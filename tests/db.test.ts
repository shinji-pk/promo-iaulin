import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Database } from '../packages/db/src/index.ts';
import { defaultSettings, type Offer } from '../packages/shared/src/index.ts';

const databases: Database[] = [];
const directories: string[] = [];
function database(path = ':memory:') { const db = new Database(path); databases.push(db); return db; }
function offer(overrides: Partial<Offer> = {}): Offer {
  const time = new Date().toISOString();
  return { id:'offer-a', createdAt:time, updatedAt:time, sourceId:'source', sourceName:'Fonte autorizada', sourceMessageId:'message-a',simulation:false,
    originalText:'Organizador por R$ 59,90',originalUrl:'https://www.amazon.com.br/dp/B0ABC12345',canonicalUrl:'https://www.amazon.com.br/dp/B0ABC12345',affiliateUrl:null,
    productKey:'amazon:B0ABC12345',platform:'amazon',productId:'B0ABC12345',title:'Organizador',price:59.90,previousPrice:null,discount:null,coupon:null,freeShipping:false,
    category:'casa',score:75,confidence:0.95,factors:[],affiliateValid:false,reasons:[],stages:[],rewrittenText:'Organizador',status:'review',publishedAt:null,...overrides };
}
afterEach(() => { for (const db of databases.splice(0)) db.close(); for (const directory of directories.splice(0)) rmSync(directory,{recursive:true,force:true}); });

describe('persistência e recuperação', () => {
  it('preserva configuração e recupera envio interrompido sem reenviar', () => {
    const dir=mkdtempSync(join(tmpdir(),'promobridge-db-')); directories.push(dir);
    const path=join(dir,'data.sqlite');
    const first=database(path);
    first.saveSettings({...defaultSettings(),minScore:84});
    first.saveOffer(offer({status:'publishing'}));
    first.close();
    const restarted=database(path);
    expect(restarted.getSettings().minScore).toBe(84);
    expect(restarted.getOffer('offer-a')?.status).toBe('uncertain');
    expect(restarted.listActivity().some(event=>event.event==='publication.uncertain')).toBe(true);
  });

  it('impede duas reservas de envio do mesmo produto, sem bloquear simulação', () => {
    const db=database(); db.saveOffer(offer({status:'publishing'}));
    expect(()=>db.saveOffer(offer({id:'offer-b',status:'publishing'}))).toThrow();
    expect(()=>db.saveOffer(offer({id:'simulation',status:'publishing',simulation:true}))).not.toThrow();
  });

  it('rejeita backup inválido sem apagar a configuração atual', () => {
    const db=database(); db.saveSettings({...defaultSettings(),minScore:83}); db.saveOffer(offer());
    const backup=db.backup();
    expect(()=>db.restore({...backup,unexpectedSecret:'no'})).toThrow();
    expect(db.getSettings().minScore).toBe(83);
    expect(db.listOffers()).toHaveLength(1);
    expect(()=>db.restore({...backup,offers:[...backup.offers,...backup.offers]})).toThrow();
  });

  it('restaurar backup antigo preserva evidência de envios posteriores', () => {
    const db=database(); const backup=db.backup();
    db.saveOffer(offer({status:'published',publishedAt:new Date().toISOString()}));
    db.saveOffer(offer({id:'offer-b',productKey:'amazon:OTHER',status:'uncertain'}));
    const result=db.restore(backup);
    expect(result.preserved).toBe(2);
    expect(db.getOffer('offer-a')?.status).toBe('published');
    expect(db.getOffer('offer-b')?.status).toBe('uncertain');
    expect(JSON.stringify(db.backup())).not.toContain('creds.json');
  });

  it('limpa ofertas antigas, preservando envios recentes e incertos', () => {
    const db=database(); const old=new Date(Date.now()-120*86400000).toISOString();
    db.saveOffer(offer({id:'old',createdAt:old,updatedAt:old}));
    db.saveOffer(offer({id:'recent-send',createdAt:old,updatedAt:old,status:'published',publishedAt:new Date().toISOString()}));
    db.saveOffer(offer({id:'uncertain',createdAt:old,updatedAt:old,status:'uncertain'}));
    expect(db.cleanup().offers).toBe(1);
    expect(db.listOffers().map(item=>item.id).sort()).toEqual(['recent-send','uncertain']);
  });

  it('migra um banco V1 real sem perder ofertas, preferências, feedback ou atividade', () => {
    const dir=mkdtempSync(join(tmpdir(),'promobridge-v1-')); directories.push(dir);
    const path=join(dir,'legacy.sqlite'), legacy=new DatabaseSync(path);
    legacy.exec(`CREATE TABLE settings (id INTEGER PRIMARY KEY CHECK(id=1),body TEXT NOT NULL);
      CREATE TABLE offers (id TEXT PRIMARY KEY,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,product_key TEXT NOT NULL,source_message_id TEXT NOT NULL,simulation INTEGER NOT NULL,status TEXT NOT NULL,published_at TEXT,body TEXT NOT NULL);
      CREATE INDEX offers_created ON offers(created_at DESC);
      CREATE INDEX offers_product ON offers(product_key,published_at DESC);
      CREATE INDEX offers_source ON offers(source_message_id,simulation);
      CREATE INDEX offers_status ON offers(status,simulation,created_at);
      CREATE UNIQUE INDEX offers_single_claim ON offers(product_key) WHERE status='publishing' AND simulation=0 AND product_key<>'';
      CREATE TABLE feedback (id TEXT PRIMARY KEY,offer_id TEXT NOT NULL,created_at TEXT NOT NULL,body TEXT NOT NULL);
      CREATE INDEX feedback_created ON feedback(created_at DESC);
      CREATE TABLE activity (id TEXT PRIMARY KEY,created_at TEXT NOT NULL,body TEXT NOT NULL);
      CREATE INDEX activity_created ON activity(created_at DESC);
      PRAGMA user_version=1;`);
    const preferences:Record<string,unknown>={...defaultSettings(),minScore:88};delete preferences.maxOfferAgeHours;
    const old=offer(), interrupted=offer({id:'interrupted',productKey:'amazon:OTHER',status:'publishing'});
    legacy.prepare('INSERT INTO settings VALUES(1,?)').run(JSON.stringify(preferences));
    for (const item of [old,interrupted]) legacy.prepare('INSERT INTO offers VALUES(?,?,?,?,?,?,?,?,?)').run(item.id,item.createdAt,item.updatedAt,item.productKey,item.sourceMessageId,0,item.status,item.publishedAt,JSON.stringify(item));
    const feedback={id:'feedback-1',offerId:old.id,action:'edit',category:'casa',reason:'Preço conferido',createdAt:old.createdAt};
    legacy.prepare('INSERT INTO feedback VALUES(?,?,?,?)').run(feedback.id,old.id,old.createdAt,JSON.stringify(feedback));
    const activity={id:'activity-1',createdAt:old.createdAt,level:'info',event:'settings.saved',message:'Preferências existentes'};
    legacy.prepare('INSERT INTO activity VALUES(?,?,?)').run(activity.id,activity.createdAt,JSON.stringify(activity));
    legacy.close();
    const db=database(path);
    expect(db.getSettings()).toMatchObject({minScore:88,maxOfferAgeHours:24});
    expect(db.getOffer(old.id)).toEqual(old);
    expect(db.getOffer(interrupted.id)?.status).toBe('uncertain');
    expect(db.listFeedback()).toEqual([feedback]);
    expect(db.listActivity()).toContainEqual(activity);
    db.putRecord('affiliate-links','link-1',{url:'https://example.com/product'});
    db.close();
    const inspect=new DatabaseSync(path);
    expect(inspect.prepare('PRAGMA user_version').get()?.user_version).toBe(2);
    expect(inspect.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map(row=>row.name)).toEqual(expect.arrayContaining(['offers_history','offers_platform','offers_simulation','offers_single_claim']));
    inspect.close();
    const reopened=database(path);
    expect(reopened.getRecord('affiliate-links','link-1')).toEqual({url:'https://example.com/product'});
    expect(reopened.listOffers()).toHaveLength(2);
  });

  it('isola e persiste registros JSON por namespace com atualização e remoção', () => {
    const dir=mkdtempSync(join(tmpdir(),'promobridge-records-')); directories.push(dir);
    const path=join(dir,'data.sqlite'), first=database(path);
    first.putRecord('affiliate-links','same-id',{url:'first'});
    first.putRecord('affiliate-receipts','same-id',{signature:'opaque-proof'});
    first.putRecord('affiliate-links','same-id',{url:'updated'});
    first.putRecord('affiliate-links','other-id',{url:'other'});
    first.close();
    const db=database(path);
    expect(db.getRecord<{url:string}>('affiliate-links','same-id')?.url).toBe('updated');
    expect(db.listRecords('affiliate-links')).toHaveLength(2);
    db.deleteRecord('affiliate-links','other-id');
    expect(db.listRecords('affiliate-links')).toEqual([{url:'updated'}]);
    db.clearRecords('affiliate-links');
    expect(db.getRecord('affiliate-links','same-id')).toBeUndefined();
    expect(db.getRecord('affiliate-receipts','same-id')).toEqual({signature:'opaque-proof'});
    expect(()=>db.putRecord('affiliate-links','bad',undefined)).toThrow('Registro JSON');
    expect(()=>db.putRecord('affiliate-links','large',{text:'x'.repeat(1_048_576)})).toThrow('1 MB');
    expect(()=>db.putRecord("links'; DROP TABLE offers; --",'id',{})).toThrow();
    expect(db.listOffers()).toEqual([]);
  });

  it('aceita campos operacionais opcionais e imagens locais apenas na rota de mídia', () => {
    const db=database(), time=new Date().toISOString(), mediaId='3dc6c552-d0c3-46e9-ae96-4d903d45f519';
    const item=offer({affiliateReceiptId:'receipt-1',affiliateMethod:'official-api',requiresManualApproval:false,
      manuallyApprovedAt:time,scheduledAt:time,expiresAt:time,providerMessageId:'PROVIDER-1',mediaId,imageUrl:`/api/v1/media/${mediaId}`});
    expect(db.saveOffer(item)).toEqual(item);
    expect(db.getOffer(item.id)).toEqual(item);
    expect(()=>db.saveOffer({...item,imageUrl:'/api/v1/media/../../creds.json'})).toThrow();
    expect(()=>db.saveOffer({...item,imageUrl:'//other.example/media'})).toThrow();
    expect(()=>db.saveOffer({...item,imageUrl:`/api/v1/media/${mediaId}?file=secret`})).toThrow();
    expect(()=>db.saveOffer({...item,mediaId:'../../secret'})).toThrow();
    expect(()=>db.saveOffer({...item,scheduledAt:'tomorrow'})).toThrow();
    expect(db.saveOffer(offer({id:'legacy-image',imageUrl:'https://images.example.com/image.jpg'})).imageUrl).toContain('https://');
  });

  it('busca e pagina em SQL com filtros combinados e ordem estável', () => {
    const db=database();
    for (let index=0;index<5;index++) {
      const time=`2026-10-18T12:0${index}:00.000Z`, title=`Achado ${index}`;
      db.saveOffer(offer({id:`item-${index}`,createdAt:time,updatedAt:time,title,originalText:title,productKey:`amazon:${index}`,
        status:index===0 ? 'published' : 'review',platform:index===1 ? 'shopee' : 'amazon',simulation:index===4,coupon:index===2 ? 'CASA10' : null}));
    }
    expect(db.searchOffers({page:2,pageSize:2})).toMatchObject({total:5,page:2,pageSize:2,items:[{id:'item-2'},{id:'item-1'}]});
    expect(db.searchOffers({status:'review',platform:'amazon',simulation:false}).items.map(item=>item.id)).toEqual(['item-3','item-2']);
    expect(db.searchOffers({query:'casa10'}).items.map(item=>item.id)).toEqual(['item-2']);
    expect(db.searchOffers({query:'  Achado 1  '}).items.map(item=>item.id)).toEqual(['item-1']);
    expect(db.searchOffers({page:10,pageSize:2})).toMatchObject({total:5,items:[]});
    const tie=offer({id:'tie-z',createdAt:'2026-10-18T12:03:00.000Z',updatedAt:'2026-10-18T12:03:00.000Z'});
    db.saveOffer(tie);
    expect(db.searchOffers({pageSize:3}).items.map(item=>item.id)).toEqual(['item-4','tie-z','item-3']);
  });

  it('trata curingas e SQL como busca literal e recusa paginação sem limites', () => {
    const db=database();
    db.saveOffer(offer({title:'Oferta 50%_OFF',originalText:'Preço conferido'}));
    db.saveOffer(offer({id:'other',title:'Oferta 50abcOFF',originalText:'Outra oferta'}));
    expect(db.searchOffers({query:'%_'}).items.map(item=>item.id)).toEqual(['offer-a']);
    expect(db.searchOffers({query:"' OR 1=1 --"})).toMatchObject({total:0,items:[]});
    expect(()=>db.searchOffers({page:0})).toThrow();
    expect(()=>db.searchOffers({pageSize:101})).toThrow();
    expect(()=>db.searchOffers({page:Number.POSITIVE_INFINITY})).toThrow();
    expect(()=>db.searchOffers({query:'x'.repeat(201)})).toThrow();
    expect(db.searchOffers().total).toBe(2);
  });

  it('restaura backup V1 removendo confiança e conservando biblioteca e envios protegidos', () => {
    const db=database(), now=new Date().toISOString();
    db.saveOffer(offer({affiliateValid:true,affiliateReceiptId:'restored-receipt',manuallyApprovedAt:now,status:'approved'}));
    const backup=db.backup();
    const legacySettings:Record<string,unknown>={...backup.settings};delete legacySettings.maxOfferAgeHours;
    db.putRecord('affiliate-receipts','proof',{signature:'receipt-proof'});
    db.putRecord('affiliate-connections','amazon',{signature:'connection-proof'});
    db.putRecord('affiliate-links','manual-link',{signature:'library-proof'});
    const protectedOffer=offer({id:'confirmed',status:'published',publishedAt:now,affiliateValid:true,affiliateReceiptId:'local-receipt',providerMessageId:'sent-1'});
    db.saveOffer(protectedOffer);
    db.saveOffer(offer({id:'inflight',productKey:'amazon:OTHER',status:'publishing',providerMessageId:'pending-1'}));
    expect(JSON.stringify(db.backup())).not.toContain('library-proof');
    const result=db.restore({...backup,settings:legacySettings});
    expect(result).toEqual({offers:3,preserved:2,recalibrationRequired:true});
    expect(db.getOffer('offer-a')).toMatchObject({affiliateValid:false,affiliateReceiptId:null,manuallyApprovedAt:null,status:'review'});
    expect(db.getOffer('confirmed')).toEqual(protectedOffer);
    expect(db.getOffer('inflight')).toMatchObject({status:'uncertain',providerMessageId:'pending-1'});
    expect(db.getSettings().maxOfferAgeHours).toBe(24);
    expect(db.listRecords('affiliate-receipts')).toEqual([]);
    expect(db.listRecords('affiliate-connections')).toEqual([]);
    expect(db.getRecord('affiliate-links','manual-link')).toEqual({signature:'library-proof'});
  });
});
