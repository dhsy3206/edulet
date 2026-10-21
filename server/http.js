// Minimal HTTP toolkit: errors, router, body parsing, cookies, rate limiter, request context.
import { Buffer } from 'node:buffer';

export class HttpError extends Error {
  constructor(status, code, message, headers) {
    super(message);
    this.status = status;
    this.code = code;
    this.headers = headers;
  }
}
export const bad = (code, message) => new HttpError(400, code, message);
export const unauthorized = (message = '로그인이 필요해요.') => new HttpError(401, 'unauthorized', message);
export const forbidden = (message = '권한이 없어요.', code = 'forbidden') => new HttpError(403, code, message);
export const notFound = (message = '찾을 수 없어요.') => new HttpError(404, 'not_found', message);

export function sendJson(res, status, data, headers) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(body);
}

export function sendText(res, status, text, headers) {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    ...headers,
  });
  res.end(text);
}

export class Router {
  constructor() { this.routes = []; }
  add(method, pattern, handler) {
    const keys = [];
    const src = pattern
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      .replace(/:([A-Za-z]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; });
    this.routes.push({ method, re: new RegExp('^' + src + '/?$'), keys, handler });
  }
  match(method, path) {
    let pathMatched = false;
    for (const r of this.routes) {
      const m = r.re.exec(path);
      if (!m) continue;
      pathMatched = true;
      if (r.method !== method) continue;
      const params = {};
      try {
        r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      } catch {
        return null;
      }
      return { handler: r.handler, params };
    }
    return pathMatched ? { methodNotAllowed: true } : null;
  }
}

export function parseCookies(header) {
  const out = Object.create(null);
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!(k in out)) out[k] = part.slice(i + 1).trim();
  }
  return out;
}

/**
 * Stop buffering an oversized request body: keep reading (and discarding) a little longer so the client can still
 * receive our 413, but never more than `limit + 8MB` / 1.5 s.
 */
export function discardBody(req, limit) {
  req.removeAllListeners('data');
  req.resume(); // a paused stream (backpressure) must flow again or the remainder is never read
  let drained = 0;
  req.on('data', (ch) => { drained += ch.length; if (drained > limit + 8 * 1024 * 1024) req.destroy(); });
  const t = setTimeout(() => req.destroy(), 1500);
  t.unref();
  req.on('end', () => clearTimeout(t));
  req.on('close', () => clearTimeout(t));
}

export const tooLargeError = () => new HttpError(413, 'too_large', '파일이 너무 커요.', { Connection: 'close' });

/**
 * Read the whole body up to `limit` bytes. Rejects with 413 (and discards the rest) when exceeded, and with 408 when the
 * whole body has not arrived within `timeoutMs` (a stalled client must not keep an authorisation decision open forever).
 */
export function readBody(req, limit, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    let timer = null;
    let finished = false;
    const settle = (fn, v) => { if (finished) return; finished = true; clearTimeout(timer); fn(v); };
    const tooLarge = () => { discardBody(req, limit); settle(reject, tooLargeError()); };
    if (Number.isFinite(declared) && declared > limit) return tooLarge();
    const chunks = [];
    let size = 0;
    timer = setTimeout(() => {
      if (finished) return;
      discardBody(req, limit);
      settle(reject, new HttpError(408, 'request_timeout', '요청을 받는 데 너무 오래 걸렸어요. 다시 해 주세요.', { Connection: 'close' }));
    }, timeoutMs);
    timer.unref();
    req.on('data', (ch) => {
      if (finished) return;
      size += ch.length;
      if (size > limit) { chunks.length = 0; tooLarge(); return; }
      chunks.push(ch);
    });
    req.on('end', () => settle(resolve, Buffer.concat(chunks)));
    req.on('error', (e) => settle(reject, e));
    req.on('aborted', () => settle(reject, new HttpError(400, 'aborted', '요청이 중단됐어요.')));
  });
}

export class RateLimiter {
  constructor() { this.m = new Map(); this.sweptAt = 0; }
  /** @returns {boolean} true when the call is allowed */
  hit(key, limit, windowMs = 60000) {
    const t = Date.now();
    let e = this.m.get(key);
    if (!e || e.reset <= t) { e = { n: 0, reset: t + windowMs }; this.m.set(key, e); }
    e.n++;
    this.sweep(t);
    return e.n <= limit;
  }
  /** Hits recorded in the current window (0 when none). Does not count as a hit. */
  count(key) {
    const e = this.m.get(key);
    return e && e.reset > Date.now() ? e.n : 0;
  }
  /** Milliseconds until the window of `key` ends (0 when there is none). */
  retryAfterMs(key) {
    const e = this.m.get(key);
    return e && e.reset > Date.now() ? e.reset - Date.now() : 0;
  }
  clear(key) { this.m.delete(key); }
  /** Drop expired windows. Runs at most once every 10 s (and only when the map is big), so hit() stays O(1) amortised. */
  sweep(t = Date.now()) {
    if (this.m.size <= 2000 || t - this.sweptAt < 10000) return;
    this.sweptAt = t;
    for (const [k, v] of this.m) if (v.reset <= t) this.m.delete(k);
  }
}

export function clientIp(app, req) {
  if (app.config.trustProxy) {
    const xff = req.headers['x-forwarded-for'];
    if (typeof xff === 'string' && xff) {
      const parts = xff.split(',').map((s) => s.trim()).filter(Boolean);
      if (parts.length) return parts[parts.length - 1];
    }
  }
  return req.socket.remoteAddress || 'unknown';
}

export class Context {
  constructor(app, req, res, url, params) {
    this.app = app;
    this.req = req;
    this.res = res;
    this.url = url;
    this.params = params;
    this.user = null; // users row
    this.tokenHash = null;
    this.done = false;
    this._body = undefined;
    const cid = req.headers['x-client-id'];
    this.origin = typeof cid === 'string' && /^[\w.-]{1,64}$/.test(cid) ? cid : null;
  }
  get db() { return this.app.db; }
  get query() { return (this._query ??= Object.fromEntries(this.url.searchParams)); }
  json(data, status = 200, headers) {
    sendJson(this.res, status, data, headers);
    this.done = true;
  }
  async body() {
    if (this._body !== undefined) return this._body;
    const raw = await readBody(this.req, 1024 * 1024);
    if (!raw.length) return (this._body = {});
    const ct = String(this.req.headers['content-type'] || '').toLowerCase();
    if (!ct.startsWith('application/json')) throw new HttpError(415, 'unsupported_media_type', 'JSON 형식으로 보내 주세요.');
    let v;
    try { v = JSON.parse(raw.toString('utf8')); } catch { throw bad('bad_json', '요청 형식이 올바르지 않아요.'); }
    if (v === null || typeof v !== 'object' || Array.isArray(v)) throw bad('bad_request', '요청 형식이 올바르지 않아요.');
    return (this._body = v);
  }
  /** Broadcast an SSE event on a board; `only(conn)` optionally restricts the audience. */
  emit(boardId, type, data, only) {
    this.app.hub.emit(boardId, type, { ...data, origin: this.origin }, only);
  }
}
