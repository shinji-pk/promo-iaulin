import type { PlatformId, Product, Validation } from './index.ts';

export type AffiliateMethod = 'amazon-tag'|'official-api'|'owner-reviewed';
export interface AffiliateConversion { url:string; receiptId:string; method:AffiliateMethod; requiresManualApproval:boolean; reason:string; expiresAt?:string; }
export interface AffiliateReceipt {
  id:string; platform:PlatformId; productKey:string; url:string; method:AffiliateMethod;
  createdAt:string; expiresAt:string; configFingerprint:string; credentialRevision:string;
  requiresManualApproval:boolean; ownerConfirmed:boolean; source:'amazon'|'shopee'|'aliexpress'|'library';
}
export interface ApprovedLink {
  id:string; platform:PlatformId; productKey:string; originalUrl:string; affiliateUrl:string;
  title:string; ownerConfirmed:boolean; createdAt:string; updatedAt:string;
}
export interface IntegrationField {key:string;label:string;secret:boolean;required:boolean;hint?:string;}
export interface IntegrationGuide {
  platform:PlatformId; name:string; automatic:boolean; officialPortal:string; documentationUrl:string;
  steps:string[]; fields:IntegrationField[]; note:string;
}
export interface CredentialStatus {platform:PlatformId;configured:boolean;revision:string;updatedAt:string|null;fields:string[];}
export interface SetupCheck {key:string;label:string;ready:boolean;detail:string;page:'sources'|'affiliates'|'automation'|'health';}
export interface SetupStatus {ready:boolean;checks:SetupCheck[];next:string;}
export interface AffiliatePort {
  convert(product:Product):Promise<AffiliateConversion>;
  validate(receiptId:string|undefined|null,product:Product,url:string):Validation;
}
export interface OperationJob {id:string;kind:'reprocess';status:'running'|'completed'|'failed';total:number;processed:number;errors:number;message:string;}
