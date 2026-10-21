// Link preview with SSRF defence. CONTRACT §5 "업로드·링크".
//  - http(s) only, every DNS answer checked, connection pinned to the checked answer (lookup hook),
//    redirects re-checked (max 3), 5s timeout, 512KB body cap, only text/html is parsed.
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { HttpError, bad } from './http.js';
import { normalizeUrl } from './util.js';

const MAX_BODY = 512 * 1024;
const MAX_REDIRECTS = 3;
const CACHE_MS = 10 * 60 * 1000;
const CACHE_MAX = 500;

// ---- IP classification ------------------------------------------------------

function parseIPv4(s) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return null;
  const p = m.slice(1).map(Number);
  return p.every((n) => n <= 255) ? p : null;
}

function blockedV4([a, b, c]) {
  return (
    a === 0 || a === 10 || a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

function parseIPv6(input) {
  let s = input.split('%')[0];
  if (s.includes('.')) {
    const i = s.lastIndexOf(':');
    const v4 = parseIPv4(s.slice(i + 1));
    if (!v4) return null;
    s = s.slice(0, i + 1) + ((v4[0] << 8) | v4[1]).toString(16) + ':' + ((v4[2] << 8) | v4[3]).toString(16);
  }
  const parts = s.split('::');
  if (parts.length > 2) return null;
  const head = parts[0] ? parts[0].split(':') : [];
  const tail = parts.length === 2 && parts[1] ? parts[1].split(':') : [];
  let groups;
  if (parts.length === 1) {
    if (head.length !== 8) return null;
    groups = head;
  } else {
    const fill = 8 - head.length - tail.length;
    if (fill < 1) return null;
    groups = [...head, ...Array(fill).fill('0'), ...tail];
  }
  const nums = groups.map((g) => (/^[0-9a-f]{1,4}$/i.test(g) ? parseInt(g, 16) : NaN));
  return nums.some(Number.isNaN) ? null : nums;
}

/** true when the address must never be fetched (loopback, private, link-local, CGNAT, multicast, ULA, ...). Unknown -> blocked. */
export function isBlockedIp(ip) {
  const addr = String(ip).replace(/^\[|\]$/g, '');
  if (net.isIPv4(addr)) return blockedV4(parseIPv4(addr));
  if (net.isIPv6(addr)) {
    const g = parseIPv6(addr);
    if (!g) return true;
    const v4 = (hi, lo) => blockedV4([hi >> 8, hi & 255, lo >> 8, lo & 255]);
    if (g.slice(0, 6).every((x) => x === 0)) return true; // ::, ::1, ::a.b.c.d (IPv4-compatible)
    if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return v4(g[6], g[7]); // ::ffff:a.b.c.d
    if (g[0] === 0x64 && g[1] === 0xff9b) return g.slice(2, 6).every((x) => x === 0) ? v4(g[6], g[7]) : true; // NAT64
    if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 ULA
    if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
    if ((g[0] & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local
    if ((g[0] & 0xff00) === 0xff00) return true; // multicast
    if (g[0] === 0x2001 && (g[1] === 0x0db8 || g[1] === 0)) return true; // documentation, Teredo
    if (g[0] === 0x2002) return v4(g[1], g[2]); // 6to4
    if (g[0] === 0x0100 && g[1] === 0 && g[2] === 0 && g[3] === 0) return true; // discard prefix
    return false;
  }
  return true;
}

export class BlockedUrlError extends Error {
  constructor(msg = 'blocked') { super(msg); this.code = 'ssrf_blocked'; }
}

// ---- URL classification --------------------------------------------------------

/** YouTube / Vimeo detection (pure). */
export function classifyVideo(urlStr) {
  let u;
  try { u = new URL(urlStr); } catch { return null; }
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  const seg = u.pathname.split('/').filter(Boolean);
  const yt = (id) => (id && /^[A-Za-z0-9_-]{11}$/.test(id)
    ? { provider: 'youtube', id, embedUrl: `https://www.youtube-nocookie.com/embed/${id}`, image: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`, site: 'YouTube' }
    : null);
  if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'music.youtube.com') {
    if (seg[0] === 'watch') return yt(u.searchParams.get('v'));
    if (['shorts', 'embed', 'live', 'v'].includes(seg[0])) return yt(seg[1]);
    return null;
  }
  if (host === 'youtu.be') return yt(seg[0]);
  const vm = (id) => (id && /^\d{3,12}$/.test(id)
    ? { provider: 'vimeo', id, embedUrl: `https://player.vimeo.com/video/${id}`, image: null, site: 'Vimeo' }
    : null);
  if (host === 'vimeo.com') return vm(seg.find((s) => /^\d{3,12}$/.test(s)));
  if (host === 'player.vimeo.com' && seg[0] === 'video') return vm(seg[1]);
  return null;
}

// ---- HTML parsing ---------------------------------------------------------------

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : '';
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}
const tidy = (s, max) => decodeEntities(String(s ?? '')).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

function parseAttrs(tag) {
  const out = {};
  const re = /([^\s=/>"']+)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  let m;
  const body = tag.replace(/^<\w+/, '');
  while ((m = re.exec(body))) out[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? '';
  return out;
}

function absHttp(v, base) {
  if (!v) return null;
  try {
    const u = new URL(decodeEntities(v).trim(), base);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch { return null; }
}

export function parseHtmlPreview(html, baseUrl) {
  const metas = {};
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    const a = parseAttrs(m[0]);
    const key = (a.property || a.name || '').toLowerCase();
    if (key && a.content != null && !(key in metas)) metas[key] = a.content;
  }
  const t = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return {
    title: tidy(metas['og:title'] || metas['twitter:title'] || (t ? t[1] : ''), 200),
    description: tidy(metas['og:description'] || metas['twitter:description'] || metas.description || '', 300),
    image: absHttp(metas['og:image'] || metas['twitter:image'] || metas['twitter:image:src'], baseUrl),
    site: tidy(metas['og:site_name'] || '', 100),
  };
}

function decodeBody(buf, contentType) {
  let label = /charset=["']?([\w-]+)/i.exec(contentType || '')?.[1];
  if (!label) label = /<meta[^>]+charset=["']?([\w-]+)/i.exec(buf.toString('latin1', 0, Math.min(buf.length, 4096)))?.[1];
  try { return new TextDecoder(label || 'utf-8').decode(buf); } catch { return buf.toString('utf8'); }
}

// ---- fetching --------------------------------------------------------------------

function fetchOnce(u, { allowPrivate, signal }) {
  return new Promise((resolve, reject) => {
    const host = u.hostname.replace(/^\[|\]$/g, '');
    if (net.isIP(host) && !allowPrivate && isBlockedIp(host)) return reject(new BlockedUrlError());
    const lookup = (hostname, options, cb) => {
      if (typeof options === 'function') { cb = options; options = {}; }
      dns.lookup(hostname, { all: true, verbatim: true }, (err, addrs) => {
        if (err) return cb(err);
        if (!allowPrivate && addrs.some((a) => isBlockedIp(a.address))) return cb(new BlockedUrlError());
        if (options && options.all) return cb(null, addrs);
        return cb(null, addrs[0].address, addrs[0].family);
      });
    };
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request({
      protocol: u.protocol,
      hostname: host,
      port: u.port || undefined,
      path: u.pathname + u.search,
      method: 'GET',
      agent: false,
      lookup,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; EduletLinkPreview/0.1)',
        Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1',
        'Accept-Language': 'ko,en;q=0.8',
        'Accept-Encoding': 'identity',
      },
    });
    const onAbort = () => req.destroy(new Error('timeout'));
    signal.addEventListener('abort', onAbort, { once: true });
    const done = (fn, v) => { signal.removeEventListener('abort', onAbort); fn(v); };
    req.on('error', (e) => done(reject, e));
    req.on('response', (res) => {
      const status = res.statusCode || 0;
      if ([301, 302, 303, 307, 308].includes(status) && res.headers.location) {
        res.resume();
        return done(resolve, { redirect: res.headers.location, status });
      }
      const chunks = [];
      let size = 0;
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        res.destroy();
        done(resolve, { status, headers: res.headers, body: Buffer.concat(chunks) });
      };
      res.on('data', (ch) => {
        size += ch.length;
        chunks.push(ch);
        if (size >= MAX_BODY) finish();
      });
      res.on('end', finish);
      res.on('error', (e) => { if (!finished) { finished = true; done(reject, e); } });
    });
    req.end();
  });
}

function hostMatches(allow, u) {
  if (allow === true) return true;
  if (!Array.isArray(allow)) return false;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const port = u.port || (u.protocol === 'https:' ? '443' : '80');
  return allow.includes(`${host}:${port}`) || allow.includes(host);
}

export class PreviewService {
  /**
   * @param {object} o
   * @param {boolean} o.enabled  EDULET_LINK_PREVIEW
   * @param {true|string[]} [o.allowPrivate] TEST ONLY — never wired to env/HTTP. true = all, or ['host:port'].
   * @param {Function} [o.fetcher] TEST ONLY — replaces the network fetch: (urlString) => {status, headers, body}
   */
  constructor({ enabled = true, allowPrivate = false, fetcher = null, timeoutMs = 5000 } = {}) {
    this.enabled = enabled;
    this.allowPrivate = allowPrivate;
    this.fetcher = fetcher;
    this.timeoutMs = timeoutMs;
    this.cache = new Map();
  }

  /** Fetch (following checked redirects) -> {status, headers, body, finalUrl}. Throws BlockedUrlError for SSRF. */
  async fetchPage(urlStr) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
    try {
      let current = new URL(urlStr);
      for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        if (current.protocol !== 'http:' && current.protocol !== 'https:') throw new BlockedUrlError('scheme');
        if (current.username || current.password) throw new BlockedUrlError('credentials');
        const allow = hostMatches(this.allowPrivate, current);
        const r = this.fetcher
          ? await this.fetcher(current.href)
          : await fetchOnce(current, { allowPrivate: allow, signal: ctl.signal });
        if (r.redirect) {
          if (hop === MAX_REDIRECTS) throw new Error('too many redirects');
          try { current = new URL(r.redirect, current); } catch { throw new BlockedUrlError('bad redirect'); }
          continue;
        }
        return { ...r, finalUrl: current.href };
      }
      throw new Error('too many redirects');
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Resolve a preview for an already-normalised http(s) URL.
   * @returns {Promise<{url, kind, title, description, image, site, embedUrl?}>}
   * @throws BlockedUrlError when the target is not allowed to be fetched
   */
  async resolve(urlStr) {
    const u = new URL(urlStr);
    const host = u.hostname.replace(/^\[|\]$/g, '').replace(/^www\./, '');
    const video = classifyVideo(urlStr);
    const base = {
      url: urlStr,
      kind: video ? 'video' : 'link',
      title: host,
      description: '',
      image: video?.image ?? null,
      site: video?.site ?? host,
      ...(video ? { embedUrl: video.embedUrl } : {}),
    };
    if (!this.enabled) return base;
    const hit = this.cache.get(urlStr);
    if (hit && hit.at > Date.now() - CACHE_MS) return hit.value;
    let page;
    try {
      page = await this.fetchPage(urlStr);
    } catch (e) {
      if (e instanceof BlockedUrlError || e?.code === 'ssrf_blocked') throw e;
      return { ...base, title: urlStr }; // network failure: degrade, do not cache
    }
    const ct = String(page.headers?.['content-type'] || '').toLowerCase();
    let value = { ...base, title: urlStr };
    if (page.status >= 200 && page.status < 300 && /^(text\/html|application\/xhtml\+xml)/.test(ct)) {
      const p = parseHtmlPreview(decodeBody(page.body, ct), page.finalUrl);
      value = {
        ...base,
        title: p.title || host,
        description: p.description,
        image: video?.image ?? p.image,
        site: p.site || base.site,
      };
    } else if (page.status >= 200 && page.status < 300 && ct.startsWith('image/')) {
      value = { ...base, title: host, image: urlStr };
    }
    if (this.cache.size >= CACHE_MAX) this.cache.delete(this.cache.keys().next().value);
    this.cache.set(urlStr, { at: Date.now(), value });
    return value;
  }

  /** Never throws: SSRF-blocked or failing targets yield a bare preview (used when saving posts). */
  async safeResolve(urlStr) {
    try {
      return await this.resolve(urlStr);
    } catch {
      const video = classifyVideo(urlStr);
      const host = new URL(urlStr).hostname;
      return {
        url: urlStr, kind: video ? 'video' : 'link', title: urlStr, description: '', image: video?.image ?? null,
        site: video?.site ?? host, ...(video ? { embedUrl: video.embedUrl } : {}),
      };
    }
  }
}

export function registerPreview(app) {
  app.router.add('POST', '/link-preview', async (c) => {
    if (!c.user) throw new HttpError(401, 'unauthorized', '로그인이 필요해요.');
    if (!app.rate.hit('lp:' + c.user.id, 20)) {
      throw new HttpError(429, 'rate_limited', '잠시 뒤에 다시 해 주세요.', { 'Retry-After': '60' });
    }
    const b = await c.body();
    const url = normalizeUrl(b.url);
    try {
      return await app.preview.resolve(url);
    } catch (e) {
      if (e instanceof BlockedUrlError || e?.code === 'ssrf_blocked') {
        throw bad('blocked_url', '이 주소는 미리보기를 가져올 수 없어요.');
      }
      throw e;
    }
  });
}

