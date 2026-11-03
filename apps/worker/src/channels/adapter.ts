import { proto, type AnyMessageContent } from '@whiskeysockets/baileys';
import { isNewsletterJid, type ChannelRole } from '../../../../packages/shared/src/channels.ts';
import { WhatsAppSendError, type NewsletterClient } from '../whatsapp.ts';

export interface ChannelInspection {
  jid: string; name: string; description: string; invite: string | null;
  subscribers: number | null; verification: 'verified' | 'unverified' | null; role: ChannelRole;
}
export interface ChannelContent { kind: 'text' | 'image' | 'video' | 'audio'; text: string; media?: { bytes: Buffer; mime: string } }
export type ChannelErrorCode = 'validation' | 'permission' | 'auth' | 'transport' | 'not_found';

/** `uncertain` means the network may have delivered it: such a post is never resent automatically. */
export class ChannelSendError extends Error {
  constructor(message: string, readonly uncertain: boolean, readonly code: ChannelErrorCode) { super(message); this.name = 'ChannelSendError'; }
}

/** Separate from the group transport on purpose: a Channel is not a group. */
export interface ChannelTransport {
  readonly provider: 'whatsapp-qr';
  connected(): boolean;
  inspect(reference: { jid?: string; invite?: string }): Promise<ChannelInspection>;
  publish(jid: string, content: ChannelContent): Promise<{ providerMessageId: string }>;
  verify(jid: string, probe: { text: string; providerMessageId: string | null; notBefore: number }): Promise<'found' | 'not_found' | 'unknown'>;
  deliveryError(jid: string, providerMessageId: string): string | null;
}

const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const text = (value: unknown): string => typeof value === 'string' ? value : typeof object(value)?.text === 'string' ? String(object(value)!.text) : '';
const roles: Record<string, ChannelRole> = { OWNER: 'owner', ADMIN: 'admin', SUBSCRIBER: 'subscriber', GUEST: 'guest' };

/** Defensive reading of the unofficial metadata payload; unknown shapes never grant permission. */
export function parseNewsletterInspection(raw: unknown): ChannelInspection | null {
  const root = object(raw);
  if (!root) return null;
  const data = typeof root.id === 'string' ? root : object(root.result) ?? object(root.data);
  if (!data || !isNewsletterJid(data.id)) return null;
  const thread = object(data.thread_metadata) ?? {};
  const viewer = object(data.viewer_metadata) ?? {};
  const name = (text(thread.name) || text(data.name)).trim().slice(0, 100);
  const description = (text(thread.description) || text(data.description)).trim().slice(0, 500);
  const inviteValue = typeof thread.invite === 'string' ? thread.invite : typeof data.invite === 'string' ? data.invite : null;
  const subscribersValue = Number(thread.subscribers_count ?? data.subscribers);
  const verificationValue = String(thread.verification ?? data.verification ?? '').toUpperCase();
  const role = roles[String(viewer.role ?? '').toUpperCase()] ?? 'unknown';
  return {
    jid: data.id as string, name: name || 'Canal sem nome', description,
    invite: inviteValue && /^[A-Za-z0-9]{10,64}$/.test(inviteValue) ? inviteValue : null,
    subscribers: Number.isFinite(subscribersValue) && subscribersValue >= 0 ? Math.floor(subscribersValue) : null,
    verification: verificationValue === 'VERIFIED' ? 'verified' : verificationValue === 'UNVERIFIED' ? 'unverified' : null,
    role,
  };
}

interface Node { tag?: unknown; attrs?: unknown; content?: unknown }
export interface FetchedChannelMessage { id: string | null; serverId: string | null; timestamp: number | null; text: string }
/** Finds channel messages in a `newsletterFetchMessages` reply and decodes their plaintext. */
export function readNewsletterMessages(node: unknown, depth = 0): FetchedChannelMessage[] {
  const current = object(node) as Node | null;
  if (!current || depth > 8) return [];
  const found: FetchedChannelMessage[] = [];
  const children = Array.isArray(current.content) ? current.content : [];
  if (current.tag === 'message') {
    const attrs = object(current.attrs) ?? {};
    const plaintext = children.map(child => object(child) as Node | null).find(child => child?.tag === 'plaintext');
    let decoded = '';
    if (plaintext && (plaintext.content instanceof Uint8Array || typeof plaintext.content === 'string')) {
      try {
        const bytes = typeof plaintext.content === 'string' ? Buffer.from(plaintext.content, 'binary') : Buffer.from(plaintext.content);
        const message = proto.Message.decode(bytes);
        decoded = message.conversation || message.extendedTextMessage?.text || message.imageMessage?.caption || message.videoMessage?.caption || '';
      } catch { decoded = ''; }
    }
    const t = Number(attrs.t);
    found.push({ id: typeof attrs.id === 'string' ? attrs.id : null, serverId: typeof attrs.server_id === 'string' ? attrs.server_id : null, timestamp: Number.isFinite(t) && t > 0 ? t * 1000 : null, text: decoded });
    return found;
  }
  for (const child of children.slice(0, 500)) found.push(...readNewsletterMessages(child, depth + 1));
  return found;
}

const comparable = (value: string) => value.replace(/\s+/g, ' ').trim();

export class WhatsAppChannelAdapter implements ChannelTransport {
  readonly provider = 'whatsapp-qr' as const;
  constructor(private readonly client: () => NewsletterClient | null) {}

  connected(): boolean { return this.client() !== null; }

  async inspect(reference: { jid?: string; invite?: string }): Promise<ChannelInspection> {
    const client = this.client();
    if (!client) throw new ChannelSendError('Conecte o WhatsApp para conferir o canal.', false, 'auth');
    if (reference.jid !== undefined && !isNewsletterJid(reference.jid)) throw new ChannelSendError('O identificador informado não é de um Canal do WhatsApp. Grupos e conversas não são aceitos aqui.', false, 'validation');
    if (reference.invite !== undefined && !/^[A-Za-z0-9]{10,64}$/.test(reference.invite)) throw new ChannelSendError('Link de canal inválido.', false, 'validation');
    let raw: unknown;
    try { raw = reference.jid ? await client.metadata('jid', reference.jid) : await client.metadata('invite', reference.invite ?? ''); }
    catch (error) {
      if (error instanceof WhatsAppSendError) throw new ChannelSendError(error.message, false, 'auth');
      throw new ChannelSendError('O WhatsApp não encontrou este canal ou não respondeu. Confira o link e tente de novo.', false, 'not_found');
    }
    const parsed = parseNewsletterInspection(raw);
    if (!parsed) throw new ChannelSendError('O WhatsApp não devolveu os dados deste canal.', false, 'not_found');
    if (reference.jid && parsed.jid !== reference.jid) throw new ChannelSendError('O WhatsApp devolveu outro canal. Nada foi alterado.', false, 'validation');
    return parsed;
  }

  async publish(jid: string, content: ChannelContent): Promise<{ providerMessageId: string }> {
    if (!isNewsletterJid(jid)) throw new ChannelSendError('Destino de Canal inválido. Nada foi enviado.', false, 'validation');
    const client = this.client();
    if (!client) throw new ChannelSendError('WhatsApp desconectado. Nada foi enviado.', false, 'auth');
    let message: AnyMessageContent;
    if (content.kind === 'text') message = { text: content.text };
    else if (!content.media) throw new ChannelSendError('Mídia ausente. Nada foi enviado.', false, 'validation');
    else if (content.kind === 'image') message = { image: content.media.bytes, caption: content.text, mimetype: content.media.mime };
    else if (content.kind === 'video') message = { video: content.media.bytes, caption: content.text, mimetype: content.media.mime };
    else message = { audio: content.media.bytes, mimetype: content.media.mime, ptt: false };
    let sent: { id: string } | null;
    try { sent = await client.send(jid, message); }
    catch (error) {
      // A guard failure happens before any network write; everything else may have left the device.
      if (error instanceof WhatsAppSendError) throw new ChannelSendError(error.message, false, 'auth');
      throw new ChannelSendError('O WhatsApp não confirmou o envio. Confira o canal antes de qualquer nova tentativa.', true, 'transport');
    }
    if (!sent) throw new ChannelSendError('O WhatsApp não devolveu a identificação da publicação. Confira o canal.', true, 'transport');
    return { providerMessageId: sent.id };
  }

  async verify(jid: string, probe: { text: string; providerMessageId: string | null; notBefore: number }): Promise<'found' | 'not_found' | 'unknown'> {
    const client = this.client();
    if (!client || !isNewsletterJid(jid)) return 'unknown';
    let messages: FetchedChannelMessage[];
    try { messages = readNewsletterMessages(await client.fetchMessages(jid, 20)); } catch { return 'unknown'; }
    if (!messages.length) return 'unknown';
    const wanted = comparable(probe.text);
    const recent = messages.filter(message => message.timestamp === null || message.timestamp >= probe.notBefore - 120_000);
    const match = recent.some(message => (probe.providerMessageId && message.id === probe.providerMessageId) || (wanted && comparable(message.text) === wanted));
    return match ? 'found' : 'not_found';
  }

  deliveryError(jid: string, providerMessageId: string): string | null { return this.client()?.deliveryError(jid, providerMessageId) ?? null; }
}
