// Picture fixtures for the export scenarios (e2e S9 / pages P3h) — all built here, nothing from outside the repository:
//   injectExif(jpeg, { orientation })  a JPEG with an EXIF segment right after SOI carrying a GPS position (and an orientation when given)
//   GPS_NEEDLE                         the 24 bytes of the latitude: if they are in a file, so is the location
//   bombPng(w, h)                      a tiny PNG that decodes to w×h pixels (1-bit, all zero) — a decompression bomb
import zlib from 'node:zlib';
import { once } from 'node:events';

const le16 = (n) => Buffer.from([n & 255, (n >> 8) & 255]);
const le32 = (n) => Buffer.from([n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255]);
const u32 = (n) => Buffer.from([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
const entry = (tag, type, count, value) => Buffer.concat([le16(tag), le16(type), le32(count), value]);
const rat = (a, b) => Buffer.concat([le32(a), le32(b)]);

const LAT = Buffer.concat([rat(37, 1), rat(33, 1), rat(5999, 100)]);
const LON = Buffer.concat([rat(126, 1), rat(58, 1), rat(40, 1)]);
export const GPS_NEEDLE = LAT;

/** The APP1 payload ("Exif\0\0" + TIFF) with a GPS block and, if `orientation` is given, the orientation tag. */
function exifPayload(orientation) {
  const n0 = orientation ? 2 : 1;
  const ifd0Len = 2 + n0 * 12 + 4;
  const gpsOff = 8 + ifd0Len;
  const gpsLen = 2 + 4 * 12 + 4;
  const latOff = gpsOff + gpsLen;
  const ifd0 = Buffer.concat([le16(n0), orientation ? entry(0x0112, 3, 1, Buffer.concat([le16(orientation), Buffer.alloc(2)])) : Buffer.alloc(0), entry(0x8825, 4, 1, le32(gpsOff)), le32(0)]);
  const gps = Buffer.concat([le16(4), entry(1, 2, 2, Buffer.from('N\0\0\0', 'latin1')), entry(2, 5, 3, le32(latOff)), entry(3, 2, 2, Buffer.from('E\0\0\0', 'latin1')), entry(4, 5, 3, le32(latOff + 24)), le32(0)]);
  return Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), Buffer.from('II', 'latin1'), le16(42), le32(8), ifd0, gps, LAT, LON]);
}

export function injectExif(jpeg, { orientation } = {}) {
  const payload = exifPayload(orientation);
  const len = Buffer.from([(payload.length + 2) >> 8, (payload.length + 2) & 255]);
  return Buffer.concat([jpeg.subarray(0, 2), Buffer.from([0xff, 0xe1]), len, payload, jpeg.subarray(2)]);
}

const crcChunk = (type, data) => {
  const t = Buffer.from(type, 'latin1');
  return Buffer.concat([u32(data.length), t, data, u32(zlib.crc32(Buffer.concat([t, data])))]);
};

/** A w×h 1-bit grayscale PNG of zeros (deflates ~1000:1), streamed so gigabytes of raw rows never sit in memory. */
export async function bombPng(w, h) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.concat([u32(w), u32(h), Buffer.from([1, 0, 0, 0, 0])]);
  const d = zlib.createDeflate({ level: 9 });
  const parts = [];
  d.on('data', (c) => parts.push(c));
  const done = once(d, 'end');
  const zeros = Buffer.alloc(1 << 20);
  let left = (1 + Math.ceil(w / 8)) * h;
  while (left > 0) {
    const n = Math.min(left, zeros.length);
    if (!d.write(n === zeros.length ? zeros : zeros.subarray(0, n))) await once(d, 'drain');
    left -= n;
  }
  d.end();
  await done;
  return Buffer.concat([sig, crcChunk('IHDR', ihdr), crcChunk('IDAT', Buffer.concat(parts)), crcChunk('IEND', Buffer.alloc(0))]);
}
