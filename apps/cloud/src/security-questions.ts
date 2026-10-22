import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { hashPassword, verifyPassword } from 'better-auth/crypto';
import { createBlobJsonStore, type JsonDocumentStore } from './blob-store.ts';
import { AUTH_DOCUMENT_PATH, emptyAuthDocument, type AuthDocument } from './blob-auth-adapter.ts';
import { SECURITY_QUESTIONS } from '../../../packages/shared/src/security-questions.ts';
export { SECURITY_QUESTIONS } from '../../../packages/shared/src/security-questions.ts';

// Recovery without e-mail. Two independent methods, both stored only as one-way verifiers:
//  1. three security questions (answers are normalised, then hashed);
//  2. a random recovery code the person downloads once as a .txt file.
// Neither the answers nor the code can be read back. A successful recovery issues a new code.

/** Changing this path starts a fresh recovery database (the previous one is simply no longer read). */
export const RECOVERY_DOCUMENT_PATH = 'accounts/security-questions-v2.json';

const allowed = new Set<string>(SECURITY_QUESTIONS.map(q => q.id));
export interface SelectedQuestion { id:string; answer:string }
interface StoredCode { hash:string; createdAt:string }
interface RecoveryUser { questions: Array<{ id:string; hash:string }>; code?:StoredCode; updatedAt:string }
export interface RecoveryDocument {
  version:1;
  users: Record<string, RecoveryUser>;
  attempts: Record<string, { count:number; until:number }>;
}
export class SecurityQuestionError extends Error {
  constructor(public status:number, public code:string, message:string) { super(message); }
}
const initial = ():RecoveryDocument => ({ version:1, users:{}, attempts:{} });

// Case, accents, repeated spaces and surrounding spaces never matter: "São  PAULO" equals "sao paulo".
const answerValue = (value:string) => value.normalize('NFKD').replace(/\p{M}/gu,'').trim().replace(/\s+/g,' ').toLocaleLowerCase('pt-BR');
const normalizedEmail = (value:string) => value.trim().toLowerCase();
const validQuestions = (items:SelectedQuestion[]) => Array.isArray(items) && items.length===3 &&
  items.every(item => item && typeof item.id==='string' && allowed.has(item.id) &&
    typeof item.answer==='string' && item.answer.length<=120 && answerValue(item.answer).length>=6) &&
  new Set(items.map(item=>item.id)).size===3;

// 25 characters x 5 bits = 125 bits of randomness. The alphabet leaves out 0, 1, I and O so nothing is misread.
const CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const CODE_LENGTH = 25;
export function generateRecoveryCode():string {
  const bytes=randomBytes(CODE_LENGTH);
  let raw='';
  for(const byte of bytes)raw+=CODE_ALPHABET[byte & 31]; // 256 is a multiple of 32, so there is no modulo bias
  return raw.match(/.{5}/g)!.join('-');
}
/** Accepts lower case, spaces or missing dashes. Returns '' when the text cannot be a code. */
export function canonicalRecoveryCode(value:unknown):string {
  if(typeof value!=='string' || value.length>80)return '';
  const canonical=value.normalize('NFKC').toUpperCase().replace(/[^A-Z0-9]/g,'');
  return canonical.length===CODE_LENGTH && [...canonical].every(char=>CODE_ALPHABET.includes(char)) ? canonical : '';
}

const protector = (secret:string,questionId:string,answer:string) =>
  createHmac('sha256',secret).update(questionId).update('\x00').update(answerValue(answer)).digest('hex');
const codeDigest = (secret:string,userId:string,canonical:string) =>
  createHmac('sha256',secret).update('recovery-code\x00').update(userId).update('\x00').update(canonical).digest('hex');
const sameDigest = (left:string,right:string) => {
  const a=Buffer.from(left),b=Buffer.from(right);
  return a.length===b.length && timingSafeEqual(a,b);
};
const indexFor = (secret:string,kind:'questions'|'code',email:string) =>
  createHmac('sha256',secret).update(`recovery:${kind}:`).update(normalizedEmail(email)).digest('hex');
const authFor = (draft:AuthDocument,userId:string) => draft.tables.account?.find(row=>row.userId===userId&&row.providerId==='credential');
const userFor = (draft:AuthDocument,email:string) => draft.tables.user?.find(row=>row.email===normalizedEmail(email));
const DENIED = () => new SecurityQuestionError(400,'recovery_denied','Não foi possível confirmar a recuperação. Confira os dados.');

export function createSecurityQuestionService(options: {
  authStore?:JsonDocumentStore<AuthDocument>;
  recoveryStore?:JsonDocumentStore<RecoveryDocument>;
  secret?:string;
} = {}) {
  const secret=options.secret??process.env.BETTER_AUTH_SECRET;
  if (!secret || secret.length<32) throw new Error('Serviço de recuperação indisponível.');
  const verifiedSecret:string=secret;
  const authStore=options.authStore??createBlobJsonStore<AuthDocument>(AUTH_DOCUMENT_PATH,emptyAuthDocument);
  const recoveryStore=options.recoveryStore??createBlobJsonStore<RecoveryDocument>(RECOVERY_DOCUMENT_PATH,initial,{maxBytes:2*1024*1024});
  let dummy:Promise<string>|undefined;
  /** Unknown accounts take the same path as real ones, so response time does not reveal who has an account. */
  const dummyHash=()=>dummy??=hashPassword('conta-inexistente-'+verifiedSecret.slice(0,8));

  const newCode=(userId:string):{ plain:string; stored:StoredCode } => {
    const plain=generateRecoveryCode();
    return { plain, stored:{ hash:codeDigest(verifiedSecret,userId,canonicalRecoveryCode(plain)), createdAt:new Date().toISOString() } };
  };

  async function status(userId:string):Promise<{ selected:string[]; hasCode:boolean; codeCreatedAt:string|null }> {
    const user=(await recoveryStore.read()).users[userId];
    return { selected:user?.questions.map(q=>q.id)??[], hasCode:Boolean(user?.code), codeCreatedAt:user?.code?.createdAt??null };
  }
  const getUser=async(userId:string):Promise<string[]>=>(await status(userId)).selected;

  async function confirmPassword(userId:string,currentPassword:string):Promise<void> {
    if(!currentPassword)throw new SecurityQuestionError(400,'password_required','Confirme a senha da conta.');
    const data=await authStore.read(), credential=authFor(data,userId);
    if(typeof credential?.password!=='string' || !(await verifyPassword({hash:credential.password,password:currentPassword}))){
      throw new SecurityQuestionError(401,'not_authorized','A senha atual não foi reconhecida.');
    }
  }

  /** Saves the three questions. The first time, it also creates the recovery code, which is returned only once. */
  async function enroll(userId:string,currentPassword:string,questions:SelectedQuestion[]):Promise<{ recoveryCode?:string }> {
    if(!validQuestions(questions))throw new SecurityQuestionError(400,'invalid_questions','Escolha três perguntas diferentes e use respostas com pelo menos 6 caracteres.');
    await confirmPassword(userId,currentPassword);
    const hashed=await Promise.all(questions.map(async q=>({id:q.id,hash:await hashPassword(protector(verifiedSecret,q.id,q.answer))})));
    let issued:string|undefined;
    await recoveryStore.transact(draft=>{
      issued=undefined; // the callback can be replayed after a write conflict
      const existing=draft.users[userId];
      let code=existing?.code;
      if(!code){const created=newCode(userId);code=created.stored;issued=created.plain;}
      draft.users[userId]={questions:hashed,code,updatedAt:new Date().toISOString()};
    });
    return issued ? { recoveryCode:issued } : {};
  }

  /** Replaces the recovery code. The old one stops working immediately. */
  async function regenerateCode(userId:string,currentPassword:string):Promise<{ recoveryCode:string }> {
    await confirmPassword(userId,currentPassword);
    let issued='';
    await recoveryStore.transact(draft=>{
      const created=newCode(userId);
      issued=created.plain;
      const existing=draft.users[userId];
      draft.users[userId]={questions:existing?.questions??[],code:created.stored,updatedAt:new Date().toISOString()};
    });
    return { recoveryCode:issued };
  }

  async function takeAttempt(rateKey:string,limit:number):Promise<void> {
    const now=Date.now();
    // A shared, compare-and-swap limiter works across serverless instances.
    await recoveryStore.transact(doc=>{
      for(const [key,entry] of Object.entries(doc.attempts))if(entry.until<=now)delete doc.attempts[key];
      const current=doc.attempts[rateKey];
      const count=current && current.until>now?current.count:0;
      if(count>=limit)throw new SecurityQuestionError(429,'too_many_attempts','Muitas tentativas. Aguarde uma hora.');
      doc.attempts[rateKey]={count:count+1,until:current&&current.until>now?current.until:now+3600000};
    });
  }

  function checkNewPassword(email:string,newPassword:string,repeated:string):void {
    if(typeof email!=='string'||email.length>254||!email.includes('@'))
      throw new SecurityQuestionError(400,'invalid_request','Confira os dados de recuperação.');
    if(typeof newPassword!=='string'||newPassword.length<6||newPassword.length>128||newPassword!==repeated)
      throw new SecurityQuestionError(400,'invalid_password','Digite duas vezes a mesma senha nova (mínimo 6 caracteres).');
  }

  /** Same private credential store used by Better Auth: one compare-and-swap write rotates the password and revokes sessions. */
  async function rotatePassword(userId:string,email:string,newPassword:string):Promise<void> {
    const hashed=await hashPassword(newPassword);
    await authStore.transact(auth=>{
      const owner=userFor(auth,email);
      if(owner?.id!==userId)throw new SecurityQuestionError(409,'account_changed','A conta mudou. Comece novamente.');
      const credential=authFor(auth,userId);
      if(!credential)throw new SecurityQuestionError(409,'credential_missing','Esta conta não permite recuperação.');
      credential.password=hashed;
      auth.tables.session=(auth.tables.session??[]).filter(row=>row.userId!==userId);
    });
  }

  async function reset(email:string,questions:SelectedQuestion[],newPassword:string,repeated:string):Promise<{ recoveryCode:string }> {
    checkNewPassword(email,newPassword,repeated);
    if(!validQuestions(questions))throw new SecurityQuestionError(400,'invalid_questions','Informe as três perguntas e respostas cadastradas.');
    const user=userFor(await authStore.read(),email);
    const userId=typeof user?.id==='string'?user.id:'';
    const rateKey=indexFor(verifiedSecret,'questions',email);
    await takeAttempt(rateKey,3);
    const stored=userId?(await recoveryStore.read()).users[userId]?.questions:undefined;
    const byId=new Map(questions.map(q=>[q.id,q.answer]));
    const ordered=stored&&stored.length===3?stored:undefined;
    // Do not indicate whether an account exists, the questions are enrolled or answers match.
    let matches=Boolean(ordered&&userId);
    if(ordered) {
      const results=await Promise.all(ordered.map(async q=>{
        const answer=byId.get(q.id);
        return typeof answer==='string' && await verifyPassword({hash:q.hash,password:protector(verifiedSecret,q.id,answer)});
      }));
      matches=matches&&results.every(Boolean);
    } else await verifyPassword({hash:await dummyHash(),password:'x'}).catch(()=>false);
    if(!matches)throw DENIED();
    await rotatePassword(userId,email,newPassword);
    // Any recovery retires the old code, so a leaked file cannot be used again.
    let issued='';
    await recoveryStore.transact(doc=>{
      const created=newCode(userId);
      issued=created.plain;
      const record=doc.users[userId];
      if(record)doc.users[userId]={...record,code:created.stored,updatedAt:new Date().toISOString()};
      delete doc.attempts[rateKey];
    });
    return { recoveryCode:issued };
  }

  async function resetWithCode(email:string,code:string,newPassword:string,repeated:string):Promise<{ recoveryCode:string }> {
    checkNewPassword(email,newPassword,repeated);
    const canonical=canonicalRecoveryCode(code);
    if(!canonical)throw new SecurityQuestionError(400,'invalid_code','Confira o código: ele tem 25 letras e números, em grupos de 5.');
    const user=userFor(await authStore.read(),email);
    const userId=typeof user?.id==='string'?user.id:'';
    const rateKey=indexFor(verifiedSecret,'code',email);
    // The code is 125 random bits, so guessing is hopeless; the limit only stops floods.
    await takeAttempt(rateKey,10);
    // Verification and consumption are one atomic write, so a code can never win twice.
    let previous:StoredCode|undefined,issued='';
    await recoveryStore.transact(doc=>{
      previous=undefined;issued=''; // the callback can be replayed after a write conflict
      const record=userId?doc.users[userId]:undefined;
      const expected=record?.code?.hash??codeDigest(verifiedSecret,'sem-conta','0');
      const same=sameDigest(codeDigest(verifiedSecret,userId||'sem-conta',canonical),expected);
      if(!same || !record?.code)return;
      previous=record.code;
      const fresh=newCode(userId);
      issued=fresh.plain;
      doc.users[userId]={...record,code:fresh.stored,updatedAt:new Date().toISOString()};
      delete doc.attempts[rateKey];
    });
    if(!issued)throw DENIED();
    try {
      await rotatePassword(userId,email,newPassword);
    } catch(error) {
      // The password did not change, so give the person back the code they still hold.
      await recoveryStore.transact(doc=>{const record=doc.users[userId];if(record&&previous)record.code=previous;}).catch(()=>undefined);
      throw error;
    }
    return { recoveryCode:issued };
  }
  return {getUser,status,enroll,regenerateCode,reset,resetWithCode};
}
