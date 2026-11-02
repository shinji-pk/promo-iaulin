// Cloudflare Pages Function: o mesmo servidor Express do Promo (apps/cloud) rodando na Cloudflare.
// Pages Functions não têm o servidor HTTP do Node: as rotas /api/auth vão direto ao Better Auth (API Web)
// e o resto passa pelo Express com apps/cloud/src/fetch-to-express.ts.
// Contas e dados ficam no Neon (DATABASE_URL); o WhatsApp continua no servidor próprio (MANAGED_WORKER_URL).
import { createHash } from 'node:crypto';

type Env = Record<string, unknown>;
type Context = { request: Request; env: Env };
type Handler = (request: Request) => Promise<Response>;

let ready: Promise<Handler> | null = null;

async function boot(): Promise<Handler> {
  const [{ createCloudApp }, { getCloudAuth }, { runExpress }] = await Promise.all([
    import('../../apps/cloud/src/app.ts'),
    import('../../apps/cloud/src/auth.ts'),
    import('../../apps/cloud/src/fetch-to-express.ts'),
  ]);
  const app = createCloudApp();
  return request => new URL(request.url).pathname.startsWith('/api/auth/')
    ? getCloudAuth().handler(request)
    : runExpress(app as unknown as Parameters<typeof runExpress>[0], request);
}

// Diagnóstico sem dados sensíveis: só o tipo do erro e uma mensagem curta sem endereços.
const safe = (error: unknown) => {
  const e = error instanceof Error ? error : new Error(String(error));
  const message = /:\/\/|postgres|secret|token|key/i.test(e.message) ? 'hidden' : e.message.slice(0, 160);
  return { error: 'server_boot_failed', kind: e.name, message };
};

export const onRequest = async (context: Context): Promise<Response> => {
  for (const [key, value] of Object.entries(context.env ?? {})) if (typeof value === 'string') process.env[key] = value;
  // Sem chave própria, deriva uma estável da conexão do banco (nunca fica no Git nem no navegador).
  if (!process.env.BETTER_AUTH_SECRET && process.env.DATABASE_URL)
    process.env.BETTER_AUTH_SECRET = createHash('sha256').update('promo-auth-v1:' + process.env.DATABASE_URL).digest('base64url');
  try {
    const handler = await (ready ??= boot().catch(error => { ready = null; throw error; }));
    return await handler(context.request);
  } catch (error) {
    console.error('promo api', error);
    return Response.json(safe(error), { status: 500, headers: { 'cache-control': 'no-store' } });
  }
};
