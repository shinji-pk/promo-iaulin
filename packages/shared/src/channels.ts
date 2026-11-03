import { z } from 'zod';

/**
 * Canais do WhatsApp (aba Atualizações). Um Canal NÃO é grupo, lista de transmissão,
 * Comunidade, Status nem conversa individual. No protocolo do WhatsApp Web o Canal
 * aparece como "newsletter" (JID terminado em @newsletter).
 */
export const NEWSLETTER_JID_PATTERN = /^\d{6,32}@newsletter$/;
export const GROUP_JID_PATTERN = /^\d+(?:-\d+)?@g\.us$/;
export const isNewsletterJid = (value: unknown): value is string => typeof value === 'string' && value.length <= 64 && NEWSLETTER_JID_PATTERN.test(value);
export const isGroupJid = (value: unknown): value is string => typeof value === 'string' && value.length <= 100 && GROUP_JID_PATTERN.test(value);

/** Accepts only the public channel link format published by WhatsApp. */
export function parseChannelLink(input: string): { invite: string } | null {
  if (typeof input !== 'string' || input.length > 300 || /[\s\\]/u.test(input.trim())) return null;
  let url: URL;
  try { url = new URL(input.trim()); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash) return null;
  if (!['whatsapp.com', 'www.whatsapp.com'].includes(url.hostname.toLowerCase())) return null;
  const match = /^\/channel\/([A-Za-z0-9]{10,64})\/?$/.exec(url.pathname);
  return match ? { invite: match[1] } : null;
}

export const channelRoles = ['owner', 'admin', 'subscriber', 'guest', 'unknown'] as const;
export type ChannelRole = typeof channelRoles[number];
/** Following a channel is not permission to administer it. */
export const canPublishWithRole = (role: ChannelRole): boolean => role === 'owner' || role === 'admin';
export const channelRoleNames: Record<ChannelRole, string> = { owner: 'Proprietário', admin: 'Administrador', subscriber: 'Seguidor (sem permissão de publicar)', guest: 'Visitante (sem permissão de publicar)', unknown: 'Permissão não confirmada' };

const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const timezone = z.string().max(64).refine(value => { try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; } }, 'Fuso horário inválido.');
const timestamp = z.iso.datetime({ offset: true });
const shortList = (max: number, length: number) => z.array(z.string().trim().min(1).max(length)).max(max).default([]);

export const channelModes = ['manual', 'assisted', 'automatic'] as const;
export type ChannelMode = typeof channelModes[number];
export const channelModeNames: Record<ChannelMode, string> = { manual: 'Manual', assisted: 'Assistido', automatic: 'Automático' };

/** A promotions channel never receives editorial/news posts automatically, and vice versa. */
export const channelPurposes = ['editorial', 'promotions'] as const;
export type ChannelPurpose = typeof channelPurposes[number];

export const channelSettingsSchema = z.object({
  mode: z.enum(channelModes).default('manual'),
  paused: z.boolean().default(false),
  minIntervalMinutes: z.number().int().min(5).max(1440).default(60),
  maxPerDay: z.number().int().min(1).max(48).default(6),
  maxUrgentPerDay: z.number().int().min(0).max(10).default(1),
  windowStart: clock.default('08:00'),
  windowEnd: clock.default('22:00'),
  timezone: timezone.default('America/Sao_Paulo'),
  dedupeDays: z.number().int().min(1).max(90).default(7),
  postValidityHours: z.number().int().min(1).max(336).default(48),
  signature: z.string().max(240).default(''),
}).strict();
export type ChannelSettings = z.infer<typeof channelSettingsSchema>;
export const defaultChannelSettings = (): ChannelSettings => channelSettingsSchema.parse({});

/** Per-channel editorial profile. Empty by default: the product imposes no topic. */
export const editorialProfileSchema = z.object({
  enabled: z.boolean().default(false),
  projectName: z.string().trim().max(80).default(''),
  description: z.string().trim().max(500).default(''),
  mainTopic: z.string().trim().max(120).default(''),
  subtopics: shortList(30, 80),
  keywords: shortList(100, 60),
  excludedWords: shortList(100, 60),
  regions: shortList(30, 60),
  languages: z.array(z.string().trim().regex(/^[a-z]{2,3}(?:-[A-Za-z]{2,4})?$/)).max(10).default([]),
  monitorEveryMinutes: z.number().int().min(15).max(1440).default(60),
  maxDraftsPerRun: z.number().int().min(1).max(20).default(5),
  minRelevance: z.number().int().min(1).max(20).default(2),
  writingStyle: z.string().trim().max(300).default(''),
  tone: z.string().trim().max(120).default(''),
  length: z.enum(['short', 'medium', 'long']).default('short'),
  emojis: z.enum(['none', 'few', 'many']).default('few'),
  markUnconfirmed: z.boolean().default(true),
  customInstructions: z.string().trim().max(2000).default(''),
  analysisEnabled: z.boolean().default(false),
}).strict();
export type EditorialProfile = z.infer<typeof editorialProfileSchema>;
export const defaultEditorialProfile = (): EditorialProfile => editorialProfileSchema.parse({});

export interface Channel {
  id: string;
  jid: string;
  name: string;
  description: string;
  publicUrl: string | null;
  invite: string | null;
  subscribers: number | null;
  verification: 'verified' | 'unverified' | null;
  role: ChannelRole;
  roleCheckedAt: string | null;
  purpose: ChannelPurpose;
  active: boolean;
  unlinkedAt: string | null;
  /** Set only after an owner-confirmed or verified publication in this very channel. */
  realTestConfirmedAt: string | null;
  pausedReason: string | null;
  consecutiveFailures: number;
  settings: ChannelSettings;
  editorial: EditorialProfile;
  createdAt: string;
  updatedAt: string;
}

export const postKinds = ['text', 'image', 'video', 'audio', 'poll'] as const;
export type PostKind = typeof postKinds[number];
export const postStatuses = ['draft', 'review', 'approved', 'scheduled', 'sending', 'pending_confirmation', 'published', 'rejected', 'cancelled', 'failed', 'expired'] as const;
export type PostStatus = typeof postStatuses[number];
export const postStatusNames: Record<PostStatus, string> = {
  draft: 'Rascunho', review: 'Em revisão', approved: 'Aprovado', scheduled: 'Agendado', sending: 'Enviando',
  pending_confirmation: 'Confirmação pendente', published: 'Publicado', rejected: 'Rejeitado', cancelled: 'Cancelado', failed: 'Falhou', expired: 'Expirado',
};

/** What the current engine can really do. Nothing unproven is offered silently. */
export interface ContentSupport { supported: boolean; detail: string; }
export const channelContentSupport: Record<PostKind, ContentSupport> = {
  text: { supported: true, detail: 'Texto com títulos, emojis e links.' },
  image: { supported: true, detail: 'Imagem JPEG, PNG ou WebP de até 3 MB, com legenda de até 1.024 caracteres.' },
  video: { supported: true, detail: 'Vídeo MP4 de até 3 MB, com legenda de até 1.024 caracteres.' },
  audio: { supported: true, detail: 'Áudio MP3, OGG ou M4A de até 3 MB, sem legenda.' },
  poll: { supported: false, detail: 'Enquetes em Canais não têm suporte comprovado neste motor. Use um texto com a pergunta.' },
};
export const channelMediaLimits = { maxBytes: 3 * 1024 * 1024 } as const;
export const channelMediaMimes: Record<'image' | 'video' | 'audio', string[]> = {
  image: ['image/jpeg', 'image/png', 'image/webp'],
  video: ['video/mp4'],
  audio: ['audio/mpeg', 'audio/ogg', 'audio/mp4'],
};
export const MAX_CHANNEL_TEXT = 4096;
export const MAX_CHANNEL_CAPTION = 1024;

export interface PostHistoryEntry { at: string; from: PostStatus | null; to: PostStatus; note: string; }
export interface ChannelPost {
  id: string;
  channelId: string;
  kind: PostKind;
  title: string;
  subtitle: string;
  body: string;
  linkUrl: string;
  includeSignature: boolean;
  mediaId: string | null;
  mediaMime: string | null;
  mediaBytes: number | null;
  mediaName: string | null;
  origin: 'manual' | 'news' | 'template';
  newsItemId: string | null;
  priority: 'normal' | 'urgent';
  status: PostStatus;
  scheduledAt: string | null;
  expiresAt: string | null;
  submittedAt: string | null;
  approvedAt: string | null;
  sendingAt: string | null;
  providerMessageId: string | null;
  publishedAt: string | null;
  confirmedAt: string | null;
  confirmation: 'automatic' | 'owner' | null;
  uncertain: boolean;
  verifyAttempts: number;
  lastError: string | null;
  dedupeKey: string;
  createdAt: string;
  updatedAt: string;
  history: PostHistoryEntry[];
}

const httpsUrl = z.string().trim().max(2048).refine(value => {
  if (!value) return true;
  if (/[\s\\]/u.test(value)) return false;
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password; } catch { return false; }
}, 'Use um link HTTPS válido, sem senha no endereço.');

/** Editable fields only. Status, identity and evidence are never accepted from the client. */
export const postInputSchema = z.object({
  kind: z.enum(postKinds).default('text'),
  title: z.string().trim().max(120).refine(value => !/[\r\n]/.test(value), 'O título deve ter uma linha.').default(''),
  subtitle: z.string().trim().max(160).refine(value => !/[\r\n]/.test(value), 'O subtítulo deve ter uma linha.').default(''),
  body: z.string().max(MAX_CHANNEL_TEXT).default(''),
  linkUrl: httpsUrl.default(''),
  includeSignature: z.boolean().default(true),
  mediaId: z.uuid().nullable().default(null),
  priority: z.enum(['normal', 'urgent']).default('normal'),
}).strict();
export type PostInput = z.infer<typeof postInputSchema>;

export const templateSchema = z.object({
  id: z.string().min(1).max(100),
  name: z.string().trim().min(1).max(80),
  content: postInputSchema.omit({ mediaId: true, priority: true }),
  createdAt: timestamp,
  updatedAt: timestamp,
}).strict();
export type PostTemplate = z.infer<typeof templateSchema>;

// eslint-disable-next-line no-control-regex -- Remove control characters except tab and newline.
const controlCharacters = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const clean = (value: string) => value.replace(/\r\n?/g, '\n').replace(controlCharacters, '').trim();

/**
 * The exact text that goes to WhatsApp. The panel preview and the worker use this same
 * function, so the preview is the message, not an approximation.
 */
export function renderChannelPost(post: Pick<ChannelPost, 'title' | 'subtitle' | 'body' | 'linkUrl' | 'includeSignature'>, settings: Pick<ChannelSettings, 'signature'>): string {
  const parts: string[] = [];
  const title = clean(post.title), subtitle = clean(post.subtitle), body = clean(post.body), link = post.linkUrl.trim(), signature = clean(settings.signature);
  if (title) parts.push(`*${title.replace(/\*/g, '')}*`);
  if (subtitle) parts.push(`_${subtitle.replace(/_/g, '')}_`);
  if (body) parts.push(body);
  if (link) parts.push(link);
  if (post.includeSignature && signature) parts.push(signature);
  return parts.join('\n\n');
}

export interface ContentCheck { errors: string[]; warnings: string[]; text: string; }
/** Size, media, URL, legibility and required fields, shared by panel and worker. */
export function checkChannelPost(post: Pick<ChannelPost, 'kind' | 'title' | 'subtitle' | 'body' | 'linkUrl' | 'includeSignature' | 'mediaId' | 'mediaMime' | 'mediaBytes'>, settings: Pick<ChannelSettings, 'signature'>): ContentCheck {
  const errors: string[] = [], warnings: string[] = [];
  const support = channelContentSupport[post.kind];
  if (!support.supported) errors.push(`${support.detail}`);
  const text = renderChannelPost(post, settings);
  const media = post.kind === 'image' || post.kind === 'video' || post.kind === 'audio';
  if (media) {
    if (!post.mediaId || !post.mediaMime) errors.push('Envie o arquivo de mídia antes de continuar.');
    else if (!channelMediaMimes[post.kind].includes(post.mediaMime)) errors.push('O arquivo enviado não corresponde ao tipo escolhido. Nada será convertido sem a sua aprovação.');
    if ((post.mediaBytes ?? 0) > channelMediaLimits.maxBytes) errors.push('O arquivo passa de 3 MB.');
    if (post.kind === 'audio' && text) errors.push('Áudio em Canal não leva legenda. Publique o texto em uma publicação separada.');
    else if (text.length > MAX_CHANNEL_CAPTION) errors.push(`A legenda tem ${text.length} caracteres; o limite é ${MAX_CHANNEL_CAPTION}.`);
  } else if (post.kind === 'text') {
    if (post.mediaId) errors.push('Publicações de texto não levam arquivo. Escolha o tipo de mídia correspondente.');
    if (!clean(post.body) && !clean(post.title)) errors.push('Escreva o texto da publicação.');
    if (text.length > MAX_CHANNEL_TEXT) errors.push(`O texto final tem ${text.length} caracteres; o limite é ${MAX_CHANNEL_TEXT}.`);
  }
  if (post.linkUrl) {
    try {
      const url = new URL(post.linkUrl);
      if (url.protocol !== 'https:') errors.push('Use somente links HTTPS.');
      if (/^(localhost|127\.|10\.|192\.168\.|169\.254\.)/.test(url.hostname)) errors.push('O link aponta para um endereço privado.');
    } catch { errors.push('O link não é válido.'); }
  }
  const letters = text.replace(/https?:\/\/\S+/g, '').replace(/[^A-Za-zÀ-ÿ]/g, '');
  if (letters.length > 40 && letters.replace(/[^A-ZÀ-Þ]/g, '').length / letters.length > 0.6) warnings.push('Muito texto em letras maiúsculas dificulta a leitura.');
  const emojiCount = (text.match(/\p{Extended_Pictographic}/gu) ?? []).length;
  if (emojiCount > 20) warnings.push(`São ${emojiCount} emojis; o excesso atrapalha a leitura.`);
  if (text.split('\n').some(line => line.length > 700)) warnings.push('Há um parágrafo muito longo. Quebre o texto em partes menores.');
  if ((text.match(/https?:\/\//g) ?? []).length > 3) warnings.push('Muitos links na mesma publicação reduzem a confiança de quem lê.');
  return { errors, warnings, text };
}

/** Legal post transitions. Anything not listed is refused by the worker. */
export const postTransitions: Record<PostStatus, PostStatus[]> = {
  draft: ['review', 'cancelled'],
  review: ['approved', 'rejected', 'draft', 'cancelled', 'expired'],
  // 'published' from approved/scheduled is only the owner declaring a MANUAL publication in the app.
  approved: ['scheduled', 'sending', 'draft', 'cancelled', 'expired', 'published'],
  scheduled: ['approved', 'sending', 'draft', 'cancelled', 'expired', 'published'],
  sending: ['pending_confirmation', 'failed'],
  pending_confirmation: ['published', 'failed'],
  published: [],
  rejected: ['draft'],
  cancelled: ['draft'],
  failed: ['draft'],
  expired: ['draft'],
};

export const newsSourceSchema = z.object({
  url: httpsUrl.refine(Boolean, 'Informe o endereço do feed.'),
  label: z.string().trim().min(1).max(80),
  active: z.boolean().default(true),
}).strict();
export interface NewsSource {
  id: string; channelId: string; url: string; label: string; active: boolean;
  createdAt: string; lastFetchedAt: string | null; lastStatus: 'ok' | 'error' | null; lastError: string | null;
  etag: string | null; lastModified: string | null; itemsSeen: number;
}
export type NewsItemStatus = 'new' | 'drafted' | 'ignored' | 'duplicate' | 'excluded' | 'irrelevant';
export interface NewsItem {
  id: string; channelId: string; sourceId: string; sourceLabel: string; sourceDomain: string;
  url: string; canonicalUrl: string; guid: string | null;
  title: string; excerpt: string; author: string | null; categories: string[]; language: string | null;
  /** Dates are kept apart on purpose: when it happened is usually NOT in the feed. */
  eventDate: string | null; publishedAt: string | null; updatedAt: string | null; fetchedAt: string;
  relevance: number; matched: string[]; status: NewsItemStatus; duplicateOf: string | null;
  corroboratingSources: number; confirmation: 'single_source' | 'corroborated';
  postId: string | null;
}

export const aiProviders = ['none', 'anthropic', 'openai-compatible'] as const;
export type AiProvider = typeof aiProviders[number];
export const aiSettingsSchema = z.object({
  provider: z.enum(aiProviders).default('none'),
  model: z.string().trim().max(120).regex(/^[A-Za-z0-9._:/-]*$/).default(''),
  baseUrl: httpsUrl.default(''),
  maxCallsPerDay: z.number().int().min(1).max(500).default(30),
  summarize: z.boolean().default(true),
  suggestTitles: z.boolean().default(false),
}).strict();
export type AiSettings = z.infer<typeof aiSettingsSchema>;
export interface AiStatus { settings: AiSettings; keyConfigured: boolean; callsToday: number; available: boolean; detail: string; }

export interface ChannelEvent { id: string; channelId: string | null; postId: string | null; createdAt: string; level: 'info' | 'warning' | 'error'; event: string; message: string; }

export type AutomaticPublishing = 'unavailable' | 'needs_real_test' | 'available';
export interface ChannelsOverview {
  available: boolean;
  engine: { provider: 'whatsapp-qr' | 'offline'; official: false; connected: boolean; detail: string };
  globalPause: { paused: boolean; reason: string | null };
  channels: (Channel & { automaticPublishing: AutomaticPublishing; automaticDetail: string; counts: Partial<Record<PostStatus, number>> })[];
  content: Record<PostKind, ContentSupport>;
}
