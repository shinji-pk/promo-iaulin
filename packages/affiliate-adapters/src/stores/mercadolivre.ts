import type { StoreAdapter } from '../common.ts';
import { product, supportedHost } from '../common.ts';

export const mercadolivre: StoreAdapter = {
  id:'mercadolivre', matches:url=>supportedHost(url,['mercadolivre.com.br']),
  identify(url) {
    if (!this.matches(url)) return null;
    const userProduct=url.pathname.match(/\/up\/(MLBU\d{5,20})(?:\/|$)/i);
    if (userProduct) return product('mercadolivre', `user:${userProduct[1].toUpperCase()}`, `https://www.mercadolivre.com.br/up/${userProduct[1].toUpperCase()}`);
    const catalog = url.pathname.match(/\/p\/(MLB\d{5,20})(?:\/|$)/i);
    if (catalog) return product('mercadolivre', `catalog:${catalog[1].toUpperCase()}`, `https://www.mercadolivre.com.br/p/${catalog[1].toUpperCase()}`);
    const item = url.pathname.match(/(?:^|\/)(MLB)[-]?(\d{5,20})(?:-|\/|$)/i);
    if (!item) return null;
    return product('mercadolivre', `MLB${item[2]}`, `https://produto.mercadolivre.com.br/MLB-${item[2]}`);
  }
};
