import { describe, expect, it } from 'vitest';
import { parseServerUrl } from '../apps/cloud/src/worker-proxy.ts';

describe('own server address', () => {
  it('accepts a public HTTPS origin and trims a trailing slash', () => {
    expect(parseServerUrl('https://meu-promo.onrender.com/')).toBe('https://meu-promo.onrender.com');
  });
  it('rejects http, paths, credentials, ports and local names', () => {
    for (const bad of ['http://meu.site', 'https://meu.site/api', 'https://a:b@meu.site', 'https://meu.site:8443', 'https://localhost', 'https://nas.local', 'nada'])
      expect(() => parseServerUrl(bad)).toThrow();
  });
});
