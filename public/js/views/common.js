// Small helpers shared by the app-shell views (not part of the F1/F2 contract surface).
import { h } from '../lib/h.js';
import { router } from '../lib/router.js';
import { toast, icon } from '../lib/ui.js';
import { WALLPAPERS, DARK_WALLPAPERS } from '../lib/constants.js';

export const FORMAT_ICON = {
  wall: 'wall', grid: 'grid', stream: 'list', shelf: 'columns', rows: 'rows', canvas: 'canvas', backchannel: 'chat',
};
/** Which format a template implies (see CONTRACT §5 POST /boards). */
export const TEMPLATE_FORMAT = { blank: 'wall', kwl: 'shelf', retro: 'shelf', training: 'rows' };

/** Toast an error unless it is a deliberate cancel. */
export function reportError(e, fallback = '처리하지 못했어요. 다시 시도해 주세요.') {
  if (e && e.code === 'cancelled') return;
  toast((e && e.message) || fallback, 'error');
}

/** Run an async function; ApiErrors become toasts. Resolves to the result, or undefined on failure. */
export async function guard(fn) {
  try {
    return await fn();
  } catch (e) {
    reportError(e);
    return undefined;
  }
}

/** Replace the current history entry with `path` and render it (used for redirects, so Back does not bounce). */
export function redirect(path) {
  queueMicrotask(() => {
    router.replace(path);
    router.go(path);
  });
}

export const isGuest = (u) => !!(u && u.isGuest);
/** A real (non-guest) account. */
export const isMember = (u) => !!u && !u.isGuest;

export const boardPath = (slug) => '/b/' + encodeURIComponent(slug);
export const boardUrl = (slug) => location.origin + boardPath(slug);

/** Wallpaper → { cls, style, dark, id }. Custom uploads ("/uploads/…") become a background-image. */
export function wallpaperProps(wp) {
  if (typeof wp === 'string' && wp.startsWith('/uploads/')) {
    return { id: 'custom', cls: 'wp-custom', dark: true, style: { backgroundImage: `url(${JSON.stringify(wp)})` } };
  }
  const id = WALLPAPERS.includes(wp) ? wp : 'green';
  return { id, cls: 'wp-' + id, dark: DARK_WALLPAPERS.includes(id), style: null };
}

/** Run `fn` once the caller has been quiet for `ms`. flush() runs a pending call right now. */
export function deferred(fn, ms = 500) {
  let t = null;
  return {
    call() {
      clearTimeout(t);
      t = setTimeout(() => {
        t = null;
        fn();
      }, ms);
    },
    flush() {
      if (t !== null) {
        clearTimeout(t);
        t = null;
        fn();
      }
    },
    cancel() {
      clearTimeout(t);
      t = null;
    },
    get pending() {
      return t !== null;
    },
  };
}

/** The Edulet mark: a tiny wall of cards on a green tile. */
export function logoMark(size = 28) {
  const r = (x, y, w, hh, o) => h.svg('rect', { x, y, width: w, height: hh, rx: 2, fill: '#fff', 'fill-opacity': o });
  return h.svg(
    'svg',
    { viewBox: '0 0 32 32', width: size, height: size, class: 'app-logo-mark', 'aria-hidden': 'true', focusable: 'false' },
    h.svg('rect', { width: 32, height: 32, rx: 9, fill: '#0e7a4b' }),
    r(7, 7, 8, 11, 1), r(17, 7, 8, 6, 0.8), r(17, 15, 8, 10, 1), r(7, 20, 8, 5, 0.8)
  );
}

/**
 * A radio group of selectable cards. options: [{ value, label, desc?, icon? }]
 * Buttons are created once and only repainted, so keyboard focus survives a pick.
 * dataKey: dataset attribute name put on each button (e.g. 'format' → data-format="wall").
 */
export function pickGroup({ options, value, onPick, label, dataKey, className = '' }) {
  let cur = value;
  const el = h('div', { class: ['app-picker', className], role: 'radiogroup', 'aria-label': label || null });
  const buttons = options.map((o) =>
    h(
      'button',
      {
        type: 'button', role: 'radio', class: ['app-pick', o.cls], 'aria-checked': 'false',
        dataset: dataKey ? { [dataKey]: o.value } : null,
        onClick: () => {
          cur = o.value;
          paint();
          if (onPick) onPick(cur);
        },
      },
      o.icon ? h('span', { class: 'app-pick-ico' }, icon(o.icon, { size: 20 })) : null,
      h('span', { class: 'app-pick-text' }, h('span', { class: 'app-pick-name' }, o.label), o.desc ? h('span', { class: 'app-pick-desc' }, o.desc) : null)
    )
  );
  function paint() {
    buttons.forEach((b, i) => {
      const on = options[i].value === cur;
      b.setAttribute('aria-checked', String(on));
      b.classList.toggle('on', on);
    });
  }
  buttons.forEach((b) => el.appendChild(b));
  paint();
  return { el, get: () => cur, set(v) { cur = v; paint(); } };
}
