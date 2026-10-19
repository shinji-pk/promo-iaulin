import type { PlatformId } from '../../../shared/src/index.ts';
import type { OfficialAffiliateProvider } from './types.ts';
import { amazonCreatorsProvider } from './amazon.ts';
import { shopeeOfficialProvider } from './shopee.ts';
import { aliexpressLegacyProvider } from './aliexpress.ts';

export type { ProviderContext, OfficialAffiliateResult, OfficialAffiliateProvider } from './types.ts';
export { amazonCreatorsProvider, shopeeOfficialProvider, aliexpressLegacyProvider };

export const defaultProviders: Partial<Record<PlatformId, OfficialAffiliateProvider>> = {
  amazon: amazonCreatorsProvider,
  shopee: shopeeOfficialProvider,
  aliexpress: aliexpressLegacyProvider
};
