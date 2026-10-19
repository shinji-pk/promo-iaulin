import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Database } from '../packages/db/src/index.ts';
import { RemoteAccess, REMOTE_COOKIE_NAME, cloudflaredAssetName, validateRemoteOrigin } from '../apps/worker/src/remote-access.ts';

const directories:string[]=[],databases:Database[]=[],controllers:RemoteAccess[]=[];
afterEach(async()=>{for(const controller of controllers.splice(0))await controller.stop();for(const database of databases.splice(0))database.close();for(const directory of directories.splice(0))rmSync(directory,{recursive:true,force:true});});
function fixture(){
  const database=new Database(':memory:');databases.push(database);const directory=mkdtempSync(join(tmpdir(),'promobridge-remote-'));directories.push(directory);
  const binary=Buffer.from('controlled test binary, never executed'),digest=createHash('sha256').update(binary).digest('hex');
  writeFileSync(join(directory,process.platform==='win32'?'cloudflared.exe':'cloudflared'),binary);
  writeFileSync(join(directory,'release.json'),JSON.stringify({name:cloudflaredAssetName(),digest:`sha256:${digest}`,binaryDigest:digest}));
  let clock=Date.now();
  const spawn=vi.fn((_command:string,_args:string[],_options:SpawnOptions)=>{
    const child=Object.assign(new EventEmitter(),{stdout:new PassThrough(),stderr:new PassThrough(),exitCode:null as number|null,signalCode:null as string|null,kill:(_signal?:string)=>{child.exitCode=0;queueMicrotask(()=>child.emit('exit',0));return true;}});
    queueMicrotask(()=>child.stderr.write('https://controlled-test.trycloudflare.com\nRegistered tunnel connection\n'));
    return child as unknown as ChildProcess;
  });
  const remote=new RemoteAccess({database,port:3030,binDirectory:directory,spawn,now:()=>clock});controllers.push(remote);
  return {database,directory,remote,spawn,advance:(ms:number)=>{clock+=ms;}};
}
describe('opt-in remote controller with controlled executable and transport',()=>{
  it('starts only explicitly, pairs once, hides codes, and requires an exact active host',async()=>{
    const {remote,spawn}=fixture();expect(remote.status().state).toBe('off');expect(spawn).not.toHaveBeenCalled();
    await remote.start({mode:'temporary'});expect(spawn).toHaveBeenCalledTimes(1);
    expect(remote.isRemoteHost('controlled-test.trycloudflare.com')).toBe(true);expect(remote.isRemoteHost('controlled-test.trycloudflare.com:443')).toBe(false);expect(remote.isRemoteHost('evil.controlled-test.trycloudflare.com')).toBe(false);
    expect(remote.status()).not.toHaveProperty('pairing');expect(JSON.stringify(remote)).not.toContain('pair=');
    const pair=remote.status({includePairing:true}).pairing!;expect(pair.url).toContain('#pair=');
    const session=remote.pair(pair.code),cookie=`${REMOTE_COOKIE_NAME}=${session.sessionToken}`;
    expect(remote.authorize(cookie)).toBe(true);expect(remote.authorize(`${cookie}; ${cookie}`)).toBe(false);
    expect(()=>remote.pair(pair.code)).toThrow(/inválido ou expirado/);
    expect(remote.status({includePairing:true}).pairing!.code).not.toBe(pair.code);
  });
  it('expires pairing and sessions, revokes devices, and clears sessions on restart',async()=>{
    const {remote,database,directory,advance}=fixture();await remote.start({mode:'temporary'});
    const expired=remote.status({includePairing:true}).pairing!.code;advance(5*60000+1);expect(()=>remote.pair(expired)).toThrow();
    const cookie=()=>`${REMOTE_COOKIE_NAME}=${remote.pair(remote.status({includePairing:true}).pairing!.code).sessionToken}`;
    const first=cookie();advance(8*3600000+1);expect(remote.authorize(first)).toBe(false);
    const second=cookie();remote.revokeSessions();expect(remote.authorize(second)).toBe(false);
    const third=cookie();expect(remote.authorize(third)).toBe(true);
    const restarted=new RemoteAccess({database,port:3030,binDirectory:directory});controllers.push(restarted);
    expect(remote.authorize(third)).toBe(false);expect(restarted.status().state).toBe('off');
  });
  it('stopping revokes authorization and never passes managed credentials in command arguments',async()=>{
    const {remote,spawn}=fixture();await remote.start({mode:'managed',token:'managed-secret-token-for-test-only',publicUrl:'https://vendas.promobridge.com'});
    const args=spawn.mock.calls[0][1],options=spawn.mock.calls[0][2];expect(JSON.stringify(args)).not.toContain('managed-secret');expect(options.env?.TUNNEL_TOKEN).toBe('managed-secret-token-for-test-only');
    const session=remote.pair(remote.status({includePairing:true}).pairing!.code);await remote.stop();expect(remote.authorize(`${REMOTE_COOKIE_NAME}=${session.sessionToken}`)).toBe(false);expect(remote.origin).toBeNull();
  });
  it('rejects a modified local binary and unsafe managed addresses before spawning',async()=>{
    const {remote,spawn,directory}=fixture();
    for(const origin of ['http://example.com','https://127.0.0.1','https://host.local','https://valid.example.com/path','https://host.trycloudflare.com','https://host.com:443'])expect(()=>validateRemoteOrigin(origin)).toThrow();
    writeFileSync(join(directory,process.platform==='win32'?'cloudflared.exe':'cloudflared'),'modified');
    await expect(remote.start({mode:'temporary'})).rejects.toThrow(/alterado/);expect(spawn).not.toHaveBeenCalled();
  });
});
