// Pointer-based drag & drop for reordering cards (and sections). Mouse/pen only — touch users get the ⋮ menu
// alternatives (맨 앞으로 / 맨 뒤로 / 섹션으로 이동…). Works with the incremental renderer because nothing here
// owns DOM: a floating ghost shows the card, a fixed-position bar shows the drop spot, and the move is a ctl call.
import { h } from '../lib/h.js';
import { isInteractive, scrollChain } from './util.js';

const THRESHOLD = 6;
const EDGE = 56;

function edgeSpeed(p, lo, hi) {
  if (p < lo + EDGE) return -Math.ceil(((lo + EDGE - p) / EDGE) * 18);
  if (p > hi - EDGE) return Math.ceil(((p - (hi - EDGE)) / EDGE) * 18);
  return 0;
}

/**
 * Zones: dnd.zone(el, { kind: 'post'|'section', axis: 'x'|'y', sectionId?, items(): [{id, el}], slot?(): Element })
 * Items: dnd.bindItem(triggerEl, { kind, id(), canDrag(), item?(): Element, ghost?(): Element })
 */
export function createDnd(ctx) {
  const zones = new Map();
  const indicator = h('div', { class: 'b-drop-indicator', hidden: true, 'aria-hidden': 'true' });
  let st = null;

  function zone(el, info) {
    el.setAttribute('data-b-zone', info.kind);
    zones.set(el, info);
    return () => {
      zones.delete(el);
      el.removeAttribute('data-b-zone');
    };
  }

  function bindItem(trigger, opts) {
    const onDown = (e) => {
      if (e.button !== 0 || e.pointerType === 'touch' || st) return;
      if (!opts.canDrag()) return;
      const item = opts.item ? opts.item() : trigger;
      if (isInteractive(e.target, trigger)) return;
      st = {
        phase: 'pending', kind: opts.kind, id: opts.id(), item, ghostSrc: opts.ghost ? opts.ghost() : item,
        x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, pointerId: e.pointerId, target: null, raf: 0, ghost: null,
      };
      window.addEventListener('pointermove', onMove, true);
      window.addEventListener('pointerup', onUp, true);
      window.addEventListener('pointercancel', cancel, true);
      window.addEventListener('keydown', onKey, true);
      window.addEventListener('blur', cancel);
    };
    const onNativeDrag = (e) => e.preventDefault();
    trigger.addEventListener('pointerdown', onDown);
    trigger.addEventListener('dragstart', onNativeDrag);
    return () => {
      trigger.removeEventListener('pointerdown', onDown);
      trigger.removeEventListener('dragstart', onNativeDrag);
      if (st && (st.item === (opts.item ? opts.item() : trigger))) cancel();
    };
  }

  function begin() {
    const { item } = st;
    const r = item.getBoundingClientRect();
    st.offX = st.x0 - r.left;
    st.offY = st.y0 - r.top;
    const g = st.ghostSrc.cloneNode(true);
    g.removeAttribute('data-post-id');
    g.removeAttribute('data-section-id');
    g.removeAttribute('tabindex');
    g.querySelectorAll('[data-post-id],[data-section-id],[data-role],[tabindex],[id]').forEach((n) => {
      n.removeAttribute('data-post-id');
      n.removeAttribute('data-section-id');
      n.removeAttribute('data-role');
      n.removeAttribute('tabindex');
      n.removeAttribute('id');
    });
    const gr = st.ghostSrc.getBoundingClientRect();
    g.classList.add('b-drag-ghost');
    g.setAttribute('aria-hidden', 'true');
    g.style.width = gr.width + 'px';
    st.gOffX = st.x0 - gr.left;
    st.gOffY = st.y0 - gr.top;
    (ctx.layer || document.body).appendChild(g);
    st.ghost = g;
    (ctx.layer || document.body).appendChild(indicator);
    item.classList.add('b-dragging');
    document.documentElement.classList.add('b-drag-active');
    const sel = window.getSelection && window.getSelection();
    if (sel && sel.removeAllRanges) sel.removeAllRanges();
    st.phase = 'active';
    moveGhost();
    loop();
  }

  function moveGhost() {
    st.ghost.style.transform = `translate(${st.x - st.gOffX}px, ${st.y - st.gOffY}px) rotate(1.5deg)`;
  }

  function showIndicator(rect, axis) {
    if (!rect) {
      indicator.hidden = true;
      return;
    }
    indicator.hidden = false;
    indicator.dataset.axis = axis;
    indicator.style.left = rect.left + 'px';
    indicator.style.top = rect.top + 'px';
    indicator.style.width = rect.width + 'px';
    indicator.style.height = rect.height + 'px';
  }

  function updateTarget() {
    const { x, y } = st;
    const under = document.elementFromPoint(x, y);
    let zEl = under && under.closest ? under.closest('[data-b-zone]') : null;
    while (zEl && (!zones.has(zEl) || zones.get(zEl).kind !== st.kind)) zEl = zEl.parentElement ? zEl.parentElement.closest('[data-b-zone]') : null;
    if (!zEl) {
      st.target = null;
      showIndicator(null);
      return;
    }
    const info = zones.get(zEl);
    const all = info.items();
    const items = all.filter((i) => i.id !== st.id && i.el.isConnected);
    let before = null;
    let rect;
    if (!items.length) {
      const slot = (info.slot ? info.slot() : null) || zEl;
      const r = slot.getBoundingClientRect();
      rect = info.axis === 'x'
        ? { left: r.left + 8, top: r.top + 8, width: 4, height: Math.max(60, Math.min(r.height - 16, 160)) }
        : { left: r.left + 8, top: r.top + 8, width: Math.max(60, r.width - 16), height: 4 };
    } else {
      let hit = null;
      let best = null;
      let bestD = Infinity;
      for (const it of items) {
        const r = it.el.getBoundingClientRect();
        if (!r.width && !r.height) continue;
        if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
          hit = { it, r };
          break;
        }
        const dx = x < r.left ? r.left - x : x > r.right ? x - r.right : 0;
        const dy = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0;
        const d = dx * dx + dy * dy;
        if (d < bestD) {
          bestD = d;
          best = { it, r };
        }
      }
      const t = hit || best;
      if (!t) {
        st.target = null;
        showIndicator(null);
        return;
      }
      const after = info.axis === 'x' ? x > t.r.left + t.r.width / 2 : y > t.r.top + t.r.height / 2;
      const idx = items.indexOf(t.it);
      before = after ? (items[idx + 1] ? items[idx + 1].id : null) : t.it.id;
      const r = t.r;
      if (info.axis === 'x') rect = { left: (after ? r.right : r.left) - 2 + (after ? 8 : -8), top: r.top, width: 4, height: r.height };
      else rect = { left: r.left, top: (after ? r.bottom : r.top) - 2 + (after ? 8 : -8), width: r.width, height: 4 };
    }
    const dragIdx = all.findIndex((i) => i.id === st.id);
    const noop = dragIdx >= 0 && before === (all[dragIdx + 1] ? all[dragIdx + 1].id : null) && (info.sectionId === undefined || info.sectionId === st.fromSection);
    st.target = { info, before, noop };
    showIndicator(rect, info.axis);
    indicator.classList.toggle('is-noop', noop);
  }

  function step() {
    const under = document.elementFromPoint(st.x, st.y);
    if (!under) return;
    let moved = false;
    for (const sc of scrollChain(under)) {
      const doc = sc === document.scrollingElement || sc === document.documentElement;
      const r = doc ? { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight } : sc.getBoundingClientRect();
      const dx = edgeSpeed(st.x, r.left, r.right);
      const dy = edgeSpeed(st.y, r.top, r.bottom);
      if (dx) {
        const b = sc.scrollLeft;
        sc.scrollLeft += dx;
        if (sc.scrollLeft !== b) moved = true;
      }
      if (dy) {
        const b = sc.scrollTop;
        sc.scrollTop += dy;
        if (sc.scrollTop !== b) moved = true;
      }
    }
    if (moved) updateTarget();
  }

  function loop() {
    if (!st || st.phase !== 'active') return;
    step();
    st.raf = requestAnimationFrame(loop);
  }

  function onMove(e) {
    if (!st || (e.pointerId !== st.pointerId)) return;
    st.x = e.clientX;
    st.y = e.clientY;
    if (st.phase === 'pending') {
      if (Math.hypot(st.x - st.x0, st.y - st.y0) < THRESHOLD) return;
      // remember where the dragged card currently lives (to detect no-op drops)
      st.fromSection = st.kind === 'post' ? (ctx.ctl.postById(st.id) ? ctx.ctl.postById(st.id).sectionId ?? null : null) : undefined;
      begin();
    }
    e.preventDefault();
    moveGhost();
    updateTarget();
  }

  function cleanup() {
    window.removeEventListener('pointermove', onMove, true);
    window.removeEventListener('pointerup', onUp, true);
    window.removeEventListener('pointercancel', cancel, true);
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('blur', cancel);
    if (st) {
      if (st.raf) cancelAnimationFrame(st.raf);
      if (st.ghost) st.ghost.remove();
      if (st.item) st.item.classList.remove('b-dragging');
    }
    indicator.hidden = true;
    indicator.remove();
    document.documentElement.classList.remove('b-drag-active');
    st = null;
  }

  function onUp(e) {
    if (!st || e.pointerId !== st.pointerId) return;
    const was = st;
    const active = was.phase === 'active';
    if (active) {
      st.x = e.clientX;
      st.y = e.clientY;
      updateTarget();
    }
    const t = was.target;
    cleanup();
    if (!active) return;
    ctx.blockClick();
    if (!t || t.noop) return;
    if (was.kind === 'post') {
      const { ctl } = ctx;
      let sectionId = t.info.sectionId;
      if (sectionId === undefined) {
        // non-sectioned format: join the neighbour's list (stale section ids may exist from an earlier format)
        const nb = t.before != null ? ctl.postById(t.before) : null;
        const me = ctl.postById(was.id);
        sectionId = nb ? nb.sectionId ?? null : me ? me.sectionId ?? null : null;
      }
      ctx.run(() => ctl.movePost(was.id, { sectionId: sectionId ?? null, beforeId: t.before }));
    }
    else if (was.kind === 'section') ctx.run(() => ctx.ctl.moveSection(was.id, t.before));
  }

  function cancel() {
    if (!st) return;
    const active = st.phase === 'active';
    cleanup();
    if (active) ctx.blockClick();
  }

  function onKey(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      cancel();
    }
  }

  return {
    zone,
    bindItem,
    cancel,
    isDragging: () => !!st && st.phase === 'active',
    /** Cancel when the dragged element vanished (deleted remotely). */
    check() {
      if (st && st.item && !st.item.isConnected) cancel();
    },
    destroy() {
      cancel();
      zones.clear();
    },
  };
}
