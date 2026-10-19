import { BlobPreconditionFailedError, get, put } from '@vercel/blob';

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
    const response = await get(pathname, { access: 'private', useCache: false });
    if (!response) return null;
    if (response.statusCode !== 200 || !response.stream || !response.blob.etag) throw new Error('Resposta inválida do armazenamento privado.');
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

export function createBlobJsonStore<T>(pathname: string, initial: () => T, options: { maxBytes?: number; maxAttempts?: number } = {}): JsonDocumentStore<T> {
  if (!process.env.BLOB_STORE_ID && !process.env.BLOB_READ_WRITE_TOKEN) throw new Error('Armazenamento de contas não configurado.');
  const maxBytes = options.maxBytes ?? 8 * 1024 * 1024;
  return new JsonDocumentStore({ backend: new VercelBlobBackend(maxBytes), pathname, initial, ...options });
}
