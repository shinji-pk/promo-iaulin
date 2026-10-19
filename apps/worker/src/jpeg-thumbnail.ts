/** Only embedded JPEG previews are accepted; no URL or media download is performed. */
export const MAX_JPEG_THUMBNAIL_BYTES = 200 * 1024;

export function readJpegThumbnail(value: unknown, mime = 'image/jpeg'): Buffer | null {
  if (mime !== 'image/jpeg') return null;
  let bytes: Buffer;
  if (typeof value === 'string') {
    if (!value || value.length > Math.ceil(MAX_JPEG_THUMBNAIL_BYTES / 3) * 4
      || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return null;
    bytes = Buffer.from(value, 'base64');
    if (bytes.toString('base64') !== value) return null;
  } else if (value instanceof Uint8Array) {
    if (value.byteLength > MAX_JPEG_THUMBNAIL_BYTES) return null;
    bytes = Buffer.from(value);
  } else return null;
  if (bytes.length < 24 || bytes.length > MAX_JPEG_THUMBNAIL_BYTES
    || bytes[0] !== 0xff || bytes[1] !== 0xd8
    || bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9) return null;

  // Check marker lengths and declared dimensions before allowing a decoder to see it.
  let framed = false;
  for (let offset = 2; offset < bytes.length - 2;) {
    if (bytes[offset++] !== 0xff) return null;
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === undefined || marker === 0x00 || marker === 0xd8 || marker === 0xd9) return null;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) return null;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length - 2) return null;
    if ((marker >= 0xc0 && marker <= 0xcf) && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      if (length < 8) return null;
      const height = bytes.readUInt16BE(offset + 3);
      const width = bytes.readUInt16BE(offset + 5);
      if (!width || !height || width > 4096 || height > 4096 || width * height > 4_194_304) return null;
      framed = true;
    }
    if (marker === 0xda) return framed ? bytes : null;
    offset += length;
  }
  return null;
}
