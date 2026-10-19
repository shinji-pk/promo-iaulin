import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../apps/worker/src/api.ts';

// Test-only network substitution: browser tests exercise processing without live store requests.
// No WhatsApp connection is initiated and the /simulate endpoint still forces simulation=true.
const directory=mkdtempSync(join(tmpdir(),'promobridge-browser-'));
const app=createApp({databasePath:join(directory,'test.sqlite'),authDir:join(directory,'auth'),schedule:false,resolveUrl:async url=>url});
const server=app.listen(3031,'127.0.0.1');
let closing=false;
async function close() {
  if(closing)return;
  closing=true;
  server.close();
  await app.runtime.close();
  rmSync(directory,{recursive:true,force:true});
}
process.on('SIGINT',()=>void close());
process.on('SIGTERM',()=>void close());
