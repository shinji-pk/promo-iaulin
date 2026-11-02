import express from 'express';
import { describe, expect, it } from 'vitest';
import { runExpress } from '../apps/cloud/src/fetch-to-express.ts';
import { createCloudApp } from '../apps/cloud/src/app.ts';

describe('Express on Cloudflare (fetch bridge)', () => {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.get('/api/v1/ping', (req, res) => { res.cookie('a', '1', { httpOnly: true }); res.append('Set-Cookie', 'b=2'); res.json({ ok: true, ip: req.ip, secure: req.secure, q: req.query.x }); });
  app.post('/api/v1/echo', (req, res) => res.status(201).json({ body: req.body, json: req.is('application/json') }));
  app.get('/api/v1/fail', () => { throw new Error('boom'); });
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => { void error; res.status(500).json({ error: 'handled' }); });
  const call = (path: string, init?: RequestInit) => runExpress(app as never, new Request('https://promo.example' + path, init));

  it('serves JSON, cookies and query strings', async () => {
    const response = await call('/api/v1/ping?x=7', { headers: { 'cf-connecting-ip': '203.0.113.9' } });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, q: '7', secure: true });
    expect(response.headers.getSetCookie().length).toBe(2);
  });

  it('parses JSON bodies with express.json', async () => {
    const response = await call('/api/v1/echo', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ a: 1 }) });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ body: { a: 1 }, json: 'application/json' });
  });

  it('runs error handlers and answers 404 for unknown routes', async () => {
    expect((await call('/api/v1/fail')).status).toBe(500);
    expect((await call('/api/v1/missing')).status).toBe(404);
  });

  it('serves the real Promo cloud app public route', async () => {
    const response = await runExpress(createCloudApp() as never, new Request('https://promo.example/api/v1/account/capabilities'));
    expect(response.status).toBe(200);
    expect(await response.json()).toHaveProperty('passwordRecovery');
  });
});
