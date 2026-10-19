import type { StoreAdapter } from '../common.ts';
import { product, supportedHost } from '../common.ts';

export const aliexpress: StoreAdapter = {
  id:'aliexpress', matches:url=>supportedHost(url,['aliexpress.com']),
  identify(url) {
    if (!this.matches(url)) return null;
    const match = url.pathname.match(/\/item\/(\d{5,25})\.html(?:\/|$)/i);
    if (!match) return null;
    return product('aliexpress', match[1], `https://www.aliexpress.com/item/${match[1]}.html`);
  }
};
