import { EventEmitter } from 'node:events';
import type { ClientRequest, IncomingMessage } from 'node:http';
import type { RequestOptions } from 'node:https';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createUrlResolver, isPublicAddress, type ResolvedAddress, type ResolverRequest } from '../packages/core/src/resolver.ts';

const publicAddresses: ResolvedAddress[] = [{ address: '8.8.8.8', family: 4 }, { address: '2606:4700:4700::1111', family: 6 }];
interface Reply { status?: number; location?: string; rawHeaders?: string[]; error?: Error; delayMs?: number; pending?: boolean; }

function fakeNetwork(replies: Record<string, Reply>) {
  const requests: { url: URL; options: RequestOptions; destroy: ReturnType<typeof vi.fn>; pins: (string | ResolvedAddress[])[] }[] = [];
  const responses: { destroy: ReturnType<typeof vi.fn>; on: ReturnType<typeof vi.fn> }[] = [];
  const request: ResolverRequest = (url, options, onResponse) => {
    const reply = replies[url.href] ?? { status: 200 };
    const outgoing = new EventEmitter();
    let destroyed = false;
    const destroy = vi.fn(() => { destroyed = true; return outgoing; });
    const entry = { url, options, destroy, pins: [] as (string | ResolvedAddress[])[] };
    requests.push(entry);
    Object.assign(outgoing, {
      destroy,
      end: () => {
        // Exercise the exact lookup handed to Node's HTTPS transport twice: it must not re-resolve DNS.
        for (const all of [false, true]) options.lookup?.(url.hostname.replace(/^\[|\]$/g, ''), { all }, (error, address) => {
          if (error) throw error;
          entry.pins.push(address as string | ResolvedAddress[]);
        });
        const respond = () => {
          if (destroyed || reply.pending) return;
          if (reply.error) { outgoing.emit('error', reply.error); return; }
          const incoming = new EventEmitter();
          const responseDestroy = vi.fn(() => incoming);
          const on = vi.fn(incoming.on.bind(incoming));
          Object.assign(incoming, {
            statusCode: reply.status ?? 200,
            headers: reply.location === undefined ? {} : { location: reply.location },
            rawHeaders: reply.rawHeaders ?? (reply.location === undefined ? [] : ['Location', reply.location]),
            destroy: responseDestroy,
            on,
          });
          responses.push({ destroy: responseDestroy, on });
          onResponse(incoming as unknown as IncomingMessage);
        };
        if (reply.delayMs) setTimeout(respond, reply.delayMs);
        else queueMicrotask(respond);
      },
    });
    return outgoing as unknown as ClientRequest;
  };
  return { request, requests, responses };
}

afterEach(() => vi.useRealTimers());

describe('globally routable address policy', () => {
  it.each([
    '0.0.0.0', '10.0.0.1', '100.64.0.1', '100.127.255.255', '127.0.0.1',
    '169.254.169.254', '172.16.0.1', '172.31.255.255', '192.0.0.9', '192.0.2.1',
    '192.88.99.1', '192.168.0.1', '198.18.0.1', '198.19.255.255', '198.51.100.1',
    '203.0.113.1', '224.0.0.1', '255.255.255.255', '::', '::1', 'fc00::1',
    'fe80::1', 'fe80::1%eth0', 'ff02::1', '2001:db8::1', '2001::1', '2001:20::1',
    '2002:7f00:1::', '3fff::1', '64:ff9b::7f00:1', '::ffff:127.0.0.1',
    '::ffff:7f00:1', '::ffff:192.168.1.1', '::ffff:169.254.169.254', 'not-an-address',
  ])('blocks private, special-use or reserved address %s', address => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it.each(['8.8.8.8', '1.1.1.1', '100.128.0.1', '172.15.255.255', '172.32.0.0', '2606:4700:4700::1111', '2001:4860:4860::8888', '::ffff:8.8.8.8'])('allows public address %s', address => {
    expect(isPublicAddress(address)).toBe(true);
  });
});

describe('HTTPS redirect resolver', () => {
  it('follows relative and cross-host redirects and checks DNS on every hop', async () => {
    const network = fakeNetwork({
      'https://short.example.com/start': { status: 302, location: '/second' },
      'https://short.example.com/second': { status: 307, location: 'https://shop.example.com/product#details' },
    });
    const lookup = vi.fn(async () => publicAddresses);
    const resolve = createUrlResolver({ lookup, request: network.request });
    await expect(resolve('https://short.example.com/start')).resolves.toBe('https://shop.example.com/product');
    expect(lookup.mock.calls).toEqual([['short.example.com'], ['short.example.com'], ['shop.example.com']]);
    expect(network.requests).toHaveLength(3);
    expect(network.responses.every(response => response.destroy.mock.calls.length === 1)).toBe(true);
    expect(network.responses.every(response => response.on.mock.calls.every(([event]) => event !== 'data'))).toBe(true);
  });

  it('pins the validated address and retains TLS certificate verification', async () => {
    const network = fakeNetwork({});
    const lookup = vi.fn().mockResolvedValueOnce(publicAddresses).mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);
    await expect(createUrlResolver({ lookup, request: network.request })('https://shop.example.com/item')).resolves.toBe('https://shop.example.com/item');
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(network.requests[0].pins).toEqual(['8.8.8.8', [{ address: '8.8.8.8', family: 4 }]]);
    expect(network.requests[0].options).toMatchObject({ agent: false, rejectUnauthorized: true, family: 4, maxHeaderSize: 16384 });
  });

  it.each([
    'http://shop.example.com/product', 'https://shop.example.com:444/product',
    'https://user:password@shop.example.com/', 'https://user@shop.example.com/',
    'https://localhost/', 'https://a.local/', 'https://metadata.google.internal/',
    'https://a.home.arpa/', 'https://printer/', 'https://127.0.0.1/',
    'https://2130706433/', 'https://0x7f000001/', 'https://[::1]/',
    'https://[::ffff:127.0.0.1]/', 'https://shop.example.com/\npath',
    'https://shop.example.com\\@127.0.0.1/',
  ])('rejects unsafe initial URL without a network request: %s', async value => {
    const network = fakeNetwork({});
    const lookup = vi.fn(async () => publicAddresses);
    await expect(createUrlResolver({ lookup, request: network.request })(value)).rejects.toThrow();
    expect(lookup).not.toHaveBeenCalled();
    expect(network.requests).toHaveLength(0);
  });

  it('normalizes the HTTPS default port, trailing DNS dot and fragments', async () => {
    const network = fakeNetwork({});
    const lookup = vi.fn(async () => publicAddresses);
    await expect(createUrlResolver({ lookup, request: network.request })('https://SHOP.example.com.:443/item#details')).resolves.toBe('https://shop.example.com/item');
    expect(lookup).toHaveBeenCalledWith('shop.example.com');
  });

  it('supports public IP literals without relying on a second DNS lookup', async () => {
    const network = fakeNetwork({});
    const lookup = vi.fn(async () => publicAddresses);
    await expect(createUrlResolver({ lookup, request: network.request })('https://[2606:4700:4700::1111]/')).resolves.toBe('https://[2606:4700:4700::1111]/');
    expect(lookup).not.toHaveBeenCalled();
  });

  it.each(([
    [], [{ address: '127.0.0.1', family: 4 }],
    [...publicAddresses, { address: '192.168.1.5', family: 4 }],
    [...publicAddresses, { address: '::ffff:a9fe:a9fe', family: 6 }],
    [{ address: '8.8.8.8', family: 6 }],
  ] as ResolvedAddress[][]).map(addresses => ({ addresses })))('fails closed on empty, mixed or inconsistent DNS results %#', async ({ addresses }) => {
    const network = fakeNetwork({});
    const lookup = vi.fn(async () => addresses);
    await expect(createUrlResolver({ lookup, request: network.request })('https://shop.example.com/')).rejects.toThrow(/DNS/);
    expect(network.requests).toHaveLength(0);
  });

  it('fails closed on DNS errors', async () => {
    const network = fakeNetwork({});
    const lookup = vi.fn(async (): Promise<ResolvedAddress[]> => { throw new Error('DNS unavailable'); });
    await expect(createUrlResolver({ lookup, request: network.request })('https://shop.example.com/')).rejects.toThrow('DNS unavailable');
    expect(network.requests).toHaveLength(0);
  });

  it.each(['http://127.0.0.1/private', 'https://169.254.169.254/latest', 'https://[::ffff:7f00:1]/', 'https://a.local/', 'https://user:pass@shop.example.com/', 'https://shop.example.com:8443/'])('revalidates unsafe redirect target %s before connecting', async location => {
    const network = fakeNetwork({ 'https://short.example.com/': { status: 302, location } });
    const lookup = vi.fn(async () => publicAddresses);
    await expect(createUrlResolver({ lookup, request: network.request })('https://short.example.com/')).rejects.toThrow();
    expect(network.requests).toHaveLength(1);
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it('blocks a redirect whose hostname resolves to a private address', async () => {
    const network = fakeNetwork({ 'https://short.example.com/': { status: 302, location: 'https://rebind.example.com/admin' } });
    const lookup = vi.fn().mockResolvedValueOnce(publicAddresses).mockResolvedValue([{ address: '10.0.0.1', family: 4 }]);
    await expect(createUrlResolver({ lookup, request: network.request })('https://short.example.com/')).rejects.toThrow(/DNS/);
    expect(network.requests).toHaveLength(1);
  });

  it('rejects cycles and enforces a redirect limit before an extra connection', async () => {
    const network = fakeNetwork({
      'https://short.example.com/': { status: 301, location: '/two' },
      'https://short.example.com/two': { status: 302, location: '/' },
    });
    const resolve = createUrlResolver({ lookup: async () => publicAddresses, request: network.request });
    await expect(resolve('https://short.example.com/')).rejects.toThrow(/Ciclo/);
    expect(network.requests).toHaveLength(2);
    network.requests.length = 0;
    const bounded = createUrlResolver({ maxRedirects: 0, lookup: async () => publicAddresses, request: network.request });
    await expect(bounded('https://short.example.com/')).rejects.toThrow(/Limite/);
    expect(network.requests).toHaveLength(1);
  });

  it.each([{ status: 302 }, { status: 404 }, { status: 500 }, { status: 305 }])('rejects missing redirect locations and unsuccessful HTTP responses: %j', async reply => {
    const network = fakeNetwork({ 'https://short.example.com/': reply });
    await expect(createUrlResolver({ lookup: async () => publicAddresses, request: network.request })('https://short.example.com/')).rejects.toThrow();
  });

  it('bounds response headers and closes the stream without downloading a body', async () => {
    const network = fakeNetwork({ 'https://shop.example.com/': { rawHeaders: ['X-Huge', 'x'.repeat(512)] } });
    await expect(createUrlResolver({ maxHeaderBytes: 256, lookup: async () => publicAddresses, request: network.request })('https://shop.example.com/')).rejects.toThrow(/limite/);
    expect(network.requests[0].options.maxHeaderSize).toBe(256);
    expect(network.responses[0].destroy).toHaveBeenCalledOnce();
    expect(network.responses[0].on.mock.calls.some(([event]) => event === 'data')).toBe(false);
  });

  it('bounds URL and redirect Location lengths', async () => {
    const network = fakeNetwork({ 'https://shop.example.com/': { status: 302, location: `/${'x'.repeat(100)}` } });
    const resolve = createUrlResolver({ maxUrlLength: 80, lookup: async () => publicAddresses, request: network.request });
    await expect(resolve(`https://shop.example.com/${'x'.repeat(100)}`)).rejects.toThrow();
    expect(network.requests).toHaveLength(0);
    await expect(resolve('https://shop.example.com/')).rejects.toThrow();
    expect(network.requests).toHaveLength(1);
  });

  it('includes DNS in the total deadline and never connects after a late DNS result', async () => {
    vi.useFakeTimers();
    const network = fakeNetwork({});
    let release: ((value: ResolvedAddress[]) => void) | undefined;
    const lookup = vi.fn(() => new Promise<ResolvedAddress[]>(resolve => { release = resolve; }));
    const result = expect(createUrlResolver({ timeoutMs: 25, lookup, request: network.request })('https://shop.example.com/')).rejects.toThrow(/Tempo limite/);
    await vi.advanceTimersByTimeAsync(25);
    await result;
    release?.(publicAddresses);
    await Promise.resolve();
    expect(network.requests).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('uses one deadline across redirects and destroys an in-flight request on timeout', async () => {
    vi.useFakeTimers();
    const network = fakeNetwork({
      'https://short.example.com/': { status: 302, location: '/two', delayMs: 15 },
      'https://short.example.com/two': { delayMs: 15 },
    });
    const result = expect(createUrlResolver({ timeoutMs: 25, lookup: async () => publicAddresses, request: network.request })('https://short.example.com/')).rejects.toThrow(/Tempo limite/);
    await vi.advanceTimersByTimeAsync(25);
    await result;
    expect(network.requests).toHaveLength(2);
    expect(network.requests[1].destroy).toHaveBeenCalledOnce();
    await vi.runAllTimersAsync();
    expect(network.responses).toHaveLength(1);
  });

  it('propagates TLS and socket errors and removes its deadline', async () => {
    vi.useFakeTimers();
    const network = fakeNetwork({ 'https://shop.example.com/': { error: new Error('certificate expired') } });
    await expect(createUrlResolver({ lookup: async () => publicAddresses, request: network.request })('https://shop.example.com/')).rejects.toThrow('certificate expired');
    expect(vi.getTimerCount()).toBe(0);
  });
});
