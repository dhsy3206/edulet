// The post card (b-card): header, title, attachment, rich body, reactions + comment count.
import { h, mount } from '../lib/h.js';
import { icon, avatar, timeAgo, fullTime } from '../lib/ui.js';
import { renderRich } from '../lib/markdown.js';
import { POST_COLORS } from '../lib/constants.js';
import { attachmentEl } from './attachments.js';
import { createReactions } from './reactions.js';
import { openPostMenu } from './actions.js';

// Tall bodies are clamped; measure in one batched rAF to avoid layout thrash.
const clampQueue = new Set();
let clampRaf = 0;
function queueClamp(card) {
  clampQueue.add(card);
  if (clampRaf) return;
  clampRaf = requestAnimationFrame(() => {
    clampRaf = 0;
    const list = [...clampQueue];
    clampQueue.clear();
    const res = list.map((c) => c.measureClamp());
    list.forEach((c, i) => c.applyClamp(res[i]));
  });
}

const COLOR_CLASSES = POST_COLORS.filter(Boolean).map((c) => 'pc-' + c);

/** Build the author/time header bits. Shared with the chat message and detail panel. */
export function authorBits(ctx, p, { size = 32 } = {}) {
  const show = ctx.settings().showAuthor !== false;
  const av = show ? avatar(p.author, size) : null;
  const name = show ? h('span', { class: 'b-author' }, (p.author && p.author.displayName) || '익명') : null;
  const time = h('time', { class: 'b-time', datetime: new Date(p.createdAt).toISOString(), title: fullTime(p.createdAt), 'data-ts': p.createdAt }, timeAgo(p.createdAt));
  return { av, name, time };
}

export function createCard(ctx, post) {
  const { ctl } = ctx;
  let cur = post;
  let last = {};

  const el = h('article', { class: 'b-card', tabindex: '0', 'data-post-id': post.id });
  const avSlot = h('span', { class: 'b-card-av' });
  const metaEl = h('div', { class: 'b-card-meta' });
  const badges = h('span', { class: 'b-badges' });
  const menuBtn = h('button', {
    type: 'button', class: 'b-card-menu btn-icon sm b-nodrag', 'aria-label': '카드 메뉴', 'aria-haspopup': 'menu',
    onClick: (e) => {
      e.stopPropagation();
      openPostMenu(ctx, menuBtn, cur);
    },
  }, icon('more-v', { size: 18 }));
  const head = h('div', { class: 'b-card-head' }, avSlot, metaEl, badges, menuBtn);
  const titleEl = h('h3', { class: 'b-card-title' });
  const attSlot = h('div', { class: 'b-card-att' });
  const bodyEl = h('div', { class: 'b-card-body' });
  const reactions = createReactions(ctx, post, { variant: 'card' });
  const commentN = h('span', { class: 'b-comment-n' });
  const commentBtn = h('button', {
    type: 'button', class: 'b-comment-btn b-nodrag', 'data-role': 'comment-open', onClick: () => ctl.openPost(cur.id),
  }, icon('message', { size: 17 }), commentN);
  const foot = h('div', { class: 'b-card-foot' }, reactions.el, h('span', { class: 'spacer' }), commentBtn);
  el.append(head, titleEl, attSlot, bodyEl, foot);

  function open() {
    ctl.openPost(cur.id);
  }
  el.addEventListener('click', (e) => {
    if (ctx.clickBlocked()) return;
    if (e.target.closest('a, button, input, textarea, select, iframe, .b-float')) return;
    open();
  });
  el.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target === el) {
      e.preventDefault();
      open();
    }
  });

  const unbindDnd = ctx.dnd.bindItem(el, {
    kind: 'post',
    id: () => cur.id,
    canDrag: () => ctx.sortable && ctl.canMovePost(cur),
  });

  const item = {
    el,
    get post() { return cur; },
    update,
    measureClamp: () => (el.isConnected ? bodyEl.scrollHeight > bodyEl.clientHeight + 2 : false),
    applyClamp: (v) => bodyEl.classList.toggle('is-clamped', !!v),
    destroy() {
      unbindDnd();
      reactions.destroy();
      clampQueue.delete(item);
      el.remove();
    },
  };

  function update(p, force) {
    cur = p;
    const s = ctx.settings();
    const showAuthor = s.showAuthor !== false;

    const colorKey = p.color || '';
    if (force || last.color !== colorKey) {
      last.color = colorKey;
      el.classList.remove(...COLOR_CLASSES);
      if (colorKey && POST_COLORS.includes(colorKey)) el.classList.add('pc-' + colorKey);
    }

    const headKey = `${showAuthor}|${p.author && p.author.id}|${p.author && p.author.displayName}|${p.author && p.author.avatarColor}|${p.createdAt}`;
    if (force || last.head !== headKey) {
      last.head = headKey;
      const b = authorBits(ctx, p, { size: 32 });
      avSlot.replaceChildren(...(b.av ? [b.av] : []));
      metaEl.replaceChildren(...(b.name ? [b.name] : []), b.time);
      metaEl.classList.toggle('no-author', !b.name);
      avSlot.hidden = !b.av;
    }

    const badgeKey = `${p.pinned ? 1 : 0}|${p.status}`;
    if (force || last.badge !== badgeKey) {
      last.badge = badgeKey;
      mount(badges,
        p.pinned ? h('span', { class: 'b-badge b-badge-pin', title: '고정된 카드' }, icon('pin', { size: 12 }), '고정됨') : null,
        p.status === 'pending' ? h('span', { class: 'b-badge b-badge-pending', title: '관리자가 승인하면 모두에게 보여요' }, '승인 대기') : null
      );
      el.classList.toggle('is-pinned', !!p.pinned);
      el.classList.toggle('is-pending', p.status === 'pending');
    }

    if (force || last.title !== p.title) {
      last.title = p.title;
      titleEl.textContent = p.title || '';
      titleEl.hidden = !p.title;
      el.setAttribute('aria-label', p.title ? `카드: ${p.title}` : '카드');
    }

    const a = p.attachment;
    const attKey = a ? [a.kind, a.url, a.name, a.size, a.preview && a.preview.image, a.preview && a.preview.title, a.preview && a.preview.description, a.preview && a.preview.site].join('|') : '';
    if (force || last.att !== attKey) {
      last.att = attKey;
      const node = attachmentEl(ctx, p);
      attSlot.replaceChildren(...(node ? [node] : []));
      attSlot.hidden = !node;
    }

    if (force || last.body !== p.body) {
      last.body = p.body;
      bodyEl.replaceChildren(renderRich(p.body));
      bodyEl.hidden = !p.body;
      bodyEl.classList.remove('is-clamped');
      if (p.body) queueClamp(item);
    }

    const cOn = s.comments !== 'off';
    const cKey = `${cOn}|${p.commentCount}`;
    if (force || last.cc !== cKey) {
      last.cc = cKey;
      commentBtn.hidden = !cOn;
      commentN.textContent = p.commentCount > 0 ? String(p.commentCount) : '';
      commentBtn.setAttribute('aria-label', p.commentCount > 0 ? `댓글 ${p.commentCount}개 보기` : '댓글 보기');
    }

    reactions.update(p, force);
  }

  update(post, true);
  return item;
}
