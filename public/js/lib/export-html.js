// Offline HTML export (docs/CONTRACT.md §5 "HTML 오프라인 파일"): turns the board's export JSON + the files it points at into ONE
// static .html page that opens from a double-click with no server and no internet.
//
//   buildOfflineHtml({ data, files, options, now }) → string        buildOfflineParts(...) → string[]  (same text, big data: URLs kept apart)
//     data    the JSON of GET /boards/:slug/export?format=json (already shaped for the viewer: authors hidden, login names dropped)
//     files   Map  /uploads/<id>/<name> → { mime, name, size?, dataUrl: 'data:…;base64,…' | null, skipped?: reason, width?, height? }
//     options { timeZone? }          now  Date | ms (the "exported at" stamp)
//
// This file is PURE: no DOM, no network, no imports but constants — it runs in node:test (test/export-html.test.js) as it does in the
// browser. The page it writes carries ZERO scripts and a Content-Security-Policy that forbids everything but data: media, so even a
// hostile post cannot run anything when the file is opened from file://. Every user-controlled value goes through esc() — there is
// no other way text reaches the markup — and links are only ever absolute http(s) URLs.
import { WALLPAPERS, DARK_WALLPAPERS, POST_COLORS, EMOJIS, FORMATS, SECTIONED, FONTS, REACTIONS } from './constants.js';

/* ───────── limits (shared with the browser-side loader, public/js/lib/export-offline.js) ───────── */
export const MB = 1024 * 1024;
/**
 * fileBytes   one embedded file (after shrinking pictures): the server accepts 20 MB uploads (the static demo 10 MB); 15 MB leaves every
 *             demo file and nearly every real one in, and as a data: URL (×4/3 = 20 MB) it still downloads fine from the page — measured in
 *             Chrome: <a download href="data:…"> saves 40 MB intact.
 * totalBytes  everything embedded, before base64 (the .html is about 4/3 of this + text). 150 MB: a 100 MB page opened in 1 s in Chrome
 *             (measured), so the reader is not the limit — the browser that BUILDS it is: base64 strings + the Blob are held at once
 *             (≈ 2× the file), which a school PC with 8 GB takes, a 4 GB Chromebook starts to feel.
 * imageMax    long side of a picture after shrinking (px). A 1600 px WebP/JPEG is 150–400 KB: 100 photos ≈ 30 MB.
 * textBytes  the markup + text of the page (cards, titles, comments — everything except embedded files). A full board (5000 cards × 10,000 characters)
 *             is 50 MB, so this only stops a board with an absurd number of comments; going over it ends the export with a message (no file is made).
 * wallpaperMax  the board's own background photo is only a backdrop.
 * concurrency pictures/files processed at once (decoding a 12-megapixel photo costs ~50 MB transiently).
 */
export const EXPORT_LIMITS = Object.freeze({ fileBytes: 15 * MB, totalBytes: 150 * MB, textBytes: 100 * MB, imageMax: 1600, wallpaperMax: 1280, concurrency: 3 });

/** Why a file is not inside the page → the sentence shown in its place. */
export const SKIP_TEXT = Object.freeze({
  too_large: '용량이 커서 담지 못했어요',
  budget: '전체 용량 한도를 넘어 담지 못했어요',
  failed: '불러오지 못해 담지 못했어요',
  excluded: '설정에 따라 담지 않았어요',
  unsupported: '담을 수 없는 형식이에요',
  undecodable: '열 수 없는 그림이라 담지 못했어요',
});

/** Counts what goes in, file by file, against the per-file and total limits. take(size) → null (fits, counted) | 'too_large' | 'budget'. */
export class Budget {
  constructor({ fileBytes = EXPORT_LIMITS.fileBytes, totalBytes = EXPORT_LIMITS.totalBytes } = {}) {
    this.fileBytes = fileBytes;
    this.totalBytes = totalBytes;
    this.used = 0;
  }
  take(size) {
    const n = Number(size);
    if (!Number.isFinite(n) || n < 0) return 'failed';
    if (n > this.fileBytes) return 'too_large';
    if (this.used + n > this.totalBytes) return 'budget';
    this.used += n;
    return null;
  }
  get left() {
    return Math.max(0, this.totalBytes - this.used);
  }
}

/** The policy of the page. Exported so the test can check the exact text. */
export const CSP = "default-src 'none'; img-src data:; media-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";

/* ───────── escaping & small helpers ───────── */
const ENT = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;', '\u2028': '&#8232;', '\u2029': '&#8233;' };
// C0/C1 controls except tab/newline/CR (U+0001 is also the placeholder of the big-data splice below, so it can never come from user text)
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;
/** HTML-escape any value for text AND double-quoted attribute positions. */
export function esc(v) {
  return String(v ?? '').replace(CONTROL, '').replace(/[&<>"'`\u2028\u2029]/g, (ch) => ENT[ch]);
}

/** A link target: absolute http(s) only, no credentials, no whitespace. Returns the normalised href, or null. */
export function safeHttpUrl(u) {
  if (typeof u !== 'string') return null;
  const s = u.trim();
  if (!s || s.length > 2048 || /[\u0000-\u0020\u007f-\u009f\u2028\u2029\\]/.test(s)) return null;
  let x;
  try {
    x = new URL(s);
  } catch {
    return null;
  }
  if (x.protocol !== 'http:' && x.protocol !== 'https:') return null;
  if (x.username || x.password) return null;
  return x.href;
}
const hostOf = (href) => {
  try {
    return new URL(href).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
};

// a name that is safe to show and to hand to <a download>: no path separators, controls or bidi tricks
// zero-width and bidi-control characters are removed (they make "photo.exe" look like "photo.pdf" or hide a name); path separators and the like become "_"
const INVISIBLE = /[\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\u061c\ufeff]/g;
const cleanName = (n) => String(n ?? '').replace(INVISIBLE, '').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\\/:*?"<>|]/g, '_').trim().slice(0, 120);
const nameFromUrl = (url) => {
  const last = String(url ?? '').split(/[?#]/)[0].split('/').pop() || '';
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
};
const fmtBytes = (n) => {
  n = Number(n);
  if (!Number.isFinite(n) || n < 0) return '';
  if (n < 1024) return n + ' B';
  if (n < MB) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' KB';
  return (n / MB).toFixed(1) + ' MB';
};
const ext = (name) => {
  const m = /\.([A-Za-z0-9]{1,5})$/.exec(name || '');
  return m ? m[1].toUpperCase() : '';
};
const isoOf = (ms) => {
  try {
    return new Date(Number(ms)).toISOString();
  } catch {
    return '';
  }
};
const colorOf = (c) => (typeof c === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(c) ? c : '#64748b');

/* ───────── "rich" text: the same small markdown subset as public/js/lib/markdown.js, written as strings ───────── */
// (that module builds DOM nodes; the e2e run renders a corpus through both and compares — S9)
const TOKEN = /(\*\*[^*\n]+?\*\*)|(\*[^*\n]+?\*)|(`[^`\n]+`)|(https?:\/\/[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+)/g;
const LINK_REL = 'noopener noreferrer nofollow ugc';

// A URL longer than this is not made a link (text instead) — checked BEFORE trimming, so the trimming below can never be fed a huge tail.
const URL_MAX = 2048;
const URL_TAIL = new Set(['.', ',', ';', ':', '!', '?', "'", '"', ')', ']']);
// Punctuation that ends a sentence rather than the address is cut off the end — in ONE pass (the brackets are counted once and given up one
// by one; a ")" is kept while the address still has more "(" than ")" left, e.g. a Wikipedia title). Same rule as always, linear in the length.
export function trimUrl(url) {
  let end = url.length;
  let open = 0;
  let close = 0;
  for (let i = 0; i < end; i++) {
    const ch = url.charCodeAt(i);
    if (ch === 40) open++;
    else if (ch === 41) close++;
  }
  while (end > 0 && URL_TAIL.has(url[end - 1])) {
    if (url[end - 1] === ')') {
      if (open >= close) break;
      close--;
    }
    end--;
  }
  return [url.slice(0, end), url.slice(end)];
}
const linkHtml = (href, label) => `<a href="${esc(href)}" target="_blank" rel="${LINK_REL}" class="rich-link">${esc(label)}</a>`;

function inlineHtml(text) {
  let out = '';
  let last = 0;
  const re = new RegExp(TOKEN.source, 'g');
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) out += esc(text.slice(last, m.index));
    if (m[1]) out += `<strong>${esc(m[1].slice(2, -2))}</strong>`;
    else if (m[2]) out += `<em>${esc(m[2].slice(1, -1))}</em>`;
    else if (m[3]) out += `<code>${esc(m[3].slice(1, -1))}</code>`;
    else if (m[4]) {
      if (m[4].length > URL_MAX) out += esc(m[4]);
      else {
        const [u, tail] = trimUrl(m[4]);
        // the address is written as typed (like markdown.js does) once it has proved to be a plain absolute http(s) URL
        out += safeHttpUrl(u) ? linkHtml(u, u) : esc(u);
        if (tail) out += esc(tail);
      }
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) out += esc(text.slice(last));
  return out;
}

/** Paragraphs / line breaks · **bold** · *italic* · `code` · "- " lists · auto-linked http(s) URLs — everything else is plain text. */
export function renderRichHtml(text) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  let out = '';
  let para = false;
  let list = false;
  for (const line of lines) {
    if (!line.trim()) {
      if (para) out += '</p>';
      if (list) out += '</ul>';
      para = list = false;
      continue;
    }
    const li = /^\s*[-*•]\s+(.*)$/.exec(line);
    if (li) {
      if (para) {
        out += '</p>';
        para = false;
      }
      if (!list) {
        out += '<ul class="rich-list">';
        list = true;
      }
      out += `<li>${inlineHtml(li[1])}</li>`;
      continue;
    }
    if (list) {
      out += '</ul>';
      list = false;
    }
    if (!para) {
      out += '<p class="rich-p">';
      para = true;
    } else out += '<br>';
    out += inlineHtml(line);
  }
  if (para) out += '</p>';
  if (list) out += '</ul>';
  return out;
}

/* ───────── which uploaded files the page needs ───────── */
// a file of this app: a server upload (32 hex) or one of the static demo's seed files (seed-<n>); /uploads/<id>/<name>, the name without / ? # \
// (a name that is only dots — "." ".." "%2e%2e" — would be folded away by the URL parser and point at /uploads/ itself: not a file, not fetched)
export const UPLOAD_URL = /^\/uploads\/(?:[0-9a-f]{32}|seed-\d{1,6})\/(?!(?:\.|%2[eE]){1,2}$)[^/?#\\]{1,400}$/;
/** Anything under /uploads/ belongs to this app, even when its shape is not one the loader knows how to fetch — that one is reported, not hidden. */
export const isLocalUrl = (u) => typeof u === 'string' && u.startsWith('/uploads/');

/**
 * Every file of this server the export JSON points at, once each, in the order it will be needed:
 * the board's own background, then each card's attachment and its (locally stored) preview picture.
 * → [{ url, role: 'wallpaper'|'image'|'file'|'preview', name, mime, size, ok }]. `ok` = the address has a shape the loader may fetch (UPLOAD_URL);
 * an /uploads/… address that is not ok is listed all the same so it can be reported as "not included". Remote URLs are not listed — never embedded.
 */
export function collectUploadRefs(data) {
  const seen = new Set();
  const out = [];
  const add = (url, role, extra = {}) => {
    if (!isLocalUrl(url) || seen.has(url)) return;
    seen.add(url);
    out.push({ url, role, name: cleanName(extra.name) || cleanName(nameFromUrl(url)), mime: extra.mime || '', size: Number.isFinite(Number(extra.size)) ? Number(extra.size) : null, ok: UPLOAD_URL.test(url) });
  };
  add(data?.board?.wallpaper, 'wallpaper', { name: '배경 그림' });
  for (const p of Array.isArray(data?.posts) ? data.posts : []) {
    const a = p?.attachment;
    if (!a || typeof a !== 'object') continue;
    add(a.url, a.kind === 'image' ? 'image' : 'file', a);
    if (a.preview && typeof a.preview === 'object') add(a.preview.image, 'preview', { name: '미리보기 그림' });
  }
  return out;
}

/** What went into the page and what did not: { images, files, bytes, skipped: [{ url, name, reason }] }. */
export function summarizeFiles(files) {
  const s = { images: 0, files: 0, bytes: 0, skipped: [] };
  const entries = files instanceof Map ? files : new Map(Object.entries(files || {}));
  for (const [url, e] of entries) {
    if (e && e.dataUrl) {
      if (/^data:image\//i.test(e.dataUrl)) s.images++;
      else s.files++;
      s.bytes += Number.isFinite(Number(e.size)) ? Number(e.size) : 0;
    } else s.skipped.push({ url, name: cleanName(e && e.name) || cleanName(nameFromUrl(url)), reason: (e && e.skipped) || 'failed' });
  }
  return s;
}

/** edulet-<slug>-YYYYMMDD.html (the date is the reader's local date). */
export function offlineFilename(slug, now = new Date()) {
  const d = now instanceof Date ? now : new Date(now);
  const p = (n) => String(n).padStart(2, '0');
  const safe = String(slug ?? '').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 60) || 'board';
  return `edulet-${safe}-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}.html`;
}

/* ───────── data: URLs ───────── */
const IMG_MIME = /^image\/(png|jpeg|gif|webp)$/;
const VIDEO_MIME = /^video\/(mp4|webm|ogg|quicktime)$/;
const AUDIO_MIME = /^audio\/(mpeg|mp3|mp4|ogg|wav|x-wav|webm|aac|flac|x-m4a)$/;

// → { mime, payload } for a base64 data: URL whose payload is plain base64 (so it can never leave an attribute), else null
function parseDataUrl(du) {
  if (typeof du !== 'string') return null;
  const m = /^data:([a-zA-Z0-9][a-zA-Z0-9.+-]*\/[a-zA-Z0-9][a-zA-Z0-9.+-]*)(?:;[a-zA-Z0-9=.+-]+)*;base64,/.exec(du);
  if (!m) return null;
  const payload = du.slice(m[0].length);
  if (/[^A-Za-z0-9+/=]/.test(payload)) return null;
  return { mime: m[1].toLowerCase(), payload };
}

/* ───────── wallpaper & palette (the app's own tokens, public/css/base.css) ───────── */
const WALLPAPER_BG = {
  green: 'radial-gradient(ellipse 60% 55% at 72% 38%, rgb(214 201 28 / 0.95) 0%, rgb(214 201 28 / 0) 62%), radial-gradient(ellipse 50% 60% at 6% 70%, rgb(120 200 60 / 0.6) 0%, rgb(120 200 60 / 0) 70%), linear-gradient(165deg, #36b04b 0%, #1f9a49 42%, #0a7a3e 100%)',
  ocean: 'radial-gradient(ellipse 60% 50% at 80% 20%, rgb(125 211 252 / 0.7), transparent 65%), linear-gradient(160deg, #38bdf8 0%, #2563eb 50%, #1e3a8a 100%)',
  sunset: 'radial-gradient(ellipse 70% 50% at 20% 90%, rgb(253 224 71 / 0.7), transparent 65%), linear-gradient(165deg, #fb7185 0%, #f97316 45%, #7c3aed 100%)',
  lavender: 'radial-gradient(ellipse 55% 50% at 75% 25%, rgb(244 114 182 / 0.45), transparent 65%), linear-gradient(160deg, #a78bfa 0%, #7c3aed 55%, #4c1d95 100%)',
  slate: 'linear-gradient(160deg, #64748b 0%, #334155 55%, #0f172a 100%)',
  paper: 'radial-gradient(circle at 20% 20%, #fffaf0 0%, #f6efe3 60%, #ece3d2 100%)',
  mint: 'radial-gradient(ellipse 60% 50% at 20% 20%, rgb(255 255 255 / 0.7), transparent 70%), linear-gradient(160deg, #a7f3d0 0%, #6ee7b7 50%, #34d399 100%)',
  rose: 'radial-gradient(ellipse 60% 50% at 80% 80%, rgb(255 255 255 / 0.55), transparent 70%), linear-gradient(160deg, #fecdd3 0%, #fda4af 50%, #fb7185 100%)',
  night: 'radial-gradient(circle at 18% 22%, rgb(99 102 241 / 0.5), transparent 45%), radial-gradient(circle at 82% 70%, rgb(14 165 233 / 0.3), transparent 50%), linear-gradient(170deg, #1e1b4b 0%, #0b1020 100%)',
  sunrise: 'radial-gradient(ellipse 70% 55% at 50% 100%, rgb(254 240 138 / 0.95), transparent 70%), linear-gradient(180deg, #7dd3fc 0%, #fde68a 55%, #fdba74 100%)',
};
const TAB_BG = { green: '#0a5c3a', ocean: '#12356f', sunset: '#6d2a63', lavender: '#3b1d78', slate: '#334155', night: '#3a3f6b', mint: '#0f6b4c', rose: '#8f2540', sunrise: '#8a5a12', paper: '#5b4b32', custom: '#1e293b' };
const FONT_STACK = {
  sans: "'Pretendard','Noto Sans KR','Apple SD Gothic Neo','Malgun Gothic',system-ui,-apple-system,'Segoe UI',Roboto,sans-serif",
  serif: "'Noto Serif KR','Nanum Myeongjo','Batang',Georgia,'Times New Roman',serif",
  mono: "'D2Coding','Consolas','Menlo','Courier New',monospace",
  rounded: "'Jua','Nanum Gothic','Malgun Gothic','Trebuchet MS',system-ui,sans-serif",
};

/* ───────── the page ───────── */
function makeCtx({ data, files, options, now }) {
  const d = data && typeof data === 'object' ? data : {};
  const board = d.board && typeof d.board === 'object' ? d.board : {};
  const settings = board.settings && typeof board.settings === 'object' ? board.settings : {};
  const entries = files instanceof Map ? files : new Map(Object.entries(files || {}));
  const opt = options && typeof options === 'object' ? options : {};
  const tz = typeof opt.timeZone === 'string' && opt.timeZone ? opt.timeZone : undefined;
  let nowMs = now instanceof Date ? now.getTime() : Number(now);
  if (!Number.isFinite(nowMs)) nowMs = Date.parse(d.exportedAt) || 0;
  let fmt = null;
  try {
    fmt = new Intl.DateTimeFormat('ko-KR', { dateStyle: 'medium', timeStyle: 'short', timeZone: tz });
  } catch { /* unknown time zone / no ICU → ISO text */ }
  const format = FORMATS.includes(board.format) ? board.format : 'wall';
  return {
    data: d, board, settings, entries, nowMs,
    format,
    sections: (Array.isArray(d.sections) ? d.sections : []).filter((s) => s && typeof s === 'object'),
    posts: (Array.isArray(d.posts) ? d.posts : []).filter((p) => p && typeof p === 'object'),
    showAuthor: settings.showAuthor !== false,
    reactionKind: REACTIONS.includes(settings.reactions) ? settings.reactions : 'like',
    scheme: board.colorScheme === 'dark' ? 'dark' : 'light',
    font: FONTS.includes(board.font) ? board.font : 'sans',
    time: (ms) => {
      const n = Number(ms);
      if (!Number.isFinite(n)) return '';
      try {
        return fmt ? fmt.format(n) : new Date(n).toISOString();
      } catch {
        return '';
      }
    },
    bigs: [], // data: URLs kept out of the markup string until the very end (see toParts)
    photoNo: 0,
    commentsTotal: 0,
    textLimit: Number(opt.textBytes) > 0 ? Number(opt.textBytes) : EXPORT_LIMITS.textBytes,
    outLen: 0, // characters of cards written so far (checked against textLimit while building)
    since: 0, // …since the build last yielded
  };
}

/** The export would be larger than the page can hold: a message for the user, and no file. */
export class ExportTooLargeError extends Error {
  constructor(bytes, limit) {
    super(`글과 댓글이 너무 많아 한 파일로 담을 수 없어요 (약 ${Math.max(1, Math.round(bytes / MB))}MB, 한도 ${Math.round(limit / MB)}MB). 보드를 나눠서 내보내 주세요.`);
    this.name = 'ExportTooLargeError';
    this.code = 'export_too_large';
  }
}

/**
 * About how many bytes the text of the page will take, from the export JSON alone (titles, bodies, comments + ~1.5 KB of markup per card,
 * ~0.6 KB per comment). Cheap enough to run before a single picture is fetched; the build checks the real size again while it writes.
 */
export function estimateTextBytes(data) {
  const posts = Array.isArray(data && data.posts) ? data.posts : [];
  let n = 4096 + String((data && data.board && data.board.description) || '').length;
  for (const p of posts) {
    if (!p || typeof p !== 'object') continue;
    n += 1500 + String(p.title ?? '').length + String(p.body ?? '').length;
    const cs = Array.isArray(p.comments) ? p.comments : [];
    for (const cm of cs) n += 600 + String((cm && cm.body) ?? '').length;
  }
  return n;
}

const abortError = () => new DOMException('취소했어요.', 'AbortError');
// the build gives the browser back to the page about every megabyte of cards (async driver below)
const YIELD_CHARS = 1024 * 1024;

// A data: URL is spliced in at the end, so the big strings are never copied into one giant page string.
const BIG = 4096;
function splice(c, dataUrl) {
  if (dataUrl.length <= BIG) return dataUrl;
  c.bigs.push(dataUrl);
  return `\u0001${c.bigs.length - 1}\u0001`;
}
function toParts(html, bigs) {
  const parts = [];
  const re = /\u0001(\d+)\u0001/g;
  let last = 0;
  let m;
  while ((m = re.exec(html))) {
    if (m.index > last) parts.push(html.slice(last, m.index));
    parts.push(bigs[Number(m[1])]);
    last = m.index + m[0].length;
  }
  if (last < html.length) parts.push(html.slice(last));
  return parts;
}

const skipLine = (c, name, reason, icon = '📎') =>
  `<p class="skip-note">${icon} ${esc(SKIP_TEXT[reason] || SKIP_TEXT.failed)}: ${esc(name)}</p>`;

// → the embeddable payload of an uploaded file, or { skipped } with the reason
function fileFor(c, url) {
  const e = c.entries.get(url);
  if (!e) return { skipped: 'failed', entry: null };
  if (!e.dataUrl) return { skipped: e.skipped || 'failed', entry: e };
  const parsed = parseDataUrl(e.dataUrl);
  if (!parsed) return { skipped: 'failed', entry: e };
  // mime = what the bytes really are (the data: URL's own type); declared = what the uploader said (decides video/audio players)
  return { entry: e, mime: parsed.mime, declared: String(e.mime || parsed.mime).toLowerCase(), payload: parsed.payload };
}

function imgTag(c, mime, payload, { alt, cls, w, h }) {
  const src = splice(c, `data:${mime};base64,${payload}`);
  const W = Math.round(Number(w));
  const H = Math.round(Number(h));
  const ratio = Number.isFinite(W) && Number.isFinite(H) && W > 0 && H > 0 && W < 100000 && H < 100000 ? ` style="aspect-ratio:${W}/${H}"` : '';
  return `<img${cls ? ` class="${cls}"` : ''} src="${src}" alt="${esc(alt)}" loading="lazy" decoding="async"${ratio}>`;
}

function imageHtml(c, a, post) {
  const href = safeHttpUrl(a.url);
  const name = cleanName(a.name) || cleanName(nameFromUrl(a.url)) || '그림';
  if (!isLocalUrl(a.url)) {
    // a picture hosted elsewhere: never fetched, so the page makes no request when it is opened
    const host = href ? hostOf(href) : '';
    return `<p class="skip-note">🖼 외부 그림은 담지 않았어요${host ? `: ${href ? `<a href="${esc(href)}" target="_blank" rel="${LINK_REL}">${esc(host)}</a>` : esc(host)}` : ''}</p>`;
  }
  const f = fileFor(c, a.url);
  if (f.skipped || !IMG_MIME.test(f.mime)) return skipLine(c, name, f.skipped || 'unsupported', '🖼');
  const n = ++c.photoNo;
  const alt = a.name || post.title || '첨부 그림';
  return `<figure class="ph" id="ph${n}"><a class="ph-close" href="#x" aria-label="닫기"><span>✕ 닫기</span></a>`
    + `<a class="ph-open" href="#ph${n}" aria-label="크게 보기: ${esc(alt)}">${imgTag(c, f.mime, f.payload, { alt, w: f.entry.width, h: f.entry.height })}</a></figure>`;
}

// a small local picture beside a link/file card (never a remote one)
function previewThumb(c, a) {
  const url = a.preview && a.preview.image;
  if (!isLocalUrl(url)) return '';
  const f = fileFor(c, url);
  if (f.skipped || !IMG_MIME.test(f.mime)) return '';
  return imgTag(c, f.mime, f.payload, { alt: '', cls: 'thumb', w: f.entry.width, h: f.entry.height });
}

function linkCardHtml(c, a, { video = false } = {}) {
  const p = a.preview && typeof a.preview === 'object' ? a.preview : {};
  const href = safeHttpUrl(a.url);
  const host = href ? hostOf(href) : '';
  const title = String(p.title || a.name || host || a.url || '링크');
  const body = `${previewThumb(c, a)}<span class="site">${video ? '▶ 영상' : '🔗 링크'} · ${esc(p.site || host || '')}</span><span class="lt">${esc(title)}</span>`
    + (p.description ? `<span class="ld">${esc(p.description)}</span>` : '')
    + (video ? '<span class="ld">인터넷에 연결하면 링크로 볼 수 있어요.</span>' : '');
  if (!href) return `<div class="link" title="올바른 웹 주소가 아니라 글자로만 보여요">${body}<span class="ld">${esc(a.url ?? '')}</span></div>`;
  return `<a class="link" href="${esc(href)}" target="_blank" rel="${LINK_REL}">${body}<span class="ld">${esc(href)}</span></a>`;
}

function fileHtml(c, a) {
  const name = cleanName(a.name) || cleanName(nameFromUrl(a.url)) || '파일';
  if (!isLocalUrl(a.url)) return linkCardHtml(c, a); // a file that lives elsewhere is just a link
  const f = fileFor(c, a.url);
  if (f.skipped) return skipLine(c, name, f.skipped);
  const size = fmtBytes(a.size ?? f.entry.size);
  if (VIDEO_MIME.test(f.declared)) {
    return `<video class="media" controls playsinline preload="none" src="${splice(c, `data:${f.declared};base64,${f.payload}`)}" aria-label="${esc(name)}">${esc(name)}</video>`;
  }
  if (AUDIO_MIME.test(f.declared)) {
    return `<div class="file au"><span class="fn">🎵 ${esc(name)}</span><audio class="media" controls preload="none" src="${splice(c, `data:${f.declared};base64,${f.payload}`)}" aria-label="${esc(name)}"></audio></div>`;
  }
  // anything else is only ever offered as a download, typed as opaque bytes so a browser never renders it as a page
  return `${previewThumb(c, a)}<a class="file" download="${esc(name)}" href="${splice(c, `data:application/octet-stream;base64,${f.payload}`)}" aria-label="파일 내려받기: ${esc(name)}">`
    + `<span class="fi" aria-hidden="true">${esc(ext(name) || '파일')}</span><span class="fmeta"><span class="fn">${esc(name)}</span><span class="fs">${esc(size)}${size ? ' · ' : ''}눌러서 내려받기</span></span></a>`;
}

function attachmentHtml(c, post) {
  const a = post.attachment;
  if (!a || typeof a !== 'object') return '';
  let inner = '';
  switch (a.kind) {
    case 'image': inner = imageHtml(c, a, post); break;
    case 'link': inner = linkCardHtml(c, a); break;
    case 'video': inner = linkCardHtml(c, a, { video: true }); break;
    case 'file': inner = fileHtml(c, a); break;
    default: inner = '';
  }
  return inner ? `<div class="att">${inner}</div>` : '';
}

function authorOf(c, entity) {
  if (!c.showAuthor) return null; // hidden on the board → hidden in the file, whoever exported it
  const u = entity && entity.author && typeof entity.author === 'object' ? entity.author : {};
  const name = String(u.displayName ?? '').replace(CONTROL, '').trim().slice(0, 80) || '익명';
  return { name, color: colorOf(u.avatarColor), initial: [...name][0].toUpperCase() };
}
const avatarHtml = (a, cls = '') => (a ? `<span class="av${cls ? ' ' + cls : ''}" style="background:${a.color}" aria-hidden="true">${esc(a.initial)}</span>` : '');
const timeHtml = (c, ms) => `<time datetime="${esc(isoOf(ms))}">${esc(c.time(ms))}</time>`;

function reactionsHtml(c, post) {
  const kind = c.reactionKind;
  const r = post.reactions && typeof post.reactions === 'object' ? post.reactions : {};
  const chip = (glyph, label, text) => `<span class="react"><span aria-hidden="true">${glyph}</span> ${esc(text)}<span class="sr"> ${esc(label)}</span></span>`;
  const count = (x) => {
    const n = Number(x && x.count);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  };
  if (kind === 'like' || kind === 'vote' || kind === 'star') {
    const n = count(r[kind]);
    const def = { like: ['♥', '좋아요'], vote: ['▲', '투표'], star: ['★', '별'] }[kind];
    return n ? chip(def[0], `${def[1]} ${n}개`, String(n)) : '';
  }
  if (kind === 'grade') {
    const n = count(r.grade);
    const avg = Number(r.grade && r.grade.avg);
    return n && Number.isFinite(avg) ? chip('★', `평균 ${avg.toFixed(1)}점, ${n}명`, `${avg.toFixed(1)} (${n}명)`) : '';
  }
  if (kind === 'emoji') {
    const map = r.emoji && typeof r.emoji === 'object' ? r.emoji : {};
    return EMOJIS.filter((e) => count(map[e])).map((e) => `<span class="react"><span aria-hidden="true">${e}</span> ${count(map[e])}<span class="sr"> ${e} ${count(map[e])}명</span></span>`).join('');
  }
  return '';
}

function commentsHtml(c, post) {
  const list = (Array.isArray(post.comments) ? post.comments : []).filter((x) => x && typeof x === 'object');
  if (!list.length) return '';
  c.commentsTotal += list.length;
  const items = list.map((cm) => {
    const a = authorOf(c, cm);
    return `<li class="cm">${avatarHtml(a, 'sm')}<div class="cm-main"><div class="cm-meta">${a ? `<b>${esc(a.name)}</b>` : ''}${timeHtml(c, cm.createdAt)}</div><div class="rich">${renderRichHtml(cm.body)}</div></div></li>`;
  }).join('');
  return `<details class="comments"><summary>댓글 ${list.length}개</summary><ol class="clist">${items}</ol></details>`;
}

const badgesHtml = (post) => (post.pinned ? '<span class="badge">📌 고정됨</span>' : '') + (post.status === 'pending' ? '<span class="badge warn">승인 대기</span>' : '');
const colorClass = (post) => (post.color && POST_COLORS.includes(post.color) ? ` pc-${post.color}` : '');

function cardHtml(c, post, h) {
  const a = authorOf(c, post);
  const title = String(post.title ?? '').trim();
  const body = String(post.body ?? '');
  const react = reactionsHtml(c, post);
  const foot = react ? `<div class="card-foot">${react}</div>` : '';
  return `<article class="card${colorClass(post)}"><div class="card-head">${avatarHtml(a)}<div class="who">${a ? `<b>${esc(a.name)}</b>` : ''}${timeHtml(c, post.createdAt)}</div>${badgesHtml(post)}</div>`
    + (title ? `<${h} class="card-title">${esc(title)}</${h}>` : '')
    + attachmentHtml(c, post)
    + (body.trim() ? `<div class="rich card-body">${renderRichHtml(body)}</div>` : '')
    + foot
    + commentsHtml(c, post)
    + '</article>';
}

function messageHtml(c, post) {
  const a = authorOf(c, post);
  const title = String(post.title ?? '').trim();
  const body = String(post.body ?? '');
  const react = reactionsHtml(c, post);
  return `<article class="msg">${avatarHtml(a)}<div class="msg-main"><div class="msg-top">${a ? `<b>${esc(a.name)}</b>` : ''}${timeHtml(c, post.createdAt)}${badgesHtml(post)}</div>`
    + `<div class="msg-bubble${colorClass(post)}">${title ? `<p class="msg-title">${esc(title)}</p>` : ''}${attachmentHtml(c, post)}${body.trim() ? `<div class="rich">${renderRichHtml(body)}</div>` : ''}</div>`
    + (react ? `<div class="msg-foot">${react}</div>` : '')
    + commentsHtml(c, post)
    + '</div></article>';
}

// sections → [{ title, posts }]; cards whose section is gone come last under a neutral heading
function groupBySection(c) {
  const byId = new Map(c.sections.map((s) => [s.id, []]));
  const loose = [];
  for (const p of c.posts) (byId.has(p.sectionId) ? byId.get(p.sectionId) : loose).push(p);
  const groups = c.sections.map((s) => ({ title: String(s.title ?? '').trim() || '(제목 없음)', posts: byId.get(s.id) }));
  if (loose.length) groups.push({ title: '섹션 없음', posts: loose });
  return groups;
}

// canvas: the free positions do not survive a file, so cards are listed in reading order (rows of ~120 px, then left to right)
function canvasOrder(posts) {
  const key = (p) => [Math.round((Number(p.y) || 0) / 120), Number(p.x) || 0];
  return posts.map((p, i) => ({ p, i, k: key(p) })).sort((a, b) => a.k[0] - b.k[0] || a.k[1] - b.k[1] || a.i - b.i).map((x) => x.p);
}

// Each card is written, counted against the text limit, and every ~1 MB of cards the build `yield`s (the async driver then lets the page breathe).
function* cards(c, list, render, h) {
  let out = '';
  for (const p of list) {
    const piece = render(c, p, h);
    c.outLen += piece.length;
    c.since += piece.length;
    if (c.outLen > c.textLimit) throw new ExportTooLargeError(c.outLen, c.textLimit);
    out += piece;
    if (c.since > YIELD_CHARS) {
      c.since = 0;
      yield;
    }
  }
  return out;
}

function* mainGen(c) {
  const f = c.format;
  if (!c.posts.length) return `<main id="main" class="layout-${f === 'backchannel' ? 'chat' : f}" data-format="${f}"><p class="empty">아직 글이 없어요.</p></main>`;
  if (SECTIONED.includes(f)) {
    let secs = '';
    for (const g of groupBySection(c)) {
      const inner = g.posts.length ? yield* cards(c, g.posts, cardHtml, 'h3') : '<p class="sec-empty">글이 없어요</p>';
      secs += `<section class="sec"><div class="sec-head"><h2 class="sec-title">${esc(g.title)}</h2><span class="sec-n">${g.posts.length}</span></div><div class="sec-body">${inner}</div></section>`;
    }
    return `<main id="main" class="layout-${f}" data-format="${f}">${secs}</main>`;
  }
  if (f === 'backchannel') return `<main id="main" class="layout-chat" data-format="${f}">${yield* cards(c, c.posts, messageHtml)}</main>`;
  if (f === 'canvas') return `<main id="main" class="layout-grid" data-format="canvas">${yield* cards(c, canvasOrder(c.posts), cardHtml, 'h2')}</main>`;
  return `<main id="main" class="layout-${f}" data-format="${f}">${yield* cards(c, c.posts, cardHtml, 'h2')}</main>`;
}

function css(c, wp) {
  const dark = wp.dark;
  return `
:root{color-scheme:light}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%;scroll-behavior:auto}
body{margin:0;min-height:100vh;font:15px/1.6 var(--font);color:var(--st);overflow-wrap:anywhere;
--font:${FONT_STACK[c.font]};--st:${dark ? '#fff' : '#1e293b'};--st2:${dark ? 'rgba(255,255,255,.86)' : '#475569'};--tab:${TAB_BG[wp.id]};--track:${dark ? 'rgba(0,0,0,.16)' : 'rgba(255,255,255,.5)'};--meta:${dark ? 'rgba(0,0,0,.46)' : 'rgba(255,255,255,.66)'};
--card-bg:#fff;--card-text:#1f2937;--card-text-2:#4b5565;--card-line:rgba(15,23,42,.12);--card-tint:rgba(15,23,42,.07);--card-link:#1d4ed8;--shadow:0 1px 2px rgba(15,23,42,.16),0 3px 10px rgba(15,23,42,.1);
--pc-red:#fde2e2;--pc-orange:#ffe8cc;--pc-yellow:#fff6bf;--pc-green:#daf5dd;--pc-blue:#dbeafe;--pc-purple:#e9defd;--pc-pink:#fde0ef}
${wp.css}
body.scheme-dark{--card-bg:#1f2530;--card-text:#eef1f6;--card-text-2:#cdd4df;--card-line:rgba(255,255,255,.16);--card-tint:rgba(255,255,255,.09);--card-link:#8ab4ff;--pc-red:#5d2a33;--pc-orange:#5e3d1f;--pc-yellow:#55501c;--pc-green:#1f4a2b;--pc-blue:#1f3b66;--pc-purple:#3f2f6b;--pc-pink:#5b2c48}
.pc-red{--post-bg:var(--pc-red)}.pc-orange{--post-bg:var(--pc-orange)}.pc-yellow{--post-bg:var(--pc-yellow)}.pc-green{--post-bg:var(--pc-green)}.pc-blue{--post-bg:var(--pc-blue)}.pc-purple{--post-bg:var(--pc-purple)}.pc-pink{--post-bg:var(--pc-pink)}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
:focus-visible{outline:3px solid #1d4ed8;outline-offset:2px;border-radius:4px}
.skip{position:absolute;left:8px;top:-80px;z-index:100;padding:8px 12px;border-radius:8px;background:#fff;color:#000}
.skip:focus{top:8px}
.page{max-width:1840px;margin:0 auto;padding:0 20px 64px}
.head{padding:28px 0 6px${wp.id === 'custom' ? ';text-shadow:0 1px 4px rgba(0,0,0,.55)' : ''}}
.byline{display:flex;align-items:center;gap:8px;margin-bottom:6px;font-size:.85rem;color:var(--st2)}
.byline time{color:var(--st2)}
.title{margin:0;font-size:clamp(1.6rem,4.5vw,2.5rem);line-height:1.25;font-weight:800;color:var(--st)}
.desc{margin-top:8px;max-width:720px;color:var(--st2)}
.desc .rich-p{margin:0 0 .5em}
.desc a{color:var(--st);font-weight:700}
.notice{margin:14px 0 22px;padding:10px 14px;border-radius:12px;background:rgba(255,255,255,.94);color:#1f2937;font-size:.88rem;box-shadow:var(--shadow)}
.notice b{font-weight:800}
.notice details{margin-top:6px}
.notice summary{cursor:pointer;font-weight:700}
.notice ul{margin:6px 0 0;padding-left:1.2em}
.empty{padding:56px 12px;text-align:center;font-weight:700;color:var(--st)}
.layout-wall{column-width:260px;column-gap:16px}
.layout-wall>.card{break-inside:avoid;margin:0 0 16px}
.layout-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:16px;align-items:start}
.layout-stream{max-width:680px;margin:0 auto;display:flex;flex-direction:column;gap:16px}
.layout-chat{max-width:760px;margin:0 auto;display:flex;flex-direction:column;gap:14px}
.layout-rows{display:flex;flex-direction:column;gap:28px}
.layout-shelf{display:flex;align-items:flex-start;gap:16px;overflow-x:auto;padding-bottom:16px}
.layout-shelf .sec{flex:0 0 min(300px,86vw)}
.sec{min-width:0}
.sec-head{display:inline-flex;align-items:center;gap:8px;max-width:100%;padding:6px 16px;border-radius:12px 12px 0 0;background:var(--tab);color:#fff}
.sec-title{margin:0;font-size:1.05rem;font-weight:800;line-height:1.3}
.sec-n{padding:1px 8px;border-radius:999px;background:rgba(0,0,0,.3);font-size:.75rem;font-weight:700}
.sec-body{display:flex;flex-direction:column;gap:12px;padding:14px;border-radius:0 12px 12px 12px;background:var(--track)}
.sec-empty{margin:0;padding:14px 4px;text-align:center;font-size:.85rem;color:var(--st2)}
.layout-rows .sec-body{flex-direction:row;flex-wrap:wrap;align-items:flex-start;gap:16px}
.layout-rows .card{flex:0 1 260px;width:min(260px,100%)}
.card{display:flex;flex-direction:column;gap:8px;min-width:0;padding:12px 14px 10px;border-radius:12px;background:var(--post-bg,var(--card-bg));color:var(--card-text);box-shadow:var(--shadow);overflow:hidden}
.card a:not(.ph-open):not(.ph-close):not(.file):not(.link){color:var(--card-link)}
.card-head{display:flex;align-items:center;gap:8px;min-height:36px}
.av{flex:none;display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;border-radius:50%;color:#fff;font-size:14px;font-weight:700}
.av.sm{width:26px;height:26px;font-size:12px}
.who{display:flex;flex-direction:column;flex:1;min-width:0;line-height:1.25}
.who b{font-size:.9rem}
time{font-size:.78rem;color:var(--card-text-2);white-space:nowrap}
.badge{padding:2px 8px;border-radius:999px;background:var(--card-tint);font-size:.7rem;font-weight:700;white-space:nowrap}
.badge.warn{background:#fef3c7;color:#92400e}
.card-title{margin:0;font-size:1.05rem;font-weight:800;line-height:1.35}
.rich-p{margin:0 0 .6em}.rich-p:last-child{margin-bottom:0}
.rich-list{margin:.2em 0 .6em;padding-left:1.3em}
.rich code{padding:0 4px;border-radius:4px;background:var(--card-tint);font-family:${FONT_STACK.mono};font-size:.92em}
.rich-link{word-break:break-all}
.att{margin:0 -14px}
.att .link,.att .file,.att .skip-note{margin:0 14px}
.ph{margin:0}
.ph-open{display:block;line-height:0}
.ph img{display:block;width:100%;height:auto;max-height:520px;object-fit:cover;object-position:top;cursor:zoom-in}
.ph-close{display:none}
.ph:target{position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;padding:12px;background:rgba(0,0,0,.92)}
.ph:target .ph-close{position:fixed;inset:0;z-index:1;display:flex;align-items:flex-start;justify-content:flex-end;padding:14px;cursor:zoom-out}
.ph:target .ph-close span{padding:8px 14px;border-radius:999px;background:#fff;color:#111;font-weight:700}
.ph:target .ph-open{position:relative;z-index:2;max-width:100%;max-height:100%}
.ph:target img{width:auto;max-width:96vw;max-height:92vh;object-fit:contain;cursor:default}
.link,.file{display:flex;gap:2px;padding:10px 12px;border:1px solid var(--card-line);border-radius:10px;background:var(--card-tint);color:inherit;text-decoration:none}
.link{flex-direction:column}
a.link:hover,a.file:hover{background:var(--card-line)}
.link .site,.link .ld,.file .fs{font-size:.78rem;color:var(--card-text-2)}
.link .lt,.file .fn{font-weight:700}
.thumb{display:block;width:100%;height:auto;max-height:200px;margin-bottom:6px;border-radius:8px;object-fit:cover}
.file{align-items:center;gap:10px}
.file.au{flex-direction:column;align-items:stretch;gap:4px}
.fi{flex:none;display:inline-flex;align-items:center;justify-content:center;width:42px;height:42px;border-radius:8px;background:var(--card-line);font-size:.7rem;font-weight:800}
.fmeta{display:flex;flex-direction:column;min-width:0}
.skip-note{margin:0;padding:10px 12px;border:1px dashed var(--card-line);border-radius:10px;font-size:.85rem;color:var(--card-text-2)}
.media{display:block;width:100%;margin-top:4px}
video.media{max-height:420px;background:#000}
.card-foot,.msg-foot{display:flex;flex-wrap:wrap;align-items:center;gap:6px;font-size:.85rem;color:var(--card-text-2)}
.react{display:inline-flex;align-items:center;gap:3px;padding:2px 8px;border-radius:999px;background:var(--card-tint)}
.comments{margin-top:2px;padding-top:6px;border-top:1px solid var(--card-line)}
.comments summary{padding:4px 0;cursor:pointer;font-size:.85rem;font-weight:700;color:var(--card-text-2)}
.clist{display:flex;flex-direction:column;gap:10px;margin:6px 0 0;padding:0;list-style:none}
.cm{display:flex;gap:8px}
.cm-main{flex:1;min-width:0}
.cm-meta{display:flex;flex-wrap:wrap;align-items:baseline;gap:6px;font-size:.85rem}
.msg{display:flex;align-items:flex-end;gap:8px}
.msg-main{display:flex;flex-direction:column;gap:3px;min-width:0;max-width:min(560px,86%)}
.msg-top{display:inline-flex;align-items:center;gap:6px;align-self:flex-start;padding:0 9px;border-radius:999px;background:var(--meta);font-size:.8rem;color:var(--st)}
.msg-top time{color:var(--st)}
.msg-bubble{display:flex;flex-direction:column;gap:6px;overflow:hidden;padding:9px 14px;border-radius:18px 18px 18px 5px;background:var(--post-bg,var(--card-bg));color:var(--card-text);box-shadow:var(--shadow)}
.msg-bubble .att{margin:0 -14px}
.msg-bubble a:not(.ph-open):not(.ph-close):not(.file):not(.link){color:var(--card-link)}
.msg-title{margin:0;font-weight:800}
.msg-foot{align-self:flex-start;color:var(--st)}
.msg .comments{padding:6px 12px;border-radius:12px;background:var(--meta);color:var(--st);border-top:0}
.msg .comments summary,.msg .cm-meta,.msg time{color:var(--st)}
@media (max-width:640px){
.page{padding:0 14px 48px}
.layout-wall{column-width:100%}
.layout-shelf{flex-direction:column;overflow-x:visible}
.layout-shelf .sec{flex:none;width:100%}
.layout-rows .card{flex-basis:100%;width:100%}
.msg-main{max-width:92%}
}
@media (prefers-color-scheme:dark){
body.scheme-light{--card-bg:#1f2530;--card-text:#eef1f6;--card-text-2:#cdd4df;--card-line:rgba(255,255,255,.16);--card-tint:rgba(255,255,255,.09);--card-link:#8ab4ff;--pc-red:#5d2a33;--pc-orange:#5e3d1f;--pc-yellow:#55501c;--pc-green:#1f4a2b;--pc-blue:#1f3b66;--pc-purple:#3f2f6b;--pc-pink:#5b2c48}
.notice{background:rgba(24,28,38,.94);color:#eef1f6}
.badge.warn{background:#5e4a12;color:#fde68a}
}
@media print{
@page{margin:12mm}
body{background:#fff!important;color:#000;--st:#000;--st2:#333;--meta:#eee}
.notice,.card,.msg-bubble{box-shadow:none!important;border:1px solid #999;background:#fff!important;color:#000!important}
.card,.msg,.sec-head,.cm{break-inside:avoid}
.layout-shelf{display:block;overflow:visible}
.layout-shelf .sec{width:auto}
.sec-body{background:none;padding:6px 0}
.layout-wall{column-count:2;column-width:auto}
.ph img{max-height:none;cursor:default}
.comments::details-content{content-visibility:visible}
a{color:#000!important;text-decoration:underline}
}
`.trim();
}

function wallpaperOf(c, parts) {
  const wp = c.board.wallpaper;
  if (isLocalUrl(wp)) {
    const f = fileFor(c, wp);
    if (!f.skipped && IMG_MIME.test(f.mime)) {
      return { id: 'custom', dark: true, css: `body{background:#334155 url("${splice(c, `data:${f.mime};base64,${f.payload}`)}") center/cover no-repeat}\n@media (min-width:800px){body{background-attachment:fixed}}`, embedded: true };
    }
    return { id: 'custom', dark: true, css: 'body{background:#334155}', embedded: false };
  }
  const id = WALLPAPERS.includes(wp) ? wp : 'green';
  return { id, dark: DARK_WALLPAPERS.includes(id), css: `body{background:${WALLPAPER_BG[id]}}\n@media (min-width:800px){body{background-attachment:fixed}}`, embedded: false };
}

function noticeHtml(c, wpl) {
  const sum = summarizeFiles(c.entries);
  const bits = [`글 ${c.posts.length}개`, `댓글 ${c.commentsTotal}개`];
  if (sum.images) bits.push(`그림 ${sum.images}개`);
  if (sum.files) bits.push(`파일 ${sum.files}개`);
  const skipped = sum.skipped;
  const when = c.nowMs ? ` ${esc(c.time(c.nowMs))}에 만든` : '';
  const canvas = c.format === 'canvas' ? '<br>캔버스 보드라서 카드를 자유롭게 놓은 위치는 담기지 않고, 읽는 순서대로 격자에 늘어놓았어요.' : '';
  const list = skipped.length
    ? `<details><summary>담지 못한 파일 ${skipped.length}개</summary><ul>${skipped.map((s) => `<li>${esc(s.name)} — ${esc(SKIP_TEXT[s.reason] || SKIP_TEXT.failed)}</li>`).join('')}</ul></details>`
    : '';
  const bg = wpl.id === 'custom' && !wpl.embedded && c.board.wallpaper ? '<br>배경 사진은 담지 못해 단색으로 바꿨어요.' : '';
  return `<div class="notice" role="note"><b>읽기 전용 사본</b> · 이 파일은${when} Edulet 보드의 사본이라 인터넷이 없어도 열려요. 그 뒤에 보드에서 바뀐 내용은 들어 있지 않아요.<br>${esc(bits.join(' · '))}${canvas}${bg}${list}</div>`;
}

// The build as a generator: it yields every ~1 MB of cards, so one driver runs it straight through (tests, small boards) and the other
// hands control back to the page between the steps (a big board must not freeze the screen).
function* buildCore(input) {
  const c = makeCtx(input);
  const est = estimateTextBytes(c.data);
  if (est > c.textLimit) throw new ExportTooLargeError(est, c.textLimit);
  const wpl = wallpaperOf(c);
  const b = c.board;
  const title = String(b.title ?? '').trim() || '이름 없는 보드';
  const owner = c.showAuthor && b.owner && typeof b.owner === 'object' ? String(b.owner.displayName ?? '').replace(CONTROL, '').trim() : '';
  const desc = String(b.description ?? '').trim();
  // content first (it counts the comments for the notice), then the frame around it
  const main = yield* mainGen(c);
  const notice = noticeHtml(c, wpl);
  const styles = css(c, wpl);
  const html = `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${CSP}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta name="robots" content="noindex">
<meta name="generator" content="Edulet 오프라인 내보내기">
<title>${esc(title)} · Edulet 오프라인 사본</title>
<style>
${styles}
</style>
</head>
<body class="wp-${wpl.id} tone-${wpl.dark ? 'dark' : 'light'} font-${c.font} scheme-${c.scheme}">
<a class="skip" href="#main">본문으로 건너뛰기</a>
<div class="page">
<header class="head">
${owner || b.createdAt ? `<div class="byline">${owner ? `<span>${esc(owner)}</span><span aria-hidden="true">•</span>` : ''}${b.createdAt ? timeHtml(c, b.createdAt) : ''}</div>` : ''}
<h1 class="title">${esc(title)}</h1>
${desc ? `<div class="desc rich">${renderRichHtml(desc)}</div>` : ''}
</header>
${notice}
${main}
</div>
</body>
</html>
`;
  return toParts(html, c.bigs);
}

/**
 * The page as an array of strings that joins to the whole document. Pictures and files (base64) are separate array items, so
 * `new Blob(parts)` never has to build one giant string. Throws ExportTooLargeError when the text alone is over the limit.
 */
export function buildOfflineParts(input = {}) {
  const g = buildCore(input);
  for (;;) {
    const r = g.next();
    if (r.done) return r.value;
  }
}

/** Same result, but gives the page back between steps and stops at once when `signal` aborts (rejects with an AbortError). */
export async function buildOfflinePartsAsync(input = {}, { signal } = {}) {
  const g = buildCore(input);
  for (;;) {
    if (signal && signal.aborted) throw abortError();
    const r = g.next();
    if (r.done) return r.value;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

export function buildOfflineHtml(input = {}) {
  return buildOfflineParts(input).join('');
}
