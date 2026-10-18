import type { Feedback, Offer, ParsedOffer, ScoreFactor, Settings } from '../../shared/src/index.ts';

export interface ScoreContext {
  feedback?: Feedback[];
  history?: Offer[];
  productKey?: string;
  sourceId?: string;
  affiliateValid?: boolean;
  simulation?: boolean;
}

const bounded = (value: number, min: number, max: number): number => Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : min;

/** Deterministic evidence-based ranking; feedback is a small bounded adjustment, not a trained model. */
export function scoreOffer(parsed: ParsedOffer, settings: Settings, context: ScoreContext = {}): { score: number; factors: ScoreFactor[] } {
  const factors: ScoreFactor[] = [];
  const add = (label: string, points: number) => factors.push({ label, points: Math.round(points) });
  const affinity = bounded(settings.audience.weights[parsed.category] ?? 0, 0, 100);
  add(`Afinidade da categoria: ${affinity}/100`, affinity * 0.4);
  add(`Confiança da extração: ${Math.round(bounded(parsed.confidence, 0, 1) * 100)}%`, bounded(parsed.confidence, 0, 1) * 20);
  add(parsed.price !== null ? 'Preço atual explícito no texto' : 'Preço atual não identificado', parsed.price !== null ? 8 : 0);
  add(parsed.discount !== null ? `Desconto informado ou calculado: ${parsed.discount}%` : 'Desconto não confirmado', bounded(parsed.discount ?? 0, 0, 70) / 70 * 10);
  add(parsed.coupon ? 'Código de cupom identificado (validade não verificada)' : 'Sem código de cupom confirmado', parsed.coupon ? 3 : 0);
  add(parsed.freeShipping ? 'Frete grátis explícito no texto (não verificado na loja)' : 'Frete grátis não confirmado', parsed.freeShipping ? 3 : 0);
  add(context.affiliateValid === true ? 'Conversão afiliada validada' : context.affiliateValid === false ? 'Conversão afiliada não validada' : 'Validação afiliada ainda não realizada', context.affiliateValid === true ? 8 : context.affiliateValid === false ? -8 : 0);

  // Simulation and failed/rejected observations never become historical evidence.
  const history = (context.history ?? []).filter(offer => !offer.simulation && !['failed', 'rejected', 'blocked'].includes(offer.status));
  const sameProduct = context.productKey ? history.filter(offer => offer.productKey === context.productKey) : [];
  add(sameProduct.length ? 'Produto já observado no histórico próprio' : context.productKey ? 'Produto novo no histórico próprio' : 'Novidade sem identidade de produto confirmada', sameProduct.length ? -4 : context.productKey ? 4 : 0);
  const historicPrices = sameProduct.filter(offer => offer.price !== null && offer.price > 0 && offer.confidence >= 0.75).map(offer => offer.price as number);
  if (parsed.price !== null && historicPrices.length) {
    const lowest = Math.min(...historicPrices);
    const change = (lowest - parsed.price) / lowest * 100;
    if (change > 0) add(`Preço ${Math.round(change)}% abaixo do menor preço próprio observado`, bounded(change / 5, 0, 6));
    else if (change <= -5) add(`Preço ${Math.round(-change)}% acima do menor preço próprio observado`, -bounded(-change / 5, 0, 6));
    else add('Preço próximo ao menor preço próprio observado', 0);
  } else add('Sem histórico confiável para comparar preço', 0);

  const byId = new Map((context.history ?? []).map(offer => [offer.id, offer]));
  const latest = new Map<string, Feedback>();
  for (const feedback of context.feedback ?? []) {
    const observed = byId.get(feedback.offerId);
    if (!observed || observed.simulation || feedback.action === 'edit') continue;
    if (observed.category !== parsed.category && (!context.sourceId || observed.sourceId !== context.sourceId)) continue;
    const prior = latest.get(feedback.offerId);
    if (!prior || feedback.createdAt > prior.createdAt) latest.set(feedback.offerId, feedback);
  }
  const observations = [...latest.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 100);
  if (observations.length >= 3) {
    const balance = observations.reduce((sum, item) => sum + (item.action === 'approve' ? 1 : -1), 0);
    // Eight neutral pseudo-observations temper small samples; the total adjustment remains within ±5.
    add(`Feedback de curadoria: ${observations.length} avaliações; ajuste conservador`, bounded(balance / (observations.length + 8) * 5, -5, 5));
  } else add(`Feedback insuficiente: ${observations.length}/3 avaliações`, 0);

  const raw = factors.reduce((sum, factor) => sum + factor.points, 0);
  const score = bounded(raw, 0, 100);
  if (score !== raw) add('Limite do score entre 0 e 100', score - raw);
  return { score, factors };
}
