import {request as httpRequest,type Server} from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {createApp,type WhatsAppTransport} from '../apps/worker/src/api.ts';
import {WhatsAppSendError} from '../apps/worker/src/whatsapp.ts';
import type {RemoteAccess,RemoteStatus} from '../apps/worker/src/remote-access.ts';
import {defaultSettings,RISK_NOTICE_VERSION,type Offer,type Settings,type WhatsAppStatus} from '../packages/shared/src/index.ts';

const source='123456@g.us',destination='987654@g.us';
const amazon='https://www.amazon.com.br/dp/B012345678';
const promo=(url=amazon)=>`Creme hidratante facial\nDe R$ 100,00 por R$ 49,90\nCupom: BELEZA10\nFrete grátis\n${url}`;
const jpeg=Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD2miiisTQ//9k=','base64');
function transport() {
  const status:WhatsAppStatus={connected:true,connecting:false,qrDataUrl:null,user:'Test',groups:[{id:source,name:'Fonte',participants:2},{id:destination,name:'Destino',participants:2,canSend:true}],lastError:null};
  return {getStatus:vi.fn(()=>structuredClone(status)),connect:vi.fn(async()=>{}),reset:vi.fn(async()=>{}),refreshGroups:vi.fn(async()=>status.groups),sendText:vi.fn(async(_group:string,_text:string)=>'TEXT-1'),sendImage:vi.fn(async(_group:string,_image:Buffer,_text:string)=>'IMAGE-1'),assertCanSend:vi.fn(async(_group:string,_text:string)=>{}),stop:vi.fn(async()=>{})} satisfies WhatsAppTransport;
}

describe('worker product operations and safe remote API',()=>{
  let directory:string,app:ReturnType<typeof createApp>,server:Server,base:string,token:string,wa:ReturnType<typeof transport>,clock:Date;
  let remote:{origin:string;isRemoteHost:(host:string)=>boolean;authorize:(cookie:string|undefined)=>boolean;status:ReturnType<typeof vi.fn>;pair:ReturnType<typeof vi.fn>;stop:ReturnType<typeof vi.fn>;revokeSessions:ReturnType<typeof vi.fn>;start:ReturnType<typeof vi.fn>};
  async function request<T=unknown>(path:string,method='GET',body?:unknown) {
    const response=await fetch(`${base}/api/v1${path}`,{method,headers:{Origin:base,'Content-Type':'application/json','X-CSRF-Token':token},...(body===undefined ? {} : {body:JSON.stringify(body)})});
    return {status:response.status,body:await response.json() as T};
  }
  async function remoteRequest(path:string,method='GET',body?:unknown,headers:Record<string,string>={}) {
    return new Promise<{status:number;body:any;headers:import('node:http').IncomingHttpHeaders}>((resolveRequest,reject)=>{
      const outgoing=httpRequest(`${base}/api/v1${path}`,{method,headers:{Host:'worker.trycloudflare.com',Origin:remote.origin,'Content-Type':'application/json',...headers}},response=>{
        let data='';response.setEncoding('utf8');response.on('data',part=>{data+=part;});response.on('end',()=>resolveRequest({status:response.statusCode!,body:JSON.parse(data),headers:response.headers}));
      });outgoing.on('error',reject);if (body!==undefined) outgoing.write(JSON.stringify(body));outgoing.end();
    });
  }
  async function setup(mode:Settings['mode']='manual',paused=false) {
    const settings=defaultSettings();Object.assign(settings,{riskNotice:{version:RISK_NOTICE_VERSION,acceptedAt:'2026-10-18T12:00:00.000Z'},sourceGroups:[source],destinationGroup:destination,minScore:0,quietStart:'00:00',quietEnd:'00:00',mode,paused});
    settings.affiliates.amazon={enabled:true,publicId:'promobridge-20',originalUrl:amazon,affiliateUrl:`${amazon}?tag=promobridge-20`,verifiedAt:null};
    await request('/settings','PUT',settings);
    await request('/affiliates/amazon/calibrate','POST',{enabled:true,publicId:'promobridge-20',originalUrl:amazon,affiliateUrl:`${amazon}?tag=promobridge-20`});
  }
  async function offer() {const result=await app.runtime.ingest({text:promo(),sourceId:source,sourceName:'Fonte',messageId:crypto.randomUUID(),simulation:false});return result[0];}
  async function approve(value:Offer) {return (await request<Offer>(`/offers/${value.id}/action`,'POST',{action:'approve'})).body;}
  beforeEach(async()=>{
    directory=await mkdtemp(join(tmpdir(),'promobridge-features-'));clock=new Date('2026-10-19T12:00:00Z');wa=transport();
    const status:RemoteStatus={state:'ready',mode:'temporary',publicUrl:'https://worker.trycloudflare.com',message:'Testing',expiresAt:'2026-10-19T12:05:00Z',activeSessions:0,pairing:{code:'PAIR-CODE',url:'https://worker.trycloudflare.com/#pair=PAIR-CODE',expiresAt:'2026-10-19T12:05:00Z'}};
    remote={origin:status.publicUrl!,isRemoteHost:host=>host==='worker.trycloudflare.com',authorize:cookie=>cookie==='promobridge_remote=DEVICE',status:vi.fn((options?:{includePairing?:boolean})=>{const {pairing,...publicStatus}=status;return options?.includePairing ? {...publicStatus,pairing} : publicStatus;}),pair:vi.fn((code:string)=>{if (code!=='PAIR-CODE') throw new Error('invalid');return {sessionToken:'DEVICE',expiresAt:'2026-10-19T20:00:00Z'};}),stop:vi.fn(async()=>status),revokeSessions:vi.fn(()=>status),start:vi.fn(async()=>status)};
    app=createApp({databasePath:join(directory,'db.sqlite'),whatsapp:wa,remoteAccess:remote as unknown as RemoteAccess,schedule:false,now:()=>new Date(clock),resolveUrl:async url=>url});
    server=await new Promise<Server>(resolveServer=>{const listener=app.listen(0,'127.0.0.1',()=>resolveServer(listener));});const address=server.address();if (!address || typeof address==='string') throw new Error('listener');base=`http://127.0.0.1:${address.port}`;
    token=(await (await fetch(`${base}/api/v1/session`)).json()).csrfToken;
  });
  afterEach(async()=>{server.closeIdleConnections();await new Promise<void>((resolveServer,reject)=>server.close(error=>error ? reject(error) : resolveServer()));await app.runtime.close();await rm(directory,{recursive:true,force:true});});

  it('holds manual intake for explicit approval, persists corrected data and history pagination',async()=>{
    await setup('auto');const result=await request<Offer[]>('/ingest','POST',{text:promo()});expect(result.status).toBe(200);const value=result.body[0];expect(value).toMatchObject({simulation:false,sourceId:'manual',status:'review',requiresManualApproval:true});expect(wa.sendText).not.toHaveBeenCalled();
    const approved=await approve(value);expect(approved.manuallyApprovedAt).toBe(clock.toISOString());
    const edited=await request<Offer>(`/offers/${value.id}/details`,'POST',{title:'Creme confirmado',price:39.9,previousPrice:100,coupon:'NOVO10',category:'beleza'});expect(edited.body).toMatchObject({title:'Creme confirmado',price:39.9,discount:60,status:'review',manuallyApprovedAt:null,scheduledAt:null});expect(edited.body.rewrittenText).toContain('Creme confirmado');
    const history=await request<{total:number;items:Offer[]}>('/offers/history?page=1&pageSize=1&query=Creme%20confirmado&platform=amazon&simulation=false');expect(history.body.total).toBe(1);expect(history.body.items[0].id).toBe(value.id);
    const reprocessed=await request<Offer>(`/offers/${value.id}/reprocess`,'POST',{});expect(reprocessed.body.id).toBe(value.id);expect(reprocessed.body.affiliateReceiptId).not.toBe(value.affiliateReceiptId);expect(reprocessed.body.status).toBe('review');expect(wa.sendText).not.toHaveBeenCalled();
  });

  it('keeps temporary gates queued, resumes once and moves expired offers to review',async()=>{
    await setup('auto',true);const value=await offer();expect(value.status).toBe('approved');expect(wa.sendText).not.toHaveBeenCalled();
    const settings=app.runtime.database.getSettings();settings.paused=false;await app.runtime.saveSettings(settings);await app.runtime.drain();expect(app.runtime.database.getOffer(value.id)).toMatchObject({status:'published',providerMessageId:'TEXT-1'});await app.runtime.drain();expect(wa.sendText).toHaveBeenCalledTimes(1);
    settings.paused=true;await app.runtime.saveSettings(settings);const next=(await app.runtime.ingest({text:promo(amazon.replace('B012345678','B087654321')),sourceId:source,sourceName:'Fonte',messageId:'NEXT',simulation:false}))[0];expect(next.status).toBe('approved');clock=new Date(clock.getTime()+25*3_600_000);await app.runtime.drain();expect(app.runtime.database.getOffer(next.id)).toMatchObject({status:'review',scheduledAt:null,manuallyApprovedAt:null});expect(wa.sendText).toHaveBeenCalledTimes(1);
  });

  it('caps offer and schedule validity at the affiliate receipt expiry',async()=>{
    await setup();const settings=app.runtime.database.getSettings();settings.maxOfferAgeHours=168;await app.runtime.saveSettings(settings);
    const value=await offer();expect(value.expiresAt).toBe(new Date(clock.getTime()+24*3_600_000).toISOString());
    await approve(value);expect((await request(`/offers/${value.id}/schedule`,'POST',{scheduledAt:new Date(clock.getTime()+25*3_600_000).toISOString()})).status).toBe(400);
    const shorter=app.runtime.database.getSettings();shorter.maxOfferAgeHours=6;await app.runtime.saveSettings(shorter);
    const next=(await app.runtime.ingest({text:promo(amazon.replace('B012345678','B087654321')),sourceId:source,sourceName:'Fonte',messageId:'SHORTER',simulation:false}))[0];expect(next.expiresAt).toBe(new Date(clock.getTime()+6*3_600_000).toISOString());
  });

  it('allows exact owner-confirmed links only after review and supports an explicit manual schedule',async()=>{
    await setup('manual');const settings=app.runtime.database.getSettings();settings.affiliates.shopee.enabled=true;await app.runtime.saveSettings(settings);
    const input={platform:'shopee',originalUrl:'https://shopee.com.br/product/123/456',affiliateUrl:'https://s.shopee.com.br/ABC123',ownerConfirmed:true};
    expect((await request('/affiliate-links','POST',{...input,ownerConfirmed:false})).status).toBe(400);expect((await request('/affiliate-links','POST',input)).status).toBe(200);
    const value=(await request<Offer[]>('/ingest','POST',{text:promo(input.originalUrl)})).body[0];expect(value).toMatchObject({status:'review',affiliateValid:true,affiliateMethod:'owner-reviewed'});
    const approved=await approve(value);const due=new Date(clock.getTime()+60_000).toISOString();expect((await request(`/offers/${value.id}/schedule`,'POST',{scheduledAt:due})).status).toBe(200);await app.runtime.drain();expect(wa.sendText).not.toHaveBeenCalled();clock=new Date(due);await app.runtime.drain();expect(app.runtime.database.getOffer(approved.id)).toMatchObject({status:'published',providerMessageId:'TEXT-1'});
    const exported=await request<{links:any[]}>('/affiliate-links/export');expect(exported.body.links).toHaveLength(1);expect(JSON.stringify(exported.body)).not.toMatch(/signature|receipt|secret/);
  });

  it('never treats owner confirmation as automatic API trust, and invalidates removed library links',async()=>{
    await setup('auto');const settings=app.runtime.database.getSettings();settings.affiliates.shopee.enabled=true;await app.runtime.saveSettings(settings);
    const input={platform:'shopee',originalUrl:'https://shopee.com.br/product/123/456',affiliateUrl:'https://s.shopee.com.br/ABC123',ownerConfirmed:true};
    const link=(await request<{id:string}>('/affiliate-links','POST',input)).body;
    const value=(await app.runtime.ingest({text:promo(input.originalUrl),sourceId:source,sourceName:'Fonte',messageId:'MANUAL-LINK',simulation:false}))[0];expect(value.status).toBe('review');
    await approve(value);await app.runtime.drain();expect(wa.sendText).not.toHaveBeenCalled();
    expect((await request(`/affiliate-links/${link.id}`,'DELETE')).status).toBe(200);expect((await request(`/offers/${value.id}/action`,'POST',{action:'publish'})).status).toBe(409);
    const reprocessed=await request<Offer>(`/offers/${value.id}/reprocess`,'POST',{});expect(reprocessed.body.status).toBe('blocked');expect(reprocessed.body.affiliateValid).toBe(false);expect(wa.sendText).not.toHaveBeenCalled();
  });

  it('records a human-confirmed published result without sending and preserves deduplication',async()=>{
    await setup();const value=await approve(await offer());wa.sendText.mockRejectedValueOnce(new WhatsAppSendError('uncertain',true));await request(`/offers/${value.id}/action`,'POST',{action:'publish'});
    const reconciled=await request<Offer>(`/offers/${value.id}/reconcile`,'POST',{outcome:'published',confirmed:true});expect(reconciled.body).toMatchObject({status:'published',publishedAt:clock.toISOString()});expect(wa.sendText).toHaveBeenCalledTimes(1);
    expect((await offer()).status).toBe('duplicate');expect((await request(`/offers/${value.id}/reprocess`,'POST',{})).status).toBe(409);expect((await request(`/offers/${value.id}/reconcile`,'POST',{outcome:'not_sent',confirmed:true})).status).toBe(409);
  });

  it('protects API secrets in a separate vault and returns metadata only',async()=>{
    const values={appId:'MY-APP',secret:'PRIVATE-SHOPEE-SECRET',contractConfirmed:'true'};
    const response=await request<{configured:boolean;fields:string[]}>('/affiliates/shopee/credentials','POST',{values});expect(response.status).toBe(200);expect(response.body.configured).toBe(true);expect(response.body.fields).toContain('secret');
    for (const endpoint of ['/affiliates/credentials','/state','/backup','/affiliate-links/export']) expect(JSON.stringify((await request(endpoint)).body)).not.toContain(values.secret);
    expect((await request('/affiliates/shopee/credentials','POST',{values:{...values,password:'DO-NOT-ACCEPT'}})).status).toBe(400);
    expect((await request('/affiliates/shopee/credentials','DELETE')).status).toBe(200);expect(app.runtime.affiliates.credentialStatuses().find(item=>item.platform==='shopee')?.configured).toBe(false);
  });

  it('preflights before claim and distinguishes a rejected send from an uncertain network attempt',async()=>{
    await setup();const value=await approve(await offer());wa.assertCanSend.mockRejectedValueOnce(new WhatsAppSendError('permission'));
    expect((await request(`/offers/${value.id}/action`,'POST',{action:'publish'})).status).toBe(409);expect(app.runtime.database.getOffer(value.id)?.status).toBe('approved');expect(app.runtime.database.listActivity().filter(item=>item.event==='publication.claimed')).toHaveLength(0);
    wa.sendText.mockRejectedValueOnce(new WhatsAppSendError('not transmitted'));const notSent=await request<Offer>(`/offers/${value.id}/action`,'POST',{action:'publish'});expect(notSent.body.status).toBe('review');
    await approve(notSent.body);wa.sendText.mockRejectedValueOnce(new WhatsAppSendError('ambiguous',true));const uncertain=await request<Offer>(`/offers/${value.id}/action`,'POST',{action:'publish'});expect(uncertain.body.status).toBe('uncertain');
    expect((await request(`/offers/${value.id}/reconcile`,'POST',{outcome:'not_sent',confirmed:false})).status).toBe(400);
    const reconciled=await request<Offer>(`/offers/${value.id}/reconcile`,'POST',{outcome:'not_sent',confirmed:true});expect(reconciled.body).toMatchObject({status:'review',manuallyApprovedAt:null,requiresManualApproval:true});await app.runtime.drain();expect(wa.sendText).toHaveBeenCalledTimes(2);
  });

  it('stores validated local previews, serves them and sends one image without a text retry',async()=>{
    await setup();const value=(await app.runtime.ingest({text:promo(),sourceId:source,sourceName:'Fonte',messageId:'IMAGE',simulation:false,imageThumbnailBase64:jpeg.toString('base64'),imageThumbnailMime:'image/jpeg',imageUrl:'https://attacker.invalid/image'}))[0];expect(value.mediaId).toBeTruthy();expect(value.imageUrl).toBe(`/api/v1/media/${value.mediaId}`);
    const response=await fetch(`${base}${value.imageUrl}`);expect(response.status).toBe(200);expect(response.headers.get('content-type')).toContain('image/jpeg');expect(Buffer.from(await response.arrayBuffer())).toEqual(jpeg);
    await approve(value);wa.sendImage.mockRejectedValueOnce(new WhatsAppSendError('upload uncertain',true));const sent=await request<Offer>(`/offers/${value.id}/action`,'POST',{action:'publish'});expect(sent.body.status).toBe('uncertain');expect(wa.sendImage).toHaveBeenCalledTimes(1);expect(wa.sendText).not.toHaveBeenCalled();
  });

  it('requires remote pairing before revealing API data and confines sensitive controls to localhost',async()=>{
    const rewritten=await new Promise<number|undefined>((resolveStatus,reject)=>{const outgoing=httpRequest(`${base}/api/v1/session`,{headers:{Host:'localhost','CF-Connecting-IP':'203.0.113.7'}},response=>{response.resume();resolveStatus(response.statusCode);});outgoing.on('error',reject);outgoing.end();});expect(rewritten).toBe(403);
    const forwarded=await new Promise<number|undefined>((resolveStatus,reject)=>{const outgoing=httpRequest(`${base}/api/v1/session`,{headers:{Host:'localhost','X-Forwarded-Host':'worker.trycloudflare.com'}},response=>{response.resume();resolveStatus(response.statusCode);});outgoing.on('error',reject);outgoing.end();});expect(forwarded).toBe(403);
    expect((await remoteRequest('/session')).status).toBe(401);expect((await remoteRequest('/state')).body.code).toBe('PAIRING_REQUIRED');
    expect((await remoteRequest('/account')).body.code).toBe('PAIRING_REQUIRED');
    expect((await remoteRequest('/remote/pair','POST',{code:'PAIR-CODE'},{Origin:'https://attacker.example'})).status).toBe(403);
    const pair=await remoteRequest('/remote/pair','POST',{code:'PAIR-CODE'});expect(pair.status).toBe(200);expect(pair.body.csrfToken).toBe(token);expect(pair.headers['set-cookie']?.[0]).toMatch(/HttpOnly/);expect(pair.headers['set-cookie']?.[0]).toMatch(/Secure/);expect(pair.headers['set-cookie']?.[0]).toMatch(/SameSite=Strict/);
    const headers={Cookie:'promobridge_remote=DEVICE','X-CSRF-Token':token};expect((await remoteRequest('/state','GET',undefined,headers)).status).toBe(200);
    expect((await remoteRequest('/account','GET',undefined,headers)).body).toEqual({mode:'worker',persistence:'computer'});
    const remoteStatus=await remoteRequest('/remote','GET',undefined,headers);expect(remoteStatus.body.pairing).toBeUndefined();expect(remoteStatus.body.qrDataUrl).toBeUndefined();expect((await request<any>('/remote')).body.qrDataUrl).toMatch(/^data:image\/png;base64,/);
    expect((await remoteRequest('/remote/stop','POST',{},headers)).status).toBe(403);expect((await remoteRequest('/affiliates/shopee/credentials','POST',{values:{}},headers)).status).toBe(403);expect(remote.stop).not.toHaveBeenCalled();
  });

  it('does not lock reset behind an in-progress business operation',async()=>{
    let release:(()=>void)|undefined;const operation=app.runtime.run(()=>new Promise<void>(resolveOperation=>{release=resolveOperation;}));await Promise.resolve();await app.runtime.reset();expect(wa.reset).toHaveBeenCalledTimes(1);release!();await operation;
  });
});
