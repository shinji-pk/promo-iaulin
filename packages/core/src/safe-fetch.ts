import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import type { ClientRequest } from 'node:http';
import { isIP } from 'node:net';
import { isPublicAddress, pinnedLookup, validateUrl, type ResolvedAddress, type ResolverRequest } from './resolver.ts';

export interface SafeFetchResult { status: number; url: string; contentType: string; body: Buffer; etag: string | null; lastModified: string | null; }
export interface SafeFetchOptions {
  timeoutMs?: number; maxBytes?: number; maxRedirects?: number;
  lookup?: (hostname: string) => Promise<ResolvedAddress[]>;
  request?: ResolverRequest;
  /** Content types accepted from the server; anything else is refused before reading the body. */
  accept?: RegExp;
}

const redirects = new Set([301, 302, 303, 307, 308]);

/**
 * Downloads a small public HTTPS document (e.g. an RSS feed) with the same SSRF policy as the
 * link resolver: DNS checked and pinned on every hop, private networks refused, bounded size
 * and time, no cookies, no credentials and no compression bombs.
 */
export function createSafeFetcher(options: SafeFetchOptions = {}) {
  const timeoutMs = options.timeoutMs ?? 10_000, maxBytes = options.maxBytes ?? 1_500_000, maxRedirects = options.maxRedirects ?? 4;
  const accept = options.accept ?? /^(application\/(rss|atom|rdf|xml)(\+xml)?|text\/xml|application\/xml)$/i;
  const lookup = options.lookup ?? (async (hostname: string) => (await dnsLookup(hostname, { all: true, verbatim: true })).map(address => ({ address: address.address, family: address.family as 4 | 6 })));
  const request = options.request ?? ((url, requestOptions, callback) => httpsRequest(url, requestOptions, callback));
  return async (value: string, conditional: { etag?: string | null; lastModified?: string | null } = {}): Promise<SafeFetchResult> => {
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(new Error('Tempo limite excedido.')), timeoutMs);
    try {
      let url = validateUrl(value, 2048);
      for (let hop = 0; ; hop++) {
        const hostname = url.hostname.replace(/^\[|\]$/g, '');
        const family = isIP(hostname);
        const addresses = family ? [{ address: hostname, family: family as 4 | 6 }] : await lookup(hostname);
        if (!addresses.length || addresses.some(address => isIP(address.address) !== address.family || !isPublicAddress(address.address))) throw new Error('Endereço não público bloqueado.');
        const result = await new Promise<SafeFetchResult & { location?: string }>((resolve, reject) => {
          let req: ClientRequest | undefined;
          const onAbort = () => { req?.destroy(); reject(controller.signal.reason instanceof Error ? controller.signal.reason : new Error('Cancelado.')); };
          if (controller.signal.aborted) { onAbort(); return; }
          controller.signal.addEventListener('abort', onAbort, { once: true });
          req = request(url, {
            method: 'GET', agent: false, rejectUnauthorized: true, family: addresses[0].family,
            lookup: pinnedLookup(hostname, addresses[0]), maxHeaderSize: 16_384,
            headers: {
              'user-agent': 'PromoIaulin-Curadoria/1 (+https://www.shinjiapps.com)', accept: 'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8',
              'accept-encoding': 'identity',
              ...(conditional.etag ? { 'if-none-match': conditional.etag } : {}),
              ...(conditional.lastModified ? { 'if-modified-since': conditional.lastModified } : {}),
            },
          }, response => {
            const status = response.statusCode ?? 0;
            const header = (name: string) => { const value = response.headers[name]; return typeof value === 'string' ? value.slice(0, 300) : null; };
            const done = (value: SafeFetchResult & { location?: string }) => { controller.signal.removeEventListener('abort', onAbort); resolve(value); };
            const fail = (error: Error) => { controller.signal.removeEventListener('abort', onAbort); response.destroy(); reject(error); };
            if (redirects.has(status) || status === 304) { response.resume(); done({ status, url: url.href, contentType: '', body: Buffer.alloc(0), etag: header('etag'), lastModified: header('last-modified'), location: header('location') ?? undefined }); return; }
            if (status < 200 || status >= 300) { response.resume(); fail(new Error(`A fonte respondeu com o status ${status}.`)); return; }
            if (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') { fail(new Error('A fonte enviou conteúdo comprimido não solicitado.')); return; }
            const contentType = String(response.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
            if (!accept.test(contentType)) { fail(new Error(`A fonte não é um feed RSS/Atom (tipo ${contentType || 'desconhecido'}).`)); return; }
            const declared = Number(response.headers['content-length']);
            if (Number.isFinite(declared) && declared > maxBytes) { fail(new Error('O feed é grande demais.')); return; }
            const chunks: Buffer[] = []; let size = 0;
            response.on('data', (chunk: Buffer) => { size += chunk.length; if (size > maxBytes) fail(new Error('O feed é grande demais.')); else chunks.push(chunk); });
            response.once('error', error => fail(error));
            response.once('end', () => { if (size <= maxBytes) done({ status, url: url.href, contentType, body: Buffer.concat(chunks), etag: header('etag'), lastModified: header('last-modified') }); });
          });
          req.once('error', error => { controller.signal.removeEventListener('abort', onAbort); reject(error); });
          req.end();
        });
        if (!redirects.has(result.status)) return result;
        if (!result.location || hop >= maxRedirects) throw new Error('Redirecionamentos demais ou sem destino.');
        url = validateUrl(new URL(result.location, url).href, 2048);
      }
    } finally { clearTimeout(deadline); }
  };
}
