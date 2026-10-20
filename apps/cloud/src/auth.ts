import { betterAuth } from 'better-auth';
import { blobAuthAdapter, emptyAuthDocument, type AuthDocument } from './blob-auth-adapter.ts';
import { createBlobJsonStore, type JsonDocumentStore } from './blob-store.ts';

// A single verified domain can serve several apps without branding the sender as one app.
// Leave TRANSACTIONAL_EMAIL_DOMAIN unset until DNS verification is complete in Resend.
// The legacy explicit sender takes precedence, preserving existing deployments.
export function getEmailSender(): string | null {
  const explicit = process.env.RESEND_FROM_EMAIL?.trim();
  if (explicit) return explicit;
  const domain = process.env.TRANSACTIONAL_EMAIL_DOMAIN?.trim().toLowerCase();
  const valid = domain && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(domain)
    && !domain.endsWith('.vercel.app');
  return valid ? `Promo IAulin <promo@${domain}>` : null;
}
export const hasEmailProvider = () => Boolean(process.env.RESEND_API_KEY && getEmailSender());
async function sendEmail(to:string,subject:string,body:string):Promise<void> {
  const sender = getEmailSender();
  if (!process.env.RESEND_API_KEY || !sender) throw new Error('Envio de e-mails não configurado.');
  const response=await fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:'Bearer '+process.env.RESEND_API_KEY,'Content-Type':'application/json'},body:JSON.stringify({from:sender,to:[to],subject,text:body}),signal:AbortSignal.timeout(12000)});
  if (!response.ok) throw new Error('O serviço de e-mail recusou o envio.');
}
/** Only exact approved frontends may authenticate or submit account changes. */
export function trustedAuthOrigins(baseURL:string):string[] {
  const base=new URL(baseURL).origin;
  const aliases=['https://promo-iaulin.vercel.app','https://promo-iaulin-mkce.vercel.app'];
  const isPromo=aliases.includes(base);
  const extras=(process.env.BETTER_AUTH_ALLOWED_ORIGINS??'').split(',').map(item=>item.trim()).filter(Boolean).map(item=>{
    const url=new URL(item);
    if(url.protocol!=='https:' || url.username || url.password || url.pathname!=='/' || url.search || url.hash)
      throw new Error('Origem de autenticação adicional inválida.');
    return url.origin;
  });
  return [...new Set([base,...(isPromo?aliases:[]),...extras])];
}

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
    user: { additionalFields: {
      username: { type:'string', required:false, defaultValue:'' },
      phone: { type:'string', required:false, defaultValue:'' }
    }, changeEmail: { enabled:true, sendChangeEmailConfirmation:async({user,newEmail,url})=>{
      await sendEmail(user.email,'Promo IAulin: confirme a troca de e-mail','Confirme a alteração para '+newEmail+': '+url);
    } } },
    emailVerification: { sendVerificationEmail:async({user,url})=>{
      await sendEmail(user.email,'Promo IAulin: confirme seu e-mail','Confirme seu e-mail: '+url);
    } },
    emailAndPassword: { enabled:true,minPasswordLength:12,maxPasswordLength:128,revokeSessionsOnPasswordReset:true,
      resetPasswordTokenExpiresIn:1800,
      sendResetPassword:async({user,url})=>{
        await sendEmail(user.email,'Promo IAulin: recuperar senha','Defina uma nova senha pelo link (30 minutos): '+url);
      }
    },
    trustedOrigins: trustedAuthOrigins(origin.origin),
    session: { expiresIn: 7 * 24 * 60 * 60, updateAge: 24 * 60 * 60, cookieCache: { enabled: false } },
    rateLimit: {
      enabled: true, storage: 'database', window: 60, max: 100,
      customRules: {
        '/sign-up/email': { window: 60, max: 10 },
        '/sign-in/email': { window: 60, max: 10 },
        '/change-password': { window: 60, max: 5 },
        '/request-password-reset': { window: 60, max: 3 },
        '/change-email': { window: 60, max: 3 },
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
