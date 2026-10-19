import { createHash } from 'node:crypto';
import { shopee } from '../stores/shopee.ts';
import { credential, record, requestJson, requireProduct, returnedUrl } from './http.ts';
import type { OfficialAffiliateProvider } from './types.ts';

export const shopeeOfficialProvider: OfficialAffiliateProvider = {
  async convert(context) {
    if (context.credentials.contractConfirmed !== 'true') throw new Error('Confirme no Explorer autenticado da Shopee que o contrato de geração de links corresponde ao indicado no guia antes de ativar a API.');
    const product = requireProduct(context, url => shopee.identify(url));
    const appId = credential(context, 'appId', 'o App ID da Shopee');
    const secret = credential(context, 'secret', 'o Secret da Shopee');
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(appId)) throw new Error('O App ID da Shopee tem formato inválido.');
    const subIds = context.credentials.subIds?.trim() ? context.credentials.subIds.split(',').map(value => value.trim()) : ['promobridge', 'whatsapp'];
    if (subIds.length > 5 || subIds.some(value => !/^[a-zA-Z0-9_-]{1,50}$/.test(value))) throw new Error('Use até cinco subIDs Shopee separados por vírgula, com letras, números, traços ou sublinhados.');
    const body = JSON.stringify({ query: `mutation { generateShortLink(input: { originUrl: ${JSON.stringify(product.canonicalUrl)}, subIds: ${JSON.stringify(subIds)} }) { shortLink } }` });
    const timestamp = String(Math.floor((context.now?.() ?? Date.now()) / 1000));
    const signature = createHash('sha256').update(`${appId}${timestamp}${body}${secret}`).digest('hex');
    const response = await requestJson(context, 'https://open-api.affiliate.shopee.com.br/graphql', {
      method: 'POST', body, headers: { 'Content-Type': 'application/json', Authorization: `SHA256 Credential=${appId}, Timestamp=${timestamp}, Signature=${signature}` }
    });
    if (response.errors !== undefined && (!Array.isArray(response.errors) || response.errors.length > 0)) throw new Error('A Shopee recusou a geração do link. Confira o contrato, as permissões e o produto no Explorer da conta.');
    const generated = record(record(response.data)?.generateShortLink);
    const value = generated?.shortLink;
    const url = returnedUrl(value);
    const direct = url ? shopee.identify(url) : null;
    const short = url && ['s.shopee.com.br', 'shope.ee'].includes(url.hostname) && /^\/[a-zA-Z0-9_-]{3,256}\/?$/.test(url.pathname);
    if (!url || (direct ? direct.productKey !== product.productKey || !['shopee.com.br', 'www.shopee.com.br'].includes(url.hostname) : !short)) {
      throw new Error('A Shopee não retornou um link permitido para o produto solicitado.');
    }
    return { url: value as string, source: 'shopee', reason: 'API Shopee respondeu à geração solicitada para este produto. O contrato foi confirmado pelo operador; atribuição e comissão dependem da conta e das regras da loja.' };
  }
};
