// "Share" info for GET /config (CONTRACT §5 인증): the addresses other devices on the same network can use to reach this server.
// The server only hands out its own LAN addresses to someone who is demonstrably sitting at this machine (see lanVisible).
import os from 'node:os';
import { clientIp } from './http.js';

const MAX_LAN = 4;
const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
// adapters that other devices on the Wi-Fi/LAN cannot reach: they sort after real ones (a virtual adapter is a worse first guess)
const VIRTUAL_NIC = /vethernet|virtualbox|vbox|vmware|vmnet|hyper-v|wsl|docker|virbr|veth|tailscale|zerotier|bluetooth|npcap/i;
// headers a reverse proxy or tunnel adds; a request carrying any of them did not come straight from a browser on this PC
const PROXY_HEADER = /^(x-forwarded-|forwarded$|via$|x-original-forwarded-for$|x-real-ip$|x-client-ip$|x-cluster-client-ip$|x-azure-clientip$|x-arr-clientip$|cf-connecting-ip$|true-client-ip$|fastly-client-ip$)/;

/** Dotted quad -> [a,b,c,d], or null when it is not a valid IPv4 address. */
function parseIpv4(s) {
  const m = IPV4.exec(String(s ?? ''));
  if (!m) return null;
  const o = m.slice(1).map(Number);
  return o.every((n) => n <= 255) && m.slice(1).every((p) => p === String(Number(p))) ? o : null;
}

/** 127.0.0.0/8, ::1 and IPv4-mapped forms of those (what a dual-stack socket reports). */
export function isLoopbackIp(ip) {
  let s = String(ip ?? '').trim().toLowerCase();
  if (s.startsWith('::ffff:')) s = s.slice(7);
  if (s === '::1') return true;
  const o = parseIpv4(s);
  return !!o && o[0] === 127;
}

/** The hostname part of a Host header is exactly localhost, 127.x.x.x or [::1] (optionally with a port) — nothing looser. */
export function isLoopbackHostHeader(host) {
  const m = /^(localhost|\[::1\]|[0-9.]+)(?::\d{1,5})?$/i.exec(String(host ?? ''));
  if (!m) return false;
  const name = m[1].toLowerCase();
  if (name === 'localhost' || name === '[::1]') return true;
  const o = parseIpv4(name);
  return !!o && o[0] === 127;
}

/** config.host binds loopback only (nothing else on the network can connect). */
function isLoopbackBind(host) {
  const h = String(host ?? '').trim().toLowerCase();
  return h === 'localhost' || h === '::1' || h === '[::1]' || isLoopbackIp(h);
}

/** What the server accepts connections on: 'all' (0.0.0.0, ::), one IPv4 address, or null (a hostname / IPv6 address — unknown). */
function boundAddress(host) {
  const h = String(host ?? '').trim().toLowerCase();
  if (h === '0.0.0.0' || h === '::' || h === '[::]') return 'all';
  const o = parseIpv4(h);
  return o ? o.join('.') : null;
}

function viaProxy(req) {
  for (const k of Object.keys(req.headers || {})) if (PROXY_HEADER.test(k)) return true;
  return false;
}

/** 0 = 192.168/16, 1 = 10/8, 2 = 172.16/12, 3 = anything else (CGNAT, public, ...). */
function band([a, b]) {
  if (a === 192 && b === 168) return 0;
  if (a === 10) return 1;
  if (a === 172 && b >= 16 && b <= 31) return 2;
  return 3;
}

/**
 * `http://<ip>:<port>` for each IPv4 address of this machine that another device on the network could reach, best guess first.
 * Skips internal (loopback), link-local (169.254/16) and non-unicast addresses; private bands first, virtual adapters last;
 * de-duplicated, at most MAX_LAN. When config.host is one specific IPv4 address only that one is listed (the server does not
 * answer on the others); a hostname or IPv6 address as config.host gives [] (we cannot tell which NIC it is).
 */
export function lanOrigins(app, port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return [];
  const bound = boundAddress(app.config.host);
  if (!bound) return [];
  let nics;
  try { nics = app.networkInterfaces(); } catch { return []; }
  if (!nics || typeof nics !== 'object') return [];
  const found = [];
  for (const [name, list] of Object.entries(nics)) {
    if (!Array.isArray(list)) continue;
    for (const a of list) {
      if (!a || a.internal || (a.family !== 'IPv4' && a.family !== 4)) continue;
      const o = parseIpv4(a.address);
      if (!o || o[0] === 0 || o[0] === 127 || o[0] >= 224 || (o[0] === 169 && o[1] === 254)) continue;
      const ip = o.join('.');
      if (bound !== 'all' && ip !== bound) continue;
      found.push({ ip, virtual: VIRTUAL_NIC.test(name) ? 1 : 0, band: band(o) });
    }
  }
  found.sort((x, y) => x.virtual - y.virtual || x.band - y.band); // stable: the OS order breaks ties
  return [...new Set(found.map((f) => f.ip))].slice(0, MAX_LAN).map((ip) => `http://${ip}:${port}`);
}

/**
 * May this request be told the server's LAN addresses? All of these must hold (CONTRACT §5):
 *  - no public address is configured (PUBLIC_URL wins), and the server is bound beyond loopback;
 *  - the request names this PC as localhost (Host header) — DNS-rebinding pages and people on other devices name something else;
 *  - it carries no proxy/tunnel header, and its client address (clientIp, TRUST_PROXY aware) is loopback.
 * Anything doubtful means no: a wrong "no" only costs the teacher a hint, a wrong "yes" tells a stranger the server's inner address.
 */
function lanVisible(app, req) {
  const cfg = app.config;
  if (publicOrigin(app)) return false;
  if (isLoopbackBind(cfg.host)) return false;
  if (viaProxy(req)) return false;
  if (!isLoopbackHostHeader(req.headers?.host)) return false;
  return isLoopbackIp(clientIp(app, req));
}

/**
 * The configured public address, unless it names this PC itself (PUBLIC_URL=http://localhost:3000 is a common way to try Google
 * sign-in locally): such an address helps nobody else, so it must not pin every shared link and QR to "localhost".
 */
function publicOrigin(app) {
  const url = app.config.publicUrl;
  if (!url) return null;
  let host;
  try { host = new URL(url).host; } catch { return null; }
  return isLoopbackHostHeader(host) ? null : url;
}

/** `share` of GET /config: `{ origin: publicUrl|null, lan: string[] }`. */
export function shareInfo(app, req) {
  return {
    origin: publicOrigin(app),
    lan: lanVisible(app, req) ? lanOrigins(app, req.socket?.localPort) : [],
  };
}

/** The server-window hint printed after the local address, or null. Only config.host matters here (nobody is asking). */
export function startupLanLine(app, port) {
  if (app.quiet || isLoopbackBind(app.config.host)) return null;
  const lan = lanOrigins(app, port);
  return lan.length ? `같은 네트워크의 다른 기기에서는: ${lan.join(' 또는 ')}` : null;
}

export const defaultNetworkInterfaces = () => os.networkInterfaces();
