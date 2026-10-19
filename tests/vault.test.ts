import { createDecipheriv } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SecretVault } from '../apps/worker/src/secret-vault.ts';

const temporary:string[]=[];
afterEach(()=>{for (const directory of temporary.splice(0)) rmSync(directory,{recursive:true,force:true});});
function directory():string {const value=mkdtempSync(join(tmpdir(),'promobridge-vault-'));temporary.push(value);return value;}

describe('cofre local AES-GCM',()=>{
  it('persiste apenas ciphertext autenticado, com chave e diretório restritos',()=>{
    const path=directory(); const vault=new SecretVault({directory:path});
    const status=vault.set('shopee',{appId:'123456',secret:'segredo-local-muito-especifico'});
    const encoded=readFileSync(join(path,'shopee.json'),'utf8');
    expect(encoded).not.toContain('segredo-local-muito-especifico');
    expect(encoded).not.toContain('123456');
    expect(statSync(path).mode & 0o777).toBe(0o700);
    expect(statSync(join(path,'key.bin')).mode & 0o777).toBe(0o600);
    expect(statSync(join(path,'shopee.json')).mode & 0o777).toBe(0o600);
    // Decrypt independently of the implementation, including the platform-bound AAD.
    const envelope=JSON.parse(encoded);const key=readFileSync(join(path,'key.bin'));
    const decipher=createDecipheriv('aes-256-gcm',key,Buffer.from(envelope.iv,'base64'));
    decipher.setAAD(Buffer.from('promobridge:credentials:v1:shopee'));
    decipher.setAuthTag(Buffer.from(envelope.tag,'base64'));
    const entry=JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext,'base64')),decipher.final()]).toString());
    expect(entry.values).toEqual({appId:'123456',secret:'segredo-local-muito-especifico'});
    expect(entry.revision).toBe(status.revision);
    expect(new SecretVault({directory:path}).get('shopee')).toEqual(entry.values);
    expect(JSON.stringify(vault)).not.toContain('segredo');
    expect(Object.keys(vault)).toEqual([]);
    expect(status.fields).toEqual(['appId','secret']);
    expect(status).not.toHaveProperty('values');
    expect(readdirSync(path).sort()).toEqual(['key.bin','shopee.json']);
  });
  it('não permite mover credenciais para outra loja ou alterar o tag/ciphertext',()=>{
    const path=directory(); const vault=new SecretVault({directory:path});
    vault.set('shopee',{secret:'segredo'});
    const envelope=JSON.parse(readFileSync(join(path,'shopee.json'),'utf8'));
    writeFileSync(join(path,'aliexpress.json'),JSON.stringify(envelope));
    expect(()=>vault.get('aliexpress')).toThrow('Não foi possível abrir');
    const ciphertext=Buffer.from(envelope.ciphertext,'base64');ciphertext[0]^=0xff;envelope.ciphertext=ciphertext.toString('base64');
    writeFileSync(join(path,'shopee.json'),JSON.stringify(envelope));
    expect(()=>vault.get('shopee')).toThrow('Não foi possível abrir');
  });
  it('gera IV e revisão novos em cada alteração, sem devolver valores no status',()=>{
    const path=directory();const vault=new SecretVault({directory:path});
    const first=vault.set('amazon',{credentialSecret:'a'});const firstEnvelope=JSON.parse(readFileSync(join(path,'amazon.json'),'utf8'));
    const second=vault.set('amazon',{credentialSecret:'a'});const secondEnvelope=JSON.parse(readFileSync(join(path,'amazon.json'),'utf8'));
    expect(first.revision).not.toBe(second.revision);
    expect(firstEnvelope.iv).not.toBe(secondEnvelope.iv);
    expect(firstEnvelope.ciphertext).not.toBe(secondEnvelope.ciphertext);
    vault.remove('amazon');
    expect(vault.status('amazon')).toMatchObject({configured:false,revision:'',fields:[],updatedAt:null});
    expect(vault.get('amazon')).toBeUndefined();
  });
  it('não regenera uma chave perdida quando há credenciais da instalação',()=>{
    const path=directory();new SecretVault({directory:path}).set('shopee',{secret:'a'});
    rmSync(join(path,'key.bin'));
    expect(()=>new SecretVault({directory:path})).toThrow('chave local');
  });
  it('autentica recibos com uma chave de instalação, resistente a alteração e troca de chave',()=>{
    const vault=new SecretVault({memory:true});const another=new SecretVault({directory:':memory:'});
    const signature=vault.signReceipt('{"product":"123","url":"https://s.shopee.com.br/abc"}');
    expect(vault.verifyReceipt('{"product":"123","url":"https://s.shopee.com.br/abc"}',signature)).toBe(true);
    expect(vault.verifyReceipt('{"product":"124","url":"https://s.shopee.com.br/abc"}',signature)).toBe(false);
    expect(another.verifyReceipt('{"product":"123","url":"https://s.shopee.com.br/abc"}',signature)).toBe(false);
    expect(vault.verifyReceipt('payload','00')).toBe(false);
    expect(vault.verifyReceipt('payload','z'.repeat(64))).toBe(false);
  });
  it('não aceita plataforma usada como caminho nem payloads inválidos',()=>{
    const vault=new SecretVault({memory:true});
    expect(()=>vault.set('../secret' as never,{secret:'x'})).toThrow('Loja inválida');
    expect(()=>vault.set('shopee',{'secret/path':'x'})).toThrow('Campo');
    expect(()=>vault.set('shopee',{})).toThrow('Informe');
    expect(()=>vault.set('shopee',{secret:'x'.repeat(8193)})).toThrow('Campo');
  });
});
