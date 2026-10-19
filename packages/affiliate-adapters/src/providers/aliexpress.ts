import { createHash } from 'node:crypto';
import { aliexpress } from '../stores/aliexpress.ts';
import { credential, record, requestJson, requireProduct, returnedUrl } from './http.ts';
import type { OfficialAffiliateProvider } from './types.ts';

export const aliexpressLegacyProvider: OfficialAffiliateProvider = {
  async convert(context) {
    if (context.credentials.legacyContractConfirmed !== 'true') throw new Error('A API TOP AliExpress é legada. Confirme no console que sua aplicação ainda usa esse contrato e gateway antes de ativá-la.');
    const product = requireProduct(context, url => aliexpress.identify(url));
    const appKey = credential(context, 'appKey', 'a App Key do AliExpress');
    const secret = credential(context, 'appSecret', 'o App Secret do AliExpress');
    const trackingId = credential(context, 'trackingId', 'o Tracking ID do AliExpress');
    const timestamp = new Date((context.now?.() ?? Date.now()) + 8 * 60 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ');
    const parameters: Record<string, string> = {
      app_key: appKey, format: 'json', method: 'aliexpress.affiliate.link.generate',
      promotion_link_type: '0', sign_method: 'md5', source_values: product.canonicalUrl,
      timestamp, tracking_id: trackingId, v: '2.0'
    };
    const input = Object.keys(parameters).sort().map(key => `${key}${parameters[key]}`).join('');
    parameters.sign = createHash('md5').update(`${secret}${input}${secret}`).digest('hex').toUpperCase();
    const response = await requestJson(context, 'https://eco.taobao.com/router/rest', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' }, body: new URLSearchParams(parameters).toString()
    });
    if (response.error_response !== undefined) throw new Error('O AliExpress recusou a solicitação. Confira permissões e compatibilidade do contrato legado.');
    const envelope = record(response.aliexpress_affiliate_link_generate_response);
    const returned = record(envelope?.resp_result);
    const result = record(returned?.result);
    if ((returned?.resp_code !== 200 && returned?.resp_code !== '200') || result?.tracking_id !== trackingId) {
      throw new Error('O AliExpress não confirmou sucesso e o Tracking ID solicitado. Confira permissões e compatibilidade do contrato legado.');
    }
    const links = record(result.promotion_links)?.promotion_link;
    if (Array.isArray(links)) {
      for (const candidate of links) {
        const link = record(candidate);
        const source = returnedUrl(link?.source_value);
        const sourceProduct = source ? aliexpress.identify(source) : null;
        if (!sourceProduct || sourceProduct.productKey !== product.productKey) continue;
        const url = returnedUrl(link?.promotion_link);
        const direct = url ? aliexpress.identify(url) : null;
        const short = url && url.hostname === 's.click.aliexpress.com' && /^\/e\/[a-zA-Z0-9_-]{1,256}\/?$/.test(url.pathname);
        if (!url || (direct ? direct.productKey !== product.productKey || !['aliexpress.com', 'www.aliexpress.com'].includes(url.hostname) : !short)) continue;
        return { url: link!.promotion_link as string, source: 'aliexpress', reason: 'Gateway TOP legado respondeu com o mesmo produto e Tracking ID. Compatibilidade declarada pelo operador; comissão depende das regras da conta.' };
      }
    }
    throw new Error('O AliExpress não retornou um link permitido ligado ao mesmo produto.');
  }
};
