import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { readJpegThumbnail, MAX_JPEG_THUMBNAIL_BYTES } from './jpeg-thumbnail.ts';
import type { Database } from '../../../packages/db/src/index.ts';

interface MediaRecord {id:string;createdAt:string;bytes:number;}
const ID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** Embedded previews only. This store never downloads a remote URL. */
export class MediaStore {
  #database:Database;
  #directory:string|null;
  #memory=new Map<string,Buffer>();
  constructor(database:Database,directory?:string) {
    this.#database=database;
    this.#directory=directory ? resolve(directory) : database.storageDirectory() ? join(database.storageDirectory()!,'media') : null;
    if (this.#directory) {
      if (existsSync(this.#directory) && (!lstatSync(this.#directory).isDirectory() || lstatSync(this.#directory).isSymbolicLink())) throw new Error('A pasta de imagens precisa ser um diretório local.');
      mkdirSync(this.#directory,{recursive:true,mode:0o700});
      chmodSync(this.#directory,0o700);
    }
  }
  save(value:unknown,mime='image/jpeg',now=new Date()):string|null {
    const bytes=readJpegThumbnail(value,mime);
    if (!bytes) return null;
    const records=this.#database.listRecords<MediaRecord>('media');
    if (records.length>=5_000 || records.reduce((sum,record)=>sum+(record.bytes || 0),0)+bytes.length>500*1024*1024) return null;
    const id=randomUUID();
    if (this.#directory) writeFileSync(join(this.#directory,`${id}.jpg`),bytes,{mode:0o600,flag:'wx'});
    else this.#memory.set(id,bytes);
    this.#database.putRecord('media',id,{id,createdAt:now.toISOString(),bytes:bytes.length} satisfies MediaRecord);
    return id;
  }
  get(id:string):Buffer|null {
    if (!ID.test(id) || !this.#database.getRecord<MediaRecord>('media',id)) return null;
    if (!this.#directory) return this.#memory.get(id) ?? null;
    try {
      const path=join(this.#directory,`${id}.jpg`),info=lstatSync(path);
      if (!info.isFile() || info.isSymbolicLink() || info.size>MAX_JPEG_THUMBNAIL_BYTES) return null;
      return readJpegThumbnail(readFileSync(path));
    } catch {return null;}
  }
  cleanup():number {
    const used=new Set(this.#database.listOffers().map(offer=>offer.mediaId).filter(Boolean));
    let removed=0;
    for (const record of this.#database.listRecords<MediaRecord>('media')) {
      if (!ID.test(record.id) || used.has(record.id)) continue;
      if (this.#directory) {try {unlinkSync(join(this.#directory,`${record.id}.jpg`));} catch { /* A missing preview does not invalidate history. */ }}
      this.#memory.delete(record.id);this.#database.deleteRecord('media',record.id);removed++;
    }
    return removed;
  }
}
