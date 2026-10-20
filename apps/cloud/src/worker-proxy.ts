import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import type { LookupFunction } from 'node:net';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { isPublicAddress } from '../../../packages/core/src/resolver.ts';

export interface WorkerConnection { origin:string; encryptedCookie:string; csrf:string; expiresAt:string; }
export interface ProxyResponse { status:number; body:Buffer; contentType:string; cookies:string[]; }

export function parsePairingUrl(input:string):{origin:string;code:string} {
  if (typeof input!=='string' || input.length>2048 || /[\s\\]/u.test(input)) throw new Error('Cole o link de pareamento gerado no seu computador.');
  const url=new URL(input), hostname=url.hostname;
  if (url.protocol!=='https:' || url.username || url.password || url.port || url.pathname!=='/' || url.search || hostname.endsWith('.') || !hostname.includes('.') ||
      !/^[a-z0-9.-]+$/i.test(hostname) || hostname.split('.').some(label=>!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label)) ||
      ['localhost','local','internal','test','invalid','example','onion'].some(suffix=>hostname===suffix||hostname.endsWith(`.${suffix}`))) throw new Error('O pareamento precisa de um endereço público HTTPS válido.');
  const fragment=new URLSearchParams(url.hash.slice(1)), code=fragment.get('pair');
  if (!code || !/^[A-Za-z0-9_-]{43}$/.test(code) || [...fragment.keys()].length!==1) throw new Error('O link não contém um código de pareamento válido. Gere outro no computador.');
  return {origin:url.origin,code};
}

function encryptionKey():Buffer {
  const secret=process.env.BETTER_AUTH_SECRET;
  if (!secret || secret.length<32) throw new Error('Proteção da conta indisponível.');
  return createHash('sha256').update(`promobridge-worker-cookie-v1:${secret}`).digest();
}
export function sealCookie(cookie:string,userId:string):string {
  const iv=randomBytes(12), cipher=createCipheriv('aes-256-gcm',encryptionKey(),iv);
  cipher.setAAD(Buffer.from(userId));
  const encrypted=Buffer.concat([cipher.update(cookie,'utf8'),cipher.final()]);
  return Buffer.concat([iv,cipher.getAuthTag(),encrypted]).toString('base64url');
}
export function openCookie(value:string,userId:string):string {
  const bytes=Buffer.from(value,'base64url');
  if(bytes.length<29 || bytes.length>1024) throw new Error('Conexão inválida. Pareie o computador novamente.');
  const cipher=createDecipheriv('aes-256-gcm',encryptionKey(),bytes.subarray(0,12));
  cipher.setAAD(Buffer.from(userId));cipher.setAuthTag(bytes.subarray(12,28));
  return Buffer.concat([cipher.update(bytes.subarray(28)),cipher.final()]).toString('utf8');
}

/** DNS is checked and pinned for every request. Redirects never receive the pairing code or cookie. */
export async function requestWorker(origin:string,path:string,options:{method?:string;body?:unknown;cookie?:string;csrf?:string;bearer?:string}={}):Promise<ProxyResponse> {
  const url=new URL(path,origin);
  if (url.origin!==origin || !url.pathname.startsWith('/api/v1/') || url.protocol!=='https:' || url.port || url.username || url.password) throw new Error('Endereço do aplicativo inválido.');
  const controller=new AbortController(), deadline=setTimeout(()=>controller.abort(),25000);
  try {
    const addresses=await Promise.race([lookup(url.hostname,{all:true,verbatim:true}),new Promise<never>((_,reject)=>controller.signal.addEventListener('abort',()=>reject(new Error('O computador demorou para responder.')),{once:true}))]);
    if(!addresses.length || addresses.length>64 || addresses.some(item=>!isPublicAddress(item.address))) throw new Error('O endereço do computador não aponta para uma rede pública permitida.');
    const address=addresses[0];
    const pinned:LookupFunction=(_hostname,lookupOptions,callback)=>{if(lookupOptions.all)callback(null,[{address:address.address,family:address.family as 4|6}]);else callback(null,address.address,address.family);};
    const body=options.body===undefined?undefined:Buffer.from(JSON.stringify(options.body));
    if(body && body.length>20*1024*1024)throw new Error('Conteúdo maior que o limite permitido.');
    return await new Promise<ProxyResponse>((resolve,reject)=>{
      const req=request(url,{method:options.method??'GET',agent:false,rejectUnauthorized:true,lookup:pinned,signal:controller.signal,maxHeaderSize:16384,
        headers:{accept:'application/json','accept-encoding':'identity',origin,...(options.bearer?{authorization:`Bearer ${options.bearer}`}:{}),...(options.cookie?{cookie:options.cookie}:{}),...(options.csrf?{'x-csrf-token':options.csrf}:{}),...(body?{'content-type':'application/json','content-length':String(body.length)}:{})}},response=>{
          const chunks:Buffer[]=[];let length=0;
          response.on('data',(chunk:Buffer)=>{length+=chunk.length;if(length>20*1024*1024){response.destroy(new Error('Resposta do computador maior que o limite.'));return;}chunks.push(chunk);});
          response.on('error',reject);response.on('end',()=>resolve({status:response.statusCode??502,body:Buffer.concat(chunks),contentType:response.headers['content-type']??'application/json',cookies:response.headers['set-cookie']??[]}));
        });
      req.on('error',()=>reject(new Error('Não foi possível acessar o computador. Confira se o PromoBridge e o acesso remoto estão ligados.')));
      req.end(body);
    });
  } finally {clearTimeout(deadline);}
}
