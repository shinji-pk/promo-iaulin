import express, { type NextFunction, type Request, type Response } from 'express';
import { fromNodeHeaders, toNodeHandler } from 'better-auth/node';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { z, ZodError } from 'zod';
import { getCloudAuth, hasEmailProvider } from './auth.ts';
import { createSecurityQuestionService, SecurityQuestionError, SECURITY_QUESTIONS } from './security-questions.ts';
import { createBlobJsonStore, type JsonDocumentStore } from './blob-store.ts';
import { openCookie, parsePairingUrl, requestWorker, sealCookie, type WorkerConnection } from './worker-proxy.ts';
import { isManagedOwner, managedWorkerFromEnv, type ManagedWorker } from './managed-worker.ts';
import { defaultSettings, platformIds, settingsSchema, type Activity, type AppSnapshot, type Offer, type Settings } from '../../../packages/shared/src/index.ts';
import { getIntegrationStatuses, identifyProduct } from '../../../packages/affiliate-adapters/src/index.ts';
import { getIntegrationGuides } from '../../../packages/shared/src/integration-guides.ts';
import { processPromotion } from '../../../packages/core/src/index.ts';
import { offerSchema } from '../../../packages/db/src/index.ts';
import { readJpegThumbnail } from '../../worker/src/jpeg-thumbnail.ts';

export interface AccountData { version:1; settings:Settings; offers:Offer[]; activity:Activity[]; feedbackCount:number; connection:WorkerConnection|null; syncedAt:string|null; }
export const initialData=():AccountData=>({version:1,settings:defaultSettings(),offers:[],activity:[],feedbackCount:0,connection:null,syncedAt:null});
const accountStore=(userId:string)=>createBlobJsonStore<AccountData>(`accounts/${encodeURIComponent(userId)}/workspace.json`,initialData);
class CloudError extends Error { constructor(readonly status:number,message:string){super(message);} }

function snapshot(data:AccountData,managed=false):AppSnapshot {
  const counts={seen:data.offers.length,published:0,review:0,blocked:0,simulated:0};
  for(const offer of data.offers){if(offer.status==='published')counts.published++;if(['review','approved'].includes(offer.status))counts.review++;if(['blocked','duplicate','failed','uncertain'].includes(offer.status))counts.blocked++;if(offer.simulation)counts.simulated++;}
  return {settings:data.settings,offers:data.offers.slice(0,1000),activity:data.activity,feedbackCount:data.feedbackCount,stats:counts,
    integrations:getIntegrationStatuses(data.settings).map(value=>({...value,state:value.state==='ready'?'degraded':value.state,reason:value.state==='ready'?(managed?'Configuração salva. O servidor do WhatsApp precisa responder para conferir a loja.':'Configuração salva. Conecte o computador para conferir a loja.'):value.reason})),
    whatsapp:{connected:false,connecting:false,qrDataUrl:null,user:null,groups:[],lastError:managed?'O servidor do WhatsApp não respondeu agora. Seus dados salvos continuam disponíveis; tente de novo em instantes.':data.connection?'O computador está indisponível ou o pareamento expirou. Seus dados salvos continuam disponíveis.':null,diagnostics:[managed?'Preferências salvas na sua conta. O servidor do WhatsApp na nuvem não respondeu; se ele acabou de ser ligado, aguarde alguns minutos.':'Preferências salvas na sua conta. Conecte o computador para capturar e publicar ofertas reais.']},health:{uptime:0,databaseBytes:Buffer.byteLength(JSON.stringify(data)),version:'2.1.0'}};
}
async function saveSnapshot(store:JsonDocumentStore<AccountData>,state:AppSnapshot,connection?:WorkerConnection):Promise<void> {
  const parsed=z.object({settings:settingsSchema,offers:z.array(offerSchema).max(50000),activity:z.array(z.object({id:z.string().max(200),createdAt:z.iso.datetime({offset:true}),level:z.enum(['info','warning','error']),event:z.string().max(200),message:z.string().max(3000),offerId:z.string().max(200).optional()}).strict()).max(100000),feedbackCount:z.number().int().min(0)}).parse(state);
  await store.transact(draft=>{draft.settings=parsed.settings;draft.offers=parsed.offers.slice(0,3000);draft.activity=parsed.activity.slice(0,300);draft.feedbackCount=parsed.feedbackCount;draft.syncedAt=new Date().toISOString();if(connection)draft.connection=connection;});
}

export function createCloudApp(options:{auth?:ReturnType<typeof getCloudAuth>;storeFor?:(userId:string)=>JsonDocumentStore<AccountData>;requestWorker?:typeof requestWorker;secret?:string;baseURL?:string;managedWorker?:ManagedWorker|null}={}){
  const auth=()=>options.auth??getCloudAuth();
  const storeFor=options.storeFor??accountStore;
  const proxy=options.requestWorker??requestWorker;
  // Read at request time so that hosting changes need only a redeploy, never a code change.
  const managedWorker=()=>options.managedWorker!==undefined?options.managedWorker:managedWorkerFromEnv();
  const secret=()=>options.secret??process.env.BETTER_AUTH_SECRET!;
  const csrfFor=(sessionId:string)=>createHmac('sha256',secret()).update(`csrf:${sessionId}`).digest('base64url');
  const validOrigin=(req:Request)=>req.get('origin')===new URL(options.baseURL??process.env.BETTER_AUTH_URL??'https://promo-iaulin.vercel.app').origin;
  const validCsrf=(req:Request,sessionId:string)=>{
    const expected=Buffer.from(csrfFor(sessionId)),given=Buffer.from(req.get('x-csrf-token')??'');
    return given.length===expected.length&&timingSafeEqual(given,expected);
  };
  const app=express();app.disable('x-powered-by');app.set('trust proxy',1);
  app.use((_req,res,next)=>{res.set({'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY','Referrer-Policy':'no-referrer'});next();});
  // One-click customer download. Public, fixed destination: never accepts an arbitrary URL.
  app.get('/api/v1/download/windows',(_req,res)=>res.redirect(302,'https://github.com/shinji-pk/promo-iaulin/releases/download/desktop-preview-38/Promo-Iaulin-Setup.exe'));
  app.all('/api/auth/{*splat}',(req,res)=>toNodeHandler(auth())(req,res));
  app.use(express.json({limit:'20mb',strict:true}));
  app.get('/api/v1/account/capabilities',(_req,res)=>res.json({passwordRecovery:hasEmailProvider(),emailChange:hasEmailProvider()}));
  app.get('/api/v1/account/security-questions',async(req,res)=>{
    try {
      const session=await auth().api.getSession({headers:fromNodeHeaders(req.headers)});
      if(!session){res.status(401).json({error:'Entre na sua conta para configurar a recuperação.'});return;}
      const selected=await createSecurityQuestionService().getUser(session.user.id);
      res.json({options:SECURITY_QUESTIONS,selected,configured:selected.length===3});
    } catch {res.status(503).json({error:'Não foi possível carregar a recuperação agora.'});}
  });
  app.post('/api/v1/account/security-questions',async(req,res)=>{
    try {
      const session=await auth().api.getSession({headers:fromNodeHeaders(req.headers)});
      if(!session){res.status(401).json({error:'Entre na sua conta para configurar a recuperação.'});return;}
      if(!validOrigin(req)||!validCsrf(req,session.session.id)){res.status(403).json({error:'Recarregue a página antes de salvar.'});return;}
      if(!req.is('application/json')){res.status(415).json({error:'Envie dados JSON.'});return;}
      const parsed=z.object({currentPassword:z.string().min(1).max(128),questions:z.array(z.object({id:z.string().max(100),answer:z.string().max(120)}).strict()).length(3)}).strict().parse(req.body);
      await createSecurityQuestionService().enroll(session.user.id,parsed.currentPassword,parsed.questions);
      res.json({configured:true});
    } catch(error){
      if(error instanceof SecurityQuestionError){res.status(error.status).json({error:error.message});return;}
      if(error instanceof ZodError){res.status(400).json({error:'Confira as três perguntas e sua senha atual.'});return;}
      res.status(503).json({error:'Não foi possível salvar suas perguntas agora.'});
    }
  });
  app.post('/api/v1/account/recover-with-questions',async(req,res)=>{
    try {
      if(!validOrigin(req)){res.status(403).json({error:'Origem não autorizada.'});return;}
      if(!req.is('application/json')){res.status(415).json({error:'Envie dados JSON.'});return;}
      const parsed=z.object({email:z.email().max(254),newPassword:z.string().min(12).max(128),confirmPassword:z.string().min(12).max(128),
        questions:z.array(z.object({id:z.string().max(100),answer:z.string().max(120)}).strict()).length(3)}).strict().parse(req.body);
      await createSecurityQuestionService().reset(parsed.email,parsed.questions,parsed.newPassword,parsed.confirmPassword);
      res.json({reset:true});
    } catch(error){
      if(error instanceof SecurityQuestionError){res.status(error.status).json({error:error.message});return;}
      if(error instanceof ZodError){res.status(400).json({error:'Confira seu e-mail, as três respostas e a senha repetida.'});return;}
      res.status(503).json({error:'Não foi possível concluir a recuperação agora.'});
    }
  });
  app.get('/api/v1/account',async(req,res)=>{
    const result=await auth().api.getSession({headers:fromNodeHeaders(req.headers)});
    const data=result?await storeFor(result.user.id).read():null;
    const managed=result&&isManagedOwner(managedWorker(),result.user.email);
    res.json({mode:'cloud',user:result?{id:result.user.id,name:result.user.name,email:result.user.email,username:result.user.username??'',phone:result.user.phone??'',image:result.user.image??null}:null,persistence:'cloud',managed:Boolean(managed),workerConnected:Boolean(managed)||Boolean(data?.connection&&Date.parse(data.connection.expiresAt)>Date.now()),workerUrl:managed?null:data?.connection?.origin??null,workerExpiresAt:managed?null:data?.connection?.expiresAt??null,syncedAt:data?.syncedAt??null});
  });
  app.use('/api/v1',async(req,res,next)=>{
    const result=await auth().api.getSession({headers:fromNodeHeaders(req.headers)});
    if(!result){res.status(401).json({error:'Entre na sua conta para continuar.',code:'AUTH_REQUIRED'});return;}
    res.locals.user=result.user;res.locals.session=result.session;res.locals.store=storeFor(result.user.id);
    const configured=managedWorker();res.locals.managed=isManagedOwner(configured,result.user.email)?configured:null;
    if(!['GET','HEAD','OPTIONS'].includes(req.method)){
      const origin=req.get('origin');const expectedOrigin=new URL(options.baseURL??process.env.BETTER_AUTH_URL??'https://promo-iaulin.vercel.app').origin;
      if(origin!==expectedOrigin){res.status(403).json({error:'Origem não autorizada.'});return;}
      const expected=Buffer.from(csrfFor(result.session.id)),given=Buffer.from(req.get('x-csrf-token')??'');
      if(given.length!==expected.length||!timingSafeEqual(given,expected)){res.status(403).json({error:'Recarregue o painel para renovar a sessão.'});return;}
      if(!req.is('application/json')){res.status(415).json({error:'Envie conteúdo JSON.'});return;}
    }
    next();
  });
  app.get('/api/v1/session',(_req,res)=>res.json({csrfToken:csrfFor(res.locals.session.id),mode:'cloud'}));
  app.put('/api/v1/account/profile',async(req,res)=>{
    const fields=z.object({
      name:z.string().trim().min(2).max(100),
      username:z.string().trim().max(40).regex(/^[a-zA-Z0-9._-]*$/).optional(),
      phone:z.string().trim().max(24).regex(/^[+0-9 ()-]*$/).optional(),
      image:z.union([z.string().max(220000).regex(/^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/),z.null()]).optional()
    }).strict().parse(req.body);
    const result=await auth().api.updateUser({headers:fromNodeHeaders(req.headers),body:fields});res.json(result);
  });
  app.post('/api/v1/account/password',async(req,res)=>{
    const parsed=z.object({currentPassword:z.string().min(1).max(128),newPassword:z.string().min(12).max(128),confirmPassword:z.string().min(12).max(128)}).strict().parse(req.body);
    if(parsed.newPassword!==parsed.confirmPassword){res.status(400).json({error:'As novas senhas não conferem.'});return;}
    const result=await auth().api.changePassword({headers:fromNodeHeaders(req.headers),body:{currentPassword:parsed.currentPassword,newPassword:parsed.newPassword,revokeOtherSessions:true},returnHeaders:true});
    for(const cookie of result.headers.getSetCookie())res.append('Set-Cookie',cookie);
    res.json({status:Boolean(result.response)});
  });
  app.post('/api/v1/account/worker',async(req,res)=>{
    const {pairingUrl,useSavedSettings}=z.object({pairingUrl:z.string().max(2048),useSavedSettings:z.boolean().default(false)}).strict().parse(req.body);
    const parsed=parsePairingUrl(pairingUrl), store=res.locals.store as JsonDocumentStore<AccountData>;
    const pair=await proxy(parsed.origin,'/api/v1/remote/pair',{method:'POST',body:{code:parsed.code}});
    if(pair.status!==200)throw new CloudError(409,'O código de pareamento foi recusado ou expirou. Gere outro no painel do computador.');
    const body=JSON.parse(pair.body.toString()) as {csrfToken:string;expiresAt:string};
    const cookie=pair.cookies.map(item=>item.split(';')[0]).find(item=>/^promobridge_remote=[A-Za-z0-9_-]{43}$/.test(item));
    if(!cookie || !/^[a-f0-9]{64}$/.test(body.csrfToken) || !Number.isFinite(Date.parse(body.expiresAt)) || Date.parse(body.expiresAt)<=Date.now() || Date.parse(body.expiresAt)>Date.now()+24*3600000)throw new CloudError(502,'O aplicativo respondeu com um pareamento inválido. Atualize o aplicativo do computador.');
    const connection:WorkerConnection={origin:parsed.origin,encryptedCookie:sealCookie(cookie,res.locals.user.id),csrf:body.csrfToken,expiresAt:body.expiresAt};
    if(useSavedSettings){const saved=await store.read();const result=await proxy(connection.origin,'/api/v1/settings',{method:'PUT',body:saved.settings,cookie,csrf:connection.csrf});if(result.status!==200)throw new CloudError(409,'O computador não aceitou suas preferências. Confira a configuração local.');}
    const result=await proxy(connection.origin,'/api/v1/state',{cookie});
    if(result.status!==200)throw new CloudError(502,'Pareamento criado, mas o computador não entregou os dados. Tente novamente.');
    await saveSnapshot(store,JSON.parse(result.body.toString()) as AppSnapshot,connection);
    res.json({connected:true,origin:connection.origin,expiresAt:connection.expiresAt});
  });
  app.delete('/api/v1/account/worker',async(_req,res)=>{await(res.locals.store as JsonDocumentStore<AccountData>).transact(draft=>{draft.connection=null;});res.json({connected:false});});
  // Account identity and device administration above always stay in the cloud.
  app.use('/api/v1',async(req,res,next)=>{
    const store=res.locals.store as JsonDocumentStore<AccountData>, data=await store.read(), managed=res.locals.managed as ManagedWorker|null;
    const paired=data.connection&&Date.parse(data.connection.expiresAt)>Date.now()?data.connection:null;
    if(!managed&&!paired){res.locals.data=data;next();return;}
    const origin=managed?managed.origin:paired!.origin;
    // The hosted server authenticates with its own secret; a paired computer keeps its encrypted cookie.
    const reading=()=>managed?{bearer:managed.token}:{cookie:openCookie(paired!.encryptedCookie,res.locals.user.id)};
    const writing=()=>managed?{bearer:managed.token}:{cookie:openCookie(paired!.encryptedCookie,res.locals.user.id),csrf:paired!.csrf};
    // Tunnel control is for a computer; plaintext credential entry never goes through a computer-linked site.
    const credentials=/^\/affiliates\/[^/]+\/credentials/.test(req.path);
    if(/^\/remote(?:\/|$)/.test(req.path)||(credentials&&!managed)){res.status(409).json({error:managed?'O acesso remoto não é necessário: seu servidor já está na nuvem.':'Abra o painel no computador para esta configuração.'});return;}
    try{
      const result=await proxy(origin,`/api/v1${req.url}`,{method:req.method,...(!['GET','HEAD'].includes(req.method)?{body:req.body}:{}),...writing()});
      if([401,403].includes(result.status)){res.locals.data=data;next();return;}
      if(req.path==='/state'&&result.status===200&&(!data.syncedAt||Date.now()-Date.parse(data.syncedAt)>30000))await saveSnapshot(store,JSON.parse(result.body.toString()) as AppSnapshot);
      else if(!['GET','HEAD'].includes(req.method)&&result.status<300){const state=await proxy(origin,'/api/v1/state',reading());if(state.status===200)await saveSnapshot(store,JSON.parse(state.body.toString()) as AppSnapshot);}
      if(result.contentType.split(';')[0].trim().toLowerCase()==='application/json'){
        let body:unknown;try{body=JSON.parse(result.body.toString('utf8'));}catch{throw new Error('Resposta JSON inválida.');}
        res.status(result.status).json(body);return;
      }
      if(/^\/media\/[0-9a-f-]{36}$/i.test(req.path) && result.status===200 && readJpegThumbnail(result.body,'image/jpeg')){res.type('image/jpeg').send(result.body);return;}
      res.status(502).json({error:managed?'O servidor respondeu com um formato inesperado. Atualize a hospedagem do WhatsApp.':'O computador respondeu com um formato inesperado. Atualize o aplicativo local.'});
    }catch{
      if(['GET','HEAD'].includes(req.method)){res.locals.data=data;next();return;}
      // Never repeat an ambiguous mutation against offline data.
      res.status(503).json({error:managed?'A conexão com o servidor do WhatsApp caiu. Confira o resultado no painel antes de repetir esta ação.':'A conexão com o computador caiu. Confira o resultado no painel local antes de repetir esta ação.'});
    }
  });
  app.get('/api/v1/state',(_req,res)=>res.json(snapshot(res.locals.data,Boolean(res.locals.managed))));
  app.get('/api/v1/health',(_req,res)=>res.json({ok:true,...snapshot(res.locals.data,Boolean(res.locals.managed)).health,whatsappConnected:false,mode:'cloud'}));
  app.put('/api/v1/settings',async(req,res)=>{
    const settings=settingsSchema.strict().parse(req.body);
    if(settings.destinationGroup && settings.sourceGroups.includes(settings.destinationGroup))throw new CloudError(400,'O destino não pode ser também um grupo-fonte.');
    for(const item of Object.values(settings.affiliates))item.verifiedAt=null;
    await(res.locals.store as JsonDocumentStore<AccountData>).transact(draft=>{draft.settings=settings;});res.json(settings);
  });
  app.post('/api/v1/simulate',async(req,res)=>{
    const {text}=z.object({text:z.string().min(1).max(16000)}).passthrough().parse(req.body),data=res.locals.data as AccountData;
    const offers=await processPromotion({text,sourceId:'simulator',sourceName:'Simulador',messageId:randomUUID(),simulation:true},data.settings,{history:data.offers,resolveUrl:async url=>{const product=identifyProduct(url);if(!product)throw new Error('Use uma URL direta do produto na simulação online.');return product.canonicalUrl;}});
    await(res.locals.store as JsonDocumentStore<AccountData>).transact(draft=>{draft.offers=[...offers,...draft.offers].slice(0,3000);});res.json(offers);
  });
  app.get('/api/v1/affiliates/guides',(_req,res)=>res.json(getIntegrationGuides()));
  app.get('/api/v1/affiliates/credentials',(_req,res)=>res.json(platformIds.map(platform=>({platform,configured:false,revision:'',updatedAt:null,fields:[]}))));
  app.get('/api/v1/affiliate-links',(_req,res)=>res.json([]));
  app.get('/api/v1/whatsapp/groups',(_req,res)=>res.json([]));
  app.get('/api/v1/remote',(_req,res)=>res.json({state:'off',mode:null,publicUrl:null,expiresAt:null,activeSessions:0,message:'Abra o aplicativo no computador para gerar o link de pareamento. Depois conecte-o em Minha conta.'}));
  app.get('/api/v1/setup',(_req,res)=>res.json(res.locals.managed?{ready:false,next:'O servidor do WhatsApp não respondeu. Aguarde alguns minutos e atualize a página.',checks:[{key:'worker',label:'Servidor do WhatsApp',ready:false,detail:'Suas preferências estão salvas na conta. O servidor executa a captura e as publicações.',page:'sources'}]}:{ready:false,next:'Conecte seu computador em Minha conta para ativar o WhatsApp.',checks:[{key:'worker',label:'Computador conectado',ready:false,detail:'Suas preferências estão salvas na conta. O computador executa a captura e as publicações.',page:'sources'}]}));
  app.get('/api/v1/backup',(_req,res)=>{const data=res.locals.data as AccountData;res.json({schemaVersion:1,exportedAt:new Date().toISOString(),settings:data.settings,offers:data.offers,feedback:[],activity:data.activity});});
  app.use('/api/v1',(_req,res)=>res.status(409).json({error:'Conecte seu computador em Minha conta para usar esta função com seu WhatsApp. As preferências da conta já estão salvas no servidor.'}));
  app.use((error:unknown,_req:Request,res:Response,_next:NextFunction)=>{
    if(error instanceof ZodError){res.status(400).json({error:'Confira os dados informados.'});return;}
    if(error instanceof CloudError){res.status(error.status).json({error:error.message});return;}
    if(error instanceof SyntaxError){res.status(400).json({error:'Conteúdo JSON inválido.'});return;}
    if(error&&typeof error==='object'&&'statusCode' in error&&typeof error.statusCode==='number'&&error.statusCode>=400&&error.statusCode<500){res.status(error.statusCode).json({error:'Não foi possível alterar a conta. Confira sua senha atual e os dados informados.'});return;}
    res.status(503).json({error:'Não foi possível acessar o armazenamento da conta. Tente novamente em instantes.'});
  });
  return app;
}
