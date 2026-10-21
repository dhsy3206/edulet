// canvas: absolutely positioned cards on a large scrollable surface. Writers drag their own cards (moderators any),
// resize the width with the right-edge handle, and unplaced cards are auto-cascaded (persisted only if allowed).
import { h } from '../../lib/h.js';
import { reconcile, clamp, isInteractive } from '../util.js';
import { createEmpty } from '../empty.js';

const DEFAULT_W = 256;
const MIN_W = 200;
const MAX_W = 640;
const PAD = 24;

export function createCanvas(ctx) {
  const { ctl } = ctx;
  const el = h('div', { class: 'b-canvas', tabindex: '-1', 'aria-label': '캔버스' });
  const surface = h('div', { class: 'b-canvas-surface' });
  const empty = createEmpty(ctx);
  el.append(surface);

  const auto = new Map(); // id → {x,y}: provisional positions for cards the server has no x/y for
  const z = new Map();
  const dragging = new Set();
  const bound = new Map(); // id → { c, unbind }
  let zTop = 10;
  let posts = [];
  let raf = 0;
  let surfRaf = 0;
  let destroyed = false;
  let activeDrag = null;

  const sizeRO = new ResizeObserver(() => scheduleSurface());

  /* ───── placement ───── */
  function applyPos(p) {
    const it = ctx.cards.get(p.id);
    if (!it || dragging.has(p.id)) return;
    const c = it.el;
    const pos = p.x != null && p.y != null ? { x: p.x, y: p.y } : auto.get(p.id);
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

  function cascade() {
    raf = 0;
    if (destroyed) return;
    const pending = posts.filter((p) => (p.x == null || p.y == null) && !auto.has(p.id) && ctx.cards.has(p.id));
    if (!pending.length) return;
    const viewW = el.clientWidth || 960;
    const colW = DEFAULT_W + PAD;
    const n = Math.max(1, Math.floor((viewW - PAD) / colW));
    const hs = new Array(n).fill(PAD);
    // start below cards that already have positions in the first columns' range
    for (const p of posts) {
      if (p.x == null || p.y == null) continue;
      const k = Math.floor((p.x - PAD / 2) / colW);
      const it = ctx.cards.get(p.id);
      if (k >= 0 && k < n && it) hs[k] = Math.max(hs[k], p.y + (it.el.offsetHeight || 240) + PAD);
    }
    const persist = [];
    for (const p of pending) {
      const it = ctx.cards.get(p.id);
      let k = 0;
      for (let i = 1; i < n; i++) if (hs[i] < hs[k]) k = i;
      const pos = { x: PAD + k * colW, y: hs[k] };
      hs[k] += (it.el.offsetHeight || 240) + PAD;
      auto.set(p.id, pos);
      applyPos(p);
      if (ctl.canMovePost(p)) persist.push([p.id, pos]);
    }
    scheduleSurface();
    persistAll(persist);
  }

  async function persistAll(list) {
    // best effort, a few at a time; failures just leave the card where it appears locally
    const queue = [...list];
    const worker = async () => {
      while (queue.length && !destroyed) {
        const [id, pos] = queue.shift();
        try {
          await ctl.setPostPosition(id, { x: pos.x, y: pos.y });
        } catch {
          /* ignore */
        }
      }
    };
    await Promise.all([worker(), worker(), worker()]);
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
        auto.delete(id);
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
        auto.delete(id);
        z.delete(id);
      }
    }
    reconcile(surface, wanted);
    empty.update(!posts.length);
    reconcile(el, [surface, ...(posts.length ? [] : [empty.el])]);
    for (const p of posts) applyPos(p);
    if (!raf) raf = requestAnimationFrame(cascade);
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
      if (raf) cancelAnimationFrame(raf);
      if (surfRaf) cancelAnimationFrame(surfRaf);
      if (activeDrag) activeDrag.cancel();
      sizeRO.disconnect();
      bound.forEach((b) => b.unbind());
      bound.clear();
      el.remove();
    },
  };
}
