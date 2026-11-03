import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import type { Database } from '../../../../packages/db/src/index.ts';
import { ChannelRepository } from '../../../../packages/db/src/channels.ts';
import { riskNoticeAccepted, type Settings } from '../../../../packages/shared/src/index.ts';
import {
  canPublishWithRole, channelContentSupport, channelPurposes, channelSettingsSchema, checkChannelPost, defaultChannelSettings, defaultEditorialProfile,
  editorialProfileSchema, isGroupJid, isNewsletterJid, parseChannelLink, postInputSchema, postTransitions, renderChannelPost, templateSchema,
  type AutomaticPublishing, type Channel, type ChannelEvent, type ChannelPost, type ChannelsOverview, type NewsItem, type PostInput, type PostStatus, type PostTemplate,
} from '../../../../packages/shared/src/channels.ts';
import { createSafeFetcher } from '../../../../packages/core/src/safe-fetch.ts';
import { ChannelSendError, type ChannelContent, type ChannelTransport } from './adapter.ts';
import { ChannelMediaStore } from './media.ts';
import { AiService, LocalSecret, type AiFetch } from './ai.ts';
import { NewsService, type FeedFetcher } from './news.ts';

export class ChannelError extends Error { constructor(readonly status: number, message: string) { super(message); this.name = 'ChannelError'; } }

export interface ChannelServiceOptions {
  database: Database;
  transport: ChannelTransport;
  /** Main app settings: the global pause and the WhatsApp risk notice also govern channels. */
  getSettings: () => Settings;
  now?: () => Date;
  fetcher?: FeedFetcher;
  aiSecret?: LocalSecret;
  aiFetch?: AiFetch;
  mediaDirectory?: string;
}

const MINUTE = 60_000, HOUR = 3_600_000, DAY = 86_400_000;
const VERIFY_DELAYS = [20_000, 60_000, 180_000, 600_000, 1_800_000];
const MAX_FAILURES = 3;
const EDITABLE: PostStatus[] = ['draft', 'review', 'approved', 'scheduled', 'rejected'];
const DELETABLE: PostStatus[] = ['draft', 'rejected', 'cancelled', 'expired', 'failed'];
const ACTIVE_QUEUE: PostStatus[] = ['draft', 'review', 'approved', 'scheduled'];

const actionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('submit') }).strict(),
  z.object({ action: z.literal('approve') }).strict(),
  z.object({ action: z.literal('reject'), note: z.string().trim().max(500).optional() }).strict(),
  z.object({ action: z.literal('cancel') }).strict(),
  z.object({ action: z.literal('reopen') }).strict(),
  z.object({ action: z.literal('schedule'), scheduledAt: z.iso.datetime({ offset: true }).nullable() }).strict(),
  z.object({ action: z.literal('unschedule') }).strict(),
  z.object({ action: z.literal('publish_now') }).strict(),
  z.object({ action: z.literal('manual_published'), confirmed: z.literal(true) }).strict(),
  z.object({ action: z.literal('confirm'), outcome: z.enum(['published', 'not_sent']), confirmed: z.literal(true) }).strict(),
]);

function minutesIn(now: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  return Number(parts.find(part => part.type === 'hour')?.value) * 60 + Number(parts.find(part => part.type === 'minute')?.value);
}
/** Allowed publishing window in the channel time zone (Intl handles daylight saving time). */
export function insideWindow(now: Date, settings: Pick<Channel['settings'], 'windowStart' | 'windowEnd' | 'timezone'>): boolean {
  const parse = (value: string) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
  const start = parse(settings.windowStart), end = parse(settings.windowEnd), current = minutesIn(now, settings.timezone);
  if (start === end) return true;
  return start < end ? current >= start && current < end : current >= start || current < end;
}
const dayKey = (date: Date, timezone: string) => new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(date);
const sentAt = (post: ChannelPost) => Date.parse(post.sendingAt ?? post.publishedAt ?? post.updatedAt);

export class ChannelService {
  readonly repo: ChannelRepository;
  readonly media: ChannelMediaStore;
  readonly ai: AiService;
  readonly news: NewsService;
  private tail: Promise<unknown> = Promise.resolve();
  private newsRunning = false;
  private lastCleanup = 0;
  private stopped = false;

  constructor(private readonly options: ChannelServiceOptions) {
    this.repo = new ChannelRepository(options.database);
    this.media = new ChannelMediaStore(options.database, options.mediaDirectory);
    const directory = options.database.storageDirectory();
    this.ai = new AiService({ database: options.database, secret: options.aiSecret ?? new LocalSecret(directory ? { directory: join(directory, 'ai-vault') } : { memory: true }), now: () => this.now(), ...(options.aiFetch ? { fetch: options.aiFetch } : {}) });
    this.news = new NewsService({ repo: this.repo, fetcher: options.fetcher ?? createSafeFetcher(), ai: this.ai, now: () => this.now() });
    this.recover();
  }

  private now(): Date { return this.options.now?.() ?? new Date(); }
  /** Serial queue for every channel mutation, the scheduler and each send. */
  run<T>(operation: () => T | Promise<T>): Promise<T> {
    if (this.stopped) return Promise.reject(new ChannelError(503, 'O serviço está encerrando.'));
    const next = this.tail.then(operation);
    this.tail = next.then(() => undefined, () => undefined);
    return next;
  }
  async stop(): Promise<void> { this.stopped = true; await this.tail.catch(() => undefined); }

  /** A crash while sending cannot be retried safely: it becomes a pending confirmation. */
  private recover(): void {
    const interrupted = this.repo.listPosts({ statuses: ['sending'], limit: 5000 });
    if (!interrupted.length) return;
    this.repo.transaction(() => {
      for (const post of interrupted) {
        this.move(post, 'pending_confirmation', 'Processo interrompido durante o envio. Confira o canal; não haverá reenvio automático.');
        post.uncertain = true;
        this.repo.savePost(post);
        this.event(post.channelId, post.id, 'warning', 'post.interrupted', 'Envio interrompido recuperado para conferência no canal.');
      }
    });
  }

  private event(channelId: string | null, postId: string | null, level: ChannelEvent['level'], event: string, message: string): void {
    this.repo.addEvent({ id: randomUUID(), channelId, postId, createdAt: this.now().toISOString(), level, event, message: message.slice(0, 1000) });
  }
  private move(post: ChannelPost, to: PostStatus, note: string): void {
    if (post.status !== to && !postTransitions[post.status].includes(to)) throw new ChannelError(409, `Não é possível passar de "${post.status}" para "${to}".`);
    const at = this.now().toISOString();
    post.history = [...post.history, { at, from: post.status, to, note: note.slice(0, 500) }].slice(-100);
    post.status = to; post.updatedAt = at;
  }
  private globalPause(): { paused: boolean; reason: string | null } {
    return this.options.database.getRecord<{ paused: boolean; reason: string | null }>('channel-config', 'global') ?? { paused: false, reason: null };
  }

  private channel(id: string): Channel {
    const channel = this.repo.getChannel(id);
    if (!channel || channel.unlinkedAt) throw new ChannelError(404, 'Canal não encontrado.');
    return channel;
  }
  private post(channelId: string, postId: string): ChannelPost {
    const post = this.repo.getPost(postId, channelId);
    if (!post) throw new ChannelError(404, 'Publicação não encontrada neste canal.');
    return post;
  }

  automaticState(channel: Channel): { state: AutomaticPublishing; detail: string } {
    if (!this.options.transport.connected()) return { state: 'unavailable', detail: 'Publicação automática indisponível: o WhatsApp não está conectado.' };
    if (!canPublishWithRole(channel.role)) return { state: 'unavailable', detail: 'Publicação automática indisponível: o número conectado não tem permissão de administrador confirmada neste canal.' };
    if (!channel.realTestConfirmedAt) return { state: 'needs_real_test', detail: 'Publicação automática indisponível: ainda falta comprovar uma publicação real neste canal. Publique uma vez pelo app e confirme que ela apareceu no WhatsApp.' };
    return { state: 'available', detail: 'Publicação real comprovada neste canal. O modo automático pode ser ligado.' };
  }

  overview(): ChannelsOverview {
    const connected = this.options.transport.connected();
    return {
      available: true,
      engine: { provider: 'whatsapp-qr', official: false, connected, detail: connected ? 'Conectado pelo QR Code (biblioteca não oficial do WhatsApp Web).' : 'Conecte o WhatsApp em Fontes & conexões para conferir e publicar nos canais.' },
      globalPause: this.globalPause(),
      channels: this.repo.listChannels().map(channel => { const automatic = this.automaticState(channel); return { ...channel, automaticPublishing: automatic.state, automaticDetail: automatic.detail, counts: this.repo.countByStatus(channel.id) }; }),
      content: channelContentSupport,
    };
  }

  // ---------- channels ----------
  async addChannel(input: unknown): Promise<Channel> {
    const parsed = z.object({ reference: z.string().trim().min(1).max(300), purpose: z.enum(channelPurposes).default('editorial') }).strict().parse(input);
    let reference: { jid?: string; invite?: string };
    if (isNewsletterJid(parsed.reference)) reference = { jid: parsed.reference };
    else if (isGroupJid(parsed.reference)) throw new ChannelError(400, 'Este identificador é de um grupo, não de um Canal. Canais ficam na aba Atualizações do WhatsApp.');
    else { const link = parseChannelLink(parsed.reference); if (!link) throw new ChannelError(400, 'Cole o link público do canal (https://whatsapp.com/channel/...) ou o identificador terminado em @newsletter.'); reference = link; }
    return this.run(async () => {
      const inspection = await this.inspect(reference);
      if (inspection.role === 'subscriber' || inspection.role === 'guest') throw new ChannelError(403, 'O número conectado segue este canal, mas não é administrador. Seguir um canal não dá permissão para publicar nele.');
      const now = this.now().toISOString();
      const existing = this.repo.getChannelByJid(inspection.jid);
      if (existing && !existing.unlinkedAt) throw new ChannelError(409, 'Este canal já está vinculado.');
      const channel: Channel = {
        id: existing?.id ?? randomUUID(), jid: inspection.jid, name: inspection.name, description: inspection.description,
        invite: inspection.invite ?? reference.invite ?? null, publicUrl: (inspection.invite ?? reference.invite) ? `https://whatsapp.com/channel/${inspection.invite ?? reference.invite}` : null,
        subscribers: inspection.subscribers, verification: inspection.verification, role: inspection.role, roleCheckedAt: now,
        purpose: parsed.purpose, active: true, unlinkedAt: null, realTestConfirmedAt: existing?.realTestConfirmedAt ?? null, pausedReason: null, consecutiveFailures: 0,
        settings: existing?.settings ?? { ...defaultChannelSettings(), timezone: this.options.getSettings().timezone },
        editorial: existing?.editorial ?? defaultEditorialProfile(),
        createdAt: existing?.createdAt ?? now, updatedAt: now,
      };
      this.repo.saveChannel(channel);
      this.event(channel.id, null, inspection.role === 'unknown' ? 'warning' : 'info', 'channel.linked', inspection.role === 'unknown' ? `Canal "${channel.name}" vinculado, mas o WhatsApp não informou se este número é administrador. Publicações ficam bloqueadas até a permissão ser confirmada.` : `Canal "${channel.name}" vinculado como ${inspection.role === 'owner' ? 'proprietário' : 'administrador'}.`);
      return channel;
    });
  }
  private async inspect(reference: { jid?: string; invite?: string }) {
    try { return await this.options.transport.inspect(reference); }
    catch (error) { throw new ChannelError(error instanceof ChannelSendError && error.code === 'validation' ? 400 : 409, error instanceof Error ? error.message : 'Não foi possível conferir o canal.'); }
  }
  /** Re-reads metadata and permission. A different channel coming back pauses everything for it. */
  private async refreshInternal(channel: Channel): Promise<Channel> {
    const inspection = await this.inspect({ jid: channel.jid });
    const current = this.channel(channel.id);
    if (inspection.jid !== current.jid) {
      current.settings = { ...current.settings, paused: true }; current.pausedReason = 'O WhatsApp devolveu um destino diferente do canal vinculado. Publicações pausadas por segurança.';
      this.repo.saveChannel(current); this.event(current.id, null, 'error', 'channel.destination_mismatch', current.pausedReason);
      throw new ChannelError(409, current.pausedReason);
    }
    const lost = canPublishWithRole(current.role) && !canPublishWithRole(inspection.role);
    Object.assign(current, { name: inspection.name, description: inspection.description, invite: inspection.invite ?? current.invite, subscribers: inspection.subscribers, verification: inspection.verification, role: inspection.role, roleCheckedAt: this.now().toISOString(), updatedAt: this.now().toISOString() });
    if (current.invite) current.publicUrl = `https://whatsapp.com/channel/${current.invite}`;
    if (lost) { current.settings = { ...current.settings, paused: true }; current.pausedReason = 'O número conectado deixou de ser administrador deste canal. Publicações pausadas.'; this.event(current.id, null, 'error', 'channel.permission_lost', current.pausedReason); }
    this.repo.saveChannel(current);
    return current;
  }
  refreshChannel(id: string): Promise<Channel> { return this.run(() => this.refreshInternal(this.channel(id))); }

  async updateChannel(id: string, input: unknown): Promise<Channel> {
    const parsed = z.object({ purpose: z.enum(channelPurposes).optional(), active: z.boolean().optional(), settings: channelSettingsSchema.optional(), editorial: editorialProfileSchema.optional() }).strict().parse(input);
    return this.run(() => {
      const channel = this.channel(id);
      if (parsed.settings?.mode === 'automatic' && channel.settings.mode !== 'automatic') {
        const automatic = this.automaticState(channel);
        if (automatic.state !== 'available') throw new ChannelError(409, automatic.detail);
      }
      if (parsed.purpose) channel.purpose = parsed.purpose;
      if (parsed.active !== undefined) channel.active = parsed.active;
      if (parsed.settings) { if (!parsed.settings.paused) { channel.pausedReason = null; channel.consecutiveFailures = 0; } channel.settings = parsed.settings; }
      if (parsed.editorial) channel.editorial = parsed.editorial;
      channel.updatedAt = this.now().toISOString();
      this.repo.saveChannel(channel);
      this.event(id, null, 'info', 'channel.updated', 'Configurações do canal salvas.');
      return channel;
    });
  }
  pauseChannel(id: string, paused: boolean): Promise<Channel> {
    return this.run(() => {
      const channel = this.channel(id);
      channel.settings = { ...channel.settings, paused };
      if (!paused) { channel.pausedReason = null; channel.consecutiveFailures = 0; }
      channel.updatedAt = this.now().toISOString(); this.repo.saveChannel(channel);
      this.event(id, null, 'info', paused ? 'channel.paused' : 'channel.resumed', paused ? 'Canal pausado imediatamente.' : 'Canal retomado.');
      return channel;
    });
  }
  async setGlobalPause(input: unknown): Promise<{ paused: boolean; reason: string | null }> {
    const parsed = z.object({ paused: z.boolean(), reason: z.string().trim().max(300).optional() }).strict().parse(input);
    return this.run(() => {
      const value = { paused: parsed.paused, reason: parsed.paused ? parsed.reason || 'Pausa geral acionada pela proprietária.' : null };
      this.options.database.putRecord('channel-config', 'global', value);
      this.event(null, null, 'warning', parsed.paused ? 'channels.paused' : 'channels.resumed', parsed.paused ? 'Pausa geral dos canais ativada: nenhuma publicação sai.' : 'Pausa geral dos canais encerrada.');
      return value;
    });
  }
  /** Unlinks from the app only; the channel itself is never touched on WhatsApp. History is kept. */
  unlinkChannel(id: string): Promise<{ unlinked: true }> {
    return this.run(() => {
      const channel = this.channel(id);
      this.repo.transaction(() => {
        for (const post of this.repo.listPosts({ channelId: id, statuses: ACTIVE_QUEUE, limit: 5000 })) { this.move(post, 'cancelled', 'Canal desvinculado do app.'); this.repo.savePost(post); }
        channel.active = false; channel.unlinkedAt = this.now().toISOString(); channel.updatedAt = channel.unlinkedAt;
        this.repo.saveChannel(channel);
        this.event(id, null, 'warning', 'channel.unlinked', `Canal "${channel.name}" desvinculado do app. Nada foi alterado no WhatsApp.`);
      });
      return { unlinked: true as const };
    });
  }

  // ---------- posts ----------
  private dedupeKey(channelId: string, post: Pick<ChannelPost, 'kind' | 'mediaId' | 'title' | 'subtitle' | 'body' | 'linkUrl' | 'includeSignature'>, signature: string): string {
    const media = post.mediaId ? this.media.record(post.mediaId)?.sha256 ?? post.mediaId : '';
    const text = renderChannelPost(post, { signature }).normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
    return createHash('sha256').update(`${channelId}\0${post.kind}\0${media}\0${text}`).digest('hex');
  }
  private applyInput(channel: Channel, post: ChannelPost, input: PostInput): void {
    if (!channelContentSupport[input.kind].supported) throw new ChannelError(400, channelContentSupport[input.kind].detail);
    let mediaMime: string | null = null, mediaBytes: number | null = null, mediaName: string | null = null;
    if (input.mediaId) {
      const record = this.media.record(input.mediaId);
      if (!record) throw new ChannelError(400, 'Arquivo de mídia não encontrado. Envie o arquivo novamente.');
      if (record.kind !== input.kind) throw new ChannelError(400, 'O arquivo enviado não corresponde ao tipo da publicação. Nada é convertido sem a sua aprovação.');
      mediaMime = record.mime; mediaBytes = record.bytes; mediaName = record.name;
    }
    Object.assign(post, { kind: input.kind, title: input.title, subtitle: input.subtitle, body: input.body, linkUrl: input.linkUrl, includeSignature: input.includeSignature, mediaId: input.mediaId, mediaMime, mediaBytes, mediaName, priority: input.priority });
    post.dedupeKey = this.dedupeKey(channel.id, post, channel.settings.signature);
  }
  private newPost(channel: Channel, input: PostInput, origin: ChannelPost['origin'], newsItemId: string | null): ChannelPost {
    const now = this.now().toISOString();
    const post: ChannelPost = {
      id: randomUUID(), channelId: channel.id, kind: 'text', title: '', subtitle: '', body: '', linkUrl: '', includeSignature: true,
      mediaId: null, mediaMime: null, mediaBytes: null, mediaName: null, origin, newsItemId, priority: 'normal', status: 'draft',
      scheduledAt: null, expiresAt: null, submittedAt: null, approvedAt: null, sendingAt: null, providerMessageId: null, publishedAt: null,
      confirmedAt: null, confirmation: null, uncertain: false, verifyAttempts: 0, lastError: null, dedupeKey: '', createdAt: now, updatedAt: now,
      history: [{ at: now, from: null, to: 'draft', note: origin === 'news' ? 'Rascunho preparado a partir de uma notícia.' : origin === 'template' ? 'Criado a partir de um modelo.' : 'Rascunho criado.' }],
    };
    this.applyInput(channel, post, input);
    return post;
  }
  async createPost(channelId: string, input: unknown, origin: 'manual' | 'template' = 'manual'): Promise<ChannelPost> {
    const parsed = postInputSchema.parse(input);
    return this.run(() => {
      const channel = this.channel(channelId);
      const post = this.newPost(channel, parsed, origin, null);
      this.repo.savePost(post); this.event(channelId, post.id, 'info', 'post.created', 'Rascunho criado.');
      return post;
    });
  }
  async updatePost(channelId: string, postId: string, input: unknown): Promise<ChannelPost> {
    const parsed = postInputSchema.parse(input);
    return this.run(() => {
      const channel = this.channel(channelId), post = this.post(channelId, postId);
      if (!EDITABLE.includes(post.status)) throw new ChannelError(409, 'Esta publicação não pode mais ser editada. Duplique-a para criar uma nova versão.');
      this.applyInput(channel, post, parsed);
      if (post.status !== 'draft') this.move(post, 'draft', 'Conteúdo editado: aprovação anterior removida.');
      else post.updatedAt = this.now().toISOString();
      Object.assign(post, { submittedAt: null, approvedAt: null, scheduledAt: null });
      this.repo.savePost(post); this.event(channelId, postId, 'info', 'post.edited', 'Publicação editada; precisa de nova revisão.');
      return post;
    });
  }
  async duplicatePost(channelId: string, postId: string, input: unknown): Promise<ChannelPost> {
    const parsed = z.object({ targetChannelId: z.string().min(1).max(100).optional() }).strict().parse(input ?? {});
    return this.run(() => {
      const source = this.post(channelId, postId), target = this.channel(parsed.targetChannelId ?? channelId);
      this.channel(channelId);
      if (source.origin === 'news' && target.purpose === 'promotions') throw new ChannelError(409, 'Conteúdo de notícias não vai para um canal de promoções.');
      const copy = this.newPost(target, { kind: source.kind, title: source.title, subtitle: source.subtitle, body: source.body, linkUrl: source.linkUrl, includeSignature: source.includeSignature, mediaId: source.mediaId, priority: source.priority }, source.origin === 'news' ? 'news' : 'manual', null);
      copy.history[0].note = 'Cópia de outra publicação.';
      this.repo.savePost(copy); this.event(target.id, copy.id, 'info', 'post.duplicated', 'Publicação duplicada como rascunho.');
      return copy;
    });
  }
  deletePost(channelId: string, postId: string): Promise<{ deleted: true }> {
    return this.run(() => {
      const post = this.post(channelId, postId);
      if (!DELETABLE.includes(post.status) || post.providerMessageId || post.sendingAt) throw new ChannelError(409, 'Publicações enviadas ou em conferência ficam no histórico e não podem ser excluídas.');
      this.repo.deletePost(postId); this.event(channelId, postId, 'info', 'post.deleted', 'Publicação excluída.');
      return { deleted: true as const };
    });
  }

  /** Every reason a post cannot leave now. Empty means allowed. */
  blockers(channel: Channel, post: ChannelPost, now: Date, trigger: 'human' | 'scheduled'): string[] {
    const reasons: string[] = [];
    const settings = this.options.getSettings(), global = this.globalPause();
    if (global.paused) reasons.push(global.reason ?? 'Pausa geral dos canais ativa.');
    if (settings.paused) reasons.push('Publicações pausadas no botão Pausar do painel.');
    if (!riskNoticeAccepted(settings)) reasons.push('Aceite o aviso sobre o uso do WhatsApp antes de publicar.');
    if (!channel.active || channel.unlinkedAt) reasons.push('Canal desativado.');
    if (channel.settings.paused) reasons.push(channel.pausedReason ?? 'Canal pausado.');
    if (!this.options.transport.connected()) reasons.push('WhatsApp desconectado.');
    if (!canPublishWithRole(channel.role)) reasons.push('O número conectado não tem permissão de administrador confirmada neste canal.');
    if (!['approved', 'scheduled'].includes(post.status)) reasons.push('A publicação precisa estar aprovada.');
    if (post.origin === 'news' && channel.purpose === 'promotions') reasons.push('Conteúdo de notícias não vai para um canal de promoções.');
    if (post.expiresAt && Date.parse(post.expiresAt) <= now.getTime()) reasons.push('A validade desta publicação acabou.');
    reasons.push(...checkChannelPost(post, channel.settings).errors);
    const since = new Date(now.getTime() - Math.max(channel.settings.dedupeDays * DAY, DAY)).toISOString();
    const sent = this.repo.sentPosts(channel.id, since).filter(item => item.id !== post.id);
    if (sent.some(item => item.dedupeKey === post.dedupeKey && sentAt(item) >= now.getTime() - channel.settings.dedupeDays * DAY)) reasons.push(`Conteúdo igual já foi enviado a este canal nos últimos ${channel.settings.dedupeDays} dias.`);
    const today = dayKey(now, channel.settings.timezone);
    const sentToday = sent.filter(item => dayKey(new Date(sentAt(item)), channel.settings.timezone) === today);
    if (post.priority === 'urgent') {
      if (sentToday.filter(item => item.priority === 'urgent').length >= channel.settings.maxUrgentPerDay) reasons.push('Limite diário de publicações urgentes atingido.');
    } else {
      if (sentToday.length >= channel.settings.maxPerDay) reasons.push('Limite diário de publicações deste canal atingido.');
      const last = sent.length ? Math.max(...sent.map(sentAt)) : null;
      if (last !== null && now.getTime() - last < channel.settings.minIntervalMinutes * MINUTE) reasons.push('Intervalo mínimo entre publicações ainda não cumprido.');
      if (trigger === 'scheduled' && !insideWindow(now, channel.settings)) reasons.push('Fora do horário permitido deste canal.');
    }
    return [...new Set(reasons)];
  }

  async action(channelId: string, postId: string, input: unknown): Promise<ChannelPost> {
    const parsed = actionSchema.parse(input);
    return this.run(async () => {
      const channel = this.channel(channelId), post = this.post(channelId, postId), now = this.now();
      const check = () => { const result = checkChannelPost(post, channel.settings); if (result.errors.length) throw new ChannelError(409, result.errors.join(' ')); };
      switch (parsed.action) {
        case 'submit': check(); this.move(post, 'review', 'Enviado para revisão.'); post.submittedAt = now.toISOString(); break;
        case 'approve': {
          check();
          const duplicate = this.repo.sentPosts(channelId, new Date(now.getTime() - channel.settings.dedupeDays * DAY).toISOString()).some(item => item.id !== post.id && item.dedupeKey === post.dedupeKey);
          if (duplicate) throw new ChannelError(409, `Conteúdo igual já foi enviado a este canal nos últimos ${channel.settings.dedupeDays} dias.`);
          this.move(post, 'approved', 'Aprovado.'); post.approvedAt = now.toISOString();
          if (channel.settings.mode !== 'manual') { this.move(post, 'scheduled', 'Agendado para o próximo horário livre (modo assistido).'); post.scheduledAt = now.toISOString(); }
          break;
        }
        case 'reject': this.move(post, 'rejected', parsed.note ? `Rejeitado: ${parsed.note}` : 'Rejeitado.'); break;
        case 'cancel': this.move(post, 'cancelled', 'Cancelado.'); post.scheduledAt = null; break;
        case 'reopen': this.move(post, 'draft', 'Reaberto como rascunho.'); Object.assign(post, { submittedAt: null, approvedAt: null, scheduledAt: null, lastError: null, uncertain: false, verifyAttempts: 0, providerMessageId: null, sendingAt: null }); break;
        case 'schedule': {
          const time = parsed.scheduledAt ? Date.parse(parsed.scheduledAt) : now.getTime();
          if (parsed.scheduledAt && (time <= now.getTime() || time > now.getTime() + 30 * DAY)) throw new ChannelError(400, 'Escolha um horário futuro, em até 30 dias.');
          if (post.expiresAt && time >= Date.parse(post.expiresAt)) throw new ChannelError(400, 'O horário escolhido é depois da validade desta publicação.');
          check();
          this.move(post, 'scheduled', parsed.scheduledAt ? 'Agendado.' : 'Agendado para o próximo horário livre.'); post.scheduledAt = new Date(time).toISOString(); break;
        }
        case 'unschedule': this.move(post, 'approved', 'Agendamento removido.'); post.scheduledAt = null; break;
        case 'publish_now': return this.publishInternal(channel, post, 'human');
        case 'manual_published':
          this.move(post, 'published', 'Publicado manualmente pela proprietária no WhatsApp (o app não enviou).');
          Object.assign(post, { publishedAt: now.toISOString(), confirmedAt: now.toISOString(), confirmation: 'owner', scheduledAt: null }); break;
        case 'confirm':
          if (post.status !== 'pending_confirmation') throw new ChannelError(409, 'Somente publicações com confirmação pendente podem ser conferidas.');
          if (parsed.outcome === 'published') {
            this.move(post, 'published', 'A proprietária confirmou que a publicação apareceu no canal.');
            Object.assign(post, { publishedAt: post.sendingAt ?? now.toISOString(), confirmedAt: now.toISOString(), confirmation: 'owner', uncertain: false, lastError: null });
            if (!channel.realTestConfirmedAt) { channel.realTestConfirmedAt = now.toISOString(); this.repo.saveChannel(channel); this.event(channelId, postId, 'info', 'channel.real_test', 'Publicação real comprovada neste canal pela proprietária.'); }
          } else { this.move(post, 'failed', 'A proprietária confirmou que a publicação NÃO apareceu. Nada será reenviado automaticamente.'); post.uncertain = false; }
          break;
      }
      this.repo.savePost(post);
      this.event(channelId, postId, 'info', `post.${parsed.action}`, post.history.at(-1)?.note ?? 'Publicação atualizada.');
      return post;
    });
  }

  /** Called inside the queue. Claims, sends once, records an honest result. */
  private async publishInternal(channelInput: Channel, postInput: ChannelPost, trigger: 'human' | 'scheduled'): Promise<ChannelPost> {
    let channel = channelInput, post = postInput;
    const now = this.now();
    if (!channel.roleCheckedAt || now.getTime() - Date.parse(channel.roleCheckedAt) > DAY) {
      try { channel = await this.refreshInternal(channel); }
      catch (error) { if (trigger === 'human') throw error; return post; }
      post = this.post(channel.id, post.id);
    }
    const reasons = this.blockers(channel, post, now, trigger);
    if (reasons.length) {
      if (trigger === 'human') throw new ChannelError(409, reasons.join(' '));
      if (post.lastError !== `Aguardando: ${reasons[0]}`) { post.lastError = `Aguardando: ${reasons[0]}`; this.repo.savePost(post); }
      return post;
    }
    let content: ChannelContent;
    const text = renderChannelPost(post, channel.settings);
    if (post.kind === 'text') content = { kind: 'text', text };
    else {
      const file = post.mediaId ? this.media.read(post.mediaId) : null;
      if (!file) {
        this.move(post, 'sending', 'Envio iniciado.'); this.move(post, 'failed', 'Arquivo de mídia ausente ou alterado depois do envio. Nada foi publicado.');
        post.lastError = 'Arquivo de mídia ausente ou alterado.'; this.repo.savePost(post); return post;
      }
      content = { kind: post.kind as 'image' | 'video' | 'audio', text, media: { bytes: file.bytes, mime: file.record.mime } };
    }
    try {
      this.repo.transaction(() => {
        const current = this.post(channel.id, post.id);
        if (!['approved', 'scheduled'].includes(current.status)) throw new ChannelError(409, 'Esta publicação já foi reservada ou encerrada.');
        post = current;
        this.move(post, 'sending', trigger === 'human' ? 'Envio solicitado pela proprietária.' : 'Envio agendado iniciado.');
        Object.assign(post, { sendingAt: this.now().toISOString(), lastError: null });
        this.repo.savePost(post);
      });
    } catch (error) {
      if (error instanceof ChannelError) throw error;
      throw new ChannelError(409, 'Outra publicação deste canal está em envio. Aguarde a conclusão.');
    }
    try {
      const result = await this.options.transport.publish(channel.jid, content);
      this.move(post, 'pending_confirmation', 'O WhatsApp aceitou o envio. Conferindo se a publicação aparece no canal.');
      Object.assign(post, { providerMessageId: result.providerMessageId, uncertain: false, verifyAttempts: 0 });
      channel = this.channel(channel.id); channel.consecutiveFailures = 0; this.repo.saveChannel(channel);
      this.event(channel.id, post.id, 'info', 'post.sent', 'Enviado ao WhatsApp. Aceitação do envio ainda não é publicação confirmada.');
    } catch (error) {
      const failure = error instanceof ChannelSendError ? error : new ChannelSendError('Falha inesperada no envio. Confira o canal.', true, 'transport');
      if (failure.uncertain) { this.move(post, 'pending_confirmation', failure.message); post.uncertain = true; }
      else this.move(post, 'failed', failure.message);
      post.lastError = failure.message;
      channel = this.channel(channel.id); channel.consecutiveFailures++;
      if (failure.code === 'auth' || failure.code === 'permission' || channel.consecutiveFailures >= MAX_FAILURES) {
        channel.settings = { ...channel.settings, paused: true };
        channel.pausedReason = failure.code === 'auth' || failure.code === 'permission' ? `Pausado automaticamente: ${failure.message}` : `Pausado automaticamente após ${channel.consecutiveFailures} falhas seguidas de envio.`;
        this.event(channel.id, null, 'error', 'channel.circuit_open', channel.pausedReason);
      }
      this.repo.saveChannel(channel);
      this.event(channel.id, post.id, failure.uncertain ? 'warning' : 'error', failure.uncertain ? 'post.uncertain' : 'post.failed', failure.message);
    }
    this.repo.savePost(post);
    return post;
  }

  // ---------- scheduler ----------
  /** One pass: expire, confirm, then at most one publication per channel. */
  tick(): Promise<void> {
    return this.run(async () => {
      const now = this.now();
      for (const post of this.repo.listPosts({ statuses: ['review', 'approved', 'scheduled'], limit: 5000 })) {
        if (post.expiresAt && Date.parse(post.expiresAt) <= now.getTime()) { this.move(post, 'expired', 'Validade encerrada antes do envio.'); post.scheduledAt = null; this.repo.savePost(post); this.event(post.channelId, post.id, 'warning', 'post.expired', 'Publicação expirada antes do envio.'); }
      }
      if (this.options.transport.connected()) await this.verifyPending(now);
      const due = this.repo.duePosts(now.toISOString());
      const byChannel = new Map<string, ChannelPost[]>();
      for (const post of due) byChannel.set(post.channelId, [...(byChannel.get(post.channelId) ?? []), post]);
      for (const [channelId, posts] of byChannel) {
        const channel = this.repo.getChannel(channelId);
        if (!channel || channel.unlinkedAt) continue;
        posts.sort((a, b) => (a.priority === b.priority ? 0 : a.priority === 'urgent' ? -1 : 1) || (a.scheduledAt ?? '').localeCompare(b.scheduledAt ?? ''));
        for (const post of posts) {
          const before = post.status;
          const after = await this.publishInternal(channel, post, 'scheduled').catch(() => post);
          if (after.status !== before) break;
        }
      }
      if (now.getTime() - this.lastCleanup > DAY) { this.cleanup(now); this.lastCleanup = now.getTime(); }
    }).then(() => this.newsTick());
  }
  private async verifyPending(now: Date): Promise<void> {
    for (const post of this.repo.listPosts({ statuses: ['pending_confirmation'], limit: 200 })) {
      if (post.verifyAttempts >= VERIFY_DELAYS.length || !post.sendingAt) continue;
      if (now.getTime() - Date.parse(post.sendingAt) < VERIFY_DELAYS[post.verifyAttempts]) continue;
      const channel = this.repo.getChannel(post.channelId);
      if (!channel) continue;
      const delivery = post.providerMessageId ? this.options.transport.deliveryError(channel.jid, post.providerMessageId) : null;
      if (delivery) { post.verifyAttempts = VERIFY_DELAYS.length; post.lastError = `O WhatsApp informou um erro para esta publicação (${delivery}). Confira o canal e registre o resultado.`; this.repo.savePost(post); this.event(channel.id, post.id, 'error', 'post.delivery_error', post.lastError); continue; }
      const result = await this.options.transport.verify(channel.jid, { text: renderChannelPost(post, channel.settings), providerMessageId: post.providerMessageId, notBefore: Date.parse(post.sendingAt) }).catch(() => 'unknown' as const);
      if (result === 'found') {
        this.move(post, 'published', 'Publicação encontrada no canal pelo app.');
        Object.assign(post, { publishedAt: post.sendingAt, confirmedAt: now.toISOString(), confirmation: 'automatic', uncertain: false, lastError: null });
        if (!channel.realTestConfirmedAt) { channel.realTestConfirmedAt = now.toISOString(); this.repo.saveChannel(channel); this.event(channel.id, post.id, 'info', 'channel.real_test', 'Primeira publicação real encontrada neste canal.'); }
        this.event(channel.id, post.id, 'info', 'post.published', 'Publicação confirmada no canal.');
      } else {
        post.verifyAttempts++;
        if (post.verifyAttempts >= VERIFY_DELAYS.length) { post.lastError = 'Não conseguimos confirmar automaticamente. Abra o canal no WhatsApp e registre se a publicação apareceu.'; this.event(channel.id, post.id, 'warning', 'post.unconfirmed', post.lastError); }
      }
      this.repo.savePost(post);
    }
  }
  private cleanup(now: Date): void {
    const referenced = new Set(this.repo.listPosts({ limit: 5000 }).map(post => post.mediaId).filter((id): id is string => Boolean(id)));
    this.media.cleanup(referenced, now);
    this.repo.pruneNews(new Date(now.getTime() - 30 * DAY).toISOString());
    this.repo.pruneEvents(new Date(now.getTime() - 180 * DAY).toISOString());
  }

  // ---------- news ----------
  private async newsTick(): Promise<void> {
    if (this.newsRunning || this.stopped) return;
    const now = this.now().getTime();
    const due = this.repo.listChannels().filter(channel => channel.active && channel.editorial.enabled && this.repo.listSources(channel.id).some(source => source.active)
      && now - Date.parse(this.options.database.getRecord<{ at: string }>('channel-config', `news:${channel.id}`)?.at ?? '1970-01-01T00:00:00Z') >= channel.editorial.monitorEveryMinutes * MINUTE);
    for (const channel of due) await this.runNews(channel.id).catch(() => undefined);
  }
  /** Fetching and AI calls happen outside the queue; every write goes through it. */
  async runNews(channelId: string): Promise<{ fetched: number; created: number; relevant: number; duplicates: number; drafts: number; errors: string[] }> {
    if (this.newsRunning) throw new ChannelError(409, 'Uma busca de notícias já está em andamento.');
    this.newsRunning = true;
    try {
      const channel = this.channel(channelId);
      await this.run(() => this.options.database.putRecord('channel-config', `news:${channelId}`, { at: this.now().toISOString() }));
      const summary = { fetched: 0, created: 0, relevant: 0, duplicates: 0, drafts: 0, errors: [] as string[] };
      for (const source of this.repo.listSources(channelId).filter(item => item.active)) {
        try {
          const fetched = await this.news.fetchSource(source);
          await this.run(() => {
            const current = this.repo.getSource(source.id, channelId);
            if (!current) return;
            const result = fetched.notModified ? null : this.news.ingest(this.channel(channelId), current, fetched.entries);
            this.repo.saveSource({ ...current, lastFetchedAt: this.now().toISOString(), lastStatus: 'ok', lastError: null, etag: fetched.etag, lastModified: fetched.lastModified, itemsSeen: current.itemsSeen + (result?.created ?? 0) });
            if (result) { summary.fetched += result.fetched; summary.created += result.created; summary.relevant += result.relevant; summary.duplicates += result.duplicates; }
          });
        } catch (error) {
          const message = error instanceof Error ? error.message.slice(0, 300) : 'Falha ao ler a fonte.';
          summary.errors.push(`${source.label}: ${message}`);
          await this.run(() => { const current = this.repo.getSource(source.id, channelId); if (current) this.repo.saveSource({ ...current, lastFetchedAt: this.now().toISOString(), lastStatus: 'error', lastError: message }); });
        }
      }
      const candidates = this.repo.listNews(channelId, 500).filter(item => item.status === 'new' && !item.postId)
        .sort((a, b) => b.relevance - a.relevance || (b.publishedAt ?? '').localeCompare(a.publishedAt ?? '')).slice(0, channel.editorial.maxDraftsPerRun);
      for (const item of candidates) { if (await this.draftFromNews(channelId, item.id, true).then(() => true, () => false)) summary.drafts++; }
      await this.run(() => this.event(channelId, null, summary.errors.length ? 'warning' : 'info', 'news.run', `Busca de notícias: ${summary.created} novas, ${summary.relevant} relevantes, ${summary.duplicates} repetidas, ${summary.drafts} rascunhos.${summary.errors.length ? ` Falhas: ${summary.errors.join(' | ')}` : ''}`));
      return summary;
    } finally { this.newsRunning = false; }
  }
  /** Draft from a captured item. In manual/assisted modes it waits in the approval queue. */
  async draftFromNews(channelId: string, itemId: string, automaticRun = false): Promise<ChannelPost> {
    const channel = this.channel(channelId);
    const item = this.repo.getNews(itemId, channelId);
    if (!item) throw new ChannelError(404, 'Notícia não encontrada neste canal.');
    if (item.postId || item.status === 'drafted') throw new ChannelError(409, 'Esta notícia já virou rascunho.');
    if (channel.purpose === 'promotions') throw new ChannelError(409, 'Este canal é de promoções: notícias não são publicadas nele.');
    const prepared = await this.news.draftFor(channel, item);
    return this.run(() => {
      const current = this.repo.getNews(itemId, channelId), fresh = this.channel(channelId);
      if (!current || current.postId) throw new ChannelError(409, 'Esta notícia já virou rascunho.');
      const post = this.newPost(fresh, prepared.draft, 'news', item.id);
      post.expiresAt = new Date(this.now().getTime() + fresh.settings.postValidityHours * HOUR).toISOString();
      if (prepared.aiUsed) post.history.push({ at: post.createdAt, from: 'draft', to: 'draft', note: 'Resumo preparado com a IA configurada nesta conta, só com o texto da fonte.' });
      if (prepared.aiError) post.history.push({ at: post.createdAt, from: 'draft', to: 'draft', note: `IA não usada (${prepared.aiError}). Rascunho feito por regras.` });
      const check = checkChannelPost(post, fresh.settings);
      if (!check.errors.length) {
        this.move(post, 'review', automaticRun ? 'Preparado pela curadoria e enviado para a fila de aprovação.' : 'Enviado para a fila de aprovação.'); post.submittedAt = post.updatedAt;
        if (automaticRun && fresh.settings.mode === 'automatic' && this.automaticState(fresh).state === 'available') {
          this.move(post, 'approved', 'Aprovado automaticamente (modo automático com publicação real comprovada).'); post.approvedAt = post.updatedAt;
          this.move(post, 'scheduled', 'Agendado para o próximo horário livre.'); post.scheduledAt = post.updatedAt;
        }
      }
      this.repo.transaction(() => { this.repo.savePost(post); this.repo.updateNews({ ...current, status: 'drafted', postId: post.id }); });
      this.event(channelId, post.id, 'info', 'news.drafted', `Rascunho preparado: ${item.title.slice(0, 120)}`);
      return post;
    });
  }
  ignoreNews(channelId: string, itemId: string): Promise<NewsItem> {
    return this.run(() => {
      this.channel(channelId);
      const item = this.repo.getNews(itemId, channelId);
      if (!item) throw new ChannelError(404, 'Notícia não encontrada neste canal.');
      if (item.postId) throw new ChannelError(409, 'Esta notícia já virou rascunho; cancele a publicação se não quiser usá-la.');
      return this.repo.updateNews({ ...item, status: 'ignored' });
    });
  }
  addSource(channelId: string, input: unknown) { return this.run(() => this.news.addSource(this.channel(channelId), input)); }
  updateSource(channelId: string, sourceId: string, input: unknown) { return this.run(() => this.news.updateSource(this.channel(channelId), sourceId, input)); }
  deleteSource(channelId: string, sourceId: string) {
    return this.run(() => { this.channel(channelId); if (!this.repo.getSource(sourceId, channelId)) throw new ChannelError(404, 'Fonte não encontrada neste canal.'); this.repo.deleteSource(sourceId); return { deleted: true as const }; });
  }
  async testSource(channelId: string, sourceId: string): Promise<{ ok: boolean; title: string; entries: number; sample: string[]; error: string | null }> {
    this.channel(channelId);
    const source = this.repo.getSource(sourceId, channelId);
    if (!source) throw new ChannelError(404, 'Fonte não encontrada neste canal.');
    try { const result = await this.news.fetchSource({ ...source, etag: null, lastModified: null }); return { ok: true, title: result.title, entries: result.entries.length, sample: result.entries.slice(0, 3).map(entry => entry.title), error: null }; }
    catch (error) { return { ok: false, title: '', entries: 0, sample: [], error: error instanceof Error ? error.message.slice(0, 300) : 'Falha ao ler a fonte.' }; }
  }

  // ---------- templates, media, export ----------
  listTemplates(): PostTemplate[] { return this.options.database.listRecords<PostTemplate>('channel-templates'); }
  async saveTemplate(input: unknown, id?: string): Promise<PostTemplate> {
    const parsed = z.object({ name: z.string().trim().min(1).max(80), content: templateSchema.shape.content }).strict().parse(input);
    return this.run(() => {
      const existing = id ? this.options.database.getRecord<PostTemplate>('channel-templates', id) : undefined;
      if (id && !existing) throw new ChannelError(404, 'Modelo não encontrado.');
      if (!id && this.listTemplates().length >= 100) throw new ChannelError(409, 'Limite de 100 modelos atingido.');
      const now = this.now().toISOString();
      const template = templateSchema.parse({ id: existing?.id ?? randomUUID(), name: parsed.name, content: parsed.content, createdAt: existing?.createdAt ?? now, updatedAt: now });
      this.options.database.putRecord('channel-templates', template.id, template);
      return template;
    });
  }
  deleteTemplate(id: string) { return this.run(() => { this.options.database.deleteRecord('channel-templates', z.string().min(1).max(100).parse(id)); return { deleted: true as const }; }); }
  async uploadMedia(input: unknown) {
    const parsed = z.object({ kind: z.enum(['image', 'video', 'audio']), name: z.string().max(200).default('arquivo'), base64: z.string().min(16).max(4_300_000) }).strict().parse(input);
    return this.run(() => { try { const record = this.media.save(parsed, this.now()); return { id: record.id, mime: record.mime, bytes: record.bytes, name: record.name, kind: record.kind }; } catch (error) { throw new ChannelError(400, error instanceof Error ? error.message : 'Arquivo inválido.'); } });
  }
  export() {
    const channels = this.repo.listChannels(true);
    return {
      schemaVersion: 1, kind: 'promo-iaulin-canais', exportedAt: this.now().toISOString(),
      note: 'Sem arquivos de mídia, chaves ou sessão do WhatsApp.',
      channels, posts: this.repo.listPosts({ limit: 5000 }), sources: channels.flatMap(channel => this.repo.listSources(channel.id)),
      templates: this.listTemplates(), events: this.repo.listEvents({ limit: 1000 }),
    };
  }
  postDetail(channelId: string, postId: string) {
    const channel = this.channel(channelId), post = this.post(channelId, postId);
    const check = checkChannelPost(post, channel.settings);
    return { post, preview: check.text, errors: check.errors, warnings: check.warnings, blockers: ['approved', 'scheduled'].includes(post.status) ? this.blockers(channel, post, this.now(), 'scheduled') : [], events: this.repo.listEvents({ postId, limit: 100 }) };
  }
  channelDetail(id: string) { const channel = this.channel(id); return { channel, automatic: this.automaticState(channel), counts: this.repo.countByStatus(id) }; }
}
