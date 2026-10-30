import type { CategoryId, ParsedOffer } from '../../shared/src/index.ts';

const fallbackTitle = 'Produto não identificado';
const moneyPattern = /(?:R\$\s*|\bBRL\s*)(\d+(?:[.,]\d+)*)/gi;
const urlPattern = /https?:\/\/[^\s<>"'`\][{}]+/gi;

interface UrlMatch { url: string; start: number; end: number; }
interface PriceMatch { value: number; previous: boolean; current: boolean; }

const normalize = (value: string): string => value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
const clamp = (value: number, low: number, high: number): number => Math.max(low, Math.min(high, value));

function urlsWithPositions(text: string): UrlMatch[] {
  return [...text.matchAll(new RegExp(urlPattern))].flatMap(match => {
    // Closing punctuation often belongs to prose/Markdown, not to the URL.
    let url = match[0].replace(/[.,!?;:]+$/, '');
    while (url.endsWith(')') && (url.match(/\(/g)?.length ?? 0) < (url.match(/\)/g)?.length ?? 0)) url = url.slice(0, -1);
    try {
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname) return [];
    } catch { return []; }
    return [{ url, start: match.index, end: match.index + url.length }];
  });
}

export function extractUrls(text: string): string[] {
  return [...new Set(urlsWithPositions(String(text)).map(match => match.url))];
}

function parseAmount(raw: string): number | null {
  if (!/^\d+(?:\.\d{3})*(?:,\d{1,2})?$/.test(raw) && !/^\d+\.\d{1,2}$/.test(raw)) return null;
  const value = raw.includes(',') ? raw.replace(/\./g, '').replace(',', '.') : /^\d+\.\d{3}(?:\.\d{3})*$/.test(raw) ? raw.replace(/\./g, '') : raw;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 && number <= 100_000_000 ? number : null;
}

function extractPrices(text: string): { price: number | null; previousPrice: number | null; ambiguous: boolean } {
  const matches: PriceMatch[] = [];
  const plain = text.replace(/[*_]/g, '');
  if (/(?:R\$|\bBRL)\s*\d+(?:[.,]\d+)*\s*(?:a|at[eé]|-|–|—)\s*(?:R\$|\bBRL)\s*\d/i.test(plain)) {
    return {price:null,previousPrice:null,ambiguous:true};
  }
  for (const match of plain.matchAll(new RegExp(moneyPattern))) {
    const value = parseAmount(match[1]);
    if (value === null) continue;
    const before = normalize(plain.slice(Math.max(0, match.index - 70), match.index));
    const after = normalize(plain.slice(match.index + match[0].length, match.index + match[0].length + 35));
    // A monthly/instalment amount is not evidence of the full product price.
    if (/(?:\d+\s*(?:x|vezes|parcelas?)\s*(?:(?:sem|com)\s+juros\s*)?(?:de\s*)?|parcela(?:s)?\s*(?:de\s*)?|entrada\s*|sinal\s*)$/i.test(before)
      || /(?:\bfrete|\benvio|\bganhe|\beconomize|\bcashback|\bbonus|\bcupom(?: de)?|\bdesconto(?: de)?)\s*[:=]?\s*$/.test(before)
      || /(?:\bacima de|\ba partir de|\bcompras (?:de|acima de)|\bpedido minimo(?: de)?|\bminimo de|\bate|\bmenos de|\bmais de|\babaixo de|\bcerca de|\bpor volta de|\baproximadamente)\s*[:=]?\s*$/.test(before)
      || /(?:\bnao(?:\s+(?:custa|custe|e|esta|sai|saia|por|de|era|tem|ha|pague|pagar|vale)){0,3}|\bsem preco(?: de)?)\s*$/.test(before)
      || /^\s*(?:\/(?:mes|mensal)|por mes|mensais?\b|ao mes\b|cada parcela\b|(?:de )?(?:desconto|cashback|off)\b)/.test(after)) continue;
    const previous = /(?:\bde|\bantes(?: era)?|\bera|\bpreco (?:original|anterior|cheio)|\bvalor original|\btabela)\s*[:=~-]?\s*$/.test(before)
      || (/~\s*$/.test(before) && /^\s*~/.test(after));
    const current = /(?:\bpor|\bagora|\bhoje|\bapenas|\bsomente|\bsai(?:ndo)?(?: por)?|\bpreco|\bvalor|\ba vista|\bno pix|→|->)\s*[:=~-]?\s*$/.test(before)
      || /^\s*(?:no pix|a vista)\b/.test(after);
    matches.push({ value, previous: previous && !current, current });
  }
  const distinct = (items: PriceMatch[]) => [...new Set(items.map(item => item.value))];
  const previousValues = distinct(matches.filter(item => item.previous));
  const currentValues = distinct(matches.filter(item => item.current && !item.previous));
  const unmarkedValues = distinct(matches.filter(item => !item.previous && !item.current));
  const previousPrice = previousValues.length === 1 ? previousValues[0] : null;
  const candidates = [...new Set([...currentValues,...unmarkedValues])];
  // Conflicting explicit current prices (e.g. card vs Pix) need review instead of choosing the cheapest.
  const price = candidates.length === 1 ? candidates[0] : null;
  return { price, previousPrice, ambiguous: candidates.length > 1 || previousValues.length > 1 };
}

function negatedBefore(text: string, index: number): boolean {
  const before = normalize(text.slice(Math.max(0, index - 60), index));
  return /(?:\bsem|\bnao(?:\s+(?:tem|ha|possui|inclui|oferece|e|esta|disponivel))?|\bnunca|\bindisponivel|\bnenhum)\s+(?:\w+\s+){0,3}$/.test(before);
}

function extractCoupon(text: string): string | null {
  const pattern = /\b(?:cupom|coupon|c[oó]digo(?:\s+promocional)?)\s*(?::|=|-)?\s*(?:(?:use|usar|aplique|utilize|o)\s+)?["'`*]*([a-z0-9][a-z0-9_-]{2,31})\b(?![\p{L}\p{N}_-])/giu;
  const invalidWords = /^(?:gratis|frete|desconto|disponivel|automatico|aplicado|invalido|expirado|esgotado|indisponivel|para|pelo|pode|exclusivo|especial|novo|nova|extra|valid[oa]|somente|primeira|compra|compras|nenhum|sem|nao|off|app|site|loja|aqui|use|usar|aplique|utilize)$/;
  const codes: string[] = [];
  for (const match of text.matchAll(pattern)) {
    const code = match[1];
    const after = normalize(text.slice(match.index + match[0].length, match.index + match[0].length + 40));
    if (negatedBefore(text, match.index) || invalidWords.test(normalize(code)) || /^["'`*]*\s*(?:%|(?:esta |e )?(?:invalido|expirado|esgotado|indisponivel)|nao (?:funciona|disponivel|esta|e|vale))/.test(after)) continue;
    // Plain prose after “cupom” is not a code. An explicit separator, uppercase spelling, or digit is required.
    if (!/[:=\-"'`]/.test(match[0].slice(0, -code.length)) && code !== code.toUpperCase() && !/\d/.test(code)) continue;
    codes.push(code);
  }
  const unique = [...new Set(codes)];
  return unique.length === 1 ? unique[0] : null;
}

function extractShipping(text: string): boolean {
  for (const match of text.matchAll(/\b(?:frete\s+(?:gr[aá]tis|gratuito)|envio\s+(?:gr[aá]tis|gratuito)|sem\s+(?:custo\s+de\s+)?frete\b(?!\s+(?:gr[aá]tis|gratuito)\b))\b/gi)) {
    if (negatedBefore(text, match.index)) continue;
    const after = normalize(text.slice(match.index + match[0].length, match.index + match[0].length + 65));
    // A condition on the same advertised benefit is not evidence of free shipping for everyone.
    // Examples: only in the app, on the first order, or after joining a club.
    if (/^\s*[:!–—-]?\s*(?:nao\b|indisponivel\b|apenas\b|somente\b|so\b|exclusiv[oa]\b|para\b|acima\b|a partir\b|em (?:compras|pedidos)\b|nas compras\b|com\b|se\b|a depender\b|sujeito\b|mediante\b|na primeira compra\b|no (?:app|aplicativo|clube|programa)\b|pelo (?:app|aplicativo)\b|via (?:app|aplicativo)\b)/.test(after)
      && !/^\s*para\s+tod[oa](?:\s+[oa])?\s+(?:brasil|pais|territorio nacional)\b/.test(after)) continue;
    return true;
  }
  return false;
}

function extractDiscount(text: string, price: number | null, previousPrice: number | null): number | null {
  if (price !== null && previousPrice !== null && previousPrice > price) return Math.round((1 - price / previousPrice) * 100);
  const values: number[] = [];
  for (const match of text.matchAll(/\b(\d{1,3}(?:[.,]\d+)?)\s*%\s*(?:de\s+desconto|off\b|desconto\b)/gi)) {
    const before = normalize(text.slice(Math.max(0, match.index - 55), match.index));
    if (negatedBefore(text, match.index) || /(?:\bate|\bmais de|\bcupom(?:\s+de)?|\bganhe(?:\s+ate)?)\s*$/.test(before)) continue;
    const amount = Number(match[1].replace(',', '.'));
    if (amount > 0 && amount < 100) values.push(amount);
  }
  const unique = [...new Set(values)];
  return unique.length === 1 ? unique[0] : null;
}

function chooseTitle(text: string): string {
  const lines = text.replace(new RegExp(urlPattern), '').split(/\r?\n/);
  for (const original of lines) {
    let line = original.replace(/[\p{Extended_Pictographic}\uFE0F\u200D]/gu, '').replace(/[*_~`]/g, '').trim();
    line = line.replace(/^\d+[.)-]\s+/, '').replace(/^[\s\p{P}]+/u, '').replace(/^(?:(?:super\s+)?(?:oferta|promo[cç][aã]o|achadinho|imperd[ií]vel|corre|baratinho|aten[cç][aã]o|aproveite|pre[cç]o\s+imperd[ií]vel|menor\s+pre[cç]o|s[oó]\s+hoje)(?:\s+(?:do dia|rel[aâ]mpago|boa))?\s*[:!|–—-]*\s*)+/i, '');
    line = line.replace(/\s*(?:[|–—-]\s*)?(?:de\s+)?(?:R\$|\bBRL\b).*$/i, '')
      .replace(/\s*(?:[|–—-]\s*)?(?:\d+\s*%\s*(?:off|de desconto)|\b(?:use\s+(?:o\s+)?cupom|cupom|frete gr[aá]tis|compre agora|clique|link (?:abaixo|aqui)|aproveite (?:agora|aqui)|garanta (?:j[aá]|o seu))).*$/i, '')
      .replace(/\s*\b(?:por|de|apenas|somente|agora|hoje)\s*[:|–—-]?\s*$/i, '').replace(/^[\s|:;–—-]+|[\s|:;!–—-]+$/g, '').trim();
    const plain = normalize(line);
    if (line.length < 4 || !/\p{L}/u.test(line) || /^(?:de|por|antes|agora|preco|valor|cupom|codigo|frete|envio|https?|link|comprar|compre|clique|confira|acesse|veja|saiba|aproveite|garanta|parcelamento|em ate|em \d|\d+\s*x|\d+\s*vezes|sem juros|sem cupom|nao tem|nao possui|sem desconto|desconto)\b/.test(plain)) continue;
    if (/^(?:ofertas?|promocoes?|achadinhos?|imperdivel|corre|so hoje|menor preco|ultima chance|preco baixo|para voce|disponivel|esgotado|economize)(?:\b|$)/.test(plain)) continue;
    return line.slice(0, 180);
  }
  return fallbackTitle;
}

function categoryFor(title: string): CategoryId {
  const value = normalize(title);
  const categories: [CategoryId, RegExp][] = [
    ['maternidade', /\b(?:bebe|infantil|fralda|mamadeira|chupeta|maternidade|amamentacao|carrinho de bebe|berco|gestante)\b/],
    ['beleza', /\b(?:perfume|perfumaria|batom|maquiagem|skincare|serum|hidratante|cosmetico|cosmeticos|shampoo|condicionador|capilar|cabelo|secador|chapinha|escova secadora|protetor solar|sabonete|esmalte|mascara facial|desodorante|creme|dermocosmetico)\b/],
    ['tecnologia', /\b(?:iphone|smartphone|celular|notebook|laptop|tablet|computador|monitor|teclado|mouse|fone|headphone|earbuds|smartwatch|televisao|tv|alexa|echo|kindle|camera|webcam|carregador|powerbank|ssd|pendrive|roteador|playstation|xbox|console|impressora|bluetooth)\b/],
    ['bem-estar', /\b(?:whey|creatina|suplemento|suplementos|vitamina|vitaminas|colageno|fitness|yoga|pilates|halter|halteres|massageador|esteira|bicicleta|ergometrica|termometro|balanca|saude|bem estar)\b/],
    ['moda', /\b(?:vestido|blusa|camiseta|camisa|calca|saia|short|shorts|tenis|sapato|sandalia|chinelo|bolsa|mochila|carteira|relogio|brinco|colar|pulseira|anel|jaqueta|casaco|lingerie|sutia|calcinha|pijama|oculos|legging|biquini|moda)\b/],
    ['casa', /\b(?:panela|frigideira|airfryer|air fryer|fritadeira|cafeteira|cafe|liquidificador|batedeira|chaleira|aspirador|robo aspirador|organizador|organizadores|cesto|pote|potes|cozinha|casa|cama|mesa|banho|toalha|lencol|travesseiro|almofada|tapete|sofa|cadeira|luminaria|lampada|copo|copos|garrafa|talher|faqueiro|prato|pratos|microondas|geladeira|lavadora|ventilador|ferro|escorredor|varal)\b/],
  ];
  return categories.find(([, pattern]) => pattern.test(value))?.[0] ?? 'outros';
}

export function parseOffer(text: string): ParsedOffer {
  const source = String(text).slice(0, 32_000);
  const { price, previousPrice, ambiguous } = extractPrices(source);
  const title = chooseTitle(source);
  const category = categoryFor(title);
  const coupon = extractCoupon(source);
  const freeShipping = extractShipping(source);
  const discount = extractDiscount(source, price, previousPrice);
  const confidence = clamp(0.1 + (title !== fallbackTitle ? 0.4 : 0) + (price !== null ? 0.35 : 0)
    + (category !== 'outros' ? 0.05 : 0) + (previousPrice !== null && price !== null && previousPrice > price ? 0.05 : 0)
    + (coupon !== null || freeShipping ? 0.05 : 0) - (ambiguous ? 0.15 : 0), 0, 1);
  return { title, price, previousPrice, discount, coupon, freeShipping, category, confidence: Math.round(confidence * 100) / 100 };
}

/** Keep commercial facts inside their own link's source block. Ambiguous adjacent links get no shared claim. */
export function parseLinkedOffers(text: string): Array<{ url: string; text: string }> {
  const source = String(text);
  const matches = urlsWithPositions(source);
  if (matches.length === 0) return [];
  if (matches.length === 1) return [{ url: matches[0].url, text: source }];
  // Explicit blank-line blocks establish the association without borrowing a
  // coupon or shipping claim from a neighbouring promotion.
  const paragraphs: Array<{start:number;end:number}> = [];
  let paragraphStart = 0;
  for (const separator of source.matchAll(/\r?\n[\t ]*\r?\n(?:[\t ]*\r?\n)*/g)) {
    paragraphs.push({start:paragraphStart,end:separator.index});
    paragraphStart = separator.index + separator[0].length;
  }
  paragraphs.push({start:paragraphStart,end:source.length});
  const paragraphBlocks = matches.map(match => {
    const paragraph = paragraphs.find(item=>item.start <= match.start && item.end >= match.end)!;
    return {url:match.url,text:source.slice(paragraph.start,paragraph.end).trim(),paragraph};
  });
  const independentParagraphs = paragraphBlocks.every(block=>matches.filter(match=>match.start >= block.paragraph.start && match.end <= block.paragraph.end).length === 1);
  let blocks: Array<{url:string;text:string}>;
  if (independentParagraphs) blocks = paragraphBlocks.map(({url,text})=>({url,text}));
  else {
    // Dense messages can still use a repeated title/price/link layout. Require
    // exactly one title line per region. Extra prose or mixed layouts are
    // ambiguous, so those entries retain only their URL and need review.
    const titledRegion = (start:number,end:number): {text:string;titleCount:number} => {
      const region = source.slice(start,end);
      let offset = 0;
      const titles: number[] = [];
      for (const line of region.split(/\r?\n/)) {
        if (chooseTitle(line) !== fallbackTitle) titles.push(offset);
        offset += line.length + (region.slice(offset+line.length,offset+line.length+2) === '\r\n' ? 2 : 1);
      }
      return {text:titles.length === 1 ? region.slice(titles[0]).trim() : '',titleCount:titles.length};
    };
    const prefix = titledRegion(0,matches[0].start);
    const startsWithLink = prefix.titleCount === 0 && !new RegExp(moneyPattern).test(source.slice(0,matches[0].start));
    blocks = matches.map((match,index)=> {
      if (startsWithLink) {
        const region = titledRegion(match.end,matches[index+1]?.start ?? source.length);
        return {url:match.url,text:region.titleCount === 1 ? `${match.url}\n${region.text}` : match.url};
      }
      const region = titledRegion(matches[index-1]?.end ?? 0,match.start);
      return {url:match.url,text:region.titleCount === 1 ? `${region.text}\n${match.url}` : match.url};
    });
  }
  // Consecutive links with no product-specific text between them share an unknowable association.
  for (let start = 0; start < matches.length; start++) {
    let end = start;
    while (end + 1 < matches.length && !source.slice(matches[end].end, matches[end + 1].start).replace(/[\s\p{P}\p{S}]/gu, '')) end++;
    if (end > start) for (let index = start; index <= end; index++) blocks[index].text = blocks[index].url;
    start = end;
  }
  const seen = new Set<string>();
  return blocks.filter(block => {
    if (seen.has(block.url)) return false;
    seen.add(block.url);
    return true;
  });
}
