import { createCipheriv, createDecipheriv, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { platformIds, type PlatformId } from '../../../packages/shared/src/index.ts';
import type { CredentialStatus } from '../../../packages/shared/src/features.ts';

interface CredentialEntry { values:Record<string,string>; revision:string; updatedAt:string; }
interface Envelope { version:1; iv:string; tag:string; ciphertext:string; }

/** Local-only encrypted credentials. No key or plaintext is enumerable/serializable. */
export class SecretVault {
  #key:Buffer;
  #directory:string|null;
  #memory = new Map<PlatformId,string>();

  constructor(options:{directory?:string;memory?:boolean} = {}) {
    this.#directory = options.memory || options.directory === ':memory:' ? null : resolve(options.directory ?? 'data/affiliate-vault');
    if (!this.#directory) { this.#key=randomBytes(32); return; }
    if (existsSync(this.#directory) && (!lstatSync(this.#directory).isDirectory() || lstatSync(this.#directory).isSymbolicLink())) throw new Error('A pasta de credenciais precisa ser um diretório local.');
    mkdirSync(this.#directory,{recursive:true,mode:0o700});
    chmodSync(this.#directory,0o700);
    const keyPath=join(this.#directory,'key.bin');
    if (existsSync(keyPath)) {
      this.#assertFile(keyPath);
      this.#key=readFileSync(keyPath);
      if (this.#key.length!==32) throw new Error('Chave local de credenciais inválida. Restaure a instalação local antes de continuar.');
      chmodSync(keyPath,0o600);
    } else {
      if (platformIds.some(platform=>existsSync(join(this.#directory!,`${platform}.json`)))) throw new Error('A chave local das credenciais está ausente. Reconfigure as conexões nesta instalação.');
      this.#key=randomBytes(32);
      writeFileSync(keyPath,this.#key,{mode:0o600,flag:'wx'});
    }
  }

  #assertPlatform(platform:PlatformId):void { if (!platformIds.includes(platform)) throw new Error('Loja inválida.'); }
  #assertFile(path:string):void {
    const info=lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size>256_000) throw new Error('Arquivo local de credenciais inválido.');
  }
  #read(platform:PlatformId):CredentialEntry|undefined {
    this.#assertPlatform(platform);
    let encoded:string|undefined;
    if (this.#directory) {
      const path=join(this.#directory,`${platform}.json`);
      if (!existsSync(path)) return undefined;
      this.#assertFile(path);
      encoded=readFileSync(path,'utf8');
    } else encoded=this.#memory.get(platform);
    if (!encoded) return undefined;
    try {
      const envelope:Envelope=JSON.parse(encoded);
      if (envelope.version!==1 || typeof envelope.iv!=='string' || typeof envelope.tag!=='string' || typeof envelope.ciphertext!=='string') throw new Error();
      const iv=Buffer.from(envelope.iv,'base64'); const tag=Buffer.from(envelope.tag,'base64');
      if (iv.length!==12 || tag.length!==16) throw new Error();
      const decipher=createDecipheriv('aes-256-gcm',this.#key,iv);
      decipher.setAAD(Buffer.from(`promobridge:credentials:v1:${platform}`));
      decipher.setAuthTag(tag);
      const entry:CredentialEntry=JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext,'base64')),decipher.final()]).toString('utf8'));
      if (!entry || typeof entry.revision!=='string' || typeof entry.updatedAt!=='string' || !Number.isFinite(Date.parse(entry.updatedAt))) throw new Error();
      this.#validateValues(entry.values);
      return entry;
    } catch { throw new Error('Não foi possível abrir as credenciais locais. Reconfigure a conexão desta loja.'); }
  }
  #validateValues(values:Record<string,string>):void {
    if (!values || typeof values!=='object' || Array.isArray(values) || Object.keys(values).length>32 || JSON.stringify(values).length>65_536) throw new Error('Formato das credenciais inválido.');
    for (const [key,value] of Object.entries(values)) if (!/^[a-zA-Z][a-zA-Z0-9_]{0,60}$/.test(key) || typeof value!=='string' || !value || value.length>8192) throw new Error('Campo de credencial inválido.');
  }

  get(platform:PlatformId):Record<string,string>|undefined { const entry=this.#read(platform); return entry ? {...entry.values} : undefined; }
  set(platform:PlatformId,values:Record<string,string>):CredentialStatus {
    this.#assertPlatform(platform); this.#validateValues(values);
    if (!Object.keys(values).length) throw new Error('Informe as credenciais da conexão.');
    const entry:CredentialEntry={values:{...values},revision:randomUUID(),updatedAt:new Date().toISOString()};
    const iv=randomBytes(12); const cipher=createCipheriv('aes-256-gcm',this.#key,iv);
    cipher.setAAD(Buffer.from(`promobridge:credentials:v1:${platform}`));
    const ciphertext=Buffer.concat([cipher.update(JSON.stringify(entry),'utf8'),cipher.final()]);
    const envelope:Envelope={version:1,iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),ciphertext:ciphertext.toString('base64')};
    const encoded=JSON.stringify(envelope);
    if (this.#directory) {
      const path=join(this.#directory,`${platform}.json`); const temporary=join(this.#directory,`.${platform}.${randomUUID()}.tmp`);
      if (existsSync(path)) this.#assertFile(path);
      try { writeFileSync(temporary,encoded,{mode:0o600,flag:'wx'}); renameSync(temporary,path); chmodSync(path,0o600); }
      finally { if (existsSync(temporary)) unlinkSync(temporary); }
    } else this.#memory.set(platform,encoded);
    return this.status(platform);
  }
  remove(platform:PlatformId):void {
    this.#assertPlatform(platform);
    if (this.#directory) { const path=join(this.#directory,`${platform}.json`); if (existsSync(path)) { this.#assertFile(path); unlinkSync(path); } }
    else this.#memory.delete(platform);
  }
  status(platform:PlatformId):CredentialStatus {
    const entry=this.#read(platform);
    return {platform,configured:Boolean(entry),revision:entry?.revision ?? '',updatedAt:entry?.updatedAt ?? null,fields:entry ? Object.keys(entry.values).sort() : []};
  }
  /** Authenticate local operational evidence without putting the signing key in SQLite. */
  signReceipt(payload:string):string { return createHmac('sha256',this.#key).update('promobridge:affiliate-evidence:v1\0').update(payload).digest('hex'); }
  verifyReceipt(payload:string,signature:string):boolean {
    if (!/^[a-f0-9]{64}$/.test(signature)) return false;
    return timingSafeEqual(Buffer.from(this.signReceipt(payload),'hex'),Buffer.from(signature,'hex'));
  }
  toJSON():{localOnly:true} { return {localOnly:true}; }
}
