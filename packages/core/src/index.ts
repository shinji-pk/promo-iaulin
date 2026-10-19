import type { Feedback, IngestInput, Offer, Product, Settings, Stage } from '../../shared/src/index.ts';
import { buildAffiliateLink, identifyPlatform, identifyProduct, validateAffiliateLink, validateCalibration } from '../../affiliate-adapters/src/index.ts';
import { parseSecureUrl } from '../../affiliate-adapters/src/common.ts';
import { scoreOffer } from '../../scoring/src/index.ts';
import { extractUrls, parseLinkedOffers, parseOffer } from './parser.ts';

export { extractUrls, parseLinkedOffers, parseOffer } from './parser.ts';
export const MIN_PUBLICATION_CONFIDENCE = 0.75;
export const MAX_LINKS_PER_MESSAGE = 8;
export const MAX_PROCESSING_MS = 20_000;

type ProcessingContext = {history?:Offer[];feedback?:Feedback[];resolveUrl?:(url:string)=>Promise<string>};

function normalize(value: string): string { return value.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase(); }
function money(value: number): string { return new Intl.NumberFormat('pt-BR',{style:'currency',currency:'BRL'}).format(value); }

function persistedSourceUrl(value: string): string {
  try {
    const url = new URL(value);
    return value.length <= 4096 && ['http:','https:'].includes(url.protocol) && !url.username && !url.password ? value : '';
  } catch { return ''; }
}

function redactCredentialUrls(value: string): string {
  return value.replace(/https?:\/\/[^\s<>`]+/gi, raw => {
    if (/^https?:\/\/[^/?#\s]*@/i.test(raw)) return '[link com credenciais removido]';
    try { const url = new URL(raw); return url.username || url.password ? '[link com credenciais removido]' : raw; }
    catch { return raw; }
  });
}

async function resolveWithinBudget(url: string, context: ProcessingContext, deadline: number): Promise<string> {
  if (!parseSecureUrl(url)) throw new Error('Endereço HTTPS inválido, com credenciais ou porta não permitida.');
  const remaining = Math.ceil(deadline-performance.now());
  if (remaining <= 0) throw new Error('Orçamento de resolução da mensagem esgotado; oferta bloqueada para nova revisão.');
  if (!context.resolveUrl) {
    const {createUrlResolver} = await import('./resolver.ts');
    const budget = Math.ceil(deadline-performance.now());
    if (budget <= 0) throw new Error('Orçamento de resolução da mensagem esgotado; oferta bloqueada para nova revisão.');
    return createUrlResolver({timeoutMs:Math.min(8_000,budget)})(url);
  }
  let timer:ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      context.resolveUrl(url),
      new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(new Error('Orçamento de resolução da mensagem esgotado; oferta bloqueada para nova revisão.')),remaining);}),
    ]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

export function renderMessage(offer: Offer, settings: Settings): string {
  const title = offer.title || 'Uma seleção para conhecer';
  const lines: string[] = [];
  if (settings.message.style === 'warm') lines.push(`Um achado para você ♡`, title);
  else if (settings.message.style === 'compact') lines.push(title);
  else lines.push(`✦ ${title}`);
  if (offer.previousPrice !== null && offer.price !== null && offer.previousPrice > offer.price) lines.push(`De ${money(offer.previousPrice)}`);
  if (offer.price !== null) lines.push(`Por ${money(offer.price)}${offer.discount !== null ? ` (${offer.discount}% de desconto)` : ''}`);
  if (offer.coupon) lines.push(`Cupom: ${offer.coupon}`);
  if (offer.freeShipping) lines.push('Frete grátis informado na oferta');
  if (offer.affiliateUrl) lines.push('', `${settings.message.cta}:`, offer.affiliateUrl, 'Link de afiliado. Preço e condições podem mudar.');
  else lines.push('', 'Oferta em revisão: link de afiliado ainda não validado.');
  if (settings.message.signature) lines.push('', settings.message.signature);
  return lines.join('\n');
}

function validTimestamp(value: string | null): number | null {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

function activeHistory(offer: Offer, history: Offer[], now: Date, days: number): Offer[] {
  const cutoff = now.getTime() - days * 86_400_000;
  return history.filter(item=>item.id !== offer.id && item.simulation === offer.simulation &&
    !['rejected','blocked','duplicate','failed'].includes(item.status) &&
    (validTimestamp(item.publishedAt) ?? validTimestamp(item.createdAt) ?? 0) >= cutoff);
}

/** A price-drop exception needs a known lower price than every recent observation. */
function duplicateReason(offer: Offer, settings: Settings, history: Offer[], now: Date): string | null {
  // A send can have succeeded even when its acknowledgement or persistence failed.
  // Keep that reservation across restarts and beyond the normal dedupe window.
  if (offer.productKey && history.some(item=>item.id !== offer.id && item.simulation === offer.simulation &&
    item.productKey === offer.productKey && ['publishing','uncertain'].includes(item.status))) {
    return 'Este produto tem um envio em andamento ou de resultado incerto.';
  }
  const recent = activeHistory(offer,history,now,settings.dedupeDays);
  // One WhatsApp message may contain several distinct products. Replay detection
  // applies to the same entry, rather than suppressing every link after the first.
  if (offer.sourceMessageId && recent.some(item=>item.sourceMessageId === offer.sourceMessageId && item.sourceId === offer.sourceId &&
    (offer.productKey ? item.productKey === offer.productKey : Boolean(offer.originalUrl && item.originalUrl === offer.originalUrl)))) return 'Este produto desta mensagem de origem já foi processado.';
  const matching = recent.filter(item=>item.productKey === offer.productKey && offer.productKey !== '');
  if (!matching.length) return null;
  if (matching.some(item=>['publishing','uncertain'].includes(item.status))) return 'Este produto tem um envio em andamento ou de resultado incerto.';
  const prices = matching.map(item=>item.price).filter((price):price is number=>price !== null && price > 0);
  const drop = settings.allowPriceDrop && offer.price !== null && prices.length === matching.length &&
    offer.price <= Math.min(...prices) * (1-settings.priceDropPercent/100);
  return drop ? null : `Produto repetido dentro da janela de ${settings.dedupeDays} dias.`;
}

function localMinutes(now: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat('en-GB',{timeZone:timezone,hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(now);
  return Number(parts.find(item=>item.type === 'hour')?.value) * 60 + Number(parts.find(item=>item.type === 'minute')?.value);
}

function inQuietHours(now: Date, settings: Settings): boolean {
  const parse = (input:string) => Number(input.slice(0,2))*60+Number(input.slice(3));
  const start = parse(settings.quietStart), end = parse(settings.quietEnd), current = localMinutes(now,settings.timezone);
  return start !== end && (start < end ? current >= start && current < end : current >= start || current < end);
}

function blockedContent(offer: Offer, settings: Settings): string[] {
  const reasons: string[] = [];
  if (offer.platform && settings.audience.blockedPlatforms.includes(offer.platform)) reasons.push('Loja bloqueada no perfil de audiência.');
  const text = normalize(`${offer.title}\n${offer.originalText}\n${offer.rewrittenText}`);
  for (const word of settings.audience.blockedWords) {
    if (word.trim() && text.includes(normalize(word.trim()))) reasons.push(`Palavra bloqueada encontrada: ${word}.`);
  }
  if ((settings.audience.weights[offer.category] ?? 0) <= 0) reasons.push('Categoria desativada no perfil de audiência.');
  return reasons;
}

function messageLinkReasons(offer: Offer, product: Product, settings: Settings): string[] {
  const reasons: string[] = [];
  const urls = extractUrls(offer.rewrittenText);
  if (!urls.length) return ['A mensagem final não contém um link afiliado validado.'];
  for (const url of urls) {
    if (!validateAffiliateLink(url, product, settings.affiliates[product.platform]).valid) reasons.push('A mensagem final contém um endereço que não valida a afiliação do mesmo produto.');
  }
  // A user edit or a template must not sneak in a different protocol or a bare clickable domain.
  const withoutUrls = urls.reduce((text,url)=>text.split(url).join(''),offer.rewrittenText);
  if (/\b[a-z][a-z0-9+.-]*:\/\//i.test(withoutUrls) || /(?:[\p{L}\p{N}-]+\.)+[\p{L}]{2,}(?::\d+)?(?:[/?#][^\s]*)?/iu.test(withoutUrls)
    || /\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?(?:[/?#][^\s]*)?/.test(withoutUrls)) {
    reasons.push('A mensagem final contém outro endereço; mantenha somente o link afiliado HTTPS validado.');
  }
  return reasons;
}

export function evaluatePublication(offer: Offer, settings: Settings, history: Offer[], now = new Date(), options: {automatic?:boolean} = {}): {allowed:boolean;reasons:string[]} {
  const reasons: string[] = [];
  if (offer.simulation) reasons.push('Simulações nunca são enviadas ao WhatsApp.');
  if (!['review','approved'].includes(offer.status)) reasons.push(`O estado ${offer.status} não permite publicação.`);
  if (settings.paused) reasons.push('Automação pausada.');
  if (options.automatic && settings.mode === 'manual') reasons.push('Modo manual: aguarda ação explícita de publicação.');
  if (!settings.destinationGroup) reasons.push('Selecione o grupo de destino.');
  if (offer.sourceId === settings.destinationGroup && settings.destinationGroup) reasons.push('Mensagens do destino não podem voltar para o pipeline.');
  if (!offer.simulation && !settings.sourceGroups.includes(offer.sourceId)) reasons.push('Grupo de origem não autorizado.');
  if (offer.confidence < MIN_PUBLICATION_CONFIDENCE || !Number.isFinite(offer.confidence)) reasons.push('Confiança de extração insuficiente para publicar.');
  if (offer.score < settings.minScore || !Number.isFinite(offer.score)) reasons.push(`Score abaixo do mínimo de ${settings.minScore}.`);
  reasons.push(...blockedContent(offer, settings));
  const product = identifyProduct(offer.canonicalUrl);
  if (!product || !offer.platform || product.platform !== offer.platform || product.productKey !== offer.productKey || product.productId !== offer.productId) {
    reasons.push('Identidade canônica do produto inválida ou alterada.');
  } else {
    const config = settings.affiliates[product.platform];
    const calibration = validateCalibration(product.platform, config);
    if (!calibration.valid) reasons.push(calibration.reason);
    if (!offer.affiliateUrl || !validateAffiliateLink(offer.affiliateUrl, product, config).valid) reasons.push('Link afiliado não valida com a configuração atual.');
    if (!offer.affiliateValid) reasons.push('Afiliação não passou pela validação do pipeline.');
    reasons.push(...messageLinkReasons(offer, product, settings));
  }
  const duplicate = duplicateReason(offer,settings,history,now);
  if (duplicate) reasons.push(duplicate);
  if (inQuietHours(now, settings)) reasons.push('Horário de silêncio ativo.');
  const published = history.filter(item=>item.id !== offer.id && !item.simulation && ['published','publishing','uncertain'].includes(item.status));
  const sentTimes = published.map(item=>validTimestamp(item.publishedAt) ?? validTimestamp(item.updatedAt)).filter((value):value is number=>value !== null);
  const hourStart = now.getTime()-3_600_000;
  if (sentTimes.filter(time=>time >= hourStart).length >= settings.maxPostsPerHour) reasons.push('Limite de publicações por hora atingido.');
  if (sentTimes.some(time=>now.getTime()-time < settings.minIntervalMinutes*60_000)) reasons.push('Intervalo mínimo entre publicações ainda não cumprido.');
  return {allowed:reasons.length === 0,reasons:[...new Set(reasons)]};
}

export async function processPromotion(input: IngestInput, settings: Settings, context: ProcessingContext = {}): Promise<Offer[]> {
  const now = new Date(), history = context.history ?? [];
  const deadline = performance.now()+MAX_PROCESSING_MS;
  const sourceText = String(input.text).slice(0,32_000);
  const linked = parseLinkedOffers(sourceText);
  const overflow = Math.max(0,linked.length-MAX_LINKS_PER_MESSAGE);
  const entries = linked.length ? linked.slice(0,MAX_LINKS_PER_MESSAGE) : [{url:'',text:sourceText}];
  if (overflow) entries.push({url:linked[MAX_LINKS_PER_MESSAGE].url,text:''});
  const offers: Offer[] = [];
  for (const entry of entries) {
    const createdAt = now.toISOString();
    const parsed = parseOffer(redactCredentialUrls(entry.text));
    const offer: Offer = {
      id:globalThis.crypto.randomUUID(),createdAt,updatedAt:createdAt,sourceId:input.sourceId,sourceName:input.sourceName,sourceMessageId:input.messageId,
      simulation:input.simulation,originalText:redactCredentialUrls(sourceText),originalUrl:persistedSourceUrl(entry.url),canonicalUrl:'',affiliateUrl:null,productKey:'',platform:null,productId:null,
      ...parsed,score:0,factors:[],affiliateValid:false,reasons:[],stages:[],rewrittenText:'',status:'review',publishedAt:null,imageUrl:input.imageUrl ? persistedSourceUrl(input.imageUrl) || null : null
    };
    const stage = (name:string,status:Stage['status'],detail:string) => offer.stages.push({name,status,detail});
    stage('Extração',entry.url ? 'ok' : 'blocked',entry.url ? 'Link separado do texto de origem.' : 'Nenhum link encontrado na mensagem.');
    try {
      if (overflow && offers.length === MAX_LINKS_PER_MESSAGE) {
        offer.title = `${overflow} links adicionais retidos`;
        throw new Error(`Limite de ${MAX_LINKS_PER_MESSAGE} links por mensagem. Os ${overflow} links adicionais foram retidos sem resolução ou publicação; separe-os em mensagens menores.`);
      }
      if (!entry.url) throw new Error('Nenhum link HTTPS encontrado.');
      const resolved = await resolveWithinBudget(entry.url,context,deadline);
      stage('Resolução','ok','Endereço final resolvido e validado.');
      offer.platform = identifyPlatform(resolved);
      const product = identifyProduct(resolved);
      if (!product) throw new Error(offer.platform ? 'A loja foi reconhecida, mas a identidade do produto não é segura.' : 'Marketplace não reconhecido ou endereço não permitido.');
      offer.platform = product.platform;
      offer.productKey = product.productKey;
      offer.productId = product.productId;
      offer.canonicalUrl = product.canonicalUrl;
      stage('Identificação','ok',`Produto ${product.productId} identificado em ${product.platform}.`);
      const config = settings.affiliates[product.platform];
      offer.affiliateUrl = buildAffiliateLink(product, config);
      const validation = offer.affiliateUrl ? validateAffiliateLink(offer.affiliateUrl,product,config) : validateCalibration(product.platform,config);
      offer.affiliateValid = Boolean(offer.affiliateUrl && validation.valid);
      stage('Afiliação',offer.affiliateValid ? 'ok' : 'blocked',validation.reason);
      if (!offer.affiliateValid) offer.reasons.push(validation.reason);
    } catch (error) {
      const message = redactCredentialUrls(error instanceof Error ? error.message : 'Falha ao processar o link.').slice(0,2000);
      stage('Resolução e identidade','blocked',message);
      offer.reasons.push(message);
    }
    const scored = scoreOffer(parsed,settings,{history:[...history,...offers],feedback:context.feedback,productKey:offer.productKey,sourceId:input.sourceId,affiliateValid:offer.affiliateValid,simulation:input.simulation});
    offer.score = scored.score;
    offer.factors = scored.factors;
    stage('Parsing',parsed.confidence >= MIN_PUBLICATION_CONFIDENCE ? 'ok' : 'pending',`Extração determinística; confiança ${Math.round(parsed.confidence*100)}%. Valores não confirmados ficam vazios.`);
    stage('Score','ok',`${offer.score}/100 com fatores explicáveis.`);
    offer.rewrittenText = renderMessage(offer,settings);
    const banned = blockedContent(offer,settings);
    offer.reasons.push(...banned);
    const duplicate = duplicateReason(offer,settings,[...history,...offers],now);
    if (duplicate) {
      offer.status = 'duplicate';
      offer.reasons.push(duplicate);
      stage('Deduplicação','blocked',duplicate);
    } else {
      stage('Deduplicação','ok','Sem repetição impeditiva na janela configurada.');
      if (!offer.affiliateValid || !offer.productKey || banned.length) offer.status = 'blocked';
      else if (input.simulation) offer.status = 'simulated';
      else {
        const gate = evaluatePublication(offer,settings,[...history,...offers],now,{automatic:true});
        offer.status = gate.allowed ? 'approved' : 'review';
        offer.reasons.push(...gate.reasons);
      }
    }
    stage('Reescrita','ok','Mensagem gerada somente com os campos extraídos; confira o preview.');
    stage('Publicação',offer.status === 'approved' ? 'ok' : offer.status === 'blocked' || offer.status === 'duplicate' ? 'blocked' : 'pending',
      input.simulation ? 'Simulação isolada: nenhum envio será realizado.' : offer.status === 'approved' ? 'Elegível; gates serão verificadas novamente antes do envio.' : 'Retido para revisão ou configuração.');
    offer.reasons = [...new Set(offer.reasons)];
    offers.push(offer);
  }
  return offers;
}
