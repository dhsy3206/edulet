// Which address does a shared link (and its QR code) point at?
//
//   'public'  the server was told its public address (EDULET_PUBLIC_URL) and sent it as config.share.origin
//   'lan'     this page is open on localhost and the server listed addresses other devices on the same network can use
//   'here'    anything else: the address this page is open on (location.origin)
//
// A teacher who opens http://localhost:3000 would otherwise copy a link that nobody else can open. The server decides what to
// offer (GET /config → share: { origin, lan }, CONTRACT §5); this module only checks that what it was handed is a plain
// http(s) origin before it becomes a link, a QR code or an <a href> — a value that is not (javascript:, a path, credentials,
// spaces …) is ignored, never repaired. In the static demo nothing is shared at all (the data lives in this browser only).
import { store } from './store.js';
import { DEMO } from './base.js';

const MAX_LAN = 8; // the server sends at most 4; more would only crowd the picker

/** 'http://host[:port]' exactly as URL.origin would print it, else null. No path, no trailing slash, no credentials, no spaces. */
export function validOrigin(value) {
  if (typeof value !== 'string' || !value || value.length > 300) return null;
  let u;
  try {
    u = new URL(value);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.username || u.password || !u.hostname) return null;
  // a hostname is letters, digits, dots and hyphens (or a bracketed IPv6 address) — the URL parser also lets quotes, backticks … through
  if (!/^(\[[0-9a-f:.]+\]|[a-z0-9]([a-z0-9.-]*[a-z0-9])?)$/i.test(u.hostname)) return null;
  return u.origin === value ? value : null; // equality also rejects '/path', '?q', '#h', surrounding blanks and a default ':80'
}

/** localhost / 127.x.x.x / [::1] (and 0.0.0.0): an address only this PC can use. */
export function isLoopbackHost(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  return h === 'localhost' || h.endsWith('.localhost') || h === '::1' || h === '::ffff:127.0.0.1' || h === '0.0.0.0' || /^127(\.\d{1,3}){3}$/.test(h);
}

/**
 * → { base, source: 'public'|'lan'|'here', lan: string[], loopback, demo }
 *   base      the origin links and QR codes are built on
 *   lan       the validated LAN addresses (empty unless source is 'lan'), for a picker
 *   loopback  this page is open on a loopback address; with source 'here' that means "the link only works on this PC"
 *   demo      static Pages build: the board lives in this browser only
 * `pick` is an address the user chose from `lan` in the open dialog (kept by the caller, never stored); anything else is ignored.
 * `hostname` is the address this page is open on (only a test passes it).
 */
export function shareInfo(pick, hostname = location.hostname) {
  const cfg = store.config;
  const demo = DEMO || !!(cfg && cfg.demo);
  const loopback = isLoopbackHost(hostname);
  const share = !demo && cfg && cfg.share && typeof cfg.share === 'object' ? cfg.share : null;
  const pub = share ? validOrigin(share.origin) : null;
  if (pub) return { base: pub, source: 'public', lan: [], loopback, demo };
  const lan = [];
  if (share && loopback && Array.isArray(share.lan)) {
    for (const a of share.lan) {
      const o = validOrigin(a);
      if (o && !lan.includes(o) && lan.length < MAX_LAN) lan.push(o);
    }
  }
  if (lan.length) return { base: lan.includes(pick) ? pick : lan[0], source: 'lan', lan, loopback, demo };
  return { base: location.origin, source: 'here', lan: [], loopback, demo };
}

/** The origin to put in front of a path when building a link or QR code (see shareInfo). */
export const shareOrigin = (pick) => shareInfo(pick).base;
