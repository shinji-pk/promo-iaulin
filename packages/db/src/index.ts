import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { categoryIds, platformIds, settingsSchema, defaultSettings, type Settings, type Offer, type Feedback, type Activity } from '../../shared/src/index.ts';

const timestamp = z.iso.datetime({ offset: true });
const boundedText = z.string().max(32000);
const safeUrl = z.string().max(4096).refine(value => {
  if (!value) return true;
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password; } catch { return false; }
}, 'URL inválida');
export const offerSchema = z.object({
  id:z.string().min(1).max(200), createdAt:timestamp, updatedAt:timestamp,
  sourceId:z.string().max(100), sourceName:z.string().max(100), sourceMessageId:z.string().max(200),
  simulation:z.boolean(), originalText:boundedText, originalUrl:safeUrl, canonicalUrl:safeUrl,
  affiliateUrl:safeUrl.nullable(), productKey:z.string().max(500), platform:z.enum(platformIds).nullable(), productId:z.string().max(200).nullable(),
  title:z.string().max(1000), price:z.number().min(0).max(1e10).nullable(), previousPrice:z.number().min(0).max(1e10).nullable(),
  discount:z.number().min(0).max(100).nullable(), coupon:z.string().max(240).nullable(), freeShipping:z.boolean(),
  category:z.enum(categoryIds), score:z.number().min(0).max(100), confidence:z.number().min(0).max(1),
  factors:z.array(z.object({label:z.string().max(300),points:z.number().min(-100).max(100)}).strict()).max(100),
  affiliateValid:z.boolean(), reasons:z.array(z.string().max(2000)).max(100),
  stages:z.array(z.object({name:z.string().max(200),status:z.enum(['ok','blocked','pending']),detail:z.string().max(2000)}).strict()).max(100),
  rewrittenText:boundedText, status:z.enum(['review','approved','rejected','duplicate','blocked','publishing','published','simulated','failed','uncertain']),
  publishedAt:timestamp.nullable(), imageUrl:safeUrl.nullable().optional()
}).strict();
const feedbackSchema = z.object({id:z.string().min(1).max(200),offerId:z.string().min(1).max(200),action:z.enum(['approve','reject','edit']),category:z.enum(categoryIds),reason:z.string().max(2000),createdAt:timestamp}).strict();
const activitySchema = z.object({id:z.string().min(1).max(200),createdAt:timestamp,level:z.enum(['info','warning','error']),event:z.string().max(200),message:z.string().max(3000),offerId:z.string().max(200).optional()}).strict();
const strictSettings = settingsSchema.strict().extend({
  audience:settingsSchema.shape.audience.unwrap().strict(),
  message:settingsSchema.shape.message.unwrap().strict()
});
export const backupSchema = z.object({schemaVersion:z.literal(1),exportedAt:timestamp,settings:strictSettings,offers:z.array(offerSchema).max(50000),feedback:z.array(feedbackSchema).max(100000),activity:z.array(activitySchema).max(100000)}).strict().superRefine((data, context) => {
  for (const key of ['offers','feedback','activity'] as const) {
    if (new Set(data[key].map(item => item.id)).size !== data[key].length) context.addIssue({code:'custom',path:[key],message:'IDs repetidos no backup'});
  }
});
export type Backup = z.infer<typeof backupSchema>;

/** Operational data only. WhatsApp credentials never enter this database or its backups. */
export class Database {
  private readonly connection: DatabaseSync;
  private readonly path: string;
  private closed = false;

  constructor(path = resolve('data/promobridge.sqlite')) {
    this.path = path;
    if (path !== ':memory:') mkdirSync(dirname(resolve(path)), {recursive:true});
    this.connection = new DatabaseSync(path);
    this.connection.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
    const version = Number((this.connection.prepare('PRAGMA user_version').get() as {user_version:number}).user_version);
    if (version > 1) { this.connection.close(); throw new Error('Banco criado por uma versão mais recente.'); }
    if (version === 0) this.connection.exec(`BEGIN IMMEDIATE;
      CREATE TABLE settings (id INTEGER PRIMARY KEY CHECK(id=1), body TEXT NOT NULL);
      CREATE TABLE offers (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, product_key TEXT NOT NULL, source_message_id TEXT NOT NULL, simulation INTEGER NOT NULL, status TEXT NOT NULL, published_at TEXT, body TEXT NOT NULL);
      CREATE INDEX offers_created ON offers(created_at DESC);
      CREATE INDEX offers_product ON offers(product_key, published_at DESC);
      CREATE INDEX offers_source ON offers(source_message_id, simulation);
      CREATE INDEX offers_status ON offers(status, simulation, created_at);
      CREATE UNIQUE INDEX offers_single_claim ON offers(product_key) WHERE status='publishing' AND simulation=0 AND product_key<>'';
      CREATE TABLE feedback (id TEXT PRIMARY KEY, offer_id TEXT NOT NULL, created_at TEXT NOT NULL, body TEXT NOT NULL);
      CREATE INDEX feedback_created ON feedback(created_at DESC);
      CREATE TABLE activity (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, body TEXT NOT NULL);
      CREATE INDEX activity_created ON activity(created_at DESC);
      PRAGMA user_version=1; COMMIT;`);
    if (!this.connection.prepare('SELECT id FROM settings WHERE id=1').get()) this.saveSettings(defaultSettings());
    // A crash after the provider accepted a message cannot safely be retried.
    this.transaction(() => {
      for (const offer of this.listOffers().filter(item => item.status === 'publishing')) {
        offer.status = 'uncertain'; offer.updatedAt = new Date().toISOString();
        offer.reasons = [...offer.reasons, 'Processo interrompido durante o envio. Confira o WhatsApp; não haverá reenvio automático.'];
        this.saveOffer(offer);
        this.addActivity({id:randomUUID(),createdAt:offer.updatedAt,level:'warning',event:'publication.uncertain',message:'Envio interrompido recuperado para conferência manual.',offerId:offer.id});
      }
    });
  }

  transaction<T>(operation: () => T): T {
    this.connection.exec('BEGIN IMMEDIATE');
    try { const result = operation(); this.connection.exec('COMMIT'); return result; }
    catch (error) { this.connection.exec('ROLLBACK'); throw error; }
  }
  getSettings(): Settings { return settingsSchema.parse(JSON.parse(String(this.connection.prepare('SELECT body FROM settings WHERE id=1').get()!.body))); }
  saveSettings(settings: Settings): Settings {
    const value = strictSettings.parse(settings);
    this.connection.prepare('INSERT INTO settings(id,body) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(JSON.stringify(value));
    return value;
  }
  listOffers(limit?: number): Offer[] {
    const rows = limit === undefined ? this.connection.prepare('SELECT body FROM offers ORDER BY created_at DESC, id DESC').all() : this.connection.prepare('SELECT body FROM offers ORDER BY created_at DESC, id DESC LIMIT ?').all(limit);
    return rows.map(row => offerSchema.parse(JSON.parse(String(row.body))));
  }
  getOffer(id: string): Offer | undefined {
    const row = this.connection.prepare('SELECT body FROM offers WHERE id=?').get(id);
    return row ? offerSchema.parse(JSON.parse(String(row.body))) : undefined;
  }
  saveOffer(offer: Offer): Offer {
    const value = offerSchema.parse(offer);
    this.connection.prepare(`INSERT INTO offers(id,created_at,updated_at,product_key,source_message_id,simulation,status,published_at,body) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at,product_key=excluded.product_key,source_message_id=excluded.source_message_id,simulation=excluded.simulation,status=excluded.status,published_at=excluded.published_at,body=excluded.body`).run(value.id,value.createdAt,value.updatedAt,value.productKey,value.sourceMessageId,Number(value.simulation),value.status,value.publishedAt,JSON.stringify(value));
    return value;
  }
  listFeedback(): Feedback[] { return this.connection.prepare('SELECT body FROM feedback ORDER BY created_at DESC').all().map(row => feedbackSchema.parse(JSON.parse(String(row.body)))); }
  saveFeedback(feedback: Feedback): void {
    const value = feedbackSchema.parse(feedback);
    this.connection.prepare('INSERT INTO feedback(id,offer_id,created_at,body) VALUES(?,?,?,?)').run(value.id,value.offerId,value.createdAt,JSON.stringify(value));
  }
  listActivity(limit = 200): Activity[] { return this.connection.prepare('SELECT body FROM activity ORDER BY created_at DESC, rowid DESC LIMIT ?').all(limit).map(row => activitySchema.parse(JSON.parse(String(row.body)))); }
  addActivity(activity: Activity): void {
    const value = activitySchema.parse(activity);
    this.connection.prepare('INSERT INTO activity(id,created_at,body) VALUES(?,?,?)').run(value.id,value.createdAt,JSON.stringify(value));
  }
  stats(): {seen:number;published:number;review:number;blocked:number;simulated:number} {
    const result = {seen:0,published:0,review:0,blocked:0,simulated:0};
    for (const row of this.connection.prepare('SELECT status,COUNT(*) AS count FROM offers GROUP BY status').all()) {
      const count = Number(row.count); result.seen += count;
      if (row.status === 'published') result.published += count;
      if (row.status === 'review' || row.status === 'approved') result.review += count;
      if (['blocked','duplicate','failed','uncertain'].includes(String(row.status))) result.blocked += count;
      if (row.status === 'simulated') result.simulated += count;
    }
    return result;
  }
  databaseBytes(): number {
    if (this.path === ':memory:') return 0;
    return [this.path,`${this.path}-wal`,`${this.path}-shm`].reduce((sum,path) => { try { return sum + statSync(path).size; } catch { return sum; } },0);
  }
  backup(): Backup { return {schemaVersion:1,exportedAt:new Date().toISOString(),settings:this.getSettings(),offers:this.listOffers(),feedback:this.listFeedback(),activity:this.listActivity(100000)}; }
  restore(input: unknown): {offers:number;preserved:number;recalibrationRequired:boolean} {
    const backup = backupSchema.parse(input);
    // Restoring an older file must not erase evidence of a send performed afterwards.
    const protectedOffers = this.listOffers().filter(offer => !offer.simulation && ['published','publishing','uncertain'].includes(offer.status));
    const merged = new Map(backup.offers.map(offer => [offer.id,offer]));
    for (const offer of protectedOffers) merged.set(offer.id,offer);
    for (const offer of merged.values()) if (offer.status === 'publishing') { offer.status='uncertain'; offer.updatedAt=new Date().toISOString(); offer.reasons.push('Backup de envio em andamento: confira o WhatsApp antes de qualquer nova ação.'); }
    // A JSON file cannot attest calibration of an affiliate account.
    for (const affiliate of Object.values(backup.settings.affiliates)) affiliate.verifiedAt = null;
    this.transaction(() => {
      this.connection.exec('DELETE FROM feedback; DELETE FROM activity; DELETE FROM offers;');
      this.saveSettings(backup.settings);
      for (const offer of merged.values()) this.saveOffer(offer);
      for (const feedback of backup.feedback) this.saveFeedback(feedback);
      for (const activity of backup.activity) this.addActivity(activity);
      this.addActivity({id:randomUUID(),createdAt:new Date().toISOString(),level:'warning',event:'backup.restored',message:'Backup restaurado; histórico de envios preservado e lojas precisam de nova calibração.'});
    });
    return {offers:merged.size,preserved:protectedOffers.length,recalibrationRequired:true};
  }
  cleanup(now = new Date()): {offers:number;feedback:number;activity:number} {
    const settings = this.getSettings();
    const cutoff = new Date(now.getTime() - Math.max(settings.retentionDays,settings.dedupeDays) * 86400000).toISOString();
    return this.transaction(() => ({
      offers:Number(this.connection.prepare("DELETE FROM offers WHERE created_at<? AND COALESCE(published_at,created_at)<? AND status NOT IN ('publishing','uncertain')").run(cutoff,cutoff).changes),
      feedback:Number(this.connection.prepare('DELETE FROM feedback WHERE created_at<? AND offer_id NOT IN (SELECT id FROM offers)').run(cutoff).changes),
      activity:Number(this.connection.prepare('DELETE FROM activity WHERE created_at<?').run(cutoff).changes)
    }));
  }
  close(): void { if (!this.closed) { this.closed=true; this.connection.close(); } }
}
