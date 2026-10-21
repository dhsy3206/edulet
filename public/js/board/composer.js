// Composer: create or edit a card. Dialog on desktop, bottom sheet on phones (CSS).
// Title + body (Ctrl/Cmd+B/I), attachment tools (image/file picker, paste, drag-drop, link preview), color, section.
import { h } from '../lib/h.js';
import { icon, modal, confirmDialog, toast, focusables } from '../lib/ui.js';
import { LIMITS, POST_COLORS, POST_COLOR_LABELS } from '../lib/constants.js';
import { createAttachField } from './attach-field.js';
import { isIme, isBlank, cleanText, errorMessage } from './util.js';

const drafts = new Map(); // board slug → unsent draft kept in memory

function askKeep() {
  return new Promise((resolve) => {
    let done = false;
    const fin = (v) => {
      done = true;
      resolve(v);
    };
    modal({
      title: '작성을 마칠까요?', size: 'sm',
      body: h('p', { class: 'modal-text' }, '쓰던 내용이 있어요. 임시 저장하면 다음에 ＋ 버튼을 눌렀을 때 이어서 쓸 수 있어요.'),
      actions: [
        { label: '계속 쓰기', kind: 'secondary', onClick: () => fin('stay') },
        { label: '임시 저장', kind: 'secondary', onClick: () => fin('save') },
        { label: '버리기', kind: 'danger', onClick: () => fin('discard') },
      ],
      onClose: () => !done && resolve('stay'),
    });
  });
}

export function createComposer(ctx) {
  const { ctl } = ctx;
  let inst = null;

  function open(opts = {}) {
    if (inst) {
      inst.focus();
      return inst;
    }
    const edit = opts.mode === 'edit';
    const post = edit ? opts.post : null;
    if (edit && !(post && ctl.canEditPost(post))) {
      toast('이 카드를 수정할 권한이 없어요.', 'error');
      return null;
    }
    if (!edit && !ctl.can('post')) {
      toast('이 보드에서는 카드를 올릴 수 없어요.', 'error');
      return null;
    }
    inst = build({ edit, post, sectionId: opts.sectionId, position: opts.position });
    return inst;
  }

  function build({ edit, post, sectionId, position }) {
    const opener = document.activeElement;
    const draftKey = ctl.slug;
    const draft = !edit ? drafts.get(draftKey) : null;
    const sections = ctl.sortedSections();
    const sectioned = ctl.sectioned && sections.length > 0;
    let secId;
    if (edit) secId = post.sectionId ?? null;
    else if (sectionId !== undefined) secId = sectionId;
    else if (sectioned) secId = draft && draft.sectionId !== undefined ? draft.sectionId : sections[0].id;
    else secId = null;
    let color = edit ? post.color || null : draft ? draft.color || null : null;
    let busy = false;
    let closed = false;
    let attempt = 0; // bumped on every submit and on close: a late answer from an abandoned request is ignored
    let pendingDraft = null; // draft stored when the user leaves while a request is still in flight

    const titleId = 'cmp' + Math.random().toString(36).slice(2, 7);
    const title = h('input', { class: 'b-compose-title', name: 'title', type: 'text', maxlength: LIMITS.postTitle, placeholder: '제목', 'aria-label': '제목', autocomplete: 'off', value: edit ? post.title : draft ? draft.title : '' });
    const body = h('textarea', { class: 'b-compose-body', name: 'body', rows: 5, maxlength: LIMITS.postBody, placeholder: '내용을 입력하세요. **굵게**, *기울임*, - 목록을 쓸 수 있어요.', 'aria-label': '내용' });
    body.value = edit ? post.body : draft ? draft.body : '';
    const field = createAttachField(ctx, { initial: edit ? post.attachment : null, onChange: refresh });
    if (draft && draft.attachment) field.restore(draft.attachment);

    const fmt = (label, tip, fn, cls) => h('button', { type: 'button', class: ['b-fmt-btn', cls], title: tip, 'aria-label': tip, onClick: () => { fn(); body.focus(); } }, label);
    function wrap(mark) {
      const s = body.selectionStart;
      const e = body.selectionEnd;
      const sel = body.value.slice(s, e) || '텍스트';
      body.setRangeText(mark + sel + mark, s, e, 'select');
      body.setSelectionRange(s + mark.length, s + mark.length + sel.length);
      refresh();
    }
    function bullets() {
      const s = body.selectionStart;
      const e = body.selectionEnd;
      const from = body.value.lastIndexOf('\n', s - 1) + 1;
      const chunk = body.value.slice(from, e) || '';
      const out = chunk.split('\n').map((l) => (l.startsWith('- ') ? l : '- ' + l)).join('\n');
      body.setRangeText(out, from, e, 'end');
      refresh();
    }
    const fmtBar = h('div', { class: 'b-fmt', role: 'toolbar', 'aria-label': '서식' },
      fmt('B', '굵게 (Ctrl+B)', () => wrap('**'), 'is-b'), fmt('I', '기울임 (Ctrl+I)', () => wrap('*'), 'is-i'), fmt('•', '목록', bullets));

    const link = h('input', { class: 'b-compose-link', name: 'link', type: 'text', inputmode: 'url', placeholder: '링크 주소를 붙여 넣으세요 (유튜브 링크는 영상으로 보여요)', 'aria-label': '링크 주소', autocomplete: 'off' });
    const linkBtn = h('button', { type: 'button', class: 'btn btn-secondary btn-sm', 'data-role': 'link-add', onClick: () => addLink() }, '붙이기');
    const linkRow = h('div', { class: 'b-compose-linkrow' }, icon('link', { size: 18 }), link, linkBtn);
    async function addLink() {
      const v = link.value.trim();
      if (!v) {
        link.focus();
        return;
      }
      if (await field.addLink(v)) link.value = '';
    }
    link.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !isIme(e)) {
        e.preventDefault();
        if (e.ctrlKey || e.metaKey) submit();
        else addLink();
      }
    });

    const tools = h('div', { class: 'b-compose-tools' },
      h('button', { type: 'button', class: 'b-tool', 'data-role': 'pick-image', onClick: () => field.pickFile('image/*') }, icon('image', { size: 18 }), '이미지'),
      h('button', { type: 'button', class: 'b-tool', 'data-role': 'pick-file', onClick: () => field.pickFile() }, icon('paperclip', { size: 18 }), '파일'),
      h('button', { type: 'button', class: 'b-tool', onClick: () => link.focus() }, icon('link', { size: 18 }), '링크'));

    const swatchBtns = POST_COLORS.map((c) => h('button', {
      type: 'button', class: ['b-swatch', c && 'pc-' + c, !c && 'is-none'], 'aria-label': c ? POST_COLOR_LABELS[c] : '기본(흰색)', title: c ? POST_COLOR_LABELS[c] : '기본',
      onClick: () => {
        color = c || null;
        paintSwatches();
      },
    }));
    function paintSwatches() {
      swatchBtns.forEach((b, i) => {
        const on = (POST_COLORS[i] || null) === color;
        b.classList.toggle('on', on);
        b.setAttribute('aria-pressed', String(on));
      });
    }
    const colorRow = h('div', { class: 'b-compose-colors' }, h('span', { class: 'b-compose-lbl' }, '카드 색'), h('div', { class: 'b-swatch-row' }, swatchBtns));
    paintSwatches();

    let secSel = null;
    if (sectioned) {
      secSel = h('select', { class: 'select b-compose-section', name: 'section', 'aria-label': '섹션' },
        secId === null || !sections.some((s) => s.id === secId) ? h('option', { value: '' }, '섹션 없음') : null,
        sections.map((s) => h('option', { value: String(s.id) }, s.title || '(이름 없음)')));
      secSel.value = secId === null || !sections.some((s) => s.id === secId) ? '' : String(secId);
      secSel.addEventListener('change', () => {
        secId = secSel.value === '' ? null : Number(secSel.value);
      });
    }

    const err = h('p', { class: 'form-error b-compose-err', role: 'alert' });
    const cancelBtn = h('button', { type: 'button', class: 'btn btn-ghost', onClick: () => requestClose() }, '취소');
    const submitBtn = h('button', { type: 'button', class: 'btn btn-primary', 'data-role': 'composer-submit', onClick: () => submit() }, edit ? '저장' : '게시하기');
    const note = draft
      ? h('div', { class: 'b-compose-note' }, h('span', null, '임시 저장한 글을 불러왔어요.'),
        h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onClick: () => { clearAll(); note.remove(); } }, '지우기'))
      : null;

    const dialog = h('div', { class: 'b-compose', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId, 'data-role': 'composer', tabindex: '-1' },
      h('div', { class: 'b-compose-head' },
        h('h2', { id: titleId, class: 'b-compose-heading' }, edit ? '카드 수정' : '새 카드'),
        h('button', { type: 'button', class: 'btn-icon', 'aria-label': '닫기', onClick: () => requestClose() }, icon('x'))),
      h('div', { class: 'b-compose-scroll' }, note, secSel, title, fmtBar, body, field.el, tools, linkRow, colorRow),
      h('div', { class: 'b-compose-foot' }, err, cancelBtn, submitBtn));
    const backdrop = h('div', { class: 'b-compose-backdrop' }, dialog);
    backdrop.addEventListener('mousedown', (e) => {
      if (e.target === backdrop) requestClose();
    });

    function clearAll() {
      title.value = '';
      body.value = '';
      color = null;
      paintSwatches();
      field.clear();
      drafts.delete(draftKey);
      refresh();
    }

    /* content / dirty state */
    function hasContent() {
      return !!(!isBlank(title.value) || !isBlank(body.value) || field.hasAttachment());
    }
    function isDirty() {
      if (edit) {
        return title.value !== post.title || body.value !== post.body || (color || null) !== (post.color || null) || (secSel ? secId !== (post.sectionId ?? null) : false) || field.value() !== undefined;
      }
      return hasContent();
    }
    function refresh() {
      submitBtn.disabled = busy || field.busy() || !hasContent();
      err.textContent = '';
    }
    title.addEventListener('input', refresh);
    body.addEventListener('input', refresh);

    /* keyboard */
    title.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !isIme(e)) {
        e.preventDefault();
        if (e.ctrlKey || e.metaKey) submit();
        else body.focus();
      }
    });
    body.addEventListener('keydown', (e) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && !e.shiftKey && !e.altKey && (e.key === 'b' || e.key === 'B')) {
        e.preventDefault();
        wrap('**');
      } else if (mod && !e.shiftKey && !e.altKey && (e.key === 'i' || e.key === 'I')) {
        e.preventDefault();
        wrap('*');
      } else if (mod && e.key === 'Enter' && !isIme(e)) {
        e.preventDefault();
        submit();
      }
    });
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
    const onDocKey = (e) => {
      if (e.key === 'Escape' && !e.defaultPrevented && ctx.isTopLayer(layer)) {
        e.preventDefault();
        requestClose();
      }
    };

    /* paste / drop an image or file */
    dialog.addEventListener('paste', (e) => {
      const files = [...((e.clipboardData && e.clipboardData.files) || [])];
      const f = files.find((x) => x.type.startsWith('image/')) || files[0];
      if (f) {
        e.preventDefault();
        field.addFile(f);
      }
    });
    dialog.addEventListener('dragover', (e) => {
      if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) {
        e.preventDefault();
        dialog.classList.add('is-drop');
      }
    });
    dialog.addEventListener('dragleave', (e) => {
      if (!dialog.contains(e.relatedTarget)) dialog.classList.remove('is-drop');
    });
    dialog.addEventListener('drop', (e) => {
      dialog.classList.remove('is-drop');
      const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) {
        e.preventDefault();
        field.addFile(f);
      }
    });

    /* submit */
    async function submit() {
      if (busy || field.busy() || !hasContent()) return;
      busy = true;
      const my = ++attempt;
      submitBtn.disabled = true;
      submitBtn.textContent = edit ? '저장 중…' : '올리는 중…';
      err.textContent = '';
      let outcome;
      try {
        const t = cleanText(title.value);
        const b = isBlank(body.value) ? '' : body.value.replace(/\s+$/g, '');
        const att = field.value();
        if (edit) {
          const patch = {};
          if (t !== post.title) patch.title = t;
          if (b !== post.body) patch.body = b;
          if ((color || null) !== (post.color || null)) patch.color = color || null;
          if (secSel && secId !== (post.sectionId ?? null)) patch.sectionId = secId;
          if (att !== undefined) patch.attachment = att;
          let saved = null;
          if (Object.keys(patch).length) saved = await ctl.updatePost(post.id, patch); // api.js ends every request within 20s (ApiError 'timeout')
          outcome = { ok: true, requeued: !!saved && saved.status === 'pending' && post.status !== 'pending' };
        } else {
          const data = { title: t, body: b };
          if (color) data.color = color;
          if (secId !== null && ctl.sectioned) data.sectionId = secId;
          if (att) data.attachment = att;
          if (position && !ctl.sectioned) {
            data.x = position.x;
            data.y = position.y;
          }
          outcome = { ok: true, created: await ctl.createPost(data) };
        }
      } catch (e) {
        outcome = { ok: false, error: e };
      }
      if (closed || my !== attempt) return abandoned(outcome); // the user left meanwhile
      busy = false;
      if (outcome.ok) {
        if (edit) toast(outcome.requeued ? '저장했어요. 관리자가 다시 승인하면 모두에게 보여요.' : '카드를 저장했어요', 'success');
        else {
          const created = outcome.created;
          drafts.delete(draftKey);
          if (created && created.id != null) ctx.reveal(created.id);
          toast(created && created.status === 'pending' ? '올렸어요. 관리자가 승인하면 모두에게 보여요.' : '카드를 올렸어요', 'success');
        }
        close();
        return;
      }
      // never leave the form stuck: restore the button and say what happened right under it
      submitBtn.textContent = edit ? '저장' : '게시하기';
      refresh();
      const e = outcome.error;
      if (!(e && e.code === 'cancelled')) {
        const msg = errorMessage(e, '저장하지 못했어요. 다시 시도해 주세요.');
        err.textContent = msg;
        toast(msg, 'error');
      }
    }

    /** The answer of a request whose composer was closed while it was in flight. */
    function abandoned(outcome) {
      const e = outcome.error;
      if (outcome.ok) {
        if (!edit && pendingDraft && drafts.get(draftKey) === pendingDraft) drafts.delete(draftKey); // it was posted after all
        const created = outcome.created;
        toast(edit ? (outcome.requeued ? '저장했어요. 관리자가 다시 승인하면 모두에게 보여요.' : '카드를 저장했어요') : created && created.status === 'pending' ? '올렸어요. 관리자가 승인하면 모두에게 보여요.' : '카드를 올렸어요', 'success');
      } else if (!(e && e.code === 'cancelled')) {
        toast(errorMessage(e, '저장하지 못했어요.') + (edit ? '' : ' 쓰던 내용은 임시 저장해 두었어요.'), 'error');
      }
    }

    /* close */
    /** Leave while a request is still running: keep the text as a draft (create) and drop the request. */
    function abandon() {
      if (!edit) {
        pendingDraft = { title: title.value, body: body.value, color, sectionId: secId, attachment: field.snapshot() };
        drafts.set(draftKey, pendingDraft);
      }
      close();
    }
    async function requestClose() {
      if (closed) return;
      if (busy) return abandon(); // 올리는 중… must never trap the user
      if (!isDirty()) return close();
      if (edit) {
        const ok = await confirmDialog({ title: '수정을 취소할까요?', message: '고친 내용이 저장되지 않아요.', confirmLabel: '수정 취소', cancelLabel: '계속 수정' });
        if (ok) close();
        return;
      }
      const choice = await askKeep();
      if (closed) return;
      if (choice === 'save') {
        drafts.set(draftKey, { title: title.value, body: body.value, color, sectionId: secId, attachment: field.snapshot() });
        close();
      } else if (choice === 'discard') {
        drafts.delete(draftKey);
        close();
      }
    }
    function close() {
      if (closed) return;
      closed = true;
      attempt++;
      document.removeEventListener('keydown', onDocKey);
      field.destroy();
      backdrop.classList.add('out');
      setTimeout(() => backdrop.remove(), 120);
      ctx.popLayer(layer);
      ctx.unlock();
      inst = null;
      if (opener && opener.focus && document.contains(opener)) opener.focus();
    }

    const layer = ctx.pushLayer('composer');
    ctx.lock();
    ctx.layer.appendChild(backdrop);
    document.addEventListener('keydown', onDocKey);
    refresh();
    requestAnimationFrame(() => {
      (draft && draft.body && !draft.title ? body : title).focus();
    });

    return {
      focus() {
        (title || dialog).focus();
      },
      close: () => close(),
      destroy: () => (busy && !closed ? abandon() : close()), // leaving the board mid-request keeps the text as a draft
    };
  }

  return {
    open,
    isOpen: () => !!inst,
    destroy() {
      if (inst) inst.destroy();
    },
  };
}
