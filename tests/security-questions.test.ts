import { describe, expect, it } from 'vitest';
import { createCloudAuth } from '../apps/cloud/src/auth.ts';
import { emptyAuthDocument, type AuthDocument } from '../apps/cloud/src/blob-auth-adapter.ts';
import { JsonDocumentStore, StoreConflictError, type JsonBackend } from '../apps/cloud/src/blob-store.ts';
import { createSecurityQuestionService, SECURITY_QUESTIONS, SecurityQuestionError } from '../apps/cloud/src/security-questions.ts';

type RecoveryDoc = {version:1;users:Record<string,{questions:Array<{id:string;hash:string}>;updatedAt:string}>;attempts:Record<string,{count:number;until:number}>};
const secret='test-recovery-secret-longer-than-thirty-two-characters';
const original='Senha inicial muito segura 123!!', next='Nova senha muito segura 456!!';
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
  const recoveryStore=new JsonDocumentStore<RecoveryDoc>({backend,pathname:'test/recovery.json',initial:()=>({version:1,users:{},attempts:{}})});
  const auth=createCloudAuth({store:authStore,secret,baseURL:'https://security.test'});
  const service=createSecurityQuestionService({authStore,recoveryStore,secret});
  const post=(path:string,body:unknown)=>auth.handler(new Request('https://security.test/api/auth/'+path,{method:'POST',headers:{Origin:'https://security.test','Content-Type':'application/json'},body:JSON.stringify(body)}));
  return {service,post,recoveryStore};
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
  it('the shared list contains at least three choices',()=>{expect(SECURITY_QUESTIONS.length).toBeGreaterThanOrEqual(3);});
});
