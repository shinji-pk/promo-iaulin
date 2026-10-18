import { z } from 'zod';

export const platformIds = ['amazon','shopee','mercadolivre','magalu','aliexpress','shein','temu'] as const;
export type PlatformId = typeof platformIds[number];
export const platformNames: Record<PlatformId,string> = { amazon:'Amazon', shopee:'Shopee', mercadolivre:'Mercado Livre', magalu:'Magalu', aliexpress:'AliExpress', shein:'SHEIN', temu:'Temu' };
export const categoryIds = ['beleza','moda','casa','tecnologia','bem-estar','maternidade','outros'] as const;
export type CategoryId = typeof categoryIds[number];
export const categoryNames: Record<CategoryId,string> = {beleza:'Beleza & cuidados',moda:'Moda & acessórios',casa:'Casa & organização',tecnologia:'Tecnologia', 'bem-estar':'Bem-estar',maternidade:'Maternidade',outros:'Outros'};

export const affiliateConfigSchema = z.object({
  enabled: z.boolean().default(false), publicId: z.string().max(100).default(''),
  originalUrl: z.string().max(2048).default(''), affiliateUrl: z.string().max(2048).default(''),
  verifiedAt: z.string().nullable().default(null)
});
export type AffiliateConfig = z.infer<typeof affiliateConfigSchema>;
export const settingsSchema = z.object({
  mode:z.enum(['manual','semi','auto']).default('manual'), paused:z.boolean().default(false),
  minScore:z.number().int().min(0).max(100).default(75), dedupeDays:z.number().int().min(1).max(90).default(7),
  maxPostsPerHour:z.number().int().min(1).max(30).default(4), minIntervalMinutes:z.number().int().min(1).max(1440).default(10),
  quietStart:z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).default('22:00'), quietEnd:z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).default('08:00'),
  timezone:z.string().refine(value => { try { new Intl.DateTimeFormat('en',{timeZone:value}); return true; } catch { return false; } }).default('America/Sao_Paulo'),
  sourceGroups:z.array(z.string().max(100)).max(100).default([]), destinationGroup:z.string().max(100).default(''),
  audience:z.object({weights:z.record(z.enum(categoryIds),z.number().min(0).max(100)),blockedWords:z.array(z.string().max(100)).max(100).default([]),blockedPlatforms:z.array(z.enum(platformIds)).default([])}).default({weights:{beleza:90,moda:80,casa:85,tecnologia:65,'bem-estar':70,maternidade:0,outros:30},blockedWords:[],blockedPlatforms:[]}),
  message:z.object({style:z.enum(['elegant','compact','warm']).default('elegant'),signature:z.string().max(240).default('Garimpos que valem a pena. ♡'),cta:z.string().min(1).max(120).default('Veja os detalhes e aproveite')}).default({style:'elegant',signature:'Garimpos que valem a pena. ♡',cta:'Veja os detalhes e aproveite'}),
  affiliates:z.record(z.enum(platformIds),affiliateConfigSchema).default(Object.fromEntries(platformIds.map(id=>[id,{enabled:false,publicId:'',originalUrl:'',affiliateUrl:'',verifiedAt:null}])) as Record<PlatformId,AffiliateConfig>),
  retentionDays:z.number().int().min(30).max(730).default(90), onboardingComplete:z.boolean().default(false),
  allowPriceDrop:z.boolean().default(true),priceDropPercent:z.number().min(5).max(90).default(15)
});
export type Settings = z.infer<typeof settingsSchema>;
export const defaultSettings = (): Settings => structuredClone(settingsSchema.parse({}));

export type IntegrationState = 'not_configured'|'needs_calibration'|'testing'|'ready'|'degraded'|'blocked';
export interface Product { platform:PlatformId; productId:string; productKey:string; canonicalUrl:string; }
export interface Validation { valid:boolean; reason:string; method:string; }
export interface IntegrationStatus { id:PlatformId; name:string; state:IntegrationState; reason:string; }
export interface ScoreFactor {label:string; points:number;}
export interface ParsedOffer {title:string; price:number|null; previousPrice:number|null; discount:number|null; coupon:string|null; freeShipping:boolean; category:CategoryId; confidence:number;}
export interface Stage { name:string; status:'ok'|'blocked'|'pending'; detail:string; }
export type OfferStatus = 'review'|'approved'|'rejected'|'duplicate'|'blocked'|'publishing'|'published'|'simulated'|'failed'|'uncertain';
export interface Offer {
  id:string; createdAt:string; updatedAt:string; sourceId:string; sourceName:string; sourceMessageId:string;
  simulation:boolean; originalText:string; originalUrl:string; canonicalUrl:string; affiliateUrl:string|null;
  productKey:string; platform:PlatformId|null; productId:string|null;
  title:string; price:number|null; previousPrice:number|null; discount:number|null; coupon:string|null; freeShipping:boolean;
  category:CategoryId; score:number; confidence:number; factors:ScoreFactor[];
  affiliateValid:boolean; reasons:string[]; stages:Stage[]; rewrittenText:string;
  status:OfferStatus; publishedAt:string|null; imageUrl?:string|null;
}
export interface Feedback { id:string; offerId:string; action:'approve'|'reject'|'edit'; category:CategoryId; reason:string; createdAt:string; }
export interface Activity {id:string; createdAt:string; level:'info'|'warning'|'error'; event:string; message:string; offerId?:string;}
export interface WhatsAppGroup {id:string; name:string; participants:number;}
export interface WhatsAppStatus {connected:boolean; connecting:boolean; qrDataUrl:string|null; user:string|null; groups:WhatsAppGroup[]; lastError:string|null;}
export interface IngestInput {text:string; sourceId:string; sourceName:string; messageId:string; simulation:boolean; imageUrl?:string|null;}
export interface AppSnapshot {settings:Settings; offers:Offer[]; integrations:IntegrationStatus[]; whatsapp:WhatsAppStatus; activity:Activity[]; feedbackCount:number; stats:{seen:number;published:number;review:number;blocked:number;simulated:number;}; health:{uptime:number;databaseBytes:number;version:string;};}

export const ingestSchema = z.object({text:z.string().min(1).max(16000),sourceId:z.string().max(100).default('simulator'),sourceName:z.string().max(100).default('Simulador'),messageId:z.string().max(200).optional(),simulation:z.boolean().default(true)});
