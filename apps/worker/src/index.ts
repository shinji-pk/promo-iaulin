import { createApp } from './api.ts';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const port=Number(process.env.PROMOBRIDGE_PORT ?? '3030');
if (!Number.isInteger(port) || port<1 || port>65535) throw new Error('PROMOBRIDGE_PORT deve ser uma porta válida.');
const app=createApp();
const server=app.listen(port,'127.0.0.1',() => {
  console.log(`PromoBridge disponível em http://127.0.0.1:${port}.`);
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
