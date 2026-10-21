// Detail overlay: large media on the left, 360px panel (author, title, body, reactions, comments) on the right.
// Driven entirely by ctl.state.openPostId; sync() is idempotent and keeps the iframe/comments alive across live updates.
import { h } from '../lib/h.js';
import { icon, toast, focusables } from '../lib/ui.js';
import { renderRich } from '../lib/markdown.js';
import { POST_COLORS } from '../lib/constants.js';
import { mediaEl } from './attachments.js';
import { createReactions } from './reactions.js';
import { createComments } from './comments.js';
import { openPostMenu } from './actions.js';
import { authorBits } from './card.js';
import { postSig, withoutSearch } from './util.js';

const EDITABLE = 'input,textarea,select,[contenteditable="true"]';

export function createDetail(ctx) {
  const { ctl } = ctx;
  let root = null;
  let layer = null;
  let openId = null;
  let prevFocus = null;
  let sigs = {};
  let els = null;
  let reactions = null;
  let comments = null;
  let cur = null;
  let snapCheck = false; // a snapshot arrived: re-check the open post's comment list against the server's count
  let snapForce = false; // …and it was a reconnect resync: reload the list for sure

  /**
   * Cards in pager order. While the open card matches the active search that is the filtered list; once it does
   * not (search changed under the open detail) fall back to the unfiltered order so "n / N" and the arrows still work.
   */
  function navList() {
    const nav = ctl.navPosts();
    const i = nav.findIndex((p) => p.id === openId);
    if (i >= 0 || !ctl.state.search) return { nav, i };
    const all = withoutSearch(ctl, () => ctl.navPosts());
    return { nav: all, i: all.findIndex((p) => p.id === openId), unfiltered: true };
  }

  function build() {
    comments = createComments(ctx, { onAdded: () => requestAnimationFrame(() => { els.scroll.scrollTop = els.scroll.scrollHeight; }) });
    const closeBtn = h('button', { type: 'button', class: 'b-d-close', 'aria-label': '닫기', title: '닫기 (Esc)', onClick: () => ctl.closePost() }, icon('x', { size: 22 }));
    const pager = h('span', { class: 'b-d-pager', 'data-role': 'detail-pager', 'aria-live': 'polite' });
    const prev = h('button', { type: 'button', class: 'b-d-arrow', 'aria-label': '이전 글', title: '이전 (←)', onClick: () => go(-1) }, icon('chevron-left', { size: 22 }));
    const next = h('button', { type: 'button', class: 'b-d-arrow', 'aria-label': '다음 글', title: '다음 (→)', onClick: () => go(1) }, icon('chevron-right', { size: 22 }));
    const nav = h('div', { class: 'b-d-nav' }, pager, prev, next);
    const media = h('div', { class: 'b-d-media' });
    const info = h('div', { class: 'b-d-info' });
    const react = h('div', { class: 'b-d-react' });
    const scroll = h('div', { class: 'b-d-scroll' }, info, react, comments.listEl);
    const panel = h('aside', { class: 'b-d-panel', 'aria-label': '카드 정보와 댓글' }, scroll, comments.formEl);
    const dialog = h('div', { class: 'b-detail', role: 'dialog', 'aria-modal': 'true', 'aria-label': '카드 상세', tabindex: '-1' }, closeBtn, nav, media, panel);
    root = h('div', { class: 'b-detail-backdrop', 'data-role': 'detail' }, dialog);
    els = { closeBtn, pager, prev, next, media, info, react, scroll, dialog };
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

  function go(delta) {
    const { nav, i } = navList();
    const t = nav[i + delta];
    if (i >= 0 && t) ctl.openPost(t.id);
  }

  const onKey = (e) => {
    if (!root || e.defaultPrevented || !ctx.isTopLayer(layer)) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      ctl.closePost();
    } else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
      if (e.target && e.target.closest && e.target.closest(EDITABLE)) return;
      e.preventDefault();
      go(e.key === 'ArrowLeft' ? -1 : 1);
    }
  };

  function open(post) {
    prevFocus = document.activeElement;
    build();
    layer = ctx.pushLayer('detail');
    ctx.lock();
    ctx.layer.appendChild(root);
    document.addEventListener('keydown', onKey);
    els.closeBtn.focus();
    reactions = createReactions(ctx, post, { variant: 'detail' });
    els.react.appendChild(reactions.el);
  }

  function close() {
    if (!root) return;
    document.removeEventListener('keydown', onKey);
    const r = root;
    r.classList.add('out');
    setTimeout(() => r.remove(), 120);
    ctx.popLayer(layer);
    ctx.unlock();
    reactions && reactions.destroy();
    comments && comments.destroy();
    root = null;
    layer = null;
    openId = null;
    sigs = {};
    reactions = null;
    comments = null;
    cur = null;
    snapCheck = snapForce = false;
    if (prevFocus && prevFocus.focus && document.contains(prevFocus)) prevFocus.focus();
    prevFocus = null;
  }

  function renderMedia(post) {
    const m = mediaEl(ctx, post);
    els.dialog.classList.toggle('is-text', !m);
    if (m) {
      els.media.className = 'b-d-media';
      els.media.replaceChildren(m);
      return;
    }
    // text-only: the body is the "media"
    els.media.className = 'b-d-media is-text' + (post.color && POST_COLORS.includes(post.color) ? ' pc-' + post.color : '');
    const body = post.body
      ? h('div', { class: 'b-d-bigtext' }, renderRich(post.body))
      : h('div', { class: 'b-d-bigtext is-title' }, post.title || '');
    els.media.replaceChildren(body);
  }

  function renderInfo(post) {
    const s = ctx.settings();
    const b = authorBits(ctx, post, { size: 36 });
    const menuBtn = h('button', { type: 'button', class: 'btn-icon sm', 'aria-label': '카드 메뉴', 'aria-haspopup': 'menu', onClick: () => openPostMenu(ctx, menuBtn, cur) }, icon('more-v', { size: 18 }));
    const hasMedia = !!post.attachment;
    const bodyInMedia = !hasMedia && !!post.body;
    const kids = [
      h('div', { class: 'b-d-head' }, b.av, h('div', { class: 'b-d-meta' }, b.name, b.time),
        post.pinned ? h('span', { class: 'b-badge b-badge-pin' }, icon('pin', { size: 12 }), '고정됨') : null,
        post.status === 'pending' ? h('span', { class: 'b-badge b-badge-pending' }, '승인 대기') : null,
        h('span', { class: 'spacer' }), menuBtn),
      post.title && !(!hasMedia && !post.body) ? h('h2', { class: 'b-d-title' }, post.title) : null,
      post.body && !bodyInMedia ? h('div', { class: 'b-d-body' }, renderRich(post.body)) : null,
    ];
    els.info.replaceChildren(...kids.filter(Boolean));
    els.info.classList.toggle('no-author', s.showAuthor === false);
  }

  function updatePager() {
    const { nav, i } = navList();
    els.pager.textContent = i >= 0 ? `${i + 1} / ${nav.length}` : `${nav.length}개`;
    els.prev.disabled = i <= 0;
    els.next.disabled = i < 0 || i >= nav.length - 1;
  }

  function sync() {
    const id = ctl.state.openPostId;
    if (id == null) {
      close();
      return;
    }
    const post = ctl.postById(id);
    if (!post) {
      // deep link to a card that doesn't exist (or was removed): drop back to the board
      if (!root) toast('카드를 찾을 수 없어요. 삭제되었거나 볼 수 없는 카드예요.', 'error');
      ctl.closePost();
      close();
      return;
    }
    cur = post;
    if (!root) open(post);
    let fresh = false;
    if (openId !== id) {
      openId = id;
      sigs = {};
      comments.load(id);
      els.scroll.scrollTop = 0;
      fresh = true;
    }
    const a = post.attachment;
    const mSig = `${id}|${a ? [a.kind, a.url, a.preview && a.preview.embedUrl, a.preview && a.preview.image, a.preview && a.preview.title].join('|') : `${post.title}|${post.body}|${post.color}`}`;
    if (sigs.media !== mSig) {
      sigs.media = mSig;
      renderMedia(post);
    }
    const iSig = postSig(post, ctx.settings().showAuthor + '|' + ctl.can('moderate'));
    if (sigs.info !== iSig) {
      sigs.info = iSig;
      renderInfo(post);
    }
    reactions.update(post);
    comments.refreshAccess();
    updatePager();
    if (snapCheck) {
      // after a snapshot (esp. a reconnect) the list may have missed comments: compare with the card's count
      const force = snapForce;
      snapCheck = snapForce = false;
      const shown = comments.count();
      if (!fresh && (force || (shown !== null && shown !== post.commentCount))) comments.refresh();
    }
  }

  return {
    sync,
    onComments(ev) {
      if (comments) comments.onEvent(ev);
    },
    /** A (re)fetched snapshot was applied; `resync` = it followed a reconnect. */
    onSnapshot(ev) {
      if (!root) return;
      snapCheck = true;
      if (ev && ev.resync) snapForce = true;
    },
    isOpen: () => !!root,
    destroy: close,
  };
}
