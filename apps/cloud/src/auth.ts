import { betterAuth } from 'better-auth';
import { blobAuthAdapter, emptyAuthDocument, type AuthDocument } from './blob-auth-adapter.ts';
import { createBlobJsonStore, type JsonDocumentStore } from './blob-store.ts';

export interface CloudAuthOptions {
  store?: JsonDocumentStore<AuthDocument>;
  secret?: string;
  baseURL?: string;
}

export function createCloudAuth(options: CloudAuthOptions = {}) {
  const secret = options.secret ?? process.env.BETTER_AUTH_SECRET;
  if (!secret || secret.length < 32) throw new Error('A autenticação precisa de uma chave de servidor com pelo menos 32 caracteres.');
  const baseURL = options.baseURL ?? process.env.BETTER_AUTH_URL ?? 'https://promo-iaulin.vercel.app';
  const origin = new URL(baseURL);
  if (origin.protocol !== 'https:' && origin.hostname !== 'localhost' && origin.hostname !== '127.0.0.1') throw new Error('O endereço de autenticação precisa usar HTTPS.');
  const store = options.store ?? createBlobJsonStore('accounts/auth-v1.json', emptyAuthDocument, { maxBytes: 8 * 1024 * 1024 });
  const auth = betterAuth({
    appName: 'PromoBridge', baseURL: origin.origin, secret,
    database: blobAuthAdapter(store),
    emailAndPassword: { enabled: true, minPasswordLength: 12, maxPasswordLength: 128 },
    trustedOrigins: [origin.origin],
    session: { expiresIn: 7 * 24 * 60 * 60, updateAge: 24 * 60 * 60, cookieCache: { enabled: false } },
    rateLimit: {
      enabled: true, storage: 'database', window: 60, max: 100,
      customRules: {
        '/sign-up/email': { window: 60, max: 10 },
        '/sign-in/email': { window: 60, max: 10 },
        '/change-password': { window: 60, max: 5 },
      },
    },
    advanced: { useSecureCookies: origin.protocol === 'https:', disableOriginCheck: false, disableCSRFCheck: false },
    logger: { disabled: true },
  });
  return {
    ...auth,
    handler: async (request: Request): Promise<Response> => {
      try { return await auth.handler(request); }
      catch {
        // Rate-limit persistence can fail before Better Auth's route boundary.
        // Fail closed without leaking records, credentials, or issuing a cookie.
        return Response.json({ code: 'AUTH_STORAGE_UNAVAILABLE', message: 'Não foi possível acessar sua conta agora. Tente novamente em instantes.' }, {
          status: 503, headers: { 'Cache-Control': 'private, no-store' },
        });
      }
    },
  };
}

let instance: ReturnType<typeof createCloudAuth> | undefined;
export function getCloudAuth(): ReturnType<typeof createCloudAuth> {
  return instance ??= createCloudAuth();
}
