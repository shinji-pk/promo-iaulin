import type { StoreAdapter } from '../common.ts';
import { product, supportedHost } from '../common.ts';

export const temu: StoreAdapter = {
  id:'temu', matches:url=>supportedHost(url,['temu.com']),
  identify(url) {
    if (!this.matches(url)) return null;
    const pathId = url.pathname.match(/-g-(\d{5,25})\.html(?:\/|$)/)?.[1];
    const queryIds = url.searchParams.getAll('goods_id');
    if (queryIds.length > 1 || (queryIds[0] && !/^\d{5,25}$/.test(queryIds[0]))) return null;
    const id = pathId ?? queryIds[0];
    if (!id || (pathId && queryIds[0] && pathId !== queryIds[0])) return null;
    return product('temu', id, `https://www.temu.com/goods.html?goods_id=${id}`);
  }
};
