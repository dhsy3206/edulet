// Edulet entry: boot the shared state, register routes, start the router.
import { store } from './lib/store.js';
import { route, onNotFound, router } from './lib/router.js';
import { toast } from './lib/ui.js';
import { homePage } from './views/home.js';
import { dashboardPage } from './views/dashboard.js';
import { boardPage } from './views/board-page.js';
import { notFoundPage } from './views/not-found.js';
import { showAuthFlash } from './views/auth.js';
import { installAvatarContrast } from './board/tone.js';
import { errorMessage } from './board/util.js';

// Safety net: an API failure that nobody caught still reaches the user instead of vanishing.
window.addEventListener('unhandledrejection', (ev) => {
  const e = ev.reason;
  if (e && e.name === 'ApiError') {
    ev.preventDefault();
    if (e.code !== 'cancelled') toast(errorMessage(e), 'error');
  }
});

// A file dropped outside a drop zone would make the browser open it and navigate away, losing unsent drafts.
// Real drop zones (composer, chat input) call preventDefault themselves first, so only the leftovers land here.
const carriesFiles = (e) => !!e.dataTransfer && [...(e.dataTransfer.types || [])].includes('Files');
const inFileInput = (e) => !!(e.target && e.target.closest && e.target.closest('input[type="file"]'));
window.addEventListener('dragover', (e) => {
  if (!carriesFiles(e) || e.defaultPrevented || inFileInput(e)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'none'; // shows "not here" instead of a misleading copy cursor
});
window.addEventListener('drop', (e) => {
  if (carriesFiles(e) && !e.defaultPrevented && !inFileInput(e)) e.preventDefault();
});

// Avatar initials: dark or white ink, whichever reads on the avatar's own colour (UX-15)
installAvatarContrast();

async function boot() {
  const app = document.getElementById('app');
  // static demo build: demo/boot.js resolves this once its service-worker "server" is controlling the page
  if (window.__edulet_ready) await window.__edulet_ready;
  await Promise.all([store.loadConfig(), store.loadMe()]);

  route('/', () => homePage(app));
  route('/dashboard', (_params, query) => dashboardPage(app, query));
  // Both board URLs share one key: moving between them updates the mounted board in place.
  route('/b/:slug', (params) => boardPage(app, params), { key: 'board' });
  route('/b/:slug/p/:postId', (params) => boardPage(app, params), { key: 'board' });
  onNotFound(() => notFoundPage(app));

  router.start();
  showAuthFlash(); // the outcome of a Google sign-in that just redirected back here
}

boot().catch((e) => {
  console.error(e);
  const app = document.getElementById('app');
  if (app) app.textContent = '앱을 시작하지 못했어요. 페이지를 새로고침해 주세요.';
});
