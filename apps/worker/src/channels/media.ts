import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Database } from '../../../../packages/db/src/index.ts';
import { channelMediaLimits, channelMediaMimes } from '../../../../packages/shared/src/channels.ts';

export interface ChannelMediaRecord { id: string; mime: string; bytes: number; sha256: string; name: string; kind: 'image' | 'video' | 'audio'; createdAt: string; }
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NAMESPACE = 'channel-media';

/** Detects the real format from the file bytes. The name and declared type are never trusted. */
export function sniffMedia(bytes: Buffer): string | null {
  if (bytes.length < 12) return null;
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  if (bytes.toString('latin1', 4, 8) === 'ftyp') {
    const brand = bytes.toString('latin1', 8, 12);
    return /^M4A |^M4B /.test(brand) ? 'audio/mp4' : 'video/mp4';
  }
  if (bytes.toString('latin1', 0, 4) === 'OggS') return 'audio/ogg';
  if (bytes.toString('latin1', 0, 3) === 'ID3' || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0)) return 'audio/mpeg';
  return null;
}

/** Files uploaded for channel posts. Separate from offer previews, which have their own retention. */
export class ChannelMediaStore {
  #directory: string | null;
  #memory = new Map<string, Buffer>();
  constructor(private readonly database: Database, directory?: string) {
    this.#directory = directory ? resolve(directory) : database.storageDirectory() ? join(database.storageDirectory()!, 'channel-media') : null;
    if (this.#directory) {
      if (existsSync(this.#directory) && (!lstatSync(this.#directory).isDirectory() || lstatSync(this.#directory).isSymbolicLink())) throw new Error('A pasta de mídias dos canais precisa ser um diretório local.');
      mkdirSync(this.#directory, { recursive: true, mode: 0o700 });
      chmodSync(this.#directory, 0o700);
    }
  }

  save(input: { kind: 'image' | 'video' | 'audio'; base64: string; name: string }, now = new Date()): ChannelMediaRecord {
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(input.base64) || input.base64.length % 4 !== 0) throw new Error('Arquivo inválido.');
    const bytes = Buffer.from(input.base64, 'base64');
    if (!bytes.length || bytes.length > channelMediaLimits.maxBytes) throw new Error('O arquivo deve ter até 3 MB.');
    const mime = sniffMedia(bytes);
    if (!mime || !channelMediaMimes[input.kind].includes(mime)) throw new Error(input.kind === 'image' ? 'Envie uma imagem JPEG, PNG ou WebP.' : input.kind === 'video' ? 'Envie um vídeo MP4.' : 'Envie um áudio MP3, OGG ou M4A.');
    const records = this.database.listRecords<ChannelMediaRecord>(NAMESPACE);
    if (records.length >= 2_000 || records.reduce((sum, record) => sum + record.bytes, 0) + bytes.length > 1024 * 1024 * 1024) throw new Error('O espaço de mídias dos canais está cheio. Exclua rascunhos antigos.');
    const id = randomUUID();
    const record: ChannelMediaRecord = { id, mime, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), name: input.name.replace(/[^\p{L}\p{N} ._-]/gu, '').slice(0, 80) || 'arquivo', kind: input.kind, createdAt: now.toISOString() };
    if (this.#directory) writeFileSync(join(this.#directory, `${id}.bin`), bytes, { mode: 0o600, flag: 'wx' });
    else this.#memory.set(id, bytes);
    this.database.putRecord(NAMESPACE, id, record);
    return record;
  }

  record(id: string): ChannelMediaRecord | undefined { return ID.test(id) ? this.database.getRecord<ChannelMediaRecord>(NAMESPACE, id) : undefined; }

  read(id: string): { record: ChannelMediaRecord; bytes: Buffer } | null {
    const record = this.record(id);
    if (!record) return null;
    let bytes: Buffer | undefined;
    if (!this.#directory) bytes = this.#memory.get(id);
    else {
      try {
        const path = join(this.#directory, `${id}.bin`), info = lstatSync(path);
        if (!info.isFile() || info.isSymbolicLink() || info.size > channelMediaLimits.maxBytes) return null;
        bytes = readFileSync(path);
      } catch { return null; }
    }
    // A file changed on disk after upload is refused rather than published.
    if (!bytes || createHash('sha256').update(bytes).digest('hex') !== record.sha256) return null;
    return { record, bytes };
  }

  /** Removes files no post references, after a grace period for drafts being written. */
  cleanup(referenced: Set<string>, now = new Date()): number {
    let removed = 0;
    for (const record of this.database.listRecords<ChannelMediaRecord>(NAMESPACE)) {
      if (referenced.has(record.id) || now.getTime() - Date.parse(record.createdAt) < 24 * 3_600_000) continue;
      if (this.#directory) { try { unlinkSync(join(this.#directory, `${record.id}.bin`)); } catch { /* already gone */ } }
      this.#memory.delete(record.id); this.database.deleteRecord(NAMESPACE, record.id); removed++;
    }
    return removed;
  }
}
