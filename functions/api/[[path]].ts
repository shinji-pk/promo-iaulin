// Cloudflare Pages Function: o mesmo servidor Express do Promo (apps/cloud) rodando na Cloudflare.
// Express roda no Workers pelo servidor HTTP do Node (cloudflare:node + nodejs_compat).
// Contas e dados ficam no Neon (DATABASE_URL); o WhatsApp continua no servidor próprio (MANAGED_WORKER_URL).
// @ts-expect-error -- módulo do runtime da Cloudflare, sem tipos neste projeto
import { httpServerHandler } from 'cloudflare:node';
import { createHash } from 'node:crypto';
import { createCloudApp } from '../../apps/cloud/src/app.ts';

type Env = Record<string, unknown>;
type Context = { request: Request; env: Env; waitUntil?: (p: Promise<unknown>) => void };

const PORT = 8787;
let handler: { fetch: (request: Request, env: Env, ctx: unknown) => Promise<Response> } | null = null;

export const onRequest = async (context: Context): Promise<Response> => {
  for (const [key, value] of Object.entries(context.env ?? {})) if (typeof value === 'string') process.env[key] = value;
  // Sem chave própria, deriva uma estável da conexão do banco (nunca fica no Git nem no navegador).
  if (!process.env.BETTER_AUTH_SECRET && process.env.DATABASE_URL)
    process.env.BETTER_AUTH_SECRET = createHash('sha256').update('promo-auth-v1:' + process.env.DATABASE_URL).digest('base64url');
  if (!handler) {
    createCloudApp().listen(PORT);
    handler = httpServerHandler({ port: PORT });
  }
  return handler!.fetch(context.request, context.env, context);
};
