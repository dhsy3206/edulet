// Shared test helpers (not a test file itself).
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/index.js';
import { createSession } from '../server/auth.js';

const stubFetcher = async () => ({
  status: 200,
  headers: { 'content-type': 'text/html; charset=utf-8' },
  body: Buffer.from('<html><head><title>Stub Title</title><meta property="og:description" content="Stub description"></head></html>'),
});

/** Boot a server on a random port with a throw-away DATA_DIR. close() also removes the folder. */
export async function startApp(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'edulet-test-'));
  const running = await createApp({
    dataDir: dir, port: 0, host: '127.0.0.1', seed: false, quiet: true, authRateLimit: 100000,
    previewFetcher: stubFetcher, // never touch the real network from tests (pass previewFetcher: null to opt out)
    ...opts,
  });
  const close = running.close.bind(running);
  running.dir = dir;
  running.close = async () => {
    await close();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  };
  return running;
}

export class Client {
  constructor(running, cookie = null) {
    this.running = running;
    this.base = running.url;
    this.cookie = cookie;
    this.clientId = 'c' + Math.random().toString(36).slice(2, 10);
  }

  async req(method, url, body, { headers = {}, raw = false } = {}) {
    const h = { ...headers };
    if (this.cookie) h.cookie = this.cookie;
    if (this.clientId && !h['x-client-id']) h['x-client-id'] = this.clientId;
    let payload;
    if (body !== undefined) {
      if (raw) payload = body;
      else { h['content-type'] = h['content-type'] || 'application/json'; payload = JSON.stringify(body); }
    }
    const res = await fetch(this.base + url, { method, headers: h, body: payload, redirect: 'manual' });
    for (const sc of res.headers.getSetCookie?.() ?? []) {
      const m = /^edulet_sid=([^;]*)/.exec(sc);
      if (m) this.cookie = /Max-Age=0/i.test(sc) || !m[1] ? null : `edulet_sid=${m[1]}`;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    const text = buf.toString('utf8');
    let json;
    if ((res.headers.get('content-type') || '').includes('json')) { try { json = JSON.parse(text); } catch { /* not json */ } }
    return { status: res.status, headers: res.headers, json, text, buf, res };
  }
  get(url, opts) { return this.req('GET', url, undefined, opts); }
  post(url, body, opts) { return this.req('POST', url, body ?? {}, opts); }
  put(url, body, opts) { return this.req('PUT', url, body ?? {}, opts); }
  patch(url, body, opts) { return this.req('PATCH', url, body ?? {}, opts); }
  del(url, opts) { return this.req('DELETE', url, undefined, opts); }

  async guest(name = '손님') {
    const r = await this.post('/api/auth/guest', { displayName: name });
    this.user = r.json.user;
    return r;
  }
}

let seq = 0;
/** Fast fixture user (inserted directly, session minted without scrypt). `username` is set but the password is NULL. */
export function makeUser(running, label = 'user', { guest = false } = {}) {
  const n = ++seq;
  const username = guest ? null : `${label}${n}`.toLowerCase();
  const id = running.db.run(
    'INSERT INTO users (username, display_name, password_hash, avatar_color, is_guest, created_at) VALUES (?,?,NULL,?,?,?)',
    username, `${label}${n}`, '#4fc3f7', guest ? 1 : 0, Date.now(),
  ).id;
  const { token } = createSession(running.app, id);
  const c = new Client(running, `edulet_sid=${token}`);
  c.id = id;
  c.username = username;
  c.displayName = `${label}${n}`;
  return c;
}

/** Create a board; fields POST /boards does not take (visibility, linkAccess, settings, ...) are applied with a PATCH. */
export async function makeBoard(owner, body = {}) {
  const { title = '테스트 보드', description, format, template, ...rest } = body;
  const r = await owner.post('/api/boards', { title, description, format, template });
  if (r.status !== 201) throw new Error('makeBoard failed ' + r.status + ' ' + r.text);
  if (!Object.keys(rest).length) return r.json.board;
  const p = await owner.patch(`/api/boards/${r.json.board.slug}`, rest);
  if (p.status !== 200) throw new Error('makeBoard patch failed ' + p.status + ' ' + p.text);
  return p.json.board;
}

export async function addMember(owner, board, user, role) {
  const r = await owner.post(`/api/boards/${board.slug}/members`, { username: user.username, role });
  if (r.status !== 201) throw new Error('addMember failed ' + r.status + ' ' + r.text);
  return r.json.member;
}

export async function makePost(client, board, body = {}) {
  const r = await client.post(`/api/boards/${board.slug}/posts`, { title: '제목', body: '본문', ...body });
  if (r.status !== 201) throw new Error('makePost failed ' + r.status + ' ' + r.text);
  return r.json.post;
}

/** Minimal valid 1x1 PNG. */
export const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64',
);

/** Server-Sent Events test client. */
export function openSse(running, slug, client = null, { clientId } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { accept: 'text/event-stream' };
    if (client?.cookie) headers.cookie = client.cookie;
    if (clientId) headers['x-client-id'] = clientId;
    const req = http.get(`${running.url}/api/boards/${slug}/events`, { headers }, (res) => {
      const sse = { status: res.statusCode, headers: res.headers, res, events: [], raw: '', closed: false, listeners: [] };
      if (res.statusCode !== 200) {
        let body = '';
        res.on('data', (d) => { body += d; });
        res.on('end', () => { sse.body = body; sse.closed = true; resolve(sse); });
        return;
      }
      res.setEncoding('utf8');
      let buf = '';
      res.on('data', (chunk) => {
        sse.raw += chunk;
        buf += chunk;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, i);
          buf = buf.slice(i + 2);
          let type = null;
          let data = null;
          for (const line of frame.split('\n')) {
            if (line.startsWith('event: ')) type = line.slice(7);
            else if (line.startsWith('data: ')) data = line.slice(6);
          }
          if (type) {
            const ev = { type, data: data ? JSON.parse(data) : null };
            sse.events.push(ev);
            sse.listeners.slice().forEach((l) => l());
          }
        }
      });
      const onEnd = () => { sse.closed = true; sse.listeners.slice().forEach((l) => l()); };
      res.on('end', onEnd);
      res.on('close', onEnd);
      res.on('error', onEnd);
      sse.waitFor = (type, pred = () => true, ms = 3000) => new Promise((ok, fail) => {
        const find = () => sse.events.find((e) => e.type === type && pred(e.data, e));
        const hit = find();
        if (hit) return ok(hit);
        const t = setTimeout(() => { off(); fail(new Error(`timeout waiting for ${type}; got: ${sse.events.map((e) => e.type).join(',')}`)); }, ms);
        const l = () => { const h = find(); if (h) { off(); clearTimeout(t); ok(h); } };
        const off = () => { sse.listeners = sse.listeners.filter((x) => x !== l); };
        sse.listeners.push(l);
      });
      sse.waitClosed = (ms = 3000) => new Promise((ok, fail) => {
        if (sse.closed) return ok();
        const t = setTimeout(() => { off(); fail(new Error('connection was not closed')); }, ms);
        const l = () => { if (sse.closed) { off(); clearTimeout(t); ok(); } };
        const off = () => { sse.listeners = sse.listeners.filter((x) => x !== l); };
        sse.listeners.push(l);
      });
      sse.ofType = (type) => sse.events.filter((e) => e.type === type);
      sse.close = () => { req.destroy(); };
      sse.waitFor('hello').then(() => resolve(sse), reject);
    });
    req.on('error', reject);
  });
}

/** Tiny RFC 4180 parser (quotes, doubled quotes, newlines inside quoted cells). */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') q = false;
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\r' && text[i + 1] === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; i++; }
    else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * An upload that can be held open: the first chunk is sent immediately, the rest only when `finish()` is called (or never).
 * `result` resolves to { status, json, text, headers } (or { error } when the connection was cut).
 */
export function slowUpload(running, client, slug, { name = 'slow.bin', first = Buffer.alloc(16, 1), type = 'application/octet-stream' } = {}) {
  let done;
  const result = new Promise((resolve) => { done = resolve; });
  const req = http.request(`${running.url}/api/uploads?board=${slug}&name=${encodeURIComponent(name)}`, {
    method: 'PUT',
    headers: { cookie: client.cookie, 'content-type': type, 'transfer-encoding': 'chunked' },
  }, (res) => {
    const parts = [];
    res.on('data', (d) => parts.push(d));
    res.on('end', () => {
      const text = Buffer.concat(parts).toString('utf8');
      let json;
      try { json = JSON.parse(text); } catch { /* not json */ }
      done({ status: res.statusCode, json, text, headers: res.headers });
    });
  });
  req.on('error', (error) => done({ error }));
  req.write(first);
  return {
    req,
    result,
    /** send `rest` (optional) and end the body */
    finish(rest) { if (rest) req.write(rest); req.end(); return result; },
    abort() { req.destroy(); },
  };
}
