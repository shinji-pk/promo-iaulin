import type { StoreAdapter } from '../common.ts';
import { product, supportedHost } from '../common.ts';

export const magalu: StoreAdapter = {
  id:'magalu', matches:url=>supportedHost(url,['magazineluiza.com.br','magalu.com','magazinevoce.com.br','influenciadormagalu.com.br']),
  identify(url) {
    if (!this.matches(url)) return null;
    const match = url.pathname.match(/\/p\/([a-z0-9]{5,30})(?:\/|$)/i);
    if (!match) return null;
    const sellerIds=url.searchParams.getAll('seller_id');
    if (sellerIds.length>1 || (sellerIds[0] && !/^[a-zA-Z0-9_-]{1,100}$/.test(sellerIds[0]))) return null;
    const id=match[1].toLowerCase();
    const result=product('magalu',id,`https://www.magazineluiza.com.br/p/${id}/`);
    if (sellerIds[0] && sellerIds[0]!=='magazineluiza') return {...result,productKey:`${result.productKey}:seller:${sellerIds[0]}`,canonicalUrl:`${result.canonicalUrl}?seller_id=${sellerIds[0]}`};
    return result;
  }
};
