// Configuration: environment variables (prefix EDULET_) + programmatic overrides (tests).
import path from 'node:path';

const FALSE_WORDS = ['0', 'false', 'off', 'no', ''];

function normalizeSeed(v) {
  if (v === undefined || v === null) return 'auto';
  if (v === false || v === 0) return 'off';
  if (v === true || v === 1) return 'on';
  const s = String(v).toLowerCase();
  if (s === 'auto') return 'auto';
  if (FALSE_WORDS.includes(s)) return 'off';
  return 'on';
}

/** '' or the origin of an http(s) address (path and trailing slash dropped); anything else is a startup error, not a silent default. */
function publicOrigin(v) {
  const s = String(v ?? '').trim();
  if (!s) return '';
  let u;
  try { u = new URL(s); } catch { u = null; }
  if (!u || (u.protocol !== 'http:' && u.protocol !== 'https:')) throw new Error(`EDULET_PUBLIC_URL 은 https://edulet.example.com 같은 주소여야 해요: ${s}`);
  return u.origin;
}

export function loadConfig(o = {}) {
  const env = process.env;
  const get = (k, d) => {
    const v = env['EDULET_' + k];
    return v === undefined || v === '' ? d : v;
  };
  const bool = (v) => !FALSE_WORDS.includes(String(v).toLowerCase());
  // positive number from the environment, falling back to the default on junk (never NaN/0 by accident)
  const num = (k, d) => {
    const n = Number(get(k, d));
    return Number.isFinite(n) && n > 0 ? n : d;
  };
  const cfg = {
    port: o.port ?? Number(get('PORT', 3000)),
    host: o.host ?? get('HOST', '0.0.0.0'),
    dataDir: path.resolve(o.dataDir ?? get('DATA_DIR', './data')),
    sessionDays: Number(get('SESSION_DAYS', 30)),
    maxUploadMb: Number(get('MAX_UPLOAD_MB', 20)),
    allowRegister: bool(get('ALLOW_REGISTER', '1')),
    seed: normalizeSeed(o.seed ?? get('SEED', 'auto')),
    trustProxy: bool(get('TRUST_PROXY', '0')),
    linkPreview: bool(get('LINK_PREVIEW', '1')),
    cookieSecure: String(get('COOKIE_SECURE', 'auto')).toLowerCase(), // auto | 1 | 0
    // abuse limits (CONTRACT §1) -------------------------------------------------
    uploadMaxConcurrent: num('UPLOAD_CONCURRENCY', 6), // uploads in flight, whole server
    uploadMaxPerUser: num('UPLOAD_PER_USER', 2), // uploads in flight, per user
    guestRateMax: num('GUEST_RATE', 300), // guest sign-ins per client address per minute (a whole class may share one school IP)
    uploadRateMax: num('UPLOAD_RATE', 30), // upload requests per user per 10 minutes
    uploadQuotaMb: num('UPLOAD_QUOTA_MB', 300), // bytes a user may upload per 24 hours
    sseMaxPerUser: num('SSE_PER_USER', 10), // open event streams per signed-in user
    sseMaxPerIp: num('SSE_PER_IP', 300), // open event streams per client address
    maxConnections: num('MAX_CONNECTIONS', 2000), // http server socket cap
    writeRateMax: num('WRITE_RATE', 240), // posts/comments/reactions/sections writes per user per minute
    boardMaxPosts: num('BOARD_MAX_POSTS', 5000), // posts per board
    loginFailMax: num('LOGIN_FAIL_MAX', 10), // failed logins per username per 15 minutes
    memberRateMax: num('MEMBER_RATE', 30), // member add / username lookups per user per minute
    // "Sign in with Google" (CONTRACT §5): on only when both the client id and its secret are set --------------
    googleClientId: String(get('GOOGLE_CLIENT_ID', '')).trim(),
    googleClientSecret: String(get('GOOGLE_CLIENT_SECRET', '')).trim(),
    publicUrl: publicOrigin(get('PUBLIC_URL', '')), // https://edulet.example.com — builds the OAuth redirect URI (else taken from the request)
    googleDomains: String(get('GOOGLE_DOMAINS', '')).split(',').map((d) => d.trim().toLowerCase().replace(/^@/, '')).filter(Boolean), // only these Google Workspace domains may sign in
    googleRateMax: num('GOOGLE_RATE', 300), // Google sign-in attempts per client address per minute (a whole class may share one school IP)
  };
  return Object.assign(cfg, o.config || {});
}
