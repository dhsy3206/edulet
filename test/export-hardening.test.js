// Hardening of the offline HTML export after the adversarial review: linear-time link trimming (live board + export), a build that gives the
// page back and can be cancelled, a cap on the text, picture headers read before anything is decoded (bombs), metadata (GPS!) cut out of
// pictures, a loader pool where one bad file does not sink the rest, and the demo's seed uploads. Pure code only — the browser parts of the
// same behaviour are in e2e S9 / pages P3h.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import {
  EXPORT_LIMITS, ExportTooLargeError, MB, buildOfflineHtml, buildOfflineParts, buildOfflinePartsAsync, collectUploadRefs, estimateTextBytes,
  trimUrl as exportTrim, renderRichHtml,
} from '../public/js/lib/export-html.js';
import { trimUrl as liveTrim } from '../public/js/lib/markdown.js';
import {
  FALLBACK_MAX, KEEP_AS_IS, MAX_PIXELS, planImage, readImageInfo, stripJpegMetadata, stripPngMetadata,
} from '../public/js/lib/image-bytes.js';
import { decodeSerial, exportErrorText, processImage, runPool } from '../public/js/lib/export-offline.js';

const NOW = Date.UTC(2026, 9, 22, 6, 30);
const HEX = (c) => String(c).repeat(32);
const post = (o = {}) => ({
  id: 1, boardId: 1, sectionId: null, author: { id: 7, username: null, displayName: '김하늘', avatarColor: '#2563eb', isGuest: false }, title: '', body: '',
  color: null, pinned: false, status: 'published', rank: 1, x: null, y: null, w: null, attachment: null, commentCount: 0, createdAt: NOW, updatedAt: NOW,
  reactions: {}, comments: [], ...o,
});
const exportOf = (posts, b = {}) => ({
  exportedAt: new Date(NOW).toISOString(), board: { id: 1, slug: 'x', title: '보드', description: '', format: 'wall', wallpaper: 'green', font: 'sans', colorScheme: 'light', settings: {}, owner: null, createdAt: NOW, ...b },
  sections: [], posts,
});
const ms = (fn) => {
  const t0 = performance.now();
  const r = fn();
  return [performance.now() - t0, r];
};

/* ───────── H1: link trimming is linear, and the two implementations agree ───────── */
// the rule as it was written before (quadratic), kept here as the reference
function refTrim(url) {
  let u = url;
  let tail = '';
  while (/[.,;:!?'")\]]$/.test(u)) {
    if (u.endsWith(')') && (u.match(/\(/g) || []).length >= (u.match(/\)/g) || []).length) break;
    tail = u.slice(-1) + tail;
    u = u.slice(0, -1);
  }
  return [u, tail];
}

describe('H1: trimUrl is linear and unchanged in meaning', () => {
  it('gives the same answer as the old rule on 20,000 random addresses (both implementations)', () => {
    let seed = 12345;
    const rnd = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296;
    const alphabet = ['a', 'b', '/', '.', ',', ';', ':', '!', '?', "'", '"', '(', ')', ')', ']', '-', '_', '=', '&'];
    for (let i = 0; i < 20000; i++) {
      let u = 'http://x';
      for (let k = 0, n = Math.floor(rnd() * 24); k < n; k++) u += alphabet[Math.floor(rnd() * alphabet.length)];
      const want = refTrim(u);
      assert.deepEqual(exportTrim(u), want, u);
      assert.deepEqual(liveTrim(u), want, u);
    }
  });

  it('trims a 100,000-character ")" tail in a few milliseconds', () => {
    const u = 'http://a' + ')'.repeat(100000);
    for (const trim of [exportTrim, liveTrim]) {
      const [t, r] = ms(() => trim(u));
      assert.deepEqual(r, ['http://a', ')'.repeat(100000)]);
      assert.ok(t < 100, `took ${t} ms`);
    }
  });

  it('30 posts whose 10,000-character body is a URL followed by ")" build in well under a second; so do 500 long comments', () => {
    const body = 'http://a' + ')'.repeat(9990);
    const [t1, h1] = ms(() => buildOfflineHtml({ data: exportOf(Array.from({ length: 30 }, (_, i) => post({ id: i, body }))), files: new Map(), now: NOW }));
    assert.ok(t1 < 400, `30 long bodies took ${t1} ms`);
    assert.ok(!h1.includes('<a href="http://a'), 'an address past 2048 characters is text, not a link');
    const cbody = 'http://a' + ')'.repeat(1990);
    const cs = Array.from({ length: 500 }, (_, i) => ({ id: i, postId: 1, author: { displayName: 'c' }, body: cbody, createdAt: NOW }));
    const [t2, h2] = ms(() => buildOfflineHtml({ data: exportOf([post({ comments: cs })]), files: new Map(), now: NOW }));
    assert.ok(t2 < 400, `500 long comments took ${t2} ms`);
    assert.ok(h2.includes('<a href="http://a" target="_blank"'), 'a 2000-character comment URL is still a link (its ")" tail is cut)');
  });

  it('an address longer than 2048 characters is not a link; one right at the limit still is', () => {
    const long = 'http://a/' + 'x'.repeat(2048);
    assert.ok(!renderRichHtml(long).includes('<a '));
    assert.ok(renderRichHtml(long).includes(long));
    const ok = 'http://a/' + 'x'.repeat(2048 - 9);
    assert.ok(renderRichHtml(ok).includes('<a '));
  });
});

/* ───────── H1b: the build gives the page back and can be cancelled ───────── */
describe('H1b: the async build', () => {
  const bigBoard = () => exportOf(Array.from({ length: 800 }, (_, i) => post({ id: i, title: 't' + i, body: 'lorem ipsum **bold** '.repeat(300) })));

  it('produces exactly what the synchronous build produces', async () => {
    const data = exportOf(Array.from({ length: 40 }, (_, i) => post({ id: i, title: 't' + i, body: 'x'.repeat(500) + ' http://a.com/' + i })));
    const a = await buildOfflinePartsAsync({ data, files: new Map(), now: NOW, options: { timeZone: 'UTC' } });
    const b = buildOfflineParts({ data, files: new Map(), now: NOW, options: { timeZone: 'UTC' } });
    assert.equal(a.join(''), b.join(''));
  });

  it('hands control back about every megabyte of cards and stops as soon as the signal aborts', async () => {
    let checks = 0;
    const signal = { get aborted() { checks++; return checks > 4; } }; // aborts at the 5th look
    await assert.rejects(buildOfflinePartsAsync({ data: bigBoard(), files: new Map(), now: NOW }, { signal }), (e) => e.name === 'AbortError');
    assert.equal(checks, 5, 'it looked once before every step — i.e. it did yield, several times, instead of running through');
  });

  it('an already-aborted signal does no work at all', async () => {
    const ac = new AbortController();
    ac.abort();
    await assert.rejects(buildOfflinePartsAsync({ data: bigBoard(), files: new Map(), now: NOW }, { signal: ac.signal }), (e) => e.name === 'AbortError');
  });
});

/* ───────── M2: too much text → a message and NO file ───────── */
describe('M2: a cap on the text of the page', () => {
  it('estimates from the JSON (titles, bodies, comments) and refuses before building', () => {
    const posts = Array.from({ length: 10 }, (_, i) => post({ id: i, body: 'x'.repeat(10000), comments: [{ id: 1, body: 'y'.repeat(2000), author: {} }] }));
    const data = exportOf(posts);
    assert.ok(estimateTextBytes(data) > 10 * 12000 && estimateTextBytes(data) < 10 * 20000);
    assert.throws(() => buildOfflineParts({ data, files: new Map(), now: NOW, options: { textBytes: 50000 } }), (e) => e instanceof ExportTooLargeError && /너무 많아/.test(e.message) && /나눠서/.test(e.message) && e.code === 'export_too_large');
    assert.doesNotThrow(() => buildOfflineParts({ data, files: new Map(), now: NOW, options: { textBytes: 5 * MB } }));
    assert.equal(EXPORT_LIMITS.textBytes, 100 * MB);
  });

  it('also checks the real size while writing (text that grows when escaped)', () => {
    // 4 cards of 3,000 "&" — estimated at ~4,500 characters each, written as 15,000 ("&amp;")
    const data = exportOf(Array.from({ length: 4 }, (_, i) => post({ id: i, body: '&'.repeat(3000) })));
    assert.ok(estimateTextBytes(data) < 24000);
    assert.throws(() => buildOfflineParts({ data, files: new Map(), now: NOW, options: { textBytes: 24000 } }), ExportTooLargeError);
  });
});

/* ───────── M1: picture headers (no decoding) ───────── */
const u16be = (n) => Buffer.from([n >> 8, n & 255]);
const u32be = (n) => Buffer.from([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
const u16le = (n) => Buffer.from([n & 255, n >> 8]);
const u32le = (n) => Buffer.from([n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255]);

const pngChunk = (type, data = Buffer.alloc(0)) => Buffer.concat([u32be(data.length), Buffer.from(type, 'latin1'), data, Buffer.alloc(4)]); // CRC is never read
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const ihdr = (w, h) => pngChunk('IHDR', Buffer.concat([u32be(w), u32be(h), Buffer.from([8, 2, 0, 0, 0])]));
const png = (w, h, extra = []) => Buffer.concat([PNG_SIG, ihdr(w, h), ...extra, pngChunk('IDAT', Buffer.from('data')), pngChunk('IEND')]);

const seg = (marker, payload) => Buffer.concat([Buffer.from([0xff, marker]), u16be(payload.length + 2), payload]);
const ascii = (s) => Buffer.from(s, 'latin1');
// a TIFF block with a GPS position (and, when asked, an orientation); returns { exif: APP1 payload, lat }
function exifWithGps(orientation) {
  const entry = (tag, type, count, value) => Buffer.concat([u16le(tag), u16le(type), u32le(count), value]);
  const n0 = orientation ? 2 : 1;
  const ifd0Len = 2 + n0 * 12 + 4;
  const gpsOff = 8 + ifd0Len;
  const gpsLen = 2 + 4 * 12 + 4;
  const latOff = gpsOff + gpsLen;
  const rat = (a, b) => Buffer.concat([u32le(a), u32le(b)]);
  const lat = Buffer.concat([rat(37, 1), rat(33, 1), rat(5999, 100)]);
  const lon = Buffer.concat([rat(126, 1), rat(58, 1), rat(40, 1)]);
  const ifd0 = Buffer.concat([u16le(n0), orientation ? entry(0x0112, 3, 1, Buffer.concat([u16le(orientation), Buffer.alloc(2)])) : Buffer.alloc(0), entry(0x8825, 4, 1, u32le(gpsOff)), u32le(0)]);
  const gps = Buffer.concat([u16le(4), entry(1, 2, 2, ascii('N\0\0\0')), entry(2, 5, 3, u32le(latOff)), entry(3, 2, 2, ascii('E\0\0\0')), entry(4, 5, 3, u32le(latOff + 24)), u32le(0)]);
  const tiff = Buffer.concat([ascii('II'), u16le(42), u32le(8), ifd0, gps, lat, lon]);
  return { exif: Buffer.concat([ascii('Exif\0\0'), tiff]), lat };
}
// a JPEG built from markers only (the parsers read lengths and markers, never the entropy data): every kind of metadata, restart markers,
// a stuffed 0xFF00, fill bytes, and a trailing blob after EOI that hides a second GPS copy (the way multi-picture files do)
function jpeg({ w = 900, h = 600, orientation, pad = 0, meta = true } = {}) {
  const g = exifWithGps(orientation);
  const sof = Buffer.concat([Buffer.from([8]), u16be(h), u16be(w), Buffer.from([1, 1, 0x11, 0])]);
  const entropy = Buffer.concat([Buffer.from([0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56, 0xff, 0xff, 0x00, 0x78]), Buffer.alloc(pad, 0x55)]);
  const parts = [
    Buffer.from([0xff, 0xd8]),
    seg(0xe0, Buffer.concat([ascii('JFIF\0'), Buffer.from([1, 1, 0, 0, 1, 0, 1, 0, 0])])),
    ...(meta ? [
      seg(0xe1, g.exif),
      seg(0xe1, Buffer.concat([ascii('http://ns.adobe.com/xap/1.0/\0'), ascii('<x:xmpmeta>GPSLatitude</x:xmpmeta>')])),
      seg(0xe2, Buffer.concat([ascii('MPF\0'), Buffer.alloc(30)])),
      seg(0xed, Buffer.concat([ascii('Photoshop 3.0\0'), ascii('8BIM IPTC caption')])),
      seg(0xfe, ascii('secret comment')),
    ] : []),
    seg(0xe2, Buffer.concat([ascii('ICC_PROFILE\0'), Buffer.from([1, 1]), Buffer.alloc(40, 7)])),
    seg(0xee, Buffer.concat([ascii('Adobe'), Buffer.alloc(7)])),
    seg(0xdb, Buffer.concat([Buffer.from([0]), Buffer.alloc(64, 16)])),
    seg(0xc0, sof),
    seg(0xc4, Buffer.concat([Buffer.from([0]), Buffer.alloc(16), Buffer.from([0])])),
    seg(0xda, Buffer.from([1, 1, 0, 0, 63, 0])),
    entropy,
    Buffer.from([0xff, 0xd9]),
    ...(meta ? [ascii('TRAILER-'), g.exif] : []),
  ];
  return { bytes: Buffer.concat(parts), lat: g.lat };
}
const has = (hay, needle) => Buffer.from(hay).includes(needle);

const riff = (fourcc, payload) => {
  const chunk = Buffer.concat([ascii(fourcc), u32le(payload.length), payload, payload.length & 1 ? Buffer.alloc(1) : Buffer.alloc(0)]);
  return Buffer.concat([ascii('RIFF'), u32le(chunk.length + 4), ascii('WEBP'), chunk]);
};
const webpLossy = (w, h) => riff('VP8 ', Buffer.concat([Buffer.from([0x30, 0x01, 0x00, 0x9d, 0x01, 0x2a]), u16le(w), u16le(h), Buffer.alloc(8)]));
const webpLossless = (w, h) => riff('VP8L', Buffer.concat([Buffer.from([0x2f]), u32le((w - 1) | ((h - 1) << 14)), Buffer.alloc(8)]));
const webpExt = (w, h, flags) => riff('VP8X', Buffer.concat([Buffer.from([flags, 0, 0, 0]), Buffer.from([(w - 1) & 255, ((w - 1) >> 8) & 255, ((w - 1) >> 16) & 255]), Buffer.from([(h - 1) & 255, ((h - 1) >> 8) & 255, ((h - 1) >> 16) & 255]), Buffer.alloc(8)]));
const gif = (w, h, v = '89a') => Buffer.concat([ascii('GIF' + v), u16le(w), u16le(h), Buffer.alloc(8)]);

describe('M1: readImageInfo reads the size from the header only', () => {
  it('PNG (with the animation flag), JPEG (with the EXIF orientation), GIF and the three WebP kinds', () => {
    assert.deepEqual(readImageInfo(png(640, 480)), { type: 'png', width: 640, height: 480, animated: false });
    assert.equal(readImageInfo(png(640, 480, [pngChunk('acTL', Buffer.alloc(8))])).animated, true);
    assert.deepEqual(readImageInfo(jpeg({ w: 900, h: 600 }).bytes), { type: 'jpeg', width: 900, height: 600, animated: false, orientation: undefined });
    assert.equal(readImageInfo(jpeg({ orientation: 6 }).bytes).orientation, 6);
    assert.deepEqual(readImageInfo(gif(320, 200)), { type: 'gif', width: 320, height: 200, animated: false });
    assert.deepEqual(readImageInfo(gif(5, 7, '87a')), { type: 'gif', width: 5, height: 7, animated: false });
    assert.deepEqual(readImageInfo(webpLossy(1234, 567)), { type: 'webp', width: 1234, height: 567, animated: false, hasMeta: false });
    assert.deepEqual(readImageInfo(webpLossless(1234, 567)), { type: 'webp', width: 1234, height: 567, animated: false, hasMeta: false });
    assert.deepEqual(readImageInfo(webpExt(40000, 3000, 0x0a)), { type: 'webp', width: 40000, height: 3000, animated: true, hasMeta: true });
  });

  it('truncated, inconsistent and false headers come back as null — never as a guess', () => {
    const p = png(100, 100);
    const j = jpeg().bytes;
    for (const cut of [0, 5, 9, 16, 23]) assert.equal(readImageInfo(p.subarray(0, cut)), null, 'png cut at ' + cut);
    for (const cut of [0, 3, 9, 20, 60]) assert.equal(readImageInfo(j.subarray(0, cut)), null, 'jpeg cut at ' + cut);
    assert.equal(readImageInfo(gif(10, 10).subarray(0, 9)), null);
    assert.equal(readImageInfo(webpLossy(10, 10).subarray(0, 25)), null);
    assert.equal(readImageInfo(png(0, 50)), null, 'zero width');
    assert.equal(readImageInfo(png(50, 0)), null);
    const badIhdr = Buffer.from(p);
    badIhdr.write('IHDX', 12, 'latin1');
    assert.equal(readImageInfo(badIhdr), null, 'IHDR tag wrong');
    const badLen = Buffer.from(p);
    badLen.writeUInt32BE(12, 8);
    assert.equal(readImageInfo(badLen), null, 'IHDR length wrong');
    assert.equal(readImageInfo(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xda, 0, 4, 0, 0])])), null, 'a scan before any frame header');
    assert.equal(readImageInfo(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="9999999" height="9999999"/>')), null, 'SVG is no picture here');
    assert.equal(readImageInfo(Buffer.from('GIF89a')), null);
    assert.equal(readImageInfo(Buffer.alloc(100)), null);
    assert.equal(readImageInfo(null), null);
    assert.equal(readImageInfo(new Uint8Array(0)), null);
    const fakeWebp = Buffer.from(webpLossy(10, 10));
    fakeWebp[23] = 0x00; // start code broken
    assert.equal(readImageInfo(fakeWebp), null);
  });

  it('a bomb PNG (a tiny file that decodes to gigabytes) is skipped from its header alone; 40 megapixels is the line', () => {
    const bomb = png(30000, 30000);
    assert.ok(bomb.length < 200);
    assert.deepEqual(planImage(bomb, { max: 1600 }), { skip: 'too_large' });
    assert.deepEqual(planImage(bomb, { max: 0 }), { skip: 'too_large' }, 'also with the original-size option: the reader\'s browser would choke on it');
    assert.deepEqual(planImage(webpExt(20000, 20000, 0), { max: 1600 }), { skip: 'too_large' });
    assert.deepEqual(planImage(gif(65535, 65535), { max: 1600 }), { skip: 'too_large' });
    assert.deepEqual(planImage(jpeg({ w: 30000, h: 30000 }).bytes, { max: 1600 }), { skip: 'too_large' });
    assert.equal(MAX_PIXELS, 40e6);
    assert.ok(!planImage(png(6324, 6324), { max: 1600 }).skip, '39.99 MP is allowed');
    assert.equal(planImage(png(6400, 6400), { max: 1600 }).skip, 'too_large');
    assert.deepEqual(planImage(Buffer.from('not a picture at all'), { max: 1600 }), { skip: 'undecodable' });
  });
});

describe('L1: metadata (GPS) never stays in a picture in the default mode', () => {
  it('stripJpegMetadata cuts EXIF, XMP, IPTC, MPF, comments and anything after the end — and keeps JFIF, the ICC profile, Adobe, the tables and the pixels', () => {
    const { bytes, lat } = jpeg({ pad: 5000 });
    assert.ok(has(bytes, lat) && has(bytes, ascii('GPSLatitude')) && has(bytes, ascii('secret comment')));
    const out = stripJpegMetadata(bytes);
    assert.ok(out && out.length < bytes.length);
    for (const bad of [lat, ascii('Exif'), ascii('GPSLatitude'), ascii('secret comment'), ascii('Photoshop'), ascii('MPF'), ascii('TRAILER-'), ascii('xmpmeta')]) assert.ok(!has(out, bad), String(bad));
    for (const good of [ascii('JFIF'), ascii('ICC_PROFILE'), ascii('Adobe')]) assert.ok(has(out, good), String(good));
    assert.deepEqual([out[0], out[1], out[out.length - 2], out[out.length - 1]], [0xff, 0xd8, 0xff, 0xd9]);
    assert.ok(has(out, Buffer.alloc(5000, 0x55)), 'the entropy data is untouched');
    assert.ok(has(out, Buffer.from([0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56, 0xff, 0xff, 0x00, 0x78])), 'stuffed bytes, restart marker and fill bytes survive');
    const info = readImageInfo(out);
    assert.deepEqual([info.width, info.height], [900, 600]);
  });

  it('keeps the rotation of a rotated photo (only the orientation tag stays, nothing else of the EXIF)', () => {
    for (const o of [2, 3, 6, 8]) {
      const { bytes, lat } = jpeg({ orientation: o });
      const out = stripJpegMetadata(bytes);
      assert.equal(readImageInfo(out).orientation, o);
      assert.ok(!has(out, lat), 'no GPS');
      assert.ok(out.length < bytes.length);
    }
    assert.equal(readImageInfo(stripJpegMetadata(jpeg({ orientation: 1 }).bytes)).orientation, undefined, 'upright photos need no EXIF at all');
    assert.ok(!has(stripJpegMetadata(jpeg({ orientation: 1 }).bytes), ascii('Exif')));
  });

  it('refuses a JPEG that does not parse completely (nobody may embed it as it is)', () => {
    const { bytes } = jpeg({ pad: 100 });
    const plain = jpeg({ pad: 100, meta: false }).bytes;
    assert.equal(stripJpegMetadata(plain.subarray(0, plain.length - 2)), null, 'no EOI');
    assert.ok(stripJpegMetadata(plain), 'the intact one is fine');
    assert.equal(stripJpegMetadata(bytes.subarray(0, 300)), null);
    const cutInEntropy = bytes.subarray(0, bytes.indexOf(Buffer.from([0xff, 0xd9])) - 20);
    assert.equal(stripJpegMetadata(cutInEntropy), null);
    const longSeg = Buffer.from(bytes);
    longSeg.writeUInt16BE(60000, 4); // the first segment claims to be longer than the file
    assert.equal(stripJpegMetadata(longSeg), null);
    assert.equal(stripJpegMetadata(Buffer.from('not a jpeg')), null);
    assert.equal(stripJpegMetadata(png(10, 10)), null);
  });

  it('stripPngMetadata drops text, EXIF and time chunks and keeps the rest', () => {
    const p = png(64, 64, [pngChunk('tEXt', ascii('GPS\0 37.5N')), pngChunk('iTXt', ascii('XML:com.adobe.xmp\0GPSLatitude')), pngChunk('eXIf', exifWithGps().exif), pngChunk('tIME', Buffer.alloc(7)), pngChunk('gAMA', Buffer.alloc(4)), pngChunk('acTL', Buffer.alloc(8))]);
    const out = stripPngMetadata(p);
    for (const bad of ['tEXt', 'iTXt', 'eXIf', 'tIME', 'GPSLatitude', 'Exif']) assert.ok(!has(out, ascii(bad)), bad);
    for (const good of ['IHDR', 'gAMA', 'acTL', 'IDAT', 'IEND']) assert.ok(has(out, ascii(good)), good);
    assert.deepEqual(readImageInfo(out), { type: 'png', width: 64, height: 64, animated: true });
    assert.equal(stripPngMetadata(p.subarray(0, p.length - 5)), null, 'truncated');
  });
});

describe('M1/L1: planImage decides before anything is decoded', () => {
  it('default mode: a small JPEG is only cleaned; a big or oversized or rotated-and-big one goes through a canvas; GIF stays', () => {
    const small = jpeg({ pad: 1000 }).bytes;
    const p1 = planImage(small, { max: 1600 });
    assert.equal(p1.canvas, false);
    assert.ok(p1.clean && !has(p1.clean, jpeg().lat));
    assert.equal(planImage(jpeg({ pad: KEEP_AS_IS + 10 }).bytes, { max: 1600 }).canvas, true, 'bigger than 200 KB: try to re-encode it smaller');
    const wide = planImage(jpeg({ w: 4000, h: 3000, pad: 100 }).bytes, { max: 1600 });
    assert.equal(wide.canvas, true);
    assert.ok(wide.scale < 1);
    const g = gif(100, 100);
    assert.deepEqual([planImage(g, { max: 1600 }).canvas, planImage(g, { max: 1600 }).clean === g], [false, true]);
  });

  it('animated PNG/WebP are flattened by the canvas; a WebP with EXIF/XMP has no safe fallback; the original-size option changes nothing', () => {
    assert.equal(planImage(png(100, 100, [pngChunk('acTL', Buffer.alloc(8))]), { max: 1600 }).canvas, true);
    assert.equal(planImage(webpExt(100, 100, 0x02), { max: 1600 }).canvas, true);
    const meta = planImage(webpExt(100, 100, 0x08), { max: 1600 });
    assert.deepEqual([meta.canvas, meta.clean], [true, null]);
    const orig = planImage(jpeg().bytes, { max: 0 });
    assert.equal(orig.original, true);
    assert.equal(orig.canvas, false);
  });

  it('a PNG without anything special and small is cleaned, not re-encoded', () => {
    const p = png(300, 200, [pngChunk('tEXt', ascii('Comment\0hi'))]);
    const plan = planImage(p, { max: 1600 });
    assert.equal(plan.canvas, false);
    assert.ok(!has(plan.clean, ascii('tEXt')));
  });
});

describe('M1: processImage without a canvas (what happens when decoding fails)', () => {
  // node has no createImageBitmap: every path that needs the canvas falls back, which is exactly the "undecodable" case
  const blobOf = (buf, type = 'image/jpeg') => new Blob([buf], { type });
  const bytesOf = async (b) => Buffer.from(await b.arrayBuffer());

  it('small JPEG: cleaned, no GPS, same size in pixels', async () => {
    const { bytes, lat } = jpeg({ pad: 2000 });
    const r = await processImage(blobOf(bytes), 1600);
    assert.ok(!r.skip && r.width === 900 && r.height === 600);
    assert.ok(!has(await bytesOf(r.blob), lat) && !has(await bytesOf(r.blob), ascii('Exif')));
    assert.equal(r.blob.type, 'image/jpeg');
  });

  it('a JPEG that would need re-encoding but cannot be decoded: cleaned bytes up to 1 MB, "undecodable" above — never the original with its GPS', async () => {
    assert.equal(FALLBACK_MAX, 1 * MB);
    const mid = jpeg({ pad: 300 * 1024 });
    const r1 = await processImage(blobOf(mid.bytes), 1600);
    assert.ok(!r1.skip, 'a 300 KB file is kept as its cleaned bytes');
    assert.ok(!has(await bytesOf(r1.blob), mid.lat));
    const huge = jpeg({ pad: 1200 * 1024 });
    assert.deepEqual(await processImage(blobOf(huge.bytes), 1600), { skip: 'undecodable' });
    const unparsable = Buffer.concat([jpeg({ pad: 10 }).bytes.subarray(0, 250), Buffer.alloc(100)]);
    assert.deepEqual(await processImage(blobOf(unparsable), 1600), { skip: 'undecodable' });
  });

  it('a bomb is skipped without being decoded; the original-size option keeps the original bytes (GPS included, as the option text says)', async () => {
    assert.deepEqual(await processImage(blobOf(png(30000, 30000), 'image/png'), 1600), { skip: 'too_large' });
    const { bytes, lat } = jpeg();
    const r = await processImage(blobOf(bytes), 0);
    assert.ok(has(await bytesOf(r.blob), lat));
  });

  it('an animated GIF is kept as it is', async () => {
    const g = gif(50, 50);
    const r = await processImage(blobOf(g, 'image/gif'), 1600);
    assert.deepEqual([r.width, r.height], [50, 50]);
    assert.ok((await bytesOf(r.blob)).equals(g));
  });
});

/* ───────── M3: the loader pool ───────── */
describe('M3: runPool', () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  it('runs every item, at most n at a time, in order of start', async () => {
    let live = 0;
    let peak = 0;
    const started = [];
    await runPool(Array.from({ length: 12 }, (_, i) => i), 3, async (i) => {
      started.push(i);
      live++;
      peak = Math.max(peak, live);
      await sleep(3);
      live--;
    });
    assert.deepEqual(started, Array.from({ length: 12 }, (_, i) => i));
    assert.equal(peak, 3);
  });

  it('after a fatal failure nothing new starts, the files in flight are waited for, and the first error is thrown', async () => {
    const started = [];
    let finished = 0;
    const boom = new Error('boom');
    await assert.rejects(runPool(Array.from({ length: 20 }, (_, i) => i), 3, async (i) => {
      started.push(i);
      await sleep(i === 4 ? 1 : 15);
      if (i === 4) throw boom;
      finished++;
    }), (e) => e === boom);
    assert.ok(started.length < 20, 'the rest never started: ' + started.length);
    assert.equal(finished, started.length - 1, 'every other worker that had started was allowed to finish before runPool returned');
  });

  it('an abort stops the pool at once', async () => {
    const ac = new AbortController();
    const started = [];
    const p = runPool(Array.from({ length: 30 }, (_, i) => i), 3, async (i) => {
      started.push(i);
      await sleep(10);
    }, ac.signal);
    setTimeout(() => ac.abort(), 15);
    await assert.rejects(p, (e) => e.name === 'AbortError');
    assert.ok(started.length < 30);
  });

  it('an empty list is fine', async () => {
    await runPool([], 3, async () => { throw new Error('never'); });
  });
});

describe('M1: only one picture is decoded at a time', () => {
  it('decodeSerial never lets two jobs overlap, runs them in order, and keeps going after a failure', async () => {
    let live = 0;
    let peak = 0;
    const order = [];
    const job = (i, fail) => decodeSerial(async () => {
      live++;
      peak = Math.max(peak, live);
      await new Promise((r) => setTimeout(r, 4));
      order.push(i);
      live--;
      if (fail) throw new Error('decode ' + i);
    });
    const results = await Promise.allSettled([job(0), job(1, true), job(2), job(3), job(4, true), job(5)]);
    assert.equal(peak, 1);
    assert.deepEqual(order, [0, 1, 2, 3, 4, 5]);
    assert.deepEqual(results.map((r) => r.status), ['fulfilled', 'rejected', 'fulfilled', 'fulfilled', 'rejected', 'fulfilled']);
  });
});

describe('M3: exportErrorText never shows an engine\'s English message', () => {
  it('Korean messages pass, everything else becomes the fallback, aborts are "취소했어요."', () => {
    assert.equal(exportErrorText(new TypeError("Cannot read properties of null (reading 'fillStyle')")), 'HTML 파일을 만들지 못했어요. 다시 시도해 주세요.');
    assert.equal(exportErrorText(new Error('Failed to fetch'), '다시 해 주세요'), '다시 해 주세요');
    assert.equal(exportErrorText(null), 'HTML 파일을 만들지 못했어요. 다시 시도해 주세요.');
    assert.equal(exportErrorText(new ExportTooLargeError(300 * MB, 100 * MB)).includes('너무 많아'), true);
    assert.equal(exportErrorText(new DOMException('x', 'AbortError')), '취소했어요.');
    const e = Object.assign(new Error('요청이 너무 많아요.'), { retryAfter: 7 });
    assert.equal(exportErrorText(e), '요청이 너무 많아요. (7초 뒤에 다시 할 수 있어요)');
  });
});

/* ───────── M5 / L3: the demo's seed uploads, unknown /uploads, file names ───────── */
describe('M5: seed uploads and unknown local addresses', () => {
  const PNG1 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

  it('/uploads/seed-<n>/… (the static demo) is fetched and embedded like a server upload', () => {
    const data = exportOf([post({ attachment: { kind: 'image', url: '/uploads/seed-3/pic.png', name: 'pic.png' } }), post({ id: 2, attachment: { kind: 'file', url: '/uploads/seed-4/doc.pdf', name: 'doc.pdf', mime: 'application/pdf', size: 3 } })]);
    const refs = collectUploadRefs(data);
    assert.deepEqual(refs.map((r) => [r.url, r.ok]), [['/uploads/seed-3/pic.png', true], ['/uploads/seed-4/doc.pdf', true]]);
    const html = buildOfflineHtml({ data, files: new Map([['/uploads/seed-3/pic.png', { mime: 'image/png', name: 'pic.png', size: 68, dataUrl: PNG1 }]]), now: NOW });
    assert.ok(html.includes('<img '));
    assert.ok(!html.includes('외부 그림'));
  });

  it('a name made only of dots (".", "..", "%2e%2e") is never fetched: the URL parser would fold it into /uploads/ itself', () => {
    for (const name of ['.', '..', '%2e', '%2E%2e', '%2e.']) {
      const refs = collectUploadRefs(exportOf([post({ attachment: { kind: 'image', url: `/uploads/${HEX('a')}/${name}`, name: 'n' } })]));
      assert.deepEqual(refs.map((r) => r.ok), [false], name);
    }
    for (const name of ['a..b.png', '.hidden', 'x%2e.png', '...jpg']) {
      const refs = collectUploadRefs(exportOf([post({ attachment: { kind: 'image', url: `/uploads/${HEX('a')}/${name}`, name: 'n' } })]));
      assert.deepEqual(refs.map((r) => r.ok), [true], name);
    }
  });

  it('an unknown /uploads/… shape is reported as "could not be loaded" (listed, named) — never called an external picture', () => {
    const data = exportOf([post({ attachment: { kind: 'image', url: '/uploads/not-an-id/x.png', name: 'x.png' } })]);
    const refs = collectUploadRefs(data);
    assert.deepEqual(refs.map((r) => [r.url, r.ok]), [['/uploads/not-an-id/x.png', false]]);
    // the loader reports it as failed (it never requests it)
    const html = buildOfflineHtml({ data, files: new Map([[refs[0].url, { name: refs[0].name, dataUrl: null, skipped: 'failed' }]]), now: NOW });
    assert.ok(html.includes('불러오지 못해 담지 못했어요: x.png'));
    assert.ok(!html.includes('외부 그림'));
    assert.ok(html.includes('<summary>담지 못한 파일 1개</summary>'));
    // and even without a report from the loader it is not called external
    assert.ok(!buildOfflineHtml({ data, files: new Map(), now: NOW }).includes('외부 그림'));
    // a really remote picture still is
    const remote = buildOfflineHtml({ data: exportOf([post({ attachment: { kind: 'image', url: 'https://evil.example/p.png' } })]), files: new Map(), now: NOW });
    assert.ok(remote.includes('외부 그림은 담지 않았어요'));
  });
});

describe('L3: invisible and bidi characters are removed from file names', () => {
  it('zero-width, bidi-control, BOM and Arabic-letter-mark characters vanish; path characters become "_"', () => {
    const inv = [0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2060, 0x2061, 0x2062, 0x2063, 0x2064, 0x2066, 0x2067, 0x2068, 0x2069, 0x061c, 0xfeff].map((c) => String.fromCharCode(c)).join('');
    const name = 'photo' + inv + 'gpj.exe';
    const url = '/uploads/' + HEX('a') + '/f';
    const data = exportOf([post({ attachment: { kind: 'file', url, name, mime: 'application/zip', size: 3 } })]);
    const html = buildOfflineHtml({ data, files: new Map([[url, { mime: 'application/zip', name, size: 3, dataUrl: 'data:application/octet-stream;base64,AAAA' }]]), now: NOW });
    assert.ok(html.includes('download="photogpj.exe"'), html.match(/download="[^"]*"/)?.[0]);
    for (const c of inv) assert.ok(!html.includes(c), 'U+' + c.charCodeAt(0).toString(16));
    assert.equal(collectUploadRefs(data)[0].name, 'photogpj.exe');
  });
});
