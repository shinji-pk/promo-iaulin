import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { z, ZodError } from 'zod';
import { Database } from '../../../packages/db/src/index.ts';
import { processPromotion, evaluatePublication } from '../../../packages/core/src/index.ts';
import { resolveUrl } from '../../../packages/core/src/resolver.ts';
import { calibrateAffiliate, getIntegrationStatuses } from '../../../packages/affiliate-adapters/src/index.ts';
import { affiliateConfigSchema, defaultSettings, ingestSchema, platformIds, settingsSchema, type Activity, type AppSnapshot, type IngestInput, type Offer, type Settings } from '../../../packages/shared/src/index.ts';
import { WhatsAppService } from './whatsapp.ts';

export type WhatsAppTransport = Pick<WhatsAppService,'getStatus'|'connect'|'reset'|'refreshGroups'|'sendText'|'stop'>;
export interface AppOptions {
  database?: Database;
  databasePath?: string;
  whatsapp?: WhatsAppTransport;
  authDir?: string;
  webDir?: string;
  schedule?: boolean;
  now?: () => Date;
  resolveUrl?: (url:string) => Promise<string>;
}
class HttpError extends Error { constructor(readonly status:number,message:string) { super(message); } }
const terminal = new Set(['published','publishing','uncertain','failed','rejected','duplicate','simulated']);
const actionSchema = z.object({action:z.enum(['approve','reject','publish','edit']),text:z.string().min(1).max(16000).optional(),reason:z.string().max(2000).optional()}).strict();
const affiliateUrlSchema=z.string().max(2048).refine(value => {
  if (!value) return true;
  if (/[\s\\]/u.test(value)) return false;
  try { const url=new URL(value);return url.protocol==='https:' && !url.username && !url.password && (!url.port || url.port==='443'); }
  catch { return false; }
},'Use uma URL HTTPS sem credenciais.');
const affiliateInputSchema=affiliateConfigSchema.strict().extend({originalUrl:affiliateUrlSchema,affiliateUrl:affiliateUrlSchema});
const groupIdSchema = z.string().max(100).regex(/^\d+(?:-\d+)?@g\.us$/);
const settingsInputSchema = settingsSchema.strict().extend({
  sourceGroups:z.array(groupIdSchema).max(100).refine(groups => new Set(groups).size===groups.length,'Não repita grupos-fonte.'),
  destinationGroup:z.union([z.literal(''),groupIdSchema]),
  audience:settingsSchema.shape.audience.unwrap().strict(),
  message:settingsSchema.shape.message.unwrap().strict(),
  affiliates:z.record(z.enum(platformIds),affiliateInputSchema)
});
const completeSettingsKeys = Object.keys(defaultSettings());

/** One queue covers configuration changes, ingestion, claims, and the entire send. */
export class WorkerRuntime {
  readonly database: Database;
  readonly whatsapp: WhatsAppTransport;
  private tail: Promise<void> = Promise.resolve();
  private timer: ReturnType<typeof setInterval> | undefined;
  private stopped = false;
  private lastCleanup = 0;
  private readonly startedAt = Date.now();
  private readonly now: () => Date;
  private readonly resolver?: (url:string) => Promise<string>;

  constructor(options:AppOptions) {
    this.database = options.database ?? new Database(options.databasePath);
    this.now = options.now ?? (() => new Date());
    this.resolver = options.resolveUrl;
    this.whatsapp = options.whatsapp ?? new WhatsAppService({
      authDir:options.authDir ?? resolve('data/whatsapp-session'),
      getSettings:() => this.database.getSettings(),
      onMessage:async input => { await this.ingest(input); },
      onEvent:(event,message) => { if (!this.stopped) void this.run(() => this.log(event,message,event.includes('error') ? 'error' : 'info')).catch(() => undefined); }
    });
    if (options.schedule !== false) {
      this.timer = setInterval(() => { void this.drain().catch(() => undefined); },15000);
      this.timer.unref();
    }
  }
  run<T>(operation:() => T | Promise<T>): Promise<T> {
    if (this.stopped) return Promise.reject(new HttpError(503,'O serviço está encerrando.'));
    const next = this.tail.then(operation);
    this.tail = next.then(() => undefined,() => undefined);
    return next;
  }
  private log(event:string,message:string,level:Activity['level']='info',offerId?:string):void {
    this.database.addActivity({id:randomUUID(),createdAt:this.now().toISOString(),event,message,level,...(offerId ? {offerId} : {})});
  }
  snapshot(): AppSnapshot {
    const settings = this.database.getSettings();
    return {settings,offers:this.database.listOffers(1000),integrations:getIntegrationStatuses(settings),whatsapp:this.whatsapp.getStatus(),activity:this.database.listActivity(),feedbackCount:this.database.listFeedback().length,stats:this.database.stats(),health:{uptime:Math.floor((Date.now()-this.startedAt)/1000),databaseBytes:this.database.databaseBytes(),version:'2.0.0'}};
  }
  async ingest(input:IngestInput):Promise<Offer[]> {
    return this.run(async () => {
      const parsed = ingestSchema.parse(input);
      const normalized:IngestInput = {...parsed,messageId:parsed.messageId ?? randomUUID(),imageUrl:input.imageUrl ?? null};
      const settings = this.database.getSettings();
      if (!normalized.simulation && (!settings.sourceGroups.includes(normalized.sourceId) || normalized.sourceId === settings.destinationGroup)) return [];
      const history = this.database.listOffers();
      if (!normalized.simulation && history.some(item => !item.simulation && item.sourceId===normalized.sourceId && item.sourceMessageId===normalized.messageId)) return [];
      const offers = await processPromotion(normalized,settings,{history,feedback:this.database.listFeedback(),...(this.resolver ? {resolveUrl:this.resolver} : {})});
      this.database.transaction(() => {
        for (const offer of offers) {
          offer.simulation = normalized.simulation;
          if (normalized.simulation && !['blocked','duplicate'].includes(offer.status)) {
            // Evaluate exactly the current automatic policy without ever enqueueing a real send.
            const dryRun = evaluatePublication({...offer,simulation:false,status:'approved',sourceId:settings.sourceGroups[0] ?? offer.sourceId},settings,history,this.now(),{automatic:true});
            offer.status = dryRun.allowed ? 'simulated' : 'review';
            offer.reasons = [...new Set([...offer.reasons,...dryRun.reasons])];
          }
          this.database.saveOffer(offer);
          this.log(normalized.simulation ? 'offer.simulated' : 'offer.received',`${offer.title || 'Oferta'}: ${offer.status}`,offer.status==='blocked' ? 'warning' : 'info',offer.id);
          history.push(offer);
        }
      });
      if (!normalized.simulation) await this.drainInternal();
      return offers.map(offer => this.database.getOffer(offer.id)!);
    });
  }
  saveSettings(input:unknown):Promise<Settings> {
    return this.run(() => {
      if (!input || typeof input !== 'object' || completeSettingsKeys.some(key => !(key in input))) throw new HttpError(400,'Envie todas as configurações.');
      const next = settingsInputSchema.parse(input);
      if (next.destinationGroup && next.sourceGroups.includes(next.destinationGroup)) throw new HttpError(400,'O destino não pode ser também um grupo-fonte.');
      const previous = this.database.getSettings();
      for (const platform of platformIds) {
        const a = next.affiliates[platform]; const b = previous.affiliates[platform];
        a.verifiedAt = a.enabled===b.enabled && a.publicId===b.publicId && a.originalUrl===b.originalUrl && a.affiliateUrl===b.affiliateUrl ? b.verifiedAt : null;
      }
      const settings = this.database.saveSettings(next);
      this.log('settings.saved','Configurações atualizadas.');
      return settings;
    });
  }
  action(id:string,input:unknown):Promise<Offer> {
    const parsed = actionSchema.parse(input);
    return this.run(async () => {
      const offer = this.database.getOffer(id);
      if (!offer) throw new HttpError(404,'Oferta não encontrada.');
      if (parsed.action==='publish') {
        await this.publishInternal(offer,false);
        return this.database.getOffer(id)!;
      }
      if (terminal.has(offer.status)) throw new HttpError(409,'Esta oferta já foi encerrada e não pode ser alterada.');
      if (parsed.action==='edit' && !parsed.text) throw new HttpError(400,'Digite a mensagem revisada.');
      if (parsed.action==='approve' && offer.status==='approved') return offer;
      const settings = this.database.getSettings();
      if (parsed.action==='approve' && (!offer.affiliateValid || offer.score<settings.minScore || offer.confidence<0.75 || offer.status==='blocked')) throw new HttpError(409,'Aprovação não libera uma oferta com afiliação, pontuação ou confiança insuficiente.');
      offer.updatedAt=this.now().toISOString();
      if (parsed.action==='edit') { offer.rewrittenText=parsed.text!; offer.status='review'; }
      else offer.status=parsed.action==='approve' ? 'approved' : 'rejected';
      this.database.transaction(() => {
        this.database.saveOffer(offer);
        this.database.saveFeedback({id:randomUUID(),offerId:offer.id,action:parsed.action as 'approve'|'reject'|'edit',category:offer.category,reason:parsed.reason ?? '',createdAt:offer.updatedAt});
        this.log(`offer.${parsed.action}`,parsed.action==='approve' ? 'Oferta aprovada. O envio exige a ação Publicar ou automação ativa.' : parsed.action==='reject' ? 'Oferta rejeitada.' : 'Mensagem editada; validação será repetida antes do envio.','info',offer.id);
      });
      return offer;
    });
  }
  private async publishInternal(offer:Offer,automatic:boolean):Promise<void> {
    if (offer.simulation) throw new HttpError(409,'Simulações nunca enviam mensagens ao WhatsApp.');
    if (terminal.has(offer.status)) throw new HttpError(409,'Esta oferta está encerrada ou já possui tentativa de envio.');
    if (offer.status !== 'approved') {
      if (automatic) return;
      throw new HttpError(409,'Aprove a oferta antes de publicar.');
    }
    if (!this.whatsapp.getStatus().connected) {
      if (automatic) return;
      throw new HttpError(409,'Conecte o WhatsApp antes de publicar.');
    }
    let destination = '';
    // Persistent claim and current-policy validation share the SQLite write lock.
    this.database.transaction(() => {
      const current = this.database.getOffer(offer.id);
      if (!current || current.status!=='approved') throw new HttpError(409,'Oferta já reservada ou encerrada.');
      const settings = this.database.getSettings();
      const evaluation = evaluatePublication(current,settings,this.database.listOffers(),this.now(),{automatic});
      if (!evaluation.allowed) throw new HttpError(409,evaluation.reasons.join(' ') || 'A publicação está bloqueada pelas regras atuais.');
      destination=settings.destinationGroup;
      offer=current; offer.status='publishing'; offer.updatedAt=this.now().toISOString();
      this.database.saveOffer(offer);
      this.log('publication.claimed','Envio reservado de forma persistente.','info',offer.id);
    });
    try {
      await this.whatsapp.sendText(destination,offer.rewrittenText);
    } catch {
      offer.status='uncertain'; offer.updatedAt=this.now().toISOString();
      offer.reasons=[...offer.reasons,'Não foi possível confirmar o envio. Confira o grupo; esta oferta não será reenviada.'];
      this.database.saveOffer(offer);
      this.log('publication.uncertain','WhatsApp não confirmou o envio. Confira o grupo antes de continuar.','warning',offer.id);
      return;
    }
    // If persisting confirmation fails, the durable publishing claim remains and is
    // recovered as uncertain on restart. Never attempt the network operation again.
    offer.status='published'; offer.publishedAt=this.now().toISOString(); offer.updatedAt=offer.publishedAt;
    this.database.saveOffer(offer);
    this.log('publication.published','Oferta publicada no grupo de destino.','info',offer.id);
  }
  private async drainInternal():Promise<void> {
    const settings=this.database.getSettings();
    if (!settings.paused && settings.mode!=='manual' && this.whatsapp.getStatus().connected) {
      const pending=this.database.listOffers().filter(offer => !offer.simulation && offer.status==='approved').sort((a,b) => a.createdAt.localeCompare(b.createdAt));
      for (const offer of pending) {
        try { await this.publishInternal(offer,true); }
        catch (error) { if (!(error instanceof HttpError && error.status===409)) throw error; }
      }
    }
    if (this.now().getTime()-this.lastCleanup>86400000) { this.database.cleanup(this.now()); this.lastCleanup=this.now().getTime(); }
  }
  drain():Promise<void> { return this.run(() => this.drainInternal()); }
  calibrate(platform:string,input:unknown):Promise<{valid:boolean;reason:string}> {
    const id=z.enum(platformIds).parse(platform);
    const parsed=affiliateInputSchema.omit({verifiedAt:true}).strict().parse(input);
    return this.run(async () => {
      const config={...parsed,verifiedAt:null};
      let result:{valid:boolean;reason:string};
      try {
        if (id==='amazon' && config.enabled && config.originalUrl && config.affiliateUrl) {
          const resolver=this.resolver ?? resolveUrl;
          // The production resolver validates DNS and HTTPS again at every redirect.
          config.originalUrl=await resolver(config.originalUrl);
          config.affiliateUrl=await resolver(config.affiliateUrl);
        }
        result=await calibrateAffiliate(id,config);
      } catch {
        result={valid:false,reason:'Não foi possível resolver os dois links com segurança. Confira as URLs e tente novamente.'};
      }
      const settings=this.database.getSettings();
      settings.affiliates[id]={...config,verifiedAt:result.valid ? this.now().toISOString() : null};
      this.database.saveSettings(settings);
      this.log('affiliate.calibrated',`${id}: ${result.reason}`,result.valid ? 'info' : 'warning');
      return result;
    });
  }
  connect():Promise<void> { return this.run(() => this.whatsapp.connect()); }
  reset():Promise<void> { return this.run(() => this.whatsapp.reset()); }
  refreshGroups():Promise<ReturnType<WhatsAppTransport['getStatus']>['groups']> { return this.run(() => this.whatsapp.refreshGroups()); }
  restore(backup:unknown):Promise<ReturnType<Database['restore']>> { return this.run(() => this.database.restore(backup)); }
  cleanup():Promise<ReturnType<Database['cleanup']>> { return this.run(() => { const result=this.database.cleanup(this.now());this.log('database.cleaned','Retenção aplicada. Histórico necessário à deduplicação foi preservado.');return result; }); }
  async close():Promise<void> {
    if (this.stopped) return;
    this.stopped=true;
    if (this.timer) clearInterval(this.timer);
    await this.tail;
    try { await this.whatsapp.stop(); } finally { this.database.close(); }
  }
}

function localRequest(request:Request):boolean {
  const address=request.socket.remoteAddress;
  if (address && !['127.0.0.1','::1','::ffff:127.0.0.1'].includes(address)) return false;
  const host=request.get('host') ?? '';
  const match=/^(localhost|127\.0\.0\.1|\[::1\])(?::(\d{1,5}))?$/i.exec(host);
  return Boolean(match && (!match[2] || (Number(match[2])>0 && Number(match[2])<=65535)));
}
function validOrigin(request:Request):boolean {
  const origin=request.get('origin');
  if (!origin) return false;
  try { return origin===new URL(`http://${request.get('host')}`).origin; } catch { return false; }
}

export function createApp(options:AppOptions={}):Express & {runtime:WorkerRuntime} {
  const runtime=new WorkerRuntime(options);
  const app=Object.assign(express(),{runtime});
  const csrfToken=randomBytes(32).toString('hex');
  const mutationCounts=new Map<string,{start:number;count:number}>();
  app.disable('x-powered-by');
  app.set('trust proxy',false);
  app.use((request,response,next) => {
    response.set({'X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY','Referrer-Policy':'no-referrer','Cross-Origin-Resource-Policy':'same-origin','Cache-Control':'no-store'});
    if (!localRequest(request)) { response.status(403).json({error:'Acesso permitido somente pelo endereço local.'});return; }
    if (request.get('origin') && !validOrigin(request)) { response.status(403).json({error:'Origem não autorizada.'});return; }
    if (!['GET','HEAD','OPTIONS'].includes(request.method)) {
      const token=Buffer.from(request.get('x-csrf-token') ?? '');
      const expected=Buffer.from(csrfToken);
      if (!validOrigin(request) || token.length!==expected.length || !timingSafeEqual(token,expected)) { response.status(403).json({error:'Sessão local inválida. Recarregue o painel.'});return; }
      if (!request.is('application/json')) { response.status(415).json({error:'Envie conteúdo JSON.'});return; }
      const key=request.socket.remoteAddress ?? 'local'; const time=Date.now();
      const count=mutationCounts.get(key) ?? {start:time,count:0};
      if (time-count.start>60000) {count.start=time;count.count=0;}
      count.count++;mutationCounts.set(key,count);
      if (count.count>120) {response.status(429).json({error:'Muitas ações em sequência. Aguarde um minuto.'});return;}
    }
    next();
  });
  app.use(express.json({limit:'20mb',strict:true}));
  const router=express.Router();
  router.get('/session',(_request,response) => response.json({csrfToken}));
  router.get('/state',(_request,response) => response.json(runtime.snapshot()));
  router.get('/health',(_request,response) => response.json({ok:true,...runtime.snapshot().health,whatsappConnected:runtime.whatsapp.getStatus().connected}));
  router.put('/settings',async (request,response) => response.json(await runtime.saveSettings(request.body)));
  router.post('/simulate',async (request,response) => {
    const parsed=ingestSchema.strict().parse(request.body);
    response.json(await runtime.ingest({text:parsed.text,sourceId:'simulator',sourceName:'Simulador',messageId:randomUUID(),simulation:true}));
  });
  router.post('/offers/:id/action',async (request,response) => response.json(await runtime.action(z.string().min(1).max(200).parse(request.params.id),request.body)));
  router.post('/affiliates/:platform/calibrate',async (request,response) => response.json(await runtime.calibrate(String(request.params.platform),request.body)));
  router.post('/whatsapp/connect',async (_request,response) => {await runtime.connect();response.json(runtime.whatsapp.getStatus());});
  router.post('/whatsapp/reset',async (_request,response) => {await runtime.reset();response.json(runtime.whatsapp.getStatus());});
  router.get('/whatsapp/groups',async (_request,response) => response.json(await runtime.refreshGroups()));
  router.get('/backup',(_request,response) => {response.set('Content-Disposition','attachment; filename="promobridge-backup.json"');response.json(runtime.database.backup());});
  router.post('/restore',async (request,response) => {const parsed=z.object({backup:z.unknown()}).strict().parse(request.body);response.json(await runtime.restore(parsed.backup));});
  router.post('/cleanup',async (request,response) => {z.object({confirm:z.literal(true)}).strict().parse(request.body);response.json(await runtime.cleanup());});
  router.use((_request,response) => response.status(404).json({error:'Rota da API não encontrada.'}));
  app.use('/api/v1',router);
  app.use('/api',(_request,response) => response.status(404).json({error:'Use a API versionada /api/v1.'}));
  const webDir=options.webDir ?? resolve('apps/web/dist');
  app.use(express.static(webDir,{index:false}));
  app.get('/{*path}',(_request,response) => {
    if (existsSync(resolve(webDir,'index.html'))) response.sendFile(resolve(webDir,'index.html'));
    else response.status(503).type('text').send('Painel ainda não compilado. Execute npm run build e reinicie o PromoBridge.');
  });
  app.use((error:unknown,_request:Request,response:Response,_next:NextFunction) => {
    if (error instanceof ZodError) {response.status(400).json({error:'Dados inválidos.',details:error.issues.map(issue => ({field:issue.path.join('.'),message:issue.message}))});return;}
    if (error instanceof HttpError) {response.status(error.status).json({error:error.message});return;}
    if (error instanceof SyntaxError && 'body' in error) {response.status(400).json({error:'JSON inválido.'});return;}
    if (typeof error==='object' && error!==null && 'status' in error && error.status===413) {response.status(413).json({error:'Arquivo muito grande.'});return;}
    response.status(500).json({error:'Não foi possível concluir a ação. Consulte a saúde do serviço.'});
  });
  return app;
}
