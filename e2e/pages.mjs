// End-to-end run of the STATIC DEMO build (GitHub Pages mode): builds dist with tools/build-pages.mjs into a temp dir, serves it
// under /edulet/ exactly like GitHub Pages does (unknown paths → 404 status with the 404.html body) and drives isolated headless
// browsers with tools/cdp.mjs against the service-worker "server". No dependencies.   usage: node e2e/pages.mjs
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join, dirname, extname, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser, findChrome } from '../tools/cdp.mjs';
import { listenOnGoodPort } from '../tools/ports.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const OUT = join(here, 'out');
mkdirSync(OUT, { recursive: true });

if (!findChrome()) {
  console.log('SKIP: Chrome/Edge not found (set CHROME_PATH)');
  process.exit(0);
}

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : detail ? '  → ' + detail : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const only = process.argv.slice(2); // e.g. `node e2e/pages.mjs P2 P4` runs just those scenarios
async function step(name, fn) {
  if (only.length && !only.some((o) => name.startsWith(o))) return;
  try {
    await fn();
  } catch (e) {
    check(name + ' (예외)', false, String(e.stack || e.message || e).slice(0, 400));
  }
}
const FORMATS = ['wall', 'grid', 'stream', 'shelf', 'rows', 'canvas', 'backchannel'];
const allErrors = []; // console errors of every page, for P5

/* ───────── 1. build ───────── */
const dist = mkdtempSync(join(tmpdir(), 'edulet-pages-'));
const build = spawnSync(process.execPath, [join(root, 'tools', 'build-pages.mjs'), '--base', '/edulet', '--out', dist], {
  env: { ...process.env, MSYS_NO_PATHCONV: '1' }, encoding: 'utf8',
});
if (build.status !== 0) {
  console.error(build.stdout + build.stderr);
  try { rmSync(dist, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(1);
}
console.log(build.stdout.trim());

/* ───────── 2. a tiny GitHub-Pages-like static server ───────── */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp',
  '.pdf': 'application/pdf', '.txt': 'text/plain; charset=utf-8',
};
const served = []; // every path the static server answered (the service worker answers api/ and uploads/ itself)
const pagesServer = http.createServer((req, res) => {
  const path = decodeURIComponent(req.url.split('?')[0]);
  served.push(path);
  const send404 = () => {
    const body = readFileSync(join(dist, '404.html'));
    res.writeHead(404, { 'Content-Type': MIME['.html'], 'Content-Length': body.length, 'Cache-Control': 'max-age=600' });
    res.end(req.method === 'HEAD' ? undefined : body);
  };
  if (path === '/edulet') { res.writeHead(301, { Location: '/edulet/' }); return res.end(); }
  if (!path.startsWith('/edulet/')) return send404(); // GitHub Pages: nothing lives outside the project prefix
  const rel = path.slice('/edulet/'.length) || 'index.html';
  const file = normalize(join(dist, rel));
  if (!file.startsWith(dist + sep) || !existsSync(file) || !statSync(file).isFile()) return send404();
  const body = readFileSync(file);
  res.writeHead(200, { 'Content-Type': MIME[extname(file).toLowerCase()] || 'application/octet-stream', 'Content-Length': body.length, 'Cache-Control': 'max-age=600' });
  res.end(req.method === 'HEAD' ? undefined : body);
});
await listenOnGoodPort(pagesServer);
const ORIGIN = `http://127.0.0.1:${pagesServer.address().port}`;
const APP = ORIGIN + '/edulet';

const browser = await launchBrowser({ width: 1280, height: 860 });

/* ───────── 3. own CDP connection: network recorder (pages AND service workers) + a few browser-level commands ───────── */
async function startRecorder() {
  const version = await (await fetch(`http://127.0.0.1:${browser.port}/json/version`)).json();
  const ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });
  let id = 0;
  const pending = new Map();
  const requests = [];
  const kinds = new Map(); // sessionId → target type
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const i = ++id;
    pending.set(i, { resolve, reject });
    ws.send(JSON.stringify({ id: i, method, params, sessionId }));
  });
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) p.reject(new Error(m.error.message)); else p.resolve(m.result);
    } else if (m.method === 'Target.attachedToTarget') {
      const { sessionId, targetInfo, waitingForDebugger } = m.params;
      kinds.set(sessionId, targetInfo.type);
      send('Network.enable', {}, sessionId)
        .catch(() => {})
        .then(() => (waitingForDebugger ? send('Runtime.runIfWaitingForDebugger', {}, sessionId) : null))
        .catch(() => {});
    } else if (m.method === 'Network.requestWillBeSent') {
      requests.push({ url: m.params.request.url, type: kinds.get(m.sessionId) || '?' });
    }
  });
  await send('Target.setAutoAttach', {
    autoAttach: true, waitForDebuggerOnStart: true, flatten: true, filter: [{ type: 'page' }, { type: 'service_worker' }, { exclude: true }],
  });
  return { requests, send, close: () => { try { ws.close(); } catch { /* ignore */ } } };
}
const recorder = await startRecorder();

/* ───────── helpers ───────── */
/** fetch inside the page with the page's demo session header (the demo's equivalent of the cookie jar). */
const call = (page, method, path, body) => page.eval(`(async () => {
  const h = { 'Content-Type': 'application/json', 'X-Client-Id': 'e2e-' + Math.random().toString(36).slice(2, 8) };
  const s = localStorage.getItem('edulet_demo_sid'); if (s) h['X-Edulet-Session'] = s;
  const r = await fetch('/edulet/api' + ${JSON.stringify(path)}, { method: ${JSON.stringify(method)}, headers: h, body: ${body === undefined ? 'undefined' : JSON.stringify(JSON.stringify(body))} });
  const n = r.headers.get('X-Edulet-Session'); if (n !== null) { if (n) localStorage.setItem('edulet_demo_sid', n); else localStorage.removeItem('edulet_demo_sid'); }
  return { status: r.status, body: await r.json().catch(() => ({})) };
})()`);

/** Wait until the app has rendered something other than the boot spinner. */
const appReady = (page, sel = '.app-header, .bp, [data-post-id]') =>
  page.waitFor(`!document.querySelector('.app-boot') && !!document.querySelector(${JSON.stringify(sel)})`, { timeout: 20000 });

const pathOf = (page) => page.eval('location.pathname');
const pageErrors = (page) => page.errors.filter((e) => !/Failed to load resource.*(404|net::ERR)/i.test(e));
const cardWith = (text) => `[...document.querySelectorAll('[data-post-id]')].find(e => e.innerText.includes(${JSON.stringify(text)}))`;
async function newPage(ctx, path = '/edulet/') {
  const page = await ctx.newPage(ORIGIN + path);
  return page;
}
async function denyDownloads(ctx) {
  await recorder.send('Browser.setDownloadBehavior', { behavior: 'deny', browserContextId: ctx.id }).catch(() => {});
}
/** Kill the service-worker process(es) of the browser: all in-memory state is gone, IndexedDB stays. */
async function stopWorkers(page) {
  // auto-attach (recorder) off first: a worker restarted under it never leaves "starting"; the network log ends here (P5 reads it earlier)
  await recorder.send('Target.setAutoAttach', { autoAttach: false, waitForDebuggerOnStart: false, flatten: true });
  const { sessionId } = await recorder.send('Target.attachToTarget', { targetId: page.targetId, flatten: true });
  await recorder.send('ServiceWorker.enable', {}, sessionId);
  await recorder.send('ServiceWorker.stopAllWorkers', {}, sessionId);
}
const status = (page) => call(page, 'GET', '/_demo/status').then((r) => r.body);
/** Bring a tab to the front: a background tab does not render (rAF is paused) and the app parks its stream after 15 s. */
async function front(page) {
  await recorder.send('Target.activateTarget', { targetId: page.targetId });
  await sleep(250);
}
const keepAlive = (page) => page.eval('window.__EDULET_HIDE_MS = 3600000; 1'); // never park the event stream of this tab
/** Open the floating composer (waits for any closing one to be gone first, so selectors cannot hit the old one). */
async function openComposer(page) {
  await page.waitFor(`!document.querySelector('[data-role="composer"]')`);
  await page.click('[aria-label="글쓰기"]');
  await page.waitFor(`document.querySelectorAll('[data-role="composer"]').length === 1`);
}

try {
  /* ══════════ P1: first visit boots by itself, reference board, deep link via 404.html ══════════ */
  await step('P1', async () => {
    const ctx = await browser.newContext();
    const page = await newPage(ctx, '/edulet/');
    await appReady(page, '.home-hero');
    check('P1 첫 방문: 서비스 워커가 설치되고 새로고침 없이 앱이 뜸', (await page.eval('!!navigator.serviceWorker.controller')) === true && (await pathOf(page)) === '/edulet/');
    check('P1 데모 표식(EDULET_DEMO / BASE)', (await page.eval('window.EDULET_DEMO === true && window.EDULET_BASE === "/edulet"')) === true);
    check('P1 "데모 모드" 알림이 보임', (await page.count('[data-demo-pill]')) === 1);
    await page.screenshot(join(OUT, 'pages-p1-home.png'));
    const health = await call(page, 'GET', '/health');
    check('P1 /edulet/api/health 는 서비스 워커가 답함', health.status === 200 && health.body.ok === true);
    const cfg = await call(page, 'GET', '/config');
    check('P1 /config: demo:true, 가입 허용, 업로드 10MB', cfg.body.demo === true && cfg.body.allowRegister === true && cfg.body.maxUploadMb === 10 && cfg.body.linkPreview === true, JSON.stringify(cfg.body));
    const nope = await call(page, 'GET', '/nope');
    check('P1 모르는 /api 경로는 404 JSON', nope.status === 404 && nope.body.error?.code === 'not_found');
    const passthrough = await page.eval(`fetch('/edulet/build-info.json').then(async r => ({ status: r.status, mode: (await r.json()).mode }))`);
    check('P1 api·uploads 밖의 요청은 건드리지 않음(정적 파일 그대로)', passthrough.status === 200 && passthrough.mode === 'demo' && served.includes('/edulet/build-info.json'));

    await page.click('a[href="/edulet/b/demo-board"]');
    await page.waitFor('[data-post-id]', { timeout: 15000 });
    check('P1 링크 클릭으로 /edulet/b/demo-board 이동', (await pathOf(page)) === '/edulet/b/demo-board');

    await page.goto(ORIGIN + '/edulet/b/demo-board'); // hard load of a deep URL → GitHub Pages answers 404.html
    await page.waitFor('[data-post-id]', { timeout: 20000 });
    await sleep(800);
    check('P1 딥링크 새로 열기(404.html)도 부팅: 카드 17장', (await page.count('[data-post-id]')) === 17, 'n=' + (await page.count('[data-post-id]')));
    check('P1 섹션 탭 3개', (await page.count('[data-role="section-title"]')) === 3);
    check('P1 형식 rows', (await page.eval(`document.querySelector('[data-role="board-surface"]')?.dataset.format`)) === 'rows');
    const cards = await page.eval(`[...document.querySelectorAll('[data-post-id]')].map(e => e.dataset.postId)`);
    await page.click(`[data-post-id="${cards[3]}"]`);
    await page.waitFor('[data-role="detail"]');
    check('P1 4번째 카드 상세: 4 / 17', /4\s*\/\s*17/.test((await page.text('[data-role="detail-pager"]')) || ''));
    check('P1 댓글 2개', (await page.count('[data-comment-id]')) === 2, 'n=' + (await page.count('[data-comment-id]')));
    await page.screenshot(join(OUT, 'pages-p1-detail.png'));
    await page.key('ArrowRight');
    await page.waitFor(`/5\\s*\\/\\s*17/.test(document.querySelector('[data-role="detail-pager"]')?.innerText||'')`);
    check('P1 → 키: 5 / 17', true);
    await page.key('Escape');
    await page.waitFor(`!document.querySelector('[data-role="detail"]')`);
    check('P1 Esc 로 닫으면 URL 이 /edulet/b/demo-board', (await pathOf(page)) === '/edulet/b/demo-board', await pathOf(page));

    // images and the PDF are served by the service worker from IndexedDB blobs
    await page.waitFor(`[...document.querySelectorAll('[data-post-id] img')].every(i => i.complete)`, { timeout: 10000 });
    const imgs = await page.eval(`[...document.querySelectorAll('[data-post-id] img')].map(i => ({ path: new URL(i.getAttribute('src'), location.href).pathname, w: i.naturalWidth }))`);
    check('P1 카드 이미지가 실제로 불러와짐(naturalWidth>0)', imgs.length >= 12 && imgs.every((i) => i.w > 0), JSON.stringify(imgs.filter((i) => !(i.w > 0)).slice(0, 3)) + ' total=' + imgs.length);
    check('P1 이미지 주소가 /edulet/uploads/seed-… 형태', imgs.every((i) => /^\/edulet\/uploads\/seed-\d+\//.test(i.path)), imgs.slice(0, 2).map((i) => i.path).join(' '));
    const pdf = await page.eval(`(async () => {
      const a = [...document.querySelectorAll('[data-post-id] a[href*="/uploads/seed-"]')].find(x => /pdf/i.test(x.getAttribute('href')) || /Padlet/.test(x.innerText));
      if (!a) return null;
      const path = new URL(a.getAttribute('href'), location.href).pathname;
      const r = await fetch(path);
      const head = new Uint8Array(await r.arrayBuffer()).slice(0, 4);
      return { path, status: r.status, type: r.headers.get('content-type'), disp: r.headers.get('content-disposition'), magic: String.fromCharCode(...head) };
    })()`);
    check('P1 PDF 파일 카드 링크가 /edulet/uploads/seed-… 이고 실제 PDF 를 줌', pdf && /^\/edulet\/uploads\/seed-\d+\//.test(pdf.path) && pdf.status === 200 && pdf.type === 'application/pdf' && /^attachment/.test(pdf.disp || '') && pdf.magic === '%PDF', JSON.stringify(pdf));
    const range = await page.eval(`fetch(${JSON.stringify(pdf?.path || '/edulet/uploads/seed-8/x')}, { headers: { Range: 'bytes=0-9' } }).then(async r => ({ status: r.status, cr: r.headers.get('content-range'), n: (await r.arrayBuffer()).byteLength }))`);
    check('P1 Range 요청(206, Content-Range)', range.status === 206 && /^bytes 0-9\//.test(range.cr || '') && range.n === 10, JSON.stringify(range));
    check('P1 콘솔 오류 없음', pageErrors(page).length === 0, pageErrors(page).join(' | ').slice(0, 300));
    allErrors.push(...pageErrors(page));
    await ctx.close();
  });

  /* ══════════ P1b–P1d: first visit straight on a deep link · hard reload without the worker · browser without service workers ══════════ */
  await step('P1b', async () => {
    const ctx = await browser.newContext();
    const page = await newPage(ctx, '/edulet/b/demo-board'); // never visited: no worker yet, GitHub Pages answers 404.html
    await page.waitFor('[data-post-id]', { timeout: 25000 });
    await sleep(500);
    check('P1b 처음 방문이 딥링크(워커 없음·404.html)여도 새로고침 없이 부팅: 카드 17장', (await page.count('[data-post-id]')) === 17 && (await page.eval('!!navigator.serviceWorker.controller')) === true && (await pathOf(page)) === '/edulet/b/demo-board', 'n=' + (await page.count('[data-post-id]')));
    check('P1b 자동 새로고침 흔적 없음(성공하면 가드가 지워짐)', (await page.eval(`sessionStorage.getItem('edulet_demo_sw_reload')`)) === null);
    check('P1b 콘솔 오류 없음', pageErrors(page).length === 0, pageErrors(page).join(' | ').slice(0, 300));
    allErrors.push(...pageErrors(page));
    await ctx.close();
  });

  await step('P1c', async () => {
    // Ctrl+Shift+R: the page loads WITHOUT the worker although one is active → boot.js waits, then reloads once by itself
    const ctx = await browser.newContext();
    const page = await newPage(ctx, '/edulet/');
    await appReady(page, '.home-hero');
    const { sessionId } = await recorder.send('Target.attachToTarget', { targetId: page.targetId, flatten: true });
    await recorder.send('Network.enable', {}, sessionId);
    await recorder.send('Network.setBypassServiceWorker', { bypass: true }, sessionId);
    await page.eval('window.__before = 1; 1');
    await page.reload();
    check('P1c 워커를 건너뛴 하드 리로드: 페이지가 워커의 제어 밖에서 시작됨', (await page.eval('!navigator.serviceWorker.controller')) === true);
    await sleep(1500);
    await recorder.send('Network.setBypassServiceWorker', { bypass: false }, sessionId); // the automatic reload below goes through the worker
    await page.waitFor(`window.__before === undefined && !document.querySelector('.app-boot') && !!document.querySelector('.home-hero') && !!navigator.serviceWorker.controller`, { timeout: 30000 });
    check('P1c 한 번 자동으로 새로고침해 스스로 복구', true);
    check('P1c 복구 뒤 가드가 지워짐', (await page.eval(`sessionStorage.getItem('edulet_demo_sw_reload')`)) === null);
    await ctx.close();
  });

  await step('P1d', async () => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage('about:blank');
    const { sessionId } = await recorder.send('Target.attachToTarget', { targetId: page.targetId, flatten: true });
    await recorder.send('Page.enable', {}, sessionId);
    await recorder.send('Page.addScriptToEvaluateOnNewDocument', { source: 'delete Navigator.prototype.serviceWorker;' }, sessionId);
    await page.goto(APP + '/');
    await page.waitFor(`(document.getElementById('app') || {}).innerText && document.getElementById('app').innerText.includes('이 브라우저에서는 데모 모드를 쓸 수 없어요')`, { timeout: 10000 });
    const msg = await page.eval(`(() => { const a = document.querySelector('#app a'); return { text: document.getElementById('app').innerText, href: a && a.getAttribute('href') }; })()`);
    check('P1d 서비스 워커를 못 쓰는 브라우저: 빈 화면 대신 한국어 안내와 README 링크', /서비스 워커/.test(msg.text) && msg.href === 'https://github.com/dhsy3206/edulet#빠른-시작', JSON.stringify(msg).slice(0, 200));
    await page.screenshot(join(OUT, 'pages-p1d-unsupported.png'));
    await ctx.close();
  });

  /* ══════════ P2: guest posts through the composer, persistence, live sync between two tabs, worker restart ══════════ */
  await step('P2', async () => {
    const ctx = await browser.newContext();
    const A = await newPage(ctx, '/edulet/');
    await appReady(A, '.home-hero');
    await A.eval('window.__EDULET_DEMO_PING_MS = 1000; 1'); // streams opened from now on heartbeat every second (default 20 s)
    await A.click('a[href="/edulet/b/practice"]');
    await A.waitFor('[data-post-id]', { timeout: 15000 });
    check('P2 연습장 시드 카드 3장', (await A.count('[data-post-id]')) === 3, 'n=' + (await A.count('[data-post-id]')));
    await keepAlive(A);
    await openComposer(A);
    await A.type('[data-role="composer"] [name=title]', '게스트가 쓴 첫 글');
    await A.type('[data-role="composer"] [name=body]', '서비스 워커가 서버예요');
    await A.click('[data-role="composer-submit"]');
    await A.waitFor('.modal-backdrop input'); // anonymous: the app asks for a name first
    await A.type('.modal-backdrop input', '앨리스');
    await A.click('.modal-actions .btn-primary');
    await A.waitFor(cardWith('게스트가 쓴 첫 글'), { timeout: 8000 });
    check('P2 게스트가 작성기로 올린 카드가 나타남', true);
    check('P2 게스트 세션이 헤더 토큰으로 저장됨', !!(await A.eval(`localStorage.getItem('edulet_demo_sid')`)));
    await A.screenshot(join(OUT, 'pages-p2-guest-post.png'));

    await A.reload();
    await keepAlive(A);
    await A.waitFor(cardWith('게스트가 쓴 첫 글'), { timeout: 15000 });
    check('P2 새로고침해도 글이 남음(IndexedDB)', (await A.count('[data-post-id]')) === 4);
    const me = await call(A, 'GET', '/auth/me');
    check('P2 새로고침해도 같은 게스트로 인식', me.body.user?.displayName === '앨리스' && me.body.user?.isGuest === true);

    // second tab of the SAME browser
    const B = await ctx.newPage(APP + '/b/practice');
    await B.waitFor('[data-post-id]', { timeout: 20000 });
    await keepAlive(B);
    await B.waitFor(cardWith('게스트가 쓴 첫 글'));
    check('P2 둘째 탭도 같은 데이터를 봄', (await B.count('[data-post-id]')) === 4);
    await sleep(900);
    await front(A);
    check('P2 접속 중 표시(같은 사용자는 1명)', (await A.count('[data-role="presence"] .avatar')) === 1, 'n=' + (await A.count('[data-role="presence"] .avatar')));

    await openComposer(A);
    await A.type('[data-role="composer"] [name=title]', '탭 A에서 쓴 글');
    await A.click('[data-role="composer-submit"]');
    await front(B);
    await B.waitFor(cardWith('탭 A에서 쓴 글'), { timeout: 6000 });
    check('P2 탭 A의 새 글이 탭 B 에 새로고침 없이 나타남(BroadcastChannel)', true);
    const id = await B.eval(`${cardWith('탭 A에서 쓴 글')}.dataset.postId`);
    await B.click(`[data-post-id="${id}"] [data-reaction="like"]`);
    await front(A);
    await A.waitFor(`(()=>{const b=document.querySelector('[data-post-id="${id}"] [data-reaction="like"]'); return b && b.getAttribute('aria-pressed') === 'true' && /1/.test(b.innerText)})()`, { timeout: 6000 });
    check('P2 탭 B 의 좋아요가 탭 A 에 반영(내 것으로 표시)', true);
    await front(B);
    await B.click(`[data-post-id="${id}"]`);
    await B.waitFor('[data-role="comment-input"]');
    await B.type('[data-role="comment-input"]', '탭 B의 댓글');
    await B.click('[data-role="comment-send"]');
    await sleep(300);
    await front(A);
    await A.waitFor(`(()=>{const c=document.querySelector('[data-post-id="${id}"] [data-role="comment-open"]'); return c && /1/.test(c.innerText)})()`, { timeout: 6000 });
    check('P2 탭 B 의 댓글 수가 탭 A 카드에 반영', true);
    await front(B);
    await B.key('Escape');
    await front(A);
    await A.screenshot(join(OUT, 'pages-p2-live.png'));

    // closing the board in a tab closes its stream (sendBeacon) — the worker's registry shrinks
    const streamsBefore = (await status(A)).streams;
    await B.goto(APP + '/');
    await B.waitFor('.home-hero', { timeout: 15000 });
    let streamsAfter = streamsBefore;
    for (let i = 0; i < 40 && streamsAfter >= streamsBefore; i++) { await sleep(150); streamsAfter = (await status(A)).streams; }
    check('P2 보드를 떠난 탭의 연결이 닫힘(close beacon)', streamsAfter < streamsBefore, `before=${streamsBefore} after=${streamsAfter}`);
    check('P2 콘솔 오류 없음(A,B)', pageErrors(A).length + pageErrors(B).length === 0, [...pageErrors(A), ...pageErrors(B)].join(' | ').slice(0, 300));
    allErrors.push(...pageErrors(A), ...pageErrors(B));
    await ctx.close();
  });

  /* ══════════ P3: register → board from the dashboard → 7 formats → composer with an image → export → logout/login ══════════ */
  await step('P3', async () => {
    const ctx = await browser.newContext();
    await denyDownloads(ctx);
    const page = await newPage(ctx, '/edulet/');
    await appReady(page, '.home-hero');
    await page.click('.home-cta .btn-primary'); // "보드 만들기" → sign-up dialog
    await page.waitFor('[data-role="auth"] input[name=displayName]');
    // modal() hands focus to the first field once it is on screen — typing before that would be redirected into it
    await page.waitFor(`document.activeElement === document.querySelector('[data-role="auth"] input[name=displayName]')`);
    check('P3 데모(서버 없음)에는 Google 로그인 버튼이 없음', (await page.count('[data-role="google-login"]')) === 0 && (await page.eval(`fetch('/edulet/api/config').then(r => r.json()).then(c => c.google === false)`)));
    await page.type('[data-role="auth"] input[name=displayName]', '김하늘');
    await page.type('[data-role="auth"] input[name=username]', 'haneul2026');
    await page.type('[data-role="auth"] input[name=password]', 'password-1234');
    await page.click('[data-role="auth-submit"]');
    await page.waitFor('.dash-create', { timeout: 15000 });
    check('P3 가입 → 대시보드의 "새 보드" 창이 열림', (await pathOf(page)) === '/edulet/dashboard');
    await page.click('.dash-create [data-template="kwl"]');
    await page.type('.dash-create input[name=title]', 'KWL 수업 보드');
    await page.click('[data-role="create-submit"]');
    await page.waitFor(`/^\\/edulet\\/b\\/[a-z0-9]+$/.test(location.pathname) && !!document.querySelector('[data-role="board-surface"]')`, { timeout: 15000 });
    const slug = (await pathOf(page)).split('/').pop();
    check('P3 KWL 템플릿 보드: shelf + 섹션 3개', (await page.eval(`document.querySelector('[data-role="board-surface"]').dataset.format`)) === 'shelf' && (await page.count('[data-role="section-title"]')) === 3, 'sections=' + (await page.count('[data-role="section-title"]')));
    await page.screenshot(join(OUT, 'pages-p3-kwl.png'));

    // formats through the settings drawer; wall first so the floating composer button exists
    await page.click('[aria-label="설정"]');
    await page.waitFor('[data-role="settings"]');
    await page.click('[data-role="settings"] [data-format="wall"]');
    await page.waitFor(`document.querySelector('[data-role="board-surface"]')?.dataset.format === 'wall'`);
    await page.key('Escape');
    await page.waitFor(`!document.querySelector('[data-role="settings"]')`);

    await openComposer(page);
    await page.type('[data-role="composer"] [name=title]', '첫 번째 글');
    await page.type('[data-role="composer"] [name=body]', '본문입니다');
    await page.click('[data-role="composer-submit"]');
    await page.waitFor(cardWith('첫 번째 글'), { timeout: 8000 });
    await openComposer(page);
    await page.type('[data-role="composer"] [name=title]', '사진이 있는 글');
    await page.setFiles('[data-role="composer"] [data-role="file-input"]', [join(root, 'seed', 'img', 'mobile.png')]);
    await page.waitFor('[data-role="composer"] .b-staged', { timeout: 10000 });
    check('P3 작성기에서 이미지 업로드(서비스 워커가 받음)', true);
    await page.click('[data-role="composer-submit"]');
    await page.waitFor(cardWith('사진이 있는 글'), { timeout: 8000 });
    check('P3 글 2개 작성', (await page.count('[data-post-id]')) === 2);
    await page.waitFor(`!document.querySelector('[data-role="composer"]')`);

    for (const f of FORMATS) {
      await page.click('[aria-label="설정"]');
      await page.waitFor('[data-role="settings"]');
      await page.click(`[data-role="settings"] [data-format="${f}"]`);
      await page.waitFor(`document.querySelector('[data-role="board-surface"]')?.dataset.format === '${f}'`, { timeout: 8000 });
      await page.key('Escape');
      await page.waitFor(`!document.querySelector('[data-role="settings"]')`);
      await sleep(350);
      check(`P3 형식 ${f}: 카드 2장 실시간 전환`, (await page.count('[data-post-id]')) === 2, 'n=' + (await page.count('[data-post-id]')));
      await page.screenshot(join(OUT, `pages-p3-${f}.png`));
    }
    await page.click('[aria-label="설정"]');
    await page.waitFor('[data-role="settings"]');
    await page.click('[data-role="settings"] [data-format="wall"]');
    await page.waitFor(`document.querySelector('[data-role="board-surface"]')?.dataset.format === 'wall'`);
    await page.key('Escape');

    await page.reload();
    await page.waitFor('[data-post-id]', { timeout: 15000 });
    await page.waitFor(`[...document.querySelectorAll('[data-post-id] img')].length > 0 && [...document.querySelectorAll('[data-post-id] img')].every(i => i.complete)`, { timeout: 10000 });
    const img = await page.eval(`(() => { const i = document.querySelector('[data-post-id] img'); return { w: i.naturalWidth, path: new URL(i.getAttribute('src'), location.href).pathname }; })()`);
    check('P3 새로고침 후 올린 이미지가 보임(워커가 /edulet/uploads/… 에서 blob 제공)', img.w > 0 && /^\/edulet\/uploads\/[0-9a-f]{32}\//.test(img.path), JSON.stringify(img));
    const raw = await page.eval(`fetch(${JSON.stringify(img.path)}).then(r => ({ status: r.status, type: r.headers.get('content-type'), disp: r.headers.get('content-disposition'), nosniff: r.headers.get('x-content-type-options') }))`);
    check('P3 업로드 응답 헤더(image/png, inline, nosniff)', raw.status === 200 && raw.type === 'image/png' && /^inline/.test(raw.disp || '') && raw.nosniff === 'nosniff', JSON.stringify(raw));

    // export JSON through the share dialog
    await page.eval(`window.__blobs = []; const o = URL.createObjectURL.bind(URL); URL.createObjectURL = (b) => { window.__blobs.push(b); return o(b); }; 1`);
    await page.click('[aria-label="공유"]');
    await page.waitFor('[data-role="share"]');
    await page.eval(`[...document.querySelectorAll('[data-role="share"] a.btn')].find(a => /JSON/.test(a.innerText)).scrollIntoView({ block: 'center' }); 1`);
    await sleep(300);
    const jsonLink = await page.eval(`(() => { const a = [...document.querySelectorAll('[data-role="share"] a.btn')].find(x => /JSON/.test(x.innerText)); const r = a.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    await page.mouse(jsonLink.x, jsonLink.y);
    await page.waitFor('(window.__blobs.length > 0)', { timeout: 8000 }); // parentheses: cdp.mjs treats a bare word-chain as a CSS selector
    const exported = JSON.parse(await page.eval('window.__blobs[0].text()'));
    check('P3 공유 창의 JSON 내보내기: 글 2개와 보드 정보', exported.board?.slug === slug && exported.posts?.length === 2 && exported.posts.every((p) => Array.isArray(p.comments)), JSON.stringify(Object.keys(exported)));
    const viaFetch = await page.eval(`(async () => { const r = await fetch('/edulet/api/boards/${slug}/export?format=csv', { headers: { 'X-Edulet-Session': localStorage.getItem('edulet_demo_sid') } }); const bytes = new Uint8Array(await r.arrayBuffer()); const t = new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes); return { status: r.status, bom: bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF, head: t.slice(1, 20), disp: r.headers.get('content-disposition'), rows: t.trim().split('\\r\\n').length }; })()`);
    check('P3 CSV 내보내기(세션 헤더로): BOM, 머리글, 글 2줄', viaFetch.status === 200 && viaFetch.bom && viaFetch.head.startsWith('섹션,작성자') && viaFetch.rows === 3 && /^attachment/.test(viaFetch.disp), JSON.stringify(viaFetch));
    await page.key('Escape');

    // logout → login again keeps the boards
    await page.click('[aria-label="사용자 메뉴"]');
    await page.waitFor(`[...document.querySelectorAll('.popover .menu-item')].some(b => b.innerText.includes('로그아웃'))`);
    await page.eval(`[...document.querySelectorAll('.popover .menu-item')].find(b => b.innerText.includes('로그아웃')).click(); 1`);
    await page.waitFor(`!localStorage.getItem('edulet_demo_sid')`, { timeout: 6000 });
    const meOut = await call(page, 'GET', '/auth/me');
    check('P3 로그아웃: 세션 토큰이 지워지고 비로그인', meOut.body.user === null);
    await page.waitFor(`[...document.querySelectorAll('button, a')].some(b => b.innerText.trim() === '로그인')`, { timeout: 6000 });
    await page.eval(`[...document.querySelectorAll('button, a')].find(b => b.innerText.trim() === '로그인').click(); 1`);
    await page.waitFor('[data-role="auth"] input[name=username]');
    await page.waitFor(`document.activeElement === document.querySelector('[data-role="auth"] input[name=username]')`);
    await page.type('[data-role="auth"] input[name=username]', 'haneul2026');
    await page.type('[data-role="auth"] input[name=password]', 'password-1234');
    await page.click('[data-role="auth-submit"]');
    await page.waitFor(`!!localStorage.getItem('edulet_demo_sid') || !!document.querySelector('[data-role="auth"] .form-error')?.innerText`, { timeout: 8000 });
    check('P3 UI 로그인: 세션 토큰이 다시 생김', !!(await page.eval(`localStorage.getItem('edulet_demo_sid')`)), await page.eval(`document.querySelector('[data-role="auth"] .form-error')?.innerText || ''`));
    await page.goto(APP + '/dashboard');
    await page.waitFor(`!!document.querySelector('.dash-card[data-slug="${slug}"]')`, { timeout: 15000 });
    check('P3 다시 로그인하면 만든 보드가 대시보드에 그대로 있음', true);
    await page.screenshot(join(OUT, 'pages-p3-dashboard.png'));
    const wrong = await call(page, 'POST', '/auth/login', { username: 'haneul2026', password: 'wrong-password' });
    check('P3 틀린 비밀번호: 401 bad_credentials', wrong.status === 401 && wrong.body.error?.code === 'bad_credentials');
    check('P3 콘솔 오류 없음', pageErrors(page).length === 0, pageErrors(page).join(' | ').slice(0, 300));
    allErrors.push(...pageErrors(page));
    await ctx.close();
  });

  /* ══════════ P4: the badge (collapse is remembered, dialog text) and the reset ══════════ */
  await step('P4', async () => {
    const ctx = await browser.newContext();
    const A = await newPage(ctx, '/edulet/b/practice');
    await A.waitFor('[data-post-id]', { timeout: 20000 });
    check('P4 알림 칩이 수동 조작이 가능한 크기(≥40px)', await A.eval(`(() => { const r = document.querySelector('.edulet-demo-pill .edp-main').getBoundingClientRect(); return r.height >= 40 && r.width >= 40; })()`));
    await A.click('.edulet-demo-pill .edp-x');
    check('P4 알림 줄이기', await A.eval(`document.querySelector('.edulet-demo-pill').classList.contains('is-collapsed')`));
    await A.reload();
    await A.waitFor('[data-post-id]', { timeout: 20000 });
    check('P4 줄여 둔 상태를 기억(새로고침 뒤에도)', await A.eval(`document.querySelector('.edulet-demo-pill').classList.contains('is-collapsed')`));
    await A.click('.edulet-demo-pill .edp-main');
    check('P4 줄인 칩을 누르면 다시 펼쳐짐', !(await A.eval(`document.querySelector('.edulet-demo-pill').classList.contains('is-collapsed')`)));

    // some data of our own to be wiped
    const guest = await call(A, 'POST', '/auth/guest', { displayName: '초기화 시험' });
    const made = await call(A, 'POST', '/boards/practice/posts', { title: '지워질 글' });
    check('P4 (준비) 게스트 글 쓰기', guest.status === 201 && made.status === 201);
    const B = await ctx.newPage(APP + '/b/demo-board');
    await B.waitFor('[data-post-id]', { timeout: 20000 });
    await B.eval('window.__marker = 1; 1');
    await A.eval('window.__marker = 1; 1');

    await front(A); // real mouse events only reach the visible tab
    await A.click('.edulet-demo-pill .edp-main');
    await A.waitFor('dialog.edulet-demo-dialog[open]');
    const dlg = await A.eval(`(() => { const d = document.querySelector('dialog.edulet-demo-dialog'); const a = d.querySelector('a'); return { text: d.innerText, href: a.getAttribute('href'), rel: a.getAttribute('rel') }; })()`);
    check('P4 안내창: 브라우저 안에서만·IndexedDB·다른 기기에는 안 보임·탭 동기화 설명', /이 브라우저/.test(dlg.text) && /IndexedDB/.test(dlg.text) && /다른 기기/.test(dlg.text) && /탭/.test(dlg.text), dlg.text.slice(0, 120));
    check('P4 안내창의 "README의 서버 실행 방법" 링크', dlg.href === 'https://github.com/dhsy3206/edulet#빠른-시작' && /noopener/.test(dlg.rel) && /README의 서버 실행 방법/.test(dlg.text), dlg.href);
    await A.screenshot(join(OUT, 'pages-p4-dialog.png'));
    await A.click('dialog [data-demo-reset]');
    await A.waitFor(`/정말|지우고|되돌릴까요/.test(document.querySelector('dialog .edd-ask')?.innerText || '')`);
    check('P4 초기화는 확인을 한 번 더 물음(바로 지우지 않음)', (await call(A, 'GET', '/boards/practice')).body.posts.length === 4);
    await A.screenshot(join(OUT, 'pages-p4-confirm.png'));
    const yes = await A.eval(`(() => { const b = [...document.querySelectorAll('dialog button')].find(x => /네, 초기화/.test(x.innerText)); const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    await A.mouse(yes.x, yes.y);
    await A.waitFor(`window.__marker === undefined && document.readyState === 'complete' && !!document.querySelector('[data-post-id]')`, { timeout: 25000 });
    check('P4 초기화 뒤 이 탭이 다시 불러와짐', true);
    await B.waitFor(`window.__marker === undefined && document.readyState === 'complete' && !!document.querySelector('[data-post-id]')`, { timeout: 25000 });
    check('P4 같은 브라우저의 다른 탭도 함께 다시 불러와짐(BroadcastChannel)', true);
    const practice = await call(A, 'GET', '/boards/practice');
    const ai = await call(A, 'GET', '/boards/demo-board');
    check('P4 시드가 복원됨(연습장 3장 · 연수 17장 · 내 글 없음)', practice.body.posts.length === 3 && ai.body.posts.length === 17 && !practice.body.posts.some((p) => p.title === '지워질 글'), `${practice.body.posts?.length}/${ai.body.posts?.length}`);
    check('P4 세션도 비워짐', (await call(A, 'GET', '/auth/me')).body.user === null && !(await A.eval(`localStorage.getItem('edulet_demo_sid')`)));
    const imgs = await B.eval(`[...document.querySelectorAll('[data-post-id] img')].filter(i => i.complete && i.naturalWidth > 0).length`);
    check('P4 초기화 뒤에도 시드 이미지가 보임', imgs >= 12, 'n=' + imgs);
    check('P4 콘솔 오류 없음', pageErrors(A).length + pageErrors(B).length === 0, [...pageErrors(A), ...pageErrors(B)].join(' | ').slice(0, 300));
    allErrors.push(...pageErrors(A), ...pageErrors(B));
    await ctx.close();
  });

  /* ══════════ P2b: the worker is killed (all memory gone) — data survives, streams heal themselves, live sync resumes ══════════ */
  await step('P2b', async () => {
    const ctx = await browser.newContext();
    const open = async () => {
      const home = await newPage(ctx, '/edulet/');
      await appReady(home, '.home-hero');
      await home.eval('window.__EDULET_DEMO_PING_MS = 1000; window.__EDULET_HIDE_MS = 3600000; 1'); // fast heartbeat, never park this tab's stream
      await home.click('a[href="/edulet/b/practice"]');
      await home.waitFor('[data-post-id]', { timeout: 15000 });
      return home;
    };
    const A = await open();
    const g = await call(A, 'POST', '/auth/guest', { displayName: '재시작 시험' });
    const first = await call(A, 'POST', '/boards/practice/posts', { title: '재시작 전에 쓴 글' });
    check('P2b (준비) 게스트 글 쓰기', g.status === 201 && first.status === 201);
    const B = await open();
    await sleep(1500);
    check('P2b (준비) 두 탭의 연결이 워커에 등록됨', (await status(A)).streams === 2, JSON.stringify(await status(A)));

    await stopWorkers(A);
    await sleep(500);
    const after = await call(A, 'GET', '/boards/practice');
    check('P2b 서비스 워커를 죽였다 살려도 데이터가 그대로(저장한 뒤 응답했음)', after.status === 200 && after.body.posts.some((p) => p.title === '재시작 전에 쓴 글') && after.body.posts.length === 4, 'n=' + after.body.posts?.length);
    const me = await call(A, 'GET', '/auth/me');
    check('P2b 세션도 그대로(같은 게스트)', me.body.user?.displayName === '재시작 시험');
    let healed = false;
    for (let i = 0; i < 80 && !healed; i++) { healed = (await status(A)).streams === 2; if (!healed) await sleep(250); }
    check('P2b 워커가 잊은 두 탭의 연결이 ping(known:false)으로 스스로 복구', healed, JSON.stringify(await status(A)));
    const made = await call(B, 'POST', '/boards/practice/posts', { title: '재시작 뒤에 쓴 글' });
    check('P2b (준비) 재시작 뒤 글 쓰기', made.status === 201, 'status=' + made.status);
    await front(A);
    await A.waitFor(cardWith('재시작 뒤에 쓴 글'), { timeout: 8000 });
    check('P2b 재시작 뒤에도 다른 탭의 글이 실시간으로 도착', true);
    check('P2b 콘솔 오류 없음(A,B)', pageErrors(A).length + pageErrors(B).length === 0, [...pageErrors(A), ...pageErrors(B)].join(' | ').slice(0, 300));
    allErrors.push(...pageErrors(A), ...pageErrors(B));
    await ctx.close();
  });

  /* ══════════ P5: no console errors anywhere; nothing leaves the /edulet/ prefix ══════════ */
  await step('P5', async () => {
    check('P5 모든 화면에서 콘솔 오류 없음', allErrors.length === 0, allErrors.join(' | ').slice(0, 400));
    const outside = recorder.requests.filter((r) => {
      if (!/^https?:/.test(r.url)) return false;
      const u = new URL(r.url);
      if (u.origin === ORIGIN) return !u.pathname.startsWith('/edulet/');
      return !(u.hostname === 'i.ytimg.com' || /(^|\.)(fonts\.googleapis\.com|fonts\.gstatic\.com)$/.test(u.hostname));
    });
    check('P5 /edulet/ 밖으로 나가는 네트워크 요청 없음(i.ytimg.com·폰트 제외)', outside.length === 0, outside.slice(0, 5).map((r) => `${r.type}:${r.url}`).join(' | '));
    check('P5 (기록 확인) 페이지와 서비스 워커의 요청을 모두 봤음', recorder.requests.length > 50 && recorder.requests.some((r) => r.type === 'service_worker') && recorder.requests.some((r) => r.type === 'page'), `n=${recorder.requests.length} types=${[...new Set(recorder.requests.map((r) => r.type))]}`);
    const leaked = served.filter((p) => p.startsWith('/edulet/api/') || p.startsWith('/edulet/uploads/'));
    check('P5 api·uploads 요청은 정적 서버까지 오지 않음(서비스 워커가 전부 답함)', leaked.length === 0, leaked.slice(0, 5).join(' '));
  });
} finally {
  recorder.close();
  await browser.close();
  await new Promise((r) => pagesServer.close(r));
  try { rmSync(dist, { recursive: true, force: true }); } catch { /* ignore */ }
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) {
  console.log('FAILED:\n' + failed.map((f) => ` - ${f.name} ${f.detail}`).join('\n'));
  process.exit(1);
}
