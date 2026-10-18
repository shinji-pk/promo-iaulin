import type { StoreAdapter } from '../common.ts';
import { product, supportedHost } from '../common.ts';

export const shopee: StoreAdapter = {
  id:'shopee', matches:url=>supportedHost(url,['shopee.com.br']),
  identify(url) {
    if (!this.matches(url)) return null;
    const match = url.pathname.match(/(?:-i\.|\/product\/)(\d{1,20})[/.](\d{1,20})(?:\/|$)/i);
    if (!match) return null;
    return product('shopee', `${match[1]}.${match[2]}`, `https://shopee.com.br/product/${match[1]}/${match[2]}`);
  }
};
