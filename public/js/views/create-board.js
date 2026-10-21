// "새 보드" dialog: title, description, format picker, template picker → POST /boards → open the board.
import { h } from '../lib/h.js';
import { api } from '../lib/api.js';
import { router } from '../lib/router.js';
import { modal, toast } from '../lib/ui.js';
import { FORMATS, FORMAT_LABELS, TEMPLATES, TEMPLATE_LABELS, LIMITS } from '../lib/constants.js';
import { FORMAT_ICON, TEMPLATE_FORMAT, pickGroup, boardPath } from './common.js';
import { openAuthModal } from './auth.js';

/** Guests have an identity but may not own boards — explain and offer sign-up. */
export function openGuestCannotCreate() {
  const m = modal({
    title: '가입하면 보드를 만들 수 있어요', size: 'sm',
    body: h('p', { class: 'modal-text' }, '지금은 게스트로 참여하고 있어요. 게스트는 다른 사람의 보드에 글을 쓸 수는 있지만, 새 보드는 가입한 계정으로만 만들 수 있어요.'),
    actions: [
      { label: '나중에', kind: 'secondary' },
      { label: '가입하기', kind: 'primary', onClick: (close) => { close(); openAuthModal({ tab: 'register' }); return false; }, keepOpen: true },
    ],
  });
  return m;
}

export function openCreateBoardModal() {
  let formatTouched = false;
  const title = h('input', { class: 'input', type: 'text', name: 'title', maxlength: LIMITS.boardTitle, placeholder: '예: 3학년 2반 독서 토론', autocomplete: 'off', autofocus: true });
  const description = h('textarea', { class: 'input', name: 'description', rows: 2, maxlength: LIMITS.boardDescription, placeholder: '보드를 한두 줄로 소개해 주세요 (선택)' });
  const err = h('p', { class: 'form-error', role: 'alert' });
  const submit = h('button', { type: 'submit', class: 'btn btn-primary', dataset: { role: 'create-submit' } }, '보드 만들기');
  const cancel = h('button', { type: 'button', class: 'btn btn-secondary', onClick: () => m.close() }, '취소');

  const formats = pickGroup({
    label: '보드 형식', dataKey: 'format', value: 'wall',
    options: FORMATS.map((f) => ({ value: f, label: FORMAT_LABELS[f].name, desc: FORMAT_LABELS[f].desc, icon: FORMAT_ICON[f] })),
    onPick: () => { formatTouched = true; },
  });
  const templates = pickGroup({
    label: '템플릿', dataKey: 'template', value: 'blank', className: 'app-picker-tpl',
    options: TEMPLATES.map((t) => ({ value: t, label: TEMPLATE_LABELS[t].name, desc: TEMPLATE_LABELS[t].desc })),
    onPick: (t) => { if (!formatTouched) formats.set(TEMPLATE_FORMAT[t]); },
  });

  title.addEventListener('input', () => {
    title.removeAttribute('aria-invalid');
    err.textContent = '';
  });

  async function onSubmit(e) {
    e.preventDefault();
    err.textContent = '';
    const t = title.value.trim();
    if (!t) {
      err.textContent = '보드 제목을 입력해 주세요.';
      title.setAttribute('aria-invalid', 'true');
      title.focus();
      return;
    }
    title.removeAttribute('aria-invalid');
    const body = { title: t, template: templates.get() };
    const d = description.value.trim();
    if (d) body.description = d;
    if (formatTouched) body.format = formats.get();
    submit.disabled = true;
    submit.textContent = '만드는 중…';
    try {
      const r = await api.post('/boards', body);
      m.close();
      toast('보드를 만들었어요.', 'success');
      router.go(boardPath(r.board.slug));
    } catch (ex) {
      err.textContent = ex.message || '보드를 만들지 못했어요. 다시 시도해 주세요.';
      submit.disabled = false;
      submit.textContent = '보드 만들기';
    }
  }

  const form = h('form', { class: 'dash-create', novalidate: true, onSubmit },
    h('label', { class: 'field' }, h('span', { class: 'label' }, '제목'), title),
    h('label', { class: 'field' }, h('span', { class: 'label' }, '설명'), description),
    h('div', { class: 'field' }, h('span', { class: 'label' }, '형식'), formats.el, h('span', { class: 'hint' }, '나중에 설정에서 언제든 바꿀 수 있어요.')),
    h('div', { class: 'field' }, h('span', { class: 'label' }, '템플릿'), templates.el),
    err,
    h('div', { class: 'app-form-actions' }, cancel, submit));

  const m = modal({ title: '새 보드 만들기', size: 'lg', body: form });
  return m;
}
