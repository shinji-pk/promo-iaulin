import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildAffiliateLink, calibrateAffiliate, getIntegrationStatuses, identifyPlatform, identifyProduct, validateAffiliateLink, validateCalibration } from '../packages/affiliate-adapters/src/index.ts';
import { evaluatePublication, extractUrls, MAX_LINKS_PER_MESSAGE, MAX_PROCESSING_MS, parseLinkedOffers, parseOffer, processPromotion, renderMessage } from '../packages/core/src/index.ts';
import { scoreOffer } from '../packages/scoring/src/index.ts';
import { defaultSettings, effectiveIntervalMs, paceRiskCovered, platformIds, RISK_NOTICE_VERSION, riskNoticeAccepted, sendingPaceRisk, type AffiliateConfig, type Feedback, type Offer, type Settings } from '../packages/shared/src/index.ts';
import { offerSchema } from '../packages/db/src/index.ts';
import type { AffiliatePort } from '../packages/shared/src/features.ts';

const now = new Date('2026-10-18T15:00:00.000Z');
const original = 'https://www.amazon.com.br/dp/B09B8VGCR8';
const second = 'https://www.amazon.com.br/dp/B0B1N5H7X2';
const calibration = (): AffiliateConfig => ({enabled:true,publicId:'garimpos-20',originalUrl:original,affiliateUrl:`${original}?tag=garimpos-20`,verifiedAt:now.toISOString()});
const settings = (): Settings => {
  const result = defaultSettings();
  Object.assign(result,{riskNotice:{version:RISK_NOTICE_VERSION,acceptedAt:'2026-10-18T12:00:00.000Z'},mode:'auto',minScore:60,sourceGroups:['source@g.us'],destinationGroup:'destination@g.us',quietStart:'00:00',quietEnd:'00:00'});
  result.affiliates.amazon = calibration();
  return result;
};
const offerText = (url = original, price = '299,90') => `✨ Oferta imperdível!\nAir Fryer 4 litros\nDe R$ 499,90 por R$ ${price}\nCupom: CASA10\nFrete grátis\n${url}`;
const ingest = (text = offerText(), overrides = {}) => ({text,sourceId:'source@g.us',sourceName:'Fonte autorizada',messageId:'message-1',simulation:false,...overrides});
const resolveUrl = async (url:string) => url;
async function offer(overrides:Partial<Offer> = {}, config = settings()): Promise<Offer> {
  const [result] = await processPromotion(ingest(),config,{resolveUrl});
  return {...result,...overrides};
}

beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime(now);});
afterEach(()=>vi.useRealTimers());

describe('identidade dos sete marketplaces',()=> {
  const fixtures = [
    {platform:'amazon',id:'B09B8VGCR8',canonical:original,urls:[`${original}?tag=origem-20`, 'https://amazon.com.br/echo-dot/gp/product/b09b8vgcr8/ref=abc','https://www.amazon.com.br/gp/aw/d/B09B8VGCR8/']},
    {platform:'shopee',id:'12345678.987654321',canonical:'https://shopee.com.br/product/12345678/987654321',urls:['https://shopee.com.br/Organizador-i.12345678.987654321?sp_atk=example','https://shopee.com.br/product/12345678/987654321']},
    {platform:'mercadolivre',id:'MLB1234567890',canonical:'https://produto.mercadolivre.com.br/MLB-1234567890',urls:['https://produto.mercadolivre.com.br/MLB-1234567890-air-fryer-_JM','https://www.mercadolivre.com.br/MLB1234567890?tracking=example']},
    {platform:'magalu',id:'238218200',canonical:'https://www.magazineluiza.com.br/p/238218200/',urls:['https://www.magazineluiza.com.br/fritadeira/p/238218200/ep/frel/?seller_id=magazineluiza','https://www.magalu.com/produto/p/238218200/']},
    {platform:'aliexpress',id:'1005005899513913',canonical:'https://www.aliexpress.com/item/1005005899513913.html',urls:['https://pt.aliexpress.com/item/1005005899513913.html?aff_fcid=example','https://www.aliexpress.com/item/1005005899513913.html']},
    {platform:'shein',id:'14567890',canonical:'https://br.shein.com/p-14567890.html',urls:['https://br.shein.com/Women-Dress-p-14567890.html?src_identifier=example','https://m.shein.com/br/p-14567890.html']},
    {platform:'temu',id:'601099512345678',canonical:'https://www.temu.com/goods.html?goods_id=601099512345678',urls:['https://www.temu.com/br/organizador-g-601099512345678.html?refer_page_name=example','https://www.temu.com/goods.html?goods_id=601099512345678']},
  ];
  it.each(fixtures)('canonicaliza variantes de $platform preservando identidade',fixture=> {
    const identified = fixture.urls.map(url=>identifyProduct(url));
    for (const item of identified) expect(item).toMatchObject({platform:fixture.platform,productId:fixture.id,canonicalUrl:fixture.canonical});
    expect(new Set(identified.map(item=>item?.productKey)).size).toBe(1);
    expect(identifyProduct(fixture.canonical)?.productKey).toBe(identified[0]?.productKey);
  });
  it('distingue catálogo e anúncio Mercado Livre e marketplaces Amazon',()=> {
    expect(identifyProduct('https://www.mercadolivre.com.br/p/MLB12345678')?.productId).toBe('catalog:MLB12345678');
    expect(identifyProduct('https://www.mercadolivre.com.br/p/MLB12345678')?.productKey).not.toBe(identifyProduct('https://produto.mercadolivre.com.br/MLB-12345678')?.productKey);
    expect(identifyProduct(original)?.productKey).not.toBe(identifyProduct(original.replace('.com.br','.com'))?.productKey);
  });
  it.each(['http://amazon.com.br/dp/B09B8VGCR8','https://amazon.com.br.evil.example/dp/B09B8VGCR8','https://evil-amazon.com.br/dp/B09B8VGCR8','https://user:secret@amazon.com.br/dp/B09B8VGCR8','https://amazon.com.br:444/dp/B09B8VGCR8','https://amazon.com.br./dp/B09B8VGCR8','https://amazon.com.br/dp/not-an-asin','https://www.temu.com/goods.html?goods_id=601099512345678&goods_id=601099599999999','https://www.temu.com/item-g-601099512345678.html?goods_id=601099599999999'])('não identifica endereço enganoso ou ambíguo: %s',url=>expect(identifyProduct(url)).toBeNull());
  it('reconhece a loja sem declarar página genérica como produto',()=> {
    expect(identifyPlatform('https://shopee.com.br/search?keyword=panela')).toBe('shopee');
    expect(identifyProduct('https://shopee.com.br/search?keyword=panela')).toBeNull();
    expect(identifyProduct('https://amzn.to/link-curto')).toBeNull();
  });
});

describe('calibração e prova estrutural da afiliação',()=> {
  it('exige mesmo produto, uma única tag e configuração habilitada',async()=> {
    const config = calibration();
    expect(await calibrateAffiliate('amazon',config)).toMatchObject({valid:true});
    expect(validateCalibration('amazon',{...config,affiliateUrl:`${second}?tag=garimpos-20`}).valid).toBe(false);
    expect(validateCalibration('amazon',{...config,affiliateUrl:`${original}?tag=outra-20`}).valid).toBe(false);
    expect(validateCalibration('amazon',{...config,affiliateUrl:`${original}?tag=garimpos-20&tag=garimpos-20`}).valid).toBe(false);
    expect(validateCalibration('amazon',{...config,enabled:false}).valid).toBe(false);
    expect(validateCalibration('amazon',{...config,publicId:'inventado'}).valid).toBe(false);
  });
  it('só gera após calibração concluída, com tag pública, no marketplace calibrado',()=> {
    const product=identifyProduct(second)!;
    expect(buildAffiliateLink(product,{...calibration(),verifiedAt:null})).toBeNull();
    expect(buildAffiliateLink(product,{...calibration(),verifiedAt:'invalid'})).toBeNull();
    expect(buildAffiliateLink(product,{...calibration(),verifiedAt:'2099-01-01T00:00:00Z'})).toBeNull();
    const url=buildAffiliateLink(product,calibration())!;
    expect(url).toBe(`${second}?tag=garimpos-20`);
    expect(validateAffiliateLink(url,product,calibration()).valid).toBe(true);
    const us=identifyProduct(second.replace('.com.br','.com'))!;
    expect(buildAffiliateLink(us,calibration())).toBeNull();
    expect(validateAffiliateLink(`${us.canonicalUrl}?tag=garimpos-20`,us,calibration()).valid).toBe(false);
    expect(buildAffiliateLink({...product,productId:'alterado'},calibration())).toBeNull();
  });
  it.each([`${second}?tag=garimpos-20`,`${original}?tag=outra-20`,`${original}?tag=garimpos-20&redirect=https://evil.example`,`${original.replace('.com.br','.com')}?tag=garimpos-20`,`http://www.amazon.com.br/dp/B09B8VGCR8?tag=garimpos-20`])('validação independente rejeita produto/tag/URL alterado: %s',url=> {
    expect(validateAffiliateLink(url,identifyProduct(original)!,calibration()).valid).toBe(false);
  });
  it('bloqueia conversões não implementadas sem inventar parâmetro de comissão',async()=> {
    const config=settings();
    for (const platform of platformIds.filter(id=>id!=='amazon')) {
      const productUrl={shopee:'https://shopee.com.br/product/123/456',mercadolivre:'https://www.mercadolivre.com.br/p/MLB12345678',magalu:'https://magalu.com/p/238218200/',aliexpress:'https://aliexpress.com/item/1005005899513913.html',shein:'https://br.shein.com/p-14567890.html',temu:'https://temu.com/goods.html?goods_id=601099512345678'}[platform];
      const product=identifyProduct(productUrl)!;
      const affiliate={...calibration(),originalUrl:productUrl,affiliateUrl:`${productUrl}${productUrl.includes('?')?'&':'?'}aff_id=public`};
      config.affiliates[platform]=affiliate;
      expect((await calibrateAffiliate(platform,affiliate)).valid).toBe(false);
      expect(buildAffiliateLink(product,affiliate)).toBeNull();
      expect(validateAffiliateLink(affiliate.affiliateUrl,product,affiliate).valid).toBe(false);
    }
    expect(getIntegrationStatuses(config).filter(item=>item.state==='ready').map(item=>item.id)).toEqual(['amazon']);
    config.affiliates.amazon.verifiedAt=null;
    expect(getIntegrationStatuses(config).find(item=>item.id==='amazon')?.state).toBe('needs_calibration');
  });
});

describe('extração conservadora e reescrita',()=> {
  it('extrai reais, comparação de preço, cupom, frete e categoria sem copiar a chamada',()=> {
    const parsed=parseOffer(offerText());
    expect(parsed).toMatchObject({title:'Air Fryer 4 litros',price:299.9,previousPrice:499.9,discount:40,coupon:'CASA10',freeShipping:true,category:'casa'});
    expect(parsed.confidence).toBeGreaterThanOrEqual(.75);
  });
  it.each([['R$ 1.234,56',1234.56],['BRL 89.90',89.9],['R$ 1.299',1299],['R$ 59,9',59.9]])('interpreta %s', (amount,value)=>expect(parseOffer(`Perfume\n${amount}`).price).toBe(value));
  it.each(['Air Fryer\n10x de R$ 29,90 sem juros','Air Fryer\nParcela de R$ 29,90','Air Fryer\nFrete R$ 19,90','Air Fryer\nR$ 40 de desconto','Air Fryer\nNão custa R$ 199,90','Air Fryer\nR$ 29,90 por mês','Air Fryer\nPor R$ 199,90\nNo Pix R$ 179,90','Air Fryer\nPor R$ 199,90\nR$ 179,90','Air Fryer\nAté R$ 100','Air Fryer\nDe R$ 100 a R$ 200','Air Fryer\nNão pague R$ 100'])('não transforma parcela, benefício ou conflito em preço: %s',text=>expect(parseOffer(text).price).toBeNull());
  it('não afirma descontos, cupons ou frete condicionais e negados',()=> {
    for (const text of ['Sem cupom. Sem frete grátis. Até 70% de desconto.','Cupom: CASA10 expirado\nFrete grátis acima de R$ 199,90','Cupom de 10%\nFrete grátis apenas no app']) {
      expect(parseOffer(text)).toMatchObject({coupon:null,freeShipping:false,discount:null,price:null,previousPrice:null});
    }
    expect(parseOffer('Cupom: CASA10\nCupom: OUTRO20').coupon).toBeNull();
    expect(parseOffer('Frete grátis para todo o Brasil').freeShipping).toBe(true);
  });
  it.each([
    'Frete grátis no app',
    'Frete grátis: só no aplicativo',
    'Frete grátis na primeira compra',
    'Frete grátis mediante cadastro',
    'Frete grátis exclusivo para membros',
    'Frete grátis em pedidos acima de R$ 99',
    'Envio gratuito no clube',
    'Envio gratuito via aplicativo',
  ])('não anuncia frete condicional como gratuito para todos: %s',claim=>{
    expect(parseOffer(`Air Fryer 4 litros\n${claim}`).freeShipping).toBe(false);
  });
  it.each(['Frete grátis','Frete grátis para todo o Brasil','Envio gratuito','Sem custo de frete'])('mantém frete incondicional: %s',claim=>{
    expect(parseOffer(`Air Fryer 4 litros\n${claim}`).freeShipping).toBe(true);
  });
  it('não inclui promessa de frete grátis na mensagem gerada para oferta restrita ao app',async()=>{
    const [result]=await processPromotion(ingest(`Air Fryer 4 litros\nPor R$ 299,90\nFrete grátis no app\n${original}`),settings(),{resolveUrl});
    expect(result.freeShipping).toBe(false);
    expect(renderMessage(result,settings())).not.toContain('Frete grátis informado na oferta');
  });
  it('mantém claims de cada produto no seu bloco e descarta footer ambíguo',()=> {
    const blocks=parseLinkedOffers(`Air Fryer\nPor R$ 299,90\n${original}\nCupom: PRIME10\nPerfume\nPor R$ 89,90\n${second}`);
    expect(blocks.map(item=>parseOffer(item.text))).toMatchObject([{title:'Air Fryer',price:299.9,coupon:null},{title:'Perfume',price:89.9,coupon:null}]);
    const paragraphs=parseLinkedOffers(`Air Fryer\nPor R$ 299,90\nCupom: CASA10\n${original}\n\nPerfume\nPor R$ 89,90\nCupom: PERFUME20\n${second}`);
    expect(paragraphs.map(item=>parseOffer(item.text).coupon)).toEqual(['CASA10','PERFUME20']);
    const linkFirst=parseLinkedOffers(`${original}\nAir Fryer\nR$ 299,90\n${second}\nPerfume\nR$ 89,90`);
    expect(linkFirst.map(item=>parseOffer(item.text).price)).toEqual([299.9,89.9]);
  });
  it('não associa preço a links adjacentes ou layouts misturados',()=> {
    const adjacent=parseLinkedOffers(`Air Fryer R$ 299,90\n${original}\n${second}`);
    expect(adjacent.map(item=>parseOffer(item.text).price)).toEqual([null,null]);
    const mixed=parseLinkedOffers(`Air Fryer R$ 299,90\n${original}\nPerfume\nDescrição adicional sem associação clara\nR$ 89,90\n${second}`);
    expect(parseOffer(mixed[1].text).price).toBeNull();
    expect(extractUrls(`Veja (${original}), [${second}]. ${original}`)).toEqual([original,second]);
  });
  it('reescreve só os campos conhecidos e identifica link afiliado',async()=> {
    const result=await offer();
    expect(result.rewrittenText).not.toBe(result.originalText);
    expect(result.rewrittenText).not.toContain('Oferta imperdível');
    expect(result.rewrittenText).toContain('Link de afiliado');
    expect(extractUrls(result.rewrittenText)).toEqual([result.affiliateUrl]);
    const unknown=renderMessage({...result,price:null,previousPrice:null,discount:null,coupon:null,freeShipping:false},settings());
    expect(unknown).not.toMatch(/R\$|Cupom|Frete/);
  });
});

describe('pipeline, deduplicação e isolamento',()=> {
  it('processa dois produtos da mesma mensagem e detecta replay de cada produto',async()=> {
    const config=settings();
    const text=`Air Fryer\nR$ 299,90\n${original}\n\nPerfume\nR$ 89,90\n${second}`;
    const offers=await processPromotion(ingest(text),config,{resolveUrl});
    expect(offers).toHaveLength(2);
    expect(offers.every(item=>item.status==='approved')).toBe(true);
    const replay=await processPromotion(ingest(text),config,{resolveUrl,history:offers});
    expect(replay.every(item=>item.status==='duplicate')).toBe(true);
  });
  it('resolve shortlinks e continua quando um dos links falha',async()=> {
    const text=`Air Fryer\nR$ 299,90\nhttps://amzn.to/falha\n\nPerfume\nR$ 89,90\nhttps://amzn.to/sucesso`;
    const result=await processPromotion(ingest(text),settings(),{resolveUrl:async url=>{if(url.endsWith('falha')) throw new Error('Redirecionamento inseguro');return second;}});
    expect(result.map(item=>item.status)).toEqual(['blocked','approved']);
    expect(result[1].canonicalUrl).toBe(second);
  });
  it('limita resolução a oito links e retém um resumo explícito dos excedentes',async()=> {
    const urls=Array.from({length:12},(_,index)=>`https://www.amazon.com.br/dp/B${String(index).padStart(9,'0')}`);
    const resolve=vi.fn(resolveUrl);
    const result=await processPromotion(ingest(urls.map(url=>`Air Fryer\nR$ 299,90\n${url}`).join('\n\n')),settings(),{resolveUrl:resolve});
    expect(resolve).toHaveBeenCalledTimes(MAX_LINKS_PER_MESSAGE);
    expect(result).toHaveLength(MAX_LINKS_PER_MESSAGE+1);
    expect(result.at(-1)).toMatchObject({status:'blocked',affiliateUrl:null,title:'4 links adicionais retidos'});
    expect(result.at(-1)?.reasons.join(' ')).toMatch(/4 links adicionais/);
    expect(result.at(-1)?.originalText).toContain(urls.at(-1));
  });
  it('aplica orçamento total de resolução e não inicia novos requests após expirar',async()=> {
    const urls=Array.from({length:8},(_,index)=>`https://www.amazon.com.br/dp/B${String(index).padStart(9,'0')}`);
    let calls=0;
    const resolve=vi.fn((url:string)=>new Promise<string>(resolve=>{if(++calls<=2) setTimeout(()=>resolve(url),8000);}));
    const pending=processPromotion(ingest(urls.map(url=>`Air Fryer\nR$ 299,90\n${url}`).join('\n\n')),settings(),{resolveUrl:resolve});
    await vi.advanceTimersByTimeAsync(MAX_PROCESSING_MS);
    const result=await pending;
    expect(resolve).toHaveBeenCalledTimes(3);
    expect(result.slice(2).every(item=>item.status==='blocked')).toBe(true);
    expect(result.slice(2).every(item=>item.reasons.some(reason=>reason.includes('Orçamento')))).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('inclui a conversão oficial no orçamento total e retém os demais produtos sem novas chamadas',async()=> {
    const urls=Array.from({length:8},(_,index)=>`https://www.amazon.com.br/dp/B${String(index).padStart(9,'0')}`);
    let calls=0;
    const convert=vi.fn<AffiliatePort['convert']>(product=>new Promise(resolve=>{
      if (++calls<=2) setTimeout(()=>resolve({url:`${product.canonicalUrl}?tag=garimpos-20`,receiptId:`receipt:${product.productKey}`,method:'official-api',requiresManualApproval:false,reason:'Resposta autenticada.'}),8000);
    }));
    const affiliatePort:AffiliatePort={convert,validate:()=>({valid:true,method:'official-api',reason:'Resposta autenticada.'})};
    const pending=processPromotion(ingest(urls.map(url=>`Air Fryer\nR$ 299,90\n${url}`).join('\n\n')),settings(),{affiliatePort});
    await vi.advanceTimersByTimeAsync(MAX_PROCESSING_MS);
    const result=await pending;
    expect(convert).toHaveBeenCalledTimes(3);
    expect(result.slice(0,2).every(item=>item.status==='approved' && item.affiliateMethod==='official-api')).toBe(true);
    expect(result.slice(2).every(item=>item.status==='blocked' && item.reasons.some(reason=>reason.includes('Orçamento')))).toBe(true);
    expect(result[2].stages).toContainEqual(expect.objectContaining({name:'Afiliação',status:'blocked'}));
    expect(vi.getTimerCount()).toBe(0);
  });
  it('compartilha o mesmo prazo entre redirecionamentos e integração de afiliados',async()=> {
    const resolve=vi.fn((url:string)=>new Promise<string>(done=>setTimeout(()=>done(url),6000)));
    const convert=vi.fn<AffiliatePort['convert']>(product=>new Promise(done=>{
      if (convert.mock.calls.length===1) setTimeout(()=>done({url:`${product.canonicalUrl}?tag=garimpos-20`,receiptId:'receipt-1',method:'official-api',requiresManualApproval:false,reason:'Resposta autenticada.'}),5000);
    }));
    const pending=processPromotion(ingest(`${offerText()}\n\n${offerText(second)}`),settings(),{resolveUrl:resolve,affiliatePort:{convert,validate:()=>({valid:true,method:'official-api',reason:'Resposta autenticada.'})}});
    await vi.advanceTimersByTimeAsync(MAX_PROCESSING_MS);
    const result=await pending;
    expect(result.map(item=>item.status)).toEqual(['approved','blocked']);
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(convert).toHaveBeenCalledTimes(2);
    expect(result[1].reasons.join(' ')).toContain('Orçamento');
    expect(vi.getTimerCount()).toBe(0);
  });
  it('usa o relógio informado para criação e validade da oferta',async()=> {
    const clock=new Date('2026-10-19T08:12:00.000Z');
    const [result]=await processPromotion(ingest(),{...settings(),maxOfferAgeHours:6},{resolveUrl,now:()=>clock});
    expect(result.createdAt).toBe(clock.toISOString());
    expect(result.expiresAt).toBe('2026-10-19T14:12:00.000Z');
  });
  it('identifica loja sem mecanismo de afiliação, mas impede publicação',async()=> {
    const [result]=await processPromotion(ingest(offerText('https://shopee.com.br/product/123/456')),settings(),{resolveUrl});
    expect(result.platform).toBe('shopee');
    expect(result.status).toBe('blocked');
    expect(result.affiliateUrl).toBeNull();
    expect(evaluatePublication({...result,status:'approved'},settings(),[],now).allowed).toBe(false);
  });
  it('só permite exceção de preço menor com histórico inteiro confiável e outra mensagem',async()=> {
    const config=settings();
    const prior=await offer({id:'old',sourceMessageId:'other-message',price:400,status:'published',publishedAt:now.toISOString()});
    const next=await offer({id:'new',price:300});
    // Ritmo calmo (5 min, até 4/h): testa só a regra de preço, sem cair no aceite de ritmo de alto risco.
    expect(evaluatePublication(next,{...config,minIntervalMinutes:5},[{...prior,publishedAt:new Date(now.getTime()-3600000).toISOString()}],now).allowed).toBe(true);
    expect(evaluatePublication({...next,price:390},config,[prior],now).reasons.join(' ')).toMatch(/repetido/);
    expect(evaluatePublication(next,config,[{...prior,price:null}],now).reasons.join(' ')).toMatch(/repetido/);
    expect(evaluatePublication(next,config,[{...prior,sourceMessageId:next.sourceMessageId}],now).reasons.join(' ')).toMatch(/mensagem/);
    expect(evaluatePublication(next,{...config,allowPriceDrop:false},[prior],now).reasons.join(' ')).toMatch(/repetido/);
  });
  it.each(['publishing','uncertain'] as const)('mantém reserva %s além da janela e após serialização',async status=> {
    const next=await offer();
    const old=new Date(now.getTime()-365*86400000).toISOString();
    const history=JSON.parse(JSON.stringify([{...next,id:'prior',status,sourceMessageId:'prior-message',createdAt:old,updatedAt:old,price:9999}])) as Offer[];
    expect(evaluatePublication({...next,price:1},settings(),history,now).reasons.join(' ')).toMatch(/incerto/);
    history[0].status='published';history[0].publishedAt=old;
    expect(evaluatePublication(next,settings(),history,now).allowed).toBe(true);
  });
  it('simulações não são publicáveis nem contaminam dedupe e limites reais',async()=> {
    const next=await offer();
    const simulation={...next,id:'simulation',simulation:true,status:'uncertain' as const};
    expect(evaluatePublication(next,settings(),[simulation],now).allowed).toBe(true);
    expect(evaluatePublication({...next,simulation:true},settings(),[],now).allowed).toBe(false);
    const [result]=await processPromotion(ingest(undefined,{simulation:true}),settings(),{resolveUrl,history:[next]});
    expect(result.status).toBe('simulated');
    expect(evaluatePublication({...result,status:'approved'},settings(),[],now).allowed).toBe(false);
  });
  it.each(['https://private-user:private-password@www.amazon.com.br/dp/B09B8VGCR8',"https://private-user:private-pass'word@www.amazon.com.br/dp/B09B8VGCR8"])('mensagens maliciosas continuam persistíveis e nunca expõem credenciais: %s',async unsafe=> {
    const [result]=await processPromotion(ingest(offerText(unsafe),{imageUrl:unsafe}),settings(),{resolveUrl:async()=>{throw new Error(`Endereço recusado: ${unsafe}`);}});
    expect(result.status).toBe('blocked');
    expect(result.originalUrl).toBe('');
    expect(result.imageUrl).toBeNull();
    expect(JSON.stringify(result)).not.toMatch(/private-user|private-pass/);
    expect(offerSchema.safeParse(result).success).toBe(true);
  });
});

describe('gates de publicação sempre reavaliadas, inclusive manual',()=> {
  it('uma oferta válida é elegível, modo manual exige ação explícita',async()=> {
    const result=await offer();
    expect(evaluatePublication(result,settings(),[],now)).toEqual({allowed:true,reasons:[]});
    const config={...settings(),mode:'manual' as const};
    expect(evaluatePublication(result,config,[],now,{automatic:true}).allowed).toBe(false);
    expect(evaluatePublication(result,config,[],now).allowed).toBe(true);
  });
  it.each([
    ['pausa', (s:Settings)=>{s.paused=true;}],
    ['score', (s:Settings)=>{s.minScore=100;}],
    ['origem', (s:Settings)=>{s.sourceGroups=[];}],
    ['destino ausente', (s:Settings)=>{s.destinationGroup='';}],
    ['loop de destino', (s:Settings)=>{s.destinationGroup='source@g.us';}],
    ['categoria', (s:Settings)=>{s.audience.weights.casa=0;}],
    ['palavra', (s:Settings)=>{s.audience.blockedWords=['FRÝER'];}],
    ['loja', (s:Settings)=>{s.audience.blockedPlatforms=['amazon'];}],
    ['calibração', (s:Settings)=>{s.affiliates.amazon.verifiedAt=null;}],
    ['tag alterada', (s:Settings)=>{s.affiliates.amazon.publicId='outra-20';}],
  ])('publicação manual respeita %s',async(_name,mutate)=> {
    const result=await offer();const config=settings();mutate(config);
    expect(evaluatePublication(result,config,[],now).allowed).toBe(false);
  });
  it.each(['published','publishing','uncertain','rejected','duplicate','simulated','blocked','failed'] as const)('não publica estado %s',async status=>expect(evaluatePublication(await offer({status}),settings(),[],now).allowed).toBe(false));
  it('bloqueia baixa confiança e identidade ou afiliação alterada',async()=> {
    const result=await offer();
    for (const overrides of [{confidence:.74},{confidence:NaN},{score:NaN},{productId:'alterado'},{productKey:'outro'},{platform:'shopee' as const},{affiliateValid:false},{affiliateUrl:`${second}?tag=garimpos-20`}]) {
      expect(evaluatePublication({...result,...overrides},settings(),[],now).allowed).toBe(false);
    }
  });
  it('usa o horário local, inclusive janelas que cruzam meia-noite',async()=> {
    const result=await offer();const config={...settings(),timezone:'America/Sao_Paulo',quietStart:'22:00',quietEnd:'08:00'};
    expect(evaluatePublication(result,config,[],new Date('2026-10-18T01:00:00Z')).reasons.join(' ')).toMatch(/silêncio/);
    expect(evaluatePublication(result,config,[],new Date('2026-10-18T10:59:00Z')).allowed).toBe(false);
    expect(evaluatePublication(result,config,[],new Date('2026-10-18T11:00:00Z')).allowed).toBe(true);
  });
  it('aplica limite e intervalo de envios publicados, pendentes e incertos',async()=> {
    const result=await offer();const config=settings();
    const history=Array.from({length:4},(_,index)=>({...result,id:`history-${index}`,productKey:`other:${index}`,sourceMessageId:`other-${index}`,status:'published' as const,publishedAt:new Date(now.getTime()-20*60000-index*60000).toISOString()}));
    expect(evaluatePublication(result,config,history,now).reasons.join(' ')).toMatch(/por hora/);
    for(const status of ['published','publishing','uncertain'] as const) {
      expect(evaluatePublication(result,config,[{...history[0],status,publishedAt:null,updatedAt:new Date(now.getTime()-60000).toISOString()}],now).reasons.join(' ')).toMatch(/Intervalo mínimo/);
    }
  });
  it('mantém ofertas válidas na fila durante pausa e silêncio para reavaliar depois',async()=> {
    for (const overrides of [{paused:true},{quietStart:'11:00',quietEnd:'13:00'}]) {
      const config={...settings(),...overrides};
      const [result]=await processPromotion(ingest(),config,{resolveUrl});
      expect(result.status).toBe('approved');
      expect(evaluatePublication(result,config,[],now,{automatic:true}).allowed).toBe(false);
      expect(evaluatePublication(result,{...config,paused:false,quietStart:'00:00',quietEnd:'00:00'},[],now,{automatic:true}).allowed).toBe(true);
    }
  });
  it('preserva a fila aprovada ao atingir frequência e libera apenas após a janela',async()=> {
    const config={...settings(),maxPostsPerHour:1,minIntervalMinutes:5};
    const prior=await offer({id:'previous',productKey:'outro-produto',sourceMessageId:'previous-message',status:'published',publishedAt:now.toISOString()});
    const [result]=await processPromotion(ingest(),config,{resolveUrl,history:[prior]});
    expect(result.status).toBe('approved');
    expect(evaluatePublication(result,config,[prior],now,{automatic:true}).allowed).toBe(false);
    expect(evaluatePublication(result,config,[prior],new Date(now.getTime()+3_600_001),{automatic:true}).allowed).toBe(true);
  });
  it('o agendamento respeita pausa, silêncio e validade, inclusive na checagem temporária',async()=> {
    const result=await offer({scheduledAt:new Date(now.getTime()+60_000).toISOString(),expiresAt:new Date(now.getTime()+120_000).toISOString()});
    expect(evaluatePublication(result,settings(),[],now).reasons.join(' ')).toMatch(/agendado/);
    expect(evaluatePublication(result,settings(),[],new Date(now.getTime()+60_000)).allowed).toBe(true);
    expect(evaluatePublication(result,{...settings(),paused:true},[],new Date(now.getTime()+60_000)).allowed).toBe(false);
    expect(evaluatePublication(result,settings(),[],new Date(now.getTime()+120_000),{ignoreTemporary:true}).reasons.join(' ')).toMatch(/venceu/);
  });
  it('links conferidos pela proprietária exigem aprovação explícita e jamais entram no envio automático',async()=> {
    const affiliatePort:AffiliatePort={
      convert:async product=>({url:`${product.canonicalUrl}?tag=garimpos-20`,receiptId:'receipt-owner',method:'owner-reviewed',requiresManualApproval:true,reason:'Conferência da proprietária.'}),
      validate:()=>({valid:true,method:'owner-reviewed',reason:'Conferência da proprietária.'})
    };
    const [result]=await processPromotion(ingest(),settings(),{affiliatePort});
    expect(result.status).toBe('review');
    expect(evaluatePublication(result,settings(),[],now,{affiliatePort}).allowed).toBe(false);
    const approved={...result,status:'approved' as const,manuallyApprovedAt:now.toISOString()};
    expect(evaluatePublication(approved,settings(),[],now,{affiliatePort}).allowed).toBe(true);
    expect(evaluatePublication(approved,settings(),[],now,{affiliatePort,automatic:true,ignoreTemporary:true}).allowed).toBe(false);
  });
  it.each([second,`${original}?tag=outra-20`,'https://evil.example/product','http://evil.example/','ftp://evil.example/','www.evil.example','exemplo.рф','192.168.1.1/path'])('recusa endereço extra na mensagem final: %s',async extra=> {
    const result=await offer();
    expect(evaluatePublication({...result,rewrittenText:`${result.rewrittenText}\n${extra}`},settings(),[],now).allowed).toBe(false);
  });
  it('exige link afiliado na própria mensagem e admite edição apenas textual',async()=> {
    const result=await offer();
    expect(evaluatePublication({...result,rewrittenText:'Sem link'},settings(),[],now).allowed).toBe(false);
    expect(evaluatePublication({...result,rewrittenText:`Seleção especial\n${result.affiliateUrl}`},settings(),[],now).allowed).toBe(true);
  });
});

describe('score explicável e feedback conservador',()=> {
  it('limita score, conserva soma dos fatores e responde ao perfil',()=> {
    const parsed=parseOffer(offerText());const config=settings();
    const high=scoreOffer(parsed,config,{affiliateValid:true,productKey:'new'});
    config.audience.weights.casa=0;
    const low=scoreOffer(parsed,config,{affiliateValid:true,productKey:'new'});
    expect(high.score).toBeGreaterThan(low.score);
    expect(high.factors.reduce((sum,factor)=>sum+factor.points,0)).toBe(high.score);
    expect(high.score).toBeGreaterThanOrEqual(0);expect(high.score).toBeLessThanOrEqual(100);
    expect(high.factors.some(item=>item.label.includes('comissão'))).toBe(false);
  });
  it('compara somente preço confiável de histórico real',async()=> {
    const baseline=await offer({price:400,confidence:.9});
    const parsed=parseOffer(offerText());const config=settings();
    const lower=scoreOffer(parsed,config,{history:[baseline],productKey:baseline.productKey});
    expect(lower.factors.some(item=>item.label.includes('abaixo do menor'))).toBe(true);
    for (const prior of [{...baseline,simulation:true},{...baseline,confidence:.5},{...baseline,status:'failed' as const}]) {
      const score=scoreOffer(parsed,config,{history:[prior],productKey:baseline.productKey});
      expect(score.factors.some(item=>item.label.includes('abaixo do menor'))).toBe(false);
    }
  });
  it('requer três avaliações reais, usa última ação e ignora edição, simulação e órfãos',async()=> {
    const base=await offer();const parsed=parseOffer(offerText());const config=settings();
    const history=Array.from({length:20},(_,index)=>({...base,id:`o-${index}`}));
    const feedback:Feedback[]=history.map((item,index)=>({id:`f-${index}`,offerId:item.id,action:'approve',category:'casa',reason:'',createdAt:now.toISOString()}));
    const rank=(items:Feedback[],offers=history)=>scoreOffer(parsed,config,{history:offers,feedback:items,sourceId:base.sourceId});
    const adjustment=(items:Feedback[],offers=history)=>rank(items,offers).factors.find(item=>item.label.includes('Feedback'))?.points ?? 0;
    expect(adjustment(feedback.slice(0,2))).toBe(0);
    expect(adjustment(feedback)).toBeGreaterThan(0);expect(adjustment(feedback)).toBeLessThanOrEqual(5);
    expect(adjustment(feedback.map(item=>({...item,action:'reject'})))).toBeLessThan(0);
    expect(adjustment(feedback.map(item=>({...item,action:'edit'})))).toBe(0);
    expect(adjustment(feedback,history.map(item=>({...item,simulation:true})))).toBe(0);
    expect(adjustment(feedback,[])).toBe(0);
    const latest=feedback.map(item=>({...item,id:`${item.id}-latest`,action:'reject' as const,createdAt:'2026-10-18T15:01:00.000Z'}));
    expect(adjustment([...feedback,...latest])).toBeLessThan(0);
  });
});

describe('aviso de uso do WhatsApp e ritmo de envio', () => {
  const base = (): Settings => settings();

  it('sem aceite do aviso nada é publicado, nem com tudo o mais liberado', async () => {
    const pending = { ...settings(), riskNotice: { version: 0, acceptedAt: null } };
    expect(riskNoticeAccepted(defaultSettings())).toBe(false);
    const approved = { ...(await offer()), status: 'approved' as const };
    expect(evaluatePublication(approved, pending, [], now).reasons.join(' ')).toMatch(/número alternativo/);
    expect(riskNoticeAccepted(base())).toBe(true);
    expect(riskNoticeAccepted({ ...base(), riskNotice: { version: RISK_NOTICE_VERSION - 1, acceptedAt: now.toISOString() } })).toBe(false);
  });

  it('classifica o ritmo e exige assumir o risco de um ritmo alto', () => {
    expect(sendingPaceRisk({ maxPostsPerHour: 4, minIntervalMinutes: 15 })).toBe('low');
    expect(sendingPaceRisk({ maxPostsPerHour: 12, minIntervalMinutes: 3 })).toBe('moderate');
    expect(sendingPaceRisk({ maxPostsPerHour: 30, minIntervalMinutes: 1 })).toBe('high');
    const fast = { ...base(), maxPostsPerHour: 30, minIntervalMinutes: 1 };
    expect(paceRiskCovered(fast)).toBe(false);
    const accepted = { ...fast, paceRiskAccepted: { maxPostsPerHour: 30, minIntervalMinutes: 1, acceptedAt: now.toISOString() } };
    expect(paceRiskCovered(accepted)).toBe(true);
    // O aceite cobre aquele ritmo ou um mais calmo, nunca um mais agressivo.
    expect(paceRiskCovered({ ...accepted, paceRiskAccepted: { maxPostsPerHour: 20, minIntervalMinutes: 1, acceptedAt: now.toISOString() } })).toBe(false);
  });

  it('a variação aleatória só aumenta o intervalo, dentro do limite escolhido, e é estável', () => {
    const settings = { ...base(), minIntervalMinutes: 10, intervalJitterPercent: 30 };
    const last = now.getTime();
    const wait = effectiveIntervalMs(settings, last);
    expect(wait).toBeGreaterThanOrEqual(600_000);
    expect(wait).toBeLessThanOrEqual(780_000);
    expect(effectiveIntervalMs(settings, last)).toBe(wait);
    expect(effectiveIntervalMs({ ...settings, intervalJitterPercent: 0 }, last)).toBe(600_000);
  });
});
