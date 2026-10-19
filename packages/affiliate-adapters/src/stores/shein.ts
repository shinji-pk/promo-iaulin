import type { StoreAdapter } from '../common.ts';
import { product, supportedHost } from '../common.ts';

export const shein: StoreAdapter = {
  id:'shein', matches:url=>supportedHost(url,['shein.com']),
  identify(url) {
    if (!this.matches(url)) return null;
    const match = url.pathname.match(/(?:^|[-/])p-(\d{4,25})\.html(?:\/|$)/i);
    if (!match) return null;
    return product('shein', match[1], `https://br.shein.com/p-${match[1]}.html`);
  }
};
