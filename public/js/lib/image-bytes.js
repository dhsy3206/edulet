// Byte-level helpers for the offline export (pure — no DOM, runs in node:test):
//   readImageInfo(bytes)       size of a PNG / JPEG / GIF / WebP from its HEADER, before anything decodes it (decompression bombs),
//                              plus "animated" and, for JPEG, the EXIF orientation
//   stripJpegMetadata(bytes)   the same JPEG without EXIF/XMP/IPTC/comments (GPS!) — pixels untouched; the orientation tag is kept
//   stripPngMetadata(bytes)    the same PNG without text / EXIF / time chunks
//   planImage(bytes, opts)     what the loader should do with a picture (skip it, re-encode it, or take the cleaned original)
// Everything here only reads lengths and markers it can bound-check; a file that does not parse comes back as null — never as a guess.

export const MB = 1024 * 1024;
/** More pixels than this are not embedded (a 40-megapixel picture is a 160 MB bitmap once decoded; bombs are tiny files that decode to gigabytes). */
export const MAX_PIXELS = 40e6;
/** A file this small and already within the size limit is not re-encoded in the default mode (only cleaned). */
export const KEEP_AS_IS = 200 * 1024;
/** When a picture cannot be decoded, its (cleaned) bytes are embedded anyway only up to this size. */
export const FALLBACK_MAX = 1 * MB;

const u16be = (b, i) => (b[i] << 8) | b[i + 1];
const u16le = (b, i) => b[i] | (b[i + 1] << 8);
const u32be = (b, i) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
const u32le = (b, i) => (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0;
const tag4 = (b, i) => String.fromCharCode(b[i], b[i + 1], b[i + 2], b[i + 3]);
const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const isPng = (b) => b.length >= 8 && PNG_SIG.every((v, i) => b[i] === v);
const isJpeg = (b) => b.length >= 4 && b[0] === 0xff && b[1] === 0xd8;
const isGif = (b) => b.length >= 10 && tag4(b, 0) === 'GIF8' && (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61;
const isWebp = (b) => b.length >= 16 && tag4(b, 0) === 'RIFF' && tag4(b, 8) === 'WEBP';

/* ───────── EXIF orientation (TIFF inside an APP1 "Exif" segment) ───────── */
function exifOrientation(b, start, end) {
  // start = first byte after the "Exif\0\0" signature = the TIFF header
  if (end - start < 14) return undefined;
  const le = b[start] === 0x49 && b[start + 1] === 0x49;
  if (!le && !(b[start] === 0x4d && b[start + 1] === 0x4d)) return undefined;
  const r16 = (i) => (le ? u16le(b, i) : u16be(b, i));
  const r32 = (i) => (le ? u32le(b, i) : u32be(b, i));
  if (r16(start + 2) !== 42) return undefined;
  const ifd = start + r32(start + 4);
  if (ifd < start || ifd + 2 > end) return undefined;
  const n = r16(ifd);
  for (let k = 0; k < n && k < 64; k++) {
    const e = ifd + 2 + k * 12;
    if (e + 12 > end) return undefined;
    if (r16(e) === 0x0112 && r16(e + 2) === 3) {
      const v = r16(e + 8);
      return v >= 1 && v <= 8 ? v : undefined;
    }
  }
  return undefined;
}

/* ───────── readImageInfo ───────── */
function pngInfo(b) {
  if (b.length < 24 || u32be(b, 8) !== 13 || tag4(b, 12) !== 'IHDR') return null;
  const width = u32be(b, 16);
  const height = u32be(b, 20);
  if (!width || !height) return null;
  let animated = false;
  let pos = 8;
  for (let n = 0; n < 64 && pos + 8 <= b.length; n++) {
    const len = u32be(b, pos);
    const type = tag4(b, pos + 4);
    if (type === 'acTL') animated = true;
    if (type === 'IDAT' || type === 'IEND') break;
    pos += 12 + len;
  }
  return { type: 'png', width, height, animated };
}

function jpegInfo(b) {
  let pos = 2;
  let orientation;
  for (let n = 0; n < 256; n++) {
    if (pos + 4 > b.length || b[pos] !== 0xff) return null;
    while (b[pos + 1] === 0xff && pos + 2 < b.length) pos++;
    const marker = b[pos + 1];
    if (marker === 0xd9 || marker === 0xda) return null; // the image or its data begins and no frame header came first
    if (marker === 0x01 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) {
      pos += 2;
      continue;
    }
    const len = u16be(b, pos + 2);
    if (len < 2) return null;
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      if (len < 8 || pos + 9 > b.length) return null;
      const height = u16be(b, pos + 5);
      const width = u16be(b, pos + 7);
      if (!width || !height) return null;
      return { type: 'jpeg', width, height, animated: false, orientation };
    }
    if (marker === 0xe1 && len >= 8 && orientation === undefined && b[pos + 4] === 0x45 && tag4(b, pos + 4) === 'Exif' && b[pos + 8] === 0 && b[pos + 9] === 0) {
      orientation = exifOrientation(b, pos + 10, Math.min(b.length, pos + 2 + len));
    }
    pos += 2 + len;
  }
  return null;
}

function webpInfo(b) {
  const kind = tag4(b, 12);
  let width;
  let height;
  let animated = false;
  let hasMeta = false;
  if (kind === 'VP8X') {
    if (b.length < 30) return null;
    animated = (b[20] & 0x02) !== 0;
    hasMeta = (b[20] & 0x0c) !== 0; // 0x08 EXIF, 0x04 XMP
    width = 1 + (b[24] | (b[25] << 8) | (b[26] << 16));
    height = 1 + (b[27] | (b[28] << 8) | (b[29] << 16));
  } else if (kind === 'VP8 ') {
    if (b.length < 30 || b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
    width = u16le(b, 26) & 0x3fff;
    height = u16le(b, 28) & 0x3fff;
  } else if (kind === 'VP8L') {
    if (b.length < 25 || b[20] !== 0x2f) return null;
    width = 1 + (b[21] | ((b[22] & 0x3f) << 8));
    height = 1 + ((b[22] >> 6) | (b[23] << 2) | ((b[24] & 0x0f) << 10));
  } else return null;
  if (!width || !height) return null;
  return { type: 'webp', width, height, animated, hasMeta };
}

/** → { type, width, height, animated, orientation?, hasMeta? } for a recognisable picture header, else null (also for a truncated or inconsistent one). */
export function readImageInfo(bytes) {
  const b = bytes;
  if (!b || b.length < 10) return null;
  try {
    if (isPng(b)) return pngInfo(b);
    if (isJpeg(b)) return jpegInfo(b);
    if (isGif(b)) {
      const width = u16le(b, 6);
      const height = u16le(b, 8);
      return width && height ? { type: 'gif', width, height, animated: false } : null;
    }
    if (isWebp(b)) return webpInfo(b);
  } catch {
    return null;
  }
  return null;
}

/* ───────── JPEG: cut the metadata out, keep the picture ───────── */
// kept: APP0 (JFIF), APP2 only when it is an ICC colour profile, APP14 (Adobe colour transform) and every non-APP/COM segment.
// dropped: APP1 (EXIF, XMP — where GPS lives), APP3–APP13 (IPTC/Photoshop …), APP15, COM, anything after the EOI marker.
function keepJpegSegment(marker, seg) {
  if (marker === 0xe0 || marker === 0xee) return true;
  if (marker === 0xe2) return seg.length > 16 && tag4(seg, 4) === 'ICC_' && tag4(seg, 8) === 'PROF';
  if (marker >= 0xe1 && marker <= 0xef) return false;
  return marker !== 0xfe;
}

// a minimal EXIF segment that carries only the orientation, so a rotated photo still shows upright after the rest is cut away
function orientationSegment(o) {
  const t = [0x4d, 0x4d, 0, 42, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, o, 0, 0, 0, 0, 0, 0];
  const payload = [0x45, 0x78, 0x69, 0x66, 0, 0, ...t];
  const len = payload.length + 2;
  return Uint8Array.from([0xff, 0xe1, len >> 8, len & 255, ...payload]);
}

/** → the cleaned JPEG as a new Uint8Array, or null when the file does not parse completely (then nobody should embed it as is). */
export function stripJpegMetadata(bytes) {
  const b = bytes;
  if (!isJpeg(b)) return null;
  const info = readImageInfo(b);
  if (!info) return null;
  const out = [b.subarray(0, 2)];
  let insertAt = 1; // after SOI (and after APP0 once seen)
  let pos = 2;
  let ended = false;
  for (let n = 0; n < 4096 && !ended; n++) {
    if (pos + 2 > b.length || b[pos] !== 0xff) return null;
    while (b[pos + 1] === 0xff && pos + 2 < b.length) pos++;
    const marker = b[pos + 1];
    if (marker === 0xd9) {
      out.push(b.subarray(pos, pos + 2));
      ended = true;
      break;
    }
    if (marker === 0x01 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) {
      out.push(b.subarray(pos, pos + 2));
      pos += 2;
      continue;
    }
    if (pos + 4 > b.length) return null;
    const len = u16be(b, pos + 2);
    if (len < 2 || pos + 2 + len > b.length) return null;
    const seg = b.subarray(pos, pos + 2 + len);
    if (keepJpegSegment(marker, seg)) {
      out.push(seg);
      if (marker === 0xe0 && insertAt === 1) insertAt = out.length;
    }
    pos += 2 + len;
    if (marker === 0xda) {
      // entropy-coded data: runs to the next marker that is not a stuffed 0xFF00 or a restart marker
      let s = pos;
      let at = -1;
      while (s < b.length) {
        const i = b.indexOf(0xff, s);
        if (i < 0 || i + 1 >= b.length) return null;
        const m = b[i + 1];
        if (m === 0x00 || (m >= 0xd0 && m <= 0xd7)) s = i + 2;
        else if (m === 0xff) s = i + 1;
        else {
          at = i;
          break;
        }
      }
      if (at < 0) return null;
      out.push(b.subarray(pos, at));
      pos = at;
    }
  }
  if (!ended) return null;
  if (info.orientation && info.orientation > 1) out.splice(insertAt, 0, orientationSegment(info.orientation));
  const total = out.reduce((n, p) => n + p.length, 0);
  const res = new Uint8Array(total);
  let o = 0;
  for (const p of out) {
    res.set(p, o);
    o += p.length;
  }
  const check = readImageInfo(res);
  if (!check || check.width !== info.width || check.height !== info.height || (check.orientation || 1) !== (info.orientation || 1)) return null;
  return res;
}

/* ───────── PNG: drop text / EXIF / time chunks ───────── */
const PNG_DROP = new Set(['tEXt', 'zTXt', 'iTXt', 'eXIf', 'tIME']);
export function stripPngMetadata(bytes) {
  const b = bytes;
  if (!isPng(b) || !pngInfo(b)) return null;
  const out = [b.subarray(0, 8)];
  let pos = 8;
  let ended = false;
  for (let n = 0; n < 100000 && pos + 12 <= b.length; n++) {
    const len = u32be(b, pos);
    const end = pos + 12 + len;
    if (end > b.length) return null;
    const type = tag4(b, pos + 4);
    if (!PNG_DROP.has(type)) out.push(b.subarray(pos, end));
    pos = end;
    if (type === 'IEND') {
      ended = true;
      break;
    }
  }
  if (!ended) return null;
  const res = new Uint8Array(out.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of out) {
    res.set(p, o);
    o += p.length;
  }
  return res;
}

/**
 * Decide what to do with one picture (before anything is decoded).
 *   opts.max   long side in px after shrinking; 0 = keep the original bytes (the "원본 크기" option)
 * → { skip: 'too_large' | 'undecodable' }                       do not embed it
 *   { info, canvas: boolean, clean: Uint8Array|null }           canvas: re-encode through a canvas (drops every kind of metadata, bakes the
 *                                                               rotation, flattens an animation); clean: the original with its metadata cut
 *                                                               out — what to embed when no re-encoding is needed, and the only fallback when
 *                                                               decoding fails (null = there is no safe fallback)
 */
export function planImage(bytes, { max = 0 } = {}) {
  const info = readImageInfo(bytes);
  if (!info) return { skip: 'undecodable' };
  if (info.width * info.height > MAX_PIXELS) return { skip: 'too_large' };
  if (!max) return { info, canvas: false, clean: bytes, original: true };
  let clean = null;
  if (info.type === 'jpeg') clean = stripJpegMetadata(bytes);
  else if (info.type === 'png') clean = stripPngMetadata(bytes);
  else if (info.type === 'webp') clean = info.hasMeta ? null : bytes;
  else clean = bytes; // GIF stays as it is (animation); the option text says so
  if (info.type === 'gif') return { info, canvas: false, clean };
  const scale = Math.min(1, max / Math.max(info.width, info.height));
  const canvas = scale < 1 || !!info.animated || (info.type === 'webp' && !!info.hasMeta) || !clean || bytes.length > KEEP_AS_IS;
  return { info, canvas, clean, scale };
}
