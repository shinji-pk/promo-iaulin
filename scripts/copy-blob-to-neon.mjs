/* global process, console */
// Copia contas e espaços de trabalho do Promo do Blob da Vercel para o Neon (tabela promo_docs).
// Não apaga nada do Blob e não sobrescreve documento que já exista no Neon.
import { get, list } from '@vercel/blob';

const url = process.env.DATABASE_URL;
if (!url || !process.env.BLOB_READ_WRITE_TOKEN) {
  console.error('Faltam DATABASE_URL e/ou BLOB_READ_WRITE_TOKEN.');
  process.exit(1);
}
const host = new URL(url).hostname;
async function sql(query, params = []) {
  const r = await fetch('https://' + host.replace(/^[^.]+\./, 'api.') + '/sql', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'Neon-Connection-String': url },
    body: JSON.stringify({ query, params }),
  });
  if (!r.ok) throw new Error('Neon ' + r.status);
  return (await r.json()).rows || [];
}

await sql(`create table if not exists promo_docs (
  path text primary key, value jsonb not null, version bigint not null default 1,
  updated_at timestamptz not null default now())`);

let cursor, copied = 0, kept = 0, skipped = 0;
do {
  const page = await list({ cursor, limit: 500 });
  for (const blob of page.blobs) {
    if (!blob.pathname.endsWith('.json')) { skipped++; continue; }
    const res = await get(blob.pathname, { access: 'private', useCache: false, headers: { 'accept-encoding': 'identity' } });
    if (!res || res.statusCode !== 200) { skipped++; continue; }
    const text = await new Response(res.stream).text();
    JSON.parse(text);
    const rows = await sql('insert into promo_docs (path, value) values ($1, $2::jsonb) on conflict (path) do nothing returning path', [blob.pathname, text]);
    if (rows.length) copied++; else kept++;
  }
  cursor = page.hasMore ? page.cursor : undefined;
} while (cursor);
console.log(`Documentos copiados: ${copied}. Já existiam no Neon (mantidos): ${kept}. Ignorados: ${skipped}.`);
