// Route handler for /b/:slug and /b/:slug/p/:postId — the board shell (wallpaper, top bar, header, states).
// The board itself (cards, composer, detail, slideshow) is mounted by F2's mountBoard().
import { h, mount } from '../lib/h.js';
import { store } from '../lib/store.js';
import { router } from '../lib/router.js';
import { BoardController } from '../lib/board-controller.js';
import { renderRich } from '../lib/markdown.js';
import { icon, avatar, timeAgo, fullTime } from '../lib/ui.js';
import { mountBoard } from '../board/index.js';
import { loadTone } from '../board/tone.js';
import { boardPath, wallpaperProps } from './common.js';
import { openAuthModal } from './auth.js';
import { createTopbar, simpleBar } from './board-topbar.js';
import { openSharePanel } from './share-panel.js';
import { toggleSettingsPanel } from './settings-panel.js';

function skeleton() {
  const card = () => h('div', { class: 'bp-skel-card' }, h('div', { class: 'bp-skel-line w60' }), h('div', { class: 'bp-skel-line' }), h('div', { class: 'bp-skel-line w80' }));
  return [
    h('section', { class: 'bp-head', 'aria-busy': 'true', 'aria-label': '보드를 불러오는 중' },
      h('div', { class: 'bp-skel-line bp-skel-meta' }), h('div', { class: 'bp-skel-line bp-skel-title' }), h('div', { class: 'bp-skel-line w50' })),
    h('div', { class: 'bp-skel-body' }, [0, 1, 2, 3].map(card)),
  ];
}

export function boardPage(root, params) {
  const slug = params.slug;
  const ctl = new BoardController(slug);
  let wantedPost = params.postId != null && params.postId !== '';
  if (wantedPost) ctl.syncFromUrl(params.postId);

  const surface = h('div', { class: 'bp bp-dark wp-green font-sans scheme-light', dataset: { role: 'board-surface' } });
  mount(root, surface);

  let view = null; // 'loading' | 'ready' | 'error' | 'notfound:anon' | 'notfound:user'
  let built = false;
  let bar = null; // full top bar (ready)
  let msgBar = null; // simple top bar (other states)
  let handle = null; // F2 mountBoard() result
  let headWatch = null; // ResizeObserver: the header scrim follows the header's height
  let hasConnected = false;
  let alive = true;
  let sharePanel = null;
  let settingsHandle = null;
  const el = {}; // ready-view elements

  /* ───────── surface ───────── */
  function setSurface(board) {
    const wp = wallpaperProps(board ? board.wallpaper : 'green');
    if (wp.id === 'custom' && !wp.toneKnown) {
      // light or dark photo? (UX-06) measure once, then repaint; until then: white text on a dark scrim
      const asked = board.wallpaper;
      loadTone(wp.url).then(() => {
        if (alive && ctl.state.board && ctl.state.board.wallpaper === asked) setSurface(ctl.state.board);
      });
    }
    surface.className = ['bp', wp.cls, 'font-' + (board ? board.font : 'sans'), 'scheme-' + (board ? board.colorScheme : 'light'), wp.dark && 'bp-dark'].filter(Boolean).join(' ');
    surface.style.backgroundImage = wp.style ? wp.style.backgroundImage : '';
    surface.dataset.tone = wp.dark ? 'dark' : 'light';
    surface.dataset.format = board ? board.format : '';
    surface.dataset.wallpaper = board ? board.wallpaper : '';
  }

  function clearChrome() {
    [bar, msgBar].forEach((b) => b && b.destroy());
    bar = msgBar = null;
    view = null;
  }
  function closePanels() {
    if (sharePanel) sharePanel.close();
    if (settingsHandle) settingsHandle.close();
    sharePanel = settingsHandle = null;
  }
  function teardownReady() {
    closePanels();
    if (handle && handle.destroy) {
      try {
        handle.destroy();
      } catch (e) {
        console.error(e);
      }
    }
    handle = null;
    if (headWatch) headWatch.disconnect();
    headWatch = null;
    surface.style.removeProperty('--bp-scrim-h');
    built = false;
  }

  /* ───────── ready view ───────── */
  function buildReady() {
    clearChrome();
    bar = createTopbar(ctl, {
      onShare: () => {
        if (sharePanel) sharePanel.close();
        sharePanel = openSharePanel(ctl);
      },
      onSettings: () => {
        settingsHandle = toggleSettingsPanel(ctl);
      },
    });
    el.title = h('h1', { class: 'bp-title', dataset: { role: 'board-title' } });
    el.byline = h('div', { class: 'bp-byline' });
    el.desc = h('div', { class: 'bp-desc' });
    // <main> landmark + a skip link that jumps past the top bar (UX-16)
    el.body = h('main', { class: 'bp-body', id: 'main', tabindex: '-1', 'aria-label': '보드' });
    el.skip = h('a', {
      class: 'bp-skip', href: '#main',
      onClick: (e) => {
        e.preventDefault();
        el.body.focus({ preventScroll: true });
        el.body.scrollIntoView({ block: 'start' });
      },
    }, '보드로 건너뛰기');
    el.bannerText = h('span', { class: 'bp-banner-text' });
    el.retry = h('button', { type: 'button', class: 'btn btn-sm btn-secondary', hidden: true, onClick: () => ctl.load() }, '다시 시도');
    el.banner = h('div', { class: 'bp-banner', role: 'status', hidden: true }, h('span', { class: 'spinner sm' }), el.bannerText, el.retry);
    el.head = h('section', { class: 'bp-head' }, el.byline, el.title, el.desc);
    mount(surface, el.skip, bar.el, el.banner, el.head, el.body);
    if (typeof ResizeObserver !== 'undefined') {
      headWatch = new ResizeObserver(() => surface.style.setProperty('--bp-scrim-h', el.head.offsetTop + el.head.offsetHeight + 70 + 'px'));
      headWatch.observe(el.head);
    }
    view = 'ready';
    built = true;
    try {
      handle = mountBoard(el.body, ctl);
    } catch (e) {
      console.error(e);
      el.body.replaceChildren(h('p', { class: 'bp-inline-error' }, '보드를 표시하지 못했어요. 페이지를 새로고침해 주세요.'));
    }
  }

  function applyBoard() {
    const b = ctl.state.board;
    setSurface(b);
    el.title.textContent = b.title;
    const o = b.owner;
    mount(el.byline,
      o ? avatar(o, 24) : null, o ? h('span', { class: 'bp-byline-name' }, o.displayName) : null, o ? h('span', { 'aria-hidden': 'true' }, '•') : null,
      h('time', { title: fullTime(b.createdAt) }, timeAgo(b.createdAt)));
    const d = (b.description || '').trim();
    el.desc.hidden = !d;
    el.desc.replaceChildren(d ? renderRich(d) : '');
    document.title = `${b.title} · Edulet`;
  }

  function updateBanner() {
    if (!built) return;
    const s = ctl.state;
    if (s.connected) hasConnected = true;
    const failed = s.status === 'error';
    // a stream that was refused outright (e.g. 429 too_many_connections) never connected: say so instead of failing silently
    const refused = s.status === 'ready' && !s.connected && !hasConnected && !!s.streamRefused;
    const lost = hasConnected && !s.connected;
    el.banner.hidden = !(failed || lost || refused);
    el.retry.hidden = !failed;
    el.bannerText.textContent = failed ? '보드를 새로 고치지 못했어요.'
      : refused ? '실시간 연결을 만들지 못했어요. 다른 창을 닫으면 다시 연결돼요.' : '연결이 끊겼어요. 다시 연결하는 중…';
  }

  /* ───────── other states ───────── */
  function showLoading() {
    clearChrome();
    setSurface(null);
    msgBar = simpleBar();
    view = 'loading';
    mount(surface, msgBar.el, skeleton());
    document.title = 'Edulet';
  }

  function showMessage(kind) {
    const anon = !store.me;
    const key = kind === 'error' ? 'error' : anon ? 'notfound:anon' : 'notfound:user';
    if (view === key) return;
    clearChrome();
    setSurface(null);
    msgBar = simpleBar();
    view = key;
    let card;
    if (kind === 'error') {
      const e = ctl.state.error;
      document.title = '보드를 불러오지 못했어요 · Edulet';
      card = h('div', { class: 'bp-msg' },
        h('span', { class: 'app-state-ico' }, icon('alert', { size: 28 })),
        h('h1', { class: 'app-state-title' }, '보드를 불러오지 못했어요'),
        h('p', { class: 'muted' }, (e && e.message) || '잠시 후 다시 시도해 주세요.'),
        h('div', { class: 'row app-state-actions' },
          h('button', { type: 'button', class: 'btn btn-primary', onClick: retry }, icon('refresh', { size: 18 }), '다시 시도'),
          h('a', { class: 'btn btn-secondary', href: '/', 'data-link': true }, '처음으로')));
    } else {
      document.title = '보드를 찾을 수 없어요 · Edulet';
      card = h('div', { class: 'bp-msg' },
        h('span', { class: 'app-state-ico' }, icon('lock', { size: 28 })),
        h('h1', { class: 'app-state-title' }, '보드를 찾을 수 없어요'),
        h('p', { class: 'muted' }, anon
          ? '주소가 잘못되었거나 비공개 보드일 수 있어요. 초대받은 보드라면 로그인하면 열릴 수도 있어요.'
          : '주소가 잘못되었거나, 삭제되었거나, 이 보드를 볼 권한이 없어요.'),
        h('div', { class: 'row app-state-actions' },
          anon ? h('button', { type: 'button', class: 'btn btn-primary', onClick: () => openAuthModal() }, '로그인') : null,
          h('a', { class: ['btn', anon ? 'btn-secondary' : 'btn-primary'], href: anon ? '/' : '/dashboard', 'data-link': true }, anon ? '처음으로' : '내 보드로')));
    }
    mount(surface, msgBar.el, h('div', { class: 'bp-msg-wrap' }, card));
  }

  function retry() {
    ctl.state.status = 'loading';
    render();
    ctl.load();
  }

  /* ───────── controller → view ───────── */
  function render() {
    const s = ctl.state;
    if (s.status === 'ready') {
      if (!built) buildReady();
      applyBoard();
      bar.update();
      updateBanner();
      if (wantedPost) {
        wantedPost = false;
        if (s.openPostId == null) router.replace(boardPath(slug)); // deep link to a post that does not exist
      }
      return;
    }
    if (built && s.status === 'error') return updateBanner(); // keep the board on screen, offer a retry
    if (built) teardownReady();
    if (s.status === 'loading') {
      if (view !== 'loading') showLoading();
      return;
    }
    showMessage(s.status === 'error' ? 'error' : 'notfound');
  }

  const unsub = ctl.subscribe((ev) => {
    switch (ev.type) {
      case 'posts': case 'post': case 'comments': case 'sections':
        return;
      case 'presence':
        if (built && bar) bar.updatePresence();
        return;
      case 'board':
        if (built) {
          applyBoard();
          bar.update();
        }
        return;
      case 'ui':
        updateBanner();
        return;
      default:
        render();
    }
  });

  showLoading();
  ctl.load();

  return {
    update(next) {
      ctl.syncFromUrl(next.postId);
    },
    destroy() {
      alive = false;
      unsub();
      teardownReady();
      clearChrome();
      ctl.destroy();
      document.title = 'Edulet';
    },
  };
}
