import { platformNames, type Offer } from '../../../packages/shared/src/index.ts';

export type OffersKind = 'queue' | 'discover' | 'published';
export type OfferFilter = Offer['status'] | 'all' | 'simulation';

type FilterOption = { value: OfferFilter; label: string };
const common: FilterOption[] = [
  { value: 'all', label: 'Todas as ofertas' },
  { value: 'review', label: 'Em revisão' },
  { value: 'approved', label: 'Aprovadas' },
  { value: 'blocked', label: 'Retidas' },
  { value: 'uncertain', label: 'Envios a conferir' },
  { value: 'failed', label: 'Falhas no envio' },
  { value: 'simulation', label: 'Simulações' },
];

const filters: Record<OffersKind, readonly FilterOption[]> = {
  queue: [...common, { value: 'duplicate', label: 'Repetidas' }, { value: 'publishing', label: 'Enviando' }],
  discover: [...common, { value: 'publishing', label: 'Enviando' }, { value: 'published', label: 'Publicadas' }],
  published: [{ value: 'all', label: 'Todas as publicações' }],
};

export function offerFilterOptions(kind: OffersKind): readonly FilterOption[] {
  return filters[kind];
}

/** A filter selected in another tab must not silently hide this tab's offers. */
export function effectiveOfferFilter(
  kind: OffersKind,
  selection: { kind: OffersKind; value: OfferFilter },
): OfferFilter {
  return selection.kind === kind && filters[kind].some(option => option.value === selection.value)
    ? selection.value
    : 'all';
}

export function visibleOffers(offers: readonly Offer[], kind: OffersKind, filter: OfferFilter, query: string): Offer[] {
  const search = query.trim().toLocaleLowerCase('pt-BR');
  return offers.filter(offer => {
    if (kind === 'published' && offer.status !== 'published') return false;
    if (kind === 'discover' && ['rejected', 'duplicate'].includes(offer.status)) return false;
    if (kind === 'queue' && ['published', 'rejected'].includes(offer.status)) return false;
    if (filter !== 'all' && !(filter === 'simulation' ? offer.simulation : offer.status === filter)) return false;
    return !search || `${offer.title} ${offer.platform ? platformNames[offer.platform] : ''} ${offer.coupon || ''}`
      .toLocaleLowerCase('pt-BR').includes(search);
  }).sort((a, b) => kind === 'discover' ? b.score - a.score : b.createdAt.localeCompare(a.createdAt));
}
