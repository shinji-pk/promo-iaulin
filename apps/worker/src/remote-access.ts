import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { spawn as spawnProcess, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { join, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import type { Database } from '../../../packages/db/src/index.ts';

export const REMOTE_COOKIE_NAME = 'promobridge_remote';
const SESSION_NAMESPACE = 'remote-sessions';
const PAIR_LIFETIME = 5 * 60_000;
const SESSION_LIFETIME = 8 * 60 * 60_000;
const MAX_BINARY_BYTES = 80 * 1024 * 1024;
const RELEASE_API = 'https://api.github.com/repos/cloudflare/cloudflared/releases/latest';
const hash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');

export interface RemoteStatus {
  state: 'off' | 'starting' | 'ready' | 'error';
  mode: 'temporary' | 'managed' | null;
  publicUrl: string | null;
  message: string;
  expiresAt: string | null;
  activeSessions: number;
  pairing?: { code: string; url: string; expiresAt: string };
}
interface SessionRecord { id: string; origin: string; expiresAt: string; createdAt: string; }
interface ReleaseAsset { tag: string; name: string; url: string; digest: string; size: number; }
interface InstalledBinary extends ReleaseAsset { binaryDigest: string; }
export interface RemoteAccessOptions {
  database: Pick<Database, 'putRecord' | 'getRecord' | 'listRecords' | 'deleteRecord' | 'clearRecords'>;
  port: number;
  binDirectory?: string;
  spawn?: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
  fetch?: typeof globalThis.fetch;
  now?: () => number | Date;
}
class RemoteError extends Error {}

/** Only a domain explicitly configured by the local owner may identify a managed tunnel. */
export function validateRemoteOrigin(input: string): string {
  // eslint-disable-next-line no-control-regex -- Reject control bytes before URL parsing normalizes them.
  if (typeof input !== 'string' || input.length > 253 || /[\s\\\u0000-\u001f\u007f]/u.test(input)) throw new RemoteError('Informe o domínio HTTPS do seu túnel, sem caminho ou credenciais.');
  let url: URL;
  try { url = new URL(input); } catch { throw new RemoteError('Informe o domínio HTTPS do seu túnel, sem caminho ou credenciais.'); }
  const host = url.hostname;
  const authority = input.match(/^https:\/\/([^/]+)/i)?.[1] ?? '';
  const reserved = ['localhost', 'local', 'localdomain', 'internal', 'intranet', 'lan', 'home', 'corp', 'arpa', 'test', 'invalid', 'example', 'onion', 'trycloudflare.com', 'cfargotunnel.com'];
  if (url.protocol !== 'https:' || url.username || url.password || url.port || authority.includes(':') ||
      (url.pathname !== '' && url.pathname !== '/') || url.search || url.hash || host.endsWith('.') || isIP(host.replace(/^\[|\]$/g, '')) ||
      !host.includes('.') || !/^[a-z]{2,63}$/i.test(host.split('.').at(-1) ?? '') ||
      host.split('.').some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label)) ||
      reserved.some(suffix => host === suffix || host.endsWith(`.${suffix}`))) {
    throw new RemoteError('Use um domínio público HTTPS próprio, sem porta, caminho ou credenciais.');
  }
  return url.origin;
}

export function cloudflaredAssetName(platform: NodeJS.Platform = process.platform, architecture: string = process.arch): string {
  const arch = ({ x64: 'amd64', arm64: 'arm64', arm: 'arm', ia32: '386' } as Record<string, string>)[architecture];
  if (!arch || !['linux', 'win32', 'darwin'].includes(platform) || (platform === 'darwin' && !['amd64', 'arm64'].includes(arch))) throw new RemoteError('Acesso remoto indisponível neste sistema ou arquitetura.');
  return `cloudflared-${platform === 'win32' ? 'windows' : platform}-${arch}${platform === 'win32' ? '.exe' : platform === 'darwin' ? '.tgz' : ''}`;
}

/** macOS releases contain one executable. Never extract paths, links, or arbitrary entries. */
function unpackExecutable(archive: Buffer): Buffer {
  const tar = gunzipSync(archive, { maxOutputLength: MAX_BINARY_BYTES });
  let executable: Buffer | undefined;
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '');
    const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/s, '');
    const lengthText = header.subarray(124, 136).toString('ascii').replace(/\0.*$/s, '').trim();
    const size = /^[0-7]+$/.test(lengthText) ? parseInt(lengthText, 8) : -1;
    let checksum = 0;
    for (let index = 0; index < 512; index++) checksum += index >= 148 && index < 156 ? 32 : header[index];
    const declaredChecksum = parseInt(header.subarray(148, 156).toString('ascii').replace(/\0.*$/s, '').trim(), 8);
    if (prefix || !['cloudflared', './cloudflared'].includes(name) || ![0, 48].includes(header[156]) || executable ||
        !Number.isSafeInteger(size) || size < 1 || size > MAX_BINARY_BYTES || offset + 512 + size > tar.length || checksum !== declaredChecksum) throw new RemoteError('Arquivo oficial do cloudflared tem estrutura inesperada.');
    executable = tar.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  if (!executable) throw new RemoteError('O arquivo oficial não contém o executável cloudflared.');
  return executable;
}

function allowedDownloadUrl(input: string, asset?: ReleaseAsset): URL {
  let url: URL;
  try { url = new URL(input); } catch { throw new RemoteError('Endereço de download oficial inválido.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) throw new RemoteError('Download do cloudflared exige HTTPS oficial.');
  if (!asset) {
    if (url.href !== RELEASE_API) throw new RemoteError('Descritor de versão não é o oficial.');
  } else if (url.href !== asset.url && !['release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(url.hostname)) {
    throw new RemoteError('Redirecionamento de download fora dos servidores oficiais do GitHub.');
  }
  return url;
}

/** Opt-in local controller. Creating this object never downloads or starts a tunnel. */
export class RemoteAccess {
  #database: RemoteAccessOptions['database'];
  #port: number;
  #directory: string;
  #spawn: NonNullable<RemoteAccessOptions['spawn']>;
  #fetch: typeof globalThis.fetch;
  #now: () => number;
  #state: RemoteStatus['state'] = 'off';
  #mode: RemoteStatus['mode'] = null;
  #publicOrigin: string | null = null;
  #message = 'Acesso pelo celular desativado. Ative apenas no painel deste computador.';
  #child: ChildProcess | null = null;
  #abort: AbortController | null = null;
  #generation = 0;
  #pairCode: string | null = null;
  #pairHash: string | null = null;
  #pairExpires = 0;
  #rejectStartup: ((error: Error) => void) | null = null;

  constructor(options: RemoteAccessOptions) {
    if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) throw new RemoteError('Porta local inválida.');
    this.#database = options.database;
    this.#port = options.port;
    this.#directory = resolve(options.binDirectory ?? 'data/tunnel-bin');
    this.#spawn = options.spawn ?? spawnProcess;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#now = () => Number(options.now ? options.now() : Date.now());
    // A restart is always off, and an old database cannot revive remote access.
    this.#database.clearRecords(SESSION_NAMESPACE);
  }

  get origin(): string | null { return this.#state === 'ready' ? this.#publicOrigin : null; }

  #sessions(): SessionRecord[] {
    const records = this.#database.listRecords<SessionRecord>(SESSION_NAMESPACE);
    const active: SessionRecord[] = [];
    for (const record of records) {
      if (!record || typeof record.id !== 'string' || !/^[a-f0-9]{64}$/.test(record.id)) continue;
      if (record.origin !== this.#publicOrigin || !Number.isFinite(Date.parse(record.expiresAt)) || Date.parse(record.expiresAt) <= this.#now()) this.#database.deleteRecord(SESSION_NAMESPACE, record.id);
      else active.push(record);
    }
    return active;
  }

  #newPairing(): void {
    this.#pairCode = randomBytes(32).toString('base64url');
    this.#pairHash = hash(this.#pairCode);
    this.#pairExpires = this.#now() + PAIR_LIFETIME;
  }

  status(options: { includePairing?: boolean } = {}): RemoteStatus {
    const activeSessions = this.#sessions().length;
    if (options.includePairing && this.#state === 'ready' && (!this.#pairCode || this.#pairExpires <= this.#now())) this.#newPairing();
    const expiresAt = this.#pairCode && this.#pairExpires > this.#now() ? new Date(this.#pairExpires).toISOString() : null;
    const value: RemoteStatus = { state: this.#state, mode: this.#mode, publicUrl: this.#state === 'ready' ? this.#publicOrigin : null, message: this.#message, expiresAt, activeSessions };
    if (options.includePairing && this.#state === 'ready' && this.#pairCode && expiresAt && this.#publicOrigin) value.pairing = { code: this.#pairCode, url: `${this.#publicOrigin}/#pair=${this.#pairCode}`, expiresAt };
    return value;
  }

  isRemoteHost(host: string): boolean {
    return Boolean(this.origin && typeof host === 'string' && host.length <= 253 && host.toLowerCase() === new URL(this.origin).hostname);
  }

  authorize(cookieHeader: string | undefined): boolean {
    if (!this.origin || typeof cookieHeader !== 'string' || cookieHeader.length > 8192) return false;
    const values = cookieHeader.split(';').map(part => part.trim()).filter(part => part.startsWith(`${REMOTE_COOKIE_NAME}=`));
    if (values.length !== 1) return false;
    const token = values[0].slice(REMOTE_COOKIE_NAME.length + 1);
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return false;
    const id = hash(token);
    const record = this.#database.getRecord<SessionRecord>(SESSION_NAMESPACE, id);
    if (!record || record.id !== id || record.origin !== this.origin || !Number.isFinite(Date.parse(record.expiresAt)) || Date.parse(record.expiresAt) <= this.#now()) {
      if (record) this.#database.deleteRecord(SESSION_NAMESPACE, id);
      return false;
    }
    return true;
  }

  pair(code: string): { sessionToken: string; expiresAt: string } {
    if (!this.origin || typeof code !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(code) || !this.#pairHash || this.#pairExpires <= this.#now() ||
        !timingSafeEqual(Buffer.from(hash(code), 'hex'), Buffer.from(this.#pairHash, 'hex'))) throw new RemoteError('Código de pareamento inválido ou expirado. Gere outro no computador.');
    if (this.#sessions().length >= 8) throw new RemoteError('Limite de dispositivos atingido. Revogue os acessos no computador.');
    // Consume before issuing; no second request can reuse this code.
    this.#pairCode = null;
    this.#pairHash = null;
    this.#pairExpires = 0;
    const sessionToken = randomBytes(32).toString('base64url');
    const createdAt = new Date(this.#now()).toISOString();
    const expiresAt = new Date(this.#now() + SESSION_LIFETIME).toISOString();
    const id = hash(sessionToken);
    this.#database.putRecord(SESSION_NAMESPACE, id, { id, origin: this.origin, createdAt, expiresAt } satisfies SessionRecord);
    return { sessionToken, expiresAt };
  }

  revokeSessions(): RemoteStatus {
    this.#database.clearRecords(SESSION_NAMESPACE);
    this.#pairCode = null;
    this.#pairHash = null;
    this.#pairExpires = 0;
    if (this.#state === 'ready') this.#newPairing();
    return this.status();
  }

  async #download(url: string, maxBytes: number, signal: AbortSignal, asset?: ReleaseAsset): Promise<Buffer> {
    let current = allowedDownloadUrl(url, asset);
    for (let redirects = 0; redirects <= 4; redirects++) {
      const response = await this.#fetch(current, { method: 'GET', redirect: 'manual', signal, headers: { 'User-Agent': 'PromoBridge-cloudflared-installer', Accept: asset ? 'application/octet-stream' : 'application/vnd.github+json' } });
      if (response.url && response.url !== current.href) throw new RemoteError('O download não respeitou a verificação de redirecionamentos.');
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        const location = response.headers.get('location');
        if (!asset || !location || redirects === 4) throw new RemoteError('Redirecionamento oficial indisponível ou excessivo.');
        current = allowedDownloadUrl(new URL(location, current).href, asset);
        continue;
      }
      if (!response.ok || !response.body) throw new RemoteError('Não foi possível baixar o cloudflared oficial. Confira a conexão e tente novamente.');
      const length = response.headers.get('content-length');
      if (length && (!/^\d+$/.test(length) || Number(length) > maxBytes)) { await response.body.cancel(); throw new RemoteError('Download oficial ultrapassa o tamanho permitido.'); }
      const reader = response.body.getReader();
      const chunks: Buffer[] = [];
      let bytes = 0;
      try {
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          bytes += part.value.byteLength;
          if (bytes > maxBytes) throw new RemoteError('Download oficial ultrapassa o tamanho permitido.');
          chunks.push(Buffer.from(part.value));
        }
      } finally { await reader.cancel().catch(() => undefined); }
      return Buffer.concat(chunks, bytes);
    }
    throw new RemoteError('Não foi possível obter o download oficial.');
  }

  async #binary(signal: AbortSignal): Promise<string> {
    const name = cloudflaredAssetName();
    const binaryPath = join(this.#directory, process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');
    const manifestPath = join(this.#directory, 'release.json');
    if (existsSync(this.#directory) && (!lstatSync(this.#directory).isDirectory() || lstatSync(this.#directory).isSymbolicLink())) throw new RemoteError('A pasta do cloudflared precisa ser um diretório local.');
    if (existsSync(binaryPath)) {
      const file = lstatSync(binaryPath);
      if (!file.isFile() || file.isSymbolicLink() || file.size > MAX_BINARY_BYTES || !existsSync(manifestPath)) throw new RemoteError('Executável local sem verificação. Reinstale o componente de acesso remoto.');
      const manifestFile = lstatSync(manifestPath);
      if (!manifestFile.isFile() || manifestFile.isSymbolicLink() || manifestFile.size > 16_384) throw new RemoteError('Verificação local do cloudflared inválida.');
      let installed: InstalledBinary;
      try { installed = JSON.parse(readFileSync(manifestPath, 'utf8')); } catch { throw new RemoteError('Verificação local do cloudflared inválida.'); }
      if (installed.name !== name || !/^sha256:[a-f0-9]{64}$/.test(installed.digest) || !/^[a-f0-9]{64}$/.test(installed.binaryDigest) ||
          hash(readFileSync(binaryPath)) !== installed.binaryDigest) throw new RemoteError('O executável local do cloudflared foi alterado. Reinstale o componente de acesso remoto.');
      chmodSync(binaryPath, 0o700);
      return binaryPath;
    }
    mkdirSync(this.#directory, { recursive: true, mode: 0o700 });
    chmodSync(this.#directory, 0o700);
    const metadata = await this.#download(RELEASE_API, 2 * 1024 * 1024, AbortSignal.any([signal, AbortSignal.timeout(15_000)]));
    let release: { tag_name?: unknown; assets?: unknown };
    try { release = JSON.parse(metadata.toString('utf8')); } catch { throw new RemoteError('O descritor oficial do cloudflared é inválido.'); }
    if (typeof release.tag_name !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,99}$/i.test(release.tag_name) || !Array.isArray(release.assets)) throw new RemoteError('O descritor oficial do cloudflared é inválido.');
    const raw = release.assets.find((item: { name?: unknown }) => item && item.name === name);
    const expected = `https://github.com/cloudflare/cloudflared/releases/download/${release.tag_name}/${name}`;
    if (!raw || raw.browser_download_url !== expected || typeof raw.digest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(raw.digest) ||
        !Number.isInteger(raw.size) || raw.size < 1 || raw.size > MAX_BINARY_BYTES) throw new RemoteError('A versão oficial não fornece executável com SHA-256 verificável para este sistema.');
    const asset: ReleaseAsset = { name, tag: release.tag_name, url: expected, digest: raw.digest, size: raw.size };
    const archive = await this.#download(asset.url, MAX_BINARY_BYTES, AbortSignal.any([signal, AbortSignal.timeout(30_000)]), asset);
    if (archive.length !== asset.size || `sha256:${hash(archive)}` !== asset.digest) throw new RemoteError('A assinatura SHA-256 do download não corresponde à versão oficial.');
    const executable = name.endsWith('.tgz') ? unpackExecutable(archive) : archive;
    if (signal.aborted) throw new RemoteError('Ativação do acesso remoto cancelada.');
    const temporary = join(this.#directory, `.cloudflared-${randomUUID()}.tmp`);
    const manifestTemporary = join(this.#directory, `.release-${randomUUID()}.tmp`);
    try {
      writeFileSync(temporary, executable, { flag: 'wx', mode: 0o700 });
      writeFileSync(manifestTemporary, JSON.stringify({ ...asset, binaryDigest: hash(executable) } satisfies InstalledBinary), { flag: 'wx', mode: 0o600 });
      renameSync(temporary, binaryPath);
      renameSync(manifestTemporary, manifestPath);
      chmodSync(binaryPath, 0o700);
    } finally {
      for (const file of [temporary, manifestTemporary]) if (existsSync(file)) unlinkSync(file);
    }
    return binaryPath;
  }

  async start(input: { mode: 'temporary' | 'managed'; token?: string; publicUrl?: string }): Promise<RemoteStatus> {
    if (this.#state === 'starting' || this.#child) throw new RemoteError('Desative o acesso atual antes de iniciar outro.');
    if (!input || !['temporary', 'managed'].includes(input.mode)) throw new RemoteError('Escolha acesso temporário ou túnel próprio.');
    const managedOrigin = input.mode === 'managed' ? validateRemoteOrigin(input.publicUrl ?? '') : null;
    if (input.mode === 'managed' && (typeof input.token !== 'string' || input.token.length < 20 || input.token.length > 8192 || !/^[A-Za-z0-9_+/.=-]+$/.test(input.token))) throw new RemoteError('Informe o token do túnel Cloudflare criado na sua conta.');
    if (input.mode === 'temporary' && (input.token || input.publicUrl)) throw new RemoteError('Acesso temporário não usa token ou endereço próprio.');
    const generation = ++this.#generation;
    const controller = new AbortController();
    this.#abort = controller;
    this.#state = 'starting';
    this.#mode = input.mode;
    this.#message = 'Preparando conexão segura. O painel local continua disponível.';
    this.#publicOrigin = null;
    this.revokeSessions();
    try {
      const binary = await this.#binary(controller.signal);
      if (generation !== this.#generation || controller.signal.aborted) throw new RemoteError('Ativação do acesso remoto cancelada.');
      const env: NodeJS.ProcessEnv = {};
      for (const key of ['PATH', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'HOME', 'LANG', 'LC_ALL', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'SSL_CERT_FILE', 'SSL_CERT_DIR']) if (process.env[key]) env[key] = process.env[key];
      if (input.mode === 'managed') env.TUNNEL_TOKEN = input.token;
      const args = input.mode === 'temporary' ? ['tunnel', '--no-autoupdate', '--protocol', 'http2', '--url', `http://127.0.0.1:${this.#port}`] : ['tunnel', '--no-autoupdate', '--protocol', 'http2', 'run'];
      const child = this.#spawn(binary, args, { shell: false, windowsHide: true, cwd: this.#directory, env, stdio: ['ignore', 'pipe', 'pipe'] });
      this.#child = child;
      this.#publicOrigin = managedOrigin;
      await new Promise<void>((resolveReady, rejectReady) => {
        let connected = false;
        let settled = false;
        const finish = (error?: Error) => {
          if (settled) return;
          settled = true;
          clearTimeout(deadline);
          this.#rejectStartup = null;
          if (error) rejectReady(error); else resolveReady();
        };
        this.#rejectStartup = error => finish(error);
        const deadline = setTimeout(() => finish(new RemoteError('O túnel não confirmou a conexão. Confira a rede e as configurações da Cloudflare.')), 30_000);
        const maybeReady = () => {
          if (generation !== this.#generation || !connected || !this.#publicOrigin) return;
          this.#state = 'ready';
          this.#message = input.mode === 'temporary' ? 'Acesso temporário para teste. O endereço muda ao reiniciar e não tem garantia de disponibilidade.' : 'Túnel próprio conectado. O computador precisa permanecer ligado.';
          this.#newPairing();
          finish();
        };
        const parser = () => {
          let buffer = '';
          let discarding = false;
          return (chunk: Buffer | string) => {
            if (generation !== this.#generation || this.#child !== child) return;
            // Bound each chunk and line. Child output is inspected, never logged or stored.
            for (const character of chunk.toString().slice(0, 65_536)) {
              if (character === '\n' || character === '\r') {
                if (!discarding) {
                  if (/Registered tunnel connection/.test(buffer)) connected = true;
                  if (input.mode === 'temporary' && !this.#publicOrigin) {
                    for (const match of buffer.matchAll(/https:\/\/[^\s<>"'|]+/g)) {
                      if (/^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.trycloudflare\.com\/?$/.test(match[0])) this.#publicOrigin = new URL(match[0]).origin;
                    }
                  }
                  maybeReady();
                }
                buffer = ''; discarding = false;
              } else if (!discarding) {
                if (buffer.length >= 4096) { buffer = ''; discarding = true; } else buffer += character;
              }
            }
          };
        };
        child.stdout?.on('data', parser());
        child.stderr?.on('data', parser());
        const failed = () => {
          if (generation !== this.#generation || this.#child !== child) return;
          this.#child = null;
          this.#state = 'error'; this.#publicOrigin = null;
          this.#message = 'A conexão remota foi encerrada. Ative novamente no computador.';
          this.revokeSessions();
          finish(new RemoteError(this.#message));
        };
        child.once('error', failed);
        child.once('exit', failed);
      });
      return this.status();
    } catch (error) {
      if (generation === this.#generation) {
        const child = this.#child;
        this.#child = null;
        if (child) await this.#terminate(child);
        this.#state = 'error'; this.#publicOrigin = null;
        this.#message = error instanceof RemoteError ? error.message : 'Não foi possível ativar o acesso remoto. Confira a conexão e tente novamente.';
        this.revokeSessions();
      }
      throw new RemoteError(error instanceof RemoteError ? error.message : 'Não foi possível ativar o acesso remoto. Confira a conexão e tente novamente.');
    } finally { if (generation === this.#generation) this.#abort = null; }
  }

  async #terminate(child: ChildProcess): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>(resolveStopped => {
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const finish = () => { clearTimeout(termTimer); if (killTimer) clearTimeout(killTimer); child.removeListener('exit', finish); resolveStopped(); };
      const termTimer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* Authentication was already revoked. */ }
        killTimer = setTimeout(finish, 1000);
      }, 2000);
      child.once('exit', finish);
      try { child.kill('SIGTERM'); } catch { finish(); }
    });
  }

  async stop(): Promise<RemoteStatus> {
    ++this.#generation;
    this.#abort?.abort(); this.#abort = null;
    this.#rejectStartup?.(new RemoteError('Ativação do acesso remoto cancelada.'));
    this.#rejectStartup = null;
    const child = this.#child;
    this.#child = null;
    this.#state = 'off'; this.#mode = null; this.#publicOrigin = null;
    this.#message = 'Acesso remoto desativado. Todos os dispositivos foram desconectados.';
    this.revokeSessions();
    if (child) await this.#terminate(child);
    return this.status();
  }

  toJSON(): RemoteStatus { return this.status(); }
}
