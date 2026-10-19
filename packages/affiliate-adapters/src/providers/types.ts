import type { AffiliateConfig, Product } from '../../../shared/src/index.ts';

export interface ProviderContext {
  product: Product;
  config: AffiliateConfig;
  credentials: Record<string, string>;
  fetch?: typeof fetch;
  now?: () => number;
}

export interface OfficialAffiliateResult {
  url: string;
  source: 'amazon' | 'shopee' | 'aliexpress';
  reason: string;
}

export interface OfficialAffiliateProvider {
  convert(context: ProviderContext): Promise<OfficialAffiliateResult>;
}
