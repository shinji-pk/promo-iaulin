import type { BetterAuthOptions } from 'better-auth';
import { createAdapterFactory, type CleanedWhere, type CustomAdapter, type DBAdapter, type JoinConfig } from 'better-auth/adapters';
import type { JsonDocumentStore } from './blob-store.ts';

type Row = Record<string, unknown>;
export interface AuthDocument { version: 1; tables: Record<string, Row[]> }
export const emptyAuthDocument = (): AuthDocument => ({ version: 1, tables: {} });
/**
 * Where all accounts live. "v2" is the account reset of 2026-10-20: every earlier account (stored at
 * accounts/auth-v1.json) stopped being read, so everyone registers again with the recovery questions and code.
 * The old files stay untouched in private storage until the owner chooses to delete them.
 */
export const AUTH_DOCUMENT_PATH = 'accounts/auth-v2.json';

const clone = <T>(value: T): T => structuredClone(value);
function validateDocument(document: AuthDocument): void {
  if (document.version !== 1 || !document.tables || typeof document.tables !== 'object' || Array.isArray(document.tables)
    || Object.values(document.tables).some(table => !Array.isArray(table) || table.some(row => !row || typeof row !== 'object' || Array.isArray(row)))) {
    throw new Error('O armazenamento de contas está inválido; restaure um backup válido.');
  }
}

function matchClause(row: Row, clause: CleanedWhere): boolean {
  const normalize = (value: unknown): unknown => value instanceof Date ? value.toISOString()
    : clause.mode === 'insensitive' && typeof value === 'string' ? value.toLowerCase() : value;
  const actual = normalize(row[clause.field]);
  const expected = normalize(clause.value);
  const equals = (left: unknown, right: unknown) => left == null && right == null || JSON.stringify(left) === JSON.stringify(right);
  switch (clause.operator) {
    case 'eq': return equals(actual, expected);
    case 'ne': return !equals(actual, expected);
    case 'in': return Array.isArray(expected) && expected.some(value => equals(actual, normalize(value)));
    case 'not_in': return Array.isArray(expected) && !expected.some(value => equals(actual, normalize(value)));
    case 'contains': return typeof actual === 'string' && typeof expected === 'string' && actual.includes(expected);
    case 'starts_with': return typeof actual === 'string' && typeof expected === 'string' && actual.startsWith(expected);
    case 'ends_with': return typeof actual === 'string' && typeof expected === 'string' && actual.endsWith(expected);
    case 'gt': return actual != null && expected != null && actual > expected;
    case 'gte': return actual != null && expected != null && actual >= expected;
    case 'lt': return actual != null && expected != null && actual < expected;
    case 'lte': return actual != null && expected != null && actual <= expected;
    default: throw new Error('Operador de consulta não suportado.');
  }
}

function matches(row: Row, where: CleanedWhere[] = []): boolean {
  if (!where.length) return true;
  // Same connector semantics as Better Auth's official in-memory adapter.
  let result = matchClause(row, where[0]);
  for (const clause of where.slice(1)) result = clause.connector === 'OR' ? result || matchClause(row, clause) : result && matchClause(row, clause);
  return result;
}

/** Better Auth's temporary transaction snapshots commit to private Blob by CAS. */
export function blobAuthAdapter(store: JsonDocumentStore<AuthDocument>) {
  const build = (options: BetterAuthOptions, snapshot?: AuthDocument): DBAdapter => createAdapterFactory({
    config: {
      adapterId: 'promobridge-private-blob', adapterName: 'PromoBridge private Blob',
      supportsDates: false, supportsJSON: true, supportsBooleans: true, supportsArrays: true,
      supportsNumericIds: false, debugLogs: false,
      transaction: async callback => {
        if (!snapshot) return store.transact(draft => { validateDocument(draft); return callback(build(options, draft)); });
        const savepoint = clone(snapshot);
        const result = await callback(build(options, savepoint));
        snapshot.tables = savepoint.tables;
        return result;
      },
    },
    adapter: ({ schema, getDefaultModelName, getModelName, getFieldName, getDefaultFieldName }) => {
      const table = (document: AuthDocument, model: string): Row[] => {
        const key = getDefaultModelName(model);
        if (!schema[key] || !/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(model)) throw new Error('Tabela de autenticação inválida.');
        if (!Object.hasOwn(document.tables, model)) document.tables[model] = [];
        return document.tables[model];
      };
      const read = async <R>(operation: (document: AuthDocument) => R): Promise<R> => {
        const document = snapshot ?? await store.read();
        validateDocument(document);
        return clone(operation(document));
      };
      const write = async <R>(operation: (document: AuthDocument) => R): Promise<R> => {
        if (snapshot) {
          validateDocument(snapshot);
          const savepoint = clone(snapshot);
          const result = clone(operation(savepoint));
          snapshot.tables = savepoint.tables;
          return result;
        }
        return store.transact(document => { validateDocument(document); return clone(operation(document)); });
      };
      const assertUnique = (document: AuthDocument, model: string, row: Row, oldRow?: Row) => {
        const modelKey = getDefaultModelName(model);
        const definition = schema[modelKey];
        const groups = [['id'], ...Object.entries(definition.fields).filter(([, field]) => field.unique).map(([name]) => [getFieldName({ model: modelKey, field: name })]),
          ...(definition.indexes ?? []).filter(index => index.unique).map(index => index.fields.map(field => getFieldName({ model: modelKey, field })))];
        if (modelKey === 'account') groups.push(['providerId', 'accountId'].map(field => getFieldName({ model: modelKey, field })));
        const emailField = modelKey === 'user' ? getFieldName({ model: modelKey, field: 'email' }) : null;
        if (emailField && typeof row[emailField] === 'string') row[emailField] = (row[emailField] as string).trim().toLowerCase();
        for (const fields of groups) {
          if (fields.some(field => row[field] == null)) continue;
          if (table(document, model).some(existing => existing !== oldRow && fields.every(field => {
            const existingValue = existing[field];
            return field === emailField && typeof existingValue === 'string' ? existingValue.trim().toLowerCase() === row[field] : existingValue === row[field];
          }))) throw new Error('Já existe um registro com este identificador.');
        }
        for (const [field, attributes] of Object.entries(definition.fields)) {
          if (!attributes.references) continue;
          const physicalField = getFieldName({ model: modelKey, field });
          const value = row[physicalField];
          if (value == null) continue;
          const targetKey = attributes.references.model;
          const targetField = getFieldName({ model: targetKey, field: attributes.references.field });
          if (!table(document, getModelName(targetKey)).some(target => target[targetField] === value)) throw new Error('A conta referenciada não existe.');
        }
      };
      const removeRows = (document: AuthDocument, model: string, removed: Row[], seen = new Set<string>()): void => {
        if (!removed.length) return;
        const modelKey = getDefaultModelName(model);
        const unseen = removed.filter(row => !seen.has(`${model}:${String(row.id)}`));
        if (!unseen.length) return;
        for (const row of unseen) seen.add(`${model}:${String(row.id)}`);
        for (const [childKey, definition] of Object.entries(schema)) {
          for (const [field, attributes] of Object.entries(definition.fields)) {
            const reference = attributes.references;
            if (!reference || reference.model !== modelKey) continue;
            const childModel = getModelName(childKey);
            const childField = getFieldName({ model: childKey, field });
            const targetField = getFieldName({ model: modelKey, field: reference.field });
            const children = table(document, childModel).filter(child => child[childField] != null && unseen.some(row => child[childField] === row[targetField]));
            if (!children.length) continue;
            if (!reference.onDelete || reference.onDelete === 'cascade') removeRows(document, childModel, children, seen);
            else if (reference.onDelete === 'set null') for (const child of children) child[childField] = null;
            else throw new Error('Existem registros associados a esta conta.');
          }
        }
        const deleted = new Set(unseen);
        document.tables[model] = table(document, model).filter(row => !deleted.has(row));
      };
      const addJoins = (document: AuthDocument, row: Row, joins?: JoinConfig): Row => {
        const value = clone(row);
        for (const [model, join] of Object.entries(joins ?? {})) {
          const rows = table(document, model).filter(other => other[join.on.to] === row[join.on.from]);
          value[model] = join.relation === 'one-to-one' ? clone(rows[0] ?? null) : clone(rows.slice(0, join.limit ?? 100));
        }
        return value;
      };
      const adapter: CustomAdapter = {
        create: async ({ model, data }) => write(document => {
          const row = clone(data);
          assertUnique(document, model, row);
          table(document, model).push(row);
          return row;
        }),
        findOne: async <T>({ model, where, join }: Parameters<CustomAdapter['findOne']>[0]) => read(document => {
          const row = table(document, model).find(row => matches(row, where));
          return row ? addJoins(document, row, join) as T : null;
        }),
        findMany: async <T>({ model, where, sortBy, offset = 0, limit, join, select }: Parameters<CustomAdapter['findMany']>[0]) => read(document => {
          const rows = table(document, model).filter(row => matches(row, where));
          if (sortBy) {
            const field = getFieldName({ model: getDefaultModelName(model), field: sortBy.field });
            rows.sort((left, right) => {
              const a = left[field]; const b = right[field];
              const direction = sortBy.direction === 'desc' ? -1 : 1;
              return (a == null ? b == null ? 0 : -1 : b == null ? 1 : a < b ? -1 : a > b ? 1 : 0) * direction;
            });
          }
          return rows.slice(offset, offset + limit).map(row => {
            const value = addJoins(document, row, join);
            if (!select?.length) return value as T;
            return Object.fromEntries(Object.entries(value).filter(([field]) => Object.hasOwn(join ?? {}, field)
              || select.includes(getDefaultFieldName({ model: getDefaultModelName(model), field })))) as T;
          });
        }),
        update: async <T>({ model, where, update }: Parameters<CustomAdapter['update']>[0]) => write(document => {
          const row = table(document, model).find(row => matches(row, where));
          if (!row) return null;
          const next = { ...row, ...(update as Row) };
          assertUnique(document, model, next, row);
          Object.assign(row, next);
          return row as T;
        }),
        updateMany: async ({ model, where, update }) => write(document => {
          let count = 0;
          for (const row of table(document, model).filter(row => matches(row, where))) {
            const next = { ...row, ...update };
            assertUnique(document, model, next, row);
            Object.assign(row, next); count++;
          }
          return count;
        }),
        delete: async ({ model, where }) => write(document => {
          const row = table(document, model).find(row => matches(row, where));
          if (row) removeRows(document, model, [row]);
        }),
        deleteMany: async ({ model, where }) => write(document => {
          const removed = table(document, model).filter(row => matches(row, where));
          removeRows(document, model, removed);
          return removed.length;
        }),
        consumeOne: async <T>({ model, where }: Parameters<NonNullable<CustomAdapter['consumeOne']>>[0]) => write(document => {
          const row = table(document, model).find(row => matches(row, where));
          if (!row) return null;
          removeRows(document, model, [row]);
          return row as T;
        }),
        incrementOne: async <T>({ model, where, increment, set }: Parameters<NonNullable<CustomAdapter['incrementOne']>>[0]) => write(document => {
          const row = table(document, model).find(row => matches(row, where));
          if (!row) return null;
          const next = { ...row, ...set };
          for (const [field, delta] of Object.entries(increment)) {
            const previous = row[field] ?? 0;
            if (typeof previous !== 'number' || !Number.isFinite(previous) || !Number.isFinite(delta) || !Number.isFinite(previous + delta)) throw new Error('Contador inválido.');
            next[field] = previous + delta;
          }
          assertUnique(document, model, next, row); Object.assign(row, next);
          return row as T;
        }),
        count: async ({ model, where }) => read(document => table(document, model).filter(row => matches(row, where)).length),
      };
      return adapter;
    },
  })(options);
  return (options: BetterAuthOptions) => build(options);
}
