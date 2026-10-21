// Empty states: no cards yet (writer vs read-only wording) / no search hits / no sections.
import { h, mount } from '../lib/h.js';
import { icon } from '../lib/ui.js';

/**
 * createEmpty(ctx, { sections: false }) → { el, update(show) }
 * Re-evaluates wording on every update (permissions and search can change at any time).
 */
export function createEmpty(ctx, { sections = false } = {}) {
  const el = h('div', { class: 'b-empty', role: 'status' });
  let key = '';
  function update(show) {
    el.hidden = !show;
    if (!show) return;
    const { ctl } = ctx;
    const searching = !!ctl.state.search.trim();
    const canPost = ctl.can('post');
    const k = `${searching}|${canPost}|${sections}|${ctl.can('moderate')}`;
    if (k === key) return;
    key = k;
    let title, text, action = null;
    if (searching) {
      title = '검색 결과가 없어요';
      text = '다른 낱말로 다시 찾아 보세요.';
    } else if (sections) {
      title = '아직 섹션이 없어요';
      text = ctl.can('moderate') ? '아래에서 섹션을 만들어 카드를 나눠 담아 보세요.' : '관리자가 섹션을 만들면 여기에 나타나요.';
    } else if (canPost) {
      title = '아직 카드가 없어요';
      text = '오른쪽 아래 ＋ 버튼으로 첫 카드를 올려 보세요.';
      action = h('button', { type: 'button', class: 'btn btn-primary', onClick: () => ctx.composer.open({ mode: 'create' }) }, icon('plus', { size: 18 }), '첫 카드 올리기');
    } else {
      title = '아직 올라온 카드가 없어요';
      text = '카드가 올라오면 새로고침 없이 여기에 나타나요.';
    }
    mount(el, h('div', { class: 'b-empty-icon', 'aria-hidden': 'true' }, icon(searching ? 'search' : 'layout', { size: 34 })), h('h2', { class: 'b-empty-title' }, title), h('p', { class: 'b-empty-text' }, text), action);
  }
  return { el, update };
}
