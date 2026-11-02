import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';

type ExpressLike = (req: unknown, res: unknown, next: (error?: unknown) => void) => void;

/**
 * Runs the Express app for one Web Request without a Node HTTP server (Cloudflare Pages).
 * The request becomes a real Readable (so express.json works unchanged) and the response
 * collects headers and body into a Web Response. Express keeps all of its own logic.
 */
export async function runExpress(app: ExpressLike, request: Request, maxBody = 21 * 1024 * 1024): Promise<Response> {
  const url = new URL(request.url);
  const hasBody = !['GET', 'HEAD'].includes(request.method);
  const raw = hasBody ? Buffer.from(await request.arrayBuffer()) : Buffer.alloc(0);
  if (raw.length > maxBody) return Response.json({ error: 'Conteúdo maior que o limite permitido.' }, { status: 413 });

  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => { headers[key.toLowerCase()] = value; });
  delete headers['transfer-encoding'];
  if (hasBody) headers['content-length'] = String(raw.length);
  headers['x-forwarded-proto'] = url.protocol.replace(':', '');
  headers['x-forwarded-host'] ??= url.host;
  const ip = request.headers.get('cf-connecting-ip') ?? '';
  if (ip) headers['x-forwarded-for'] = ip;

  const socket = Object.assign(new EventEmitter(), { remoteAddress: ip, encrypted: url.protocol === 'https:', readable: true, writable: true });
  // autoDestroy off: after Express swaps the prototype, IncomingMessage._destroy expects Node internals.
  const req = new Readable({ read() {}, autoDestroy: false, emitClose: false }) as Readable & Record<string, unknown>;
  if (raw.length) req.push(raw);
  req.push(null);
  Object.assign(req, {
    method: request.method, url: url.pathname + url.search, headers, rawHeaders: Object.entries(headers).flat(),
    httpVersion: '1.1', httpVersionMajor: 1, httpVersionMinor: 1, socket, connection: socket,
  });

  return await new Promise<Response>((resolve, reject) => {
    const out = new Headers();
    const chunks: Buffer[] = [];
    let ended = false;
    const res: Record<string, unknown> & EventEmitter = Object.assign(new EventEmitter(), {
      statusCode: 200, statusMessage: '', headersSent: false, finished: false, writableEnded: false, locals: {},
      socket, connection: socket, req,
      setHeader(name: string, value: unknown) {
        out.delete(name);
        for (const item of ([] as unknown[]).concat(value)) out.append(name, String(item));
        return res;
      },
      getHeader(name: string) {
        if (name.toLowerCase() === 'set-cookie') { const all = out.getSetCookie(); return all.length ? all : undefined; }
        return out.get(name) ?? undefined;
      },
      getHeaders() { const all: Record<string, string | string[]> = {}; out.forEach((v, k) => { all[k] = k === 'set-cookie' ? out.getSetCookie() : v; }); return all; },
      getHeaderNames() { return [...out.keys()]; },
      hasHeader(name: string) { return out.has(name); },
      removeHeader(name: string) { out.delete(name); },
      writeHead(status: number, a?: unknown, b?: unknown) {
        res.statusCode = status;
        const extra = (typeof a === 'object' && a) || (typeof b === 'object' && b);
        if (extra) for (const [k, v] of Object.entries(extra as Record<string, unknown>)) (res.setHeader as (k: string, v: unknown) => void)(k, v);
        return res;
      },
      flushHeaders() {},
      write(chunk: unknown, encoding?: unknown) {
        if (chunk == null) return true;
        chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, (typeof encoding === 'string' ? encoding : 'utf8') as BufferEncoding) : Buffer.from(chunk as Uint8Array));
        return true;
      },
      end(chunk?: unknown, encoding?: unknown) {
        if (ended) return res;
        if (typeof chunk === 'function') chunk = undefined;
        if (chunk != null) (res.write as (c: unknown, e?: unknown) => boolean)(chunk, encoding);
        ended = true;
        Object.assign(res, { headersSent: true, finished: true, writableEnded: true });
        const status = Number(res.statusCode) || 200;
        const empty = [101, 204, 205, 304].includes(status) || request.method === 'HEAD';
        resolve(new Response(empty ? null : Buffer.concat(chunks), { status, headers: out }));
        res.emit('finish');
        return res;
      },
    });
    try {
      app(req, res, error => {
        if (ended) return;
        if (error) reject(error);
        else resolve(Response.json({ error: 'Rota não encontrada.' }, { status: 404, headers: { 'cache-control': 'no-store' } }));
      });
    } catch (error) { reject(error); }
  });
}
