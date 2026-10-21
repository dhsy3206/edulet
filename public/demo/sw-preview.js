/* Edulet demo server — link previews (server/preview.js, simplified).
 * A browser cannot read other sites' HTML (CORS), so plain links get a host-only preview — exactly what the Node server
 * returns with EDULET_LINK_PREVIEW=0. YouTube / Vimeo links keep their embed URL and thumbnail (pure URL parsing) and try the
 * public oEmbed endpoint for the real title; any failure is ignored. No SSRF machinery: the demo never fetches arbitrary URLs. */
(function (E) {
  'use strict';
  const { bad } = E;

  /** YouTube / Vimeo detection (pure) — copied from server/preview.js. */
  function classifyVideo(urlStr) {
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

  /** Public oEmbed endpoints (fixed hosts); the video id is validated by classifyVideo first. */
  const OEMBED = {
    youtube: (v) => `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent('https://www.youtube.com/watch?v=' + v.id)}`,
    vimeo: (v) => `https://vimeo.com/api/oembed.json?url=${encodeURIComponent('https://vimeo.com/' + v.id)}`,
  };
  const CACHE_MS = 10 * 60 * 1000;
  const cache = new Map(); // url → { at, value }

  /** The preview stored/returned when nothing better is known: just the URL as title (barePreview in the Node server). */
  function barePreview(urlStr) {
    const video = classifyVideo(urlStr);
    return {
      url: urlStr, kind: video ? 'video' : 'link', title: urlStr, description: '', image: video?.image ?? null,
      site: video?.site ?? new URL(urlStr).hostname, ...(video ? { embedUrl: video.embedUrl } : {}),
    };
  }

  /** Block what the Node server blocks from the URL text alone: credentials, localhost names, private literal IPs. */
  function checkBlocked(urlStr) {
    const u = new URL(urlStr);
    const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
    let blocked = !!(u.username || u.password) || host === 'localhost' || host.endsWith('.localhost') || host.includes(':'); // IPv6 literal
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
    if (m) {
      const [a, b, c] = m.slice(1).map(Number);
      blocked = blocked || a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
        (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 0 && (c === 0 || c === 2)) || (a === 192 && b === 168) ||
        (a === 198 && (b === 18 || b === 19)) || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113) || a >= 224;
    }
    if (blocked) throw bad('blocked_url', '이 주소는 미리보기를 가져올 수 없어요.');
  }

  async function oembed(video, base) {
    const endpoint = OEMBED[video.provider];
    if (!endpoint) return null;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 4000);
    try {
      const r = await fetch(endpoint(video), { mode: 'cors', credentials: 'omit', signal: ctl.signal });
      if (!r.ok) return null;
      const j = await r.json();
      const clip = (s, n) => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim().slice(0, n) : '');
      const title = clip(j.title, 200);
      if (!title) return null;
      const thumb = typeof j.thumbnail_url === 'string' && /^https:\/\//i.test(j.thumbnail_url) ? j.thumbnail_url.slice(0, 500) : null;
      return { ...base, title, description: clip(j.author_name, 300), image: video.image ?? thumb };
    } catch {
      return null; // offline, blocked, no CORS…: fall back to the host-only preview
    } finally {
      clearTimeout(timer);
    }
  }

  /** Preview for an already-normalised http(s) URL → { url, kind, title, description, image, site, embedUrl? }. */
  async function resolve(urlStr) {
    checkBlocked(urlStr);
    const u = new URL(urlStr);
    const host = u.hostname.replace(/^\[|\]$/g, '').replace(/^www\./, '');
    const video = classifyVideo(urlStr);
    const base = {
      url: urlStr, kind: video ? 'video' : 'link', title: host, description: '', image: video?.image ?? null,
      site: video?.site ?? host, ...(video ? { embedUrl: video.embedUrl } : {}),
    };
    if (!video) return base;
    const hit = cache.get(urlStr);
    if (hit && hit.at > Date.now() - CACHE_MS) return hit.value;
    const value = (await oembed(video, base)) || base;
    if (cache.size >= 200) cache.delete(cache.keys().next().value);
    cache.set(urlStr, { at: Date.now(), value });
    return value;
  }

  /** Never throws: used when saving posts (a failing preview must not block saving). */
  async function safeResolve(urlStr) {
    try {
      return await resolve(urlStr);
    } catch {
      return barePreview(urlStr);
    }
  }

  E.preview = { classifyVideo, barePreview, resolve, safeResolve };
})((self.EDU = self.EDU || {}));
