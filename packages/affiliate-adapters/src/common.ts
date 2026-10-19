import type { PlatformId, Product } from '../../shared/src/index.ts';

export interface StoreAdapter {
  id: PlatformId;
  matches(url: URL): boolean;
  identify(url: URL): Product | null;
}

export function parseSecureUrl(input: string): URL | null {
  try {
    const url = new URL(input);
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) return null;
    // eslint-disable-next-line no-control-regex -- Reject control characters before URL normalization can hide them.
    if (url.hostname.endsWith('.') || /[\u0000-\u0020\u007f\\]/.test(input)) return null;
    return url;
  } catch { return null; }
}

export function belongsTo(host: string, roots: string[]): boolean {
  return roots.some(root => host === root || host.endsWith(`.${root}`));
}

export function product(platform: PlatformId, productId: string, canonicalUrl: string): Product {
  return { platform, productId, productKey: `${platform}:${productId}`, canonicalUrl };
}

export function supportedHost(url: URL, roots: string[]): boolean {
  return belongsTo(url.hostname.toLowerCase(), roots);
}
