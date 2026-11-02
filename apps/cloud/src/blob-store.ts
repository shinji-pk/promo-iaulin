// Loaded only on Vercel: the Cloudflare build never evaluates the Blob SDK.
const blobSdk = () => import('@vercel/blob');

export class StoreConflictError extends Error {
  constructor() { super('O documento foi atualizado por outra solicitação.'); this.name = 'StoreConflictError'; }
}

export interface JsonBackend {
  read(pathname: string): Promise<{ etag: string; value: unknown } | null>;
  /** expectedEtag=null creates the object only when it does not already exist. */
  write(pathname: string, value: unknown, expectedEtag: string | null): Promise<void>;
}

/** A single private document is the atomic commit boundary, across Function instances. */
export class JsonDocumentStore<T> {
  readonly maxBytes: number;
  private readonly maxAttempts: number;
  constructor(private readonly options: {
    backend: JsonBackend;
    pathname: string;
    initial: () => T;
    maxBytes?: number;
    maxAttempts?: number;
  }) {
    this.maxBytes = options.maxBytes ?? 8 * 1024 * 1024;
    this.maxAttempts = options.maxAttempts ?? 12;
    if (!options.pathname || options.pathname.startsWith('/') || options.pathname.includes('..')) throw new Error('Caminho de armazenamento inválido.');
  }

  private checked(value: unknown): T {
    const serialized = JSON.stringify(value);
    if (serialized === undefined || Buffer.byteLength(serialized, 'utf8') > this.maxBytes) throw new Error('Limite de armazenamento do documento atingido.');
    return JSON.parse(serialized) as T;
  }

  async read(): Promise<T> {
    const current = await this.options.backend.read(this.options.pathname);
    return this.checked(current ? current.value : this.options.initial());
  }

  /** The callback may be replayed on CAS conflicts: it must contain no external effects. */
  async transact<R>(mutation: (draft: T) => R | Promise<R>): Promise<R> {
    for (let attempt = 0; attempt < this.maxAttempts; attempt++) {
      const current = await this.options.backend.read(this.options.pathname);
      const draft = this.checked(current ? current.value : this.options.initial());
      const result = await mutation(draft);
      const value = this.checked(draft);
      try {
        await this.options.backend.write(this.options.pathname, value, current?.etag ?? null);
        return result;
      } catch (error) {
        if (!(error instanceof StoreConflictError)) throw error;
        if (attempt + 1 < this.maxAttempts) await new Promise(resolve => setTimeout(resolve, Math.min(2 ** attempt, 40) + Math.floor(Math.random() * 8)));
      }
    }
    throw new Error('Muitas alterações simultâneas. Tente novamente em instantes.');
  }
}

class VercelBlobBackend implements JsonBackend {
  constructor(private readonly maxBytes: number) {}

  async read(pathname: string): Promise<{ etag: string; value: unknown } | null> {
    // Cached reads can resurrect a revoked session or allow an out-of-date uniqueness check.
    // Compression turns the content ETag into a weak representation ETag. It
    // cannot authorize an ifMatch write, so read the identity representation.
    const { get } = await blobSdk();
    const response = await get(pathname, { access: 'private', useCache: false, headers: { 'accept-encoding': 'identity' } });
    if (!response) return null;
    if (response.statusCode !== 200 || !response.stream || !response.blob.etag || response.blob.etag.startsWith('W/')) throw new Error('Resposta inválida do armazenamento privado.');
    if (response.blob.size !== null && response.blob.size > this.maxBytes) throw new Error('Documento excede o limite de armazenamento.');
    const reader = response.stream.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) {
        const item = await reader.read();
        if (item.done) break;
        bytes += item.value.byteLength;
        if (bytes > this.maxBytes) { await reader.cancel(); throw new Error('Documento excede o limite de armazenamento.'); }
        chunks.push(item.value);
      }
    } finally { reader.releaseLock(); }
    const body = Buffer.concat(chunks).toString('utf8');
    return { etag: response.blob.etag, value: JSON.parse(body) as unknown };
  }

  async write(pathname: string, value: unknown, expectedEtag: string | null): Promise<void> {
    const { put, BlobPreconditionFailedError } = await blobSdk();
    try {
      await put(pathname, JSON.stringify(value), {
        access: 'private', addRandomSuffix: false, contentType: 'application/json',
        // First creation is conditional too; concurrent creators must reload the winner.
        allowOverwrite: expectedEtag !== null,
        ...(expectedEtag !== null ? { ifMatch: expectedEtag } : {}),
      });
    } catch (error) {
      if (error instanceof BlobPreconditionFailedError) throw new StoreConflictError();
      // SDK 2.8 has no dedicated already-exists error. Confirm a concurrent creator
      // actually won, rather than swallowing credential/network/storage failures.
      if (expectedEtag === null) {
        const existing = await this.read(pathname).catch(() => null);
        if (existing) throw new StoreConflictError();
      }
      throw error;
    }
  }
}

/** Neon (Cloudflare): one row per document, version-based compare-and-swap like Blob ifMatch. */
type NeonRow = Record<string, string | null>;
export type NeonSql = (query: string, params?: unknown[]) => Promise<NeonRow[]>;
export function neonHttp(databaseUrl: string): NeonSql {
  const host = new URL(databaseUrl).hostname;
  return async (query, params = []) => {
    const init = { method: 'POST', headers: { 'content-type': 'application/json', 'Neon-Connection-String': databaseUrl }, body: JSON.stringify({ query, params }) };
    let response = await fetch(`https://${host.replace(/^[^.]+\./, 'api.')}/sql`, init).catch(() => null);
    if (!response || (!response.ok && response.status >= 500)) response = await fetch(`https://${host}/sql`, init);
    const text = await response.text();
    // Never surface database messages: they can carry connection details.
    if (!response.ok) throw new Error(`Neon ${response.status}`);
    try { return (JSON.parse(text) as { rows?: NeonRow[] }).rows ?? []; } catch { return []; }
  };
}

export class NeonBackend implements JsonBackend {
  private ready: Promise<unknown> | null = null;
  constructor(private readonly sql: NeonSql, private readonly maxBytes: number) {}
  private ensure() {
    return this.ready ??= this.sql(`create table if not exists promo_docs (
      path text primary key, value jsonb not null, version bigint not null default 1,
      updated_at timestamptz not null default now())`).catch(error => { this.ready = null; throw error; });
  }
  async read(pathname: string): Promise<{ etag: string; value: unknown } | null> {
    await this.ensure();
    const rows = await this.sql('select value::text as v, version::text as e from promo_docs where path = $1', [pathname]);
    if (!rows[0]) return null;
    const body = rows[0].v ?? '';
    if (Buffer.byteLength(body, 'utf8') > this.maxBytes) throw new Error('Documento excede o limite de armazenamento.');
    return { etag: 'n' + rows[0].e, value: JSON.parse(body) as unknown };
  }
  async write(pathname: string, value: unknown, expectedEtag: string | null): Promise<void> {
    await this.ensure();
    const text = JSON.stringify(value);
    if (expectedEtag !== null && !/^n\d{1,18}$/.test(expectedEtag)) throw new StoreConflictError();
    const rows = expectedEtag === null
      ? await this.sql('insert into promo_docs (path, value) values ($1, $2::jsonb) on conflict (path) do nothing returning version', [pathname, text])
      : await this.sql('update promo_docs set value = $2::jsonb, version = version + 1, updated_at = now() where path = $1 and version = $3::bigint returning version', [pathname, text, expectedEtag.slice(1)]);
    if (!rows.length) throw new StoreConflictError();
  }
}

/** Blob on Vercel; Neon when DATABASE_URL is set and no Blob store is (Cloudflare), or PROMO_STORE=neon. */
export const useNeonStore = () => Boolean(process.env.DATABASE_URL)
  && (process.env.PROMO_STORE === 'neon' || (!process.env.BLOB_STORE_ID && !process.env.BLOB_READ_WRITE_TOKEN));

export function createBlobJsonStore<T>(pathname: string, initial: () => T, options: { maxBytes?: number; maxAttempts?: number } = {}): JsonDocumentStore<T> {
  const maxBytes = options.maxBytes ?? 8 * 1024 * 1024;
  if (useNeonStore()) return new JsonDocumentStore({ backend: new NeonBackend(neonHttp(process.env.DATABASE_URL!), maxBytes), pathname, initial, ...options });
  if (!process.env.BLOB_STORE_ID && !process.env.BLOB_READ_WRITE_TOKEN) throw new Error('Armazenamento de contas não configurado.');
  return new JsonDocumentStore({ backend: new VercelBlobBackend(maxBytes), pathname, initial, ...options });
}
