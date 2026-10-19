import {afterEach,describe,expect,it,vi} from 'vitest';
const origin=vi.hoisted(()=>({value:{text:'x'.repeat(2048),count:0},revision:1,writes:0}));
vi.mock('@vercel/blob',()=>{
  class BlobPreconditionFailedError extends Error{}
  return {BlobPreconditionFailedError,get:vi.fn(async(_path:string,options:{useCache?:boolean;headers?:Record<string,string>})=>{
    const strong=`"origin-${origin.revision}"`,identity=options.headers?.['accept-encoding']==='identity';
    return {statusCode:200,stream:new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode(JSON.stringify(origin.value)));controller.close();}}),blob:{size:2048,etag:identity?strong:`W/${strong}`}};
  }),put:vi.fn(async(_path:string,body:string,options:{ifMatch?:string})=>{
    if(options.ifMatch!==`"origin-${origin.revision}"`)throw new BlobPreconditionFailedError();
    origin.value=JSON.parse(body);origin.revision++;origin.writes++;
  })};
});
import {createBlobJsonStore} from '../apps/cloud/src/blob-store.ts';
afterEach(()=>vi.unstubAllEnvs());
describe('private Blob origin consistency',()=>{
  it('updates documents larger than the compression threshold with a strong content ETag',async()=>{
    vi.stubEnv('BLOB_STORE_ID','store_test');origin.value={text:'x'.repeat(2048),count:0};origin.revision=1;origin.writes=0;
    const store=createBlobJsonStore('accounts/compressed.json',()=>({text:'',count:0}));
    await store.transact(draft=>{draft.count++;});await store.transact(draft=>{draft.count++;});
    expect((await store.read()).count).toBe(2);expect(origin.writes).toBe(2);expect(origin.value.text).toHaveLength(2048);
  });
});
