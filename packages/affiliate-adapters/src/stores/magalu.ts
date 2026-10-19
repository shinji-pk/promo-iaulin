import type { StoreAdapter } from '../common.ts';
import { product, supportedHost } from '../common.ts';

export const magalu: StoreAdapter = {
  id:'magalu', matches:url=>supportedHost(url,['magazineluiza.com.br','magalu.com']),
  identify(url) {
    if (!this.matches(url)) return null;
    const match = url.pathname.match(/\/p\/([a-z0-9]{5,30})(?:\/|$)/i);
    if (!match) return null;
    return product('magalu', match[1].toLowerCase(), `https://www.magazineluiza.com.br/p/${match[1].toLowerCase()}/`);
  }
};
