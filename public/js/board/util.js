// Small shared helpers for the board canvas (no DOM-building of user data here).
import { withBase } from '../lib/base.js';

/* ───────── text emptiness (UX-09) ───────── */
// Zero-width / bidi-control characters render as nothing: a title made only of them must count as empty.
const INVISIBLE = /[\u200b-\u200f\u2060\ufeff\u202a-\u202e]/g;
export const stripInvisible = (s) => String(s ?? '').replace(INVISIBLE, '');
export const isBlank = (s) => stripInvisible(s).trim() === '';
/** Text to send: '' when it only holds whitespace/invisible characters, else trimmed (invisible chars inside are kept: ZWJ builds emoji). */
export const cleanText = (s) => (isBlank(s) ? '' : String(s).trim());

/* ───────── failures shown to the user (UX-03) ───────── */
/** A readable Korean sentence for any failure (server codes already carry Korean text; add the wait for 429s). */
export function errorMessage(e, fallback = '처리하지 못했어요. 다시 시도해 주세요.') {
  if (!e) return fallback;
  let m = e.message || fallback;
  if (e.code === 'timeout' && !/[가-힣]/.test(m)) m = '서버가 응답하지 않아요. 잠시 뒤에 다시 시도해 주세요.';
  if ((e.code === 'rate_limited' || e.status === 429) && Number(e.retryAfter) > 0 && !/\d+\s*초/.test(m)) {
    m += ` (${Math.ceil(Number(e.retryAfter))}초 뒤에 다시 할 수 있어요)`;
  }
  return m;
}

/** Resolve to an absolute http(s) URL string, or null (blocks javascript:, data:, etc.). */
export function safeUrl(u) {
  if (!u || typeof u !== 'string') return null;
  try {
    const x = new URL(withBase(u), location.href);
    return x.protocol === 'http:' || x.protocol === 'https:' ? x.href : null;
  } catch {
    return null;
  }
}

export function isExternalUrl(u) {
  try {
    return new URL(u, location.href).origin !== location.origin;
  } catch {
    return true;
  }
}

export function hostOf(u) {
  try {
    return new URL(u, location.href).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Run `fn` while the controller's search filter is cleared (no event is emitted) — to read the unfiltered card order. */
export function withoutSearch(ctl, fn) {
  const st = ctl.state;
  const q = st.search;
  st.search = '';
  try {
    return fn();
  } finally {
    st.search = q;
  }
}

/** requestAnimationFrame coalescing scheduler. */
export function rafScheduler(fn) {
  let id = 0;
  const run = () => {
    if (id) return;
    id = requestAnimationFrame(() => {
      id = 0;
      fn();
    });
  };
  run.cancel = () => {
    if (id) cancelAnimationFrame(id);
    id = 0;
  };
  return run;
}

/**
 * Make `parent`'s children exactly `wanted` (in order), moving as few nodes as possible.
 * Nodes not in `wanted` are removed. Existing nodes keep their identity (focus/scroll survive).
 */
export function reconcile(parent, wanted) {
  const set = new Set(wanted);
  for (let n = parent.firstChild; n; ) {
    const next = n.nextSibling;
    if (!set.has(n)) parent.removeChild(n);
    n = next;
  }
  let ref = parent.firstChild;
  for (const el of wanted) {
    if (el === ref) ref = ref.nextSibling;
    else parent.insertBefore(el, ref);
  }
}

/** Nearest ancestor that scrolls vertically by style (or the document scroller). */
export function scrollerOf(el) {
  for (let p = el && el.parentElement; p && p !== document.body && p !== document.documentElement; p = p.parentElement) {
    const oy = getComputedStyle(p).overflowY;
    if (oy === 'auto' || oy === 'scroll') return p;
  }
  return document.scrollingElement || document.documentElement;
}

/** All scrollable ancestors of `el` (inclusive), nearest first, ending with the document scroller. */
export function scrollChain(el) {
  const out = [];
  for (let p = el; p && p !== document.body && p !== document.documentElement; p = p.parentElement) {
    const cs = getComputedStyle(p);
    const sx = (cs.overflowX === 'auto' || cs.overflowX === 'scroll') && p.scrollWidth > p.clientWidth + 1;
    const sy = (cs.overflowY === 'auto' || cs.overflowY === 'scroll') && p.scrollHeight > p.clientHeight + 1;
    if (sx || sy) out.push(p);
  }
  out.push(document.scrollingElement || document.documentElement);
  return out;
}

export const INTERACTIVE = 'a,button,input,textarea,select,label,iframe,video,audio,[contenteditable="true"],.b-nodrag';
export function isInteractive(target, boundary) {
  const t = target && target.closest ? target.closest(INTERACTIVE) : null;
  return !!t && (!boundary || boundary.contains(t));
}

/** Korean/Japanese IME composition guard for Enter handling. */
export function isIme(e) {
  return e.isComposing || e.keyCode === 229;
}

export function autosize(ta, max = 160) {
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight + 2, max) + 'px';
}

/** Signature of everything that decides where a post sits in a list. */
export function placeSig(p) {
  return `${p.sectionId ?? ''}|${p.rank}|${p.pinned ? 1 : 0}|${p.status}|${p.createdAt}`;
}

export function postUrl(slug, id) {
  return `${location.origin}${withBase(`/b/${encodeURIComponent(slug)}/p/${id}`)}`;
}

export function fileExt(name) {
  const m = /\.([A-Za-z0-9]{1,5})$/.exec(name || '');
  return m ? m[1].toUpperCase() : '';
}

/** Signature of a post for cheap "did anything visible change?" checks. */
export function postSig(p, extra = '') {
  const a = p.attachment;
  const au = a ? `${a.kind}|${a.url}|${a.name}|${a.size}|${a.preview ? `${a.preview.image}|${a.preview.title}|${a.preview.embedUrl}` : ''}` : '';
  const au2 = p.author ? `${p.author.id}|${p.author.displayName}|${p.author.avatarColor}` : '';
  return [p.title, p.body, p.color, p.pinned ? 1 : 0, p.status, p.commentCount, p.updatedAt, au, au2, extra].join('\u0001');
}
