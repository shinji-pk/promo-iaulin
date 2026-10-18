import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
});
