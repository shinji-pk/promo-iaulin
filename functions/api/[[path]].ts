// Cloudflare Pages Function: o mesmo servidor Express do Promo (apps/cloud) rodando na Cloudflare.
// Express roda no Workers pelo servidor HTTP do Node (cloudflare:node + nodejs_compat).
// Contas e dados ficam no Neon (DATABASE_URL); o WhatsApp continua no servidor próprio (MANAGED_WORKER_URL).
import { createHash } from 'node:crypto';

type Env = Record<string, unknown>;
type Context = { request: Request; env: Env };
type Handler = { fetch: (request: Request, env: Env, ctx: unknown) => Promise<Response> };

const PORT = 8787;
let ready: Promise<Handler> | null = null;

async function boot(): Promise<Handler> {
  // @ts-expect-error -- módulo do runtime da Cloudflare, sem tipos neste projeto
  const { httpServerHandler } = await import('cloudflare:node');
  const { createCloudApp } = await import('../../apps/cloud/src/app.ts');
  createCloudApp().listen(PORT);
  return httpServerHandler({ port: PORT }) as Handler;
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
    return await handler.fetch(context.request, context.env, context);
  } catch (error) {
    console.error('promo api', error);
    return Response.json(safe(error), { status: 500, headers: { 'cache-control': 'no-store' } });
  }
};
