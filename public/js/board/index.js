// Board canvas entry point: mountBoard(rootEl, ctl) → { destroy() }.
// Subscribes to the BoardController and renders the chosen format incrementally: cards are cached by post.id and
// updated in place; layouts are rebuilt only when the format changes. Renders are coalesced with rAF.
import { h } from '../lib/h.js';
import { icon, toast, timeAgo } from '../lib/ui.js';
import { WALLPAPERS, DARK_WALLPAPERS } from '../lib/constants.js';
import { createCard } from './card.js';
import { createMessage } from './message.js';
import { createDnd } from './dnd.js';
import { createComposer } from './composer.js';
import { createDetail } from './detail.js';
import { createSlideshow } from './slideshow.js';
import { createList } from './layouts/list.js';
import { createWall } from './layouts/wall.js';
import { createSectioned } from './layouts/sectioned.js';
import { createCanvas } from './layouts/canvas.js';
import { createBackchannel } from './layouts/backchannel.js';
import { rafScheduler, placeSig, errorMessage } from './util.js';
import { cachedTone, loadTone } from './tone.js';

const LAYOUTS = {
  wall: createWall,
  grid: (ctx) => createList(ctx, 'grid'),
  stream: (ctx) => createList(ctx, 'stream'),
  shelf: (ctx) => createSectioned(ctx, 'shelf'),
  rows: (ctx) => createSectioned(ctx, 'rows'),
  canvas: createCanvas,
  backchannel: createBackchannel,
};

export function mountBoard(rootEl, ctl) {
  const root = h('div', { class: 'b-root' });
  const content = h('div', { class: 'b-content' });
  const fab = h('button', {
    type: 'button', class: 'b-fab', 'aria-label': '글쓰기', title: '글쓰기', hidden: true,
    onClick: () => {
      const opts = { mode: 'create' };
      if (layout && layout.suggestPosition) opts.position = layout.suggestPosition();
      ctx.composer.open(opts);
    },
  }, icon('plus', { size: 28 }));
  const layerEl = h('div', { class: 'b-layer' });
  root.append(content, fab);
  rootEl.appendChild(root);
  document.body.appendChild(layerEl);

  /* ───── shared context handed to every module ───── */
  const layers = [];
  let locks = 0;
  let blockUntil = 0;
  let down = false;
  let revealId = null;
  let destroyed = false;
  let layout = null;
  let fmt = null;
  let lastSettings = '';
  let needSync = true;
  let forceAll = false;
  const dirty = new Set();
  const placeSigs = new Map();

  const ctx = {
    ctl, root, layer: layerEl, cards: new Map(), sortable: false,
    settings: () => (ctl.state.board && ctl.state.board.settings) || {},
    format: () => (ctl.state.board && ctl.state.board.format) || 'wall',
    fail(e) {
      if (e && e.code === 'cancelled') return;
      toast(errorMessage(e, '요청을 처리하지 못했어요.'), 'error');
    },
    async run(fn) {
      try {
        return await (typeof fn === 'function' ? fn() : fn);
      } catch (e) {
        ctx.fail(e);
        return undefined;
      }
    },
    itemFor(post) {
      let it = ctx.cards.get(post.id);
      if (!it) {
        it = (ctx.format() === 'backchannel' ? createMessage : createCard)(ctx, post);
        ctx.cards.set(post.id, it);
      } else it.update(post);
      return it;
    },
    prune(posts) {
      const ids = new Set(posts.map((p) => p.id));
      for (const [id, it] of [...ctx.cards]) {
        if (!ids.has(id)) {
          it.destroy();
          ctx.cards.delete(id);
        }
      }
    },
    blockClick() {
      blockUntil = performance.now() + 350;
    },
    clickBlocked: () => performance.now() < blockUntil,
    pointerDown: () => down,
    pushLayer(name) {
      const t = { name };
      layers.push(t);
      return t;
    },
    popLayer(t) {
      const i = layers.indexOf(t);
      if (i >= 0) layers.splice(i, 1);
    },
    isTopLayer: (t) => layers[layers.length - 1] === t,
    lock() {
      if (locks++ === 0) document.documentElement.classList.add('b-lock');
    },
    unlock() {
      if (locks > 0 && --locks === 0) document.documentElement.classList.remove('b-lock');
    },
    /** Scroll a just-created card into view (after the next render). */
    reveal(id) {
      revealId = id;
      schedule();
    },
  };
  ctx.dnd = createDnd(ctx);
  ctx.composer = createComposer(ctx);
  const detail = createDetail(ctx);
  const slideshow = createSlideshow(ctx);

  /* ───── rendering ───── */
  function applyChrome(board) {
    const wp = board.wallpaper || 'green';
    const known = WALLPAPERS.includes(wp);
    // custom image: tone from its measured luminance (board/tone.js); dark until that is known or if it cannot be read
    if (!known && !cachedTone(wp)) loadTone(wp).then(() => schedule());
    const dark = known ? DARK_WALLPAPERS.includes(wp) : cachedTone(wp) !== 'light';
    const cls = `b-root b-fmt-${board.format} font-${board.font || 'sans'}${board.colorScheme === 'dark' ? ' scheme-dark' : ''}`;
    if (root.className !== cls) root.className = cls;
    root.dataset.wp = known ? wp : 'custom';
    root.dataset.tone = dark ? 'dark' : 'light';
    rootEl.dataset.format = board.format;
    layerEl.className = `b-layer font-${board.font || 'sans'}${board.colorScheme === 'dark' ? ' scheme-dark' : ''}`;
    fab.hidden = !(ctl.can('post') && board.format !== 'backchannel');
  }

  function destroyItems() {
    for (const it of ctx.cards.values()) it.destroy();
    ctx.cards.clear();
  }

  function rebuild(format) {
    ctx.dnd.cancel();
    if (layout) layout.destroy();
    destroyItems();
    fmt = format;
    ctx.sortable = format !== 'canvas' && format !== 'backchannel';
    layout = (LAYOUTS[format] || LAYOUTS.wall)(ctx);
    content.replaceChildren(layout.el);
    placeSigs.clear();
    needSync = true;
  }

  function recordPlacement() {
    placeSigs.clear();
    for (const p of ctl.state.posts) placeSigs.set(p.id, placeSig(p));
  }

  function flush() {
    if (destroyed) return;
    const s = ctl.state;
    if (s.status !== 'ready' || !s.board) return;
    const board = s.board;
    applyChrome(board);
    if (!layout || board.format !== fmt) rebuild(board.format);

    const sSig = JSON.stringify([board.settings, ctl.state.role, ctl.state.me && ctl.state.me.id]);
    if (sSig !== lastSettings) {
      lastSettings = sSig;
      forceAll = true;
    }
    if (forceAll) {
      for (const it of ctx.cards.values()) it.update(it.post, true);
      forceAll = false;
      needSync = true;
    }
    if (dirty.size) {
      for (const id of dirty) {
        const p = ctl.postById(id);
        if (!p) continue;
        const it = ctx.cards.get(id);
        if (it) it.update(p);
        if (placeSigs.get(id) !== placeSig(p)) needSync = true;
        if (layout.updatePost) layout.updatePost(p);
      }
      dirty.clear();
    }
    if (needSync) {
      needSync = false;
      layout.sync();
      recordPlacement();
      ctx.dnd.check();
    }
    detail.sync();
    slideshow.sync();
    if (revealId != null) {
      const it = ctx.cards.get(revealId);
      if (it) {
        revealId = null;
        it.el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
        it.el.classList.add('b-flash');
        setTimeout(() => it.el.classList.remove('b-flash'), 1800);
      }
    }
  }
  const schedule = rafScheduler(flush);

  function onEvent(ev) {
    if (destroyed) return;
    switch (ev.type) {
      case 'snapshot':
        detail.onSnapshot(ev);
        needSync = true;
        break;
      case 'sections':
      case 'posts':
        needSync = true;
        break;
      case 'board':
        forceAll = true;
        break;
      case 'post':
        if (ev.post) dirty.add(ev.post.id);
        break;
      case 'comments':
        detail.onComments(ev);
        dirty.add(ev.postId);
        break;
      case 'ui':
        if (!ev.openPost && !ev.slideshow) needSync = true;
        break;
      default:
        return;
    }
    schedule();
  }
  const unsub = ctl.subscribe(onEvent);

  /* ───── housekeeping ───── */
  const tick = setInterval(() => {
    for (const host of [root, layerEl]) {
      host.querySelectorAll('time[data-ts]').forEach((t) => {
        const txt = timeAgo(Number(t.dataset.ts));
        if (t.textContent !== txt) t.textContent = txt;
      });
    }
  }, 30000);
  const onDown = () => { down = true; };
  const onUp = () => { down = false; };
  document.addEventListener('pointerdown', onDown, true);
  document.addEventListener('pointerup', onUp, true);
  document.addEventListener('pointercancel', onUp, true);

  flush();

  return {
    destroy() {
      if (destroyed) return;
      destroyed = true;
      unsub();
      schedule.cancel();
      clearInterval(tick);
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('pointerup', onUp, true);
      document.removeEventListener('pointercancel', onUp, true);
      detail.destroy();
      slideshow.destroy();
      ctx.composer.destroy();
      ctx.dnd.destroy();
      if (layout) layout.destroy();
      destroyItems();
      layerEl.remove();
      root.remove();
      if (locks > 0) document.documentElement.classList.remove('b-lock');
      delete rootEl.dataset.format;
    },
  };
}
