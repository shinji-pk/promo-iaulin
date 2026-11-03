export interface FeedEntry {
  title: string; link: string | null; guid: string | null; summary: string; author: string | null;
  categories: string[]; publishedAt: string | null; updatedAt: string | null; language: string | null;
}
export interface ParsedFeed { title: string; language: string | null; entries: FeedEntry[]; }

const MAX_ENTRIES = 60;
const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
export function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,6});/gi, (whole, code: string) => {
    if (code[0] === '#') {
      const point = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(point) && point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff) ? String.fromCodePoint(point) : '';
    }
    return entities[code.toLowerCase()] ?? whole;
  });
}
/** Turns HTML from a feed into plain text: no markup, scripts or hidden content survive. */
export function plainText(value: string, max = 2000): string {
  const withoutCdata = value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  const decoded = decodeEntities(withoutCdata);
  return decodeEntities(decoded.replace(/<(script|style|iframe|noscript)[\s\S]*?<\/\1>/gi, ' ').replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n').replace(/<[^>]{0,2000}>/g, ' '))
    // eslint-disable-next-line no-control-regex -- remove control characters from untrusted feed text
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim().slice(0, max);
}
const escape = (name: string) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function child(block: string, names: string[]): string | null {
  for (const name of names) {
    const match = new RegExp(`<(?:[a-z0-9]+:)?${escape(name)}(?:\\s[^>]{0,1000})?>([\\s\\S]{0,200000}?)</(?:[a-z0-9]+:)?${escape(name)}>`, 'i').exec(block);
    if (match) return match[1];
  }
  return null;
}
function children(block: string, name: string): string[] {
  const found: string[] = [];
  const pattern = new RegExp(`<(?:[a-z0-9]+:)?${escape(name)}(\\s[^>]{0,1000})?(?:/>|>([\\s\\S]{0,2000}?)</(?:[a-z0-9]+:)?${escape(name)}>)`, 'gi');
  for (let match = pattern.exec(block); match && found.length < 20; match = pattern.exec(block)) {
    const term = /\bterm="([^"]{1,100})"/i.exec(match[1] ?? '')?.[1];
    const value = plainText(term ?? match[2] ?? '', 100);
    if (value) found.push(value);
  }
  return found;
}
function date(value: string | null): string | null {
  if (!value) return null;
  const time = Date.parse(plainText(value, 100));
  return Number.isFinite(time) && time > Date.UTC(1990, 0, 1) ? new Date(time).toISOString() : null;
}
function link(block: string): string | null {
  const atom = [...block.matchAll(/<link\b([^>]{0,1000})\/?>/gi)].map(match => match[1]);
  const preferred = atom.find(attrs => /href=/.test(attrs) && (!/\brel=/.test(attrs) || /\brel="alternate"/.test(attrs))) ?? atom.find(attrs => /href=/.test(attrs));
  const href = preferred ? /\bhref="([^"]{1,2048})"/i.exec(preferred)?.[1] : null;
  const value = href ? decodeEntities(href) : plainText(child(block, ['link']) ?? '', 2048);
  try { const url = new URL(value.trim()); return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null; } catch { return null; }
}

/**
 * Minimal RSS 2.0 / Atom reader for untrusted input. Documents with DOCTYPE or entity
 * declarations are refused (no XXE, no entity expansion). Only metadata and the publisher's
 * own short summary are read; full articles are never copied.
 */
export function parseFeed(xml: string): ParsedFeed {
  if (xml.length > 2_000_000) throw new Error('Feed grande demais.');
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('Feeds com declaração DOCTYPE ou ENTITY não são aceitos por segurança.');
  const source = xml.replace(/<!--[\s\S]*?-->/g, '');
  if (!/<(rss|feed|rdf:RDF)\b/i.test(source)) throw new Error('O endereço não contém um feed RSS ou Atom.');
  const language = plainText(child(source, ['language']) ?? '', 20) || /<feed[^>]*\bxml:lang="([^"]{2,20})"/i.exec(source)?.[1] || null;
  const head = source.split(/<(?:item|entry)\b/i)[0];
  const title = plainText(child(head, ['title']) ?? '', 200);
  const blocks = [...source.matchAll(/<(item|entry)\b[^>]{0,1000}>([\s\S]{0,400000}?)<\/\1>/gi)].slice(0, MAX_ENTRIES).map(match => match[2]);
  const entries: FeedEntry[] = [];
  for (const block of blocks) {
    const entryTitle = plainText(child(block, ['title']) ?? '', 300);
    if (!entryTitle) continue;
    entries.push({
      title: entryTitle,
      link: link(block),
      guid: plainText(child(block, ['guid', 'id']) ?? '', 500) || null,
      summary: plainText(child(block, ['description', 'summary', 'subtitle']) ?? '', 1200),
      author: plainText(child(block, ['creator', 'author']) ?? '', 120).split('\n')[0] || null,
      categories: children(block, 'category'),
      publishedAt: date(child(block, ['pubDate', 'published', 'issued', 'date'])),
      updatedAt: date(child(block, ['updated', 'modified'])),
      language: language ? language.toLowerCase() : null,
    });
  }
  return { title, language: language ? language.toLowerCase() : null, entries };
}
