// Esquemas puros (sem SQLite nem arquivos): usados também pelo servidor na nuvem (Cloudflare).
import { z } from 'zod';
import { categoryIds, platformIds } from '../../shared/src/index.ts';

export const timestamp = z.iso.datetime({ offset: true });
export const boundedText = z.string().max(32000);
export const safeUrl = z.string().max(4096).refine(value => {
  if (!value) return true;
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password; } catch { return false; }
}, 'URL inválida');
export const localMediaUrl = z.string().regex(/^\/api\/v1\/media\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
export const recordNamespace = z.string().min(1).max(100).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);
export const recordId = z.string().min(1).max(500);
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
  publishedAt:timestamp.nullable(), imageUrl:z.union([safeUrl,localMediaUrl]).nullable().optional(),
  affiliateReceiptId:z.string().min(1).max(200).nullable().optional(),
  affiliateMethod:z.enum(['amazon-tag','official-api','owner-reviewed']).nullable().optional(),
  requiresManualApproval:z.boolean().optional(), manuallyApprovedAt:timestamp.nullable().optional(),
  scheduledAt:timestamp.nullable().optional(), expiresAt:timestamp.nullable().optional(),
  providerMessageId:z.string().min(1).max(200).nullable().optional(), mediaId:z.uuid().nullable().optional()
}).strict();
