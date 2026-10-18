import { platformIds, platformNames, type AffiliateConfig, type IntegrationStatus, type PlatformId, type Product, type Settings, type Validation } from '../../shared/src/index.ts';
import { parseSecureUrl } from './common.ts';
import { amazon } from './stores/amazon.ts';
import { shopee } from './stores/shopee.ts';
import { mercadolivre } from './stores/mercadolivre.ts';
import { magalu } from './stores/magalu.ts';
import { aliexpress } from './stores/aliexpress.ts';
import { shein } from './stores/shein.ts';
import { temu } from './stores/temu.ts';

export const adapters = [amazon,shopee,mercadolivre,magalu,aliexpress,shein,temu];

export function identifyPlatform(input: string): PlatformId | null {
  const url = parseSecureUrl(input);
  return url ? adapters.find(adapter=>adapter.matches(url))?.id ?? null : null;
}

export function identifyProduct(input: string): Product | null {
  const url = parseSecureUrl(input);
  return url ? adapters.find(adapter=>adapter.matches(url))?.identify(url) ?? null : null;
}

function failure(reason: string): Validation { return {valid:false,reason,method:'blocked'}; }

/** Validate a documented affiliate mechanism independently of generation. */
function validateAmazonTag(input: string, expected: Product, publicId: string): Validation {
  const url = parseSecureUrl(input);
  const identified = identifyProduct(input);
  if (!url || !identified || identified.productKey !== expected.productKey) return failure('O link afiliado não identifica exatamente o mesmo produto e marketplace.');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9-]{0,96}-\d{2}$/.test(publicId)) return failure('Informe uma tag pública Amazon válida (por exemplo, sua-tag-20).');
  if (url.searchParams.getAll('tag').length !== 1 || url.searchParams.get('tag') !== publicId) return failure('A tag Amazon do link não corresponde à tag pública configurada.');
  // Unknown parameters can change the redirect target or attribution; generated links use tag only.
  const allowed = new Set(['tag','linkCode','linkId','camp','creative','creativeASIN','ref_','th','psc']);
  if ([...url.searchParams.keys()].some(key=>!allowed.has(key))) return failure('Parâmetros não reconhecidos no link Amazon; use o link direto do produto com a tag.');
  return {valid:true,reason:'Mesmo ASIN e marketplace; tag Amazon corresponde à configuração. Verificação estrutural, sem comprovação de titularidade ou comissão.',method:'amazon-product-tag'};
}

export function validateCalibration(platform: PlatformId, config: AffiliateConfig): Validation {
  if (!config.enabled) return failure('Integração desabilitada.');
  if (!config.originalUrl || !config.affiliateUrl) return failure('Calibre com um link original e um link afiliado do mesmo produto.');
  const original = identifyProduct(config.originalUrl);
  if (!original || original.platform !== platform) return failure('O link original precisa identificar um produto dessa loja. Expanda links curtos antes de calibrar.');
  if (platform !== 'amazon') return failure('Identificação disponível; geração e prova de afiliação oficial ainda não implementadas para esta loja. Links opacos ou assinados exigem integração oficial.');
  return validateAmazonTag(config.affiliateUrl, original, config.publicId);
}

export async function calibrateAffiliate(platform: PlatformId, config: AffiliateConfig): Promise<{valid:boolean;reason:string}> {
  const validation = validateCalibration(platform, config);
  return {valid:validation.valid,reason:validation.reason};
}

export function hasCompletedCalibration(config: AffiliateConfig): boolean {
  return Boolean(config.verifiedAt && Number.isFinite(Date.parse(config.verifiedAt)) && Date.parse(config.verifiedAt) <= Date.now()+60_000);
}

function calibratedMarketplace(product: Product, config: AffiliateConfig): Validation {
  const calibration = validateCalibration(product.platform, config);
  if (!calibration.valid) return calibration;
  const original = identifyProduct(config.originalUrl);
  if (!original || new URL(original.canonicalUrl).hostname !== new URL(product.canonicalUrl).hostname) {
    return failure('A calibração é válida somente para o marketplace Amazon do par de links informado. Calibre este país antes de publicar.');
  }
  return calibration;
}

export function buildAffiliateLink(product: Product, config: AffiliateConfig): string | null {
  if (!hasCompletedCalibration(config) || product.platform !== 'amazon') return null;
  const canonical = identifyProduct(product.canonicalUrl);
  if (!canonical || canonical.productKey !== product.productKey || canonical.productId !== product.productId || !calibratedMarketplace(canonical, config).valid) return null;
  const url = new URL(canonical.canonicalUrl);
  url.searchParams.set('tag', config.publicId);
  return url.toString();
}

export function validateAffiliateLink(input: string, product: Product, config: AffiliateConfig): Validation {
  if (!hasCompletedCalibration(config)) return failure('Conclua a calibração no painel antes de publicar.');
  const canonical = identifyProduct(product.canonicalUrl);
  if (!canonical || canonical.productKey !== product.productKey || canonical.productId !== product.productId) return failure('Identidade do produto inválida.');
  const calibration = calibratedMarketplace(canonical, config);
  if (!calibration.valid) return calibration;
  if (product.platform !== 'amazon') return failure('Mecanismo de afiliação ainda não suportado.');
  return validateAmazonTag(input, product, config.publicId);
}

export function getIntegrationStatuses(settings: Settings): IntegrationStatus[] {
  return platformIds.map(id=>{
    const config = settings.affiliates[id];
    if (!config.enabled) return {id,name:platformNames[id],state:'not_configured',reason:'Habilite e calibre a loja para começar.'};
    const validation = validateCalibration(id, config);
    if (validation.valid && hasCompletedCalibration(config)) return {id,name:platformNames[id],state:'ready',reason:validation.reason};
    if (validation.valid) return {id,name:platformNames[id],state:'needs_calibration',reason:'Par de URLs compatível. Execute a calibração no painel antes de publicar.'};
    return {id,name:platformNames[id],state:id === 'amazon' ? 'needs_calibration' : 'blocked',reason:validation.reason};
  });
}
