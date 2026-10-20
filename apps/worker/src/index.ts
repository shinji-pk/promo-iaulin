import { createApp } from './api.ts';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

// Hosted mode (PROMOBRIDGE_CLOUD_TOKEN) accepts only the site's server, authenticated by a secret.
// Without it, the worker stays on loopback exactly as before.
const hosted=Boolean(process.env.PROMOBRIDGE_CLOUD_TOKEN);
const port=Number(process.env.PROMOBRIDGE_PORT ?? process.env.PORT ?? '3030');
if (!Number.isInteger(port) || port<1 || port>65535) throw new Error('PROMOBRIDGE_PORT deve ser uma porta válida.');
const host=hosted ? '0.0.0.0' : '127.0.0.1';
const app=createApp({port, ...(process.env.PROMOBRIDGE_WEB_DIR ? {webDir:resolve(process.env.PROMOBRIDGE_WEB_DIR)} : {})});
const server=app.listen(port,host,() => {
  console.log(hosted ? `PromoBridge (nuvem) escutando na porta ${port}.` : `PromoBridge disponível em http://127.0.0.1:${port}.`);
  if (existsSync(resolve('data/whatsapp-session/creds.json'))) {
    void app.runtime.connect().catch(() => console.error('Não foi possível retomar a sessão. Use Fontes & conexões no painel.'));
  } else console.log('Para começar, conecte o WhatsApp pelo painel.');
});
let closing=false;
async function shutdown():Promise<void> {
  if (closing) return;
  closing=true;
  server.close();
  server.closeIdleConnections();
  try { await app.runtime.close(); } catch { process.exitCode=1; }
}
process.on('SIGINT',() => {void shutdown();});
process.on('SIGTERM',() => {void shutdown();});
server.on('error',async error => {
  console.error(`Não foi possível iniciar o painel: ${error.message}`);
  process.exitCode=1;
  await shutdown();
});
