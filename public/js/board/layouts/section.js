// One section of a rows/shelf board: tab header (title, count, ⋯ menu), the card track, and the "+" add-card button.
import { h } from '../../lib/h.js';
import { icon, popover, confirmDialog, modal } from '../../lib/ui.js';
import { LIMITS } from '../../lib/constants.js';
import { reconcile, isIme } from '../util.js';

export function createSection(ctx, orientation, initial) {
  const { ctl } = ctx;
  let cur = initial;
  let posts = [];
  let editing = false;
  const orphan = initial.id === null;
  const isRows = orientation === 'rows';

  const el = h('section', { class: ['b-section', 'b-section-' + orientation, orphan && 'is-orphan'], 'data-section-id': orphan ? 'none' : initial.id });
  const titleEl = h('h2', { class: 'b-sec-title', 'data-role': 'section-title' });
  const countEl = h('span', { class: 'b-sec-count', 'aria-hidden': 'true' });
  const menuBtn = h('button', {
    type: 'button', class: 'b-sec-menu btn-icon sm b-nodrag', 'aria-label': '섹션 메뉴', 'aria-haspopup': 'menu',
    onClick: () => openMenu(),
  }, icon('more', { size: 18 }));
  const head = h('div', { class: 'b-sec-head' }, titleEl, countEl, menuBtn);
  const track = h('div', { class: 'b-sec-track' });
  const addBtn = h('button', {
    type: 'button', class: 'b-add-card', 'data-role': 'add-card',
    onClick: () => ctx.composer.open({ mode: 'create', sectionId: cur.id }),
  }, icon('plus', { size: 22 }), h('span', null, '카드 추가'));
  const emptyNote = h('p', { class: 'b-sec-empty' }, '카드가 없어요');
  el.append(head, track);

  const unzone = ctx.dnd.zone(el, {
    kind: 'post', axis: isRows ? 'x' : 'y', sectionId: orphan ? null : initial.id,
    items: () => posts.map((p) => ({ id: p.id, el: ctx.cards.get(p.id) && ctx.cards.get(p.id).el })).filter((i) => i.el),
    slot: () => track,
  });
  const unbindHead = orphan ? () => {} : ctx.dnd.bindItem(head, {
    kind: 'section', id: () => cur.id, item: () => el, ghost: () => head,
    canDrag: () => ctl.can('moderate') && !editing && ctl.state.sections.length > 1,
  });

  function startRename() {
    if (editing || orphan) return;
    editing = true;
    const input = h('input', { class: 'b-sec-rename', type: 'text', maxlength: LIMITS.sectionTitle, value: cur.title, 'aria-label': '섹션 이름', name: 'section-title' });
    titleEl.replaceChildren(input);
    input.focus();
    input.select();
    const done = async (save) => {
      if (!editing) return;
      editing = false;
      const v = input.value.trim();
      titleEl.textContent = cur.title;
      if (save && v && v !== cur.title) {
        titleEl.textContent = v;
        await ctx.run(() => ctl.renameSection(cur.id, v));
        titleEl.textContent = (ctl.sectionById(cur.id) || cur).title;
      }
    };
    input.addEventListener('keydown', (e) => {
      if (isIme(e)) return;
      if (e.key === 'Enter') {
        e.preventDefault();
        done(true);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        done(false);
      }
    });
    input.addEventListener('blur', () => done(true));
  }

  function deleteFlow() {
    const total = ctl.state.posts.filter((p) => p.sectionId === cur.id).length;
    const others = ctl.state.sections.filter((s) => s.id !== cur.id).length;
    if (!total) {
      return confirmDialog({ title: '섹션을 삭제할까요?', message: `“${cur.title}” 섹션을 삭제해요.`, confirmLabel: '삭제', danger: true })
        .then((ok) => ok && ctx.run(() => ctl.deleteSection(cur.id, 'move')));
    }
    const mk = (value, label, checked) => h('label', { class: 'checkbox b-radio-row' }, h('input', { type: 'radio', name: 'b-del-mode', value, checked }), h('span', null, label));
    const move = mk('move', others ? '카드는 다른 섹션으로 옮기기' : '카드는 남기고 섹션만 삭제', true);
    const del = mk('delete', `카드 ${total}개도 함께 삭제`, false);
    modal({
      title: '섹션을 삭제할까요?', size: 'sm',
      body: h('div', null, h('p', { class: 'modal-text' }, `“${cur.title}” 섹션에 카드가 ${total}개 있어요.`), h('div', { class: 'b-radio-group' }, move, del)),
      actions: [
        { label: '취소', kind: 'secondary', onClick: () => {} },
        {
          label: '삭제', kind: 'danger',
          onClick: async () => {
            const mode = del.querySelector('input').checked ? 'delete' : 'move';
            await ctl.deleteSection(cur.id, mode);
          },
        },
      ],
    });
    return undefined;
  }

  function openMenu() {
    const secs = ctl.sortedSections();
    const idx = secs.findIndex((s) => s.id === cur.id);
    const back = isRows ? '위로 이동' : '왼쪽으로 이동';
    const fwd = isRows ? '아래로 이동' : '오른쪽으로 이동';
    const items = [
      { label: '이름 변경', icon: 'edit', onClick: startRename },
      ctl.can('post') ? { label: '카드 추가', icon: 'plus', onClick: () => ctx.composer.open({ mode: 'create', sectionId: cur.id }) } : null,
      { separator: true },
      { label: back, icon: isRows ? 'arrow-up' : 'arrow-left', disabled: idx <= 0, onClick: () => ctx.run(() => ctl.moveSection(cur.id, secs[idx - 1].id)) },
      { label: fwd, icon: isRows ? 'arrow-down' : 'chevron-right', disabled: idx < 0 || idx >= secs.length - 1, onClick: () => ctx.run(() => ctl.moveSection(cur.id, secs[idx + 2] ? secs[idx + 2].id : null)) },
      { separator: true },
      { label: '섹션 삭제', icon: 'trash', danger: true, onClick: deleteFlow },
    ];
    popover(menuBtn, items, { minWidth: 190 });
  }

  function sync(sec, list) {
    cur = sec;
    posts = list;
    const canMod = ctl.can('moderate') && !orphan;
    if (!editing) titleEl.textContent = sec.title || '(이름 없음)';
    countEl.textContent = String(list.length);
    menuBtn.hidden = !canMod;
    menuBtn.setAttribute('aria-label', `${sec.title || '섹션'} 메뉴`);
    el.classList.toggle('is-editable', canMod);
    const wanted = list.map((p) => ctx.itemFor(p).el);
    const canPost = ctl.can('post');
    addBtn.setAttribute('aria-label', `${sec.title || '섹션'}에 카드 추가`);
    if (canPost) wanted.push(addBtn);
    else if (!wanted.length) wanted.push(emptyNote);
    reconcile(track, wanted);
  }

  return {
    el,
    sync,
    destroy() {
      unzone();
      unbindHead();
      el.remove();
    },
  };
}
