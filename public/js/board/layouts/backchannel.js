// backchannel: chat-style list (own messages right-aligned), autoscroll unless the reader scrolled up,
// and a sticky input at the bottom (Enter sends, Shift+Enter newline, attach images/files/links).
import { h } from '../../lib/h.js';
import { icon, popover, promptDialog } from '../../lib/ui.js';
import { LIMITS } from '../../lib/constants.js';
import { reconcile, scrollerOf, isIme, autosize, isBlank, cleanText } from '../util.js';
import { createEmpty } from '../empty.js';
import { createAttachField } from '../attach-field.js';

export function createBackchannel(ctx) {
  const { ctl } = ctx;
  const el = h('div', { class: 'b-chat' });
  const list = h('div', { class: 'b-chat-list', role: 'log', 'aria-live': 'polite', 'aria-label': '대화' });
  const empty = createEmpty(ctx);

  const field = createAttachField(ctx, { onChange: refreshSend });
  const ta = h('textarea', {
    class: 'b-chat-input', name: 'body', rows: 1, maxlength: LIMITS.postBody, placeholder: '메시지를 입력하세요  (Enter 전송 · Shift+Enter 줄바꿈)', 'aria-label': '메시지 입력',
  });
  const attachBtn = h('button', { type: 'button', class: 'b-chat-btn', 'aria-label': '첨부', title: '이미지·파일·링크 첨부', 'aria-haspopup': 'menu', onClick: () => openAttachMenu() }, icon('paperclip', { size: 20 }));
  const sendBtn = h('button', { type: 'button', class: 'b-chat-send', 'aria-label': '보내기', title: '보내기 (Enter)', 'data-role': 'chat-send', onClick: () => send() }, icon('send', { size: 20 }));
  const row = h('div', { class: 'b-chat-row' }, attachBtn, ta, sendBtn);
  const note = h('p', { class: 'b-chat-note' }, '이 보드에서는 메시지를 보낼 수 없어요. 대화를 지켜볼 수 있어요.');
  const bar = h('div', { class: 'b-chat-bar' }, field.el, row, note);
  el.append(list, bar);

  let sending = false;
  let stick = true;
  let first = true;
  let scroller = null;
  let scrollTarget = null;

  function refreshSend() {
    sendBtn.disabled = sending || field.busy() || (isBlank(ta.value) && !field.hasAttachment());
  }

  function openAttachMenu() {
    popover(attachBtn, [
      { label: '이미지 올리기', icon: 'image', onClick: () => field.pickFile('image/*') },
      { label: '파일 올리기', icon: 'file', onClick: () => field.pickFile() },
      { label: '링크 붙이기', icon: 'link', onClick: async () => {
        const v = await promptDialog({ title: '링크 붙이기', label: '주소', placeholder: 'https://', confirmLabel: '붙이기', maxLength: 2000 });
        if (v) field.addLink(v);
      } },
    ], { align: 'start', minWidth: 180 });
  }

  async function send() {
    if (sending || field.busy()) return;
    const text = cleanText(ta.value);
    const att = field.value();
    if (!text && !att) return;
    sending = true;
    refreshSend();
    const data = { body: text };
    if (att) data.attachment = att;
    const r = await ctx.run(() => ctl.createPost(data)); // api.js times a hung request out, so the send button never stays frozen
    sending = false;
    if (r) {
      ta.value = '';
      autosize(ta, 140);
      field.clear();
      stick = true;
      toBottom();
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
    autosize(ta, 140);
    refreshSend();
  });
  ta.addEventListener('paste', (e) => {
    const f = [...((e.clipboardData && e.clipboardData.files) || [])].find((x) => x.type.startsWith('image/'));
    if (f) {
      e.preventDefault();
      field.addFile(f);
    }
  });
  const onDragOver = (e) => {
    if (ctl.can('post') && e.dataTransfer && [...e.dataTransfer.types].includes('Files')) {
      e.preventDefault();
      el.classList.add('is-drop');
    }
  };
  const onDragLeave = (e) => {
    if (!el.contains(e.relatedTarget)) el.classList.remove('is-drop');
  };
  const onDrop = (e) => {
    el.classList.remove('is-drop');
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f && ctl.can('post')) {
      e.preventDefault();
      field.addFile(f);
    }
  };
  // images finishing their load push content down: keep following the conversation
  list.addEventListener('load', () => stick && toBottom(), true);
  el.addEventListener('dragover', onDragOver);
  el.addEventListener('dragleave', onDragLeave);
  el.addEventListener('drop', onDrop);

  /* scrolling */
  function nearBottom() {
    const s = scroller;
    return s.scrollHeight - s.scrollTop - s.clientHeight < 120;
  }
  const onScroll = () => {
    if (scroller) stick = nearBottom();
  };
  function ensureScroller() {
    if (scroller || !el.isConnected) return;
    scroller = scrollerOf(el);
    scrollTarget = scroller === document.scrollingElement || scroller === document.documentElement ? window : scroller;
    scrollTarget.addEventListener('scroll', onScroll, { passive: true });
  }
  function toBottom() {
    ensureScroller();
    requestAnimationFrame(() => {
      if (!scroller) return;
      scroller.scrollTop = scroller.scrollHeight;
    });
  }

  function sync() {
    ensureScroller();
    const posts = ctl.sortedPosts();
    const els = posts.map((p) => ctx.itemFor(p).el);
    ctx.prune(posts);
    empty.update(!posts.length);
    const canPost = ctl.can('post');
    row.hidden = !canPost;
    note.hidden = canPost;
    reconcile(list, posts.length ? els : [empty.el]);
    refreshSend();
    if (first) {
      first = false;
      stick = true;
      toBottom();
    } else if (stick) toBottom();
  }

  return {
    el,
    sync,
    focusInput() {
      ta.focus();
    },
    destroy() {
      if (scrollTarget) scrollTarget.removeEventListener('scroll', onScroll);
      field.destroy();
      el.remove();
    },
  };
}
