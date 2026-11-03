import { createHash, randomUUID } from 'node:crypto';
import { newsSourceSchema, type Channel, type EditorialProfile, type NewsItem, type NewsSource, type PostInput } from '../../../../packages/shared/src/channels.ts';
import type { ChannelRepository } from '../../../../packages/db/src/channels.ts';
import { validateUrl } from '../../../../packages/core/src/resolver.ts';
import type { SafeFetchResult } from '../../../../packages/core/src/safe-fetch.ts';
import { parseFeed, type FeedEntry } from './feed.ts';
import type { AiService } from './ai.ts';

export type FeedFetcher = (url: string, conditional?: { etag?: string | null; lastModified?: string | null }) => Promise<SafeFetchResult>;
const MAX_SOURCES = 30;
const DAY = 86_400_000;

export const normalizeWords = (value: string) => value.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
const tokens = (value: string) => new Set(normalizeWords(value).split(/[^\p{L}\p{N}]+/u).filter(word => word.length >= 3));
export function similarity(a: string, b: string): number {
  const left = tokens(a), right = tokens(b);
  if (!left.size || !right.size) return 0;
  let shared = 0; for (const word of left) if (right.has(word)) shared++;
  return shared / (left.size + right.size - shared);
}
const containsTerm = (haystack: string, term: string) => {
  const needle = normalizeWords(term.trim());
  return needle.length >= 2 && new RegExp(`(^|[^\\p{L}\\p{N}])${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^\\p{L}\\p{N}]|$)`, 'u').test(haystack);
};

/** Strips tracking parameters so the same article from different links is recognized. */
export function canonicalNewsUrl(value: string): string {
  try {
    const url = new URL(value);
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) if (/^(utm_|fbclid|gclid|mc_|ref$|cmpid|ocid)/i.test(key)) url.searchParams.delete(key);
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, '');
    return url.href.replace(/\/$/, '');
  } catch { return value; }
}

/** Rule-based relevance. No configured criteria means nothing is relevant: the owner chooses the topic. */
export function scoreNews(entry: Pick<FeedEntry, 'title' | 'summary' | 'categories' | 'language'>, profile: EditorialProfile): { relevance: number; matched: string[]; excluded: string | null; languageMismatch: boolean } {
  const title = normalizeWords(entry.title), body = normalizeWords(`${entry.summary}\n${entry.categories.join(' ')}`);
  const all = `${title}\n${body}`;
  const excluded = profile.excludedWords.find(word => containsTerm(all, word)) ?? null;
  const languageMismatch = Boolean(profile.languages.length && entry.language && !profile.languages.some(language => entry.language!.startsWith(language.toLowerCase().slice(0, 2))));
  let relevance = 0; const matched: string[] = [];
  const add = (term: string, inTitle: number, inBody: number) => {
    if (containsTerm(title, term)) { relevance += inTitle; matched.push(term); }
    else if (containsTerm(body, term)) { relevance += inBody; matched.push(term); }
  };
  for (const keyword of profile.keywords) add(keyword, 3, 1);
  for (const subtopic of profile.subtopics) add(subtopic, 2, 1);
  for (const region of profile.regions) add(region, 1, 1);
  if (profile.mainTopic) add(profile.mainTopic, 2, 1);
  return { relevance, matched: [...new Set(matched)].slice(0, 20), excluded, languageMismatch };
}

const dateFormat = (value: string | null, timezone: string) => value ? `${new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeZone: timezone }).format(new Date(value))} às ${new Intl.DateTimeFormat('pt-BR', { timeStyle: 'short', timeZone: timezone }).format(new Date(value))}` : null;
const cut = (value: string, max: number) => value.length <= max ? value : `${value.slice(0, max).replace(/\s+\S*$/, '')}…`;

/** A factual draft from the source's own metadata. Dates are labeled separately and never merged. */
export function ruleDraft(item: NewsItem, channel: Pick<Channel, 'settings' | 'editorial'>, ai?: { summary: string; title: string | null; analysis: string | null } | null): PostInput {
  const profile = channel.editorial, timezone = channel.settings.timezone;
  const emoji = (value: string) => profile.emojis === 'none' ? '' : `${value} `;
  const limit = profile.length === 'short' ? 220 : profile.length === 'medium' ? 420 : 640;
  const facts = ai?.summary ? `${ai.summary}\n(Resumo preparado a partir do texto publicado pela fonte.)` : item.excerpt ? `Segundo ${item.sourceLabel}: ${cut(item.excerpt, limit)}` : `Segundo ${item.sourceLabel}. Leia os detalhes no link da fonte.`;
  const dates = [
    `${emoji('🗓️')}Publicado pela fonte: ${dateFormat(item.publishedAt, timezone) ?? 'data não informada'}`,
    item.updatedAt && item.updatedAt !== item.publishedAt ? `Atualizado pela fonte: ${dateFormat(item.updatedAt, timezone)}` : '',
    `Data do acontecimento: ${item.eventDate ? dateFormat(item.eventDate, timezone) : 'não informada pela fonte'}`,
  ].filter(Boolean).join('\n');
  const confirmation = item.confirmation === 'corroborated'
    ? `${emoji('✅')}Também noticiado por ${item.corroboratingSources} outra(s) fonte(s) acompanhada(s) por este canal.`
    : profile.markUnconfirmed ? `${emoji('⚠️')}Fonte única até agora: confirmação pendente.` : '';
  const analysis = ai?.analysis ? `${emoji('🧭')}Análise (opinião do canal, não é fato verificado):\n${ai.analysis}` : '';
  return {
    kind: 'text', title: cut(ai?.title || item.title, 118), subtitle: cut(`${item.sourceLabel}`, 150),
    body: [facts, dates, confirmation, analysis].filter(Boolean).join('\n\n').slice(0, 3500),
    linkUrl: item.url.startsWith('https://') ? item.url : '', includeSignature: true, mediaId: null, priority: 'normal',
  };
}

export interface NewsRunResult { fetched: number; created: number; relevant: number; duplicates: number; errors: string[] }

export class NewsService {
  constructor(private readonly options: { repo: ChannelRepository; fetcher: FeedFetcher; ai: AiService; now: () => Date }) {}

  addSource(channel: Channel, input: unknown): NewsSource {
    const parsed = newsSourceSchema.parse(input);
    validateUrl(parsed.url, 2048);
    const existing = this.options.repo.listSources(channel.id);
    if (existing.length >= MAX_SOURCES) throw new Error(`Cada canal aceita até ${MAX_SOURCES} fontes.`);
    if (existing.some(source => source.url === parsed.url)) throw new Error('Esta fonte já está cadastrada neste canal.');
    return this.options.repo.saveSource({ id: randomUUID(), channelId: channel.id, url: parsed.url, label: parsed.label, active: parsed.active, createdAt: this.options.now().toISOString(), lastFetchedAt: null, lastStatus: null, lastError: null, etag: null, lastModified: null, itemsSeen: 0 });
  }
  updateSource(channel: Channel, id: string, input: unknown): NewsSource {
    const source = this.options.repo.getSource(id, channel.id);
    if (!source) throw new Error('Fonte não encontrada neste canal.');
    const parsed = newsSourceSchema.partial().strict().parse(input);
    if (parsed.url) validateUrl(parsed.url, 2048);
    return this.options.repo.saveSource({ ...source, ...parsed, ...(parsed.url && parsed.url !== source.url ? { etag: null, lastModified: null } : {}) });
  }

  /** Fetches only; the caller persists through the channel queue. */
  async fetchSource(source: NewsSource): Promise<{ entries: FeedEntry[]; title: string; etag: string | null; lastModified: string | null; notModified: boolean }> {
    const result = await this.options.fetcher(source.url, { etag: source.etag, lastModified: source.lastModified });
    if (result.status === 304) return { entries: [], title: '', etag: source.etag, lastModified: source.lastModified, notModified: true };
    const feed = parseFeed(result.body.toString('utf8'));
    return { entries: feed.entries, title: feed.title, etag: result.etag, lastModified: result.lastModified, notModified: false };
  }

  /** Classifies fetched entries for one channel and prepares drafts (persisted by the caller). */
  ingest(channel: Channel, source: NewsSource, entries: FeedEntry[]): NewsRunResult {
    const repo = this.options.repo, now = this.options.now();
    const result: NewsRunResult = { fetched: entries.length, created: 0, relevant: 0, duplicates: 0, errors: [] };
    const recent = repo.recentNews(channel.id, new Date(now.getTime() - 7 * DAY).toISOString());
    const domain = (() => { try { return new URL(source.url).hostname.replace(/^www\./, ''); } catch { return source.label; } })();
    for (const entry of entries) {
      if (!entry.link) continue;
      const canonicalUrl = canonicalNewsUrl(entry.link);
      const key = createHash('sha256').update(entry.guid ? `guid:${source.id}:${entry.guid}` : `url:${canonicalUrl}`).digest('hex');
      const urlKey = createHash('sha256').update(`url:${canonicalUrl}`).digest('hex');
      if (repo.hasNewsKey(channel.id, key) || repo.hasNewsKey(channel.id, urlKey)) continue;
      const score = scoreNews(entry, channel.editorial);
      // The same story already captured (from any source) is a duplicate; other outlets with a similar
      // headline count as corroboration, which is also credited back to the earlier items.
      const twin = recent.find(item => item.status !== 'duplicate' && similarity(item.title, entry.title) >= 0.8);
      const related = recent.filter(item => item.sourceDomain !== domain && similarity(item.title, entry.title) >= 0.45);
      const corroborating = new Set(related.map(item => item.sourceDomain));
      for (const earlier of related) {
        if (earlier.status === 'duplicate') continue;
        const others = new Set(recent.filter(other => other.sourceDomain !== earlier.sourceDomain && similarity(other.title, earlier.title) >= 0.45).map(other => other.sourceDomain));
        others.add(domain);
        if (others.size > earlier.corroboratingSources) {
          earlier.corroboratingSources = others.size; earlier.confirmation = 'corroborated';
          const stored = repo.getNews(earlier.id, channel.id);
          if (stored) repo.updateNews({ ...stored, corroboratingSources: others.size, confirmation: 'corroborated' });
        }
      }
      // A similar headline from another outlet already in the queue is the same story: it corroborates, but is not drafted twice.
      const sameStory = twin ?? related.find(item => item.status === 'new' || item.status === 'drafted');
      const status: NewsItem['status'] = score.excluded ? 'excluded' : score.languageMismatch ? 'irrelevant' : score.relevance < channel.editorial.minRelevance ? 'irrelevant' : sameStory ? 'duplicate' : 'new';
      const item: NewsItem = {
        id: randomUUID(), channelId: channel.id, sourceId: source.id, sourceLabel: source.label, sourceDomain: domain,
        url: entry.link, canonicalUrl, guid: entry.guid, title: entry.title.slice(0, 300), excerpt: entry.summary.slice(0, 600),
        author: entry.author, categories: entry.categories, language: entry.language,
        eventDate: null, publishedAt: entry.publishedAt, updatedAt: entry.updatedAt, fetchedAt: now.toISOString(),
        relevance: score.relevance, matched: score.excluded ? [`excluída: ${score.excluded}`] : score.matched, status,
        duplicateOf: status === 'duplicate' ? sameStory?.id ?? null : null, corroboratingSources: corroborating.size, confirmation: corroborating.size ? 'corroborated' : 'single_source', postId: null,
      };
      repo.saveNews(item, key);
      if (urlKey !== key && !repo.hasNewsKey(channel.id, urlKey)) repo.saveNews({ ...item, id: randomUUID(), status: 'duplicate', duplicateOf: item.id }, urlKey);
      recent.push(item);
      result.created++;
      if (status === 'duplicate') result.duplicates++;
      if (status === 'new') result.relevant++;
    }
    return result;
  }

  /** Builds a draft for one stored item, with AI when configured and rules otherwise. */
  async draftFor(channel: Channel, item: NewsItem): Promise<{ draft: PostInput; aiUsed: boolean; aiError: string | null }> {
    const status = this.options.ai.status();
    if (!status.available || !status.settings.summarize) return { draft: ruleDraft(item, channel), aiUsed: false, aiError: status.settings.provider === 'none' ? null : status.detail };
    try {
      const ai = await this.options.ai.summarize({ title: item.title, excerpt: item.excerpt, sourceLabel: item.sourceLabel, url: item.url, profile: channel.editorial, wantTitle: status.settings.suggestTitles, wantAnalysis: channel.editorial.analysisEnabled });
      return { draft: ruleDraft(item, channel, ai), aiUsed: true, aiError: null };
    } catch (error) {
      return { draft: ruleDraft(item, channel), aiUsed: false, aiError: error instanceof Error ? error.message.slice(0, 300) : 'Falha da IA.' };
    }
  }
}
