// canvas: absolutely positioned cards on a large scrollable surface. Writers drag their own cards (moderators any)
// and resize the width with the right-edge handle. Cards the server has no x/y for (a board switched to canvas) sit
// in a FIXED 4-column grid in board order — a pure function of the card data, never of this window or a measurement,
// so every client shows the identical arrangement. That arrangement is never persisted: x/y are saved only when a
// user actually drags a card.
import { h } from '../../lib/h.js';
import { reconcile, clamp, isInteractive, withoutSearch, stripInvisible } from '../util.js';
import { createEmpty } from '../empty.js';

const DEFAULT_W = 256;
const MIN_W = 200;
const MAX_W = 640;
const PAD = 24;
const GRID_COLS = 4;
const GRID_STEP = 280; // x distance between grid columns (card 256 + 24 gap)
const GRID_GAP = 20; // vertical gap between grid rows

/* Card height estimated from data only (the same on every client, unlike a DOM measurement). Slightly generous. */
const emUnits = (str) => {
  let u = 0;
  for (const ch of str) {
    const c = ch.codePointAt(0);
    u += c === 32 ? 0.3 : (c >= 0x1100 && c <= 0x11ff) || (c >= 0x2e80 && c <= 0xd7af) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xff00 && c <= 0xffef) || c >= 0x1f000 ? 1 : 0.55;
  }
  return u;
};
const NL = String.fromCharCode(10);
const wrapLines = (text, perLineEm) => String(text || '').split(NL).reduce((n, para) => n + Math.max(1, Math.ceil(emUnits(para) / perLineEm)), 0);
const estCache = new Map(); // post id → { sig, h }
function estimateHeight(p) {
  const w = clamp(p.w || DEFAULT_W, MIN_W, MAX_W);
  const a = p.attachment;
  const pv = (a && a.preview) || {};
  const sig = [w, p.title, (p.body || '').slice(0, 700), a ? [a.kind, pv.image ? 1 : 0, pv.embedUrl ? 1 : 0].join('') : ''].join('|');
  const hit = estCache.get(p.id);
  if (hit && hit.sig === sig) return hit.h;
  const inner = w - 28;
  let hh = 12 + 36 + 6 + 40 + 8; // padding, header row, bottom padding, footer row, gap
  if (p.title) hh += 8 + wrapLines(stripInvisible(p.title), inner / 17.5) * 23.7;
  if (a) {
    hh += 8;
    if (a.kind === 'image') hh += Math.min(440, (w * 3) / 4);
    else if (a.kind === 'video') hh += (w * 9) / 16;
    else if (a.kind === 'link') hh += (pv.image ? (w * 9) / 16 : 0) + 78;
    else hh += (pv.image ? (w * 9) / 16 : 0) + 64;
  }
  if (p.body) hh += 8 + Math.min(wrapLines(stripInvisible((p.body || '').slice(0, 700)), inner / 14.5) * 22.5, 142);
  hh = Math.ceil(hh * 1.04);
  estCache.set(p.id, { sig, h: hh });
  return hh;
}

/** id → {x,y} grid slot for every card in board order (placed cards keep their slot reserved, so dragging one never reflows the rest). */
function gridSlots(ordered) {
  const out = new Map();
  let y = PAD;
  for (let r = 0; r * GRID_COLS < ordered.length; r++) {
    const row = ordered.slice(r * GRID_COLS, (r + 1) * GRID_COLS);
    row.forEach((p, c) => out.set(p.id, { x: PAD + c * GRID_STEP, y }));
    y += Math.max(...row.map(estimateHeight)) + GRID_GAP;
  }
  return out;
}

export function createCanvas(ctx) {
  const { ctl } = ctx;
  const el = h('div', { class: 'b-canvas', tabindex: '-1', 'aria-label': '캔버스' });
  const surface = h('div', { class: 'b-canvas-surface' });
  const empty = createEmpty(ctx);
  el.append(surface);

  let slots = new Map(); // id → {x,y}: deterministic grid slot, used while the server has no x/y for a card
  const z = new Map();
  const dragging = new Set();
  const bound = new Map(); // id → { c, unbind }
  let zTop = 10;
  let posts = [];
  let surfRaf = 0;
  let destroyed = false;
  let activeDrag = null;

  const sizeRO = new ResizeObserver(() => scheduleSurface());

  /* ───── placement ───── */
  function applyPos(p) {
    const it = ctx.cards.get(p.id);
    if (!it || dragging.has(p.id)) return;
    const c = it.el;
    const pos = p.x != null && p.y != null ? { x: p.x, y: p.y } : slots.get(p.id);
    c.style.width = (p.w || DEFAULT_W) + 'px';
    c.classList.toggle('can-move', ctl.canMovePost(p));
    if (z.has(p.id)) c.style.zIndex = z.get(p.id);
    if (pos) {
      c.style.left = pos.x + 'px';
      c.style.top = pos.y + 'px';
      c.classList.remove('is-unplaced');
    } else {
      c.classList.add('is-unplaced');
      c.style.left = '0px';
      c.style.top = '0px';
    }
  }

  function scheduleSurface() {
    if (surfRaf || destroyed) return;
    surfRaf = requestAnimationFrame(() => {
      surfRaf = 0;
      updateSurface();
    });
  }
  function updateSurface() {
    let right = 0;
    let bottom = 0;
    for (const [id] of bound) {
      const it = ctx.cards.get(id);
      if (!it) continue;
      const c = it.el;
      const x = parseFloat(c.style.left) || 0;
      const y = parseFloat(c.style.top) || 0;
      right = Math.max(right, x + c.offsetWidth);
      bottom = Math.max(bottom, y + c.offsetHeight);
    }
    surface.style.width = Math.max(el.clientWidth * 1.5, right + 400) + 'px';
    surface.style.height = Math.max(el.clientHeight * 1.5, bottom + 400) + 'px';
  }

  /* ───── dragging / resizing ───── */
  function surfaceXY(ev) {
    const r = surface.getBoundingClientRect();
    return { x: ev.clientX - r.left, y: ev.clientY - r.top };
  }

  function startDrag(e, post, c) {
    const id = post.id;
    const p0 = surfaceXY(e);
    const pos0 = { x: parseFloat(c.style.left) || 0, y: parseFloat(c.style.top) || 0 };
    const grab = { x: p0.x - pos0.x, y: p0.y - pos0.y };
    let last = { clientX: e.clientX, clientY: e.clientY };
    let moved = false;
    let loop = 0;
    try {
      c.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }

    const apply = () => {
      const r = surface.getBoundingClientRect();
      const x = Math.max(0, last.clientX - r.left - grab.x);
      const y = Math.max(0, last.clientY - r.top - grab.y);
      c.style.left = Math.round(x) + 'px';
      c.style.top = Math.round(y) + 'px';
    };
    const autoScroll = () => {
      if (!moved) return;
      const r = el.getBoundingClientRect();
      const dx = edge(last.clientX, r.left, r.right);
      const dy = edge(last.clientY, r.top, r.bottom);
      if (dx || dy) {
        el.scrollLeft += dx;
        el.scrollTop += dy;
        apply();
        scheduleSurface();
      }
      loop = requestAnimationFrame(autoScroll);
    };
    const move = (ev) => {
      if (ev.pointerId !== e.pointerId) return;
      last = ev;
      if (!moved) {
        if (Math.hypot(ev.clientX - e.clientX, ev.clientY - e.clientY) < 5) return;
        moved = true;
        dragging.add(id);
        c.classList.add('is-dragging');
        c.style.zIndex = ++zTop;
        z.set(id, zTop);
        document.documentElement.classList.add('b-drag-active');
        loop = requestAnimationFrame(autoScroll);
      }
      ev.preventDefault();
      apply();
    };
    const finish = (commit) => {
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', up, true);
      window.removeEventListener('pointercancel', cancel, true);
      window.removeEventListener('keydown', key, true);
      if (loop) cancelAnimationFrame(loop);
      activeDrag = null;
      try {
        c.releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      if (!moved) return;
      document.documentElement.classList.remove('b-drag-active');
      c.classList.remove('is-dragging');
      dragging.delete(id);
      ctx.blockClick();
      if (commit) {
        const x = Math.max(0, Math.round(parseFloat(c.style.left) || 0));
        const y = Math.max(0, Math.round(parseFloat(c.style.top) || 0));
        ctx.run(() => ctl.setPostPosition(id, { x, y })).then(() => {
          const cur = ctl.postById(id);
          if (cur) applyPos(cur);
          scheduleSurface();
        });
        scheduleSurface();
      } else {
        c.style.left = pos0.x + 'px';
        c.style.top = pos0.y + 'px';
      }
    };
    const up = (ev) => ev.pointerId === e.pointerId && finish(true);
    const cancel = () => finish(false);
    const key = (ev) => {
      if (ev.key === 'Escape') {
        ev.preventDefault();
        ev.stopPropagation();
        finish(false);
      }
    };
    window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', cancel, true);
    window.addEventListener('keydown', key, true);
    activeDrag = { cancel };
  }

  function edge(p, lo, hi) {
    const Z = 48;
    if (p < lo + Z) return -Math.ceil(((lo + Z - p) / Z) * 16);
    if (p > hi - Z) return Math.ceil(((p - (hi - Z)) / Z) * 16);
    return 0;
  }

  function startResize(e, post, c) {
    e.preventDefault();
    e.stopPropagation();
    const id = post.id;
    const w0 = c.offsetWidth;
    const x0 = e.clientX;
    let w = w0;
    let moved = false;
    try {
      e.target.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    dragging.add(id);
    c.classList.add('is-resizing');
    const move = (ev) => {
      if (ev.pointerId !== e.pointerId) return;
      moved = true;
      w = clamp(w0 + (ev.clientX - x0), MIN_W, MAX_W);
      c.style.width = Math.round(w) + 'px';
    };
    const finish = (commit) => {
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', up, true);
      window.removeEventListener('pointercancel', cancel, true);
      dragging.delete(id);
      c.classList.remove('is-resizing');
      if (!moved) return;
      ctx.blockClick();
      if (commit) {
        ctx.run(() => ctl.setPostPosition(id, { w: Math.round(w) })).then(() => {
          const cur = ctl.postById(id);
          if (cur) applyPos(cur);
          scheduleSurface();
        });
      } else c.style.width = w0 + 'px';
      scheduleSurface();
    };
    const up = (ev) => ev.pointerId === e.pointerId && finish(true);
    const cancel = () => finish(false);
    window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', cancel, true);
  }

  function bind(p, it) {
    if (bound.has(p.id)) return;
    const c = it.el;
    const handle = h('span', { class: 'b-resize b-nodrag', 'aria-hidden': 'true', title: '너비 조절' });
    c.appendChild(handle);
    const onDown = (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      const post = ctl.postById(p.id);
      if (!post || !ctl.canMovePost(post) || activeDrag) return;
      if (e.target === handle) return startResize(e, post, c);
      if (isInteractive(e.target, c)) return;
      if (e.pointerType === 'touch' && !e.target.closest('.b-card-head')) return;
      startDrag(e, post, c);
    };
    c.addEventListener('pointerdown', onDown);
    sizeRO.observe(c);
    bound.set(p.id, {
      c,
      unbind() {
        c.removeEventListener('pointerdown', onDown);
        sizeRO.unobserve(c);
        handle.remove();
      },
    });
  }

  function sync() {
    posts = ctl.sortedPosts();
    const wanted = [];
    for (const p of posts) {
      const it = ctx.itemFor(p);
      bind(p, it);
      wanted.push(it.el);
    }
    ctx.prune(posts);
    for (const [id, b] of [...bound]) {
      if (!ctx.cards.has(id) || !posts.some((p) => p.id === id)) {
        b.unbind();
        bound.delete(id);
        estCache.delete(id);
        z.delete(id);
      }
    }
    reconcile(surface, wanted);
    empty.update(!posts.length);
    reconcile(el, [surface, ...(posts.length ? [] : [empty.el])]);
    // slots follow the unfiltered board order, so typing in the search box never moves a card
    slots = gridSlots(withoutSearch(ctl, () => ctl.sortedPosts()));
    for (const p of posts) applyPos(p);
    scheduleSurface();
  }

  return {
    el,
    sync,
    updatePost(p) {
      applyPos(p);
      scheduleSurface();
    },
    /** Where a freshly composed card should land: inside the visible area, slightly cascaded. */
    suggestPosition() {
      const n = posts.length % 6;
      return { x: Math.round(el.scrollLeft + 40 + n * 28), y: Math.round(el.scrollTop + 40 + n * 28) };
    },
    destroy() {
      destroyed = true;
      if (surfRaf) cancelAnimationFrame(surfRaf);
      if (activeDrag) activeDrag.cancel();
      sizeRO.disconnect();
      bound.forEach((b) => b.unbind());
      bound.clear();
      el.remove();
    },
  };
}
