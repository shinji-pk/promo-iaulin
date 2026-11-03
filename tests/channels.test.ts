import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Server } from 'node:http';
import { proto } from '@whiskeysockets/baileys';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Database } from '../packages/db/src/index.ts';
import { defaultSettings, RISK_NOTICE_VERSION, type Settings, type WhatsAppStatus } from '../packages/shared/src/index.ts';
import { checkChannelPost, isGroupJid, isNewsletterJid, parseChannelLink, renderChannelPost, type ChannelPost, type ChannelsOverview, type ChannelRole } from '../packages/shared/src/channels.ts';
import { ChannelSendError, parseNewsletterInspection, readNewsletterMessages, WhatsAppChannelAdapter, type ChannelContent, type ChannelTransport } from '../apps/worker/src/channels/adapter.ts';
import { ChannelError, ChannelService, insideWindow } from '../apps/worker/src/channels/service.ts';
import { sniffMedia } from '../apps/worker/src/channels/media.ts';
import { WhatsAppSendError, type NewsletterClient } from '../apps/worker/src/whatsapp.ts';
import { createApp, type WhatsAppTransport } from '../apps/worker/src/api.ts';

const CHANNEL = '120363000000000001@newsletter';
const OTHER = '120363000000000002@newsletter';
const LINK = 'https://whatsapp.com/channel/0029VaTesteCanalAbc12';
const GROUP = '120363999999999999@g.us';
const settings = (): Settings => ({ ...defaultSettings(), riskNotice: { version: RISK_NOTICE_VERSION, acceptedAt: '2026-11-01T12:00:00.000Z' } });

class FakeTransport implements ChannelTransport {
  readonly provider = 'whatsapp-qr' as const;
  isConnected = true;
  roles = new Map<string, ChannelRole>([[CHANNEL, 'owner'], [OTHER, 'admin']]);
  invites = new Map<string, string>([['0029VaTesteCanalAbc12', CHANNEL]]);
  sent: { jid: string; content: ChannelContent }[] = [];
  failure: ChannelSendError | null = null;
  visible = new Set<string>();
  verifyResult: 'found' | 'not_found' | 'unknown' | null = null;
  connected() { return this.isConnected; }
  async inspect(reference: { jid?: string; invite?: string }) {
    if (!this.isConnected) throw new ChannelSendError('Conecte o WhatsApp para conferir o canal.', false, 'auth');
    const jid = reference.jid ?? this.invites.get(reference.invite ?? '');
    if (!jid || !this.roles.has(jid)) throw new ChannelSendError('Canal não encontrado.', false, 'not_found');
    return { jid, name: jid === CHANNEL ? 'Canal de teste' : 'Outro canal', description: '', invite: reference.invite ?? null, subscribers: 10, verification: null, role: this.roles.get(jid)! };
  }
  async publish(jid: string, content: ChannelContent) {
    if (this.failure) throw this.failure;
    this.sent.push({ jid, content });
    const id = `MSG-${this.sent.length}`;
    this.visible.add(`${jid}:${content.text}`);
    return { providerMessageId: id };
  }
  async verify(jid: string, probe: { text: string }) { return this.verifyResult ?? (this.visible.has(`${jid}:${probe.text}`) ? 'found' as const : 'not_found' as const); }
  deliveryError() { return null; }
}

function setup(options: { now?: () => Date } = {}) {
  const database = new Database(':memory:');
  database.saveSettings(settings());
  const transport = new FakeTransport();
  let clock = new Date('2026-11-03T15:00:00.000Z'); // 12:00 em São Paulo
  const now = options.now ?? (() => clock);
  const service = new ChannelService({ database, transport, getSettings: () => database.getSettings(), now });
  return { database, transport, service, advance: (ms: number) => { clock = new Date(clock.getTime() + ms); }, setClock: (value: string) => { clock = new Date(value); } };
}
const text = { kind: 'text' as const, title: 'Boletim', body: 'Primeira publicação do canal.' };

async function approved(service: ChannelService, channelId: string, body = text) {
  const post = await service.createPost(channelId, body);
  await service.action(channelId, post.id, { action: 'submit' });
  return service.action(channelId, post.id, { action: 'approve' });
}

describe('Canais: identificação e conteúdo', () => {
  it('distingue Canal (newsletter) de grupo e aceita só o link público oficial', () => {
    expect(isNewsletterJid(CHANNEL)).toBe(true);
    expect(isNewsletterJid(GROUP)).toBe(false);
    expect(isGroupJid(GROUP)).toBe(true);
    expect(isGroupJid(CHANNEL)).toBe(false);
    expect(parseChannelLink(LINK)).toEqual({ invite: '0029VaTesteCanalAbc12' });
    for (const bad of ['http://whatsapp.com/channel/0029VaTesteCanalAbc12', 'https://chat.whatsapp.com/ABCDEFGHIJKL', 'https://whatsapp.com.evil.com/channel/0029VaTesteCanalAbc12', `${LINK}?x=1`, 'https://whatsapp.com/channel/curto'])
      expect(parseChannelLink(bad)).toBeNull();
  });
  it('a prévia é exatamente o texto enviado e valida tamanho, mídia, link e legibilidade', () => {
    const post = { kind: 'text' as const, title: 'Título', subtitle: 'Sub', body: 'Corpo', linkUrl: 'https://exemplo.com.br/a', includeSignature: true, mediaId: null, mediaMime: null, mediaBytes: null };
    expect(renderChannelPost(post, { signature: '— Equipe' })).toBe('*Título*\n\n_Sub_\n\nCorpo\n\nhttps://exemplo.com.br/a\n\n— Equipe');
    expect(checkChannelPost(post, { signature: '' }).errors).toEqual([]);
    expect(checkChannelPost({ ...post, body: 'x'.repeat(5000) }, { signature: '' }).errors.join()).toContain('limite');
    expect(checkChannelPost({ ...post, kind: 'image' }, { signature: '' }).errors.join()).toContain('arquivo');
    expect(checkChannelPost({ ...post, kind: 'image', mediaId: 'x', mediaMime: 'video/mp4', mediaBytes: 10 }, { signature: '' }).errors.join()).toContain('não corresponde');
    expect(checkChannelPost({ ...post, kind: 'poll' }, { signature: '' }).errors.join()).toContain('Enquetes');
    expect(checkChannelPost({ ...post, linkUrl: 'https://127.0.0.1/x' }, { signature: '' }).errors.join()).toContain('privado');
    expect(checkChannelPost({ ...post, body: 'TEXTO TODO EM MAIUSCULAS PARA TESTAR A LEGIBILIDADE DA MENSAGEM' }, { signature: '' }).warnings.join()).toContain('maiúsculas');
  });
  it('reconhece o formato real do arquivo pelos bytes', () => {
    expect(sniffMedia(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]))).toBe('image/jpeg');
    expect(sniffMedia(Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypmp42'), Buffer.alloc(4)]))).toBe('video/mp4');
    expect(sniffMedia(Buffer.from('OggS00000000'))).toBe('audio/ogg');
    expect(sniffMedia(Buffer.from('<html><script>'))).toBeNull();
  });
});

describe('Canais: adaptador newsletter separado do adaptador de grupos', () => {
  const client = (overrides: Partial<NewsletterClient> = {}): NewsletterClient => ({
    metadata: vi.fn(async () => ({ id: CHANNEL, thread_metadata: { name: { text: 'Canal real' }, description: { text: 'Descrição' }, invite: '0029VaTesteCanalAbc12', subscribers_count: '42', verification: 'UNVERIFIED' }, viewer_metadata: { role: 'ADMIN' } })),
    send: vi.fn(async () => ({ id: 'ABC123' })), fetchMessages: vi.fn(async () => ({})), deliveryError: () => null, ...overrides,
  });
  it('lê o papel do número no canal; seguir não é administrar', () => {
    expect(parseNewsletterInspection({ id: CHANNEL, thread_metadata: { name: { text: 'X' } }, viewer_metadata: { role: 'OWNER' } })?.role).toBe('owner');
    expect(parseNewsletterInspection({ id: CHANNEL, thread_metadata: { name: { text: 'X' } }, viewer_metadata: { role: 'SUBSCRIBER' } })?.role).toBe('subscriber');
    expect(parseNewsletterInspection({ id: CHANNEL, name: 'Sem papel' })?.role).toBe('unknown');
    expect(parseNewsletterInspection({ id: GROUP, name: 'Grupo' })).toBeNull();
  });
  it('nunca envia para grupo e classifica falhas sem reenviar', async () => {
    const fake = client();
    const adapter = new WhatsAppChannelAdapter(() => fake);
    await expect(adapter.publish(GROUP, { kind: 'text', text: 'oi' })).rejects.toMatchObject({ uncertain: false, code: 'validation' });
    expect(fake.send).not.toHaveBeenCalled();
    expect(await adapter.publish(CHANNEL, { kind: 'text', text: 'oi' })).toEqual({ providerMessageId: 'ABC123' });
    expect(fake.send).toHaveBeenCalledWith(CHANNEL, { text: 'oi' });
    const network = new WhatsAppChannelAdapter(() => client({ send: vi.fn(async () => { throw new Error('socket closed'); }) }));
    await expect(network.publish(CHANNEL, { kind: 'text', text: 'oi' })).rejects.toMatchObject({ uncertain: true, code: 'transport' });
    const changed = new WhatsAppChannelAdapter(() => client({ send: vi.fn(async () => { throw new WhatsAppSendError('mudou'); }) }));
    await expect(changed.publish(CHANNEL, { kind: 'text', text: 'oi' })).rejects.toMatchObject({ uncertain: false, code: 'auth' });
    await expect(new WhatsAppChannelAdapter(() => null).publish(CHANNEL, { kind: 'text', text: 'oi' })).rejects.toMatchObject({ uncertain: false, code: 'auth' });
    const image = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
    await adapter.publish(CHANNEL, { kind: 'image', text: 'legenda', media: { bytes: image, mime: 'image/jpeg' } });
    expect(fake.send).toHaveBeenLastCalledWith(CHANNEL, { image, caption: 'legenda', mimetype: 'image/jpeg' });
  });
  it('confere no próprio canal se a publicação apareceu', async () => {
    const plaintext = proto.Message.encode({ conversation: 'Texto publicado' }).finish();
    const reply = { tag: 'iq', attrs: {}, content: [{ tag: 'message_updates', attrs: {}, content: [{ tag: 'messages', attrs: {}, content: [{ tag: 'message', attrs: { server_id: '101', t: String(Math.floor(Date.UTC(2026, 10, 3, 15) / 1000)) }, content: [{ tag: 'plaintext', attrs: {}, content: plaintext }] }] }] }] };
    expect(readNewsletterMessages(reply)).toEqual([{ id: null, serverId: '101', timestamp: Date.UTC(2026, 10, 3, 15), text: 'Texto publicado' }]);
    const adapter = new WhatsAppChannelAdapter(() => client({ fetchMessages: vi.fn(async () => reply) }));
    expect(await adapter.verify(CHANNEL, { text: 'Texto publicado', providerMessageId: 'X', notBefore: Date.UTC(2026, 10, 3, 15) })).toBe('found');
    expect(await adapter.verify(CHANNEL, { text: 'Outro texto', providerMessageId: 'X', notBefore: Date.UTC(2026, 10, 3, 15) })).toBe('not_found');
    expect(await new WhatsAppChannelAdapter(() => client({ fetchMessages: vi.fn(async () => { throw new Error('x'); }) })).verify(CHANNEL, { text: 'a', providerMessageId: null, notBefore: 0 })).toBe('unknown');
  });
});

describe('Canais: vínculo, fluxo editorial e publicação', () => {
  it('vincula pelo link, recusa grupos, seguidores e duplicidade', async () => {
    const { service, transport } = setup();
    await expect(service.addChannel({ reference: GROUP })).rejects.toThrow('grupo');
    const channel = await service.addChannel({ reference: LINK });
    expect(channel).toMatchObject({ jid: CHANNEL, role: 'owner', publicUrl: LINK, realTestConfirmedAt: null, settings: { mode: 'manual' }, editorial: { enabled: false, keywords: [], mainTopic: '' } });
    await expect(service.addChannel({ reference: CHANNEL })).rejects.toThrow('já está vinculado');
    transport.roles.set(OTHER, 'subscriber');
    await expect(service.addChannel({ reference: OTHER })).rejects.toThrow('não é administrador');
  });

  it('segue Rascunho → Em revisão → Aprovado → Enviando → Confirmação pendente → Publicado, com histórico', async () => {
    const { service, transport, advance } = setup();
    const channel = await service.addChannel({ reference: LINK });
    const draft = await service.createPost(channel.id, text);
    await expect(service.action(channel.id, draft.id, { action: 'approve' })).rejects.toThrow();
    const post = await approved(service, channel.id);
    expect(post.status).toBe('approved');
    const sent = await service.action(channel.id, post.id, { action: 'publish_now' });
    expect(sent).toMatchObject({ status: 'pending_confirmation', providerMessageId: 'MSG-1', uncertain: false });
    expect(transport.sent).toEqual([{ jid: CHANNEL, content: { kind: 'text', text: '*Boletim*\n\nPrimeira publicação do canal.' } }]);
    expect(service.automaticState(service.repo.getChannel(channel.id)!).state).toBe('needs_real_test');
    advance(25_000); await service.tick();
    const done = service.repo.getPost(post.id)!;
    expect(done).toMatchObject({ status: 'published', confirmation: 'automatic' });
    expect(done.history.map(entry => entry.to)).toEqual(['draft', 'review', 'approved', 'sending', 'pending_confirmation', 'published']);
    expect(service.repo.getChannel(channel.id)!.realTestConfirmedAt).not.toBeNull();
    expect(service.automaticState(service.repo.getChannel(channel.id)!).state).toBe('available');
  });

  it('não liga o modo automático sem publicação real comprovada', async () => {
    const { service } = setup();
    const channel = await service.addChannel({ reference: LINK });
    await expect(service.updateChannel(channel.id, { settings: { ...channel.settings, mode: 'automatic' } })).rejects.toThrow('Publicação automática indisponível');
    expect((await service.updateChannel(channel.id, { settings: { ...channel.settings, mode: 'assisted' } })).settings.mode).toBe('assisted');
  });

  it('envio incerto vira confirmação pendente, nunca é reenviado e só a dona decide', async () => {
    const { service, transport, advance } = setup();
    const channel = await service.addChannel({ reference: LINK });
    const post = await approved(service, channel.id);
    transport.failure = new ChannelSendError('O WhatsApp não confirmou o envio.', true, 'transport');
    const result = await service.action(channel.id, post.id, { action: 'publish_now' });
    expect(result).toMatchObject({ status: 'pending_confirmation', uncertain: true });
    transport.failure = null; transport.verifyResult = 'not_found';
    for (let index = 0; index < 8; index++) { advance(30 * 60_000); await service.tick(); }
    expect(transport.sent).toHaveLength(0);
    expect(service.repo.getPost(post.id)!.lastError).toContain('registre');
    const confirmed = await service.action(channel.id, post.id, { action: 'confirm', outcome: 'not_sent', confirmed: true });
    expect(confirmed.status).toBe('failed');
    expect(transport.sent).toHaveLength(0);
  });

  it('falha de permissão pausa o canal e falhas seguidas abrem o disjuntor', async () => {
    const { service, transport } = setup();
    const channel = await service.addChannel({ reference: LINK });
    const first = await approved(service, channel.id);
    transport.failure = new ChannelSendError('Sem permissão de administrador.', false, 'permission');
    expect((await service.action(channel.id, first.id, { action: 'publish_now' })).status).toBe('failed');
    expect(service.repo.getChannel(channel.id)).toMatchObject({ settings: { paused: true } });
    expect(service.repo.getChannel(channel.id)!.pausedReason).toContain('Pausado automaticamente');
    await service.pauseChannel(channel.id, false);
    const second = setup();
    const other = await second.service.addChannel({ reference: LINK });
    await second.service.updateChannel(other.id, { settings: { ...other.settings, minIntervalMinutes: 5 } });
    second.transport.failure = new ChannelSendError('falha de rede', false, 'transport');
    for (let index = 0; index < 3; index++) {
      const post = await approved(second.service, other.id, { ...text, body: `Texto ${index}` });
      await second.service.action(other.id, post.id, { action: 'publish_now' });
    }
    expect(second.service.repo.getChannel(other.id)!.pausedReason).toContain('3 falhas');
  });

  it('respeita pausa geral, pausa do canal, duplicidade, intervalo e limite diário', async () => {
    const { service, advance } = setup();
    const channel = await service.addChannel({ reference: LINK });
    const post = await approved(service, channel.id);
    await service.setGlobalPause({ paused: true });
    await expect(service.action(channel.id, post.id, { action: 'publish_now' })).rejects.toThrow('Pausa geral');
    await service.setGlobalPause({ paused: false });
    await service.pauseChannel(channel.id, true);
    await expect(service.action(channel.id, post.id, { action: 'publish_now' })).rejects.toThrow('pausado');
    await service.pauseChannel(channel.id, false);
    await service.action(channel.id, post.id, { action: 'publish_now' });
    const again = await service.createPost(channel.id, text);
    await service.action(channel.id, again.id, { action: 'submit' });
    await expect(service.action(channel.id, again.id, { action: 'approve' })).rejects.toThrow('Conteúdo igual');
    const next = await approved(service, channel.id, { ...text, body: 'Outro assunto' });
    await expect(service.action(channel.id, next.id, { action: 'publish_now' })).rejects.toThrow('Intervalo mínimo');
    advance(61 * 60_000);
    await service.updateChannel(channel.id, { settings: { ...service.repo.getChannel(channel.id)!.settings, maxPerDay: 1 } });
    await expect(service.action(channel.id, next.id, { action: 'publish_now' })).rejects.toThrow('Limite diário');
  });

  it('agenda no fuso do canal, respeita a janela, cancela, reagenda e expira', async () => {
    const { service, transport, setClock } = setup();
    const channel = await service.addChannel({ reference: LINK });
    await service.updateChannel(channel.id, { settings: { ...channel.settings, mode: 'assisted' } });
    const post = await approved(service, channel.id);
    expect(post.status).toBe('scheduled');
    setClock('2026-11-04T02:00:00.000Z'); // 23:00 em São Paulo: fora da janela 08–22
    expect(insideWindow(new Date('2026-11-04T02:00:00.000Z'), { windowStart: '08:00', windowEnd: '22:00', timezone: 'America/Sao_Paulo' })).toBe(false);
    await service.tick();
    expect(transport.sent).toHaveLength(0);
    expect(service.repo.getPost(post.id)!.lastError).toContain('horário permitido');
    await service.action(channel.id, post.id, { action: 'unschedule' });
    await expect(service.action(channel.id, post.id, { action: 'schedule', scheduledAt: '2026-11-03T10:00:00.000Z' })).rejects.toThrow('futuro');
    await service.action(channel.id, post.id, { action: 'schedule', scheduledAt: '2026-11-04T12:00:00.000Z' });
    setClock('2026-11-04T12:30:00.000Z'); await service.tick();
    expect(transport.sent).toHaveLength(1);
    const cancelled = await approved(service, channel.id, { ...text, body: 'Vai ser cancelada' });
    expect((await service.action(channel.id, cancelled.id, { action: 'cancel' })).status).toBe('cancelled');
    const waiting = await service.createPost(channel.id, { ...text, body: 'Notícia com validade' });
    await service.action(channel.id, waiting.id, { action: 'submit' });
    const news = service.repo.savePost({ ...service.repo.getPost(waiting.id)!, expiresAt: '2026-11-04T13:00:00.000Z' } as ChannelPost);
    setClock('2026-11-04T14:00:00.000Z'); await service.tick();
    expect(service.repo.getPost(news.id)!.status).toBe('expired');
  });

  it('isola publicações entre canais e não mistura promoções com notícias', async () => {
    const { service } = setup();
    const first = await service.addChannel({ reference: LINK });
    const second = await service.addChannel({ reference: OTHER, purpose: 'promotions' });
    const post = await service.createPost(first.id, text);
    await expect(service.action(second.id, post.id, { action: 'submit' })).rejects.toBeInstanceOf(ChannelError);
    await expect(service.updatePost(second.id, post.id, text)).rejects.toThrow('não encontrada');
    expect(service.repo.listPosts({ channelId: second.id })).toHaveLength(0);
    const newsPost = service.repo.savePost({ ...post, origin: 'news' });
    await expect(service.duplicatePost(first.id, newsPost.id, { targetChannelId: second.id })).rejects.toThrow('promoções');
  });

  it('recupera um envio interrompido como confirmação pendente sem reenviar', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'promo-canais-'));
    try {
      const path = join(dir, 'data.sqlite');
      const database = new Database(path); database.saveSettings(settings());
      const transport = new FakeTransport();
      const service = new ChannelService({ database, transport, getSettings: () => database.getSettings(), now: () => new Date('2026-11-03T15:00:00.000Z') });
      const channel = await service.addChannel({ reference: LINK });
      const post = await approved(service, channel.id);
      service.repo.savePost({ ...service.repo.getPost(post.id)!, status: 'sending', sendingAt: '2026-11-03T15:00:00.000Z' });
      database.close();
      const reopened = new Database(path);
      const recovered = new ChannelService({ database: reopened, transport, getSettings: () => reopened.getSettings() });
      expect(recovered.repo.getPost(post.id)).toMatchObject({ status: 'pending_confirmation', uncertain: true });
      expect(transport.sent).toHaveLength(0);
      reopened.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('publica imagem enviada pelo painel com os bytes conferidos', async () => {
    const { service, transport } = setup();
    const channel = await service.addChannel({ reference: LINK });
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 1)]);
    await expect(service.uploadMedia({ kind: 'video', name: 'foto.jpg', base64: jpeg.toString('base64') })).rejects.toThrow('MP4');
    const media = await service.uploadMedia({ kind: 'image', name: 'foto.jpg', base64: jpeg.toString('base64') });
    const post = await approved(service, channel.id, { kind: 'image', title: '', body: 'Legenda', mediaId: media.id } as never);
    await service.action(channel.id, post.id, { action: 'publish_now' });
    expect(transport.sent[0]).toMatchObject({ jid: CHANNEL, content: { kind: 'image', text: 'Legenda', media: { mime: 'image/jpeg' } } });
    expect(transport.sent[0].content.media!.bytes.equals(jpeg)).toBe(true);
  });

  it('a reversão da migração 3 remove só os dados de canais', () => {
    const dir = mkdtempSync(join(tmpdir(), 'promo-down-'));
    try {
      const path = join(dir, 'data.sqlite');
      const database = new Database(path); database.saveSettings({ ...settings(), minScore: 91 }); database.close();
      const raw = new DatabaseSync(path);
      raw.exec(readFileSync(new URL('../packages/db/migrations/003-canais.down.sql', import.meta.url), 'utf8'));
      expect(raw.prepare('PRAGMA user_version').get()?.user_version).toBe(2);
      expect(raw.prepare("SELECT name FROM sqlite_master WHERE name='channels'").get()).toBeUndefined();
      raw.close();
      const reopened = new Database(path);
      expect(reopened.getSettings().minScore).toBe(91);
      expect(reopened.schemaVersion()).toBe(3);
      reopened.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('Canais pela API local (Express real, CSRF e banco SQLite)', () => {
  let app: ReturnType<typeof createApp>, server: Server, base = '', token = '', transport: FakeTransport;
  const whatsapp = (): WhatsAppTransport => {
    const status: WhatsAppStatus = { connected: true, connecting: false, qrDataUrl: null, user: 'teste', groups: [], lastError: null };
    return { getStatus: () => status, connect: async () => {}, reset: async () => {}, refreshGroups: async () => [], sendText: vi.fn(async () => 'GROUP-SEND'), stop: async () => {} };
  };
  beforeEach(async () => {
    transport = new FakeTransport();
    const database = new Database(':memory:'); database.saveSettings(settings());
    app = createApp({ database, whatsapp: whatsapp(), channelTransport: transport, schedule: false });
    server = await new Promise<Server>(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
    const address = server.address();
    base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
    token = (await (await fetch(`${base}/api/v1/session`)).json() as { csrfToken: string }).csrfToken;
  });
  afterEach(async () => { server.closeIdleConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await app.runtime.close(); });
  const call = async <T,>(path: string, method = 'GET', body?: unknown, csrf = token) => {
    const response = await fetch(`${base}/api/v1${path}`, { method, headers: { Origin: base, 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() as T };
  };

  it('cria, revisa e publica num Canal sem nunca usar o envio de grupos', async () => {
    expect((await call('/channels', 'POST', { reference: LINK }, 'x'.repeat(64))).status).toBe(403);
    const created = await call<{ id: string }>('/channels', 'POST', { reference: LINK });
    expect(created.status).toBe(200);
    const overview = await call<ChannelsOverview>('/channels');
    expect(overview.body).toMatchObject({ available: true, engine: { official: false, connected: true }, channels: [{ automaticPublishing: 'needs_real_test' }] });
    const post = await call<{ id: string }>(`/channels/${created.body.id}/posts`, 'POST', text);
    expect((await call(`/channels/${created.body.id}/posts/${post.body.id}/action`, 'POST', { action: 'submit' })).status).toBe(200);
    expect((await call(`/channels/${created.body.id}/posts/${post.body.id}/action`, 'POST', { action: 'approve' })).status).toBe(200);
    const sent = await call<{ status: string }>(`/channels/${created.body.id}/posts/${post.body.id}/action`, 'POST', { action: 'publish_now' });
    expect(sent.body.status).toBe('pending_confirmation');
    expect(transport.sent[0].jid).toBe(CHANNEL);
    expect((app.runtime.whatsapp.sendText as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    expect((await call(`/channels/outro-canal/posts/${post.body.id}`)).status).toBe(404);
    expect((await call(`/channels/${created.body.id}/posts`, 'POST', { ...text, status: 'published' })).status).toBe(400);
    expect((await call('/channels/ai')).body).toMatchObject({ available: false, keyConfigured: false });
    expect((await call('/channels/ai/key', 'POST', { key: 'sk-chave-local-da-dona-123456' })).body).toMatchObject({ keyConfigured: true });
    expect(JSON.stringify((await call('/channels/export')).body)).not.toContain('sk-chave-local');
  });
});
