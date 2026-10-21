// Backchannel message: a chat bubble for one post (own messages right-aligned).
import { h, mount } from '../lib/h.js';
import { icon } from '../lib/ui.js';
import { renderRich } from '../lib/markdown.js';
import { POST_COLORS } from '../lib/constants.js';
import { attachmentEl } from './attachments.js';
import { createReactions } from './reactions.js';
import { openPostMenu } from './actions.js';
import { authorBits } from './card.js';

const COLOR_CLASSES = POST_COLORS.filter(Boolean).map((c) => 'pc-' + c);

export function createMessage(ctx, post) {
  const { ctl } = ctx;
  let cur = post;
  let last = {};

  const el = h('article', { class: 'b-msg', 'data-post-id': post.id });
  const avSlot = h('span', { class: 'b-msg-av' });
  const metaEl = h('div', { class: 'b-msg-meta' });
  const menuBtn = h('button', {
    type: 'button', class: 'b-msg-menu btn-icon sm', 'aria-label': '메시지 메뉴', 'aria-haspopup': 'menu',
    onClick: (e) => {
      e.stopPropagation();
      openPostMenu(ctx, menuBtn, cur);
    },
  }, icon('more-v', { size: 16 }));
  const badges = h('span', { class: 'b-badges' });
  const titleEl = h('div', { class: 'b-msg-title' });
  const attSlot = h('div', { class: 'b-msg-att' });
  const bodyEl = h('div', { class: 'b-msg-body' });
  const bubble = h('div', { class: 'b-msg-bubble', tabindex: '0', role: 'button', 'aria-label': '메시지 자세히 보기' }, titleEl, attSlot, bodyEl);
  const reactions = createReactions(ctx, post, { variant: 'msg' });
  const commentN = h('span', { class: 'b-comment-n' });
  const commentBtn = h('button', { type: 'button', class: 'b-comment-btn', 'data-role': 'comment-open', onClick: () => ctl.openPost(cur.id) }, icon('message', { size: 15 }), commentN);
  const foot = h('div', { class: 'b-msg-foot' }, reactions.el, commentBtn);
  const main = h('div', { class: 'b-msg-main' }, h('div', { class: 'b-msg-top' }, metaEl, badges, menuBtn), bubble, foot);
  el.append(avSlot, main);

  const open = () => ctl.openPost(cur.id);
  bubble.addEventListener('click', (e) => {
    if (e.target.closest('a, button, iframe')) return;
    open();
  });
  bubble.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target === bubble) {
      e.preventDefault();
      open();
    }
  });

  function update(p, force) {
    cur = p;
    const s = ctx.settings();
    const mine = ctl.isMine(p);
    const showAuthor = s.showAuthor !== false;

    const flagKey = `${mine}|${p.color || ''}`;
    if (force || last.flags !== flagKey) {
      last.flags = flagKey;
      el.classList.toggle('mine', mine);
      bubble.classList.remove(...COLOR_CLASSES);
      if (p.color && POST_COLORS.includes(p.color)) bubble.classList.add('pc-' + p.color);
    }

    const headKey = `${showAuthor}|${mine}|${p.author && p.author.id}|${p.author && p.author.displayName}|${p.author && p.author.avatarColor}|${p.createdAt}`;
    if (force || last.head !== headKey) {
      last.head = headKey;
      const b = authorBits(ctx, p, { size: 30 });
      avSlot.replaceChildren(...(b.av && !mine ? [b.av] : []));
      avSlot.hidden = !b.av || mine;
      metaEl.replaceChildren(...(b.name && !mine ? [b.name] : []), b.time);
    }

    const badgeKey = `${p.pinned ? 1 : 0}|${p.status}`;
    if (force || last.badge !== badgeKey) {
      last.badge = badgeKey;
      mount(badges,
        p.pinned ? h('span', { class: 'b-badge b-badge-pin' }, icon('pin', { size: 12 }), '고정됨') : null,
        p.status === 'pending' ? h('span', { class: 'b-badge b-badge-pending' }, '승인 대기') : null
      );
      el.classList.toggle('is-pending', p.status === 'pending');
    }

    if (force || last.title !== p.title) {
      last.title = p.title;
      titleEl.textContent = p.title || '';
      titleEl.hidden = !p.title;
    }
    const a = p.attachment;
    const attKey = a ? [a.kind, a.url, a.name, a.size, a.preview && a.preview.image, a.preview && a.preview.title].join('|') : '';
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
    }
    const cOn = s.comments !== 'off';
    const cKey = `${cOn}|${p.commentCount}`;
    if (force || last.cc !== cKey) {
      last.cc = cKey;
      commentBtn.hidden = !cOn || !p.commentCount;
      commentN.textContent = p.commentCount > 0 ? String(p.commentCount) : '';
      commentBtn.setAttribute('aria-label', `댓글 ${p.commentCount}개 보기`);
    }
    reactions.update(p, force);
    foot.hidden = reactions.el.hidden && commentBtn.hidden;
  }

  update(post, true);
  return {
    el,
    get post() { return cur; },
    update,
    destroy() {
      reactions.destroy();
      el.remove();
    },
  };
}
