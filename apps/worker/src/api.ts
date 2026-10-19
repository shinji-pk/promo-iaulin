import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import QRCode from 'qrcode';
import { z, ZodError } from 'zod';
import { Database, offerSchema } from '../../../packages/db/src/index.ts';
import { processPromotion, evaluatePublication, renderMessage } from '../../../packages/core/src/index.ts';
import { resolveUrl } from '../../../packages/core/src/resolver.ts';
import { calibrateAffiliate, identifyProduct } from '../../../packages/affiliate-adapters/src/index.ts';
import { affiliateConfigSchema, categoryIds, defaultSettings, ingestSchema, platformIds, settingsSchema, type Activity, type AppSnapshot, type IngestInput, type Offer, type Settings } from '../../../packages/shared/src/index.ts';
import { WhatsAppService, WhatsAppSendError, MAX_IMAGE_CAPTION } from './whatsapp.ts';
import { AffiliateService, getIntegrationGuides } from './affiliates.ts';
import { SecretVault } from './secret-vault.ts';
import { RemoteAccess, REMOTE_COOKIE_NAME, type RemoteStatus } from './remote-access.ts';
import { MediaStore } from './media-store.ts';
import { scoreOffer } from '../../../packages/scoring/src/index.ts';
import type { SetupStatus } from '../../../packages/shared/src/features.ts';

export type WhatsAppTransport = Pick<WhatsAppService,'getStatus'|'connect'|'reset'|'refreshGroups'|'sendText'|'stop'> & Partial<Pick<WhatsAppService,'sendImage'|'assertCanSend'>>;
export interface AppOptions {
  database?: Database;
  databasePath?: string;
  whatsapp?: WhatsAppTransport;
  authDir?: string;
  webDir?: string;
  schedule?: boolean;
  now?: () => Date;
  resolveUrl?: (url:string) => Promise<string>;
  affiliates?: AffiliateService;
  vault?: SecretVault;
  remoteAccess?: RemoteAccess;
  port?: number;
  mediaDirectory?: string;
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
  readonly affiliates: AffiliateService;
  readonly remote: RemoteAccess;
  readonly media: MediaStore;
  private lifecycleTail:Promise<void> = Promise.resolve();
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
    const directory=this.database.storageDirectory();
    const vault=options.vault ?? new SecretVault(directory ? {directory:join(directory,'affiliate-vault')} : {memory:true});
    this.affiliates=options.affiliates ?? new AffiliateService({database:this.database,vault,getSettings:()=>this.database.getSettings(),resolveUrl:this.resolver ?? resolveUrl,now:()=>this.now().getTime()});
    this.remote=options.remoteAccess ?? new RemoteAccess({database:this.database,port:options.port ?? Number(process.env.PROMOBRIDGE_PORT ?? 3030),...(directory ? {binDirectory:join(directory,'tunnel-bin')} : {}),now:this.now});
    this.media=new MediaStore(this.database,options.mediaDirectory);
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
    return {settings,offers:this.database.listOffers(1000),integrations:this.affiliates.statuses(),whatsapp:this.whatsapp.getStatus(),activity:this.database.listActivity(),feedbackCount:this.database.listFeedback().length,stats:this.database.stats(),health:{uptime:Math.floor((Date.now()-this.startedAt)/1000),databaseBytes:this.database.databaseBytes(),version:'2.1.0'}};
  }
  async ingest(input:IngestInput):Promise<Offer[]> {
    return this.run(async () => {
      const parsed = ingestSchema.parse(input);
      const normalized:IngestInput = {...parsed,messageId:parsed.messageId ?? randomUUID(),imageUrl:null};
      const settings = this.database.getSettings();
      if (!normalized.simulation && ((normalized.sourceId!=='manual' && !settings.sourceGroups.includes(normalized.sourceId)) || normalized.sourceId === settings.destinationGroup)) return [];
      const history = this.database.listOffers();
      if (!normalized.simulation && history.some(item => !item.simulation && item.sourceId===normalized.sourceId && item.sourceMessageId===normalized.messageId)) return [];
      const offers = await processPromotion(normalized,settings,{history,feedback:this.database.listFeedback(),affiliatePort:this.affiliates,now:this.now,...(this.resolver ? {resolveUrl:this.resolver} : {})});
      const mediaId=!normalized.simulation ? this.media.save(input.imageThumbnailBase64,input.imageThumbnailMime,this.now()) : null;
      this.database.transaction(() => {
        for (const offer of offers) {
          offer.simulation = normalized.simulation;
          if (mediaId) {offer.mediaId=mediaId;offer.imageUrl=`/api/v1/media/${mediaId}`;}
          if (normalized.sourceId==='manual') {offer.requiresManualApproval=true;if (offer.status==='approved') offer.status='review';}
          if (normalized.simulation && !['blocked','duplicate'].includes(offer.status)) {
            // Evaluate exactly the current automatic policy without ever enqueueing a real send.
            const dryRun = evaluatePublication({...offer,simulation:false,status:'approved',sourceId:settings.sourceGroups[0] ?? offer.sourceId},settings,history,this.now(),{automatic:true,affiliatePort:this.affiliates});
            offer.status = dryRun.allowed ? 'simulated' : 'review';
            offer.reasons = [...new Set([...offer.reasons,...dryRun.reasons])];
          }
          this.database.saveOffer(offer);
          this.log(normalized.simulation ? 'offer.simulated' : 'offer.received',`${offer.title || 'Oferta'}: ${{review:'em revisão',approved:'aprovada',rejected:'rejeitada',duplicate:'repetida',blocked:'precisa de configuração',publishing:'em envio',published:'publicada',simulated:'simulação',failed:'falha',uncertain:'envio a conferir'}[offer.status]}`,offer.status==='blocked' ? 'warning' : 'info',offer.id);
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
      if (parsed.action==='edit') { offer.rewrittenText=parsed.text!; offer.status='review';offer.manuallyApprovedAt=null;offer.scheduledAt=null; }
      else {offer.status=parsed.action==='approve' ? 'approved' : 'rejected';offer.manuallyApprovedAt=parsed.action==='approve' ? offer.updatedAt : null;if (parsed.action==='reject') offer.scheduledAt=null;}
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
    if (offer.status!=='approved') {if (automatic) return;throw new HttpError(409,'Aprove a oferta antes de publicar.');}
    if (!this.whatsapp.getStatus().connected) {if (automatic) return;throw new HttpError(409,'Conecte o WhatsApp antes de publicar.');}
    let settings=this.database.getSettings();
    const initial=evaluatePublication(offer,settings,this.database.listOffers(),this.now(),{automatic,affiliatePort:this.affiliates});
    if (!initial.allowed) throw new HttpError(409,initial.reasons.join(' '));
    // Permission/network preflight happens before any persistent claim or network send.
    try {await this.whatsapp.assertCanSend?.(settings.destinationGroup,offer.rewrittenText);}
    catch {throw new HttpError(409,'Não foi possível confirmar a permissão de envio. Atualize os grupos e confira o WhatsApp.');}
    let destination='';
    this.database.transaction(()=>{
      const current=this.database.getOffer(offer.id);
      if (!current || current.status!=='approved') throw new HttpError(409,'Oferta já reservada ou encerrada.');
      settings=this.database.getSettings();
      const evaluation=evaluatePublication(current,settings,this.database.listOffers(),this.now(),{automatic,affiliatePort:this.affiliates});
      if (!evaluation.allowed) throw new HttpError(409,evaluation.reasons.join(' '));
      destination=settings.destinationGroup;offer=current;offer.status='publishing';offer.updatedAt=this.now().toISOString();
      this.database.saveOffer(offer);this.log('publication.claimed','Envio reservado de forma persistente.','info',offer.id);
    });
    try {
      const image=offer.mediaId ? this.media.get(offer.mediaId) : null;
      const providerMessageId=image && this.whatsapp.sendImage && offer.rewrittenText.length<=MAX_IMAGE_CAPTION
        ? await this.whatsapp.sendImage(destination,image,offer.rewrittenText)
        : await this.whatsapp.sendText(destination,offer.rewrittenText);
      if (providerMessageId) offer.providerMessageId=providerMessageId;
    } catch (error) {
      const certainNoSend=error instanceof WhatsAppSendError && !error.uncertain;
      offer.status=certainNoSend ? 'review' : 'uncertain';offer.updatedAt=this.now().toISOString();
      if (certainNoSend) {offer.manuallyApprovedAt=null;offer.scheduledAt=null;}
      offer.reasons=[...new Set([...offer.reasons,certainNoSend ? 'O envio não foi iniciado. Confira as permissões e aprove novamente.' : 'Não foi possível confirmar o envio. Confira o grupo; esta oferta não será reenviada.'])];
      this.database.saveOffer(offer);
      this.log(certainNoSend ? 'publication.not_sent' : 'publication.uncertain',certainNoSend ? 'O WhatsApp recusou o envio antes da transmissão.' : 'WhatsApp não confirmou o envio. Confira o grupo antes de continuar.','warning',offer.id);
      return;
    }
    // A persistence failure leaves the durable claim for uncertain recovery, never a retry.
    offer.status='published';offer.publishedAt=this.now().toISOString();offer.updatedAt=offer.publishedAt;
    this.database.saveOffer(offer);this.log('publication.published','Oferta publicada no grupo de destino.','info',offer.id);
  }
  private async drainInternal():Promise<void> {
    const settings=this.database.getSettings(),now=this.now();
    const pending=this.database.listOffers().filter(offer=>!offer.simulation && offer.status==='approved').sort((a,b)=>(a.scheduledAt ?? a.createdAt).localeCompare(b.scheduledAt ?? b.createdAt));
    for (const offer of pending) {
      if (offer.expiresAt && Date.parse(offer.expiresAt)<=now.getTime()) {
        offer.status='review';offer.scheduledAt=null;offer.manuallyApprovedAt=null;offer.updatedAt=now.toISOString();
        offer.reasons=[...new Set([...offer.reasons,'Esta oferta venceu. Confira os dados e defina uma nova validade antes de publicar.'])];
        this.database.saveOffer(offer);this.log('offer.expired','Oferta vencida retirada da fila de envio.','warning',offer.id);continue;
      }
      if (settings.paused || !this.whatsapp.getStatus().connected) continue;
      const scheduled=Boolean(offer.scheduledAt && Date.parse(offer.scheduledAt)<=now.getTime() && offer.manuallyApprovedAt);
      if (settings.mode==='manual' && !scheduled) continue;
      try {await this.publishInternal(offer,!scheduled);}
      catch (error) {if (!(error instanceof HttpError && error.status===409)) throw error;}
    }
    if (now.getTime()-this.lastCleanup>86400000) {this.database.cleanup(now);this.media.cleanup();this.lastCleanup=now.getTime();}
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
          config.originalUrl=identifyProduct(config.originalUrl)?.canonicalUrl ?? await resolver(config.originalUrl);
          // Do not open the newly generated affiliate URL: that creates an artificial click.
        }
        result=await calibrateAffiliate(id,config);
      } catch {
        result={valid:false,reason:'Não foi possível resolver o produto original com segurança. Confira as URLs e tente novamente.'};
      }
      const settings=this.database.getSettings();
      settings.affiliates[id]={...config,verifiedAt:result.valid ? this.now().toISOString() : null};
      this.database.saveSettings(settings);
      this.log('affiliate.calibrated',`${id}: ${result.reason}`,result.valid ? 'info' : 'warning');
      return result;
    });
  }
  setup():SetupStatus {
    const settings=this.database.getSettings(),wa=this.whatsapp.getStatus();
    const integrations=this.affiliates.statuses();
    const destination=wa.groups.find(group=>group.id===settings.destinationGroup);
    const checks:SetupStatus['checks']=[
      {key:'whatsapp',label:'WhatsApp conectado',ready:wa.connected,detail:wa.connected ? 'Sessão conectada neste computador.' : 'Conecte o número que receberá e publicará as ofertas.',page:'sources'},
      {key:'sources',label:'Grupos de origem',ready:settings.sourceGroups.length>0,detail:settings.sourceGroups.length ? `${settings.sourceGroups.length} grupo(s) selecionado(s).` : 'Selecione os grupos que fornecem promoções.',page:'sources'},
      {key:'destination',label:'Destino disponível',ready:Boolean(settings.destinationGroup && destination && destination.available!==false && destination.canSend!==false),detail:!settings.destinationGroup ? 'Selecione o grupo de destino.' : destination?.canSend===false ? 'O número conectado não pode publicar neste grupo.' : destination ? 'Destino selecionado; permissões serão conferidas antes de cada envio.' : 'Atualize os grupos para confirmar o destino.',page:'sources'},
      {key:'affiliates',label:'Afiliação configurada',ready:integrations.some(item=>item.state==='ready'),detail:integrations.some(item=>item.state==='ready') ? 'Há lojas configuradas. Links manuais exigem aprovação por oferta; comissão não é garantida.' : 'Configure uma API ou importe um link oficial para um produto.',page:'affiliates'},
      {key:'automation',label:'Regras de publicação',ready:!settings.paused,detail:settings.paused ? 'A automação está pausada. Você pode configurar tudo antes de retomar.' : `Modo ${settings.mode==='manual' ? 'manual' : settings.mode==='semi' ? 'assistido' : 'automático'}; validade de ${settings.maxOfferAgeHours} horas e limites ativos.`,page:'automation'}
    ];
    return {ready:checks.every(check=>check.ready),checks,next:checks.find(check=>!check.ready)?.detail ?? 'Tudo configurado. Faça uma oferta de teste e confira o destino antes de ampliar a operação.'};
  }
  reprocess(id:string):Promise<Offer> {
    return this.run(async()=>{
      const previous=this.database.getOffer(id);
      if (!previous) throw new HttpError(404,'Oferta não encontrada.');
      if (['published','publishing','uncertain'].includes(previous.status)) throw new HttpError(409,'Confira o envio existente; ofertas publicadas ou incertas não podem ser reprocessadas.');
      const history=this.database.listOffers().filter(offer=>offer.id!==id);
      const results=await processPromotion({text:previous.originalText,sourceId:previous.sourceId,sourceName:previous.sourceName,messageId:previous.sourceMessageId,simulation:previous.simulation},this.database.getSettings(),{history,feedback:this.database.listFeedback(),affiliatePort:this.affiliates,now:this.now,...(this.resolver ? {resolveUrl:this.resolver} : {})});
      const result=results.find(offer=>offer.originalUrl===previous.originalUrl) ?? results.find(offer=>offer.productKey && offer.productKey===previous.productKey);
      if (!result) throw new HttpError(409,'Não foi possível reencontrar este produto no texto original. Cole uma nova oferta na entrada manual.');
      const offer:Offer={...result,id,createdAt:previous.createdAt,updatedAt:this.now().toISOString(),expiresAt:previous.expiresAt ?? result.expiresAt,mediaId:previous.mediaId,imageUrl:previous.imageUrl,manuallyApprovedAt:null,scheduledAt:null};
      if (offer.status==='approved' || offer.status==='simulated') offer.status='review';
      this.database.saveOffer(offer);this.log('offer.reprocessed','Produto reprocessado com a configuração atual; aprove novamente antes de publicar.','info',id);
      return offer;
    });
  }
  details(id:string,input:unknown):Promise<Offer> {
    const parsed=z.object({title:z.string().trim().min(1).max(1000).optional(),price:z.number().min(0).max(1e10).nullable().optional(),previousPrice:z.number().min(0).max(1e10).nullable().optional(),coupon:z.string().trim().max(240).nullable().optional(),category:z.enum(categoryIds).optional(),expiresAt:z.iso.datetime({offset:true}).optional()}).strict().refine(value=>Object.keys(value).length>0,'Informe pelo menos um campo.').parse(input);
    return this.run(()=>{
      const offer=this.database.getOffer(id);
      if (!offer) throw new HttpError(404,'Oferta não encontrada.');
      if (terminal.has(offer.status) && !['blocked','duplicate'].includes(offer.status)) throw new HttpError(409,'Esta oferta já foi encerrada.');
      if (parsed.expiresAt && Date.parse(parsed.expiresAt)<=this.now().getTime()) throw new HttpError(400,'A validade precisa estar no futuro.');
      Object.assign(offer,parsed);
      offer.discount=offer.price!==null && offer.previousPrice!==null && offer.previousPrice>offer.price && offer.previousPrice>0 ? Math.round((1-offer.price/offer.previousPrice)*100) : null;
      offer.confidence=offer.title && offer.price!==null ? Math.max(offer.confidence,0.9) : offer.confidence;
      const settings=this.database.getSettings(),history=this.database.listOffers().filter(item=>item.id!==id);
      const validation=offer.simulation ? {valid:offer.affiliateValid} : this.affiliates.validateOffer(offer,settings);
      offer.affiliateValid=validation.valid;offer.manuallyApprovedAt=null;offer.scheduledAt=null;
      const score=scoreOffer(offer,settings,{history,feedback:this.database.listFeedback(),productKey:offer.productKey,sourceId:offer.sourceId,affiliateValid:offer.affiliateValid,simulation:offer.simulation});
      offer.score=score.score;offer.factors=score.factors;offer.status=offer.affiliateValid ? 'review' : 'blocked';offer.updatedAt=this.now().toISOString();
      offer.rewrittenText=renderMessage(offer,settings);
      const gate=evaluatePublication({...offer,simulation:false,manuallyApprovedAt:offer.updatedAt},settings,history,this.now(),{automatic:false,affiliatePort:this.affiliates,ignoreTemporary:true});
      offer.reasons=gate.reasons;this.database.saveOffer(offer);
      this.database.saveFeedback({id:randomUUID(),offerId:id,action:'edit',category:offer.category,reason:'Dados estruturados conferidos manualmente.',createdAt:offer.updatedAt});
      this.log('offer.details','Dados conferidos e mensagem recalculada. Aprovação anterior removida.','info',id);return offer;
    });
  }
  scheduleOffer(id:string,input:unknown):Promise<Offer> {
    const parsed=z.object({scheduledAt:z.iso.datetime({offset:true})}).strict().parse(input);
    return this.run(()=>{
      const offer=this.database.getOffer(id);
      if (!offer) throw new HttpError(404,'Oferta não encontrada.');
      if (offer.simulation || offer.status!=='approved') throw new HttpError(409,'Aprove uma oferta real antes de agendar.');
      const time=Date.parse(parsed.scheduledAt),now=this.now();
      if (time<=now.getTime() || time>now.getTime()+168*3_600_000 || (offer.expiresAt && time>=Date.parse(offer.expiresAt))) throw new HttpError(400,'Agende um horário futuro, em até sete dias e antes da validade da oferta.');
      const settings=this.database.getSettings();
      const evaluation=evaluatePublication(offer,settings,this.database.listOffers(),now,{automatic:false,affiliatePort:this.affiliates,ignoreTemporary:true});
      if (!evaluation.allowed) throw new HttpError(409,evaluation.reasons.join(' '));
      offer.scheduledAt=new Date(time).toISOString();offer.manuallyApprovedAt=offer.manuallyApprovedAt ?? now.toISOString();offer.updatedAt=now.toISOString();
      this.database.saveOffer(offer);this.log('offer.scheduled','Publicação agendada por decisão explícita; limites e validade continuam ativos.','info',id);return offer;
    });
  }
  reconcile(id:string,input:unknown):Promise<Offer> {
    const parsed=z.object({outcome:z.enum(['published','not_sent']),confirmed:z.literal(true)}).strict().parse(input);
    return this.run(()=>{
      const offer=this.database.getOffer(id);
      if (!offer) throw new HttpError(404,'Oferta não encontrada.');
      if (offer.status!=='uncertain') throw new HttpError(409,'Somente envios incertos podem ser conferidos por esta ação.');
      offer.updatedAt=this.now().toISOString();offer.scheduledAt=null;
      if (parsed.outcome==='published') {offer.status='published';offer.publishedAt=offer.updatedAt;}
      else {offer.status='review';offer.publishedAt=null;offer.providerMessageId=null;offer.manuallyApprovedAt=null;offer.requiresManualApproval=true;}
      offer.reasons=[...new Set([...offer.reasons,parsed.outcome==='published' ? 'Publicação confirmada manualmente no grupo pela proprietária.' : 'A proprietária confirmou que a mensagem não foi enviada. Uma nova aprovação é obrigatória.'])];
      this.database.saveOffer(offer);this.log('publication.reconciled',parsed.outcome==='published' ? 'Resultado publicado confirmado manualmente; nenhum novo envio.' : 'Ausência de envio confirmada manualmente; oferta devolvida à revisão.','warning',id);return offer;
    });
  }
  private lifecycle(operation:()=>Promise<void>):Promise<void> {
    if (this.stopped) return Promise.reject(new HttpError(503,'O serviço está encerrando.'));
    const next=this.lifecycleTail.then(operation);this.lifecycleTail=next.catch(()=>undefined);return next;
  }
  connect():Promise<void> {return this.lifecycle(()=>this.whatsapp.connect());}
  reset():Promise<void> {return this.lifecycle(()=>this.whatsapp.reset());}
  refreshGroups():Promise<ReturnType<WhatsAppTransport['getStatus']>['groups']> {return this.whatsapp.refreshGroups();}
  restore(backup:unknown):Promise<ReturnType<Database['restore']>> { return this.run(() => this.database.restore(backup)); }
  cleanup():Promise<ReturnType<Database['cleanup']>> { return this.run(() => { const result=this.database.cleanup(this.now());this.media.cleanup();this.log('database.cleaned','Retenção aplicada. Histórico necessário à deduplicação foi preservado.');return result; }); }
  async close():Promise<void> {
    if (this.stopped) return;
    this.stopped=true;
    if (this.timer) clearInterval(this.timer);
    await Promise.all([this.tail,this.lifecycleTail]);
    try {await this.remote.stop();await this.whatsapp.stop();} finally {this.database.close();}
  }
}

function localRequest(request:Request):boolean {
  // A tunnel that rewrites Host to localhost must never gain local-owner privileges.
  if (['cf-ray','cf-connecting-ip','forwarded','x-forwarded-for','x-forwarded-host','x-forwarded-proto'].some(header=>request.headers[header]!==undefined)) return false;
  const address=request.socket.remoteAddress;
  if (address && !['127.0.0.1','::1','::ffff:127.0.0.1'].includes(address)) return false;
  const host=request.get('host') ?? '';
  const match=/^(localhost|127\.0\.0\.1|\[::1\])(?::(\d{1,5}))?$/i.exec(host);
  return Boolean(match && (!match[2] || (Number(match[2])>0 && Number(match[2])<=65535)));
}
function validOrigin(request:Request,remoteOrigin?:string|null):boolean {
  const origin=request.get('origin');
  if (!origin) return false;
  try { return origin===(remoteOrigin ?? new URL(`http://${request.get('host')}`).origin); } catch { return false; }
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
    const local=localRequest(request);
    const address=request.socket.remoteAddress;
    const loopback=!address || ['127.0.0.1','::1','::ffff:127.0.0.1'].includes(address);
    const remote=!local && loopback && runtime.remote.isRemoteHost(request.get('host') ?? '');
    if (!local && !remote) {response.status(403).json({error:'Endereço não autorizado. Use o painel local ou um dispositivo pareado.'});return;}
    const origin=remote ? runtime.remote.origin : undefined;
    if (request.get('origin') && !validOrigin(request,origin)) {response.status(403).json({error:'Origem não autorizada.'});return;}
    const pairing=remote && request.method==='POST' && request.path==='/api/v1/remote/pair';
    if (remote && request.path.startsWith('/api/') && !pairing && !runtime.remote.authorize(request.get('cookie'))) {response.status(401).json({error:'Pareie este dispositivo pelo QR Code exibido no computador.',code:'PAIRING_REQUIRED'});return;}
    if (!['GET','HEAD','OPTIONS'].includes(request.method)) {
      const token=Buffer.from(request.get('x-csrf-token') ?? '');
      const expected=Buffer.from(csrfToken);
      if (!validOrigin(request,origin) || (!pairing && (token.length!==expected.length || !timingSafeEqual(token,expected)))) {response.status(403).json({error:'Sessão inválida. Recarregue o painel ou faça um novo pareamento.'});return;}
      const emptyDelete=request.method==='DELETE' && !request.get('transfer-encoding') && (!request.get('content-length') || request.get('content-length')==='0');
      if (!emptyDelete && !request.is('application/json')) {response.status(415).json({error:'Envie conteúdo JSON.'});return;}
      const key=pairing ? 'remote-pairing' : `${remote ? 'remote' : 'local'}:${request.socket.remoteAddress ?? 'local'}`;
      const time=Date.now(),count=mutationCounts.get(key) ?? {start:time,count:0};
      if (time-count.start>60000) {count.start=time;count.count=0;}
      count.count++;mutationCounts.set(key,count);
      if (count.count>(pairing ? 10 : 120)) {response.status(429).json({error:'Muitas ações em sequência. Aguarde um minuto.'});return;}
    }
    next();
  });
  app.use(express.json({limit:'20mb',strict:true}));
  const router=express.Router();
  const localOnly=(request:Request,_response:Response,next:NextFunction)=>{if (!localRequest(request)) {next(new HttpError(403,'Esta ação precisa ser feita no computador que executa o PromoBridge.'));return;}next();};
  const id=(value:unknown)=>z.string().min(1).max(200).parse(value);
  const platform=(value:unknown)=>z.enum(platformIds).parse(value);
  const service=async<T>(operation:()=>T|Promise<T>):Promise<T>=>{try {return await operation();} catch (error) {if (error instanceof ZodError || error instanceof HttpError) throw error;throw new HttpError(400,error instanceof Error ? error.message.slice(0,2000) : 'Não foi possível concluir a configuração.');}};
  const remoteStatus=async(request:Request):Promise<RemoteStatus & {qrDataUrl?:string}>=>{
    const status=runtime.remote.status({includePairing:localRequest(request)});
    return status.pairing ? {...status,qrDataUrl:await QRCode.toDataURL(status.pairing.url,{width:300,margin:2,errorCorrectionLevel:'M'})} : status;
  };
  router.get('/setup',(_request,response)=>response.json(runtime.setup()));
  router.get('/affiliates/guides',(_request,response)=>response.json(getIntegrationGuides()));
  router.get('/affiliates/credentials',(_request,response)=>response.json(runtime.affiliates.credentialStatuses()));
  router.post('/affiliates/:platform/credentials',localOnly,async(request,response)=>{
    const parsed=z.object({values:z.record(z.string().max(100),z.string().max(8192))}).strict().parse(request.body);
    response.json(await runtime.run(()=>service(()=>runtime.affiliates.saveCredentials(platform(request.params.platform),parsed.values))));
  });
  router.delete('/affiliates/:platform/credentials',localOnly,async(request,response)=>{z.object({}).strict().parse(request.body ?? {});await runtime.run(()=>runtime.affiliates.removeCredentials(platform(request.params.platform)));response.json({ok:true});});
  router.post('/affiliates/:platform/test',async(request,response)=>{
    const parsed=z.object({originalUrl:affiliateUrlSchema.optional()}).strict().parse(request.body);
    response.json(await runtime.run(()=>runtime.affiliates.testConnection(platform(request.params.platform),parsed)));
  });
  router.get('/affiliate-links/export',(_request,response)=>{response.set('Content-Disposition','attachment; filename="promobridge-links.json"');response.json({schemaVersion:1,exportedAt:new Date().toISOString(),links:runtime.affiliates.listLinks()});});
  router.get('/affiliate-links',(request,response)=>response.json(runtime.affiliates.listLinks(request.query.platform===undefined ? undefined : platform(request.query.platform))));
  router.post('/affiliate-links',async(request,response)=>{
    const parsed=z.object({platform:z.enum(platformIds),originalUrl:affiliateUrlSchema.refine(Boolean),affiliateUrl:affiliateUrlSchema.refine(Boolean),title:z.string().max(1000).optional(),ownerConfirmed:z.literal(true)}).strict().parse(request.body);
    response.json(await runtime.run(()=>service(()=>runtime.affiliates.importLink(parsed))));
  });
  router.delete('/affiliate-links/:id',async(request,response)=>{z.object({}).strict().parse(request.body ?? {});await runtime.run(()=>runtime.affiliates.removeLink(id(request.params.id)));response.json({ok:true});});
  router.post('/ingest',async(request,response)=>{const parsed=z.object({text:z.string().min(1).max(16000)}).strict().parse(request.body);response.json(await runtime.ingest({text:parsed.text,sourceId:'manual',sourceName:'Entrada manual',messageId:randomUUID(),simulation:false}));});
  router.post('/offers/:id/reprocess',async(request,response)=>{z.object({}).strict().parse(request.body);response.json(await runtime.reprocess(id(request.params.id)));});
  router.post('/offers/:id/details',async(request,response)=>response.json(await runtime.details(id(request.params.id),request.body)));
  router.post('/offers/:id/schedule',async(request,response)=>response.json(await runtime.scheduleOffer(id(request.params.id),request.body)));
  router.post('/offers/:id/reconcile',async(request,response)=>response.json(await runtime.reconcile(id(request.params.id),request.body)));
  router.get('/offers/history',(request,response)=>{
    const parsed=z.object({page:z.coerce.number().int().min(1).max(1_000_000).optional(),pageSize:z.coerce.number().int().min(1).max(100).optional(),query:z.string().max(200).optional(),status:offerSchema.shape.status.optional(),platform:z.enum(platformIds).optional(),simulation:z.enum(['true','false']).transform(value=>value==='true').optional()}).strict().parse(request.query);
    response.json(runtime.database.searchOffers(parsed));
  });
  router.get('/media/:id',(request,response)=>{const bytes=runtime.media.get(z.uuid().parse(request.params.id));if (!bytes) throw new HttpError(404,'Miniatura não encontrada nesta instalação.');response.type('image/jpeg').send(bytes);});
  router.get('/remote',async(request,response)=>response.json(await remoteStatus(request)));
  router.post('/remote/start',localOnly,async(request,response)=>{
    const parsed=z.discriminatedUnion('mode',[z.object({mode:z.literal('temporary')}).strict(),z.object({mode:z.literal('managed'),token:z.string().min(1).max(10000),publicUrl:z.string().min(1).max(2048)}).strict()]).parse(request.body);
    await service(()=>runtime.remote.start(parsed));response.json(await remoteStatus(request));
  });
  router.post('/remote/stop',localOnly,async(request,response)=>{z.object({}).strict().parse(request.body);response.json(await runtime.remote.stop());});
  router.post('/remote/revoke',localOnly,(request,response)=>{z.object({}).strict().parse(request.body);response.json(runtime.remote.revokeSessions());});
  router.post('/remote/pair',(request,response)=>{
    if (localRequest(request) || !runtime.remote.isRemoteHost(request.get('host') ?? '')) throw new HttpError(403,'Use o endereço HTTPS de pareamento no dispositivo que deseja conectar.');
    const parsed=z.object({code:z.string().min(1).max(200)}).strict().parse(request.body);
    let session:ReturnType<RemoteAccess['pair']>;
    try {session=runtime.remote.pair(parsed.code);} catch {throw new HttpError(403,'Código inválido ou expirado. Gere outro no computador.');}
    response.cookie(REMOTE_COOKIE_NAME,session.sessionToken,{httpOnly:true,secure:true,sameSite:'strict',path:'/',expires:new Date(session.expiresAt)});
    response.json({csrfToken,expiresAt:session.expiresAt});
  });
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
