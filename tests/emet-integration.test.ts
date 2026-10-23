import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCloudApp, initialData, type AccountData } from '../apps/cloud/src/app.ts';
import { EmetAccessError, verifyEmetAccess, type EmetPrincipal } from '../apps/cloud/src/emet-access.ts';
import { JsonDocumentStore, StoreConflictError, type JsonBackend } from '../apps/cloud/src/blob-store.ts';

const A='11111111-1111-4111-8111-111111111111';
const B='33333333-3333-4333-8333-333333333333';
const USER='22222222-2222-4222-8222-222222222222';
const TOKEN='abcdefghijklmnopqrstuvwx1234567890';
const secret='test-hmac-secret-long-enough-to-sign-csrf-tokens';
const clone=<T,>(x:T):T=>JSON.parse(JSON.stringify(x)) as T;

class MemoryBackend implements JsonBackend {
  readonly documents=new Map<string,{etag:string;value:unknown}>();
  revision=0;
  async read(path:string){return clone(this.documents.get(path)??null);}
  async write(path:string,value:unknown,expected:string|null){
    if((this.documents.get(path)?.etag??null)!==expected)throw new StoreConflictError();
    this.documents.set(path,{etag:String(++this.revision),value:clone(value)});
  }
}

describe('Emet single account and company-isolated Promo backend',()=>{
  let server:Server;
  let base='';
  let verifier:ReturnType<typeof vi.fn<typeof verifyEmetAccess>>;
  let backend:MemoryBackend;
  const call=async(path:string,method='GET',body?:unknown,extra:Record<string,string>={})=>{
    const response=await fetch(base+path,{method,headers:{Cookie:'__Host-emet-access='+TOKEN,Origin:'https://emet.shinjiapps.com',
      'Content-Type':'application/json',...extra},...(body===undefined?{}:{body:JSON.stringify(body)})});
    return {status:response.status,body:await response.json() as any};
  };
  afterEach(async()=>{
    if(server){server.closeIdleConnections();await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));}
  });
  async function boot(){
    backend=new MemoryBackend();
    verifier=vi.fn<typeof verifyEmetAccess>(async({organizationId,cookie}):Promise<EmetPrincipal>=>{
      if(!cookie.includes(TOKEN))throw new EmetAccessError(401,'AUTH_REQUIRED');
      return {user:{id:USER,email:'person@example.test',name:'Person'},organization:{id:organizationId,name:organizationId===A?'Company A':'Company B',role:'owner'}};
    });
    server=createServer();
    server.on('request',createCloudApp({secret,emetVerifier:verifier,storeFor:key=>new JsonDocumentStore<AccountData>({backend,pathname:key,initial:initialData})}));
    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
    base='http://127.0.0.1:'+(server.address() as AddressInfo).port;
  }

  it('uses the Emet account for the selected company without Better Auth signup',async()=>{
    await boot();
    const profile=await call('/api/v1/account?organizationId='+A);
    expect(profile.status).toBe(200);
    expect(profile.body).toMatchObject({mode:'emet',organization:{id:A,role:'owner'},user:{id:USER,email:'person@example.test'}});
    expect(verifier).toHaveBeenCalledWith({organizationId:A,cookie:expect.stringContaining(TOKEN)});
    const csrf=await call('/api/v1/session?organizationId='+A);
    expect(csrf.status).toBe(200);
    expect(csrf.body.mode).toBe('emet');
    expect(csrf.body.csrfToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const legacyChange=await call('/api/v1/account/password?organizationId='+A,'POST',{currentPassword:'secret'}, {'X-CSRF-Token':csrf.body.csrfToken});
    expect(legacyChange.status).toBe(409);
    expect(legacyChange.body.code).toBe('MANAGE_IN_EMET');
  });

  it('isolates workspace data by company even for the same authenticated person',async()=>{
    await boot();
    const csrf=(await call('/api/v1/session?organizationId='+A)).body.csrfToken;
    const state=(await call('/api/v1/state?organizationId='+A)).body;
    const changed={...state.settings,sourceGroups:['company-a-group']};
    const saved=await call('/api/v1/settings?organizationId='+A,'PUT',changed,{'X-CSRF-Token':csrf});
    expect(saved.status).toBe(200);
    expect((await call('/api/v1/state?organizationId='+A)).body.settings.sourceGroups).toEqual(['company-a-group']);
    expect((await call('/api/v1/state?organizationId='+B)).body.settings.sourceGroups).not.toContain('company-a-group');
    // Read-only access to a new company returns defaults without writing anything.
    expect([...backend.documents.keys()].sort()).toEqual(['emet:'+A]);
    const csB=(await call('/api/v1/session?organizationId='+B)).body.csrfToken;
    const settingsB=(await call('/api/v1/state?organizationId='+B)).body.settings;
    expect((await call('/api/v1/settings?organizationId='+B,'PUT',settingsB,{'X-CSRF-Token':csB})).status).toBe(200);
    expect([...backend.documents.keys()].sort()).toEqual(['emet:'+A,'emet:'+B]);
  });

  it('denies missing, duplicate, invalid and unauthorized company contexts',async()=>{
    await boot();
    expect((await call('/api/v1/state?organizationId=invalid')).status).toBe(409);
    expect((await call('/api/v1/state?organizationId='+A+'&organizationId='+B)).status).toBe(409);
    expect((await call('/api/v1/state')).status).toBe(409);
    expect((await call('/api/v1/state?organizationId='+A,'GET',undefined,{Cookie:''})).status).toBe(401);
    verifier.mockRejectedValueOnce(new EmetAccessError(403,'EMET_ACCESS_DENIED'));
    expect((await call('/api/v1/state?organizationId='+A)).status).toBe(403);
  });

  it('blocks cross-site mutations and invalid CSRF before writing tenant data',async()=>{
    await boot();
    const state=(await call('/api/v1/state?organizationId='+A)).body;
    expect((await call('/api/v1/settings?organizationId='+A,'PUT',state.settings)).status).toBe(403);
    const csrf=(await call('/api/v1/session?organizationId='+A)).body.csrfToken;
    expect((await call('/api/v1/settings?organizationId='+A,'PUT',state.settings,
      {Origin:'https://attacker.example','X-CSRF-Token':csrf})).status).toBe(403);
    expect(backend.documents.size).toBe(0);
  });
});
