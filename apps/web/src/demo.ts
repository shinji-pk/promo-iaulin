import { z } from 'zod';
import { defaultSettings, settingsSchema, categoryIds, platformIds, platformNames, type AppSnapshot, type Offer, type PlatformId } from '../../../packages/shared/src/index.ts';

const storageKey = 'promobridge-demonstration-v2';
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
});
const demoBackupSchema = z.object({ format: z.literal('promobridge-demo'), version: z.literal(1), settings: settingsSchema, offers: z.array(demoOfferSchema).max(1000) });
const activitySchema = z.array(z.object({ id: z.string(), createdAt: z.iso.datetime(), level: z.enum(['info', 'warning', 'error']), event: z.string(), message: z.string() })).max(100);
function emptySnapshot(): AppSnapshot {
  return { settings: defaultSettings(), offers: [], integrations: platformIds.map(id => ({ id, name: platformNames[id], state: 'not_configured', reason: 'Configure e valide no aplicativo local.' })), whatsapp: { connected: false, connecting: false, qrDataUrl: null, user: null, groups: [], lastError: null }, activity: [], feedbackCount: 0, stats: { seen: 0, published: 0, review: 0, blocked: 0, simulated: 0 }, health: { uptime: 0, databaseBytes: 0, version: '2.0.0 · demonstração' } };
}
function isolatedOffers(offers: Offer[]): Offer[] { return offers.map(offer => ({ ...offer, simulation: true, publishedAt: null, status: ['published', 'publishing', 'uncertain'].includes(offer.status) ? 'review' : offer.status })); }
let snapshot = emptySnapshot();
try {
  const saved = localStorage.getItem(storageKey);
  if (saved) {
    const parsed: unknown = JSON.parse(saved);
    const state = z.object({ settings: settingsSchema, offers: z.array(demoOfferSchema).max(1000), activity: activitySchema, feedbackCount: z.number().int().nonnegative() }).parse(parsed);
    snapshot = { ...emptySnapshot(), ...state, offers: isolatedOffers(state.offers) };
  }
} catch { snapshot = emptySnapshot(); }
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
  if (path === '/settings' && method === 'PUT') {
    snapshot.settings = settingsSchema.parse(body);
    // A browser demonstration never stores a production verification claim.
    for (const id of platformIds) snapshot.settings.affiliates[id].verifiedAt = null;
    event('Preferências salvas neste navegador de demonstração.');
    persist();
    return structuredClone(snapshot.settings);
  }
  if (path === '/simulate') {
    const { processPromotion } = await import('../../../packages/core/src/index.ts');
    const text = z.string().min(1).max(16000).parse(body.text);
    const offers = await processPromotion({ text, sourceId: 'simulator', sourceName: 'Simulador', messageId: crypto.randomUUID(), simulation: true }, snapshot.settings, { history: snapshot.offers, resolveUrl: async (url: string) => url });
    offers.forEach(offer => { offer.simulation = true; });
    snapshot.offers.unshift(...offers);
    event(`${offers.length} oferta(s) processada(s) em simulação. Nenhuma mensagem enviada.`);
    persist();
    return structuredClone(offers);
  }
  if (path.startsWith('/offers/')) {
    const id = path.split('/')[2];
    const offer = snapshot.offers.find(item => item.id === id);
    if (!offer) throw new Error('Oferta não encontrada.');
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
  if (path.startsWith('/affiliates/')) {
    const platform = z.enum(platformIds).parse(path.split('/')[2]) as PlatformId;
    snapshot.settings.affiliates[platform] = { ...snapshot.settings.affiliates[platform], ...body, verifiedAt: null };
    persist();
    return { valid: false, reason: 'Dados salvos na demonstração. Para validar a afiliação, abra o aplicativo local.' };
  }
  throw new Error('Esta ação precisa do aplicativo local.');
}
