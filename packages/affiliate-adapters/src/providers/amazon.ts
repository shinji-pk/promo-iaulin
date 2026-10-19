import { amazon } from '../stores/amazon.ts';
import { credential, record, requestJson, requireProduct, returnedUrl } from './http.ts';
import type { OfficialAffiliateProvider } from './types.ts';

const tokenEndpoints: Record<string, string> = {
  '3.1': 'https://api.amazon.com/auth/o2/token',
  '3.2': 'https://api.amazon.co.uk/auth/o2/token',
  '3.3': 'https://api.amazon.co.jp/auth/o2/token'
};
const languages: Record<string, string> = {
  'www.amazon.com.br': 'pt_BR', 'www.amazon.com': 'en_US', 'www.amazon.co.uk': 'en_GB',
  'www.amazon.ca': 'en_CA', 'www.amazon.de': 'de_DE', 'www.amazon.fr': 'fr_FR',
  'www.amazon.es': 'es_ES', 'www.amazon.it': 'it_IT', 'www.amazon.co.jp': 'ja_JP',
  'www.amazon.com.mx': 'es_MX', 'www.amazon.com.au': 'en_AU', 'www.amazon.in': 'en_IN'
};
const allowedParameters = new Set(['tag', 'linkCode', 'linkId', 'camp', 'creative', 'creativeASIN', 'ref_', 'th', 'psc', 'language']);

export const amazonCreatorsProvider: OfficialAffiliateProvider = {
  async convert(context) {
    const product = requireProduct(context, url => amazon.identify(url));
    const credentialId = credential(context, 'credentialId', 'o Credential ID da Amazon');
    const secret = credential(context, 'credentialSecret', 'o Secret da Amazon');
    const version = credential(context, 'credentialVersion', 'a Version da credencial Amazon');
    const endpoint = tokenEndpoints[version];
    if (!endpoint) throw new Error('Versão de credencial Amazon não suportada. Use 3.1, 3.2 ou 3.3 conforme a aplicação da conta.');
    const tag = context.config.publicId;
    if (!/^[a-zA-Z0-9][a-zA-Z0-9-]{0,96}-\d{2}$/.test(tag)) throw new Error('Informe a tag pública Amazon válida da sua conta.');
    const marketplace = new URL(product.canonicalUrl).hostname;
    const auth = await requestJson(context, endpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'client_credentials', client_id: credentialId, client_secret: secret, scope: 'creatorsapi::default' })
    });
    const token = auth.access_token;
    if (typeof token !== 'string' || !token || token.length > 16_384 || /\s/.test(token) || (auth.token_type !== undefined && String(auth.token_type).toLowerCase() !== 'bearer')) {
      throw new Error('A Amazon não retornou um token de acesso válido. Confira a credencial e as permissões.');
    }
    const response = await requestJson(context, 'https://creatorsapi.amazon/catalog/v1/getItems', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'x-marketplace': marketplace },
      body: JSON.stringify({ itemIds: [product.productId], itemIdType: 'ASIN', marketplace, partnerTag: tag, resources: ['itemInfo.title', 'images.primary.large', 'offersV2.listings.price', 'offersV2.listings.availability'] })
    });
    const containers = [record(response.itemsResult), record(response.itemResults)];
    for (const container of containers) {
      const items = container?.items;
      if (!Array.isArray(items)) continue;
      for (const candidate of items) {
        const item = record(candidate);
        if (item?.asin !== product.productId) continue;
        const url = returnedUrl(item.detailPageURL);
        const identified = url ? amazon.identify(url) : null;
        if (!url || !identified || identified.productKey !== product.productKey || ![marketplace, marketplace.replace(/^www\./, '')].includes(url.hostname)) continue;
        if (!new RegExp(`^/dp/${product.productId}/?$`).test(url.pathname)) continue;
        if (url.searchParams.getAll('tag').length !== 1 || url.searchParams.get('tag') !== tag) continue;
        if ([...url.searchParams.keys()].some(key => !allowedParameters.has(key))) continue;
        if (url.searchParams.has('language') && (url.searchParams.getAll('language').length !== 1 || url.searchParams.get('language') !== languages[marketplace])) continue;
        return { url: item.detailPageURL as string, source: 'amazon', reason: 'Creators API respondeu para o mesmo ASIN, marketplace e tag configurada. A resposta não garante comissão ou venda futura.' };
      }
    }
    throw new Error('A Amazon não retornou um link do mesmo produto, marketplace e tag. Confira disponibilidade e permissões.');
  }
};
