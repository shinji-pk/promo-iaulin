import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Database } from '../packages/db/src/index.ts';
import { defaultSettings, platformIds, type PlatformId, type Product } from '../packages/shared/src/index.ts';
import type { AffiliateReceipt } from '../packages/shared/src/features.ts';
import { identifyProduct, validateAffiliateLink } from '../packages/affiliate-adapters/src/index.ts';
import type { ProviderContext } from '../packages/affiliate-adapters/src/providers/index.ts';
import { AffiliateService, getIntegrationGuides } from '../apps/worker/src/affiliates.ts';
import { SecretVault } from '../apps/worker/src/secret-vault.ts';

const originals:Record<PlatformId,string>={
  amazon:'https://www.amazon.com.br/dp/B09B8VGCR8',
  shopee:'https://shopee.com.br/product/123/456',
  mercadolivre:'https://www.mercadolivre.com.br/p/MLB12345678',
  magalu:'https://www.magazineluiza.com.br/p/238218200/',
  aliexpress:'https://www.aliexpress.com/item/1005005899513913.html',
  shein:'https://br.shein.com/p-14567890.html',
  temu:'https://www.temu.com/goods.html?goods_id=601099512345678'
};
const links:Record<PlatformId,string>={
  amazon:`${originals.amazon}?tag=minha-tag-20`,shopee:'https://s.shopee.com.br/abc12345',
  mercadolivre:'https://mercadolivre.com/sec/abc12345',
  magalu:'https://www.magazinevoce.com.br/magazinelojateste/produto/p/238218200/',
  aliexpress:'https://s.click.aliexpress.com/e/_abc12345',
  shein:'https://onelink.shein.com/3/abc12345',
  temu:`${originals.temu}&_oak_scene=affiliate`
};
let database:Database;let vault:SecretVault;let settings=defaultSettings();let service:AffiliateService;let time=Date.parse('2026-10-18T15:00:00Z');
beforeEach(()=>{
  database=new Database(':memory:');vault=new SecretVault({memory:true});settings=defaultSettings();time=Date.parse('2026-10-18T15:00:00Z');
  for (const id of platformIds) settings.affiliates[id].enabled=true;
  settings.affiliates.amazon.publicId='minha-tag-20';
  service=new AffiliateService({database,vault,getSettings:()=>settings,now:()=>time});
});
afterEach(()=>database.close());
const product=(id:PlatformId):Product=>identifyProduct(originals[id])!;
const importPair=(id:PlatformId)=>service.importLink({platform:id,originalUrl:originals[id],affiliateUrl:links[id],ownerConfirmed:true,title:`Produto ${id}`});

async function connectAmazon():Promise<void> {
  service.saveCredentials('amazon',{credentialId:'id',credentialSecret:'secret',credentialVersion:'3.1'});
  expect((await service.testConnection('amazon',{originalUrl:originals.amazon})).valid).toBe(true);
}
function amazonFetch():typeof fetch {
  return vi.fn(async (input:RequestInfo|URL)=>{
    if (String(input)==='https://api.amazon.com/auth/o2/token') return new Response(JSON.stringify({access_token:'token-confidencial',expires_in:3600}),{status:200});
    if (String(input)==='https://creatorsapi.amazon/catalog/v1/getItems') return new Response(JSON.stringify({itemsResult:{items:[{asin:'B09B8VGCR8',detailPageURL:`${originals.amazon}?tag=minha-tag-20&language=pt_BR`}]}}),{status:200});
    throw new Error('Não deve visitar saída afiliada');
  }) as typeof fetch;
}

describe('biblioteca exata para as sete lojas',()=>{
  it.each(platformIds)('importa e reutiliza %s somente em revisão manual por produto',async id=>{
    const record=await importPair(id);const conversion=await service.convert(product(id));
    expect(record).toMatchObject({platform:id,productKey:product(id).productKey,originalUrl:originals[id],affiliateUrl:links[id],ownerConfirmed:true});
    expect(conversion).toMatchObject({url:links[id],method:'owner-reviewed',requiresManualApproval:true});
    expect(service.validate(conversion.receiptId,product(id),links[id])).toMatchObject({valid:true,method:'owner-reviewed'});
    expect(service.statuses().find(value=>value.id===id)).toMatchObject({state:'ready'});
    expect(service.statuses().find(value=>value.id===id)?.reason).toContain('Somente revisão manual');
    expect(service.listLinks(id)[0]).not.toHaveProperty('signature');
  });
  it('expande somente o original e nunca visita o link afiliado de saída',async()=>{
    const resolve=vi.fn(async()=>originals.shopee);const outboundFetch=vi.fn();
    service=new AffiliateService({database,vault,getSettings:()=>settings,resolveUrl:resolve,fetch:outboundFetch,now:()=>time});
    await service.importLink({platform:'shopee',originalUrl:'https://s.shopee.com.br/original123',affiliateUrl:links.shopee,ownerConfirmed:true});
    const result=await service.convert(product('shopee'));
    expect(service.validate(result.receiptId,product('shopee'),result.url).valid).toBe(true);
    expect(resolve.mock.calls).toEqual([['https://s.shopee.com.br/original123']]);expect(outboundFetch).not.toHaveBeenCalled();
  });
  it('não transforma um link de calibração em regra para outro produto',async()=>{
    await importPair('shopee');
    await expect(service.convert(identifyProduct('https://shopee.com.br/product/123/999')!)).rejects.toThrow('importe');
  });
  it('exige declaração explícita e mesmo produto, recusando campanha, host parecido e redirecionamento',async()=>{
    await expect(service.importLink({platform:'shopee',originalUrl:originals.shopee,affiliateUrl:links.shopee,ownerConfirmed:false as true})).rejects.toThrow('Confirme');
    for (const bad of ['https://shopee.com.br/product/123/999','https://shopee.com.br/campaign/test','https://shopee.com.br/search?keyword=panela','https://s.shopee.com.br.evil.example/abc12345','https://s.shopee.com.br/abc123?redirect=https://evil.example']) {
      await expect(service.importLink({platform:'shopee',originalUrl:originals.shopee,affiliateUrl:bad,ownerConfirmed:true})).rejects.toThrow();
    }
    await expect(service.importLink({platform:'amazon',originalUrl:originals.amazon,affiliateUrl:`${originals.amazon}?tag=outra-20`,ownerConfirmed:true})).rejects.toThrow('tag');
  });
  it('recusa alteração da loja Magalu e do vendedor original',async()=>{
    settings.affiliates.magalu.publicId='magazinelojateste';await importPair('magalu');
    await expect(service.importLink({platform:'magalu',originalUrl:originals.magalu,affiliateUrl:links.magalu.replace('magazinelojateste','magazineoutra'),ownerConfirmed:true})).rejects.toThrow('loja diferente');
    await expect(service.importLink({platform:'magalu',originalUrl:`${originals.magalu}?seller_id=lojafonte`,affiliateUrl:`${links.magalu}?seller_id=outravendedora`,ownerConfirmed:true})).rejects.toThrow();
    await expect(service.importLink({platform:'magalu',originalUrl:`${originals.magalu}?seller_id=lojafonte`,affiliateUrl:`${links.magalu}?seller_id=lojafonte`,ownerConfirmed:true})).resolves.toMatchObject({ownerConfirmed:true});
  });
  it('oculta biblioteca alterada e invalida recibos após exclusão do par exato',async()=>{
    const link=await importPair('shopee');const conversion=await service.convert(product('shopee'));
    service.removeLink(link.id);
    expect(service.validate(conversion.receiptId,product('shopee'),conversion.url).valid).toBe(false);
    await importPair('shopee');const stored=database.listRecords<Record<string,unknown>>('affiliate-links')[0];
    stored.affiliateUrl='https://s.shopee.com.br/tampered123';database.putRecord('affiliate-links',String(stored.id),stored);
    expect(service.listLinks('shopee')).toEqual([]);
    await expect(service.convert(product('shopee'))).rejects.toThrow();
  });
});

describe('recibos vinculados à conta e íntegros',()=>{
  it('bloqueia recibo ausente, de outro produto, outra URL ou produto forjado',async()=>{
    await importPair('shopee');const result=await service.convert(product('shopee'));
    expect(service.validate(undefined,product('shopee'),result.url).valid).toBe(false);
    expect(service.validate(result.receiptId,identifyProduct('https://shopee.com.br/product/123/999')!,result.url).valid).toBe(false);
    expect(service.validate(result.receiptId,product('shopee'),`${result.url}?edited=1`).valid).toBe(false);
    expect(service.validate(result.receiptId,{...product('shopee'),productId:'forjado'},result.url).valid).toBe(false);
  });
  it('recusa JSON adulterado mesmo quando o produto e URL aparentam coincidir',async()=>{
    await importPair('shopee');const result=await service.convert(product('shopee'));
    const stored=database.getRecord<AffiliateReceipt>('affiliate-receipts',result.receiptId)!;
    database.putRecord('affiliate-receipts',result.receiptId,{...stored,requiresManualApproval:false,method:'official-api',source:'shopee'});
    expect(service.validate(result.receiptId,product('shopee'),result.url)).toMatchObject({valid:false});
  });
  it('expira e invalida recibos quando a configuração ou revisão das credenciais muda',async()=>{
    await importPair('shopee');const initial=await service.convert(product('shopee'));
    settings.affiliates.shopee.publicId='conta-atualizada';
    expect(service.validate(initial.receiptId,product('shopee'),initial.url).valid).toBe(false);
    const second=await service.convert(product('shopee'));
    vault.set('shopee',{appId:'123',secret:'novo'});
    expect(service.validate(second.receiptId,product('shopee'),second.url).valid).toBe(false);
    const third=await service.convert(product('shopee'));time+=24*60*60*1000+1;
    expect(service.validate(third.receiptId,product('shopee'),third.url).reason).toContain('expirou');
  });
  it('não permite recibos assinados por outra instalação ou restaurados no backup',async()=>{
    await importPair('shopee');const result=await service.convert(product('shopee'));
    const another=new AffiliateService({database,vault:new SecretVault({memory:true}),getSettings:()=>settings,now:()=>time});
    expect(another.validate(result.receiptId,product('shopee'),result.url).valid).toBe(false);
    database.clearRecords('affiliate-receipts');
    expect(service.validate(result.receiptId,product('shopee'),result.url).valid).toBe(false);
  });
});

describe('conexões oficiais locais',()=>{
  it('salvar chaves retorna somente metadados e não marca integração validada',()=>{
    const saved=service.saveCredentials('amazon',{credentialId:'id',credentialSecret:'segredo-exclusivo',credentialVersion:'3.1'});
    expect(saved.configured).toBe(true);expect(JSON.stringify(saved)).not.toContain('segredo-exclusivo');
    expect(service.statuses().find(value=>value.id==='amazon')?.state).toBe('needs_calibration');
    expect(()=>service.saveCredentials('shein',{password:'nao'})).toThrow('gerador oficial');
    expect(()=>service.saveCredentials('amazon',{password:'nao'})).toThrow('não reconhecido');
    expect(()=>service.saveCredentials('amazon',{credentialId:'id'})).toThrow('Preencha');
  });
  it('realiza OAuth/GetItems pelo cliente real e gera recibo do produto sem abrir a saída',async()=>{
    const fetch=amazonFetch();service=new AffiliateService({database,vault,getSettings:()=>settings,fetch,now:()=>time});
    await connectAmazon();
    expect(service.statuses().find(value=>value.id==='amazon')?.state).toBe('ready');
    const result=await service.convert(product('amazon'));
    expect(result).toMatchObject({method:'official-api',requiresManualApproval:false,url:`${originals.amazon}?tag=minha-tag-20&language=pt_BR`});
    expect(service.validate(result.receiptId,product('amazon'),result.url)).toMatchObject({valid:true,method:'official-api'});
    expect(vi.mocked(fetch).mock.calls.every(([url])=>['https://api.amazon.com/auth/o2/token','https://creatorsapi.amazon/catalog/v1/getItems'].includes(String(url)))).toBe(true);
    expect(JSON.stringify(database.listRecords('affiliate-receipts'))).not.toContain('token-confidencial');
  });
  it('exige nova conexão quando conta muda e recusa resposta de outro produto',async()=>{
    const fetch=amazonFetch();service=new AffiliateService({database,vault,getSettings:()=>settings,fetch,now:()=>time});await connectAmazon();
    service.saveCredentials('amazon',{credentialId:'id2',credentialSecret:'secret2',credentialVersion:'3.1'});
    expect(service.statuses().find(value=>value.id==='amazon')?.state).toBe('needs_calibration');
    await expect(service.convert(product('amazon'))).rejects.toThrow('Teste a conexão');
    const wrongFetch=vi.fn(async (url:RequestInfo|URL)=>String(url).includes('/token') ? new Response(JSON.stringify({access_token:'token',expires_in:3600})) : new Response(JSON.stringify({itemsResult:{items:[{asin:'B0B1N5H7X2',detailPageURL:'https://www.amazon.com.br/dp/B0B1N5H7X2?tag=minha-tag-20'}]}}))) as typeof globalThis.fetch;
    service=new AffiliateService({database,vault,getSettings:()=>settings,fetch:wrongFetch,now:()=>time});
    expect((await service.testConnection('amazon',{originalUrl:originals.amazon})).valid).toBe(false);
    expect(service.statuses().find(value=>value.id==='amazon')?.state).toBe('needs_calibration');
  });
  it('expira o selo de conexão e sanitiza erros sem credenciais',async()=>{
    const fetch=amazonFetch();service=new AffiliateService({database,vault,getSettings:()=>settings,fetch,now:()=>time});await connectAmazon();
    time+=24*60*60*1000+1;
    expect(service.statuses().find(value=>value.id==='amazon')?.state).toBe('needs_calibration');
    const failing=new AffiliateService({database,vault,getSettings:()=>settings,providers:{amazon:{convert:async()=>{throw new Error('secret-do-provedor');}}},now:()=>time});
    const test=await failing.testConnection('amazon',{originalUrl:originals.amazon});
    expect(test.valid).toBe(false);expect(test.reason).not.toContain('secret-do-provedor');
  });
  it('mantém fallback Amazon estrutural sem chamá-lo API validada',async()=>{
    settings.affiliates.amazon.originalUrl=originals.amazon;settings.affiliates.amazon.affiliateUrl=links.amazon;settings.affiliates.amazon.verifiedAt=new Date(time).toISOString();
    const result=await service.convert(product('amazon'));
    expect(result).toMatchObject({method:'amazon-tag',requiresManualApproval:false});
    expect(service.validate(result.receiptId,product('amazon'),result.url).valid).toBe(true);
    expect(validateAffiliateLink(`${originals.amazon}?tag=minha-tag-20&language=pt_BR`,product('amazon'),settings.affiliates.amazon).valid).toBe(true);
    expect(validateAffiliateLink(`${originals.amazon}?tag=minha-tag-20&language=en_US`,product('amazon'),settings.affiliates.amazon).valid).toBe(false);
  });
  it.each(['configuração','credenciais','conexão'])('não emite recibo se %s mudar enquanto a API responde',async changed=>{
    let release:(()=>void)|undefined;
    let wait=false;
    const provider={convert:vi.fn(async()=>{
      if(wait) await new Promise<void>(resolve=>{release=resolve;});
      return {url:links.amazon,source:'amazon' as const,reason:'Fixture autenticada'};
    })};
    service=new AffiliateService({database,vault,getSettings:()=>settings,providers:{amazon:provider},now:()=>time});
    await connectAmazon();
    wait=true;
    const converting=service.convert(product('amazon'));
    expect(release).toEqual(expect.any(Function));
    if(changed==='configuração') settings.affiliates.amazon.publicId='outra-tag-20';
    else if(changed==='credenciais') service.saveCredentials('amazon',{credentialId:'outro-id',credentialSecret:'outro-secret',credentialVersion:'3.1'});
    else database.deleteRecord('affiliate-connections','amazon');
    release!();
    await expect(converting).rejects.toThrow('mudou durante a conversão');
    expect(database.listRecords('affiliate-receipts')).toEqual([]);
  });
  it('usa uma cópia da configuração e invalida teste que começou com outra conta',async()=>{
    let release:(()=>void)|undefined;
    let observedTag='';
    const provider={convert:vi.fn(async(context:ProviderContext)=>{
      await new Promise<void>(resolve=>{release=resolve;});
      observedTag=context.config.publicId;
      return {url:links.amazon,source:'amazon' as const,reason:'Fixture autenticada'};
    })};
    service=new AffiliateService({database,vault,getSettings:()=>settings,providers:{amazon:provider},now:()=>time});
    service.saveCredentials('amazon',{credentialId:'id',credentialSecret:'secret',credentialVersion:'3.1'});
    const testing=service.testConnection('amazon',{originalUrl:originals.amazon});
    await vi.waitFor(()=>expect(release).toEqual(expect.any(Function)));
    settings.affiliates.amazon.publicId='nova-tag-20';
    release!();
    expect((await testing).valid).toBe(false);
    expect(observedTag).toBe('minha-tag-20');
    expect(database.getRecord('affiliate-connections','amazon')).toBeUndefined();
  });
  it('permite resolver falha da API com um par exato da biblioteca, exigindo revisão manual',async()=>{
    const provider={convert:vi.fn(async()=>({url:links.amazon,source:'amazon' as const,reason:'Fixture autenticada'}))};
    service=new AffiliateService({database,vault,getSettings:()=>settings,providers:{amazon:provider},now:()=>time});
    await connectAmazon();
    await importPair('amazon');
    provider.convert.mockRejectedValueOnce(new Error('API indisponível com segredo privado'));
    const result=await service.convert(product('amazon'));
    expect(result).toMatchObject({url:links.amazon,method:'owner-reviewed',requiresManualApproval:true});
    expect(service.validate(result.receiptId,product('amazon'),result.url)).toMatchObject({valid:true,method:'owner-reviewed'});
    expect(JSON.stringify(result)).not.toContain('segredo privado');
  });
  it('oferece sete guias públicos de fonte oficial sem incluir segredos',()=>{
    const guides=getIntegrationGuides();expect(guides.map(value=>value.platform)).toEqual([...platformIds]);
    expect(guides.filter(value=>value.fields.length).map(value=>value.platform)).toEqual(['amazon','shopee','aliexpress']);
    guides[0].steps.length=0;expect(getIntegrationGuides()[0].steps.length).toBeGreaterThan(0);
  });
});

describe('identidades adicionais observadas nas lojas',()=>{
  it('separa anúncio, catálogo e user product no Mercado Livre',()=>{
    const user=identifyProduct('https://www.mercadolivre.com.br/produto/up/MLBU2321504314');
    expect(user?.productId).toBe('user:MLBU2321504314');
    expect(user?.productKey).not.toBe(identifyProduct('https://www.mercadolivre.com.br/p/MLB2321504314')?.productKey);
  });
  it('preserva país SHEIN e vendedor Magalu e recusa goods_id de campanha Temu',()=>{
    expect(identifyProduct('https://us.shein.com/p-14567890.html')?.productKey).not.toBe(product('shein').productKey);
    expect(identifyProduct('https://br.shein.com/p-14567890.html?product_id=99999')).toBeNull();
    expect(identifyProduct(`${originals.magalu}?seller_id=outro`)?.productKey).not.toBe(product('magalu').productKey);
    expect(identifyProduct('https://www.temu.com/br/coupon.html?goods_id=601099512345678')).toBeNull();
    expect(identifyProduct('https://www.influenciadormagalu.com.br/minhaloja/produto/p/238218200/')?.productKey).toBe(product('magalu').productKey);
  });
});
