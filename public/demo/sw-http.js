/* Edulet demo server — HTTP layer: router, request context, session lookup, response building, the /api pipeline.
 * Port of server/http.js + the dispatch part of server/index.js. Routes are registered by the other sw-*.js files. */
(function (E) {
  'use strict';
  const { HttpError, bad } = E;
  const { q } = E.db;

  /* ───────── router (same matching rules as the Node server) ───────── */
  class Router {
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
  const router = new Router();

  /* ───────── request context ───────── */
  const MAX_JSON = 1024 * 1024;
  class Context {
    constructor(req, url, params) {
      this.req = req;
      this.url = url;
      this.params = params;
      this.user = null; // users row
      this.tokenHash = null;
      this.sessionHeader = undefined; // string → sent as X-Edulet-Session ('' = clear it in the browser)
      this.queue = []; // hub work, flushed after the state has been saved
      this.result = null; // explicit response from json()/respond()
      this.volatile = false; // true: the request changes no persistent state (no save)
      this._body = undefined;
      const cid = req.headers.get('x-client-id');
      this.origin = typeof cid === 'string' && /^[\w.-]{1,64}$/.test(cid) ? cid : null;
    }
    get query() { return (this._query ??= Object.fromEntries(this.url.searchParams)); }
    json(data, status = 200, headers) { this.result = { status, data, headers }; }
    respond(response) { this.result = { response }; }
    async body() {
      if (this._body !== undefined) return this._body;
      const raw = new Uint8Array(await this.req.arrayBuffer());
      if (raw.length > MAX_JSON) throw new HttpError(413, 'too_large', '파일이 너무 커요.');
      if (!raw.length) return (this._body = {});
      const ct = String(this.req.headers.get('content-type') || '').toLowerCase();
      if (!ct.startsWith('application/json')) throw new HttpError(415, 'unsupported_media_type', 'JSON 형식으로 보내 주세요.');
      let v;
      try { v = JSON.parse(new TextDecoder().decode(raw)); } catch { throw bad('bad_json', '요청 형식이 올바르지 않아요.'); }
      if (v === null || typeof v !== 'object' || Array.isArray(v)) throw bad('bad_request', '요청 형식이 올바르지 않아요.');
      return (this._body = v);
    }
    /** Broadcast an event on a board once the state is saved; `only(stream)` optionally restricts the audience. */
    emit(boardId, type, data, only) {
      const origin = this.origin;
      this.queue.push(() => E.hub.emit(boardId, type, { ...data, origin }, only));
    }
    /** Run a hub action (refresh, close…) after the state is saved, in order with the emits. */
    defer(fn) { this.queue.push(fn); }
  }

  /* ───────── sessions (X-Edulet-Session header instead of a cookie) ───────── */
  async function createSession(userId) {
    const token = E.randomToken(32);
    const tokenHash = await E.sha256Hex(token);
    const t = E.now();
    E.db.state.sessions[tokenHash] = { token_hash: tokenHash, user_id: userId, expires_at: t + E.C.SESSION_DAYS * 86400000, created_at: t };
    return token;
  }

  /** Resolve the session header → c.user / c.tokenHash. An unknown token makes the response clear the browser's copy. */
  async function authenticate(c) {
    const token = c.req.headers.get('x-edulet-session');
    if (!token) return;
    if (token.length > 200) { c.sessionHeader = ''; return; }
    const tokenHash = await E.sha256Hex(token);
    const s = E.db.state.sessions[tokenHash];
    if (s && s.expires_at <= E.now()) delete E.db.state.sessions[tokenHash];
    const user = s && s.expires_at > E.now() ? q.user(s.user_id) : null;
    if (!user) { c.sessionHeader = ''; return; }
    c.user = user;
    c.tokenHash = tokenHash;
  }

  /* ───────── responses ───────── */
  const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
  function jsonResponse(status, data, headers, c) {
    const h = { ...JSON_HEADERS, ...headers };
    if (c && c.sessionHeader !== undefined) h['X-Edulet-Session'] = c.sessionHeader;
    return new Response(JSON.stringify(data), { status, headers: h });
  }
  function errorResponse(err, c) {
    if (err instanceof HttpError) return jsonResponse(err.status, { error: { code: err.code, message: err.message } }, err.headers, c);
    console.error('[edulet-demo]', err);
    return jsonResponse(500, { error: { code: 'server_error', message: '서버에서 문제가 생겼어요. 잠시 뒤에 다시 해 주세요.' } }, undefined, c);
  }

  /** The whole /api pipeline for one request: route → handler → persist → events → response. */
  async function handleApi(req, url, apiPath) {
    const m = router.match(req.method, apiPath);
    if (!m) return jsonResponse(404, { error: { code: 'not_found', message: '없는 주소예요.' } });
    if (m.methodNotAllowed) return jsonResponse(405, { error: { code: 'method_not_allowed', message: '허용되지 않는 요청이에요.' } });
    const c = new Context(req, url, m.params);
    try {
      await authenticate(c);
      const out = await m.handler(c);
      const r = c.result || { status: 200, data: out === undefined ? { ok: true } : out };
      const status = r.response ? r.response.status : r.status;
      // persist BEFORE answering every mutating request, then tell the other tabs
      if (req.method !== 'GET' && req.method !== 'HEAD' && !c.volatile && status < 400) await E.db.save();
      for (const fn of c.queue) {
        try { fn(); } catch (e) { console.error('[edulet-demo] event', e); }
      }
      if (r.response) {
        if (c.sessionHeader !== undefined) r.response.headers.set('X-Edulet-Session', c.sessionHeader);
        return r.response;
      }
      return jsonResponse(r.status, r.data, r.headers, c);
    } catch (err) {
      return errorResponse(err, c);
    }
  }

  E.router = router;
  E.http = { Router, Context, createSession, authenticate, jsonResponse, errorResponse, handleApi };
})((self.EDU = self.EDU || {}));
