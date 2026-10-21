// Edulet entry: boot the shared state, register routes, start the router.
import { store } from './lib/store.js';
import { route, onNotFound, router } from './lib/router.js';
import { toast } from './lib/ui.js';
import { homePage } from './views/home.js';
import { dashboardPage } from './views/dashboard.js';
import { boardPage } from './views/board-page.js';
import { notFoundPage } from './views/not-found.js';

// Safety net: an API failure that nobody caught still reaches the user instead of vanishing.
window.addEventListener('unhandledrejection', (ev) => {
  const e = ev.reason;
  if (e && e.name === 'ApiError') {
    ev.preventDefault();
    if (e.code !== 'cancelled') toast(e.message, 'error');
  }
});

async function boot() {
  const app = document.getElementById('app');
  await Promise.all([store.loadConfig(), store.loadMe()]);

  route('/', () => homePage(app));
  route('/dashboard', (_params, query) => dashboardPage(app, query));
  // Both board URLs share one key: moving between them updates the mounted board in place.
  route('/b/:slug', (params) => boardPage(app, params), { key: 'board' });
  route('/b/:slug/p/:postId', (params) => boardPage(app, params), { key: 'board' });
  onNotFound(() => notFoundPage(app));

  router.start();
}

boot().catch((e) => {
  console.error(e);
  const app = document.getElementById('app');
  if (app) app.textContent = '앱을 시작하지 못했어요. 페이지를 새로고침해 주세요.';
});
