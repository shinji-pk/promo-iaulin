import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpsRequest, type RequestOptions } from 'node:https';
import type { ClientRequest, IncomingMessage } from 'node:http';
import { isIP, type LookupFunction } from 'node:net';

export interface ResolvedAddress { address: string; family: 4 | 6; }
export type ResolverRequest = (url: URL, options: RequestOptions, onResponse: (response: IncomingMessage) => void) => ClientRequest;
export interface ResolverOptions {
  /** One deadline covers DNS and every redirect, rather than restarting per hop. */
  timeoutMs?: number;
  maxRedirects?: number;
  maxHeaderBytes?: number;
  maxUrlLength?: number;
  lookup?: (hostname: string) => Promise<ResolvedAddress[]>;
  request?: ResolverRequest;
}

const redirectStatuses = new Set([301, 302, 303, 307, 308]);
const localSuffixes = ['localhost', 'local', 'localdomain', 'internal', 'intranet', 'lan', 'home', 'arpa', 'test', 'invalid', 'example', 'onion'];

function ipv4Number(address: string): number {
  return address.split('.').reduce((value, octet) => value * 256 + Number(octet), 0);
}

function inV4Range(value: number, network: string, prefix: number): boolean {
  const size = 2 ** (32 - prefix);
  return Math.floor(value / size) === Math.floor(ipv4Number(network) / size);
}

function isPublicIPv4(address: string): boolean {
  const value = ipv4Number(address);
  return !([
    ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
    ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
    ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
    ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
  ] as const).some(([network, prefix]) => inV4Range(value, network, prefix));
}

function ipv6Number(address: string): bigint {
  let expanded = address.toLowerCase();
  if (expanded.includes('.')) {
    const lastColon = expanded.lastIndexOf(':');
    const v4 = ipv4Number(expanded.slice(lastColon + 1));
    expanded = `${expanded.slice(0, lastColon)}:${Math.floor(v4 / 65536).toString(16)}:${(v4 % 65536).toString(16)}`;
  }
  const halves = expanded.split('::');
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves[1] ? halves[1].split(':') : [];
  const groups = halves.length === 2 ? [...left, ...Array<string>(8 - left.length - right.length).fill('0'), ...right] : left;
  return groups.reduce((value, group) => (value << 16n) + BigInt(`0x${group}`), 0n);
}

/** Accept globally routable unicast addresses only, including embedded IPv4 checks. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isPublicIPv4(address);
  if (family !== 6 || address.includes('%')) return false;
  const value = ipv6Number(address);
  if (value >> 32n === 0xffffn) {
    const embedded = Number(value & 0xffffffffn);
    return isPublicIPv4([24, 16, 8, 0].map(shift => (embedded >>> shift) & 255).join('.'));
  }
  // All non-global IPv6 space, plus special-use / transition and documentation ranges.
  if (value >> 125n !== 1n) return false;
  return !([
    ['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20],
  ] as const).some(([network, prefix]) => value >> BigInt(128 - prefix) === ipv6Number(network) >> BigInt(128 - prefix));
}

function validateUrl(value: string, maxLength: number): URL {
  // eslint-disable-next-line no-control-regex -- Reject control characters before URL parsing normalizes them.
  if (value.length > maxLength || /[\u0000-\u0020\u007f\\]/u.test(value)) throw new Error('URL inválida ou longa demais.');
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('URL inválida.'); }
  if (url.protocol !== 'https:' || (url.port && url.port !== '443') || url.username || url.password) {
    throw new Error('Somente HTTPS na porta 443, sem credenciais, é permitido.');
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (isIP(hostname)) {
    if (!isPublicAddress(hostname)) throw new Error('Endereço privado ou reservado bloqueado.');
  } else {
    if (!hostname.includes('.') || hostname.length > 253 || hostname.split('.').some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) ||
      localSuffixes.some(suffix => hostname === suffix || hostname.endsWith(`.${suffix}`))) {
      throw new Error('Hostname local ou inválido bloqueado.');
    }
    url.hostname = hostname;
  }
  url.hash = '';
  return url;
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

function pinnedLookup(hostname: string, address: ResolvedAddress): LookupFunction {
  return (requestedHost, options, callback) => {
    if (requestedHost.toLowerCase().replace(/\.$/, '') !== hostname) {
      callback(new Error('Hostname da conexão divergente.'), '');
      return;
    }
    if (options.all) callback(null, [address]);
    else callback(null, address.address, address.family);
  };
}

function readHeaders(url: URL, address: ResolvedAddress, signal: AbortSignal, request: ResolverRequest, maxHeaderBytes: number): Promise<{ status: number; location?: string }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let req: ClientRequest | undefined;
    const finish = (error?: Error, result?: { status: number; location?: string }) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else if (result) resolve(result);
    };
    const onAbort = () => {
      finish(signal.reason instanceof Error ? signal.reason : new Error('Resolução cancelada.'));
      req?.destroy();
    };
    if (signal.aborted) { onAbort(); return; }
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      req = request(url, {
        method: 'GET', agent: false, rejectUnauthorized: true, family: address.family,
        lookup: pinnedLookup(url.hostname.replace(/^\[|\]$/g, ''), address),
        maxHeaderSize: maxHeaderBytes,
        headers: { 'user-agent': 'PromoBridge/2 URL-Resolver', accept: 'text/html', 'accept-encoding': 'identity', range: 'bytes=0-0' },
      }, response => {
        // Redirect resolution needs headers only. Never buffer or process an external body.
        response.once('error', error => finish(error));
        const bytes = response.rawHeaders.reduce((sum, header) => sum + Buffer.byteLength(header) + 2, 0) + 64;
        if (bytes > maxHeaderBytes) finish(new Error('Cabeçalhos da resposta excedem o limite.'));
        else finish(undefined, { status: response.statusCode ?? 0, location: response.headers.location });
        response.destroy();
      });
      req.once('error', error => finish(error));
      req.end();
    } catch (error) {
      finish(error instanceof Error ? error : new Error('Falha na conexão HTTPS.'));
      req?.destroy();
    }
  });
}

/** Dependencies are injectable for offline security tests; production uses native TLS and DNS. */
export function createUrlResolver(options: ResolverOptions = {}): (value: string) => Promise<string> {
  const timeoutMs = options.timeoutMs ?? 8_000;
  const maxRedirects = options.maxRedirects ?? 5;
  const maxHeaderBytes = options.maxHeaderBytes ?? 16_384;
  const maxUrlLength = options.maxUrlLength ?? 4_096;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000 || !Number.isInteger(maxRedirects) || maxRedirects < 0 || maxRedirects > 20 ||
    !Number.isInteger(maxHeaderBytes) || maxHeaderBytes < 128 || maxHeaderBytes > 65_536 || !Number.isInteger(maxUrlLength) || maxUrlLength < 1 || maxUrlLength > 16_384) {
    throw new Error('Limites do resolvedor inválidos.');
  }
  const lookup: NonNullable<ResolverOptions['lookup']> = options.lookup ?? (async hostname =>
    (await dnsLookup(hostname, { all: true, verbatim: true })).map(address => ({ address: address.address, family: address.family as 4 | 6 })));
  const request = options.request ?? ((url, requestOptions, callback) => httpsRequest(url, requestOptions, callback));
  return async (value: string): Promise<string> => {
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(new Error('Tempo limite da resolução excedido.')), timeoutMs);
    const seen = new Set<string>();
    try {
      let url = validateUrl(value, maxUrlLength);
      for (let redirects = 0; ; redirects++) {
        if (seen.has(url.href)) throw new Error('Ciclo de redirecionamento bloqueado.');
        seen.add(url.href);
        const hostname = url.hostname.replace(/^\[|\]$/g, '');
        const family = isIP(hostname);
        const addresses = family ? [{ address: hostname, family: family as 4 | 6 }] : await abortable(lookup(hostname), controller.signal);
        if (!addresses.length || addresses.length > 64 || addresses.some(address => isIP(address.address) !== address.family || !isPublicAddress(address.address))) {
          throw new Error('DNS sem endereço público seguro; resolução bloqueada.');
        }
        const response = await readHeaders(url, addresses[0], controller.signal, request, maxHeaderBytes);
        if (!redirectStatuses.has(response.status)) {
          if (response.status < 200 || response.status >= 300) throw new Error(`Destino HTTPS respondeu com status ${response.status}.`);
          return url.href;
        }
        if (!response.location) throw new Error('Redirecionamento sem destino.');
        if (redirects >= maxRedirects) throw new Error('Limite de redirecionamentos excedido.');
        // Resolve relative Location values, then apply the complete policy before the next request.
        // eslint-disable-next-line no-control-regex -- Redirect targets need the same control-character defense as the initial URL.
        if (response.location.length > maxUrlLength || /[\u0000-\u0020\u007f\\]/u.test(response.location)) throw new Error('Destino do redirecionamento inválido.');
        url = validateUrl(new URL(response.location, url).href, maxUrlLength);
      }
    } finally {
      clearTimeout(deadline);
    }
  };
}

export const resolveUrl = createUrlResolver();
