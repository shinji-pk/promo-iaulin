import { EventEmitter } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo, LookupFunction } from 'node:net';
import type { RequestOptions } from 'node:https';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCloudApp, initialData, type AccountData } from '../apps/cloud/src/app.ts';
import { createCloudAuth } from '../apps/cloud/src/auth.ts';
import { emptyAuthDocument, type AuthDocument } from '../apps/cloud/src/blob-auth-adapter.ts';
import { JsonDocumentStore, StoreConflictError, type JsonBackend } from '../apps/cloud/src/blob-store.ts';
import { openCookie, parsePairingUrl, requestWorker, sealCookie, type ProxyResponse } from '../apps/cloud/src/worker-proxy.ts';
import { defaultSettings, type AppSnapshot, type Settings } from '../packages/shared/src/index.ts';

const network = vi.hoisted(() => ({ lookup: vi.fn(), request: vi.fn() }));
vi.mock('node:dns/promises', () => ({ lookup: network.lookup }));
vi.mock('node:https', () => ({ request: network.request }));

const secret = 'cloud-api-test-key-with-at-least-thirty-two-characters';
const password = 'Senha pessoal longa 123!';
const pairingCode = 'P'.repeat(43);
const remoteCookie = `promobridge_remote=${'R'.repeat(43)}`;
const remoteCsrf = 'f'.repeat(64);
const workerOrigin = 'https://worker.promobridge.com';
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

class MemoryBackend implements JsonBackend {
  readonly documents = new Map<string, { etag: string; value: unknown }>();
  private revision = 0;
  async read(pathname: string) { return clone(this.documents.get(pathname) ?? null); }
  async write(pathname: string, value: unknown, expectedEtag: string | null) {
    if ((this.documents.get(pathname)?.etag ?? null) !== expectedEtag) throw new StoreConflictError();
    this.documents.set(pathname, { etag: String(++this.revision), value: clone(value) });
  }
}

interface Identity { cookie: string; id: string; csrf: string; }
function responseJson(value: unknown, status = 200, cookies: string[] = []): ProxyResponse {
  return { status, body: Buffer.from(JSON.stringify(value)), contentType: 'application/json', cookies };
}

describe('cloud account API with real Express, Better Auth and persistent isolated documents', () => {
  let backend: MemoryBackend;
  let server: Server;
  let base: string;
  let proxy: ReturnType<typeof vi.fn<typeof requestWorker>>;
  const storeFor = (id: string) => new JsonDocumentStore<AccountData>({ backend, pathname: `accounts/${id}.json`, initial: initialData });

  async function start() {
    server = createServer();
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const authStore = new JsonDocumentStore<AuthDocument>({ backend, pathname: 'auth.json', initial: emptyAuthDocument, maxAttempts: 30 });
    const auth = createCloudAuth({ store: authStore, baseURL: base, secret });
    server.on('request', createCloudApp({ auth, storeFor, requestWorker: proxy, baseURL: base, secret }));
  }
  async function stop() {
    server.closeIdleConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
  async function api(path: string, options: { identity?: Identity; method?: string; body?: unknown; headers?: Record<string, string> } = {}) {
    return fetch(`${base}${path}`, {
      method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
      headers: { Origin: base, 'Content-Type': 'application/json', ...(options.identity ? { Cookie: options.identity.cookie, 'X-CSRF-Token': options.identity.csrf } : {}), ...options.headers },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
  }
  async function register(email: string): Promise<Identity> {
    const response = await api('/api/auth/sign-up/email', { body: { email, password, name: 'Pessoa de teste' } });
    expect(response.status).toBe(200);
    const body = await response.json() as { user: { id: string } };
    const cookie = response.headers.getSetCookie().map(item => item.split(';')[0]).join('; ');
    const session = await fetch(`${base}/api/v1/session`, { headers: { Cookie: cookie } });
    expect(session.status).toBe(200);
    return { cookie, id: body.user.id, csrf: (await session.json() as { csrfToken: string }).csrfToken };
  }
  async function state(identity: Identity): Promise<AppSnapshot> {
    const result = await api('/api/v1/state', { identity });
    expect(result.status).toBe(200);
    return result.json() as Promise<AppSnapshot>;
  }
  it('inicia o download de Windows diretamente, mesmo antes de criar uma conta', async () => {
    const response = await fetch(base + '/api/v1/download/windows', { redirect: 'manual' });
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('https://github.com/shinji-pk/promo-iaulin/releases/download/desktop-preview-38/Promo-Iaulin-Setup.exe');
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  beforeEach(async () => {
    vi.stubEnv('BETTER_AUTH_SECRET', secret);
    backend = new MemoryBackend();
    proxy = vi.fn<typeof requestWorker>().mockRejectedValue(new Error('No real computer is available in tests.'));
    await start();
  });
  afterEach(async () => { await stop(); vi.unstubAllEnvs(); });

  it('requires a real login and stores different preferences per account across server restarts', async () => {
    expect((await api('/api/v1/state')).status).toBe(401);
    const publicAccount = await api('/api/v1/account');
    expect(await publicAccount.json()).toMatchObject({ mode: 'cloud', user: null, persistence: 'cloud' });
    const alice = await register('alice@example.com');
    const bob = await register('bob@example.com');
    const settings = defaultSettings();
    settings.message.signature = 'Preferências privadas de Alice';
    settings.minScore = 91;
    const saved = await api('/api/v1/settings', { identity: alice, method: 'PUT', body: settings });
    expect(saved.status).toBe(200);
    expect((await state(alice)).settings.message.signature).toBe(settings.message.signature);
    expect((await state(bob)).settings.message.signature).not.toBe(settings.message.signature);
    const attemptedRead = await api(`/api/v1/state?userId=${alice.id}`, { identity: bob });
    expect((await attemptedRead.json() as AppSnapshot).settings.message.signature).not.toBe(settings.message.signature);
    await stop();
    await start();
    expect((await state(alice)).settings).toMatchObject({ minScore: 91, message: { signature: settings.message.signature } });
    expect((await state(bob)).settings.minScore).toBe(defaultSettings().minScore);
    expect(proxy).not.toHaveBeenCalled();
  });

  it('rejects missing, cross-account and cross-origin CSRF tokens before saving anything', async () => {
    const alice = await register('alice@example.com'), bob = await register('bob@example.com');
    const settings = { ...defaultSettings(), minScore: 99 };
    const deniedHeaders: Record<string, string>[] = [{ 'X-CSRF-Token': '' }, { 'X-CSRF-Token': bob.csrf }, { Origin: 'https://attacker.example' }];
    for (const headers of deniedHeaders) {
      expect((await api('/api/v1/settings', { identity: alice, method: 'PUT', body: settings, headers })).status).toBe(403);
    }
    expect((await api('/api/v1/settings', { identity: alice, method: 'PUT', body: settings, headers: { 'Content-Type': 'text/plain' } })).status).toBe(415);
    expect((await state(alice)).settings.minScore).toBe(defaultSettings().minScore);
  });

  it('saves simulations to the current account without pretending that WhatsApp is connected', async () => {
    const alice = await register('alice@example.com'), bob = await register('bob@example.com');
    const response = await api('/api/v1/simulate', { identity: alice, body: { text: 'Creme hidratante por R$ 49,90 https://www.amazon.com.br/dp/B012345678' } });
    expect(response.status).toBe(200);
    const own = await state(alice), other = await state(bob);
    expect(own.offers).toHaveLength(1);
    expect(own.offers[0]).toMatchObject({ simulation: true, originalText: expect.stringContaining('Creme hidratante') });
    expect(own.whatsapp.connected).toBe(false);
    expect(other.offers).toEqual([]);
    expect(proxy).not.toHaveBeenCalled();
  });

  it('revokes API access on logout and permits later login with the saved preferences', async () => {
    const alice = await register('alice@example.com');
    const settings = { ...defaultSettings(), minScore: 89 };
    expect((await api('/api/v1/settings', { identity: alice, method: 'PUT', body: settings })).status).toBe(200);
    expect((await api('/api/auth/sign-out', { identity: alice, body: {} })).status).toBe(200);
    expect((await api('/api/v1/state', { identity: alice })).status).toBe(401);
    const login = await api('/api/auth/sign-in/email', { body: { email: 'alice@example.com', password } });
    expect(login.status).toBe(200);
    alice.cookie = login.headers.getSetCookie().map(item => item.split(';')[0]).join('; ');
    expect((await state(alice)).settings.minScore).toBe(89);
  });

  it('persists profile changes and returns the replacement session cookie when changing the password', async () => {
    const alice = await register('alice@example.com'), bob = await register('bob@example.com');
    expect((await api('/api/v1/account/profile', { identity: alice, method: 'PUT', body: { name: 'Alice atualizada' } })).status).toBe(200);
    expect(await (await api('/api/v1/account', { identity: alice })).json()).toMatchObject({ user: { name: 'Alice atualizada' } });
    expect(await (await api('/api/v1/account', { identity: bob })).json()).toMatchObject({ user: { name: 'Pessoa de teste' } });
    const nextPassword = 'Uma nova senha longa 456!';
    const result = await api('/api/v1/account/password', { identity: alice, body: { currentPassword: password, newPassword: nextPassword, confirmPassword: nextPassword } });
    expect(result.status).toBe(200);
    const replacement = result.headers.getSetCookie().map(item => item.split(';')[0]).join('; ');
    expect(replacement).toContain('session_token=');
    expect(replacement).not.toBe(alice.cookie);
    expect((await api('/api/v1/state', { identity: alice })).status).toBe(401);
    alice.cookie = replacement;
    expect((await state(alice)).whatsapp.connected).toBe(false);
    expect((await api('/api/auth/sign-in/email', { body: { email: 'alice@example.com', password } })).status).toBe(401);
    expect((await api('/api/auth/sign-in/email', { body: { email: 'alice@example.com', password: nextPassword } })).status).toBe(200);
    expect(JSON.stringify(await backend.read('auth.json'))).not.toContain(nextPassword);
  });

  it('pairs only the authenticated account and encrypts its worker cookie with that account identity', async () => {
    const alice = await register('alice@example.com'), bob = await register('bob@example.com');
    const localState = await state(alice);
    localState.settings.message.signature = 'Dados recebidos do computador';
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    proxy.mockImplementation(async (_origin, path) => path === '/api/v1/remote/pair'
      ? responseJson({ csrfToken: remoteCsrf, expiresAt }, 200, [`${remoteCookie}; HttpOnly; Secure; SameSite=Strict`])
      : responseJson(localState));
    const paired = await api('/api/v1/account/worker', { identity: alice, body: { pairingUrl: `${workerOrigin}/#pair=${pairingCode}` } });
    expect(paired.status).toBe(200);
    const saved = await storeFor(alice.id).read();
    expect(saved.connection).toMatchObject({ origin: workerOrigin, csrf: remoteCsrf, expiresAt });
    expect(JSON.stringify(saved)).not.toContain(remoteCookie);
    expect(openCookie(saved.connection!.encryptedCookie, alice.id)).toBe(remoteCookie);
    expect(() => openCookie(saved.connection!.encryptedCookie, bob.id)).toThrow();
    expect((await storeFor(bob.id).read()).connection).toBeNull();
    expect((await api('/api/v1/account', { identity: bob })).status).toBe(200);
    proxy.mockRejectedValue(new Error('Computer unavailable'));
    expect((await state(alice)).settings.message.signature).toBe(localState.settings.message.signature);
    expect((await state(bob)).settings.message.signature).not.toBe(localState.settings.message.signature);
    expect((await api('/api/v1/account/worker', { identity: alice, method: 'DELETE', body: {} })).status).toBe(200);
    expect((await storeFor(alice.id).read()).connection).toBeNull();
  });

  it('never repeats an ambiguous worker mutation or writes its attempted settings to the offline snapshot', async () => {
    const alice = await register('alice@example.com');
    await storeFor(alice.id).transact(draft => { draft.connection = { origin: workerOrigin, encryptedCookie: sealCookie(remoteCookie, alice.id), csrf: remoteCsrf, expiresAt: new Date(Date.now() + 60_000).toISOString() }; });
    const settings: Settings = { ...defaultSettings(), minScore: 99 };
    const result = await api('/api/v1/settings', { identity: alice, method: 'PUT', body: settings });
    expect(result.status).toBe(503);
    expect(proxy).toHaveBeenCalledTimes(1);
    expect((await storeFor(alice.id).read()).settings.minScore).toBe(defaultSettings().minScore);
  });

  it('rejects executable worker content instead of serving HTML from the account origin', async () => {
    const alice = await register('alice@example.com');
    await storeFor(alice.id).transact(draft => { draft.connection = { origin: workerOrigin, encryptedCookie: sealCookie(remoteCookie, alice.id), csrf: remoteCsrf, expiresAt: new Date(Date.now() + 60_000).toISOString() }; });
    const html = '<script>window.accountWasCompromised=true</script>';
    proxy.mockResolvedValue({ status: 200, body: Buffer.from(html), contentType: 'text/html; charset=utf-8', cookies: [] });
    for (const path of ['/api/v1/health', '/api/v1/media/12345678-1234-4123-8123-123456789abc']) {
      const response = await api(path, { identity: alice });
      expect(response.status).toBe(502);
      expect(response.headers.get('content-type')).toContain('application/json');
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
      expect(await response.text()).not.toContain(html);
    }
  });

  it('keeps existing account data intact when a worker returns a malformed snapshot', async () => {
    const alice = await register('alice@example.com');
    const initial = await storeFor(alice.id).read();
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    proxy.mockImplementation(async (_origin, path) => path === '/api/v1/remote/pair'
      ? responseJson({ csrfToken: remoteCsrf, expiresAt }, 200, [`${remoteCookie}; HttpOnly; Secure; SameSite=Strict`])
      : responseJson({ settings: { minScore: -1 }, offers: 'invalid-offers' }));
    const paired = await api('/api/v1/account/worker', { identity: alice, body: { pairingUrl: `${workerOrigin}/#pair=${pairingCode}` } });
    expect(paired.status).toBeGreaterThanOrEqual(400);
    const saved = await storeFor(alice.id).read();
    expect(saved).toEqual(initial);
  });

  it.each(['expired', 'unreasonably long'])('rejects %s pairing sessions without committing a connection', async kind => {
    const alice = await register('alice@example.com');
    const expiresAt = new Date(Date.now() + (kind === 'expired' ? -1000 : 25 * 60 * 60 * 1000)).toISOString();
    proxy.mockResolvedValue(responseJson({ csrfToken: remoteCsrf, expiresAt }, 200, [`${remoteCookie}; HttpOnly; Secure; SameSite=Strict`]));
    const result = await api('/api/v1/account/worker', { identity: alice, body: { pairingUrl: `${workerOrigin}/#pair=${pairingCode}` } });
    expect(result.status).toBe(502);
    expect(proxy).toHaveBeenCalledTimes(1);
    expect((await storeFor(alice.id).read()).connection).toBeNull();
  });
});

describe('worker pairing URL, cookie encryption and DNS-pinned proxy boundaries', () => {
  beforeEach(() => { vi.stubEnv('BETTER_AUTH_SECRET', secret); network.lookup.mockReset(); network.request.mockReset(); });
  afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });

  it('accepts the exact temporary or managed pairing link and refuses ambiguous or non-public URL formats', () => {
    expect(parsePairingUrl(`https://example-worker.trycloudflare.com/#pair=${pairingCode}`)).toEqual({ origin: 'https://example-worker.trycloudflare.com', code: pairingCode });
    expect(parsePairingUrl(`${workerOrigin}/#pair=${pairingCode}`)).toEqual({ origin: workerOrigin, code: pairingCode });
    for (const url of [
      `http://worker.promobridge.com/#pair=${pairingCode}`, `https://localhost/#pair=${pairingCode}`,
      `https://worker.local/#pair=${pairingCode}`, `https://worker.internal/#pair=${pairingCode}`,
      `https://worker.promobridge.com:8443/#pair=${pairingCode}`, `https://user:password@worker.promobridge.com/#pair=${pairingCode}`,
      `${workerOrigin}/other#pair=${pairingCode}`, `${workerOrigin}/?code=secret#pair=${pairingCode}`,
      `${workerOrigin}/#pair=short`, `${workerOrigin}/#pair=${pairingCode}&pair=${pairingCode}`,
      `${workerOrigin}/#pair=${pairingCode}&redirect=https://attacker.example`, `https://worker.promobridge.com./#pair=${pairingCode}`,
    ]) expect(() => parsePairingUrl(url)).toThrow();
  });

  it('uses authenticated encryption bound to one account and fails after ciphertext tampering or key changes', () => {
    const sealed = sealCookie(remoteCookie, 'alice');
    expect(sealed).not.toContain(remoteCookie);
    expect(sealCookie(remoteCookie, 'alice')).not.toBe(sealed);
    expect(openCookie(sealed, 'alice')).toBe(remoteCookie);
    expect(() => openCookie(sealed, 'bob')).toThrow();
    const bytes = Buffer.from(sealed, 'base64url'); bytes[bytes.length - 1] ^= 255;
    expect(() => openCookie(bytes.toString('base64url'), 'alice')).toThrow();
    vi.stubEnv('BETTER_AUTH_SECRET', `${secret}-rotated`);
    expect(() => openCookie(sealed, 'alice')).toThrow();
  });

  it.each(['127.0.0.1', '10.1.2.3', '192.168.1.1', '169.254.169.254', '::1', '::ffff:127.0.0.1', 'fd00::1'])('rejects private or metadata DNS address %s before opening HTTPS', async address => {
    network.lookup.mockResolvedValue([{ address, family: address.includes(':') ? 6 : 4 }]);
    await expect(requestWorker(workerOrigin, '/api/v1/state')).rejects.toThrow('rede pública');
    expect(network.request).not.toHaveBeenCalled();
  });

  it('rejects a mixed public/private DNS response rather than choosing its apparently safe entry', async () => {
    network.lookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 }]);
    await expect(requestWorker(workerOrigin, '/api/v1/state')).rejects.toThrow('rede pública');
    expect(network.request).not.toHaveBeenCalled();
  });

  it.each(['https://attacker.com/api/v1/state', '//attacker.com/api/v1/state', '/api/v1/../../secret', '/admin'])('rejects path escape %s before DNS', async path => {
    await expect(requestWorker(workerOrigin, path)).rejects.toThrow('Endereço');
    expect(network.lookup).not.toHaveBeenCalled();
    expect(network.request).not.toHaveBeenCalled();
  });

  it('pins the checked public address, retains TLS checks and never follows redirects carrying a cookie', async () => {
    network.lookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    network.request.mockImplementation((_url: URL, options: RequestOptions, callback: (response: EventEmitter & { statusCode: number; headers: Record<string, unknown> }) => void) => {
      const outgoing = Object.assign(new EventEmitter(), { end: vi.fn(() => {
        const response = Object.assign(new EventEmitter(), { statusCode: 302, headers: { 'content-type': 'application/json', location: 'https://attacker.com/' } });
        queueMicrotask(() => { callback(response); response.emit('data', Buffer.from('{}')); response.emit('end'); });
      }) });
      expect(options).toMatchObject({ agent: false, rejectUnauthorized: true, maxHeaderSize: 16384 });
      return outgoing;
    });
    const result = await requestWorker(workerOrigin, '/api/v1/state', { cookie: remoteCookie, csrf: remoteCsrf });
    expect(result.status).toBe(302);
    expect(network.lookup).toHaveBeenCalledTimes(1);
    expect(network.request).toHaveBeenCalledTimes(1);
    const options = network.request.mock.calls[0][1] as RequestOptions;
    expect(options.headers).toMatchObject({ cookie: remoteCookie, 'x-csrf-token': remoteCsrf, origin: workerOrigin });
    const pinned = options.lookup as LookupFunction;
    const address = await new Promise<{ address: unknown; family: unknown }>((resolve, reject) => pinned('worker.promobridge.com', {}, (error, value, family) => error ? reject(error) : resolve({ address: value, family })));
    expect(address).toEqual({ address: '93.184.216.34', family: 4 });
  });

  it('bounds an unresolved DNS lookup and rejects an oversized request before HTTPS', async () => {
    network.lookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    await expect(requestWorker(workerOrigin, '/api/v1/settings', { method: 'PUT', body: 'x'.repeat(20 * 1024 * 1024) })).rejects.toThrow('limite');
    expect(network.request).not.toHaveBeenCalled();
    vi.useFakeTimers();
    network.lookup.mockImplementationOnce(() => new Promise(() => {}));
    const result = requestWorker(workerOrigin, '/api/v1/state').catch(error => error);
    await vi.advanceTimersByTimeAsync(25_000);
    expect(await result).toBeInstanceOf(Error);
    expect(network.request).not.toHaveBeenCalled();
  });
});
