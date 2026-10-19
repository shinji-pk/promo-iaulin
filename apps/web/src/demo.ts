import { z } from 'zod';
import { defaultSettings, settingsSchema, categoryIds, platformIds, platformNames, type AppSnapshot, type Offer, type PlatformId } from '../../../packages/shared/src/index.ts';
import type { ApprovedLink, SetupStatus } from '../../../packages/shared/src/features.ts';
import { getIntegrationGuides } from '../../../packages/shared/src/integration-guides.ts';
import { identifyPlatform, identifyProduct } from '../../../packages/affiliate-adapters/src/index.ts';

const storageKey = 'promobridge-demonstration-v2';
const libraryStorageKey = 'promobridge-demo-links-v1';
const demoOfferSchema = z.object({
  id: z.string().min(1).max(200), createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
  sourceId: z.string().max(100), sourceName: z.string().max(100), sourceMessageId: z.string().max(200),
  simulation: z.literal(true), originalText: z.string().max(16000), originalUrl: z.string().max(4096), canonicalUrl: z.string().max(4096), affiliateUrl: z.string().max(4096).nullable(),
  productKey: z.string().max(4096), platform: z.enum(platformIds).nullable(), productId: z.string().max(100).nullable(),
  title: z.string().max(2000), price: z.number().nonnegative().nullable(), previousPrice: z.number().nonnegative().nullable(), discount: z.number().nullable(), coupon: z.string().max(1000).nullable(), freeShipping: z.boolean(),
  category: z.enum(categoryIds), score: z.number().min(0).max(100), confidence: z.number().min(0).max(1),
  factors: z.array(z.object({ label: z.string().max(2000), points: z.number() })).max(100),
  affiliateValid: z.boolean(), reasons: z.array(z.string().max(2000)).max(100),
  stages: z.array(z.object({ name: z.string().max(2000), status: z.enum(['ok', 'blocked', 'pending']), detail: z.string().max(4000) })).max(100),
  rewrittenText: z.string().max(16000), status: z.enum(['review', 'approved', 'rejected', 'duplicate', 'blocked', 'publishing', 'published', 'simulated', 'failed', 'uncertain']), publishedAt: z.string().nullable(), imageUrl: z.string().max(4096).nullable().optional(),
  expiresAt: z.iso.datetime().nullable().optional(), requiresManualApproval: z.boolean().optional(),
});
const librarySchema = z.array(z.object({ id: z.string().min(1).max(100), platform: z.enum(platformIds), productKey: z.string().min(1).max(500), originalUrl: z.url().max(2048), affiliateUrl: z.url().max(2048), title: z.string().max(200), ownerConfirmed: z.literal(true), createdAt: z.iso.datetime(), updatedAt: z.iso.datetime() })).max(1000);
const demoBackupSchema = z.object({ format: z.literal('promobridge-demo'), version: z.literal(1), settings: settingsSchema, offers: z.array(demoOfferSchema).max(1000) });
const activitySchema = z.array(z.object({ id: z.string(), createdAt: z.iso.datetime(), level: z.enum(['info', 'warning', 'error']), event: z.string(), message: z.string() })).max(100);
function emptySnapshot(): AppSnapshot {
  return { settings: defaultSettings(), offers: [], integrations: platformIds.map(id => ({ id, name: platformNames[id], state: 'not_configured', reason: 'Configure e valide no aplicativo local.' })), whatsapp: { connected: false, connecting: false, qrDataUrl: null, user: null, groups: [], lastError: null }, activity: [], feedbackCount: 0, stats: { seen: 0, published: 0, review: 0, blocked: 0, simulated: 0 }, health: { uptime: 0, databaseBytes: 0, version: '2.0.0 · demonstração' } };
}
function isolatedOffers(offers: Offer[]): Offer[] { return offers.map(offer => ({ ...offer, simulation: true, publishedAt: null, status: ['published', 'publishing', 'uncertain'].includes(offer.status) ? 'review' : offer.status })); }
let snapshot = emptySnapshot();
let library: ApprovedLink[] = [];
try {
  const saved = localStorage.getItem(storageKey);
  if (saved) {
    const parsed: unknown = JSON.parse(saved);
    const state = z.object({ settings: settingsSchema, offers: z.array(demoOfferSchema).max(1000), activity: activitySchema, feedbackCount: z.number().int().nonnegative() }).parse(parsed);
    snapshot = { ...emptySnapshot(), ...state, offers: isolatedOffers(state.offers) };
  }
} catch { snapshot = emptySnapshot(); }
try { const saved = localStorage.getItem(libraryStorageKey); if (saved) library = librarySchema.parse(JSON.parse(saved)); } catch { library = []; }
function persistLibrary() { try { localStorage.setItem(libraryStorageKey, JSON.stringify(library)); } catch { /* Remains available for this isolated session. */ } }
function persist() {
  snapshot.offers = snapshot.offers.slice(0, 1000);
  snapshot.stats = { seen: 0, published: 0, review: 0, blocked: 0, simulated: snapshot.offers.length };
  try { localStorage.setItem(storageKey, JSON.stringify(snapshot)); } catch { /* An unavailable browser store does not prevent this isolated session. */ }
}
function event(message: string) {
  snapshot.activity.unshift({ id: crypto.randomUUID(), createdAt: new Date().toISOString(), level: 'info', event: 'simulation', message });
  snapshot.activity = snapshot.activity.slice(0, 100);
}
export async function demoRequest(path: string, method: string, body?: any): Promise<unknown> {
  if (path === '/state') return structuredClone(snapshot);
  if (path === '/setup') return {
    ready: false,
    next: 'Você está na demonstração. Abra o aplicativo local para conectar contas e publicar pelo WhatsApp.',
    checks: [
      { key: 'local', label: 'Aplicativo no computador', ready: false, detail: 'A demonstração não executa o worker nem acessa seu computador.', page: 'sources' },
      { key: 'whatsapp', label: 'WhatsApp conectado', ready: false, detail: 'A conexão por QR Code acontece no aplicativo local.', page: 'sources' },
      { key: 'groups', label: 'Fontes e destino escolhidos', ready: false, detail: 'Grupos reais aparecem depois da conexão local.', page: 'sources' },
      { key: 'affiliate', label: 'Afiliação conferida', ready: false, detail: 'Links salvos na demonstração não comprovam uma afiliação real.', page: 'affiliates' },
      { key: 'rules', label: 'Seu ritmo e filtros', ready: true, detail: 'Você pode experimentar e salvar preferências neste navegador.', page: 'automation' },
    ],
  } satisfies SetupStatus;
  if (path === '/affiliates/guides' && method === 'GET') return getIntegrationGuides();
  if (path === '/affiliates/credentials' && method === 'GET') return platformIds.map(platform => ({ platform, configured: false, revision: '', updatedAt: null, fields: [] }));
  if (/^\/affiliates\/[^/]+\/(credentials|test)$/.test(path)) throw new Error('Credenciais e testes de conexão só estão disponíveis no aplicativo local. Esta demonstração não recebe segredos.');
  if (path === '/affiliate-links/export' && method === 'GET') return { format: 'promobridge-demo-links', version: 1, exportedAt: new Date().toISOString(), links: structuredClone(library) };
  if (path.split('?')[0] === '/affiliate-links' && method === 'GET') {
    const platform = new URLSearchParams(path.split('?')[1] || '').get('platform');
    return structuredClone(library.filter(link => !platform || link.platform === platform));
  }
  if (path === '/affiliate-links' && method === 'POST') {
    const input = z.object({ platform: z.enum(platformIds), originalUrl: z.url().max(2048), affiliateUrl: z.url().max(2048), title: z.string().max(200).optional(), ownerConfirmed: z.literal(true) }).parse(body);
    const original = new URL(input.originalUrl), affiliate = new URL(input.affiliateUrl);
    if ([original, affiliate].some(url => url.protocol !== 'https:' || url.username || url.password || url.port && url.port !== '443')) throw new Error('Use links HTTPS seguros, sem credenciais ou portas alternativas.');
    const product = identifyProduct(input.originalUrl);
    if (!product || product.platform !== input.platform) throw new Error('Na demonstração, use o link direto original de um produto da loja escolhida. Links curtos não são abertos.');
    if (identifyPlatform(input.affiliateUrl) !== input.platform) throw new Error('O link afiliado precisa usar um domínio reconhecido da loja escolhida.');
    const linked = identifyProduct(input.affiliateUrl);
    if (linked && linked.productKey !== product.productKey) throw new Error('Os links identificam produtos diferentes. Gere o link afiliado para o mesmo produto.');
    const now = new Date().toISOString();
    const existing = library.find(link => link.platform === input.platform && link.productKey === product.productKey);
    const link: ApprovedLink = { id: existing?.id || crypto.randomUUID(), platform: input.platform, productKey: product.productKey, originalUrl: input.originalUrl, affiliateUrl: input.affiliateUrl, title: input.title || '', ownerConfirmed: true, createdAt: existing?.createdAt || now, updatedAt: now };
    library = [link, ...library.filter(item => item.id !== link.id)].slice(0, 1000); persistLibrary();
    event('Par de links salvo apenas na biblioteca de demonstração. Nenhuma afiliação real foi validada.'); persist();
    return structuredClone(link);
  }
  if (path.startsWith('/affiliate-links/') && method === 'DELETE') { library = library.filter(link => link.id !== path.split('/')[2]); persistLibrary(); return { ok: true }; }
  if (path.startsWith('/remote')) throw new Error('O acesso pelo celular é configurado no aplicativo local. A demonstração não cria conexões remotas.');
  if (path === '/settings' && method === 'PUT') {
    snapshot.settings = settingsSchema.parse(body);
    // A browser demonstration never stores a production verification claim.
    for (const id of platformIds) snapshot.settings.affiliates[id].verifiedAt = null;
    event('Preferências salvas neste navegador de demonstração.');
    persist();
    return structuredClone(snapshot.settings);
  }
  if (path === '/simulate' || path === '/ingest') {
    const { processPromotion } = await import('../../../packages/core/src/index.ts');
    const text = z.string().trim().min(1).max(16000).parse(body?.text);
    const offers = await processPromotion({ text, sourceId: path === '/ingest' ? 'manual-demo' : 'simulator', sourceName: path === '/ingest' ? 'Entrada manual · demonstração' : 'Simulador', messageId: crypto.randomUUID(), simulation: true }, snapshot.settings, { history: snapshot.offers, resolveUrl: async (url: string) => url });
    offers.forEach(offer => { offer.simulation = true; if (path === '/ingest') offer.requiresManualApproval = true; });
    snapshot.offers.unshift(...offers);
    event(`${offers.length} oferta(s) processada(s) em simulação. Nenhuma mensagem enviada.`);
    persist();
    return structuredClone(offers);
  }
  if (path.startsWith('/offers/')) {
    const id = path.split('/')[2];
    const offer = snapshot.offers.find(item => item.id === id);
    if (!offer) throw new Error('Oferta não encontrada.');
    const operation = path.split('/')[3];
    if (operation === 'schedule' || operation === 'reconcile') throw new Error('Envios, agendamentos e conferências reais só acontecem no aplicativo local.');
    if (operation === 'reprocess') {
      const { processPromotion } = await import('../../../packages/core/src/index.ts');
      const refreshed = await processPromotion({ text: offer.originalText, sourceId: offer.sourceId, sourceName: offer.sourceName, messageId: offer.sourceMessageId, simulation: true }, snapshot.settings, { history: snapshot.offers.filter(item => item.id !== offer.id), resolveUrl: async url => url });
      const replacement = refreshed.find(item => item.productKey === offer.productKey || item.originalUrl === offer.originalUrl);
      if (!replacement) throw new Error('Não foi possível identificar novamente este produto. Confira a mensagem original.');
      Object.assign(offer, replacement, { id: offer.id, createdAt: offer.createdAt, simulation: true, requiresManualApproval: offer.requiresManualApproval, expiresAt: offer.expiresAt, publishedAt: null });
      event('Oferta reprocessada apenas em demonstração.'); persist(); return structuredClone(offer);
    }
    if (operation === 'details') {
      const details = z.object({ title: z.string().trim().min(1).max(500).optional(), price: z.number().positive().nullable().optional(), previousPrice: z.number().positive().nullable().optional(), coupon: z.string().max(100).nullable().optional(), category: z.enum(categoryIds).optional(), expiresAt: z.iso.datetime().nullable().optional() }).parse(body);
      Object.assign(offer, details, { status: 'simulated', simulation: true, updatedAt: new Date().toISOString() });
      offer.discount = offer.price !== null && offer.previousPrice !== null && offer.previousPrice > offer.price ? Math.round((1 - offer.price / offer.previousPrice) * 100) : null;
      const [{ renderMessage }, { scoreOffer }] = await Promise.all([import('../../../packages/core/src/index.ts'), import('../../../packages/scoring/src/index.ts')]);
      const score = scoreOffer(offer, snapshot.settings, { affiliateValid: offer.affiliateValid, productKey: offer.productKey, simulation: true });
      offer.score = score.score; offer.factors = score.factors; offer.rewrittenText = renderMessage(offer, snapshot.settings);
      snapshot.feedbackCount++; event('Dados corrigidos apenas na demonstração.'); persist(); return structuredClone(offer);
    }
    if (operation !== 'action') throw new Error('Esta ação não está disponível na demonstração.');
    if (body.action === 'publish') throw new Error('Ofertas de simulação nunca são enviadas ao WhatsApp.');
    if (body.action === 'edit') offer.rewrittenText = z.string().min(1).max(16000).parse(body.text);
    if (body.action === 'approve') offer.status = 'approved';
    if (body.action === 'reject') offer.status = 'rejected';
    offer.updatedAt = new Date().toISOString();
    snapshot.feedbackCount++;
    event('Decisão salva apenas na demonstração.');
    persist();
    return structuredClone(offer);
  }
  if (path === '/backup') return { format: 'promobridge-demo', version: 1, exportedAt: new Date().toISOString(), settings: snapshot.settings, offers: snapshot.offers, activity: snapshot.activity };
  if (path === '/restore') {
    const validated = demoBackupSchema.safeParse(body?.backup);
    if (!validated.success) throw new Error('Use um backup válido desta demonstração. Os backups locais devem ser restaurados no aplicativo local.');
    snapshot.settings = validated.data.settings;
    for (const id of platformIds) snapshot.settings.affiliates[id].verifiedAt = null;
    snapshot.offers = isolatedOffers(validated.data.offers);
    event('Backup de demonstração restaurado neste navegador.');
    persist();
    return { ok: true };
  }
  if (path === '/cleanup') {
    snapshot.offers = [];
    snapshot.activity = [];
    persist();
    return { ok: true };
  }
  if (path === '/whatsapp/groups') return [];
  if (path.startsWith('/whatsapp/')) throw new Error('A conexão com o WhatsApp é feita no aplicativo local do seu computador. Esta é uma demonstração isolada.');
  if (/^\/affiliates\/[^/]+\/calibrate$/.test(path)) {
    const platform = z.enum(platformIds).parse(path.split('/')[2]) as PlatformId;
    snapshot.settings.affiliates[platform] = { ...snapshot.settings.affiliates[platform], ...body, verifiedAt: null };
    persist();
    return { valid: false, reason: 'Dados salvos na demonstração. Para validar a afiliação, abra o aplicativo local.' };
  }
  throw new Error('Esta ação precisa do aplicativo local.');
}
