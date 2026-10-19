import { createHash, randomUUID } from 'node:crypto';
import { buildAffiliateLink, identifyProduct, getIntegrationStatuses, validateAffiliateLink } from '../../../packages/affiliate-adapters/src/index.ts';
import { parseSecureUrl, supportedHost } from '../../../packages/affiliate-adapters/src/common.ts';
import { defaultProviders, type OfficialAffiliateProvider, type OfficialAffiliateResult } from '../../../packages/affiliate-adapters/src/providers/index.ts';
import { platformIds, platformNames, type IntegrationStatus, type Offer, type PlatformId, type Product, type Settings, type Validation } from '../../../packages/shared/src/index.ts';
import type { AffiliateConversion, AffiliateMethod, AffiliatePort, AffiliateReceipt, ApprovedLink, CredentialStatus } from '../../../packages/shared/src/features.ts';
import { getIntegrationGuides } from '../../../packages/shared/src/integration-guides.ts';
import { SecretVault } from './secret-vault.ts';
export { getIntegrationGuides } from '../../../packages/shared/src/integration-guides.ts';

interface RecordDatabase {
  putRecord(namespace:string,id:string,value:unknown):void;
  getRecord<T>(namespace:string,id:string):T|undefined;
  listRecords<T>(namespace:string):T[];
  deleteRecord(namespace:string,id:string):void;
}
interface Signed {signature:string;}
interface StoredLink extends ApprovedLink,Signed {}
interface StoredReceipt extends AffiliateReceipt,Signed {libraryId?:string;}
interface ConnectionProof extends Signed {platform:PlatformId;configFingerprint:string;credentialRevision:string;testedAt:string;expiresAt:string;}
export interface AffiliateServiceOptions {
  database:RecordDatabase; vault:SecretVault; getSettings:()=>Settings;
  resolveUrl?:(url:string)=>Promise<string>;
  providers?:Partial<Record<PlatformId,OfficialAffiliateProvider>>;
  fetch?:typeof fetch; now?:()=>number;
}
const RECEIPTS='affiliate-receipts'; const LINKS='affiliate-links'; const CONNECTIONS='affiliate-connections';
const DAY=24*60*60*1000;
function stable(value:unknown):string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value==='object') return `{${Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,entry])=>`${JSON.stringify(key)}:${stable(entry)}`).join(',')}}`;
  return JSON.stringify(value);
}
function failure(reason:string):Validation {return {valid:false,reason,method:'blocked'};}
function sameProduct(value:Product|null,expected:Product):boolean { return Boolean(value && value.platform===expected.platform && value.productKey===expected.productKey && value.productId===expected.productId); }
const redirectKeys=new Set(['redirect','redirect_url','redirect_uri','target','target_url','url','url_to']);

/** Exact official output URLs are stored verbatim; they are never visited to generate a click. */
export class AffiliateService implements AffiliatePort {
  #database:RecordDatabase; #vault:SecretVault; #getSettings:()=>Settings;
  #resolveUrl?:AffiliateServiceOptions['resolveUrl']; #providers:Partial<Record<PlatformId,OfficialAffiliateProvider>>;
  #fetch?:typeof fetch; #now:()=>number;
  constructor(options:AffiliateServiceOptions) {
    this.#database=options.database; this.#vault=options.vault; this.#getSettings=options.getSettings;
    this.#resolveUrl=options.resolveUrl; this.#providers=options.providers ?? defaultProviders;
    this.#fetch=options.fetch; this.#now=options.now ?? Date.now;
  }
  #assertPlatform(platform:PlatformId):void {if (!platformIds.includes(platform)) throw new Error('Loja inválida.');}
  #fingerprint(platform:PlatformId):string {return createHash('sha256').update(stable({platform,config:this.#getSettings().affiliates[platform]})).digest('hex');}
  #sign<T extends object>(value:T):T&Signed {return {...value,signature:this.#vault.signReceipt(stable(value))};}
  #authenticates(value:unknown):boolean {
    if (!value || typeof value!=='object' || !('signature' in value) || typeof value.signature!=='string') return false;
    const {signature,...payload}=value;
    return this.#vault.verifyReceipt(stable(payload),signature);
  }
  #currentProduct(product:Product):Product {
    if (!platformIds.includes(product.platform) || !sameProduct(identifyProduct(product.canonicalUrl),product)) throw new Error('O produto informado não possui uma identidade válida e inequívoca.');
    return product;
  }
  async #identifyOriginal(input:string,platform:PlatformId):Promise<Product> {
    if (typeof input!=='string' || input.length>4096 || !parseSecureUrl(input)) throw new Error('Informe uma URL HTTPS válida do produto original.');
    let identified=identifyProduct(input);
    if (!identified && this.#resolveUrl) {
      // Only the original product link can be expanded. Never resolve the affiliate output URL.
      const resolved=await this.#resolveUrl(input);
      identified=identifyProduct(resolved);
    }
    if (!identified || identified.platform!==platform) throw new Error('O link original precisa identificar um produto específico da loja selecionada. Use a URL direta do produto.');
    return this.#currentProduct(identified);
  }
  #checkOutput(platform:PlatformId,product:Product,input:string):void {
    if (typeof input!=='string' || input.length>4096) throw new Error('O link afiliado informado é inválido.');
    const url=parseSecureUrl(input);
    if (!url || [...url.searchParams.keys()].some(key=>redirectKeys.has(key.toLowerCase()))) throw new Error('Use o link HTTPS completo gerado oficialmente para este produto, sem redirecionamento adicional.');
    const identified=identifyProduct(input);
    if (identified) {
      if (!sameProduct(identified,product)) throw new Error('O link afiliado aponta para outro produto ou marketplace.');
      if (platform==='amazon') {
        const configured=this.#getSettings().affiliates.amazon.publicId;
        if (configured && (url.searchParams.getAll('tag').length!==1 || url.searchParams.get('tag')!==configured)) throw new Error('A tag do link Amazon não corresponde à tag configurada.');
      }
      if (platform==='magalu') {
        const configured=this.#getSettings().affiliates.magalu.publicId.trim().toLowerCase();
        if (configured && supportedHost(url,['magazinevoce.com.br','influenciadormagalu.com.br'])) {
          const store=url.pathname.split('/').filter(Boolean)[0]?.toLowerCase();
          if (store!==configured) throw new Error('O link Magalu pertence a uma loja diferente do identificador público configurado.');
        }
      }
      return;
    }
    const path=url.pathname;
    const opaque:Record<PlatformId,boolean>={
      amazon:(supportedHost(url,['amzn.to']) && /^\/[a-zA-Z0-9_-]{2,200}\/?$/.test(path)) || (url.hostname==='a.co' && /^\/d\/[a-zA-Z0-9_-]{2,200}\/?$/.test(path)),
      shopee:supportedHost(url,['s.shopee.com.br','shope.ee']) && /^\/[a-zA-Z0-9_-]{2,200}\/?$/.test(path),
      mercadolivre:(url.hostname==='mercadolivre.com' || supportedHost(url,['mercadolivre.com.br'])) && /^\/sec\/[a-zA-Z0-9_-]{2,200}\/?$/.test(path),
      magalu:false,
      aliexpress:(url.hostname==='s.click.aliexpress.com' && /^\/e\/[a-zA-Z0-9_-]{2,200}\/?$/.test(path)) || (url.hostname==='a.aliexpress.com' && /^\/[a-zA-Z0-9_-]{2,200}\/?$/.test(path)),
      shein:url.hostname==='onelink.shein.com' && /^\/[a-zA-Z0-9_-]{1,30}\/[a-zA-Z0-9_-]{2,200}\/?$/.test(path),
      temu:supportedHost(url,['temu.com']) && /^\/(?:k|t)\/[a-zA-Z0-9_-]{2,200}\/?$/.test(path)
    };
    if (!opaque[platform]) throw new Error('Esse endereço não é um produto reconhecido nem um formato de link curto oficial permitido. Não use páginas iniciais, campanhas, buscas ou cupons.');
  }
  #validConnection(platform:PlatformId):boolean {
    const proof=this.#database.getRecord<ConnectionProof>(CONNECTIONS,platform);
    if (!proof || !this.#authenticates(proof)) return false;
    const time=this.#now();
    return proof.platform===platform && proof.configFingerprint===this.#fingerprint(platform) && proof.credentialRevision===this.#vault.status(platform).revision && Boolean(proof.credentialRevision) && Number.isFinite(Date.parse(proof.testedAt)) && Date.parse(proof.testedAt)<=time+60_000 && Date.parse(proof.expiresAt)>time;
  }
  #record(product:Product,url:string,method:AffiliateMethod,source:AffiliateReceipt['source'],libraryId?:string):AffiliateConversion {
    const requiresManualApproval=method==='owner-reviewed';
    const receipt:Omit<StoredReceipt,'signature'>={id:randomUUID(),platform:product.platform,productKey:product.productKey,url,method,createdAt:new Date(this.#now()).toISOString(),expiresAt:new Date(this.#now()+DAY).toISOString(),configFingerprint:this.#fingerprint(product.platform),credentialRevision:this.#vault.status(product.platform).revision,requiresManualApproval,ownerConfirmed:requiresManualApproval,source,...(libraryId ? {libraryId} : {})};
    this.#database.putRecord(RECEIPTS,receipt.id,this.#sign(receipt));
    return {url,receiptId:receipt.id,method,requiresManualApproval,expiresAt:receipt.expiresAt,reason:requiresManualApproval ? 'Link oficial informado pela titular para este produto. Titularidade declarada; exige aprovação manual nesta oferta e não comprova comissão.' : method==='amazon-tag' ? 'Mesmo produto e tag Amazon configurada. Verificação estrutural, sem comprovação de titularidade ou comissão.' : 'Resposta autenticada da API vinculada ao produto e à configuração local. Comissão depende das regras da loja.'};
  }
  #fromLibrary(product:Product):AffiliateConversion|null {
    const link=this.#database.listRecords<StoredLink>(LINKS).filter(value=>value.platform===product.platform && value.productKey===product.productKey && value.ownerConfirmed===true && this.#authenticates(value)).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt))[0];
    if (!link) return null;
    this.#checkOutput(product.platform,product,link.affiliateUrl);
    return this.#record(product,link.affiliateUrl,'owner-reviewed','library',link.id);
  }

  async convert(input:Product):Promise<AffiliateConversion> {
    const product=this.#currentProduct(input); const config=this.#getSettings().affiliates[product.platform];
    if (!config.enabled) throw new Error('Habilite esta loja em Afiliados antes de converter.');
    const provider=this.#providers[product.platform];
    if (provider && this.#vault.status(product.platform).configured && this.#validConnection(product.platform)) {
      const fingerprint=this.#fingerprint(product.platform);
      const revision=this.#vault.status(product.platform).revision;
      let result:OfficialAffiliateResult;
      try {result=await provider.convert({product,config:structuredClone(config),credentials:this.#vault.get(product.platform)!,...(this.#fetch ? {fetch:this.#fetch} : {}),now:this.#now});}
      catch {
        if (fingerprint!==this.#fingerprint(product.platform) || revision!==this.#vault.status(product.platform).revision || !this.#validConnection(product.platform)) throw new Error('A conta ou a conexão mudou durante a conversão. Teste a conexão novamente e reprocesse a oferta.');
        const manual=this.#fromLibrary(product);
        if (manual) return manual;
        throw new Error('A API oficial não confirmou o link deste produto. Confira permissões, credenciais e o teste de conexão; ou importe o link oficial pela biblioteca.');
      }
      if (fingerprint!==this.#fingerprint(product.platform) || revision!==this.#vault.status(product.platform).revision || !this.#validConnection(product.platform)) throw new Error('A conta ou a conexão mudou durante a conversão. Teste a conexão novamente e reprocesse a oferta.');
      if (result.source!==product.platform) throw new Error('A API retornou uma origem de afiliação incompatível.');
      this.#checkOutput(product.platform,product,result.url);
      return this.#record(product,result.url,'official-api',result.source);
    }
    if (product.platform==='amazon') {
      const url=buildAffiliateLink(product,config);
      if (url && validateAffiliateLink(url,product,config).valid) return this.#record(product,url,'amazon-tag','amazon');
    }
    const manual=this.#fromLibrary(product);
    if (manual) return manual;
    throw new Error(provider && this.#vault.status(product.platform).configured ? 'Teste a conexão desta loja com um produto antes de usar a API. Você também pode importar o link oficial desse produto na biblioteca.' : 'Abra o gerador oficial da loja e importe o link deste produto na biblioteca. Cada envio exige aprovação manual.');
  }

  validate(receiptId:string|undefined|null,input:Product,url:string):Validation {
    try {
      const product=this.#currentProduct(input);
      if (!this.#getSettings().affiliates[product.platform].enabled) return failure('Integração desabilitada.');
      if (!receiptId) return failure('Recibo local de afiliação ausente. Reprocesse a oferta.');
      const receipt=this.#database.getRecord<StoredReceipt>(RECEIPTS,receiptId);
      if (!receipt || !this.#authenticates(receipt)) return failure('Recibo local ausente ou alterado. Reprocesse a oferta.');
      if (receipt.id!==receiptId || receipt.platform!==product.platform || receipt.productKey!==product.productKey || receipt.url!==url) return failure('O recibo não corresponde exatamente ao produto e ao link desta oferta.');
      const time=this.#now();
      if (!Number.isFinite(Date.parse(receipt.createdAt)) || Date.parse(receipt.createdAt)>time+60_000 || !Number.isFinite(Date.parse(receipt.expiresAt)) || Date.parse(receipt.expiresAt)<=time) return failure('O recibo de afiliação expirou. Reprocesse a oferta.');
      if (receipt.configFingerprint!==this.#fingerprint(product.platform) || receipt.credentialRevision!==this.#vault.status(product.platform).revision) return failure('A configuração da conta mudou. Reprocesse a oferta para gerar um novo recibo.');
      this.#checkOutput(product.platform,product,url);
      if (receipt.method==='amazon-tag') {
        if (receipt.platform!=='amazon' || receipt.source!=='amazon' || receipt.requiresManualApproval) return failure('Mecanismo de afiliação incompatível.');
        return validateAffiliateLink(url,product,this.#getSettings().affiliates.amazon);
      }
      if (receipt.method==='official-api') {
        if (receipt.requiresManualApproval || receipt.ownerConfirmed || receipt.source!==product.platform || !['amazon','shopee','aliexpress'].includes(receipt.source)) return failure('Mecanismo de API incompatível.');
        return {valid:true,method:'official-api',reason:'Recibo íntegro de resposta autenticada da API para o mesmo produto, conta e URL. Comissão não verificada.'};
      }
      if (receipt.method==='owner-reviewed' && receipt.source==='library' && receipt.ownerConfirmed===true && receipt.requiresManualApproval===true && receipt.libraryId) {
        const link=this.#database.getRecord<StoredLink>(LINKS,receipt.libraryId);
        if (!link || !this.#authenticates(link) || link.productKey!==product.productKey || link.platform!==product.platform || link.affiliateUrl!==url || !link.ownerConfirmed) return failure('O link manual foi removido ou alterado na biblioteca. Importe novamente e reprocesse.');
        return {valid:true,method:'owner-reviewed',reason:'Par exato de produto e link confirmado pela titular. Exige aprovação manual por oferta; não autoriza envio automático nem comprova comissão.'};
      }
      return failure('Mecanismo de afiliação desconhecido.');
    } catch {return failure('A identidade, as credenciais locais ou o link de afiliação precisam ser reconfigurados.');}
  }
  validateOffer(offer:Offer,_settings?:Settings):Validation {
    if (!offer.platform || !offer.productId) return failure('Produto não identificado.');
    return this.validate(offer.affiliateReceiptId,{platform:offer.platform,productId:offer.productId,productKey:offer.productKey,canonicalUrl:offer.canonicalUrl},offer.affiliateUrl ?? '');
  }
  listLinks(platform?:PlatformId):ApprovedLink[] {
    if (platform) this.#assertPlatform(platform);
    return this.#database.listRecords<StoredLink>(LINKS).filter(value=>(!platform || value.platform===platform) && this.#authenticates(value)).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)).map(({signature:_signature,...value})=>value);
  }
  async importLink(input:{platform:PlatformId;originalUrl:string;affiliateUrl:string;title?:string;ownerConfirmed:true}):Promise<ApprovedLink> {
    this.#assertPlatform(input.platform);
    if (input.ownerConfirmed!==true) throw new Error('Confirme que o link foi gerado na sua conta oficial para este mesmo produto.');
    const product=await this.#identifyOriginal(input.originalUrl,input.platform);
    this.#checkOutput(input.platform,product,input.affiliateUrl);
    if (input.title!==undefined && (typeof input.title!=='string' || input.title.length>1000)) throw new Error('O título pode ter até 1.000 caracteres.');
    // Preserve non-default seller selection even though the legacy product adapter canonicalizes the offer.
    if (input.platform==='magalu') {
      const originalSeller=new URL(input.originalUrl).searchParams.get('seller_id');
      const affiliateSeller=new URL(input.affiliateUrl).searchParams.get('seller_id');
      if (originalSeller && affiliateSeller!==originalSeller) throw new Error('Preserve o mesmo vendedor no link Magalu original e afiliado.');
    }
    const previous=this.listLinks(input.platform).find(link=>link.productKey===product.productKey && link.affiliateUrl===input.affiliateUrl);
    const timestamp=new Date(this.#now()).toISOString();
    const value:ApprovedLink={id:previous?.id ?? randomUUID(),platform:input.platform,productKey:product.productKey,originalUrl:input.originalUrl,affiliateUrl:input.affiliateUrl,title:input.title?.trim() ?? '',ownerConfirmed:true,createdAt:previous?.createdAt ?? timestamp,updatedAt:timestamp};
    this.#database.putRecord(LINKS,value.id,this.#sign(value));
    return value;
  }
  removeLink(id:string):void {this.#database.deleteRecord(LINKS,id);}
  credentialStatuses():CredentialStatus[] {return platformIds.map(platform=>this.#vault.status(platform));}
  saveCredentials(platform:PlatformId,values:Record<string,string>):CredentialStatus {
    this.#assertPlatform(platform);
    const guide=getIntegrationGuides().find(value=>value.platform===platform)!;
    if (!guide.fields.length) throw new Error('Esta loja usa o gerador oficial e a biblioteca por produto; não informe senha ou token de vendedor.');
    if (!values || typeof values!=='object' || Array.isArray(values)) throw new Error('Informe os campos da conexão.');
    const allowed=new Set(guide.fields.map(field=>field.key));
    if (Object.keys(values).some(key=>!allowed.has(key))) throw new Error('Campo de credencial não reconhecido para esta loja.');
    for (const field of guide.fields) if (field.required && (typeof values[field.key]!=='string' || !values[field.key].trim())) throw new Error(`Preencha ${field.label}.`);
    const clean=Object.fromEntries(Object.entries(values).filter(([,value])=>typeof value==='string' && value.trim()));
    const status=this.#vault.set(platform,clean);
    this.#database.deleteRecord(CONNECTIONS,platform);
    return status;
  }
  removeCredentials(platform:PlatformId):void {this.#assertPlatform(platform);this.#vault.remove(platform);this.#database.deleteRecord(CONNECTIONS,platform);}
  async testConnection(platform:PlatformId,options:{originalUrl?:string}={}):Promise<{valid:boolean;reason:string}> {
    this.#assertPlatform(platform);
    this.#database.deleteRecord(CONNECTIONS,platform);
    const provider=this.#providers[platform];
    if (!provider) return {valid:false,reason:'Esta loja usa links do gerador oficial por produto. Importe na biblioteca e aprove cada oferta manualmente.'};
    const config=this.#getSettings().affiliates[platform];
    if (!config.enabled) return {valid:false,reason:'Habilite a loja e salve a configuração antes de testar a conexão.'};
    if (!this.#vault.status(platform).configured) return {valid:false,reason:'Salve as credenciais locais da API antes de testar.'};
    const fingerprint=this.#fingerprint(platform); const revision=this.#vault.status(platform).revision;
    let product:Product;
    try {product=await this.#identifyOriginal(options.originalUrl || config.originalUrl,platform);}
    catch {return {valid:false,reason:'Informe a URL direta de um produto desta loja para testar autenticação e geração para o mesmo produto.'};}
    try {
      const result=await provider.convert({product,config:structuredClone(config),credentials:this.#vault.get(platform)!,...(this.#fetch ? {fetch:this.#fetch} : {}),now:this.#now});
      if (result.source!==platform) throw new Error();
      this.#checkOutput(platform,product,result.url);
      if (fingerprint!==this.#fingerprint(platform) || revision!==this.#vault.status(platform).revision) return {valid:false,reason:'A conta mudou durante o teste. Execute o teste novamente.'};
      const proof={platform,configFingerprint:fingerprint,credentialRevision:revision,testedAt:new Date(this.#now()).toISOString(),expiresAt:new Date(this.#now()+DAY).toISOString()};
      this.#database.putRecord(CONNECTIONS,platform,this.#sign(proof));
      return {valid:true,reason:'A API autenticou e retornou um link para o produto testado. Novos produtos serão consultados individualmente; isso não comprova comissão.'};
    } catch {return {valid:false,reason:'Não foi possível confirmar este produto na API oficial. Confira no guia o contrato da aplicação, acesso regional, campos e permissões. Nenhuma conta ou comissão foi marcada como validada.'};}
  }
  statuses():IntegrationStatus[] {
    const settings=this.#getSettings(); const legacy=getIntegrationStatuses(settings);
    return platformIds.map(id=>{
      if (!settings.affiliates[id].enabled) return {id,name:platformNames[id],state:'not_configured',reason:'Habilite a loja para usar a conexão ou os links da biblioteca.'};
      try {
        if (this.#validConnection(id)) return {id,name:platformNames[id],state:'ready',reason:'API oficial testada nesta configuração. Cada produto exige uma nova resposta autenticada; comissão não verificada.'};
        if (id==='amazon' && legacy.find(value=>value.id===id)?.state==='ready') return legacy.find(value=>value.id===id)!;
        const count=this.listLinks(id).length;
        if (count) return {id,name:platformNames[id],state:'ready',reason:`Somente revisão manual: ${count} produto(s) na biblioteca. Cada oferta exige aprovação explícita; titularidade declarada e comissão não verificada.`};
        if (this.#vault.status(id).configured) return {id,name:platformNames[id],state:'needs_calibration',reason:'Credenciais salvas localmente. Teste a conexão com um produto após salvar a configuração; salvar chaves não valida a conta.'};
      } catch {return {id,name:platformNames[id],state:'degraded',reason:'Reconfigure as credenciais locais desta loja antes de continuar.'};}
      return {id,name:platformNames[id],state:'needs_calibration',reason:'Use Conectar conta quando disponível ou importe um link do gerador oficial para este produto.'};
    });
  }
}
