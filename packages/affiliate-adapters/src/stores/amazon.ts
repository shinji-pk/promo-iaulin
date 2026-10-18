import type { StoreAdapter } from '../common.ts';
import { product, supportedHost } from '../common.ts';

const roots = ['amazon.com.br','amazon.com','amazon.co.uk','amazon.ca','amazon.de','amazon.fr','amazon.es','amazon.it','amazon.co.jp','amazon.com.mx','amazon.com.au','amazon.in'];
export const amazon: StoreAdapter = {
  id: 'amazon',
  matches: url => supportedHost(url, roots),
  identify(url) {
    if (!this.matches(url)) return null;
    const match = url.pathname.match(/\/(?:dp|gp\/product|gp\/aw\/d)\/([a-z0-9]{10})(?:\/|$)/i);
    if (!match) return null;
    const root = roots.find(domain => url.hostname === domain || url.hostname.endsWith(`.${domain}`));
    const asin = match[1].toUpperCase();
    // Marketplace is part of identity: a US calibration cannot silently authorize a BR item.
    return { ...product('amazon', asin, `https://www.${root}/dp/${asin}`), productKey:`amazon:${root}:${asin}` };
  }
};
