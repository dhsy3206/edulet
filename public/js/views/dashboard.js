// "내 보드" — the signed-in user's boards.
import { h, mount } from '../lib/h.js';
import { api } from '../lib/api.js';
import { store } from '../lib/store.js';
import { router } from '../lib/router.js';
import { icon, popover, timeAgo, fullTime } from '../lib/ui.js';
import { FORMAT_LABELS, ROLE_LABELS } from '../lib/constants.js';
import { FORMAT_ICON, boardPath, isGuest, redirect, reportError, wallpaperProps } from './common.js';
import { loadTone } from '../board/tone.js';
import { openAuthModal } from './auth.js';
import { appHeader } from './shell.js';
import { openCreateBoardModal, openGuestCannotCreate } from './create-board.js';
import { copyBoardLink, deleteBoardFlow, duplicateBoardFlow, leaveBoardFlow } from './board-actions.js';

function stateBox({ iconName, title, text, actions }) {
  return h('div', { class: 'app-state dash-state' },
    h('span', { class: 'app-state-ico' }, icon(iconName, { size: 28 })),
    h('h2', { class: 'app-state-title' }, title),
    text ? h('p', { class: 'muted' }, text) : null,
    h('div', { class: 'row app-state-actions' }, actions));
}

function skeletonGrid() {
  return h('div', { class: 'dash-grid', 'aria-busy': 'true', 'aria-label': '보드를 불러오는 중' },
    [0, 1, 2, 3].map(() => h('div', { class: 'dash-card dash-skel' }, h('div', { class: 'dash-thumb' }), h('div', { class: 'dash-meta' },
      h('div', { class: 'dash-skel-line' }), h('div', { class: 'dash-skel-line short' })))));
}

export function dashboardPage(root, query = {}) {
  document.title = '내 보드 · Edulet';
  const header = appHeader();
  const main = h('main', { class: 'dash', id: 'main' });
  mount(root, h('div', { class: 'app-page' }, header.el, main));

  let state = 'loading'; // loading | ready | error | anon
  let boards = [];
  let error = null;
  let seq = 0;
  let destroyed = false;
  let wantNew = query.new === '1';
  let hadMe = !!store.me;

  const isOwner = (b) => !!(store.me && b.owner && b.owner.id === store.me.id);

  function startCreate() {
    if (!store.me) return openAuthModal({ tab: 'register', message: '보드를 만들려면 로그인이 필요해요.' });
    if (isGuest(store.me)) return openGuestCannotCreate();
    return openCreateBoardModal();
  }

  function openMenu(btn, b) {
    const owner = isOwner(b);
    popover(btn, [
      { label: '열기', icon: 'external-link', onClick: () => router.go(boardPath(b.slug)) },
      { label: '링크 복사', icon: 'link', onClick: () => copyBoardLink(b.slug) },
      { label: '복제', icon: 'copy', onClick: () => duplicateBoardFlow(b) },
      { separator: true },
      owner ? {
        label: '삭제', icon: 'trash', danger: true,
        onClick: async () => {
          if (await deleteBoardFlow(b)) {
            boards = boards.filter((x) => x.slug !== b.slug);
            render();
          }
        },
      } : {
        // a member who is not the owner can leave; the owner keeps "삭제" (the server refuses owner_cannot_leave)
        label: '보드 나가기', icon: 'logout', danger: true,
        onClick: async () => {
          try {
            if (await leaveBoardFlow(b, store.me && store.me.id)) {
              boards = boards.filter((x) => x.slug !== b.slug);
              render();
              refreshQuiet(); // then re-read the list from the server
            }
          } catch (e) {
            reportError(e, '보드에서 나가지 못했어요. 다시 시도해 주세요.');
          }
        },
      },
    ]);
  }

  function boardCard(b) {
    const wp = wallpaperProps(b.wallpaper);
    const fmt = FORMAT_LABELS[b.format] || { name: b.format };
    const role = isOwner(b) ? '소유자' : ROLE_LABELS[b.role] || '';
    const more = h('button', {
      type: 'button', class: 'btn-icon sm dash-more', 'aria-label': `“${b.title}” 메뉴`, 'aria-haspopup': 'menu',
      onClick: () => openMenu(more, b),
    }, icon('more', { size: 18 }));
    const thumb = h('a', { class: ['dash-thumb', wp.cls, wp.dark && 'dark'], href: boardPath(b.slug), 'data-link': true, style: wp.style, 'aria-label': `${b.title} 열기` },
      h('span', { class: 'dash-thumb-title' }, b.title));
    // a light uploaded photo must not carry white text: look at the image once, then fix the thumb's tone
    if (wp.id === 'custom' && !wp.toneKnown) loadTone(wp.url).then(() => thumb.classList.toggle('dark', wallpaperProps(b.wallpaper).dark));
    return h('article', { class: 'dash-card', dataset: { slug: b.slug } },
      thumb,
      more,
      h('div', { class: 'dash-meta' },
        h('div', { class: 'dash-meta-row' },
          h('span', { class: 'dash-fmt', title: fmt.name + ' 형식' }, icon(FORMAT_ICON[b.format] || 'layout', { size: 16 }), fmt.name),
          role ? h('span', { class: ['chip', (isOwner(b) || b.role === 'admin') && 'ok'] }, role) : null),
        h('div', { class: 'dash-meta-row muted' },
          h('span', null, `글 ${b.postCount ?? 0}개`), h('span', { 'aria-hidden': 'true' }, '·'),
          h('time', { title: fullTime(b.updatedAt) }, timeAgo(b.updatedAt)))));
  }

  function newTile() {
    return h('button', { type: 'button', class: 'dash-card dash-new', dataset: { role: 'new-board' }, onClick: startCreate },
      h('span', { class: 'dash-new-ico' }, icon('plus', { size: 26 })), h('span', { class: 'dash-new-text' }, '새 보드'));
  }

  function content() {
    if (state === 'anon') {
      return stateBox({
        iconName: 'lock', title: '로그인이 필요해요', text: '로그인하면 내가 만든 보드와 초대받은 보드를 한곳에서 볼 수 있어요.',
        actions: [
          h('button', { type: 'button', class: 'btn btn-primary', onClick: () => openAuthModal() }, '로그인'),
          h('a', { class: 'btn btn-secondary', href: '/b/practice', 'data-link': true }, '연습장 열어 보기'),
        ],
      });
    }
    if (state === 'loading') return skeletonGrid();
    if (state === 'error') {
      return stateBox({
        iconName: 'alert', title: '보드를 불러오지 못했어요', text: (error && error.message) || '잠시 후 다시 시도해 주세요.',
        actions: [h('button', { type: 'button', class: 'btn btn-primary', onClick: load }, icon('refresh', { size: 18 }), '다시 시도')],
      });
    }
    return h('div', null,
      h('div', { class: 'dash-grid' }, newTile(), boards.map(boardCard)),
      boards.length ? null : h('div', { class: 'dash-empty' },
        h('h2', null, '아직 보드가 없어요'),
        h('p', { class: 'muted' }, isGuest(store.me)
          ? '게스트는 다른 사람의 보드에 참여할 수 있어요. 받은 링크를 열어 보세요.'
          : '“새 보드”로 첫 보드를 만들거나, 연습장에서 먼저 써 보세요.'),
        h('a', { class: 'btn btn-secondary', href: '/b/practice', 'data-link': true }, '연습장 열어 보기')));
  }

  function render() {
    if (destroyed) return;
    const guest = isGuest(store.me);
    mount(main,
      h('div', { class: 'dash-head' },
        h('h1', { class: 'dash-title' }, '내 보드'),
        store.me ? h('button', { type: 'button', class: 'btn btn-primary', onClick: startCreate }, icon('plus', { size: 18 }), '새 보드') : null),
      guest && state === 'ready' ? h('div', { class: 'app-notice', role: 'note' },
        h('span', null, '게스트로 참여 중이에요. 보드를 만들려면 가입이 필요해요.'),
        h('button', { type: 'button', class: 'btn btn-sm btn-secondary', onClick: () => openAuthModal({ tab: 'register' }) }, '가입하기')) : null,
      content());
  }

  async function load() {
    const my = ++seq;
    if (!store.me) {
      state = 'anon';
      return render();
    }
    state = 'loading';
    render();
    const r = await guardLoad();
    if (my !== seq || destroyed) return;
    if (r) {
      boards = r.boards || [];
      state = 'ready';
    } else if (!store.me) {
      state = 'anon';
    } else {
      state = 'error';
    }
    render();
    if (state === 'ready' && wantNew) {
      wantNew = false;
      router.replace('/dashboard');
      startCreate();
    }
  }
  async function refreshQuiet() {
    const r = await guardLoad();
    if (r && !destroyed && state === 'ready') {
      boards = r.boards || [];
      render();
    }
  }
  async function guardLoad() {
    try {
      return await api.get('/boards');
    } catch (e) {
      error = e;
      return null;
    }
  }

  const unsub = store.subscribe('me', () => {
    if (!store.me && hadMe) return redirect('/');
    hadMe = !!store.me;
    load();
  });
  load();

  return () => {
    destroyed = true;
    seq++;
    unsub();
    header.destroy();
  };
}
