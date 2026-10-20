import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('browser API JSON requests', () => {
  it('sends empty JSON for bodyless WhatsApp actions without adding a body to GET', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal('window', { location: { hostname: 'localhost' } });
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    vi.resetModules();

    const { api } = await import('../apps/web/src/api.ts');
    await api.post('/whatsapp/connect');
    await api.post('/whatsapp/reset');
    await api.get('/state');

    expect(calls.map(call => call.url)).toEqual(['/api/v1/whatsapp/connect', '/api/v1/whatsapp/reset', '/api/v1/state']);
    for (const call of calls.slice(0, 2)) {
      expect(call.init.method).toBe('POST');
      expect(call.init.body).toBe('{}');
      expect(call.init.headers).toMatchObject({ 'Content-Type': 'application/json' });
    }
    expect(calls[2].init.method).toBe('GET');
    expect(calls[2].init.body).toBeUndefined();
  });
});
