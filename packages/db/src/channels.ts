import type { Database } from './index.ts';
import type { Channel, ChannelEvent, ChannelPost, NewsItem, NewsSource, PostStatus } from '../../shared/src/channels.ts';

const parse = <T>(row: Record<string, unknown> | undefined): T | undefined => row ? JSON.parse(String(row.body)) as T : undefined;
const parseAll = <T>(rows: Record<string, unknown>[]): T[] => rows.map(row => JSON.parse(String(row.body)) as T);

/**
 * Persistence for Canais do WhatsApp. Channels, posts, sources and news live in their own
 * tables (migration 3), never mixed with offers or groups. Every read that targets a post
 * or source also checks the channel it belongs to.
 */
export class ChannelRepository {
  constructor(private readonly db: Database) {}

  transaction<T>(operation: () => T): T { return this.db.transaction(operation); }

  listChannels(includeUnlinked = false): Channel[] {
    const channels = parseAll<Channel>(this.db.sql('SELECT body FROM channels ORDER BY created_at ASC, id ASC').all() as Record<string, unknown>[]);
    return includeUnlinked ? channels : channels.filter(channel => !channel.unlinkedAt);
  }
  getChannel(id: string): Channel | undefined { return parse<Channel>(this.db.sql('SELECT body FROM channels WHERE id=?').get(id) as Record<string, unknown> | undefined); }
  getChannelByJid(jid: string): Channel | undefined { return parse<Channel>(this.db.sql('SELECT body FROM channels WHERE jid=?').get(jid) as Record<string, unknown> | undefined); }
  saveChannel(channel: Channel): Channel {
    this.db.sql('INSERT INTO channels(id,jid,active,created_at,updated_at,body) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET active=excluded.active,updated_at=excluded.updated_at,body=excluded.body')
      .run(channel.id, channel.jid, Number(channel.active), channel.createdAt, channel.updatedAt, JSON.stringify(channel));
    return channel;
  }

  listPosts(filter: { channelId?: string; statuses?: PostStatus[]; limit?: number } = {}): ChannelPost[] {
    const clauses: string[] = [], params: (string | number)[] = [];
    if (filter.channelId) { clauses.push('channel_id=?'); params.push(filter.channelId); }
    if (filter.statuses?.length) { clauses.push(`status IN (${filter.statuses.map(() => '?').join(',')})`); params.push(...filter.statuses); }
    const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
    params.push(Math.min(Math.max(filter.limit ?? 500, 1), 5000));
    return parseAll<ChannelPost>(this.db.sql(`SELECT body FROM channel_posts${where} ORDER BY created_at DESC, id DESC LIMIT ?`).all(...params) as Record<string, unknown>[]);
  }
  getPost(id: string, channelId?: string): ChannelPost | undefined {
    const post = parse<ChannelPost>(this.db.sql('SELECT body FROM channel_posts WHERE id=?').get(id) as Record<string, unknown> | undefined);
    return post && (!channelId || post.channelId === channelId) ? post : undefined;
  }
  savePost(post: ChannelPost): ChannelPost {
    this.db.sql('INSERT INTO channel_posts(id,channel_id,status,scheduled_at,created_at,updated_at,dedupe_key,body) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,scheduled_at=excluded.scheduled_at,updated_at=excluded.updated_at,dedupe_key=excluded.dedupe_key,body=excluded.body')
      .run(post.id, post.channelId, post.status, post.scheduledAt, post.createdAt, post.updatedAt, post.dedupeKey, JSON.stringify(post));
    return post;
  }
  deletePost(id: string): void { this.db.sql('DELETE FROM channel_posts WHERE id=?').run(id); }
  /** Posts that count as already sent for pacing and deduplication. */
  sentPosts(channelId: string, sinceIso: string): ChannelPost[] {
    return parseAll<ChannelPost>(this.db.sql("SELECT body FROM channel_posts WHERE channel_id=? AND status IN ('sending','pending_confirmation','published') AND updated_at>=? ORDER BY updated_at DESC").all(channelId, sinceIso) as Record<string, unknown>[]);
  }
  duePosts(nowIso: string): ChannelPost[] {
    return parseAll<ChannelPost>(this.db.sql("SELECT body FROM channel_posts WHERE status='scheduled' AND scheduled_at<=? ORDER BY scheduled_at ASC, created_at ASC").all(nowIso) as Record<string, unknown>[]);
  }
  countByStatus(channelId: string): Partial<Record<PostStatus, number>> {
    const counts: Partial<Record<PostStatus, number>> = {};
    for (const row of this.db.sql('SELECT status, COUNT(*) AS count FROM channel_posts WHERE channel_id=? GROUP BY status').all(channelId) as { status: PostStatus; count: number }[]) counts[row.status] = Number(row.count);
    return counts;
  }

  listSources(channelId: string): NewsSource[] { return parseAll<NewsSource>(this.db.sql('SELECT body FROM news_sources WHERE channel_id=? ORDER BY id').all(channelId) as Record<string, unknown>[]); }
  getSource(id: string, channelId: string): NewsSource | undefined {
    const source = parse<NewsSource>(this.db.sql('SELECT body FROM news_sources WHERE id=?').get(id) as Record<string, unknown> | undefined);
    return source && source.channelId === channelId ? source : undefined;
  }
  saveSource(source: NewsSource): NewsSource {
    this.db.sql('INSERT INTO news_sources(id,channel_id,url,body) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET url=excluded.url,body=excluded.body').run(source.id, source.channelId, source.url, JSON.stringify(source));
    return source;
  }
  deleteSource(id: string): void { this.db.sql('DELETE FROM news_sources WHERE id=?').run(id); }

  listNews(channelId: string, limit = 200): NewsItem[] {
    return parseAll<NewsItem>(this.db.sql('SELECT body FROM news_items WHERE channel_id=? ORDER BY fetched_at DESC, id DESC LIMIT ?').all(channelId, Math.min(Math.max(limit, 1), 2000)) as Record<string, unknown>[]);
  }
  recentNews(channelId: string, sinceIso: string): NewsItem[] {
    return parseAll<NewsItem>(this.db.sql('SELECT body FROM news_items WHERE channel_id=? AND fetched_at>=?').all(channelId, sinceIso) as Record<string, unknown>[]);
  }
  getNews(id: string, channelId: string): NewsItem | undefined {
    const item = parse<NewsItem>(this.db.sql('SELECT body FROM news_items WHERE id=?').get(id) as Record<string, unknown> | undefined);
    return item && item.channelId === channelId ? item : undefined;
  }
  hasNewsKey(channelId: string, key: string): boolean { return Boolean(this.db.sql('SELECT 1 FROM news_items WHERE channel_id=? AND url_key=?').get(channelId, key)); }
  saveNews(item: NewsItem, key: string): NewsItem {
    this.db.sql('INSERT INTO news_items(id,channel_id,url_key,fetched_at,body) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(item.id, item.channelId, key, item.fetchedAt, JSON.stringify(item));
    return item;
  }
  updateNews(item: NewsItem): NewsItem { this.db.sql('UPDATE news_items SET body=? WHERE id=? AND channel_id=?').run(JSON.stringify(item), item.id, item.channelId); return item; }
  /** Old captured news is metadata only; published posts keep their own copy of the text. */
  pruneNews(beforeIso: string): number { return Number(this.db.sql("DELETE FROM news_items WHERE fetched_at<? AND json_extract(body,'$.status')<>'drafted'").run(beforeIso).changes); }

  addEvent(event: ChannelEvent): void {
    this.db.sql('INSERT INTO channel_events(id,channel_id,post_id,created_at,body) VALUES(?,?,?,?,?)').run(event.id, event.channelId, event.postId, event.createdAt, JSON.stringify(event));
  }
  listEvents(filter: { channelId?: string; postId?: string; limit?: number } = {}): ChannelEvent[] {
    const clauses: string[] = [], params: (string | number)[] = [];
    if (filter.channelId) { clauses.push('channel_id=?'); params.push(filter.channelId); }
    if (filter.postId) { clauses.push('post_id=?'); params.push(filter.postId); }
    params.push(Math.min(Math.max(filter.limit ?? 200, 1), 2000));
    return parseAll<ChannelEvent>(this.db.sql(`SELECT body FROM channel_events${clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''} ORDER BY created_at DESC, rowid DESC LIMIT ?`).all(...params) as Record<string, unknown>[]);
  }
  pruneEvents(beforeIso: string): number { return Number(this.db.sql('DELETE FROM channel_events WHERE created_at<?').run(beforeIso).changes); }
}
