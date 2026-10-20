import { betterAuth } from 'better-auth';
import { blobAuthAdapter, emptyAuthDocument, type AuthDocument } from './blob-auth-adapter.ts';
import { createBlobJsonStore, type JsonDocumentStore } from './blob-store.ts';

export const hasEmailProvider = () => Boolean(process.env.RESEND_API_KEY && process.env.RESEND_FROM_EMAIL);
async function sendEmail(to:string,subject:string,body:string):Promise<void> {
  if (!hasEmailProvider()) throw new Error('Envio de e-mails não configurado.');
  const response=await fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:'Bearer '+process.env.RESEND_API_KEY,'Content-Type':'application/json'},body:JSON.stringify({from:process.env.RESEND_FROM_EMAIL,to:[to],subject,text:body}),signal:AbortSignal.timeout(12000)});
  if (!response.ok) throw new Error('O serviço de e-mail recusou o envio.');
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
    trustedOrigins: [origin.origin],
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
