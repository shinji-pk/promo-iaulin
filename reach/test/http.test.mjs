import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import net from 'node:net';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

async function ephemeralPort(){return await new Promise((resolve,reject)=>{
 const s=net.createServer();s.once('error',reject);s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p))});
})}
test('HTTP smoke: health, assets, hardened headers and 404',async t=>{
 const port=await ephemeralPort(),cwd=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
 const child=spawn(process.execPath,['server.mjs'],{cwd,env:{...process.env,PORT:String(port)},stdio:['ignore','pipe','pipe']});
 t.after(()=>child.kill());
 const origin='http://127.0.0.1:'+port;let ready=false;
 for(let i=0;i<50;i++){try{let r=await fetch(origin+'/health',{signal:AbortSignal.timeout(600)});if(r.ok){ready=true;break}}catch{}await new Promise(r=>setTimeout(r,100))}
 assert.equal(ready,true,'server must start');
 const health=await fetch(origin+'/health');assert.deepEqual(await health.json(),{status:'ok'});
 const page=await fetch(origin+'/');assert.equal(page.status,200);assert.match(await page.text(),/Shinji Reach/);
 assert.equal(page.headers.get('cache-control'),'no-store');
 assert.equal(page.headers.get('x-frame-options'),'DENY');
 const js=await fetch(origin+'/app.js');assert.equal(js.status,200);assert.match(js.headers.get('content-type'),/javascript/);
 const css=await fetch(origin+'/style.css');assert.equal(css.status,200);assert.match(await css.text(),/focus-card/);
 const missing=await fetch(origin+'/missing-file-secret');assert.equal(missing.status,404);
 const internal=await fetch(origin+'/server.mjs');assert.equal(internal.status,404,'server source must not be public');
 const testFile=await fetch(origin+'/test/core.test.mjs');assert.equal(testFile.status,404,'test code must not be public');
 const env=await fetch(origin+'/.env');assert.equal(env.status,404,'dotfiles must not be public');
 const traversal=await fetch(origin+'/%2E%2E/%2E%2E/etc/passwd');assert.notEqual(traversal.status,200);
});
