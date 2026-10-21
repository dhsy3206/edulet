// A stand-in for Google's two OAuth addresses (authorization + token endpoint) and a browser-like walker for the redirect chain.
// Shared by test/google.test.js and e2e/run.mjs. Not a test file itself: nothing runs when it is imported.
import crypto from 'node:crypto';
import http from 'node:http';
import { listenOnGoodPort } from '../tools/ports.mjs';

export const CLIENT_ID = 'edulet-test.apps.googleusercontent.com';
export const CLIENT_SECRET = 'GOCSPX-edulet-test-secret';

const b64u = (v) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');
const readForm = (req) => new Promise((resolve) => {
  const parts = [];
  req.on('data', (d) => parts.push(d));
  req.on('end', () => resolve(Object.fromEntries(new URLSearchParams(Buffer.concat(parts).toString('utf8')))));
});

/**
 * g.profile  — the Google account that "signs in" ({ sub, email, email_verified, name, hd? })
 * g.claims   — overrides for the ID token's claims (set a key to undefined to drop it), e.g. { aud: 'someone-else' }
 * g.idToken  — send this string as the ID token instead (to test garbage)
 * g.deny     — the person presses "Cancel" on Google's page
 * g.tokenStatus / g.tokenDelayMs — make the token endpoint fail or stall
 * g.authCalls / g.tokenCalls — what the server sent
 */
export async function startMockGoogle() {
  const codes = new Map();
  let seq = 0;
  const g = {
    profile: null, claims: null, idToken: null, deny: false, tokenStatus: 200, tokenDelayMs: 0, authCalls: [], tokenCalls: [],
    reset() {
      g.profile = { sub: String(110000000000000000000n + BigInt(++seq)), email: 'hana@example.com', email_verified: true, name: '김하나' }; // a new Google account each time
      g.claims = {};
      g.idToken = null;
      g.deny = false;
      g.tokenStatus = 200;
      g.tokenDelayMs = 0;
      g.authCalls.length = 0;
      g.tokenCalls.length = 0;
    },
  };
  g.reset();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://mock');
    const send = (status, body, headers = {}) => {
      const text = typeof body === 'string' ? body : JSON.stringify(body);
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(text);
    };
    if (req.method === 'GET' && url.pathname === '/auth') {
      const q = Object.fromEntries(url.searchParams);
      g.authCalls.push(q);
      // Google answers a malformed request with an error page, not a redirect — so does this.
      if (q.client_id !== CLIENT_ID || q.response_type !== 'code' || !q.redirect_uri || !q.state || q.code_challenge_method !== 'S256' || !q.code_challenge || !q.nonce
        || !/\bopenid\b/.test(q.scope || '')) return send(400, { error: 'invalid_request' });
      const back = new URL(q.redirect_uri);
      back.searchParams.set('state', q.state);
      if (g.deny) {
        back.searchParams.set('error', 'access_denied');
        return send(302, '', { location: back.href });
      }
      const code = '4/0A' + crypto.randomBytes(18).toString('base64url');
      codes.set(code, { nonce: q.nonce, challenge: q.code_challenge, redirect_uri: q.redirect_uri, used: false });
      back.searchParams.set('code', code);
      return send(302, '', { location: back.href });
    }
    if (req.method === 'POST' && url.pathname === '/token') {
      const f = await readForm(req);
      g.tokenCalls.push(f);
      if (g.tokenDelayMs) await new Promise((r) => setTimeout(r, g.tokenDelayMs));
      if (g.tokenStatus !== 200) return send(g.tokenStatus, { error: 'invalid_client', error_description: 'mock failure' });
      const rec = codes.get(f.code);
      const bad = !rec || rec.used || f.grant_type !== 'authorization_code' || f.client_id !== CLIENT_ID || f.client_secret !== CLIENT_SECRET
        || f.redirect_uri !== rec.redirect_uri || !f.code_verifier
        || crypto.createHash('sha256').update(f.code_verifier).digest('base64url') !== rec.challenge;
      if (bad) return send(400, { error: 'invalid_grant', error_description: 'Bad Request' });
      rec.used = true; // a code works once
      const t = Math.floor(Date.now() / 1000);
      const claims = {
        iss: 'https://accounts.google.com', azp: CLIENT_ID, aud: CLIENT_ID, ...g.profile, nonce: rec.nonce, iat: t, exp: t + 3600, ...g.claims,
      };
      for (const k of Object.keys(claims)) if (claims[k] === undefined) delete claims[k];
      const id_token = g.idToken ?? `${b64u({ alg: 'RS256', typ: 'JWT' })}.${b64u(claims)}.${b64u('not-checked-here')}`;
      return send(200, { access_token: 'ya29.mock', expires_in: 3599, scope: 'openid email profile', token_type: 'Bearer', id_token });
    }
    return send(404, { error: 'not_found' });
  });
  await listenOnGoodPort(server);
  g.url = `http://127.0.0.1:${server.address().port}`;
  /** what createApp({ googleEndpoints }) wants */
  g.endpoints = (timeoutMs = 3000, extra = {}) => ({ auth: g.url + '/auth', token: g.url + '/token', timeoutMs, ...extra });
  /** the config overrides that switch Google sign-in on */
  g.config = (extra = {}) => ({ googleClientId: CLIENT_ID, googleClientSecret: CLIENT_SECRET, googleDomains: [], ...extra });
  g.close = () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); });
  return g;
}

/** Just enough cookie jar: name → value, Max-Age=0 deletes; `raw` keeps every Set-Cookie line seen. */
function absorb(jar, setCookies) {
  for (const sc of setCookies) {
    jar.raw.push(sc);
    const m = /^([^=;\s]+)=([^;]*)/.exec(sc);
    if (!m) continue;
    if (/Max-Age=0/i.test(sc) || !m[2]) jar.delete(m[1]);
    else jar.set(m[1], m[2]);
  }
}
export function newJar(sid = null) {
  const jar = new Map();
  jar.raw = [];
  if (sid) jar.set('edulet_sid', sid);
  return jar;
}
const cookieHeader = (jar) => (jar.size ? { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') } : {});

async function hop(jar, url, headers = {}) {
  const res = await fetch(url, { redirect: 'manual', headers: { ...headers, ...cookieHeader(jar) } });
  absorb(jar, res.headers.getSetCookie?.() ?? []);
  return { status: res.status, location: res.headers.get('location'), res };
}

/**
 * Do what the browser does up to the point where Google would send it back: GET /api/auth/google/start, then Google's page.
 * Returns { jar, callbackUrl } — or, when the app already ended the flow itself, { jar, done: { location, flash, sid } }.
 */
export async function beginGoogle(running, { sid = null, mode, next, headers } = {}) {  // mode is ignored by the server: linking is beginLink()
  const jar = newJar(sid);
  const q = new URLSearchParams();
  if (mode !== undefined) q.set('mode', mode);
  if (next !== undefined) q.set('next', next);
  const first = await hop(jar, `${running.url}/api/auth/google/start?${q}`, headers);
  if (first.status !== 302 || !first.location) throw new Error('start did not redirect: ' + first.status);
  if (first.location.startsWith('/')) return { jar, done: summary(jar, first.location) };
  const google = await hop(jar, first.location); // Google's authorization page
  if (google.status !== 302 || !google.location) throw new Error('Google refused the request: ' + google.status);
  return { jar, authUrl: first.location, callbackUrl: google.location };
}

/** What the browser's flow cookie must look like: base64url(JSON) + "." + HMAC (see server/google.js). For forging cookies in tests. */
export const signFlowCookie = (flow, secret = CLIENT_SECRET) => {
  const payload = Buffer.from(typeof flow === 'string' ? flow : JSON.stringify(flow)).toString('base64url');
  return payload + '.' + crypto.createHmac('sha256', secret).update('edulet-oauth-flow|' + payload).digest('base64url');
};
/** The JSON inside a flow cookie value (signature not checked). */
export const readFlowCookie = (value) => JSON.parse(Buffer.from(value.slice(0, value.indexOf('.')), 'base64url').toString('utf8'));

/**
 * Link a Google account to a signed-in password account: POST /api/auth/google/link (which wants the password), then Google's page.
 * Returns { jar, authUrl, callbackUrl } — or { jar, rejected: { status, json } } when the server said no.
 */
export async function beginLink(running, { sid, password, next, headers } = {}) {
  const jar = newJar(sid);
  const body = {};
  if (password !== undefined) body.currentPassword = password;
  if (next !== undefined) body.next = next;
  const res = await fetch(`${running.url}/api/auth/google/link`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers, ...cookieHeader(jar) }, body: JSON.stringify(body), redirect: 'manual',
  });
  absorb(jar, res.headers.getSetCookie?.() ?? []);
  const json = await res.json().catch(() => null);
  if (res.status !== 200) return { jar, rejected: { status: res.status, json } };
  const google = await hop(jar, json.url);
  if (google.status !== 302 || !google.location) throw new Error('Google refused the request: ' + google.status);
  return { jar, authUrl: json.url, callbackUrl: google.location };
}

const summary = (jar, location) => ({ location, flash: jar.get('edulet_flash') ?? null, sid: jar.get('edulet_sid') ?? null });

/** GET the callback URL (possibly tampered with) and report where the app sent the browser. */
export async function finishGoogle(jar, callbackUrl) {
  const r = await hop(jar, callbackUrl);
  if (r.status !== 302) throw new Error('callback did not redirect: ' + r.status);
  return summary(jar, r.location);
}

/** The whole sign-in, start to finish: { location, flash, sid, jar }. */
export async function walkGoogle(running, opts = {}) {
  const b = opts.mode === 'link' ? await beginLink(running, opts) : await beginGoogle(running, opts);
  if (b.rejected) return { rejected: b.rejected, flash: null, sid: opts.sid ?? null, jar: b.jar };
  const out = b.done ?? (await finishGoogle(b.jar, b.callbackUrl));
  return { ...out, jar: b.jar };
}
