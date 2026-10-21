// Comments for the open post: list (live-updated, deduped by id) + input (Enter sends, Shift+Enter newline).
import { h } from '../lib/h.js';
import { icon, avatar, timeAgo, fullTime, confirmDialog } from '../lib/ui.js';
import { store } from '../lib/store.js';
import { renderRich } from '../lib/markdown.js';
import { LIMITS } from '../lib/constants.js';
import { isIme, autosize } from './util.js';

/**
 * createComments(ctx, { onAdded }) → { listEl, formEl, load(postId), onEvent(ev), refreshAccess(), destroy() }
 * listEl = heading + list (goes in the panel's scroll area); formEl = pinned input area.
 */
export function createComments(ctx, { onAdded } = {}) {
  const { ctl } = ctx;
  let postId = null;
  let token = 0;
  let loaded = false;
  const nodes = new Map(); // comment id → element
  const seen = new Set();

  const countEl = h('span', { class: 'b-comments-count' });
  const head = h('h3', { class: 'b-comments-head' }, '댓글 ', countEl);
  const list = h('div', { class: 'b-comments-list', role: 'list' });
  const status = h('p', { class: 'b-comments-status' });
  const listEl = h('div', { class: 'b-comments' }, head, status, list);

  const ta = h('textarea', { class: 'b-comment-input', name: 'comment', rows: 1, maxlength: LIMITS.comment, placeholder: '댓글을 입력하세요', 'aria-label': '댓글 입력', 'data-role': 'comment-input' });
  const sendBtn = h('button', { type: 'button', class: 'b-comment-send', 'aria-label': '댓글 보내기', title: '보내기 (Enter)', 'data-role': 'comment-send', onClick: () => send() }, icon('send', { size: 18 }));
  const row = h('div', { class: 'b-comment-row' }, ta, sendBtn);
  const lock = h('p', { class: 'b-comment-lock' });
  const formEl = h('div', { class: 'b-comment-form' }, row, lock);
  let sending = false;

  function refreshSend() {
    sendBtn.disabled = sending || !ta.value.trim();
  }
  function refreshAccess() {
    const off = ctl.state.board && ctl.state.board.settings.comments === 'off';
    const can = ctl.can('comment');
    row.hidden = !can;
    lock.hidden = can;
    if (!can) lock.textContent = off ? '이 보드는 댓글이 꺼져 있어요.' : '댓글을 쓸 권한이 없어요. 보기만 할 수 있는 링크예요.';
    head.hidden = !!off && !nodes.size;
    renderStatus();
  }
  function setCount(n) {
    countEl.textContent = n > 0 ? String(n) : '';
  }
  function renderStatus() {
    if (!loaded) {
      status.hidden = false;
      return;
    }
    if (nodes.size) {
      status.hidden = true;
      return;
    }
    status.hidden = false;
    status.textContent = ctl.state.board && ctl.state.board.settings.comments === 'off' ? '' : ctl.can('comment') ? '아직 댓글이 없어요. 첫 댓글을 남겨 보세요.' : '아직 댓글이 없어요.';
  }

  function makeNode(c) {
    const mine = !!(store.me && c.author && c.author.id === store.me.id);
    const del = mine || ctl.can('moderate')
      ? h('button', {
        type: 'button', class: 'b-comment-del btn-icon sm', 'aria-label': '댓글 삭제', title: '삭제',
        onClick: async () => {
          const ok = await confirmDialog({ title: '댓글을 삭제할까요?', message: '삭제한 댓글은 되돌릴 수 없어요.', confirmLabel: '삭제', danger: true });
          if (ok) ctx.run(() => ctl.deleteComment(c.id, postId));
        },
      }, icon('trash', { size: 15 }))
      : null;
    return h('div', { class: ['b-comment', mine && 'mine'], role: 'listitem', 'data-comment-id': c.id },
      avatar(c.author, 28),
      h('div', { class: 'b-comment-main' },
        h('div', { class: 'b-comment-meta' },
          h('span', { class: 'b-author' }, (c.author && c.author.displayName) || '익명'),
          h('time', { class: 'b-time', datetime: new Date(c.createdAt).toISOString(), title: fullTime(c.createdAt), 'data-ts': c.createdAt }, timeAgo(c.createdAt)),
          del),
        h('div', { class: 'b-comment-body' }, renderRich(c.body))));
  }

  function add(c) {
    if (seen.has(c.id)) return false;
    seen.add(c.id);
    const n = makeNode(c);
    nodes.set(c.id, n);
    list.appendChild(n);
    return true;
  }

  async function load(id) {
    postId = id;
    const my = ++token;
    loaded = false;
    nodes.clear();
    seen.clear();
    list.replaceChildren();
    status.textContent = '댓글을 불러오는 중…';
    status.hidden = false;
    const post = ctl.postById(id);
    setCount(post ? post.commentCount : 0);
    refreshAccess();
    try {
      const cs = await ctl.loadComments(id);
      if (my !== token) return;
      cs.forEach(add);
      loaded = true;
      setCount(cs.length);
      renderStatus();
      refreshAccess();
    } catch (e) {
      if (my !== token) return;
      status.textContent = '댓글을 불러오지 못했어요.';
      ctx.fail(e);
    }
  }

  function onEvent(ev) {
    if (ev.type !== 'comments' || ev.postId !== postId || !loaded) return;
    if (ev.deleted) {
      const n = nodes.get(ev.commentId);
      if (n) {
        n.remove();
        nodes.delete(ev.commentId);
        seen.delete(ev.commentId);
      }
    } else if (ev.comment) {
      const added = add(ev.comment);
      if (added && onAdded && ev.mine) onAdded();
    }
    if (typeof ev.commentCount === 'number') setCount(ev.commentCount);
    renderStatus();
    refreshAccess();
  }

  async function send() {
    if (sending || postId == null) return;
    const text = ta.value.trim();
    if (!text) return;
    sending = true;
    refreshSend();
    const c = await ctx.run(() => ctl.addComment(postId, text));
    sending = false;
    if (c) {
      ta.value = '';
      autosize(ta, 120);
      if (add(c) && onAdded) onAdded();
      const p = ctl.postById(postId);
      setCount(nodes.size || (p ? p.commentCount : 0));
      renderStatus();
      refreshAccess();
      if (onAdded) onAdded();
    }
    refreshSend();
    ta.focus();
  }

  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.altKey && !isIme(e)) {
      e.preventDefault();
      send();
    }
  });
  ta.addEventListener('input', () => {
    autosize(ta, 120);
    refreshSend();
  });
  refreshSend();
  refreshAccess();

  return {
    listEl,
    formEl,
    load,
    onEvent,
    refreshAccess,
    focusInput: () => ta.focus(),
    destroy() {
      token++;
    },
  };
}
