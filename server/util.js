// Small helpers: ids/hashes, text cleaning and validation.
import crypto from 'node:crypto';
import { bad, notFound } from './http.js';
import { LIMITS } from './constants.js';

export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
export const randomToken = (n = 32) => crypto.randomBytes(n).toString('base64url');
export const randomHex = (n = 16) => crypto.randomBytes(n).toString('hex');
export const now = () => Date.now();

export function cpLen(s) {
  let n = 0;
  // eslint-disable-next-line no-unused-vars
  for (const _ of s) n++;
  return n;
}

/** Single-line text: control chars -> space, collapsed, trimmed. */
export function cleanLine(s) {
  return String(s).replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim();
}
/** Multi-line text: normalise newlines, drop control chars (keep \n and \t), trim ends. */
export function cleanBlock(s) {
  return String(s)
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u2028\u2029]/g, '')
    .trim();
}

export function needLine(v, label, min, max) {
  if (typeof v !== 'string') throw bad('bad_request', `${label}을(를) 입력해 주세요.`);
  const s = cleanLine(v);
  const n = cpLen(s);
  if (n < min) throw bad('bad_request', `${label}을(를) 입력해 주세요.`);
  if (n > max) throw bad('too_long', `${label}은(는) ${max}자 이하로 써 주세요.`);
  return s;
}
export function optLine(v, label, max) {
  if (v == null) return '';
  if (typeof v !== 'string') throw bad('bad_request', `${label} 형식이 올바르지 않아요.`);
  const s = cleanLine(v);
  if (cpLen(s) > max) throw bad('too_long', `${label}은(는) ${max}자 이하로 써 주세요.`);
  return s;
}
export function optBlock(v, label, max) {
  if (v == null) return '';
  if (typeof v !== 'string') throw bad('bad_request', `${label} 형식이 올바르지 않아요.`);
  const s = cleanBlock(v);
  if (cpLen(s) > max) throw bad('too_long', `${label}은(는) ${max}자 이하로 써 주세요.`);
  return s;
}

export function oneOf(v, list, label) {
  if (!list.includes(v)) throw bad('bad_request', `${label} 값이 올바르지 않아요.`);
  return v;
}

export function toId(v) {
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n < 1) throw notFound();
  return n;
}
/** For ids inside request bodies (400 instead of 404). */
export function bodyId(v, label = 'id') {
  const n = Number(v);
  if (v == null || typeof v === 'boolean' || !Number.isSafeInteger(n) || n < 1) throw bad('bad_request', `${label} 값이 올바르지 않아요.`);
  return n;
}

export function finite(v, label, lo, hi) {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw bad('bad_request', `${label} 값이 올바르지 않아요.`);
  return Math.min(hi, Math.max(lo, v));
}

/** http(s) URL only; returns the normalised href. */
export function normalizeUrl(v) {
  if (typeof v !== 'string') throw bad('bad_url', '주소가 올바르지 않아요.');
  const s = v.trim();
  if (!s || s.length > LIMITS.url || /[\u0000- ]/.test(s)) throw bad('bad_url', '주소가 올바르지 않아요.');
  let u;
  try { u = new URL(s); } catch { throw bad('bad_url', '주소가 올바르지 않아요.'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw bad('bad_url', 'http 또는 https 주소만 쓸 수 있어요.');
  return u.href;
}

export function uploadUrl(id, name) {
  return `/uploads/${id}/${encodeURIComponent(name)}`;
}

export function sniffImage(buf) {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 && buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 6 && buf.toString('latin1', 0, 6).match(/^GIF8[79]a$/)) return 'image/gif';
  if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}
