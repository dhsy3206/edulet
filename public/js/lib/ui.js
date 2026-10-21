// Shared UI primitives: icons, modal, toast, popover menu, avatar, time, clipboard, QR.
import { h } from './h.js';
import { qrSvg } from '../../vendor/qrcode.js';

/* ───────── icons (24×24, stroke) ───────── */
// Each entry: [tag, attrs] list. Fill-only shapes set fill:'currentColor'.
const P = (d, extra = {}) => ['path', { d, ...extra }];
const C = (cx, cy, r, extra = {}) => ['circle', { cx, cy, r, ...extra }];
const R = (x, y, w, hgt, rx = 0, extra = {}) => ['rect', { x, y, width: w, height: hgt, rx, ...extra }];
const FILL = { fill: 'currentColor', stroke: 'none' };
const ICONS = {
  plus: [P('M12 5v14M5 12h14')],
  x: [P('M18 6 6 18M6 6l12 12')],
  search: [C(11, 11, 7), P('m21 21-4.3-4.3')],
  share: [P('M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7M16 6l-4-4-4 4M12 2v13')],
  play: [P('M7 4.5v15a.5.5 0 0 0 .8.4l12-7.5a.5.5 0 0 0 0-.8l-12-7.5a.5.5 0 0 0-.8.4z', FILL)],
  pause: [P('M8 5v14M16 5v14', { 'stroke-width': 3 })],
  'play-circle': [C(12, 12, 9), P('M10 8.5v7l6-3.5z', FILL)],
  settings: [P('M3 6h9M16 6h5M3 12h3M10 12h11M3 18h11M18 18h3'), C(14, 6, 2), C(8, 12, 2), C(16, 18, 2)],
  more: [C(5, 12, 1.4, FILL), C(12, 12, 1.4, FILL), C(19, 12, 1.4, FILL)],
  'more-v': [C(12, 5, 1.4, FILL), C(12, 12, 1.4, FILL), C(12, 19, 1.4, FILL)],
  message: [P('M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z')],
  heart: [P('M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z')],
  'thumbs-up': [P('M7 11v9H4v-9h3zM7 11l4-8c1.5 0 2.5 1 2.5 2.5V9h5.2a2 2 0 0 1 2 2.3l-1.2 7A2 2 0 0 1 17.5 20H7')],
  star: [P('M12 3l2.8 5.9 6.2.9-4.5 4.4 1.1 6.3L12 17.5 6.4 20.5l1.1-6.3L3 9.8l6.2-.9z')],
  vote: [P('M12 17V7M7 12l5-5 5 5M5 20h14')],
  link: [P('M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1')],
  image: [R(3, 4, 18, 16, 2), C(9, 10, 1.5), P('m21 16-5-5-9 9')],
  paperclip: [P('M21 11l-9 9a5 5 0 0 1-7-7l9-9a3.5 3.5 0 0 1 5 5l-9 9a2 2 0 0 1-3-3l8-8')],
  file: [P('M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5')],
  'chevron-left': [P('M15 5l-7 7 7 7')],
  'chevron-right': [P('M9 5l7 7-7 7')],
  'chevron-down': [P('M5 9l7 7 7-7')],
  'chevron-up': [P('M5 15l7-7 7 7')],
  'arrow-left': [P('M19 12H5M12 5l-7 7 7 7')],
  check: [P('M5 12l5 5 9-10')],
  trash: [P('M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6')],
  edit: [P('M4 20h4L19 9l-4-4L4 16v4zM13 7l4 4')],
  pin: [P('M12 17v5M8 3h8l-1 6 3 3v2H6v-2l3-3z')],
  palette: [P('M12 3a9 9 0 1 0 0 18c1.5 0 2-1 1.5-2s0-2 1.5-2h2a4 4 0 0 0 4-4c0-5-4.5-10-9-10z'), C(8, 11, 1, FILL), C(12, 7.5, 1, FILL), C(16, 11, 1, FILL)],
  copy: [R(9, 9, 11, 11, 2), P('M5 15V5a2 2 0 0 1 2-2h8')],
  download: [P('M12 3v12M7 10l5 5 5-5M4 21h16')],
  users: [C(9, 8, 3.5), P('M2 20a7 7 0 0 1 14 0'), C(17, 9, 2.5), P('M16 14a5 5 0 0 1 6 5')],
  user: [C(12, 8, 4), P('M4 21a8 8 0 0 1 16 0')],
  lock: [R(5, 11, 14, 10, 2), P('M8 11V8a4 4 0 0 1 8 0v3')],
  globe: [C(12, 12, 9), P('M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18')],
  logout: [P('M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9')],
  smile: [C(12, 12, 9), P('M8 14s1.5 2 4 2 4-2 4-2'), C(9, 10, 0.8, FILL), C(15, 10, 0.8, FILL)],
  grip: [C(9, 6, 1.3, FILL), C(15, 6, 1.3, FILL), C(9, 12, 1.3, FILL), C(15, 12, 1.3, FILL), C(9, 18, 1.3, FILL), C(15, 18, 1.3, FILL)],
  layout: [R(3, 3, 18, 18, 2), P('M3 9h18M9 21V9')],
  grid: [R(3, 3, 7, 7, 1), R(14, 3, 7, 7, 1), R(3, 14, 7, 7, 1), R(14, 14, 7, 7, 1)],
  maximize: [P('M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5')],
  'external-link': [P('M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5')],
  send: [P('M22 2L11 13M22 2l-7 20-4-9-9-4z')],
  eye: [P('M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z'), C(12, 12, 3)],
  home: [P('M3 11l9-8 9 8v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z')],
  clock: [C(12, 12, 9), P('M12 7v5l3 2')],
  check_circle: [C(12, 12, 9), P('M8 12l3 3 5-6')],
  alert: [P('M12 3l10 18H2z'), P('M12 10v5M12 18h.01')],
  refresh: [P('M20 11a8 8 0 0 0-14-4M4 4v4h4M4 13a8 8 0 0 0 14 4M20 20v-4h-4')],
  'arrow-up': [P('M12 19V5M5 12l7-7 7 7')],
  'arrow-down': [P('M12 5v14M19 12l-7 7-7-7')],
  columns: [R(3, 3, 5, 18, 1), R(10, 3, 5, 18, 1), R(17, 3, 4, 18, 1)],
  rows: [R(3, 3, 18, 5, 1), R(3, 10, 18, 5, 1), R(3, 17, 18, 4, 1)],
  list: [P('M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01')],
  wall: [R(3, 3, 8, 11, 1), R(13, 3, 8, 6, 1), R(13, 11, 8, 10, 1), R(3, 16, 8, 5, 1)],
  chat: [P('M4 5h16v11H9l-5 4z')],
  canvas: [R(3, 3, 18, 18, 2, { 'stroke-dasharray': '3 3' }), R(6, 6, 6, 5, 1), R(12, 13, 6, 5, 1)],
};

export function icon(name, { size = 20, label, class: cls } = {}) {
  const def = ICONS[name] || ICONS.more;
  const svg = h.svg(
    'svg',
    {
      viewBox: '0 0 24 24', width: size, height: size, fill: 'none', stroke: 'currentColor',
      'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', class: ['icon', cls],
      'aria-hidden': label ? null : 'true', role: label ? 'img' : null, 'aria-label': label || null, focusable: 'false',
    },
    def.map(([tag, attrs]) => h.svg(tag, attrs))
  );
  return svg;
}

/* ───────── small utils ───────── */
export function debounce(fn, ms = 200) {
  let t;
  const d = (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
  d.cancel = () => clearTimeout(t);
  return d;
}

export function formatBytes(n) {
  if (n == null) return '';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}

export function timeAgo(ms) {
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 45) return '방금';
  const m = Math.floor(s / 60);
  if (m < 60) return `${Math.max(1, m)}분 전`;
  const hr = Math.floor(m / 60);
  if (hr < 24) return `${hr}시간 전`;
  const d = Math.floor(hr / 24);
  if (d < 30) return `${d}일 전`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}개월 전`;
  return `${Math.floor(mo / 12)}년 전`;
}

export function fullTime(ms) {
  try {
    return new Date(ms).toLocaleString('ko-KR', { dateStyle: 'medium', timeStyle: 'short' });
  } catch {
    return new Date(ms).toISOString();
  }
}

export function avatar(user, size = 32) {
  const name = (user && user.displayName) || '?';
  const initial = [...name.trim()][0] || '?';
  return h(
    'span',
    {
      class: 'avatar', title: name, 'aria-hidden': 'true',
      style: { width: size + 'px', height: size + 'px', fontSize: Math.round(size * 0.45) + 'px', background: (user && user.avatarColor) || '#64748b' },
    },
    initial.toUpperCase()
  );
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = h('textarea', { style: { position: 'fixed', opacity: 0, top: 0 }, readOnly: true }, text);
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      /* ignore */
    }
    ta.remove();
    return ok;
  }
}

/** QR code as an <svg> element, or null if the text is too long. */
export function qr(text) {
  const markup = qrSvg(text);
  if (!markup) return null;
  const doc = new DOMParser().parseFromString(markup, 'image/svg+xml');
  const el = document.importNode(doc.documentElement, true);
  el.setAttribute('class', 'qr');
  el.setAttribute('role', 'img');
  el.setAttribute('aria-label', 'QR 코드');
  return el;
}

/* ───────── toast ───────── */
let toastBox;
export function toast(message, kind = 'info', ms = 3500) {
  if (!toastBox) {
    toastBox = h('div', { id: 'toasts', class: 'toasts', 'aria-live': 'polite', role: 'status' });
    document.body.appendChild(toastBox);
  }
  const t = h('div', { class: ['toast', 'toast-' + kind] }, message);
  toastBox.appendChild(t);
  const kill = () => {
    t.classList.add('out');
    setTimeout(() => t.remove(), 200);
  };
  setTimeout(kill, ms);
  t.addEventListener('click', kill);
  return kill;
}

/* ───────── focus helpers ───────── */
const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
export function focusables(root) {
  return [...root.querySelectorAll(FOCUSABLE)].filter((e) => e.offsetParent !== null || e === document.activeElement);
}

/* ───────── modal ───────── */
let openModals = 0;
/**
 * modal({ title, body, actions, size, onClose, persistent })
 *   actions: [{ label, kind: 'primary'|'secondary'|'danger', onClick(close, ev) → may return a Promise (button shows busy), keepOpen }]
 * returns { el, close, setBusy(bool) }
 */
export function modal({ title, body, actions = [], size = 'md', onClose, persistent = false, labelledBy } = {}) {
  const prev = document.activeElement;
  const titleId = labelledBy || 'm' + Math.random().toString(36).slice(2, 8);
  let closed = false;
  const dialog = h(
    'div',
    { class: ['modal', 'modal-' + size], role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': title ? titleId : null, tabindex: '-1' },
    title
      ? h('div', { class: 'modal-head' }, h('h2', { id: titleId, class: 'modal-title' }, title),
          h('button', { class: 'btn-icon', type: 'button', 'aria-label': '닫기', onClick: () => close() }, icon('x')))
      : null,
    h('div', { class: 'modal-body' }, body),
    actions.length ? h('div', { class: 'modal-actions' }) : null
  );
  const backdrop = h('div', { class: 'modal-backdrop' }, dialog);
  const bar = dialog.querySelector('.modal-actions');

  function setBusy(b) {
    dialog.classList.toggle('busy', !!b);
    dialog.querySelectorAll('.modal-actions button').forEach((x) => (x.disabled = !!b));
  }
  function close(result) {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKey, true);
    backdrop.classList.add('out');
    setTimeout(() => backdrop.remove(), 120);
    if (--openModals === 0) document.documentElement.classList.remove('modal-open');
    if (prev && prev.focus && document.contains(prev)) prev.focus();
    if (onClose) onClose(result);
  }
  function onKey(e) {
    if (e.key === 'Escape' && !persistent) {
      // only the top-most modal reacts
      const all = document.querySelectorAll('.modal-backdrop');
      if (all[all.length - 1] === backdrop) {
        e.stopPropagation();
        close();
      }
    } else if (e.key === 'Tab') {
      const all = document.querySelectorAll('.modal-backdrop');
      if (all[all.length - 1] !== backdrop) return;
      const f = focusables(dialog);
      if (!f.length) return e.preventDefault();
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && (document.activeElement === first || document.activeElement === dialog)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  }

  actions.forEach((a) => {
    const btn = h('button', { type: 'button', class: ['btn', 'btn-' + (a.kind || 'secondary')] }, a.label);
    btn.addEventListener('click', async (ev) => {
      if (!a.onClick) return close(a.value);
      try {
        setBusy(true);
        const r = await a.onClick(close, ev);
        if (!a.keepOpen && r !== false) close(r);
      } catch (err) {
        if (err && err.message) toast(err.message, 'error');
      } finally {
        if (!closed) setBusy(false);
      }
    });
    bar.appendChild(btn);
  });

  if (!persistent) backdrop.addEventListener('mousedown', (e) => e.target === backdrop && close());
  document.addEventListener('keydown', onKey, true);
  document.body.appendChild(backdrop);
  if (openModals++ === 0) document.documentElement.classList.add('modal-open');
  requestAnimationFrame(() => {
    const auto = dialog.querySelector('[autofocus]') || focusables(dialog.querySelector('.modal-body'))[0] || dialog;
    auto.focus();
  });
  return { el: dialog, close, setBusy };
}

export function confirmDialog({ title = '확인', message, confirmLabel = '확인', cancelLabel = '취소', danger = false } = {}) {
  return new Promise((resolve) => {
    let answered = false;
    const done = (v) => {
      answered = true;
      resolve(v);
    };
    modal({
      title, size: 'sm', body: h('p', { class: 'modal-text' }, message),
      actions: [
        { label: cancelLabel, kind: 'secondary', onClick: () => done(false) },
        { label: confirmLabel, kind: danger ? 'danger' : 'primary', onClick: () => done(true) },
      ],
      onClose: () => !answered && resolve(false),
    });
  });
}

/** Ask for one line of text. Resolves to the trimmed string or null when cancelled. */
export function promptDialog({ title, label, value = '', placeholder = '', confirmLabel = '확인', maxLength = 100, multiline = false } = {}) {
  return new Promise((resolve) => {
    let answered = false;
    const input = multiline
      ? h('textarea', { class: 'input', rows: 3, maxlength: maxLength, placeholder, autofocus: true }, value)
      : h('input', { class: 'input', type: 'text', maxlength: maxLength, placeholder, value, autofocus: true });
    const submit = (close) => {
      const v = input.value.trim();
      if (!v) return false;
      answered = true;
      resolve(v);
      close();
      return false;
    };
    const m = modal({
      title, size: 'sm',
      body: h('form', { onSubmit: (e) => { e.preventDefault(); submit(m.close); } },
        h('label', { class: 'field' }, label ? h('span', { class: 'label' }, label) : null, input)),
      actions: [
        { label: '취소', kind: 'secondary', onClick: () => { answered = true; resolve(null); } },
        { label: confirmLabel, kind: 'primary', onClick: (close) => submit(close), keepOpen: true },
      ],
      onClose: () => !answered && resolve(null),
    });
  });
}

/* ───────── popover menu ───────── */
let openPop = null;
/**
 * popover(anchorEl, items, { align }) — items: [{ label, icon, onClick, danger, disabled, checked } | { separator: true } | { heading: 'text' }]
 * returns { close }
 */
export function popover(anchor, items, { align = 'end', minWidth = 180 } = {}) {
  if (openPop) openPop.close();
  const menu = h('div', { class: 'popover', role: 'menu' });
  items.filter(Boolean).forEach((it) => {
    if (it.separator) return menu.appendChild(h('div', { class: 'menu-sep', role: 'separator' }));
    if (it.heading) return menu.appendChild(h('div', { class: 'menu-heading' }, it.heading));
    const b = h('button', {
      type: 'button', role: it.checked != null ? 'menuitemradio' : 'menuitem', 'aria-checked': it.checked != null ? String(!!it.checked) : null,
      class: ['menu-item', it.danger && 'danger'], disabled: !!it.disabled,
      onClick: async () => {
        close();
        try {
          if (it.onClick) await it.onClick();
        } catch (err) {
          if (err && err.message && err.code !== 'cancelled') toast(err.message, 'error');
        }
      },
    }, it.icon ? icon(it.icon, { size: 18 }) : h('span', { class: 'menu-icon-gap' }),
       h('span', { class: 'menu-label' }, it.label), it.checked ? icon('check', { size: 16, class: 'menu-check' }) : null);
    menu.appendChild(b);
  });
  menu.style.minWidth = minWidth + 'px';
  menu.style.visibility = 'hidden';
  document.body.appendChild(menu);

  const r = anchor.getBoundingClientRect();
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  let left = align === 'end' ? r.right - mw : r.left;
  left = Math.min(Math.max(8, left), window.innerWidth - mw - 8);
  let top = r.bottom + 6;
  if (top + mh > window.innerHeight - 8) top = Math.max(8, r.top - mh - 6);
  menu.style.left = left + 'px';
  menu.style.top = top + 'px';
  menu.style.visibility = '';

  const btns = () => [...menu.querySelectorAll('.menu-item:not([disabled])')];
  function onKey(e) {
    if (e.key === 'Escape') { e.stopPropagation(); close(); anchor.focus && anchor.focus(); }
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const l = btns();
      if (!l.length) return;
      const i = l.indexOf(document.activeElement);
      l[(i + (e.key === 'ArrowDown' ? 1 : -1) + l.length) % l.length].focus();
    } else if (e.key === 'Tab') close();
  }
  function onDown(e) {
    if (!menu.contains(e.target) && !anchor.contains(e.target)) close();
  }
  function close() {
    if (!menu.isConnected) return;
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('mousedown', onDown, true);
    window.removeEventListener('resize', close);
    window.removeEventListener('scroll', close, true);
    menu.remove();
    if (openPop && openPop.menu === menu) openPop = null;
  }
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('mousedown', onDown, true);
  window.addEventListener('resize', close);
  window.addEventListener('scroll', close, true);
  openPop = { close, menu };
  const first = btns()[0];
  if (first) first.focus();
  return { close };
}

/** Small helper for forms: a labelled field. */
export function field(label, control, hint) {
  return h('label', { class: 'field' }, h('span', { class: 'label' }, label), control, hint ? h('span', { class: 'hint' }, hint) : null);
}

/** Segmented radio group. options: [{value,label,icon?}]; returns { el, get(), set(v) } */
export function segmented(options, value, onChange, { name = 'seg' + Math.random().toString(36).slice(2, 6), label } = {}) {
  let cur = value;
  const el = h('div', { class: 'segmented', role: 'radiogroup', 'aria-label': label || null });
  const render = () => {
    el.replaceChildren(...options.map((o) => h('button', {
      type: 'button', role: 'radio', 'aria-checked': String(o.value === cur), class: ['seg', o.value === cur && 'on'], title: o.title || null,
      onClick: () => { cur = o.value; render(); onChange && onChange(cur); },
    }, o.icon ? icon(o.icon, { size: 16 }) : null, o.label)));
  };
  render();
  return { el, get: () => cur, set: (v) => { cur = v; render(); } };
}
