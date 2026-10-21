// Reaction control (like ♥ / vote ▲ / star ★ toggles, grade 1–10 popover, emoji chips + picker).
import { h } from '../lib/h.js';
import { icon } from '../lib/ui.js';
import { EMOJIS } from '../lib/constants.js';
import { floating } from './float.js';

const TOGGLE = {
  like: { icon: 'heart', label: '좋아요' },
  vote: { icon: 'vote', label: '투표' },
  star: { icon: 'star', label: '별' },
};

/**
 * createReactions(ctx, post, { variant: 'card'|'detail'|'msg' }) → { el, update(post, force) }
 * Renders nothing when board.settings.reactions === 'none'. Read-only (counts only) when the viewer can't react.
 */
export function createReactions(ctx, post, { variant = 'card' } = {}) {
  const el = h('div', { class: ['b-reactions', 'b-reactions-' + variant] });
  let sig = null;
  let cur = post;
  let pop = null;
  let toggleEl = null;
  let toggleKey = '';

  const react = (kind, value) => ctx.run(() => ctx.ctl.react(cur.id, kind, value));

  function renderToggle(kind, r, can) {
    const def = TOGGLE[kind];
    const count = r.count || 0;
    const body = [icon(def.icon, { size: variant === 'detail' ? 20 : 18 }), h('span', { class: 'b-react-n' }, count > 0 ? String(count) : '')];
    if (!can) {
      return h('span', { class: ['b-react', 'readonly', r.mine && 'on'], 'data-reaction': kind, title: def.label, role: 'img', 'aria-label': `${def.label} ${count}개` }, body);
    }
    return h('button', {
      type: 'button', class: ['b-react', r.mine && 'on'], 'data-reaction': kind, 'aria-pressed': String(!!r.mine),
      'aria-label': `${def.label} ${r.mine ? '취소' : ''} (${count}개)`.replace('  ', ' '), title: def.label, onClick: () => react(kind),
    }, body);
  }

  function openGrade(btn) {
    const g = cur.reactions.grade || { count: 0, avg: 0, mine: 0 };
    const grid = h('div', { class: 'b-grade-grid' }, Array.from({ length: 10 }, (_, i) => {
      const n = i + 1;
      return h('button', {
        type: 'button', class: ['b-grade-n', g.mine === n && 'on'], 'aria-pressed': String(g.mine === n), 'aria-label': `${n}점`,
        onClick: () => { pop && pop.close(); react('grade', n); },
      }, String(n));
    }));
    const content = h('div', { class: 'b-grade-pop' },
      h('div', { class: 'b-float-title' }, '점수 주기 (1~10)'),
      grid,
      h('div', { class: 'b-grade-foot' },
        h('span', null, g.count ? `평균 ${g.avg.toFixed(1)} · ${g.count}명` : '아직 점수가 없어요'),
        g.mine ? h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onClick: () => { pop && pop.close(); react('grade', g.mine); } }, '내 점수 취소') : null));
    pop = floating(btn, content, { label: '점수 주기', onClose: () => (pop = null) });
  }

  function renderGrade(r, can) {
    const g = r || { count: 0, avg: 0, mine: 0 };
    const label = g.count ? `${g.avg.toFixed(1)}` : '점수';
    const body = [icon('star', { size: variant === 'detail' ? 20 : 18 }), h('span', { class: 'b-react-n' }, label), g.count ? h('span', { class: 'b-react-sub' }, `(${g.count})`) : null,
      g.mine ? h('span', { class: 'b-react-mine' }, `내 점수 ${g.mine}`) : null];
    if (!can) return h('span', { class: ['b-react', 'readonly', g.mine && 'on'], 'data-reaction': 'grade', role: 'img', 'aria-label': g.count ? `평균 ${g.avg.toFixed(1)}점, ${g.count}명` : '아직 점수 없음' }, body);
    const btn = h('button', {
      type: 'button', class: ['b-react', 'b-grade', g.mine && 'on'], 'data-reaction': 'grade', 'aria-haspopup': 'dialog',
      'aria-label': g.count ? `점수 주기, 평균 ${g.avg.toFixed(1)}점` : '점수 주기', onClick: () => openGrade(btn),
    }, body);
    return btn;
  }

  function openEmoji(btn) {
    const mine = (e) => !!(cur.reactions.emoji[e] && cur.reactions.emoji[e].mine);
    const row = h('div', { class: 'b-emoji-row' }, EMOJIS.map((e) => h('button', {
      type: 'button', class: ['b-emoji-pick', mine(e) && 'on'], 'aria-pressed': String(mine(e)), 'aria-label': `${e} 반응`,
      onClick: () => { pop && pop.close(); react('emoji', e); },
    }, e)));
    pop = floating(btn, row, { label: '이모지 반응', onClose: () => (pop = null) });
  }

  function renderEmoji(map, can) {
    const chips = EMOJIS.filter((e) => map[e] && map[e].count > 0).map((e) => {
      const m = map[e];
      const body = [h('span', { class: 'b-emoji', 'aria-hidden': 'true' }, e), h('span', { class: 'b-react-n' }, String(m.count))];
      if (!can) return h('span', { class: ['b-chip-react', 'readonly', m.mine && 'on'], role: 'img', 'aria-label': `${e} ${m.count}명` }, body);
      return h('button', {
        type: 'button', class: ['b-chip-react', m.mine && 'on'], 'data-reaction': 'emoji', 'aria-pressed': String(!!m.mine),
        'aria-label': `${e} ${m.count}명${m.mine ? ', 내가 누름' : ''}`, onClick: () => react('emoji', e),
      }, body);
    });
    if (can) {
      const add = h('button', { type: 'button', class: ['b-react', 'b-emoji-add'], 'data-reaction': 'emoji', 'aria-haspopup': 'dialog', 'aria-label': '이모지 반응 추가', title: '이모지 반응', onClick: () => openEmoji(add) }, icon('smile', { size: 18 }));
      chips.push(add);
    }
    return chips;
  }

  function update(p, force) {
    cur = p;
    const kind = ctx.settings().reactions || 'like';
    if (kind === 'none') {
      if (sig !== 'none') {
        sig = 'none';
        el.hidden = true;
        el.replaceChildren();
      }
      return;
    }
    const can = ctx.ctl.can('react');
    const r = p.reactions || {};
    const s = kind + '|' + (can ? 1 : 0) + '|' + JSON.stringify(r[kind] || null);
    if (!force && s === sig) return;
    sig = s;
    el.hidden = false;
    if (pop) pop.close();
    if (kind === 'grade') { toggleEl = null; el.replaceChildren(renderGrade(r.grade, can)); }
    else if (kind === 'emoji') { toggleEl = null; el.replaceChildren(...renderEmoji(r.emoji || {}, can)); }
    else {
      const t = r[kind] || { count: 0, mine: false };
      const key = kind + (can ? 'b' : 's');
      if (toggleEl && toggleKey === key && toggleEl.parentNode === el) {
        // patch in place so keyboard focus survives the click that triggered this update
        const def = TOGGLE[kind];
        toggleEl.classList.toggle('on', !!t.mine);
        if (can) {
          toggleEl.setAttribute('aria-pressed', String(!!t.mine));
          toggleEl.setAttribute('aria-label', `${def.label}${t.mine ? ' 취소' : ''} (${t.count || 0}개)`);
        } else toggleEl.setAttribute('aria-label', `${def.label} ${t.count || 0}개`);
        toggleEl.querySelector('.b-react-n').textContent = t.count > 0 ? String(t.count) : '';
      } else {
        toggleEl = renderToggle(kind, t, can);
        toggleKey = key;
        el.replaceChildren(toggleEl);
      }
    }
  }

  update(post, true);
  return { el, update, destroy() { if (pop) pop.close(); } };
}
