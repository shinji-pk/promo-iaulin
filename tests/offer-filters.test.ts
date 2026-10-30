import { describe, expect, it } from 'vitest';
import type { Offer } from '../packages/shared/src/index.ts';
import { effectiveOfferFilter, offerFilterOptions, visibleOffers } from '../apps/web/src/offer-filters.ts';

function offer(id: string, status: Offer['status'], overrides: Partial<Offer> = {}): Offer {
  return {
    id, status, title: `Oferta ${id}`, platform: null, coupon: null, simulation: false,
    score: 50, createdAt: '2026-10-29T12:00:00.000Z', ...overrides,
  } as Offer;
}

describe('contextual offer filters', () => {
  it('shows only relevant filters in each tab', () => {
    expect(offerFilterOptions('published').map(item => item.value)).toEqual(['all']);
    expect(offerFilterOptions('queue').map(item => item.value)).not.toContain('published');
    expect(offerFilterOptions('discover').map(item => item.value)).toContain('published');
  });

  it('does not carry a restrictive filter into another tab', () => {
    expect(effectiveOfferFilter('published', { kind: 'queue', value: 'approved' })).toBe('all');
    expect(effectiveOfferFilter('discover', { kind: 'discover', value: 'published' })).toBe('published');
    expect(effectiveOfferFilter('published', { kind: 'published', value: 'failed' })).toBe('all');
  });

  it('shows published offers in history even after switching from an approved queue filter', () => {
    const offers = [offer('published', 'published'), offer('approved', 'approved')];
    const selected = effectiveOfferFilter('published', { kind: 'queue', value: 'approved' });
    expect(visibleOffers(offers, 'published', selected, '').map(item => item.id)).toEqual(['published']);
  });

  it('preserves the queue/discover status boundaries and simulation filter', () => {
    const offers = [
      offer('published', 'published'), offer('rejected', 'rejected'),
      offer('duplicate', 'duplicate'), offer('review', 'review'),
      offer('simulated', 'simulated', { simulation: true }),
    ];
    expect(visibleOffers(offers, 'queue', 'all', '').map(item => item.id)).toEqual(['duplicate', 'review', 'simulated']);
    expect(visibleOffers(offers, 'discover', 'all', '').map(item => item.id)).toEqual(['published', 'review', 'simulated']);
    expect(visibleOffers(offers, 'queue', 'simulation', '').map(item => item.id)).toEqual(['simulated']);
  });

  it('searches by title, store and coupon without changing the input order', () => {
    const offers = [
      offer('a', 'review', { title: 'Cafeteira', platform: 'amazon', coupon: 'BOM10', score: 10 }),
      offer('b', 'review', { title: 'Secador', platform: 'shopee', score: 90 }),
    ];
    expect(visibleOffers(offers, 'discover', 'all', '  CAFETEIRA  ').map(item => item.id)).toEqual(['a']);
    expect(visibleOffers(offers, 'queue', 'all', 'shopee').map(item => item.id)).toEqual(['b']);
    expect(visibleOffers(offers, 'queue', 'all', 'bom10').map(item => item.id)).toEqual(['a']);
    expect(visibleOffers(offers, 'discover', 'all', '').map(item => item.id)).toEqual(['b', 'a']);
    expect(offers.map(item => item.id)).toEqual(['a', 'b']);
  });
});
