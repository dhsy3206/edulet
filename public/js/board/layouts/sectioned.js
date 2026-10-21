// rows (sections as horizontal strips) and shelf (sections as vertical columns).
import { h } from '../../lib/h.js';
import { icon } from '../../lib/ui.js';
import { LIMITS } from '../../lib/constants.js';
import { reconcile, isIme } from '../util.js';
import { createEmpty } from '../empty.js';
import { createSection } from './section.js';

export function createSectioned(ctx, orientation) {
  const { ctl } = ctx;
  const isRows = orientation === 'rows';
  const el = h('div', { class: ['b-sectioned', 'b-' + orientation] });
  const listEl = h('div', { class: 'b-sec-list' });
  const empty = createEmpty(ctx, { sections: true });
  const comps = new Map();
  let orphanComp = null;
  let order = [];

  /* “섹션 추가” control at the end */
  const input = h('input', { class: 'input b-sec-add-input', type: 'text', name: 'new-section', maxlength: LIMITS.sectionTitle, placeholder: '섹션 이름', 'aria-label': '새 섹션 이름' });
  const form = h('form', { class: 'b-sec-add-form', hidden: true, onSubmit: (e) => { e.preventDefault(); submit(); } },
    input,
    h('button', { type: 'submit', class: 'btn btn-primary btn-sm' }, '추가'),
    h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onClick: () => closeForm() }, '취소'));
  const addBtn = h('button', { type: 'button', class: 'b-sec-add-btn', 'data-role': 'add-section', onClick: () => openForm() }, icon('plus', { size: 18 }), '섹션 추가');
  const addEl = h('div', { class: 'b-sec-add' }, addBtn, form);

  function openForm() {
    addBtn.hidden = true;
    form.hidden = false;
    input.value = '';
    input.focus();
  }
  function closeForm() {
    form.hidden = true;
    addBtn.hidden = false;
    addBtn.focus();
  }
  async function submit() {
    const v = input.value.trim();
    if (!v) {
      input.focus();
      return;
    }
    const r = await ctx.run(() => ctl.createSection(v));
    if (r) {
      input.value = '';
      closeForm();
    }
  }
  input.addEventListener('keydown', (e) => {
    if (isIme(e)) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      submit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeForm();
    }
  });

  const unzone = ctx.dnd.zone(listEl, {
    kind: 'section', axis: isRows ? 'y' : 'x',
    items: () => order.map((id) => ({ id, el: comps.get(id) && comps.get(id).el })).filter((i) => i.el),
  });

  function sync() {
    const secs = ctl.sortedSections();
    const known = new Set(secs.map((s) => s.id));
    const orphans = ctl.navPosts().filter((p) => p.sectionId == null || !known.has(p.sectionId));
    const used = [];
    const els = [];
    for (const s of secs) {
      let c = comps.get(s.id);
      if (!c) comps.set(s.id, (c = createSection(ctx, orientation, s)));
      const list = ctl.postsOf(s.id);
      c.sync(s, list);
      used.push(...list);
      els.push(c.el);
    }
    for (const [id, c] of [...comps]) {
      if (!known.has(id)) {
        c.destroy();
        comps.delete(id);
      }
    }
    order = secs.map((s) => s.id);
    if (orphans.length) {
      if (!orphanComp) orphanComp = createSection(ctx, orientation, { id: null, title: '분류되지 않음' });
      orphanComp.sync({ id: null, title: '분류되지 않음' }, orphans);
      used.push(...orphans);
      els.push(orphanComp.el);
    } else if (orphanComp) {
      orphanComp.destroy();
      orphanComp = null;
    }
    ctx.prune(used);
    const canMod = ctl.can('moderate');
    addEl.hidden = !canMod;
    if (!canMod && !form.hidden) closeForm();
    empty.update(!els.length);
    reconcile(listEl, [...els, addEl]);
    reconcile(el, [...(els.length ? [] : [empty.el]), listEl]);
  }

  return {
    el,
    sync,
    destroy() {
      unzone();
      comps.forEach((c) => c.destroy());
      comps.clear();
      if (orphanComp) orphanComp.destroy();
      el.remove();
    },
  };
}
