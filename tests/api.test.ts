import { request as httpRequest, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, type WhatsAppTransport } from '../apps/worker/src/api.ts';
import { Database } from '../packages/db/src/index.ts';
import { defaultSettings, RISK_NOTICE_VERSION, type AppSnapshot, type Offer, type Settings, type WhatsAppStatus } from '../packages/shared/src/index.ts';

const source='123456@g.us';
const destination='987654@g.us';
const originalUrl='https://www.amazon.com.br/dp/B012345678';
const affiliateUrl=`${originalUrl}?tag=promobridge-20`;
const promo=(asin='B012345678') => `Creme hidratante facial\nDe R$ 100,00 por R$ 49,90\nCupom: BELEZA10\nFrete grátis\nhttps://www.amazon.com.br/dp/${asin}`;
const config={enabled:true,publicId:'promobridge-20',originalUrl,affiliateUrl};
const configured=():Settings => ({...defaultSettings(),riskNotice:{version:RISK_NOTICE_VERSION,acceptedAt:'2026-10-18T12:00:00.000Z'},sourceGroups:[source],destinationGroup:destination,minScore:0,quietStart:'00:00',quietEnd:'00:00'});

function transport() {
  const status:WhatsAppStatus={connected:true,connecting:false,qrDataUrl:null,user:'Dispositivo de teste',groups:[{id:source,name:'Fonte',participants:2},{id:destination,name:'Destino',participants:2}],lastError:null};
  return {
    getStatus:vi.fn(() => structuredClone(status)),
    connect:vi.fn(async () => {}),reset:vi.fn(async () => {}),
    refreshGroups:vi.fn(async () => structuredClone(status.groups)),
    sendText:vi.fn(async (_groupId:string,_text:string) => 'SENT-1'),stop:vi.fn(async () => {})
  } satisfies WhatsAppTransport;
}

describe('local versioned API with real SQLite and a fake WhatsApp transport', () => {
  let root:string;
  let path:string;
  let app:ReturnType<typeof createApp>;
  let server:Server;
  let base:string;
  let token:string;
  let wa:ReturnType<typeof transport>;
  let resolver:ReturnType<typeof vi.fn<(url:string)=>Promise<string>>>;

  async function start() {
    app=createApp({databasePath:path,whatsapp:wa,resolveUrl:resolver,schedule:false});
    server=await new Promise<Server>(resolveServer => {
      const listener=app.listen(0,'127.0.0.1',() => resolveServer(listener));
    });
    const address=server.address();
    if (!address || typeof address==='string') throw new Error('Expected TCP listener');
    base=`http://127.0.0.1:${address.port}`;
    const response=await fetch(`${base}/api/v1/session`);
    token=(await response.json() as {csrfToken:string}).csrfToken;
  }
  async function stop() {
    server.closeIdleConnections();
    await new Promise<void>((resolveServer,reject) => server.close(error => error ? reject(error) : resolveServer()));
    await app.runtime.close();
  }
  async function request<T=unknown>(endpoint:string,method='GET',body?:unknown,headers:Record<string,string>={}) {
    const response=await fetch(`${base}/api/v1${endpoint}`,{method,headers:{Origin:base,'Content-Type':'application/json','X-CSRF-Token':token,...headers},...(body===undefined ? {} : {body:JSON.stringify(body)})});
    return {status:response.status,body:await response.json() as T,headers:response.headers};
  }
  async function setup(mode:Settings['mode']='manual') {
    const settings=configured();settings.mode=mode;
    expect((await request('/settings','PUT',settings)).status).toBe(200);
    expect((await request<{valid:boolean}>('/affiliates/amazon/calibrate','POST',config)).body.valid).toBe(true);
  }
  async function ingest(asin='B012345678',messageId='MESSAGE-1') {
    const offers=await app.runtime.ingest({text:promo(asin),sourceId:source,sourceName:'Fonte',messageId,simulation:false});
    expect(offers).toHaveLength(1);
    return offers[0];
  }
  async function approved() {
    await setup();
    const offer=await ingest();
    expect(offer.status).toBe('review');
    const response=await request<Offer>(`/offers/${offer.id}/action`,'POST',{action:'approve'});
    expect(response.status).toBe(200);
    expect(response.body.status).toBe('approved');
    return response.body;
  }

  beforeEach(async () => {
    root=await mkdtemp(join(tmpdir(),'promobridge-api-'));path=join(root,'test.sqlite');
    wa=transport();resolver=vi.fn(async (url:string) => url);
    await start();
  });
  afterEach(async () => { await stop(); await rm(root,{recursive:true,force:true}); });

  it('starts with real zero counters without implicitly connecting WhatsApp or adding synthetic records', async () => {
    const response=await request<AppSnapshot>('/state');
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({offers:[],activity:[],feedbackCount:0,stats:{seen:0,published:0,review:0,blocked:0,simulated:0}});
    expect(response.body.integrations).toHaveLength(7);
    expect(response.body.integrations.every(item => item.state==='not_configured')).toBe(true);
    expect(wa.connect).not.toHaveBeenCalled();
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect((await request<{ok:boolean}>('/health')).body.ok).toBe(true);
    expect((await fetch(`${base}/api/state`)).status).toBe(404);
  });

  it('blocks hostile Host, foreign Origin, missing Origin and invalid CSRF tokens', async () => {
    // Native fetch intentionally ignores a supplied Host header. Use the raw client.
    const hostileHostStatus=await new Promise<number|undefined>((resolveStatus,reject) => {
      const outgoing=httpRequest(`${base}/api/v1/state`,{headers:{Host:'attacker.example'}},response => {response.resume();resolveStatus(response.statusCode);});
      outgoing.once('error',reject);outgoing.end();
    });
    expect(hostileHostStatus).toBe(403);
    expect((await request('/state','GET',undefined,{Origin:'https://attacker.example'})).status).toBe(403);
    expect((await request('/simulate','POST',{text:promo()},{Origin:'http://localhost'})).status).toBe(403);
    expect((await request('/simulate','POST',{text:promo()},{'X-CSRF-Token':''})).status).toBe(403);
    expect((await request('/simulate','POST',{text:promo()},{'X-CSRF-Token':'é'.repeat(64)})).status).toBe(403);
    expect((await fetch(`${base}/api/v1/simulate`,{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':token},body:JSON.stringify({text:promo()})})).status).toBe(403);
    expect((await request('/simulate','POST',{text:promo()},{'Content-Type':'text/plain'})).status).toBe(415);
    expect(wa.sendText).not.toHaveBeenCalled();
  });

  it('validates payloads and full settings without silently accepting unknown or malformed fields', async () => {
    expect((await request('/simulate','POST',{text:''})).status).toBe(400);
    expect((await request('/simulate','POST',{text:promo(),imageUrl:'http://127.0.0.1'})).status).toBe(400);
    expect((await request('/settings','PUT',{mode:'auto'})).status).toBe(400);
    const invalid=configured();invalid.sourceGroups=['someone@s.whatsapp.net'];
    expect((await request('/settings','PUT',invalid)).status).toBe(400);
    invalid.sourceGroups=[source,source];
    expect((await request('/settings','PUT',invalid)).status).toBe(400);
    invalid.sourceGroups=[source];invalid.destinationGroup=source;
    expect((await request('/settings','PUT',invalid)).status).toBe(400);
    const settings=configured();
    expect((await request('/settings','PUT',{...settings,affiliates:{...settings.affiliates,amazon:{...settings.affiliates.amazon,password:'secret'}}})).status).toBe(400);
    expect((await request('/affiliates/amazon/calibrate','POST',{...config,originalUrl:'https://private-user:private-password@www.amazon.com.br/dp/B012345678'})).status).toBe(400);
    expect((await request('/cleanup','POST',{confirm:false})).status).toBe(400);
    expect((await request('/restore','POST',{backup:{}})).status).toBe(400);
    expect(app.runtime.database.listOffers()).toHaveLength(0);
  });

  it('canonicalizes direct products without clicking affiliate URLs, and prevents forged readiness', async () => {
    await setup();
    expect(resolver).not.toHaveBeenCalled();
    expect(resolver).not.toHaveBeenCalledWith(affiliateUrl);
    const response=await request<AppSnapshot>('/state');
    expect(response.body.integrations.find(item => item.id==='amazon')?.state).toBe('ready');
    const marker=response.body.settings.affiliates.amazon.verifiedAt;
    expect(marker).toBeTruthy();
    const unchanged=response.body.settings;unchanged.affiliates.amazon.verifiedAt='2099-01-01T00:00:00.000Z';
    const saved=await request<Settings>('/settings','PUT',unchanged);
    expect(saved.body.affiliates.amazon.verifiedAt).toBe(marker);
    saved.body.affiliates.amazon.publicId='other-20';
    const changed=await request<Settings>('/settings','PUT',saved.body);
    expect(changed.body.affiliates.amazon.verifiedAt).toBeNull();
    expect((await request<AppSnapshot>('/state')).body.integrations.find(item => item.id==='amazon')?.state).toBe('needs_calibration');
  });

  it('keeps calibration blocked after unsafe resolution, mismatched products and unsupported mechanisms', async () => {
    resolver.mockRejectedValueOnce(new Error('private DNS target'));
    const failed=await request<{valid:boolean;reason:string}>('/affiliates/amazon/calibrate','POST',{...config,originalUrl:'https://amzn.to/unsafe'});
    expect(failed.status).toBe(200);expect(failed.body.valid).toBe(false);
    expect(failed.body.reason).not.toContain('private DNS target');
    const mismatch=await request<{valid:boolean}>('/affiliates/amazon/calibrate','POST',{...config,affiliateUrl:affiliateUrl.replace('B012345678','B087654321')});
    expect(mismatch.body.valid).toBe(false);
    const unsupported=await request<{valid:boolean}>('/affiliates/shopee/calibrate','POST',{...config,originalUrl:'https://shopee.com.br/product/123/456',affiliateUrl:'https://shopee.com.br/product/123/456'});
    expect(unsupported.body.valid).toBe(false);
    expect(app.runtime.database.getSettings().affiliates.amazon.verifiedAt).toBeNull();
  });

  it('forces simulator isolation despite real-source and simulation:false inputs and persists every product', async () => {
    await setup('auto');
    const response=await request<Offer[]>('/simulate','POST',{text:`${promo()}\n\n${promo('B087654321')}`,sourceId:source,sourceName:'Mascarado',messageId:'real-message',simulation:false});
    expect(response.status).toBe(200);expect(response.body).toHaveLength(2);
    for (const offer of response.body) {
      expect(offer).toMatchObject({simulation:true,sourceId:'simulator',sourceName:'Simulador',status:'simulated'});
      expect((await request(`/offers/${offer.id}/action`,'POST',{action:'publish'})).status).toBe(409);
    }
    await app.runtime.drain();
    expect(wa.sendText).not.toHaveBeenCalled();
    expect(app.runtime.database.listOffers()).toHaveLength(2);
    const reopened=new Database(path);
    expect(reopened.listOffers()).toHaveLength(2);reopened.close();
  });

  it('persists simulated manual review, edits, rejection and feedback without sending', async () => {
    await setup();
    const response=await request<Offer[]>('/simulate','POST',{text:promo()});
    const offer=response.body[0];expect(offer.status).toBe('review');
    const edited=await request<Offer>(`/offers/${offer.id}/action`,'POST',{action:'edit',text:`${offer.rewrittenText}\nRevisado.`});
    expect(edited.status).toBe(200);expect(edited.body.status).toBe('review');
    const rejected=await request<Offer>(`/offers/${offer.id}/action`,'POST',{action:'reject',reason:'Exemplo revisado'});
    expect(rejected.body.status).toBe('rejected');
    expect((await request<AppSnapshot>('/state')).body.feedbackCount).toBe(2);
    const reopened=new Database(path);expect(reopened.listFeedback()).toHaveLength(2);expect(reopened.getOffer(offer.id)?.status).toBe('rejected');reopened.close();
    expect(wa.sendText).not.toHaveBeenCalled();
  });

  it('returns a persisted blocked result for credential URLs without exposing the supplied credentials', async () => {
    const result=await request<Offer[]>('/simulate','POST',{text:promo().replace('https://www.amazon.com.br/','https://private-user:private-password@www.amazon.com.br/')});
    expect(result.status).toBe(200);expect(result.body[0].status).toBe('blocked');
    expect(JSON.stringify(result.body)).not.toContain('private-user');
    expect(JSON.stringify(result.body)).not.toContain('private-password');
    expect(app.runtime.database.listOffers()).toHaveLength(1);
    expect(JSON.stringify(app.runtime.database.backup())).not.toContain('private-password');
    expect(wa.sendText).not.toHaveBeenCalled();
  });

  it('holds a custom template with an unsafe signature link for review and blocks publication', async () => {
    await setup('auto');
    const settings=app.runtime.database.getSettings();settings.message.signature='Conheça https://attacker.example/checkout';
    await app.runtime.saveSettings(settings);
    const offer=await ingest();expect(offer.status).toBe('review');
    expect((await request(`/offers/${offer.id}/action`,'POST',{action:'approve'})).status).toBe(200);
    expect((await request(`/offers/${offer.id}/action`,'POST',{action:'publish'})).status).toBe(409);
    await app.runtime.drain();
    expect(wa.sendText).not.toHaveBeenCalled();
  });

  it('ignores unauthorized sources and destination messages, and deduplicates repeated deliveries', async () => {
    await setup();
    const input={text:promo(),sourceId:'111111@g.us',sourceName:'Não autorizada',messageId:'MESSAGE',simulation:false};
    expect(await app.runtime.ingest(input)).toEqual([]);
    expect(await app.runtime.ingest({...input,sourceId:destination})).toEqual([]);
    await ingest();
    expect(await app.runtime.ingest({...input,sourceId:source,messageId:'MESSAGE-1'})).toEqual([]);
    expect(app.runtime.database.listOffers()).toHaveLength(1);
    expect(wa.sendText).not.toHaveBeenCalled();
  });

  it('requires approval, records a durable claim before sending and prevents concurrent duplicate publication', async () => {
    const offer=await approved();
    wa.sendText.mockImplementationOnce(async (groupId,text) => {
      expect(groupId).toBe(destination);expect(text).toContain(affiliateUrl);
      expect(app.runtime.database.getOffer(offer.id)?.status).toBe('publishing');
      return 'ACK-1';
    });
    const results=await Promise.all([request<Offer>(`/offers/${offer.id}/action`,'POST',{action:'publish'}),request<Offer>(`/offers/${offer.id}/action`,'POST',{action:'publish'})]);
    expect(results.map(result => result.status).sort()).toEqual([200,409]);
    expect(app.runtime.database.getOffer(offer.id)?.status).toBe('published');
    expect(wa.sendText).toHaveBeenCalledTimes(1);
    expect(app.runtime.database.listFeedback()).toHaveLength(1);
    expect(app.runtime.database.listActivity().some(item => item.event==='publication.claimed')).toBe(true);
  });

  it('serializes automatic ingestion and sends concurrent deliveries of the same product at most once', async () => {
    await setup('auto');
    const makeInput=(messageId:string) => ({text:promo(),sourceId:source,sourceName:'Fonte',messageId,simulation:false});
    const [first,second]=await Promise.all([app.runtime.ingest(makeInput('AUTO-1')),app.runtime.ingest(makeInput('AUTO-2'))]);
    expect(first[0].status).toBe('published');expect(second[0].status).toBe('duplicate');
    await app.runtime.drain();expect(wa.sendText).toHaveBeenCalledTimes(1);
  });

  it.each(['external URL','new product','changed affiliate configuration'] as const)('revalidates %s before a manual send', async change => {
    const offer=await approved();
    if (change==='changed affiliate configuration') {
      const settings=app.runtime.database.getSettings();settings.affiliates.amazon.publicId='changed-20';
      expect((await request('/settings','PUT',settings)).status).toBe(200);
    } else {
      const text=change==='external URL' ? `${offer.rewrittenText}\nhttps://attacker.example/checkout` : offer.rewrittenText.replaceAll('B012345678','B087654321');
      expect((await request(`/offers/${offer.id}/action`,'POST',{action:'edit',text})).status).toBe(200);
      expect((await request(`/offers/${offer.id}/action`,'POST',{action:'approve'})).status).toBe(200);
    }
    expect((await request(`/offers/${offer.id}/action`,'POST',{action:'publish'})).status).toBe(409);
    expect(wa.sendText).not.toHaveBeenCalled();
    expect(app.runtime.database.getOffer(offer.id)?.status).toBe('approved');
  });

  it('retains an ambiguous send as uncertain across restart and never sends it again', async () => {
    const offer=await approved();
    wa.sendText.mockRejectedValueOnce(new Error('Network failed after provider accepted the message'));
    const result=await request<Offer>(`/offers/${offer.id}/action`,'POST',{action:'publish'});
    expect(result.status).toBe(200);expect(result.body.status).toBe('uncertain');
    await stop();await start();
    expect(app.runtime.database.getOffer(offer.id)?.status).toBe('uncertain');
    expect((await request(`/offers/${offer.id}/action`,'POST',{action:'publish'})).status).toBe(409);
    const settings=app.runtime.database.getSettings();settings.mode='auto';await app.runtime.saveSettings(settings);await app.runtime.drain();
    expect(wa.sendText).toHaveBeenCalledTimes(1);
  });

  it('recovers an interrupted persistent claim as uncertain on restart', async () => {
    const offer=await approved();offer.status='publishing';app.runtime.database.saveOffer(offer);
    await stop();await start();
    expect(app.runtime.database.getOffer(offer.id)?.status).toBe('uncertain');
    expect((await request(`/offers/${offer.id}/action`,'POST',{action:'publish'})).status).toBe(409);
    expect(wa.sendText).not.toHaveBeenCalled();
  });

  it('restores operational data without importing session credentials or bypassing calibration', async () => {
    const offer=await approved();
    const backup=(await request<{settings:Settings}>('/backup')).body;
    expect(JSON.stringify(backup)).not.toContain('authDir');
    expect((await request(`/offers/${offer.id}/action`,'POST',{action:'publish'})).status).toBe(200);
    const restored=await request<{preserved:number;recalibrationRequired:boolean}>('/restore','POST',{backup});
    expect(restored.status).toBe(200);expect(restored.body).toMatchObject({preserved:1,recalibrationRequired:true});
    expect(app.runtime.database.getOffer(offer.id)?.status).toBe('published');
    expect(app.runtime.database.getSettings().affiliates.amazon.verifiedAt).toBeNull();
    expect((await request(`/offers/${offer.id}/action`,'POST',{action:'publish'})).status).toBe(409);
    expect(wa.sendText).toHaveBeenCalledTimes(1);
  });

  it('connects, refreshes groups and resets only in response to explicit panel actions', async () => {
    expect(wa.connect).not.toHaveBeenCalled();
    expect((await request('/whatsapp/connect','POST',{})).status).toBe(200);
    expect((await request('/whatsapp/groups')).body).toHaveLength(2);
    expect((await request('/whatsapp/reset','POST',{})).status).toBe(200);
    expect(wa.connect).toHaveBeenCalledTimes(1);expect(wa.reset).toHaveBeenCalledTimes(1);expect(wa.refreshGroups).toHaveBeenCalledTimes(1);
    expect((await request('/offers/missing/action','POST',{action:'reject'})).status).toBe(404);
  });
});
