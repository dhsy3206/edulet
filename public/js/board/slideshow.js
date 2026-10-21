// Slideshow overlay: one card at a time on a dark stage. ←/→ navigate, Space toggles autoplay (5s), Esc/✕ closes.
import { h, mount } from '../lib/h.js';
import { icon, focusables } from '../lib/ui.js';
import { renderRich } from '../lib/markdown.js';
import { mediaEl } from './attachments.js';
import { authorBits } from './card.js';

const INTERVAL = 5000;

export function createSlideshow(ctx) {
  const { ctl } = ctx;
  let root = null;
  let layer = null;
  let els = null;
  let curId = null;
  let playing = false;
  let timer = 0;
  let prevFocus = null;
  let shownSig = '';

  function build() {
    const closeBtn = h('button', { type: 'button', class: 'b-ss-btn b-ss-close', 'aria-label': '슬라이드쇼 닫기', title: '닫기 (Esc)', onClick: () => ctl.closeSlideshow() }, icon('x', { size: 22 }));
    const counter = h('span', { class: 'b-ss-count', 'data-role': 'slideshow-pager', 'aria-live': 'polite' });
    const fsBtn = h('button', { type: 'button', class: 'b-ss-btn', 'aria-label': '전체 화면', title: '전체 화면', onClick: toggleFullscreen }, icon('maximize', { size: 20 }));
    const stage = h('div', { class: 'b-ss-stage' });
    const prev = h('button', { type: 'button', class: 'b-ss-btn b-ss-nav b-ss-prev', 'aria-label': '이전 카드', title: '이전 (←)', onClick: () => step(-1, true) }, icon('chevron-left', { size: 28 }));
    const next = h('button', { type: 'button', class: 'b-ss-btn b-ss-nav b-ss-next', 'aria-label': '다음 카드', title: '다음 (→)', onClick: () => step(1, true) }, icon('chevron-right', { size: 28 }));
    const playBtn = h('button', { type: 'button', class: 'b-ss-btn b-ss-play', 'aria-label': '자동 재생', 'aria-pressed': 'false', title: '자동 재생 (Space)', onClick: () => setPlaying(!playing) }, icon('play', { size: 20 }));
    const bar = h('div', { class: 'b-ss-progress', 'aria-hidden': 'true' }, h('i'));
    const top = h('div', { class: 'b-ss-top' }, closeBtn, h('span', { class: 'spacer' }), counter, fsBtn);
    const bottom = h('div', { class: 'b-ss-bottom' }, playBtn);
    const dialog = h('div', { class: 'b-ss', role: 'dialog', 'aria-modal': 'true', 'aria-label': '슬라이드쇼', tabindex: '-1' }, top, prev, stage, next, bottom, bar);
    root = h('div', { class: 'b-ss-backdrop', 'data-role': 'slideshow' }, dialog);
    els = { closeBtn, counter, stage, prev, next, playBtn, bar, dialog, fsBtn };
    dialog.addEventListener('keydown', (e) => {
      if (e.key !== 'Tab') return;
      const f = focusables(dialog);
      if (!f.length) return;
      const first = f[0];
      const last = f[f.length - 1];
      if (e.shiftKey && (document.activeElement === first || document.activeElement === dialog)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    });
  }

  function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen && document.exitFullscreen();
    else if (root && root.requestFullscreen) root.requestFullscreen().catch(() => {});
  }

  function setPlaying(v) {
    playing = v;
    clearInterval(timer);
    timer = 0;
    if (!els) return;
    els.playBtn.setAttribute('aria-pressed', String(v));
    els.playBtn.setAttribute('aria-label', v ? '일시정지' : '자동 재생');
    els.playBtn.replaceChildren(icon(v ? 'pause' : 'play', { size: 20 }));
    els.dialog.classList.toggle('is-playing', v);
    restartBar();
    if (v) timer = setInterval(() => step(1, false), INTERVAL);
  }

  function restartBar() {
    const i = els.bar.firstChild;
    i.style.animation = 'none';
    // eslint-disable-next-line no-unused-expressions
    i.offsetWidth;
    i.style.animation = '';
  }

  function step(delta, manual) {
    const nav = ctl.navPosts();
    if (!nav.length) return;
    let i = nav.findIndex((p) => p.id === curId);
    if (i < 0) i = 0;
    let n = i + delta;
    if (n >= nav.length) n = manual ? nav.length - 1 : 0;
    if (n < 0) n = 0;
    curId = nav[n].id;
    show();
    if (playing && manual) setPlaying(true); // restart the 5s clock after a manual move
  }

  const onKey = (e) => {
    if (!root || e.defaultPrevented || !ctx.isTopLayer(layer)) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      ctl.closeSlideshow();
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      step(e.key === 'ArrowLeft' ? -1 : 1, true);
    } else if ((e.key === ' ' || e.code === 'Space') && !(e.target.closest && e.target.closest('button, a, input, textarea, select'))) {
      e.preventDefault();
      setPlaying(!playing);
    }
  };

  function show() {
    const nav = ctl.navPosts();
    if (!nav.length) {
      els.counter.textContent = '0 / 0';
      els.stage.replaceChildren(h('p', { class: 'b-ss-empty' }, '보여 줄 카드가 없어요.'));
      els.prev.disabled = true;
      els.next.disabled = true;
      shownSig = '';
      return;
    }
    let i = nav.findIndex((p) => p.id === curId);
    if (i < 0) {
      i = 0;
      curId = nav[0].id;
    }
    const post = nav[i];
    els.counter.textContent = `${i + 1} / ${nav.length}`;
    els.prev.disabled = i === 0;
    els.next.disabled = i === nav.length - 1 && !playing;
    const a = post.attachment;
    const sig = [post.id, post.title, post.body, post.updatedAt, a && a.url, ctx.settings().showAuthor].join('\u0001');
    if (sig === shownSig) return;
    shownSig = sig;
    const m = mediaEl(ctx, post);
    const b = authorBits(ctx, post, { size: 28 });
    els.stage.className = 'b-ss-stage' + (m ? ' has-media' : ' text-only');
    mount(els.stage,
      m ? h('div', { class: 'b-ss-media' }, m) : null,
      h('div', { class: 'b-ss-text' },
        post.title ? h('h2', { class: 'b-ss-title' }, post.title) : null,
        post.body ? h('div', { class: 'b-ss-body' }, renderRich(post.body)) : null,
        b.name ? h('div', { class: 'b-ss-by' }, b.av, b.name) : null));
  }

  function open() {
    prevFocus = document.activeElement;
    build();
    layer = ctx.pushLayer('slideshow');
    ctx.lock();
    ctx.layer.appendChild(root);
    document.addEventListener('keydown', onKey);
    const nav = ctl.navPosts();
    const start = ctl.state.openPostId;
    curId = nav.some((p) => p.id === start) ? start : nav[0] ? nav[0].id : null;
    shownSig = '';
    show();
    els.dialog.focus(); // not a button, so Space toggles autoplay right away
  }

  function close() {
    if (!root) return;
    document.removeEventListener('keydown', onKey);
    clearInterval(timer);
    timer = 0;
    playing = false;
    if (document.fullscreenElement) document.exitFullscreen && document.exitFullscreen().catch(() => {});
    const r = root;
    r.classList.add('out');
    setTimeout(() => r.remove(), 120);
    ctx.popLayer(layer);
    ctx.unlock();
    root = null;
    layer = null;
    els = null;
    if (prevFocus && prevFocus.focus && document.contains(prevFocus)) prevFocus.focus();
    prevFocus = null;
  }

  return {
    sync() {
      if (ctl.state.slideshow) {
        if (!root) open();
        else show();
      } else close();
    },
    isOpen: () => !!root,
    destroy: close,
  };
}
