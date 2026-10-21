// wall: JS masonry. Cards are placed in post order, each into the currently shortest column, so reading order
// matches ctl.sortedPosts(). Re-balances on structure/column-count changes and (briefly) while images settle.
import { h } from '../../lib/h.js';
import { reconcile } from '../util.js';
import { createEmpty } from '../empty.js';

const MIN_COL = 240;
const GAP = 16;
const ESTIMATE = 230;
const SETTLE_MS = 1400;

export function createWall(ctx) {
  const { ctl } = ctx;
  const el = h('div', { class: 'b-wall' });
  const empty = createEmpty(ctx);
  const heights = new Map();
  let cols = [];
  let posts = [];
  let structAt = 0;
  let timer = 0;
  let destroyed = false;

  const items = () => ctl.sortedPosts().map((p) => ({ id: p.id, el: ctx.cards.get(p.id) && ctx.cards.get(p.id).el })).filter((i) => i.el);
  const unzone = ctx.dnd.zone(el, { kind: 'post', axis: 'y', items });

  function columnCount() {
    const w = el.clientWidth || el.parentElement?.clientWidth || window.innerWidth;
    if (window.innerWidth <= 640 || w <= 640) return 1;
    return Math.max(1, Math.min(8, Math.floor((w + GAP) / (MIN_COL + GAP))));
  }

  function ensureColumns(n) {
    while (cols.length < n) cols.push(h('div', { class: 'b-wall-col' }));
    while (cols.length > n) cols.pop().remove();
    el.style.setProperty('--b-cols', String(n));
  }

  // Heights come from a ResizeObserver on the cards; unseen cards use an estimate.
  const cardRO = new ResizeObserver((entries) => {
    let changed = false;
    for (const e of entries) {
      const id = Number(e.target.dataset.postId);
      const hh = e.borderBoxSize && e.borderBoxSize[0] ? e.borderBoxSize[0].blockSize : e.target.offsetHeight;
      if (hh && heights.get(id) !== hh) {
        heights.set(id, hh);
        changed = true;
      }
    }
    // Only re-balance while the layout is still settling (images loading) and the user isn't pressing a button.
    if (changed && performance.now() - structAt < SETTLE_MS && !ctx.pointerDown()) scheduleRelayout();
  });
  const observed = new WeakSet();

  const boxRO = new ResizeObserver(() => {
    if (destroyed) return;
    if (columnCount() !== cols.length && posts.length) scheduleRelayout(true);
  });
  boxRO.observe(el);

  function scheduleRelayout(structural) {
    if (timer) return;
    timer = requestAnimationFrame(() => {
      timer = 0;
      if (destroyed) return;
      if (structural) structAt = performance.now();
      place();
    });
  }

  function place() {
    if (!posts.length) return;
    const n = columnCount();
    ensureColumns(n);
    const hs = new Array(n).fill(0);
    const lists = Array.from({ length: n }, () => []);
    for (const p of posts) {
      const it = ctx.cards.get(p.id);
      if (!it) continue;
      let k = 0;
      for (let i = 1; i < n; i++) if (hs[i] < hs[k]) k = i;
      lists[k].push(it.el);
      hs[k] += (heights.get(p.id) || ESTIMATE) + GAP;
      if (!observed.has(it.el)) {
        observed.add(it.el);
        cardRO.observe(it.el);
      }
    }
    // Columns first appear in the container, then each gets its cards.
    reconcile(el, cols);
    cols.forEach((c, i) => reconcile(c, lists[i]));
  }

  function sync() {
    posts = ctl.sortedPosts();
    for (const p of posts) ctx.itemFor(p);
    ctx.prune(posts);
    for (const id of [...heights.keys()]) if (!ctx.cards.has(id)) heights.delete(id);
    empty.update(!posts.length);
    structAt = performance.now();
    if (!posts.length) {
      reconcile(el, [empty.el]);
      return;
    }
    place();
  }

  return {
    el,
    sync,
    destroy() {
      destroyed = true;
      if (timer) cancelAnimationFrame(timer);
      cardRO.disconnect();
      boxRO.disconnect();
      unzone();
      el.remove();
    },
  };
}
