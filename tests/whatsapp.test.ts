import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultSettings } from '../packages/shared/src/index.ts';
import type { IngestInput, Settings } from '../packages/shared/src/index.ts';

const mock = vi.hoisted(() => ({ make: vi.fn(), auth: vi.fn(), qr: vi.fn() }));
vi.mock('@whiskeysockets/baileys', () => ({
  default: mock.make, useMultiFileAuthState: mock.auth,
  DisconnectReason: { loggedOut: 401, badSession: 500, connectionReplaced: 440, multideviceMismatch: 411, forbidden: 403, restartRequired: 515 },
  WAMessageStatus: { ERROR: 0, PENDING: 1, SERVER_ACK: 2, DELIVERY_ACK: 3, READ: 4, PLAYED: 5 },
}));
vi.mock('qrcode', () => ({ default: { toDataURL: mock.qr } }));

import { WhatsAppService, WhatsAppSendError, normalizeIncomingMessage, type WhatsAppDelivery } from '../apps/worker/src/whatsapp.ts';
import { readJpegThumbnail } from '../apps/worker/src/jpeg-thumbnail.ts';

// A real 1×1 JPEG so the frame and MIME checks exercise a decodable embedded preview.
const jpeg = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD2miiisTQ//9k=', 'base64');

const source = '123456@g.us';
const destination = '987654@g.us';
const makeSettings = (): Settings => ({ ...defaultSettings(), sourceGroups: [source], destinationGroup: destination });
const incoming = (content: unknown = { conversation: 'Oferta https://amazon.com.br/dp/B012345678' }, overrides = {}) => ({
  key: { id: 'MESSAGE-1', remoteJid: source, fromMe: false },
  messageTimestamp: Math.floor(Date.now() / 1_000), message: content, ...overrides,
});
const socketFixture = () => ({
  ev: new EventEmitter(), user: { id: '5511999991234:9@s.whatsapp.net', name: 'Private name' },
  groupFetchAllParticipating: vi.fn().mockResolvedValue({
    [source]: { id: source, subject: 'Ofertas de origem', participants: [{ id: 'private-person' }] },
    [destination]: { id: destination, subject: 'Meu grupo', participants: [] },
  }),
  groupMetadata: vi.fn().mockImplementation(async (id: string) => ({ id, subject: 'Grupo atualizado', participants: [] })),
  sendMessage: vi.fn().mockResolvedValue({ key: { id: 'SENT-1' } }),
  logout: vi.fn().mockResolvedValue(undefined), end: vi.fn(),
});
type FakeSocket = ReturnType<typeof socketFixture>;
const flush = async () => { for (let index = 0; index < 15; index++) await Promise.resolve(); };

describe('WhatsApp normalization', () => {
  const options = { settings: makeSettings(), groups: [{ id: source, name: 'Fonte autorizada', participants: 3 }], upsertType: 'notify' };

  it('preserves multiple links in a forwarded caption inside nested view-once and ephemeral messages', () => {
    const text = 'Creme R$ 29,90\nhttps://amzn.to/exemplo\nhttps://shopee.com.br/product/123/456';
    const result = normalizeIncomingMessage(incoming({ ephemeralMessage: { message: { viewOnceMessageV2: { message: {
      imageMessage: { caption: text, contextInfo: { isForwarded: true, quotedMessage: { conversation: 'Não ingerir a citação' } } },
    } } } } }), options);
    expect(result).toEqual({ text, sourceId: source, sourceName: 'Fonte autorizada', messageId: 'MESSAGE-1', simulation: false, imageUrl: null });
  });

  it.each([
    { extendedTextMessage: { text: 'Um https://amazon.com.br/dp/B012345678', contextInfo: { isForwarded: true } } },
    { videoMessage: { caption: 'Um https://amazon.com.br/dp/B012345678' } },
    { documentWithCaptionMessage: { message: { documentMessage: { caption: 'Um https://amazon.com.br/dp/B012345678' } } } },
    { viewOnceMessage: { message: { imageMessage: { caption: 'Um https://amazon.com.br/dp/B012345678' } } } },
    { viewOnceMessageV2Extension: { message: { imageMessage: { caption: 'Um https://amazon.com.br/dp/B012345678' } } } },
  ])('handles supported text and caption containers', content => {
    expect(normalizeIncomingMessage(incoming(content), options)?.text).toContain('https://amazon.com.br/');
  });

  it.each([
    { key: { id: 'OWN', remoteJid: source, fromMe: true } },
    { key: { id: 'OTHER', remoteJid: 'unauthorized@g.us' } },
    { key: { id: 'DESTINATION', remoteJid: destination } },
    { key: { id: 'PRIVATE', remoteJid: '5511999991234@s.whatsapp.net' } },
    { key: { id: 'STATUS', remoteJid: 'status@broadcast' } },
    { key: { remoteJid: source } },
    { messageStubType: 27 },
    { message: { protocolMessage: { type: 0 }, conversation: 'Injected text' } },
    { message: { reactionMessage: { text: '❤️' } } },
    { message: { imageMessage: { contextInfo: { quotedMessage: { conversation: 'https://example.com' } } } } },
    { message: { conversation: 'x'.repeat(16_001) } },
    { message: { conversation: '\u0000 \r\n ' } },
  ])('ignores own, unauthorized, system, missing and oversized messages', overrides => {
    expect(normalizeIncomingMessage(incoming(undefined, overrides), options)).toBeNull();
  });

  it('ignores history, offline backlog and implausible future timestamps', () => {
    const now = Date.now();
    expect(normalizeIncomingMessage(incoming(), { ...options, upsertType: 'append' })).toBeNull();
    expect(normalizeIncomingMessage(incoming(undefined, { messageTimestamp: Math.floor(now / 1_000) - 60 }), { ...options, notBefore: now })).toBeNull();
    expect(normalizeIncomingMessage(incoming(undefined, { messageTimestamp: undefined }), { ...options, notBefore: now })).toBeNull();
    expect(normalizeIncomingMessage(incoming(undefined, { messageTimestamp: Math.floor(now / 1_000) + 600 }), options)).toBeNull();
    expect(normalizeIncomingMessage(incoming(undefined, { messageTimestamp: { low: Math.floor(now / 1_000), high: 0 } }), { ...options, notBefore: now })).not.toBeNull();
  });

  it('captures only the message own validated JPEG preview, including a link preview', () => {
    const image = normalizeIncomingMessage(incoming({ imageMessage: { caption: 'Oferta https://amazon.com.br/dp/B012345678', jpegThumbnail: jpeg } }), options);
    expect(image).toMatchObject({ imageThumbnailBase64: jpeg.toString('base64'), imageThumbnailMime: 'image/jpeg', imageUrl: null });
    const preview = normalizeIncomingMessage(incoming({ extendedTextMessage: { text: 'Oferta https://amazon.com.br/dp/B012345678', jpegThumbnail: jpeg.toString('base64') } }), options);
    expect(preview?.imageThumbnailBase64).toBe(jpeg.toString('base64'));
    const quoted = normalizeIncomingMessage(incoming({ extendedTextMessage: { text: 'Oferta https://amazon.com.br/dp/B012345678', contextInfo: {
      quotedMessage: { imageMessage: { jpegThumbnail: jpeg } }, externalAdReply: { thumbnail: jpeg },
    } } }), options);
    expect(quoted?.imageThumbnailBase64).toBeUndefined();
    const once = normalizeIncomingMessage(incoming({ viewOnceMessage: { message: { imageMessage: { caption: 'Oferta https://amazon.com.br/dp/B012345678', jpegThumbnail: jpeg } } } }), options);
    expect(once?.text).toContain('Oferta');
    expect(once?.imageThumbnailBase64).toBeUndefined();
  });

  it('rejects invalid, oversized or wrong-MIME previews without dropping their text', () => {
    for (const jpegThumbnail of [Buffer.from('<svg>bad</svg>'), Buffer.alloc(200 * 1024 + 1), '/9j/!!!!', Buffer.from([0xff, 0xd8, 0xff, 0xd9])]) {
      const result = normalizeIncomingMessage(incoming({ imageMessage: { caption: 'Oferta', jpegThumbnail } }), options);
      expect(result?.text).toBe('Oferta');
      expect(result?.imageThumbnailBase64).toBeUndefined();
    }
    expect(readJpegThumbnail(jpeg, 'image/png')).toBeNull();
    const invalidFrame = Buffer.from(jpeg);
    const frame = invalidFrame.indexOf(Buffer.from([0xff, 0xc0]));
    invalidFrame.writeUInt16BE(65535, frame + 5);
    expect(readJpegThumbnail(invalidFrame)).toBeNull();
  });

  it('ignores a source that is no longer available in the current session', () => {
    expect(normalizeIncomingMessage(incoming(), { ...options, groups: [] })).toBeNull();
    expect(normalizeIncomingMessage(incoming(), { ...options, groups: [{ id: source, name: 'Removed', participants: 0, available: false }] })).toBeNull();
  });
});

describe('WhatsApp lifecycle without a real connection', () => {
  let root: string;
  let authDir: string;
  let settings: Settings;
  let sockets: FakeSocket[];
  let service: WhatsAppService;
  let onMessage: ReturnType<typeof vi.fn<(input: IngestInput) => Promise<void>>>;
  let onEvent: ReturnType<typeof vi.fn<(event:string,message:string)=>void>>;
  let onDelivery: ReturnType<typeof vi.fn<(delivery: WhatsAppDelivery) => void>>;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'promobridge-whatsapp-'));
    authDir = join(root, 'session');
    settings = makeSettings();
    sockets = [];
    mock.make.mockReset().mockImplementation(() => { const socket = socketFixture(); sockets.push(socket); return socket; });
    mock.auth.mockReset().mockImplementation(async () => ({
      state: { creds: {}, keys: { get: vi.fn(), set: vi.fn().mockResolvedValue(undefined) } },
      saveCreds: async () => { await writeFile(join(authDir, 'creds.json'), '{"secret":"private"}'); },
    }));
    mock.qr.mockReset().mockResolvedValue('data:image/png;base64,QR');
    onMessage = vi.fn<(input: IngestInput) => Promise<void>>().mockResolvedValue(undefined);
    onEvent = vi.fn();
    onDelivery = vi.fn<(delivery: WhatsAppDelivery) => void>();
    service = new WhatsAppService({ authDir, onMessage, getSettings: () => settings, onEvent, onDelivery });
  });

  afterEach(async () => {
    await service.stop();
    vi.useRealTimers();
    await rm(root, { recursive: true, force: true });
  });

  async function open(): Promise<FakeSocket> {
    await service.connect();
    const socket = sockets.at(-1)!;
    socket.ev.emit('connection.update', { connection: 'open' });
    await flush();
    return socket;
  }

  it('does not connect at startup; explicit connect is idempotent and uses a private local session', async () => {
    expect(service.getStatus()).toMatchObject({ connected: false, connecting: false, qrDataUrl: null });
    expect(mock.make).not.toHaveBeenCalled();
    await Promise.all([service.connect(), service.connect()]);
    expect(mock.make).toHaveBeenCalledTimes(1);
    if (process.platform !== 'win32') expect((await stat(authDir)).mode & 0o777).toBe(0o700);
    const options = mock.make.mock.calls[0][0];
    expect(options).toMatchObject({ printQRInTerminal: false, syncFullHistory: false, emitOwnEvents: false });
    expect(options.shouldSyncHistoryMessage()).toBe(false);
    sockets[0].ev.emit('connection.update', { qr: 'NEVER LOG THIS SECRET' });
    await flush();
    expect(service.getStatus().qrDataUrl).toBe('data:image/png;base64,QR');
    expect(JSON.stringify(onEvent.mock.calls)).not.toContain('NEVER LOG');
  });

  it('loads groups automatically, redacts the phone and returns isolated status objects', async () => {
    const socket = await open();
    expect(socket.groupFetchAllParticipating).toHaveBeenCalledTimes(1);
    expect(service.getStatus()).toMatchObject({ connected: true, connecting: false, qrDataUrl: null, user: '•••• 1234' });
    const status = service.getStatus();
    status.groups[0].name = 'tampered';
    expect(service.getStatus().groups[0].name).not.toBe('tampered');
    expect(JSON.stringify(service.getStatus())).not.toContain('551199999');
    expect(JSON.stringify(onEvent.mock.calls)).not.toContain('551199999');
  });

  it('ingests each live message once and continues after an individual processing error', async () => {
    const socket = await open();
    onMessage.mockRejectedValueOnce(new Error('private original message'));
    socket.ev.emit('messages.upsert', { type: 'notify', messages: [incoming(), incoming(), incoming(undefined, {
      key: { id: 'MESSAGE-2', remoteJid: source },
    })] });
    await flush();
    expect(onMessage).toHaveBeenCalledTimes(2);
    expect(onMessage.mock.calls[0][0]).toMatchObject({ sourceId: source, sourceName: 'Ofertas de origem', simulation: false });
    socket.ev.emit('messages.upsert', { type: 'append', messages: [incoming()] });
    socket.ev.emit('messages.upsert', { type: 'notify', requestId: 'offline-resend', messages: [incoming()] });
    settings.sourceGroups = [];
    socket.ev.emit('messages.upsert', { type: 'notify', messages: [incoming(undefined, { key: { id: 'MESSAGE-3', remoteJid: source } })] });
    await flush();
    expect(onMessage).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(onEvent.mock.calls)).not.toContain('private original message');
  });

  it('only sends to the configured available destination while connected and unpaused', async () => {
    await expect(service.sendText(destination, 'Oferta')).rejects.toThrow('desconectado');
    const socket = await open();
    await expect(service.sendText(source, 'Oferta')).rejects.toThrow('destino');
    settings.paused = true;
    await expect(service.sendText(destination, 'Oferta')).rejects.toThrow('pausada');
    settings.paused = false;
    await expect(service.sendText(destination, 'x'.repeat(16_001))).rejects.toThrow('16.000');
    settings.destinationGroup = 'unavailable@g.us';
    await expect(service.sendText(settings.destinationGroup, 'Oferta')).rejects.toThrow('disponível');
    settings.destinationGroup = destination;
    expect(socket.sendMessage).not.toHaveBeenCalled();
    await expect(service.sendText(destination, 'Oferta')).resolves.toBe('SENT-1');
    socket.sendMessage.mockRejectedValueOnce(new Error('private session token'));
    await expect(service.sendText(destination, 'Outra oferta')).rejects.toThrow('não confirmou');
    expect(socket.sendMessage).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(onEvent.mock.calls)).not.toContain('private session token');
  });

  it('reconnects with bounded exponential backoff and stops after the retry limit', async () => {
    vi.useFakeTimers();
    let socket = await open();
    for (const delay of [1_000, 2_000, 4_000, 8_000, 16_000, 30_000]) {
      socket.ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 408 } } } });
      expect(service.getStatus().connecting).toBe(true);
      const count = sockets.length;
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(sockets).toHaveLength(count);
      await vi.advanceTimersByTimeAsync(1);
      // Socket creation performs real local filesystem I/O after the timer.
      await vi.waitFor(() => expect(sockets).toHaveLength(count + 1));
      socket = sockets.at(-1)!;
      socket.ev.emit('connection.update', { connection: 'open' });
      await flush();
    }
    socket.ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 408 } } } });
    expect(service.getStatus()).toMatchObject({ connected: false, connecting: false });
    expect(service.getStatus().lastError).toContain('várias tentativas');
    await vi.advanceTimersByTimeAsync(120_000);
    expect(sockets).toHaveLength(7);
  });

  it.each([401, 403, 411, 440, 500])('does not reconnect after terminal disconnect %i', async code => {
    vi.useFakeTimers();
    const socket = await open();
    socket.ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: code } } } });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(sockets).toHaveLength(1);
    expect(service.getStatus()).toMatchObject({ connected: false, connecting: false, groups: [] });
    expect(service.getStatus().lastError).toContain('Sessão encerrada');
  });

  it('stop cancels reconnects and rejects events from an obsolete socket', async () => {
    vi.useFakeTimers();
    const socket = await open();
    const oldListener = socket.ev.listeners('connection.update')[0];
    socket.ev.emit('connection.update', { connection: 'close' });
    await service.stop();
    oldListener({ connection: 'open' });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(service.getStatus()).toMatchObject({ connected: false, connecting: false, groups: [] });
    expect(sockets).toHaveLength(1);
    expect(socket.ev.listenerCount('connection.update')).toBe(0);
  });

  it('reset waits for credential writes, logs out, removes auth and never auto-connects', async () => {
    const socket = await open();
    socket.ev.emit('creds.update', {});
    await flush();
    await service.reset();
    await expect(stat(authDir)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(socket.logout).toHaveBeenCalledTimes(1);
    expect(socket.end).toHaveBeenCalled();
    expect(service.getStatus()).toMatchObject({ connected: false, connecting: false, qrDataUrl: null, user: null, groups: [] });
    expect(sockets).toHaveLength(1);
    await service.connect();
    expect(sockets).toHaveLength(2);
  });

  it('stop during asynchronous initialization cannot resurrect a socket', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>(resolveGate => { release = resolveGate; });
    const originalAuth = mock.auth.getMockImplementation()!;
    mock.auth.mockImplementationOnce(async () => { await gate; return originalAuth(); });
    const connecting = service.connect();
    await vi.waitFor(() => expect(mock.auth).toHaveBeenCalledTimes(1));
    const stopping = service.stop();
    release!();
    await Promise.all([connecting, stopping]);
    expect(mock.make).not.toHaveBeenCalled();
    expect(service.getStatus()).toMatchObject({ connected: false, connecting: false });
  });

  it('ignores a delayed QR after reset and serializes a new connect after cleanup', async () => {
    let releaseQr: ((value: string) => void) | undefined;
    mock.qr.mockImplementationOnce(() => new Promise<string>(resolveQr => { releaseQr = resolveQr; }));
    const socket = await open();
    socket.ev.emit('connection.update', { qr: 'obsolete secret' });
    await flush();
    const reset = service.reset();
    const connect = service.connect();
    releaseQr!('data:image/png;base64,OBSOLETE');
    await Promise.all([reset, connect]);
    expect(sockets).toHaveLength(2);
    expect(service.getStatus().qrDataUrl).toBeNull();
    expect(service.getStatus().connecting).toBe(true);
  });

  it('persists credentials with private file permissions', async () => {
    const socket = await open();
    socket.ev.emit('creds.update', {});
    await service.stop();
    // stop invalidates queued writes; persist a credential through a fresh connection instead.
    await service.connect();
    sockets.at(-1)!.ev.emit('creds.update', {});
    await vi.waitFor(async () => { const file = await stat(join(authDir, 'creds.json')); expect(file.isFile()).toBe(true); if (process.platform !== 'win32') expect(file.mode & 0o777).toBe(0o600); });
    expect(await readFile(join(authDir, 'creds.json'), 'utf8')).toContain('private');
  });

  it('sends a validated local JPEG and its actual caption once, without an automatic text fallback', async () => {
    const socket = await open();
    await expect(service.sendImage(destination, jpeg, 'Oferta com imagem')).resolves.toBe('SENT-1');
    expect(socket.sendMessage).toHaveBeenCalledWith(destination, {
      image: jpeg, caption: 'Oferta com imagem', mimetype: 'image/jpeg', jpegThumbnail: jpeg.toString('base64'),
    });
    await expect(service.sendImage(destination, jpeg, 'x'.repeat(1025))).rejects.toMatchObject({ uncertain: false });
    await expect(service.sendImage(destination, Buffer.from('invalid'), 'Oferta')).rejects.toMatchObject({ uncertain: false });
    socket.sendMessage.mockRejectedValueOnce(new Error('private upload token'));
    await expect(service.sendImage(destination, jpeg, 'Outra oferta')).rejects.toMatchObject({ uncertain: true });
    expect(socket.sendMessage).toHaveBeenCalledTimes(2);
    expect(socket.sendMessage.mock.calls.every(([, content]) => 'image' in content)).toBe(true);
    expect(JSON.stringify(onEvent.mock.calls)).not.toContain('private upload token');
    expect(service.getStatus().lastSentAt).toEqual(expect.any(String));
  });

  it('bounds a hung send, reports uncertainty and never retries when its late response arrives', async () => {
    vi.useFakeTimers();
    const socket = await open();
    let release: ((value: { key: { id: string } }) => void) | undefined;
    socket.sendMessage.mockImplementationOnce(() => new Promise(resolveSend => { release = resolveSend; }));
    const result = service.sendText(destination, 'Oferta').catch(error => error);
    await vi.advanceTimersByTimeAsync(25_000);
    const error = await result;
    expect(error).toBeInstanceOf(WhatsAppSendError);
    expect(error.uncertain).toBe(true);
    expect(socket.sendMessage).toHaveBeenCalledTimes(1);
    release!({ key: { id: 'LATE-ID' } });
    await flush();
    expect(socket.sendMessage).toHaveBeenCalledTimes(1);
    expect(onEvent).toHaveBeenCalledWith('whatsapp.send_uncertain', expect.stringContaining('Confira o grupo'));
  });

  it('updates group names and announcement permissions from live metadata using PN and LID identities', async () => {
    const socket = await open();
    socket.ev.emit('groups.update', [{ id: destination, subject: 'Destino atualizado', announce: true }]);
    expect(service.getStatus().groups.find(group => group.id === destination)).toMatchObject({ name: 'Destino atualizado', canSend: false, announcement: true });
    await expect(service.assertCanSend(destination, 'Oferta')).rejects.toMatchObject({ uncertain: false });
    expect(service.getStatus().diagnostics?.join(' ')).toContain('administradores');
    socket.ev.emit('groups.upsert', [{ id: destination, subject: 'Destino LID', announce: true,
      participants: [{ id: '123456789@lid', jid: '5511999991234@s.whatsapp.net', admin: 'admin' }] }]);
    expect(service.getStatus().groups.find(group => group.id === destination)).toMatchObject({ isAdmin: true, canSend: true });
    await expect(service.assertCanSend(destination, 'Oferta')).resolves.toBeUndefined();
    socket.ev.emit('group-participants.update', { id: destination, author: 'admin', participants: ['123456789@lid'], action: 'demote' });
    await expect(service.assertCanSend(destination, 'Oferta')).rejects.toMatchObject({ uncertain: false });
    expect(socket.sendMessage).not.toHaveBeenCalled();
    expect(JSON.stringify(service.getStatus())).not.toContain('551199999');
    expect(JSON.stringify(service.getStatus())).not.toContain('123456789@lid');
  });

  it('stops receiving and sending a group immediately after the local number is removed', async () => {
    const socket = await open();
    socket.ev.emit('group-participants.update', { id: source, author: 'admin', participants: ['5511999991234@s.whatsapp.net'], action: 'remove' });
    socket.ev.emit('messages.upsert', { type: 'notify', messages: [incoming()] });
    await flush();
    expect(onMessage).not.toHaveBeenCalled();
    expect(service.getStatus().diagnostics?.join(' ')).toContain('origem não está disponível');
    socket.ev.emit('group-participants.update', { id: destination, author: 'admin', participants: ['5511999991234:9@s.whatsapp.net'], action: 'remove' });
    await expect(service.sendText(destination, 'Oferta')).rejects.toMatchObject({ uncertain: false });
    expect(socket.sendMessage).not.toHaveBeenCalled();
  });

  it('refreshes expired destination metadata before sending and rejects a failed check without uncertainty', async () => {
    vi.useFakeTimers();
    const socket = await open();
    await vi.advanceTimersByTimeAsync(60_001);
    socket.groupMetadata.mockResolvedValueOnce({ id: destination, subject: 'Só administradores', announce: true, participants: [] });
    await expect(service.sendText(destination, 'Oferta')).rejects.toMatchObject({ uncertain: false });
    expect(socket.groupMetadata).toHaveBeenCalledWith(destination);
    expect(socket.sendMessage).not.toHaveBeenCalled();
    await service.refreshGroups();
    await vi.advanceTimersByTimeAsync(60_001);
    socket.groupMetadata.mockRejectedValueOnce(new Error('private auth payload'));
    await expect(service.sendText(destination, 'Oferta')).rejects.toThrow('confirmar o acesso');
    expect(socket.sendMessage).not.toHaveBeenCalled();
    expect(JSON.stringify(onEvent.mock.calls)).not.toContain('private auth payload');
  });

  it('refuses metadata returned for a different group before attempting a send', async () => {
    vi.useFakeTimers();
    const socket = await open();
    await vi.advanceTimersByTimeAsync(60_001);
    socket.groupMetadata.mockResolvedValueOnce({ id: source, subject: 'Outro grupo', participants: [] });
    await expect(service.sendText(destination, 'Oferta')).rejects.toMatchObject({ uncertain: false });
    expect(socket.sendMessage).not.toHaveBeenCalled();
  });

  it.each(['pause', 'destination', 'source'])('rechecks %s after the asynchronous preflight before network I/O', async changed => {
    const socket = await open();
    const preflight = service.assertCanSend.bind(service);
    vi.spyOn(service, 'assertCanSend').mockImplementationOnce(async (group, text) => {
      await preflight(group, text);
      if (changed === 'pause') settings.paused = true;
      else if (changed === 'destination') settings.destinationGroup = 'another@g.us';
      else settings.sourceGroups.push(destination);
    });
    await expect(service.sendText(destination, 'Oferta')).rejects.toMatchObject({ uncertain: false });
    expect(socket.sendMessage).not.toHaveBeenCalled();
  });

  it('reports receipts only for a known message, its exact group and its own sender', async () => {
    const socket = await open();
    await service.sendText(destination, 'Oferta');
    socket.ev.emit('messages.update', [
      { key: { id: 'UNKNOWN', remoteJid: destination, fromMe: true }, update: { status: 4 } },
      { key: { id: 'SENT-1', remoteJid: source, fromMe: true }, update: { status: 4 } },
      { key: { id: 'SENT-1', remoteJid: destination, fromMe: false }, update: { status: 4 } },
      { key: { id: 'SENT-1', remoteJid: destination, fromMe: true }, update: { status: 1 } },
      { key: { id: 'SENT-1', remoteJid: destination, fromMe: true }, update: { status: 3 } },
      { key: { id: 'SENT-1', remoteJid: destination, fromMe: true }, update: { status: 3 } },
      { key: { id: 'SENT-1', remoteJid: destination, fromMe: true }, update: { status: 4 } },
      { key: { id: 'SENT-1', remoteJid: destination, fromMe: true }, update: { status: 3 } },
      { key: { id: 'SENT-1', remoteJid: destination, fromMe: true }, update: { status: 2 } },
      { key: { id: 'SENT-1', remoteJid: destination, fromMe: true }, update: { status: 0 } },
    ]);
    expect(onDelivery.mock.calls.map(([value]) => value)).toEqual([
      { groupId: destination, messageId: 'SENT-1', status: 'delivered' },
      { groupId: destination, messageId: 'SENT-1', status: 'read' },
    ]);
    expect(socket.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('allows a later live retry after failed persistence and records the last successfully processed message', async () => {
    const socket = await open();
    onMessage.mockRejectedValueOnce(new Error('disk full'));
    socket.ev.emit('messages.upsert', { type: 'notify', messages: [incoming()] });
    await flush();
    expect(service.getStatus().lastMessageAt).toBeUndefined();
    socket.ev.emit('messages.upsert', { type: 'notify', messages: [incoming()] });
    await flush();
    expect(onMessage).toHaveBeenCalledTimes(2);
    expect(service.getStatus().lastMessageAt).toEqual(expect.any(String));
  });

  it('bounds pending ingestion and reset never waits on a callback that may be waiting for reset itself', async () => {
    const socket = await open();
    let release: (() => void) | undefined;
    onMessage.mockImplementationOnce(() => new Promise<void>(resolveMessage => { release = resolveMessage; }));
    socket.ev.emit('messages.upsert', { type: 'notify', messages: Array.from({ length: 205 }, (_, index) => incoming(undefined, {
      key: { id: `BURST-${index}`, remoteJid: source },
    })) });
    await flush();
    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onEvent.mock.calls.filter(([event]) => event === 'whatsapp.ingest_overflow')).toHaveLength(1);
    await service.reset();
    expect(service.getStatus()).toMatchObject({ connected: false, connecting: false });
    release!();
    await flush();
    expect(onMessage).toHaveBeenCalledTimes(1);
    await expect(stat(authDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('handles the expected restart after scanning QR without spending the normal reconnect budget', async () => {
    vi.useFakeTimers();
    const socket = await open();
    socket.ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 515 } } } });
    await vi.advanceTimersByTimeAsync(100);
    await vi.waitFor(() => expect(sockets).toHaveLength(2));
    sockets[1].ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 408 } } } });
    await vi.advanceTimersByTimeAsync(999);
    expect(sockets).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(sockets).toHaveLength(3));
  });
});
