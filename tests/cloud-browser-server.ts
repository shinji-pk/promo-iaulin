import express from 'express';
import { createCloudApp } from '../apps/cloud/src/app.ts';
import { createCloudAuth } from '../apps/cloud/src/auth.ts';
import { emptyAuthDocument } from '../apps/cloud/src/blob-auth-adapter.ts';
import { JsonDocumentStore, StoreConflictError, type JsonBackend } from '../apps/cloud/src/blob-store.ts';

const documents=new Map<string,{etag:string;value:unknown}>();let revision=0;
const backend:JsonBackend={read:async path=>structuredClone(documents.get(path)??null),write:async(path,value,expected)=>{if((documents.get(path)?.etag??null)!==expected)throw new StoreConflictError();documents.set(path,{etag:String(++revision),value:structuredClone(value)});}};
const secret='browser-test-private-secret-at-least-thirty-two-characters';
const origin='http://127.0.0.1:3032';
const authStore=new JsonDocumentStore({backend,pathname:'auth',initial:emptyAuthDocument});
const auth=createCloudAuth({store:authStore,secret,baseURL:origin});
const {initialData}=await import('../apps/cloud/src/app.ts');
const {createSecurityQuestionService}=await import('../apps/cloud/src/security-questions.ts');
const recoveryService=createSecurityQuestionService({authStore,recoveryStore:new JsonDocumentStore({backend,pathname:'recovery',initial:()=>({version:1 as const,users:{},attempts:{}})}),secret});
const app=createCloudApp({auth,secret,baseURL:origin,recoveryService,storeFor:id=>new JsonDocumentStore({backend,pathname:`user-${id}`,initial:initialData})});
app.use(express.static('apps/web/dist'));
const server=app.listen(3032,'127.0.0.1');
process.on('SIGTERM',()=>server.close());
