/* Edulet demo server — core helpers (service worker side, loaded with importScripts).
 * Constants, errors, text validation, ranks, crypto. Mirrors server/{constants,util,http,rank}.js so the demo
 * answers exactly like the Node server. Everything is exported on the shared namespace `self.EDU`. */
(function (E) {
  'use strict';

  /* ───────── constants (docs/CONTRACT.md §2) ───────── */
  const C = {
    FORMATS: ['wall', 'grid', 'stream', 'shelf', 'rows', 'canvas', 'backchannel'],
    SECTIONED: ['shelf', 'rows'],
    ROLES: ['read', 'comment', 'write', 'moderate', 'admin'],
    VISIBILITY: ['private', 'link'],
    LINK_ACCESS: ['read', 'comment', 'write', 'moderate'],
    REACTIONS: ['none', 'like', 'vote', 'star', 'grade', 'emoji'],
    EMOJIS: ['👍', '❤️', '😂', '😮', '😢', '🎉'],
    POST_COLORS: [null, 'red', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink'],
    FONTS: ['sans', 'serif', 'mono', 'rounded'],
    SCHEMES: ['light', 'dark'],
    WALLPAPERS: ['green', 'ocean', 'sunset', 'lavender', 'slate', 'paper', 'mint', 'rose', 'night', 'sunrise'],
    TEMPLATES: ['blank', 'kwl', 'retro', 'training'],
    ATTACH_KINDS: ['image', 'file', 'link', 'video'],
    IMAGE_MIMES: ['image/png', 'image/jpeg', 'image/gif', 'image/webp'],
    DEFAULT_SETTINGS: { reactions: 'like', comments: 'on', approval: false, showAuthor: true, newPostPosition: 'top' },
    LIMITS: {
      postTitle: 200, postBody: 10000, comment: 2000, boardTitle: 120, boardDesc: 1000, sectionTitle: 80,
      displayName: 40, usernameMin: 3, usernameMax: 30, passwordMin: 8, passwordMax: 200, url: 2000,
    },
    TEMPLATE_DEFS: {
      blank: { format: 'wall', sections: [] },
      kwl: { format: 'shelf', sections: ['알고 있는 것', '알고 싶은 것', '배운 것'] },
      retro: { format: 'shelf', sections: ['잘한 점', '아쉬운 점', '시도할 점'] },
      training: { format: 'rows', sections: ['1부', '2부'] },
    },
    AVATAR_COLORS: ['#e57373', '#f06292', '#ba68c8', '#7986cb', '#4fc3f7', '#4db6ac', '#81c784', '#ffb74d', '#a1887f', '#90a4ae'],
    // demo-only limits (the Node server's are configurable; here they are fixed)
    MAX_UPLOAD_MB: 10,
    BOARD_MAX_POSTS: 5000,
    SESSION_DAYS: 30,
    VERSION: '0.1.0-demo',
  };
  const roleIndex = (r) => C.ROLES.indexOf(r);
  const atLeast = (role, min) => role != null && roleIndex(role) >= roleIndex(min);
  const isSectioned = (format) => C.SECTIONED.includes(format);

  /* ───────── errors (same shape as server/http.js) ───────── */
  class HttpError extends Error {
    constructor(status, code, message, headers) {
      super(message);
      this.status = status;
      this.code = code;
      this.headers = headers;
    }
  }
  const bad = (code, message) => new HttpError(400, code, message);
  const unauthorized = (message = '로그인이 필요해요.') => new HttpError(401, 'unauthorized', message);
  const forbidden = (message = '권한이 없어요.', code = 'forbidden') => new HttpError(403, code, message);
  const notFound = (message = '찾을 수 없어요.') => new HttpError(404, 'not_found', message);

  /* ───────── ids, hashes, randomness ───────── */
  const now = () => Date.now();
  const hex = (u8) => [...u8].map((b) => b.toString(16).padStart(2, '0')).join('');
  const randomBytes = (n) => crypto.getRandomValues(new Uint8Array(n));
  const randomHex = (n = 16) => hex(randomBytes(n));
  const b64 = (u8) => btoa(String.fromCharCode(...u8));
  const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const randomToken = (n = 32) => b64(randomBytes(n)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const randomInt = (max) => crypto.getRandomValues(new Uint32Array(1))[0] % max;
  const randomAvatar = () => C.AVATAR_COLORS[randomInt(C.AVATAR_COLORS.length)];
  async function sha256Hex(s) {
    return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))));
  }

  /* ───────── passwords: PBKDF2-SHA256 instead of scrypt (WebCrypto has no scrypt) ───────── */
  const PBKDF2_ITER = 150000;
  async function pbkdf2(pw, salt, iter) {
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(String(pw).normalize('NFKC')), 'PBKDF2', false, ['deriveBits']);
    return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, key, 256));
  }
  async function hashPassword(pw) {
    const salt = randomBytes(16);
    return `pbkdf2$sha256$${PBKDF2_ITER}$${b64(salt)}$${b64(await pbkdf2(pw, salt, PBKDF2_ITER))}`;
  }
  async function verifyPassword(pw, stored) {
    const p = String(stored).split('$');
    if (p.length !== 5 || p[0] !== 'pbkdf2' || p[1] !== 'sha256') return false;
    const iter = Number(p[2]);
    if (!(iter >= 1000 && iter <= 2000000)) return false;
    const want = unb64(p[4]);
    const got = await pbkdf2(pw, unb64(p[3]), iter);
    if (want.length !== got.length) return false;
    let diff = 0;
    for (let i = 0; i < want.length; i++) diff |= want[i] ^ got[i];
    return diff === 0;
  }
  let dummy;
  const dummyHash = () => (dummy ||= hashPassword('edulet-dummy-password'));

  /* ───────── text cleaning & validation (server/util.js) ───────── */
  const cpLen = (s) => { let n = 0; for (const _ of s) n++; return n; }; // eslint-disable-line no-unused-vars
  const cleanLine = (s) => String(s).replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim();
  const cleanBlock = (s) => String(s)
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u2028\u2029]/g, '')
    .trim();

  function needLine(v, label, min, max) {
    if (typeof v !== 'string') throw bad('bad_request', `${label}을(를) 입력해 주세요.`);
    const s = cleanLine(v);
    const n = cpLen(s);
    if (n < min) throw bad('bad_request', `${label}을(를) 입력해 주세요.`);
    if (n > max) throw bad('too_long', `${label}은(는) ${max}자 이하로 써 주세요.`);
    return s;
  }
  function optLine(v, label, max) {
    if (v == null) return '';
    if (typeof v !== 'string') throw bad('bad_request', `${label} 형식이 올바르지 않아요.`);
    const s = cleanLine(v);
    if (cpLen(s) > max) throw bad('too_long', `${label}은(는) ${max}자 이하로 써 주세요.`);
    return s;
  }
  function optBlock(v, label, max) {
    if (v == null) return '';
    if (typeof v !== 'string') throw bad('bad_request', `${label} 형식이 올바르지 않아요.`);
    const s = cleanBlock(v);
    if (cpLen(s) > max) throw bad('too_long', `${label}은(는) ${max}자 이하로 써 주세요.`);
    return s;
  }
  function oneOf(v, list, label) {
    if (!list.includes(v)) throw bad('bad_request', `${label} 값이 올바르지 않아요.`);
    return v;
  }
  function toId(v) {
    const n = Number(v);
    if (!Number.isSafeInteger(n) || n < 1) throw notFound();
    return n;
  }
  /** For ids inside request bodies (400 instead of 404). */
  function bodyId(v, label = 'id') {
    const n = Number(v);
    if (v == null || typeof v === 'boolean' || !Number.isSafeInteger(n) || n < 1) throw bad('bad_request', `${label} 값이 올바르지 않아요.`);
    return n;
  }
  function finite(v, label, lo, hi) {
    if (typeof v !== 'number' || !Number.isFinite(v)) throw bad('bad_request', `${label} 값이 올바르지 않아요.`);
    return Math.min(hi, Math.max(lo, v));
  }
  /** http(s) URL only; returns the normalised href. */
  function normalizeUrl(v) {
    if (typeof v !== 'string') throw bad('bad_url', '주소가 올바르지 않아요.');
    const s = v.trim();
    if (!s || s.length > C.LIMITS.url || /[\u0000- ]/.test(s)) throw bad('bad_url', '주소가 올바르지 않아요.');
    let u;
    try { u = new URL(s); } catch { throw bad('bad_url', '주소가 올바르지 않아요.'); }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw bad('bad_url', 'http 또는 https 주소만 쓸 수 있어요.');
    return u.href;
  }
  const uploadUrl = (id, name) => `/uploads/${id}/${encodeURIComponent(name)}`;

  /** File names: no path separators / control characters, ≤ 100 chars (extension kept). */
  function normalizeFileName(raw) {
    let s = typeof raw === 'string' ? raw : '';
    try { s = decodeURIComponent(s); } catch { /* use as-is */ }
    s = s.replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, '').replace(/[\\/]/g, '').replace(/\.\.+/g, '.').replace(/^\.+/, '').trim();
    if (s.length > 100) {
      const m = /\.[^./]*$/.exec(s);
      const ext = m ? m[0].slice(0, 12) : '';
      s = s.slice(0, 100 - ext.length) + ext;
    }
    return s || 'file';
  }

  /** Magic-byte sniffing of PNG / JPEG / GIF / WebP (SVG and everything else is not an image here). */
  function sniffImage(u8) {
    const at = (a, b) => String.fromCharCode(...u8.subarray(a, b));
    if (u8.length >= 8 && u8[0] === 0x89 && u8[1] === 0x50 && u8[2] === 0x4e && u8[3] === 0x47 && u8[4] === 0x0d && u8[5] === 0x0a && u8[6] === 0x1a && u8[7] === 0x0a) return 'image/png';
    if (u8.length >= 3 && u8[0] === 0xff && u8[1] === 0xd8 && u8[2] === 0xff) return 'image/jpeg';
    if (u8.length >= 6 && /^GIF8[79]a$/.test(at(0, 6))) return 'image/gif';
    if (u8.length >= 12 && at(0, 4) === 'RIFF' && at(8, 12) === 'WEBP') return 'image/webp';
    return null;
  }

  /* ───────── fractional ranks (server/rank.js) ───────── */
  const MIN_GAP = 1e-6;
  /**
   * Rank for `movingId` placed right before `beforeId` (null = end) among `others` ({id, rank}, sorted, WITHOUT the moving item).
   * When `order` is set the whole list must be renumbered i+1 in that id order (moving id included).
   */
  function planPlacement(others, beforeId, movingId) {
    if (beforeId == null) return { rank: others.length ? others[others.length - 1].rank + 1 : 1, order: null };
    const idx = others.findIndex((o) => o.id === beforeId);
    if (idx < 0) throw bad('bad_request', '기준 위치를 찾을 수 없어요.');
    const next = others[idx];
    const prev = idx > 0 ? others[idx - 1] : null;
    if (!prev) return { rank: next.rank - 1, order: null };
    if (next.rank - prev.rank < MIN_GAP) {
      const order = others.map((o) => o.id);
      order.splice(idx, 0, movingId);
      return { rank: idx + 1, order };
    }
    return { rank: (prev.rank + next.rank) / 2, order: null };
  }
  /** Rank for a brand-new item: min-1 (top) / max+1 (bottom) / 1 when the list is empty. */
  function edgeRank(lo, hi, position) {
    if (lo == null || hi == null) return 1;
    return position === 'bottom' ? hi + 1 : lo - 1;
  }

  Object.assign(E, {
    C, roleIndex, atLeast, isSectioned,
    HttpError, bad, unauthorized, forbidden, notFound,
    now, randomHex, randomToken, randomInt, randomAvatar, sha256Hex, hashPassword, verifyPassword, dummyHash,
    cpLen, cleanLine, cleanBlock, needLine, optLine, optBlock, oneOf, toId, bodyId, finite, normalizeUrl, uploadUrl,
    normalizeFileName, sniffImage, planPlacement, edgeRank,
  });
})((self.EDU = self.EDU || {}));
