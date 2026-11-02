import { describe, expect, it } from 'vitest';
import { JsonDocumentStore, NeonBackend, StoreConflictError, type NeonSql } from '../apps/cloud/src/blob-store.ts';

/** Imita a tabela promo_docs com a mesma regra de versão do Postgres. */
function fakeNeon() {
  const rows = new Map<string, { value: string; version: number }>();
  const sql: NeonSql = async (query, params = []) => {
    const [path, value, expected] = params as string[];
    if (query.startsWith('create table')) return [];
    if (query.startsWith('select')) {
      const row = rows.get(path);
      return row ? [{ v: row.value, e: String(row.version) }] : [];
    }
    if (query.startsWith('insert')) {
      if (rows.has(path)) return [];
      rows.set(path, { value, version: 1 });
      return [{ version: '1' }];
    }
    if (query.startsWith('update')) {
      const row = rows.get(path);
      if (!row || String(row.version) !== expected) return [];
      row.value = value; row.version += 1;
      return [{ version: String(row.version) }];
    }
    throw new Error('unexpected query');
  };
  return { sql, rows };
}

describe('Neon document store (Cloudflare)', () => {
  it('creates once and only replaces the version that was read', async () => {
    const { sql } = fakeNeon();
    const backend = new NeonBackend(sql, 1024 * 1024);
    expect(await backend.read('accounts/a/workspace.json')).toBeNull();
    await backend.write('accounts/a/workspace.json', { n: 1 }, null);
    await expect(backend.write('accounts/a/workspace.json', { n: 9 }, null)).rejects.toBeInstanceOf(StoreConflictError);
    const first = await backend.read('accounts/a/workspace.json');
    expect(first).toEqual({ etag: 'n1', value: { n: 1 } });
    await backend.write('accounts/a/workspace.json', { n: 2 }, 'n1');
    await expect(backend.write('accounts/a/workspace.json', { n: 3 }, 'n1')).rejects.toBeInstanceOf(StoreConflictError);
    await expect(backend.write('accounts/a/workspace.json', { n: 3 }, '"blob-etag"')).rejects.toBeInstanceOf(StoreConflictError);
    expect(await backend.read('accounts/a/workspace.json')).toEqual({ etag: 'n2', value: { n: 2 } });
  });

  it('keeps concurrent transactions consistent through the shared store', async () => {
    const { sql } = fakeNeon();
    const store = new JsonDocumentStore<{ count: number }>({ backend: new NeonBackend(sql, 1024 * 1024), pathname: 'counter.json', initial: () => ({ count: 0 }) });
    await Promise.all(Array.from({ length: 8 }, () => store.transact(draft => { draft.count += 1; })));
    expect((await store.read()).count).toBe(8);
  });
});
