// History-API router.
//   route('/b/:slug', handler, { key })      handler(params, query) → void | cleanupFn | { destroy(), update?(params, query) }
// When the next match has the same `key` and the current result has update(), the page is updated in place
// instead of being torn down (used so /b/:slug and /b/:slug/p/:id share one mounted board).
const routes = [];
let current = null; // { key, params, result }
let notFound = null;

function compile(pattern) {
  const names = [];
  const re = new RegExp(
    '^' +
      pattern.replace(/\/:([A-Za-z0-9_]+)/g, (_, n) => {
        names.push(n);
        return '/([^/]+)';
      }) +
      '/?$'
  );
  return { re, names };
}

export function route(pattern, handler, opts = {}) {
  routes.push({ ...compile(pattern), handler, key: opts.key || pattern });
}

export function onNotFound(handler) {
  notFound = handler;
}

function teardown() {
  const r = current && current.result;
  current = null;
  if (typeof r === 'function') r();
  else if (r && typeof r.destroy === 'function') r.destroy();
}

function parseQuery(search) {
  const q = {};
  for (const [k, v] of new URLSearchParams(search)) q[k] = v;
  return q;
}

function resolve() {
  const path = location.pathname;
  const query = parseQuery(location.search);
  for (const r of routes) {
    const m = r.re.exec(path);
    if (!m) continue;
    const params = {};
    r.names.forEach((n, i) => (params[n] = decodeURIComponent(m[i + 1])));
    if (current && current.key === r.key && current.result && typeof current.result.update === 'function' && current.params.slug === params.slug) {
      current.params = params;
      current.result.update(params, query);
      return;
    }
    teardown();
    current = { key: r.key, params, result: null };
    current.result = r.handler(params, query);
    return;
  }
  teardown();
  if (notFound) current = { key: '*', params: {}, result: notFound(path) };
}

export const router = {
  start() {
    window.addEventListener('popstate', resolve);
    document.addEventListener('click', (e) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = e.target.closest && e.target.closest('a[data-link]');
      if (!a) return;
      const url = new URL(a.href, location.href);
      if (url.origin !== location.origin) return;
      e.preventDefault();
      router.go(url.pathname + url.search + url.hash);
    });
    resolve();
  },
  go(path) {
    if (path === location.pathname + location.search + location.hash) return resolve();
    history.pushState(null, '', path);
    resolve();
    window.scrollTo(0, 0);
  },
  /** Change the URL without running the router (used for post deep links inside a mounted board). */
  replace(path) {
    history.replaceState(null, '', path);
  },
  /** Same as replace but adds a history entry, still without resolving. */
  push(path) {
    history.pushState(null, '', path);
  },
  get path() {
    return location.pathname;
  },
};
