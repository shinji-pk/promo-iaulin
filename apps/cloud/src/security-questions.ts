import { createHmac } from 'node:crypto';
import { hashPassword, verifyPassword } from 'better-auth/crypto';
import { createBlobJsonStore, type JsonDocumentStore } from './blob-store.ts';
import { type AuthDocument } from './blob-auth-adapter.ts';

// Knowledge-based recovery is less secure than email verification or a recovery key.
// Keep it opt-in, restrict guesses and never expose stored answers.
export const SECURITY_QUESTIONS = [
  { id:'first_school', label:'Qual era o nome da sua primeira escola?' },
  { id:'childhood_street', label:'Qual era o nome da rua onde você cresceu?' },
  { id:'first_pet', label:'Qual era o nome do seu primeiro animal de estimação?' },
  { id:'favorite_teacher', label:'Qual era o nome de um professor marcante?' },
  { id:'childhood_friend', label:'Qual era o primeiro nome de um amigo de infância?' },
  { id:'first_job', label:'Em qual lugar você teve seu primeiro emprego?' },
  { id:'memorable_trip', label:'Qual cidade marcou sua primeira viagem?' },
  { id:'childhood_nickname', label:'Qual apelido sua família usava na infância?' },
  { id:'favorite_book', label:'Qual livro mais marcou sua adolescência?' },
  { id:'family_recipe', label:'Qual comida da família você mais lembra da infância?' },
] as const;
const allowed = new Set<string>(SECURITY_QUESTIONS.map(q => q.id));
export interface SelectedQuestion { id:string; answer:string }
interface RecoveryDocument {
  version:1;
  users: Record<string, { questions: Array<{ id:string; hash:string }>; updatedAt:string }>;
  attempts: Record<string, { count:number; until:number }>;
}
export class SecurityQuestionError extends Error {
  constructor(public status:number, public code:string, message:string) { super(message); }
}
const initial = ():RecoveryDocument => ({ version:1, users:{}, attempts:{} });
const answerValue = (value:string) => value.normalize('NFKC').trim().replace(/\s+/g,' ').toLocaleLowerCase('pt-BR');
const normalizedEmail = (value:string) => value.trim().toLowerCase();
const validQuestions = (items:SelectedQuestion[]) => Array.isArray(items) && items.length===3 &&
  items.every(item => item && typeof item.id==='string' && allowed.has(item.id) &&
    typeof item.answer==='string' && item.answer.length<=120 && answerValue(item.answer).length>=6) &&
  new Set(items.map(item=>item.id)).size===3;
const protector = (secret:string,questionId:string,answer:string) =>
  createHmac('sha256',secret).update(questionId).update('\x00').update(answerValue(answer)).digest('hex');
const indexFor = (secret:string,email:string) =>
  createHmac('sha256',secret).update('recovery:').update(normalizedEmail(email)).digest('hex');
const authFor = (draft:AuthDocument,userId:string) => draft.tables.account?.find(row=>row.userId===userId&&row.providerId==='credential');
const userFor = (draft:AuthDocument,email:string) => draft.tables.user?.find(row=>row.email===normalizedEmail(email));

export function createSecurityQuestionService(options: {
  authStore?:JsonDocumentStore<AuthDocument>;
  recoveryStore?:JsonDocumentStore<RecoveryDocument>;
  secret?:string;
} = {}) {
  const secret=options.secret??process.env.BETTER_AUTH_SECRET;
  if (!secret || secret.length<32) throw new Error('Serviço de recuperação indisponível.');
  const authStore=options.authStore??createBlobJsonStore<AuthDocument>('accounts/auth-v1.json',()=>({version:1,tables:{}}));
  const recoveryStore=options.recoveryStore??createBlobJsonStore<RecoveryDocument>('accounts/security-questions-v1.json',initial,{maxBytes:2*1024*1024});

  async function getUser(userId:string):Promise<string[]> {
    const doc=await recoveryStore.read();
    return doc.users[userId]?.questions.map(q=>q.id)??[];
  }

  async function enroll(userId:string,currentPassword:string,questions:SelectedQuestion[]):Promise<void> {
    if(!validQuestions(questions))throw new SecurityQuestionError(400,'invalid_questions','Escolha três perguntas diferentes e use respostas com pelo menos 6 caracteres.');
    if(!currentPassword)throw new SecurityQuestionError(400,'password_required','Confirme a senha da conta.');
    const data=await authStore.read(), credential=authFor(data,userId);
    if(typeof credential?.password!=='string' || !(await verifyPassword({hash:credential.password,password:currentPassword}))){
      throw new SecurityQuestionError(401,'not_authorized','A senha atual não foi reconhecida.');
    }
    const hashed=await Promise.all(questions.map(async q=>({id:q.id,hash:await hashPassword(protector(secret,q.id,q.answer))})));
    await recoveryStore.transact(draft=>{
      draft.users[userId]={questions:hashed,updatedAt:new Date().toISOString()};
    });
  }

  async function reset(email:string,questions:SelectedQuestion[],newPassword:string,confirmPassword:string):Promise<void> {
    if(typeof email!=='string'||email.length>254||!email.includes('@'))
      throw new SecurityQuestionError(400,'invalid_request','Confira os dados de recuperação.');
    if(!validQuestions(questions))throw new SecurityQuestionError(400,'invalid_questions','Informe as três perguntas e respostas cadastradas.');
    if(typeof newPassword!=='string'||newPassword.length<12||newPassword.length>128||newPassword!==confirmPassword)
      throw new SecurityQuestionError(400,'invalid_password','Digite duas vezes a mesma senha nova (mínimo 12 caracteres).');
    const accountDoc=await authStore.read();
    const user=userFor(accountDoc,email);
    const userId=typeof user?.id==='string'?user.id:'';
    const rateKey=indexFor(secret,email),now=Date.now();
    // A globally shared, CAS-backed limiter blocks concurrent attempts, across serverless instances.
    await recoveryStore.transact(doc=>{
      const current=doc.attempts[rateKey];
      const count=current && current.until>now?current.count:0;
      if(count>=3)throw new SecurityQuestionError(429,'too_many_attempts','Muitas tentativas. Aguarde uma hora.');
      doc.attempts[rateKey]={count:count+1,until:current&&current.until>now?current.until:now+3600000};
    });
    const doc=await recoveryStore.read();
    const stored=userId?doc.users[userId]?.questions:undefined;
    const byId=new Map(questions.map(q=>[q.id,q.answer]));
    const ordered=stored&&stored.length===3?stored:undefined;
    // Do not indicate whether an account exists, the questions are enrolled or answers match.
    let matches=Boolean(ordered&&userId);
    if(ordered) {
      const results=await Promise.all(ordered.map(async q=>{
        const answer=byId.get(q.id);
        return typeof answer==='string' && await verifyPassword({hash:q.hash,password:protector(secret,q.id,answer)});
      }));
      matches=matches&&results.every(Boolean);
    }
    if(!matches)throw new SecurityQuestionError(400,'recovery_denied','Não foi possível confirmar a recuperação. Confira os dados.');
    const hashed=await hashPassword(newPassword);
    // This is the same private credential store used by Better Auth.
    // A single compare-and-swap write rotates the credential and revokes all sessions.
    await authStore.transact(auth=>{
      const owner=userFor(auth,email);
      if(owner?.id!==userId)throw new SecurityQuestionError(409,'account_changed','A conta mudou. Comece novamente.');
      const credential=authFor(auth,userId);
      if(!credential)throw new SecurityQuestionError(409,'credential_missing','Esta conta não permite recuperação por perguntas.');
      credential.password=hashed;
      auth.tables.session=(auth.tables.session??[]).filter(row=>row.userId!==userId);
    });
    await recoveryStore.transact(doc=>{delete doc.attempts[rateKey];});
  }
  return {getUser,enroll,reset};
}
