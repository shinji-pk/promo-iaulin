import type { StoreAdapter } from '../common.ts';
import { product, supportedHost } from '../common.ts';

export const shein: StoreAdapter = {
  id:'shein', matches:url=>supportedHost(url,['shein.com']),
  identify(url) {
    if (!this.matches(url)) return null;
    const match = url.pathname.match(/(?:^|[-/])p-(\d{4,25})\.html(?:\/|$)/i);
    if (!match) return null;
    for (const key of ['goods_id','product_id']) {
      const ids=url.searchParams.getAll(key);
      if (ids.length>1 || (ids[0] && ids[0]!==match[1])) return null;
    }
    const hostLocale=url.hostname.match(/^([a-z]{2})\.shein\.com$/)?.[1];
    const pathLocale=url.pathname.match(/^\/([a-z]{2})\//)?.[1];
    if (hostLocale && pathLocale && hostLocale!==pathLocale) return null;
    const locale=hostLocale ?? pathLocale ?? 'global';
    const result=product('shein',match[1],`https://${locale==='global' ? 'www' : locale}.shein.com/p-${match[1]}.html`);
    return locale==='br' ? result : {...result,productKey:`shein:${locale}:${match[1]}`};
  }
};
