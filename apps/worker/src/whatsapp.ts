import { chmod, lstat, mkdir, readdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import makeWASocket, {
  DisconnectReason, useMultiFileAuthState, WAMessageStatus,
  type AnyMessageContent, type BaileysEventMap, type ConnectionState, type GroupMetadata, type WASocket,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import QRCode from 'qrcode';
import type { IngestInput, Settings, WhatsAppGroup, WhatsAppStatus } from '../../../packages/shared/src/index.ts';
import { readJpegThumbnail } from './jpeg-thumbnail.ts';

const MAX_TEXT = 16_000;
const MAX_RECONNECTS = 6;
const MAX_SEEN = 5_000;
const MAX_PENDING = 200;
const GROUP_CACHE_TTL = 60_000;
const SEND_TIMEOUT = 25_000;
const QUERY_TIMEOUT = 15_000;
const DELIVERY_RANK: Record<WhatsAppDelivery['status'], number> = { error: 0, server_ack: 1, delivered: 2, read: 3, played: 4 };
export const MAX_IMAGE_CAPTION = 1_024;
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

/** Only unwrap the message itself. A quoted message can never supply text or media. */
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
  if (options.groups && !options.groups.some(group => group.id === sourceId && group.available !== false)) return null;
  if (typeof key.id !== 'string' || !key.id || key.id.length > 200 || envelope.messageStubType) return null;
  const timestamp = timestampMilliseconds(envelope.messageTimestamp);
  if (options.notBefore !== undefined && (timestamp === null || timestamp < options.notBefore - 5_000)) return null;
  if (timestamp !== null && timestamp > (options.now ?? Date.now()) + 300_000) return null;

  let content = object(envelope.message);
  let viewOnce = false;
  for (let depth = 0; content && depth < 8; depth++) {
    if (content.protocolMessage || content.reactionMessage || content.pollUpdateMessage) return null;
    const wrapper = ['ephemeralMessage', 'viewOnceMessage', 'viewOnceMessageV2', 'viewOnceMessageV2Extension', 'documentWithCaptionMessage']
      .find(name => content?.[name]);
    if (!wrapper) break;
    if (wrapper.startsWith('viewOnce')) viewOnce = true;
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
  const preview = !viewOnce ? readJpegThumbnail(object(content.imageMessage)?.jpegThumbnail
    ?? object(content.extendedTextMessage)?.jpegThumbnail) : null;
  return { text, sourceId, sourceName: (options.groups?.find(group => group.id === sourceId)?.name ?? 'Grupo de origem').slice(0, 100),
    messageId: key.id, simulation: false, imageUrl: null,
    ...(preview ? { imageThumbnailBase64: preview.toString('base64'), imageThumbnailMime: 'image/jpeg' as const } : {}) };
}

export interface WhatsAppDelivery {
  groupId: string; messageId: string;
  status: 'server_ack' | 'delivered' | 'read' | 'played' | 'error';
}

/** A local validation failure is safe to fix; an unconfirmed network attempt needs reconciliation. */
export class WhatsAppSendError extends Error {
  readonly uncertain: boolean;
  constructor(message: string, uncertain = false) {
    super(message);
    this.name = 'WhatsAppSendError';
    this.uncertain = uncertain;
  }
}

async function withTimeout<T>(operation: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('operation-timeout')), milliseconds);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

function normalizedJid(value: string): string {
  const [user, server] = value.split('@');
  return `${user.split(':')[0]}@${server}`;
}

export interface WhatsAppOptions {
  authDir: string;
  onMessage: (input: IngestInput) => Promise<void>;
  getSettings: () => Settings;
  onEvent?: (event: string, message: string) => void;
  onDelivery?: (delivery: WhatsAppDelivery) => void;
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
  private pending = new Set<string>();
  private readonly groupCache = new Map<string, { metadata: GroupMetadata; expiresAt: number }>();
  private readonly outgoing = new Map<string, WhatsAppDelivery['status'] | null>();
  private protocolRestarts = 0;
  private qrRevision = 0;

  constructor(options: WhatsAppOptions) {
    this.options = options;
    this.authDir = resolve(options.authDir);
  }

  getStatus(): WhatsAppStatus {
    return { ...this.status, groups: this.status.groups.map(group => ({ ...group })), diagnostics: this.diagnostics() };
  }

  connect(): Promise<void> {
    if (this.desired && (this.status.connected || this.status.connecting)) return this.lifecycle;
    this.desired = true;
    const generation = ++this.generation;
    this.reconnects = 0;
    this.protocolRestarts = 0;
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
      // Ingest belongs to the business queue and may itself be waiting for a reset.
      // Generation checks cancel queued messages without a lifecycle/business deadlock.
      await this.authWrites;
    });
  }

  reset(): Promise<void> {
    this.invalidate();
    this.seen.clear();
    this.outgoing.clear();
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
      await this.authWrites;
      await rm(this.authDir, { recursive: true, force: true });
      this.emit('whatsapp.reset', 'Sessão removida. Use Conectar WhatsApp para vincular um número.');
    });
  }

  async refreshGroups(): Promise<WhatsAppGroup[]> {
    const socket = this.socket;
    const generation = this.generation;
    if (!socket || !this.status.connected) return [];
    try {
      const all = await withTimeout(socket.groupFetchAllParticipating(), QUERY_TIMEOUT);
      if (!this.active(generation, socket) || !this.status.connected) return [];
      this.groupCache.clear();
      for (const metadata of Object.values(all).slice(0, 1_000)) this.cacheGroup(metadata, socket);
      this.status.groups = this.status.groups.filter(group => this.groupCache.has(group.id));
      this.sortGroups();
      return this.getStatus().groups;
    } catch {
      if (this.active(generation, socket)) this.error('Não foi possível atualizar os grupos. Tente novamente.');
      throw new Error('Não foi possível atualizar os grupos do WhatsApp.');
    }
  }

  async sendText(groupId: string, text: string): Promise<string> {
    await this.assertCanSend(groupId, text);
    return this.send(groupId, { text });
  }

  async sendImage(groupId: string, image: Buffer, caption: string): Promise<string> {
    const jpeg = readJpegThumbnail(image);
    if (!jpeg) throw new WhatsAppSendError('A imagem local não é uma miniatura JPEG válida de até 200 KB.');
    if (caption.length > MAX_IMAGE_CAPTION)
      throw new WhatsAppSendError('A legenda da imagem deve ter até 1.024 caracteres. Reduza o texto ou escolha enviar somente texto.');
    await this.assertCanSend(groupId, caption);
    // Never retry as text: even a timeout can mean the image already reached the group.
    return this.send(groupId, { image: jpeg, caption, mimetype: 'image/jpeg', jpegThumbnail: jpeg.toString('base64') });
  }

  /** Run before reserving an offer so a local configuration error is not an uncertain delivery. */
  async assertCanSend(groupId: string, text: string): Promise<void> {
    const settings = this.options.getSettings();
    const socket = this.socket;
    const generation = this.generation;
    if (!socket || !this.status.connected || !this.desired) throw new WhatsAppSendError('WhatsApp desconectado.');
    if (settings.paused) throw new WhatsAppSendError('A automação está pausada.');
    if (!settings.destinationGroup || groupId !== settings.destinationGroup || !groupId.endsWith('@g.us'))
      throw new WhatsAppSendError('Escolha o grupo de destino nas configurações.');
    if (settings.sourceGroups.includes(groupId)) throw new WhatsAppSendError('O destino não pode ser também um grupo de origem.');
    if (!text.trim() || text.length > MAX_TEXT) throw new WhatsAppSendError('A mensagem deve ter entre 1 e 16.000 caracteres.');
    let group = this.status.groups.find(item => item.id === groupId);
    if (!group || group.available === false) throw new WhatsAppSendError('O grupo de destino não está disponível nesta sessão. Atualize os grupos.');
    if (group.canSend === false) throw new WhatsAppSendError('Somente administradores podem enviar no grupo de destino. Dê permissão ao número conectado ou escolha outro grupo.');
    const cached = this.groupCache.get(groupId);
    if (!cached || cached.expiresAt <= Date.now()) {
      try {
        const metadata = await withTimeout(socket.groupMetadata(groupId), QUERY_TIMEOUT);
        if (!this.active(generation, socket) || !this.status.connected) throw new Error('connection-changed');
        if (metadata.id !== groupId) throw new Error('group-changed');
        this.cacheGroup(metadata, socket);
        group = this.status.groups.find(item => item.id === groupId);
      } catch {
        throw new WhatsAppSendError('Não foi possível confirmar o acesso ao grupo de destino. Atualize os grupos antes de publicar.');
      }
      if (!group || group.available === false) throw new WhatsAppSendError('O grupo de destino não está disponível nesta sessão.');
      if (group.canSend === false) throw new WhatsAppSendError('Somente administradores podem enviar no grupo de destino. Dê permissão ao número conectado ou escolha outro grupo.');
    }
    if (!this.active(generation, socket) || !this.status.connected || this.options.getSettings().paused)
      throw new WhatsAppSendError('A conexão ou a pausa mudou. Confira o WhatsApp antes de publicar.');
    if (this.options.getSettings().destinationGroup !== groupId || this.options.getSettings().sourceGroups.includes(groupId))
      throw new WhatsAppSendError('O grupo de destino mudou. Confira as configurações antes de publicar.');
  }

  private async send(groupId: string, content: AnyMessageContent): Promise<string> {
    const socket = this.socket;
    if (!socket || !this.status.connected || !this.desired) throw new WhatsAppSendError('WhatsApp desconectado.');
    // Recheck synchronous settings after the awaited preflight, immediately before network I/O.
    const settings = this.options.getSettings();
    if (settings.paused) throw new WhatsAppSendError('A automação está pausada.');
    if (settings.destinationGroup !== groupId || settings.sourceGroups.includes(groupId))
      throw new WhatsAppSendError('O grupo de destino mudou. Confira as configurações antes de publicar.');
    try {
      const sent = await withTimeout(socket.sendMessage(groupId, content), SEND_TIMEOUT);
      if (!sent?.key?.id) throw new Error('no-ack');
      this.outgoing.set(`${groupId}:${sent.key.id}`, null);
      if (this.outgoing.size > MAX_SEEN) this.outgoing.delete(this.outgoing.keys().next().value!);
      this.status.lastSentAt = new Date().toISOString();
      return sent.key.id;
    } catch {
      // An unknown delivery result must never trigger an automatic resend.
      this.emit('whatsapp.send_uncertain', 'O envio não foi confirmado. Confira o grupo antes de tentar novamente.');
      throw new WhatsAppSendError('O WhatsApp não confirmou o envio. Confira o grupo antes de tentar novamente.', true);
    }
  }

  private cacheGroup(metadata: GroupMetadata, socket: WASocket): void {
    if (!metadata.id?.endsWith('@g.us') || metadata.id.length > 100) return;
    this.groupCache.set(metadata.id, { metadata, expiresAt: Date.now() + GROUP_CACHE_TTL });
    const self = new Set([socket.user?.id, socket.user?.lid, socket.user?.jid].filter((jid): jid is string => Boolean(jid)).map(normalizedJid));
    const participant = metadata.participants?.find(member => [member.id, member.lid, member.jid]
      .some(jid => jid && self.has(normalizedJid(jid))));
    const isAdmin = Boolean(participant && (participant.admin === 'admin' || participant.admin === 'superadmin'
      || participant.isAdmin || participant.isSuperAdmin));
    const group: WhatsAppGroup = { id: metadata.id, name: (metadata.subject || 'Grupo sem nome').slice(0, 100),
      participants: metadata.participants?.length ?? metadata.size ?? 0, available: true,
      announcement: Boolean(metadata.announce), isAdmin, canSend: !metadata.announce || isAdmin };
    const index = this.status.groups.findIndex(item => item.id === metadata.id);
    if (index === -1) this.status.groups.push(group);
    else this.status.groups[index] = group;
  }

  private sortGroups(): void {
    this.status.groups.sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
  }

  private diagnostics(): string[] {
    const settings = this.options.getSettings();
    const messages: string[] = [];
    if (!this.status.connected) messages.push('Conecte o WhatsApp para receber mensagens novas e publicar.');
    if (!settings.sourceGroups.length) messages.push('Escolha ao menos um grupo de origem.');
    else if (this.status.connected && settings.sourceGroups.some(id => !this.status.groups.some(group => group.id === id && group.available !== false)))
      messages.push('Um grupo de origem não está disponível. Atualize a lista e confira a participação do número conectado.');
    if (!settings.destinationGroup) messages.push('Escolha o grupo de destino.');
    else {
      const destination = this.status.groups.find(group => group.id === settings.destinationGroup);
      if (this.status.connected && (!destination || destination.available === false)) messages.push('O grupo de destino não está disponível nesta sessão.');
      else if (destination?.canSend === false) messages.push('O destino permite mensagens apenas de administradores e o número conectado não tem essa permissão.');
      if (settings.sourceGroups.includes(settings.destinationGroup)) messages.push('Escolha um destino diferente dos grupos de origem.');
    }
    return messages;
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
    this.groupCache.clear();
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
        cachedGroupMetadata: async jid => {
          const entry = this.groupCache.get(jid);
          return entry && entry.expiresAt > Date.now() ? entry.metadata : undefined;
        },
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
        for (const message of batch.messages) {
          if (this.pending.size >= MAX_PENDING) {
            this.emit('whatsapp.ingest_overflow', 'A captura atingiu 200 mensagens pendentes. Algumas mensagens novas não foram capturadas; aguarde a fila e confira a origem.');
            break;
          }
          const initial = normalizeIncomingMessage(message, { settings: this.options.getSettings(), groups: this.status.groups,
            upsertType: batch.type, notBefore });
          if (!initial) continue;
          const identity = `${initial.sourceId}:${initial.messageId}`;
          if (this.seen.has(identity) || this.pending.has(identity)) continue;
          this.pending.add(identity);
          this.incoming = this.incoming.then(async () => {
            if (!this.active(generation, socket) || !this.status.connected) return;
            // Revalidate settings and participation after waiting for an earlier message.
            const input = normalizeIncomingMessage(message, { settings: this.options.getSettings(), groups: this.status.groups,
              upsertType: batch.type, notBefore });
            if (!input) return;
            try {
              await this.options.onMessage(input);
              this.seen.add(identity);
              if (this.seen.size > MAX_SEEN) this.seen.delete(this.seen.values().next().value!);
              if (this.active(generation, socket)) this.status.lastMessageAt = new Date().toISOString();
            } catch {
              this.emit('whatsapp.ingest_error', 'Uma mensagem não pôde ser salva. Confira a origem e importe o texto pela entrada manual; as próximas continuam sendo recebidas.');
            }
          }).catch(() => this.emit('whatsapp.ingest_error', 'Não foi possível processar uma mensagem recebida.'))
            .finally(() => { this.pending.delete(identity); });
        }
      };
      const onGroups = (updates: BaileysEventMap['groups.update']) => {
        if (!this.active(generation, socket) || !this.status.connected) return;
        for (const update of updates.slice(0, 1_000)) {
          if (!update.id) continue;
          const cached = this.groupCache.get(update.id);
          if (cached) this.cacheGroup({ ...cached.metadata, ...update }, socket);
        }
        this.sortGroups();
      };
      const onGroupUpsert = (groups: BaileysEventMap['groups.upsert']) => {
        if (!this.active(generation, socket) || !this.status.connected) return;
        for (const metadata of groups.slice(0, 1_000)) this.cacheGroup(metadata, socket);
        this.sortGroups();
      };
      const onParticipants = (update: BaileysEventMap['group-participants.update']) => {
        if (!this.active(generation, socket) || !this.status.connected) return;
        const cached = this.groupCache.get(update.id);
        if (!cached) return;
        const identities = new Set(update.participants.map(normalizedJid));
        const self = [socket.user?.id, socket.user?.jid, socket.user?.lid].some(jid => jid && identities.has(normalizedJid(jid)));
        if (self && update.action === 'remove') {
          this.groupCache.delete(update.id);
          this.status.groups = this.status.groups.filter(group => group.id !== update.id);
          this.emit('whatsapp.group_unavailable', 'O número conectado saiu de um grupo. Confira as origens e o destino nas configurações.');
          return;
        }
        const matches = (member: GroupMetadata['participants'][number]) => [member.id, member.lid, member.jid]
          .some(jid => jid && identities.has(normalizedJid(jid)));
        let participants = [...(cached.metadata.participants ?? [])];
        if (update.action === 'remove') participants = participants.filter(member => !matches(member));
        else if (update.action === 'add') {
          const known = new Set(participants.flatMap(member => [member.id, member.lid, member.jid].filter((jid): jid is string => Boolean(jid))).map(normalizedJid));
          participants.push(...update.participants.filter(jid => !known.has(normalizedJid(jid))).map(id => ({ id })));
        } else if (update.action === 'promote' || update.action === 'demote') participants = participants.map(member => matches(member)
          ? { ...member, admin: update.action === 'promote' ? 'admin' as const : null, isAdmin: update.action === 'promote', isSuperAdmin: false }
          : member);
        this.cacheGroup({ ...cached.metadata, participants }, socket);
        // Group encryption and the next successful preflight must fetch current metadata.
        this.groupCache.get(update.id)!.expiresAt = 0;
      };
      const onMessageUpdates = (updates: BaileysEventMap['messages.update']) => {
        if (!this.active(generation, socket)) return;
        for (const { key, update } of updates) {
          if (!key.fromMe || !key.id || !key.remoteJid) continue;
          const identity = `${key.remoteJid}:${key.id}`;
          if (!this.outgoing.has(identity)) continue;
          const status = update.status === WAMessageStatus.ERROR ? 'error'
            : update.status === WAMessageStatus.SERVER_ACK ? 'server_ack'
            : update.status === WAMessageStatus.DELIVERY_ACK ? 'delivered'
            : update.status === WAMessageStatus.READ ? 'read'
            : update.status === WAMessageStatus.PLAYED ? 'played' : null;
          const previous = this.outgoing.get(identity);
          if (!status || previous === status || (previous && DELIVERY_RANK[status] < DELIVERY_RANK[previous])) continue;
          this.outgoing.set(identity, status);
          try { this.options.onDelivery?.({ groupId: key.remoteJid, messageId: key.id, status }); }
          catch { /* Delivery reporting never triggers another network send. */ }
        }
      };
      socket.ev.on('creds.update', onCredentials);
      socket.ev.on('connection.update', onConnection);
      socket.ev.on('messages.upsert', onMessages);
      socket.ev.on('groups.update', onGroups);
      socket.ev.on('groups.upsert', onGroupUpsert);
      socket.ev.on('group-participants.update', onParticipants);
      socket.ev.on('messages.update', onMessageUpdates);
      this.detach = () => {
        socket.ev.off('creds.update', onCredentials);
        socket.ev.off('connection.update', onConnection);
        socket.ev.off('messages.upsert', onMessages);
        socket.ev.off('groups.update', onGroups);
        socket.ev.off('groups.upsert', onGroupUpsert);
        socket.ev.off('group-participants.update', onParticipants);
        socket.ev.off('messages.update', onMessageUpdates);
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
      if (this.openedAt && Date.now() - this.openedAt >= 60_000) { this.reconnects = 0; this.protocolRestarts = 0; }
      this.openedAt = 0;
      this.qrRevision++;
      this.status = { connected: false, connecting: false, qrDataUrl: null, user: null, groups: [], lastError: null };
      this.groupCache.clear();
      this.closeSocket();
      if (terminal) {
        this.desired = false;
        this.error('Sessão encerrada. Remova a sessão e conecte novamente pelo painel.');
      } else this.scheduleReconnect(generation, code === DisconnectReason.restartRequired);
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

  private scheduleReconnect(generation: number, expectedRestart = false): void {
    if (!this.active(generation)) return;
    if (this.reconnects >= MAX_RECONNECTS) {
      this.desired = false;
      this.status.connecting = false;
      this.error('Não foi possível reconectar após várias tentativas. Use Conectar WhatsApp para tentar novamente.');
      return;
    }
    // The first protocol restarts after a successful QR are expected, but still bounded.
    const delay = expectedRestart && this.protocolRestarts++ < 3 ? 100 : Math.min(1_000 * 2 ** this.reconnects++, 30_000);
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
