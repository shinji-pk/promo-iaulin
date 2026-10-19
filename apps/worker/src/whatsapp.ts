import { chmod, lstat, mkdir, readdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import makeWASocket, {
  DisconnectReason, useMultiFileAuthState,
  type BaileysEventMap, type ConnectionState, type WASocket,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import QRCode from 'qrcode';
import type { IngestInput, Settings, WhatsAppGroup, WhatsAppStatus } from '../../../packages/shared/src/index.ts';

const MAX_TEXT = 16_000;
const MAX_RECONNECTS = 6;
const MAX_SEEN = 5_000;
const silentLogger = pino({ level: 'silent' });
const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' ? value as Record<string, unknown> : null;

function timestampMilliseconds(value: unknown): number | null {
  const long = object(value);
  const number = long && typeof long.low === 'number' && typeof long.high === 'number'
    ? (long.high >>> 0) * 2 ** 32 + (long.low >>> 0)
    : typeof value === 'number' || typeof value === 'string' || typeof value === 'bigint' ? Number(value) : NaN;
  return Number.isFinite(number) && number > 0 ? number * (number < 1e12 ? 1_000 : 1) : null;
}

/** Only unwrap the message itself: quoted messages and previews are never ingested. */
export function normalizeIncomingMessage(message: unknown, options: {
  settings: Pick<Settings, 'sourceGroups' | 'destinationGroup'>;
  groups?: WhatsAppGroup[]; upsertType?: string; notBefore?: number; now?: number;
}): IngestInput | null {
  const envelope = object(message);
  const key = object(envelope?.key);
  if (!envelope || !key || key.fromMe || (options.upsertType && options.upsertType !== 'notify')) return null;
  const sourceId = key.remoteJid;
  if (typeof sourceId !== 'string' || !sourceId.endsWith('@g.us') || sourceId.length > 100
    || sourceId === options.settings.destinationGroup || !options.settings.sourceGroups.includes(sourceId)) return null;
  if (typeof key.id !== 'string' || !key.id || key.id.length > 200 || envelope.messageStubType) return null;
  const timestamp = timestampMilliseconds(envelope.messageTimestamp);
  if (options.notBefore !== undefined && (timestamp === null || timestamp < options.notBefore - 5_000)) return null;
  if (timestamp !== null && timestamp > (options.now ?? Date.now()) + 300_000) return null;

  let content = object(envelope.message);
  for (let depth = 0; content && depth < 8; depth++) {
    if (content.protocolMessage || content.reactionMessage || content.pollUpdateMessage) return null;
    const wrapper = ['ephemeralMessage', 'viewOnceMessage', 'viewOnceMessageV2', 'viewOnceMessageV2Extension', 'documentWithCaptionMessage']
      .find(name => content?.[name]);
    if (!wrapper) break;
    content = object(object(content[wrapper])?.message);
  }
  if (!content) return null;
  const values = [content.conversation, object(content.extendedTextMessage)?.text,
    object(content.imageMessage)?.caption, object(content.videoMessage)?.caption, object(content.documentMessage)?.caption];
  const raw = values.find(value => typeof value === 'string' && value.trim());
  if (typeof raw !== 'string' || raw.length > MAX_TEXT) return null;
  // eslint-disable-next-line no-control-regex -- Strip unsafe controls while preserving tab and newline.
  const text = raw.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
  if (!text) return null;
  return { text, sourceId, sourceName: (options.groups?.find(group => group.id === sourceId)?.name ?? 'Grupo de origem').slice(0, 100),
    messageId: key.id, simulation: false, imageUrl: null };
}

export interface WhatsAppOptions {
  authDir: string;
  onMessage: (input: IngestInput) => Promise<void>;
  getSettings: () => Settings;
  onEvent?: (event: string, message: string) => void;
}

/** A persistent local client, started exclusively by an explicit connect action. */
export class WhatsAppService {
  private readonly options: WhatsAppOptions;
  private readonly authDir: string;
  private status: WhatsAppStatus = { connected: false, connecting: false, qrDataUrl: null, user: null, groups: [], lastError: null };
  private socket: WASocket | null = null;
  private detach: (() => void) | null = null;
  private desired = false;
  private generation = 0;
  private attempt: symbol | null = null;
  private reconnects = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private openedAt = 0;
  private lifecycle: Promise<void> = Promise.resolve();
  private authWrites: Promise<void> = Promise.resolve();
  private incoming: Promise<void> = Promise.resolve();
  private seen = new Set<string>();
  private qrRevision = 0;

  constructor(options: WhatsAppOptions) {
    this.options = options;
    this.authDir = resolve(options.authDir);
  }

  getStatus(): WhatsAppStatus {
    return { ...this.status, groups: this.status.groups.map(group => ({ ...group })) };
  }

  connect(): Promise<void> {
    if (this.desired && (this.status.connected || this.status.connecting)) return this.lifecycle;
    this.desired = true;
    const generation = ++this.generation;
    this.reconnects = 0;
    this.clearReconnect();
    this.status = { ...this.status, connecting: true, lastError: null };
    return this.enqueue(async () => {
      if (this.active(generation)) await this.open(generation);
    });
  }

  stop(): Promise<void> {
    this.invalidate();
    return this.enqueue(async () => {
      this.closeSocket();
      await Promise.all([this.authWrites, this.incoming]);
    });
  }

  reset(): Promise<void> {
    this.invalidate();
    this.seen.clear();
    return this.enqueue(async () => {
      const socket = this.socket;
      this.closeSocket(false);
      if (socket) {
        // Do not let an unavailable server prevent a local session reset.
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([socket.logout(), new Promise<void>(resolveTimeout => {
            timer = setTimeout(resolveTimeout, 3_000);
            timer.unref?.();
          })]);
        } catch { /* Local credentials are removed even when already logged out. */ }
        finally { if (timer) clearTimeout(timer); socket.end(undefined); }
      }
      await Promise.all([this.authWrites, this.incoming]);
      await rm(this.authDir, { recursive: true, force: true });
      this.emit('whatsapp.reset', 'Sessão removida. Use Conectar WhatsApp para vincular um número.');
    });
  }

  async refreshGroups(): Promise<WhatsAppGroup[]> {
    const socket = this.socket;
    const generation = this.generation;
    if (!socket || !this.status.connected) return [];
    try {
      const all = await socket.groupFetchAllParticipating();
      if (!this.active(generation, socket) || !this.status.connected) return [];
      this.status.groups = Object.values(all).filter(group => group.id.endsWith('@g.us'))
        .map(group => ({ id: group.id, name: (group.subject || 'Grupo sem nome').slice(0, 100), participants: group.participants?.length ?? 0 }))
        .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
      return this.getStatus().groups;
    } catch {
      if (this.active(generation, socket)) this.error('Não foi possível atualizar os grupos. Tente novamente.');
      throw new Error('Não foi possível atualizar os grupos do WhatsApp.');
    }
  }

  async sendText(groupId: string, text: string): Promise<string> {
    const settings = this.options.getSettings();
    const socket = this.socket;
    if (!socket || !this.status.connected || !this.desired) throw new Error('WhatsApp desconectado.');
    if (settings.paused) throw new Error('A automação está pausada.');
    if (!settings.destinationGroup || groupId !== settings.destinationGroup || !groupId.endsWith('@g.us'))
      throw new Error('Escolha o grupo de destino nas configurações.');
    if (!this.status.groups.some(group => group.id === groupId)) throw new Error('O grupo de destino não está disponível nesta sessão.');
    if (!text.trim() || text.length > MAX_TEXT) throw new Error('A mensagem deve ter entre 1 e 16.000 caracteres.');
    try {
      const sent = await socket.sendMessage(groupId, { text });
      if (!sent?.key?.id) throw new Error('no-ack');
      return sent.key.id;
    } catch {
      // An unknown delivery result must never trigger an automatic resend.
      this.emit('whatsapp.send_uncertain', 'O envio não foi confirmado. Confira o grupo antes de tentar novamente.');
      throw new Error('O WhatsApp não confirmou o envio. Confira o grupo antes de tentar novamente.');
    }
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const next = this.lifecycle.then(operation);
    this.lifecycle = next.catch(() => {});
    return next;
  }

  private active(generation: number, socket?: WASocket): boolean {
    return this.desired && this.generation === generation && (!socket || this.socket === socket);
  }

  private invalidate(): void {
    this.desired = false;
    this.generation++;
    this.qrRevision++;
    this.clearReconnect();
    this.status = { connected: false, connecting: false, qrDataUrl: null, user: null, groups: [], lastError: null };
  }

  private clearReconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private closeSocket(end = true): void {
    const socket = this.socket;
    this.socket = null;
    this.attempt = null;
    this.detach?.();
    this.detach = null;
    if (end) socket?.end(undefined);
  }

  private async privateAuthDirectory(): Promise<void> {
    await mkdir(this.authDir, { recursive: true, mode: 0o700 });
    const stat = await lstat(this.authDir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('unsafe-auth-directory');
    await chmod(this.authDir, 0o700);
    await this.privateAuthFiles();
  }

  private async privateAuthFiles(): Promise<void> {
    for (const entry of await readdir(this.authDir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error('unsafe-auth-file');
      if (entry.isFile()) await chmod(resolve(this.authDir, entry.name), 0o600);
    }
  }

  private persist(operation: () => void | Promise<void>, generation: number, attempt: symbol): Promise<void> {
    const write = this.authWrites.then(async () => {
      if (this.active(generation) && this.attempt === attempt) {
        await operation();
        await this.privateAuthFiles();
      }
    });
    this.authWrites = write.catch(() => {});
    return write;
  }

  private async open(generation: number): Promise<void> {
    const notBefore = Date.now();
    this.closeSocket();
    await this.authWrites;
    try {
      await this.privateAuthDirectory();
      if (!this.active(generation)) return;
      const { state, saveCreds } = await useMultiFileAuthState(this.authDir);
      if (!this.active(generation)) return;
      const attempt = Symbol('whatsapp-attempt');
      this.attempt = attempt;
      const setKeys = state.keys.set.bind(state.keys);
      state.keys.set = data => this.persist(() => setKeys(data), generation, attempt);
      const socket = makeWASocket({
        auth: state, logger: silentLogger, browser: ['PromoBridge', 'Chrome', '2.0.0'],
        printQRInTerminal: false, markOnlineOnConnect: false, syncFullHistory: false,
        shouldSyncHistoryMessage: () => false, emitOwnEvents: false,
        generateHighQualityLinkPreview: false, connectTimeoutMs: 20_000,
        defaultQueryTimeoutMs: 20_000, keepAliveIntervalMs: 25_000,
      });
      this.socket = socket;
      const onCredentials = () => {
        void this.persist(saveCreds, generation, attempt).catch(() => {
          if (this.active(generation, socket)) this.error('Não foi possível salvar a sessão local. Verifique o espaço e as permissões.');
        });
      };
      const onConnection = (update: Partial<ConnectionState>) => {
        void this.connectionUpdate(update, generation, socket).catch(() => {
          if (this.active(generation, socket)) this.error('Não foi possível atualizar a conexão do WhatsApp.');
        });
      };
      const onMessages = (batch: BaileysEventMap['messages.upsert']) => {
        if (batch.type !== 'notify' || batch.requestId || !this.active(generation, socket) || !this.status.connected) return;
        this.incoming = this.incoming.then(async () => {
          for (const message of batch.messages) {
            if (!this.active(generation, socket) || !this.status.connected) break;
            const input = normalizeIncomingMessage(message, { settings: this.options.getSettings(), groups: this.status.groups,
              upsertType: batch.type, notBefore });
            if (!input) continue;
            const identity = `${input.sourceId}:${input.messageId}`;
            if (this.seen.has(identity)) continue;
            this.seen.add(identity);
            if (this.seen.size > MAX_SEEN) this.seen.delete(this.seen.values().next().value!);
            try { await this.options.onMessage(input); }
            catch { this.emit('whatsapp.ingest_error', 'Uma mensagem não pôde ser processada. As próximas continuam sendo recebidas.'); }
          }
        }).catch(() => this.emit('whatsapp.ingest_error', 'Não foi possível processar uma mensagem recebida.'));
      };
      socket.ev.on('creds.update', onCredentials);
      socket.ev.on('connection.update', onConnection);
      socket.ev.on('messages.upsert', onMessages);
      this.detach = () => {
        socket.ev.off('creds.update', onCredentials);
        socket.ev.off('connection.update', onConnection);
        socket.ev.off('messages.upsert', onMessages);
      };
    } catch {
      if (!this.active(generation)) return;
      this.status.connecting = false;
      this.error('Não foi possível iniciar o WhatsApp. Verifique a conexão e tente novamente.');
      this.scheduleReconnect(generation);
      throw new Error('Não foi possível iniciar o WhatsApp.');
    }
  }

  private async connectionUpdate(update: Partial<ConnectionState>, generation: number, socket: WASocket): Promise<void> {
    if (!this.active(generation, socket)) return;
    if (update.connection === 'close') {
      const error = object(update.lastDisconnect?.error);
      const code = object(error?.output)?.statusCode ?? error?.statusCode;
      const terminal = [DisconnectReason.loggedOut, DisconnectReason.badSession, DisconnectReason.connectionReplaced,
        DisconnectReason.multideviceMismatch, DisconnectReason.forbidden].includes(code as DisconnectReason);
      if (this.openedAt && Date.now() - this.openedAt >= 60_000) this.reconnects = 0;
      this.openedAt = 0;
      this.qrRevision++;
      this.status = { connected: false, connecting: false, qrDataUrl: null, user: null, groups: [], lastError: null };
      this.closeSocket();
      if (terminal) {
        this.desired = false;
        this.error('Sessão encerrada. Remova a sessão e conecte novamente pelo painel.');
      } else this.scheduleReconnect(generation);
      return;
    }
    if (update.connection === 'open') {
      this.qrRevision++;
      this.openedAt = Date.now();
      const phone = socket.user?.id.split(':')[0].split('@')[0].replace(/\D/g, '') ?? '';
      this.status = { ...this.status, connected: true, connecting: false, qrDataUrl: null,
        user: phone ? `•••• ${phone.slice(-4)}` : 'Dispositivo vinculado', lastError: null };
      this.emit('whatsapp.connected', 'WhatsApp conectado.');
      await this.refreshGroups().catch(() => {});
      return;
    }
    if (update.qr) {
      const revision = ++this.qrRevision;
      try {
        const qrDataUrl = await QRCode.toDataURL(update.qr, { margin: 2, width: 320 });
        if (this.active(generation, socket) && revision === this.qrRevision && !this.status.connected) {
          this.status.qrDataUrl = qrDataUrl;
          this.status.connecting = true;
          this.status.lastError = null;
        }
      } catch { if (this.active(generation, socket)) this.error('Não foi possível gerar o QR Code. Tente conectar novamente.'); }
    }
  }

  private scheduleReconnect(generation: number): void {
    if (!this.active(generation)) return;
    if (this.reconnects >= MAX_RECONNECTS) {
      this.desired = false;
      this.status.connecting = false;
      this.error('Não foi possível reconectar após várias tentativas. Use Conectar WhatsApp para tentar novamente.');
      return;
    }
    const delay = Math.min(1_000 * 2 ** this.reconnects++, 30_000);
    this.status.connecting = true;
    this.status.lastError = 'Conexão interrompida. Tentando reconectar…';
    this.emit('whatsapp.reconnecting', 'Conexão interrompida. Uma nova tentativa será feita automaticamente.');
    this.clearReconnect();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.active(generation)) void this.enqueue(() => this.open(generation)).catch(() => {});
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private error(message: string): void {
    this.status.lastError = message;
    this.emit('whatsapp.error', message);
  }

  private emit(event: string, message: string): void {
    try { this.options.onEvent?.(event, message); } catch { /* Reporting must not interrupt the connection. */ }
  }
}
