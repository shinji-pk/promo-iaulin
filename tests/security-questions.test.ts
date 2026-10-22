import { describe, expect, it } from 'vitest';
import { createCloudAuth } from '../apps/cloud/src/auth.ts';
import { emptyAuthDocument, type AuthDocument } from '../apps/cloud/src/blob-auth-adapter.ts';
import { JsonDocumentStore, StoreConflictError, type JsonBackend } from '../apps/cloud/src/blob-store.ts';
import { canonicalRecoveryCode, createSecurityQuestionService, generateRecoveryCode, SECURITY_QUESTIONS, type RecoveryDocument } from '../apps/cloud/src/security-questions.ts';

const secret='test-recovery-secret-longer-than-thirty-two-characters';
const original='Senha inicial muito segura 123!!', next='Nova senha muito segura 456!!', third='Terceira senha muito segura 789!!';
const q=[
  {id:'first_school',answer:'Minha escola particular'},
  {id:'favorite_teacher',answer:'Professora inesquecível'},
  {id:'favorite_book',answer:'Meu romance favorito'}
];
class Backend implements JsonBackend {
  private files=new Map<string,{etag:string;value:unknown}>();
  private revision=0;
  async read(pathname:string){return structuredClone(this.files.get(pathname)??null);}
  async write(pathname:string,value:unknown,previous:string|null){
    const file=this.files.get(pathname);
    if((file?.etag??null)!==previous)throw new StoreConflictError();
    this.files.set(pathname,{etag:String(++this.revision),value:structuredClone(value)});
  }
}
function setup(){
  const backend=new Backend();
  const authStore=new JsonDocumentStore<AuthDocument>({backend,pathname:'test/auth.json',initial:emptyAuthDocument});
  const recoveryStore=new JsonDocumentStore<RecoveryDocument>({backend,pathname:'test/recovery.json',initial:()=>({version:1,users:{},attempts:{}})});
  const auth=createCloudAuth({store:authStore,secret,baseURL:'https://security.test'});
  const service=createSecurityQuestionService({authStore,recoveryStore,secret});
  const post=(path:string,body:unknown)=>auth.handler(new Request('https://security.test/api/auth/'+path,{method:'POST',headers:{Origin:'https://security.test','Content-Type':'application/json'},body:JSON.stringify(body)}));
  /** Creates an account with the three questions, exactly like the signup screen does. */
  async function register(email='person@example.com'){
    const signed=await post('sign-up/email',{name:'Teste',email,password:original});
    expect(signed.status).toBe(200);
    const {user}=await signed.json() as {user:{id:string}};
    const saved=await service.enroll(user.id,original,q);
    return {userId:user.id,code:saved.recoveryCode!,email};
  }
  const canSignIn=async(email:string,password:string)=>(await post('sign-in/email',{email,password})).status===200;
  return {service,post,recoveryStore,register,canSignIn};
}

describe('knowledge-based fallback: private, opt-in, rate limited',()=>{
  it('normalizes case and whitespace, rotates password, and revokes existing sessions',async()=>{
    const {service,post,recoveryStore}=setup();
    const signed=await post('sign-up/email',{name:'Teste',email:'usER@example.com',password:original});
    expect(signed.status).toBe(200);
    const signedData=await signed.json() as {user:{id:string}};
    await expect(service.enroll(signedData.user.id,'senha errada',q)).rejects.toMatchObject({status:401});
    await service.enroll(signedData.user.id,original,q);
    expect(await service.getUser(signedData.user.id)).toEqual(q.map(x=>x.id));
    const stored=JSON.stringify(await recoveryStore.read());
    for(const item of q)expect(stored).not.toContain(item.answer);
    const uppercase=q.map(x=>({...x,answer:'  '+x.answer.toLocaleUpperCase('pt-BR')+'   '}));
    await service.reset('USER@EXAMPLE.COM',uppercase,next,next);
    expect((await post('sign-in/email',{email:'user@example.com',password:original})).status).not.toBe(200);
    expect((await post('sign-in/email',{email:'user@example.com',password:next})).status).toBe(200);
  });
  it('ignores accents as well as capital letters, because people type "Sao Paulo" and "São Paulo" alike',async()=>{
    const {service,register,canSignIn}=setup();
    const {email}=await register();
    const noAccents=[q[0],{id:'favorite_teacher',answer:'PROFESSORA INESQUECIVEL'},q[2]];
    await service.reset(email,noAccents,next,next);
    expect(await canSignIn(email,next)).toBe(true);
  });
  it('requires three different questions and matching repeated passwords',async()=>{
    const {service,post}=setup();
    const signed=await post('sign-up/email',{name:'Teste',email:'person@example.com',password:original});
    const {user}=await signed.json() as {user:{id:string}};
    await expect(service.enroll(user.id,original,[q[0],q[0],q[1]])).rejects.toMatchObject({status:400});
    await service.enroll(user.id,original,q);
    await expect(service.reset('person@example.com',q,next,next+'different')).rejects.toMatchObject({status:400});
  });
  it('rejects incorrect answers and globally limits repeated attempts',async()=>{
    const {service,post}=setup();
    const signed=await post('sign-up/email',{name:'Teste',email:'person@example.com',password:original});
    const {user}=await signed.json() as {user:{id:string}};
    await service.enroll(user.id,original,q);
    const wrong=q.map(item=>({...item,answer:'Valor incorreto'}));
    for(let i=0;i<3;i++)await expect(service.reset('person@example.com',wrong,next,next)).rejects.toMatchObject({status:400});
    await expect(service.reset('person@example.com',q,next,next)).rejects.toMatchObject({status:429});
    expect((await post('sign-in/email',{email:'person@example.com',password:original})).status).toBe(200);
  });
  it('answers the same way for an account that does not exist',async()=>{
    const {service}=setup();
    const error=await service.reset('ninguem@example.com',q,next,next).catch(cause=>cause);
    expect(error).toMatchObject({status:400,code:'recovery_denied'});
  });
  it('the shared list contains at least three choices',()=>{expect(SECURITY_QUESTIONS.length).toBeGreaterThanOrEqual(3);});
});

describe('recovery code (.txt file): one use, never stored in the clear',()=>{
  it('generates 25 unambiguous characters in groups of five, different every time',()=>{
    const pattern=/^([2-9A-HJ-NP-Z]{5}-){4}[2-9A-HJ-NP-Z]{5}$/;
    const codes=new Set(Array.from({length:200},()=>generateRecoveryCode()));
    expect(codes.size).toBe(200);
    for(const code of codes)expect(code).toMatch(pattern);
  });
  it('accepts lower case, spaces and missing dashes, but rejects anything that is not a code',()=>{
    const code=generateRecoveryCode();
    expect(canonicalRecoveryCode(code.toLowerCase().replaceAll('-',' '))).toBe(code.replaceAll('-',''));
    expect(canonicalRecoveryCode(code.replaceAll('-',''))).toBe(code.replaceAll('-',''));
    for(const bad of ['','ABC',code+'X','0'.repeat(25),'O'.repeat(25),undefined,42])expect(canonicalRecoveryCode(bad)).toBe('');
  });
  it('is created together with the questions, returned once, and stored only as a hash',async()=>{
    const {register,recoveryStore,service}=setup();
    const {userId,code}=await register();
    expect(code).toMatch(/^([2-9A-HJ-NP-Z]{5}-){4}[2-9A-HJ-NP-Z]{5}$/);
    const stored=JSON.stringify(await recoveryStore.read());
    expect(stored).not.toContain(code);
    expect(stored).not.toContain(code.replaceAll('-',''));
    expect(await service.status(userId)).toMatchObject({hasCode:true,selected:q.map(x=>x.id)});
    // Saving the questions again keeps the same code and does not show a new one.
    expect(await service.enroll(userId,original,q)).toEqual({});
  });
  it('resets the password, signs out other devices, and replaces the code (single use)',async()=>{
    const {service,register,canSignIn}=setup();
    const {email,code}=await register();
    const typed=code.toLowerCase().replaceAll('-','  ');
    const done=await service.resetWithCode(email.toUpperCase(),typed,next,next);
    expect(done.recoveryCode).toMatch(/^([2-9A-HJ-NP-Z]{5}-){4}[2-9A-HJ-NP-Z]{5}$/);
    expect(done.recoveryCode).not.toBe(code);
    expect(await canSignIn(email,original)).toBe(false);
    expect(await canSignIn(email,next)).toBe(true);
    // The code that was just used is dead; the new one works exactly once more.
    await expect(service.resetWithCode(email,code,third,third)).rejects.toMatchObject({status:400,code:'recovery_denied'});
    await service.resetWithCode(email,done.recoveryCode,third,third);
    expect(await canSignIn(email,third)).toBe(true);
  });
  it('does not let two simultaneous uses of one code both succeed',async()=>{
    const {service,register,canSignIn}=setup();
    const {email,code}=await register();
    const results=await Promise.allSettled([service.resetWithCode(email,code,next,next),service.resetWithCode(email,code,third,third)]);
    expect(results.filter(item=>item.status==='fulfilled')).toHaveLength(1);
    expect((await Promise.all([canSignIn(email,next),canSignIn(email,third)])).filter(Boolean)).toHaveLength(1);
  });
  it('treats a wrong code and an unknown account identically, and limits floods',async()=>{
    const {service,register}=setup();
    const {email}=await register();
    const wrong=generateRecoveryCode();
    const known=await service.resetWithCode(email,wrong,next,next).catch(cause=>cause);
    const unknown=await service.resetWithCode('ninguem@example.com',wrong,next,next).catch(cause=>cause);
    expect(known).toMatchObject({status:400,code:'recovery_denied'});
    expect(unknown).toMatchObject({status:400,code:'recovery_denied'});
    expect(known.message).toBe(unknown.message);
    await expect(service.resetWithCode(email,'curto',next,next)).rejects.toMatchObject({status:400,code:'invalid_code'});
    // Two attempts were used above (one wrong, one unknown account counts separately), so nine more reach the limit of ten.
    for(let i=0;i<9;i++)await service.resetWithCode(email,wrong,next,next).catch(()=>undefined);
    await expect(service.resetWithCode(email,wrong,next,next)).rejects.toMatchObject({status:429});
  });
  it('requires matching new passwords of at least 6 characters',async()=>{
    const {service,register}=setup();
    const {email,code}=await register();
    await expect(service.resetWithCode(email,code,next,next+'x')).rejects.toMatchObject({status:400,code:'invalid_password'});
    await expect(service.resetWithCode(email,code,'curta','curta')).rejects.toMatchObject({status:400,code:'invalid_password'});
    // The failed attempts above must not have burned the code.
    await service.resetWithCode(email,code,next,next);
  });
  it('recovering with the questions also retires the old code',async()=>{
    const {service,register}=setup();
    const {email,code}=await register();
    const done=await service.reset(email,q,next,next);
    expect(done.recoveryCode).not.toBe(code);
    await expect(service.resetWithCode(email,code,third,third)).rejects.toMatchObject({status:400});
    await service.resetWithCode(email,done.recoveryCode,third,third);
  });
  it('lets a signed-in person generate a new code only with their password; the old one stops working',async()=>{
    const {service,register,canSignIn}=setup();
    const {userId,email,code}=await register();
    await expect(service.regenerateCode(userId,'senha errada')).rejects.toMatchObject({status:401});
    const fresh=await service.regenerateCode(userId,original);
    expect(fresh.recoveryCode).not.toBe(code);
    await expect(service.resetWithCode(email,code,next,next)).rejects.toMatchObject({status:400});
    await service.resetWithCode(email,fresh.recoveryCode,next,next);
    expect(await canSignIn(email,next)).toBe(true);
  });
  it('one account\'s code never opens another account',async()=>{
    const {service,register,canSignIn}=setup();
    const first=await register('first@example.com');
    const second=await register('second@example.com');
    await expect(service.resetWithCode(second.email,first.code,next,next)).rejects.toMatchObject({status:400});
    expect(await canSignIn(second.email,original)).toBe(true);
  });
});
