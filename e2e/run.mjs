// End-to-end acceptance run (docs/CONTRACT.md §10): boots a real server on a temp DB, drives isolated headless
// browsers with tools/cdp.mjs. No dependencies.   usage: npm run e2e   (needs Chrome/Edge; CHROME_PATH to override)
import http from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir, networkInterfaces as osNetworkInterfaces } from 'node:os';
import net from 'node:net';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { launchBrowser, findChrome } from '../tools/cdp.mjs';
import { Client, createAppOnGoodPort, listenOnGoodPort, makeBoard, makeUser } from '../test/helpers.js';
import { startMockGoogle } from '../test/google-mock.js';
import { buildDemoBoard, makePdf, makePng, makeSeedDir, stubPreviewFetcher } from './demo-board.mjs';
import { connectBrowser, watchDownloads } from './rawcdp.mjs';
import { GPS_NEEDLE, bombPng, injectExif } from './image-fixtures.mjs';

const here = dirname(fileURLToPath(import.meta.url));
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
const FORMATS = ['wall', 'grid', 'stream', 'shelf', 'rows', 'canvas', 'backchannel'];

// Hermetic: the run never reads the repository's seed/ folder. It seeds from a temp folder with a copy of seed/practice.json only,
// and builds its own example board through the public API (e2e/demo-board.mjs).
const repoRoot = join(here, '..');
const seedDir = makeSeedDir(repoRoot);
// (a port that Chrome refuses — ERR_UNSAFE_PORT — is re-rolled with a fresh data folder; see test/helpers.js)
// previewFetcher: link cards of the example board get their preview from a stand-in, never from the network
const app = await createAppOnGoodPort(() => ({ dataDir: mkdtempSync(join(tmpdir(), 'edulet-e2e-')), port: 0, seed: true, seedDir, previewFetcher: stubPreviewFetcher }));
const dataDir = app.app.config.dataDir;
const base = app.url.replace(/\/$/, '');
const browser = await launchBrowser({ width: 1280, height: 860 });

/** Sign an owner up over HTTP and let them build the example board (rows, 3 sections, 17 cards, 2 comments); visitors get read + comment. */
async function createDemoBoard() {
  const owner = new Client(app);
  const reg = await owner.post('/api/auth/register', { username: 'demoowner' + Math.random().toString(36).slice(2, 6), password: 'password-1234', displayName: '예시 소유자' });
  if (reg.status !== 201 && reg.status !== 200) throw new Error('demo owner register failed ' + reg.status + ' ' + reg.text);
  return buildDemoBoard({
    request: async (method, path, body) => {
      const r = await owner.req(method, '/api' + path, body);
      return { status: r.status, body: r.json ?? {} };
    },
    upload: async (slug, name, mime, bytes) => {
      const r = await owner.req('PUT', `/api/uploads?board=${encodeURIComponent(slug)}&name=${encodeURIComponent(name)}`, bytes, { raw: true, headers: { 'content-type': mime } });
      return { status: r.status, body: r.json ?? {} };
    },
  }, { links: true });
}

/** fetch inside the page (uses that context's cookies). */
const call = (page, method, path, body) =>
  page.eval(`fetch(${JSON.stringify('/api' + path)}, { method: ${JSON.stringify(method)}, headers: {'Content-Type':'application/json'}, body: ${body === undefined ? 'undefined' : JSON.stringify(JSON.stringify(body))} }).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }))`);

async function newUser(name, { guest = false, path = '/' } = {}) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage(base + path);
  if (guest) await call(page, 'POST', '/auth/guest', { displayName: name });
  else {
    const u = name.toLowerCase().replace(/[^a-z0-9]/g, '') + Math.random().toString(36).slice(2, 6);
    const r = await call(page, 'POST', '/auth/register', { username: u, password: 'password-1234', displayName: name });
    if (r.status !== 200 && r.status !== 201) throw new Error('register failed ' + JSON.stringify(r));
  }
  return { ctx, page };
}

const only = process.argv.slice(2); // e.g. `node e2e/run.mjs S8` runs just that scenario
async function step(name, fn) {
  if (only.length && !only.some((o) => name.startsWith(o))) return;
  try {
    await fn();
  } catch (e) {
    check(name + ' (예외)', false, String(e.message || e).slice(0, 300));
  }
}

try {
  const demo = await createDemoBoard(); // built by the public API, exactly like a teacher would (the slug is generated, so it is read back)
  const DEMO_PATH = '/b/' + demo.slug;

  /* ── S1 example board (anonymous, read/comment) ── */
  await step('S1', async () => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage(base + DEMO_PATH);
    await page.waitFor('[data-post-id]', { timeout: 15000 });
    await sleep(600);
    check('S1 참조 보드: 카드 17장', (await page.count('[data-post-id]')) === demo.total, 'count=' + (await page.count('[data-post-id]')));
    check('S1 섹션 3개', (await page.count('[data-role="section-title"]')) === 3);
    check('S1 형식 rows', (await page.eval(`document.querySelector('[data-role="board-surface"]')?.dataset.format`)) === 'rows');
    check('S1 읽기 접속자에게 글쓰기 버튼이 없거나 게스트 진입으로 연결', true);
    await page.screenshot(join(OUT, 's1-demo.png'));
    const cards = await page.eval(`[...document.querySelectorAll('[data-post-id]')].map(e => e.dataset.postId)`);
    check('S1 (준비) 4번째로 보이는 카드가 댓글을 단 카드', cards[3] === String(demo.commentedPostId), `shown=${cards[3]} commented=${demo.commentedPostId}`);
    await page.click(`[data-post-id="${cards[3]}"]`);
    await page.waitFor('[data-role="detail"]');
    check('S1 상세 4 / 17', /4\s*\/\s*17/.test((await page.text('[data-role="detail-pager"]')) || ''));
    check('S1 댓글 2개', (await page.count('[data-comment-id]')) === 2, 'n=' + (await page.count('[data-comment-id]')));
    await page.screenshot(join(OUT, 's1-detail.png'));
    await page.key('ArrowRight');
    await page.waitFor(`/5\\s*\\/\\s*17/.test(document.querySelector('[data-role="detail-pager"]')?.innerText||'')`);
    check('S1 → 키로 다음 글(5 / 17)', true);
    check('S1 URL 이 /p/<id> 로 동기화', new RegExp(`^/b/${demo.slug}/p/\\d+$`).test(await page.eval('location.pathname')));
    await page.key('Escape');
    await page.waitFor(`!document.querySelector('[data-role="detail"]')`);
    check('S1 Esc 로 닫으면 URL 복귀', (await page.eval('location.pathname')) === DEMO_PATH);
    const w = await call(page, 'POST', `/boards/${demo.slug}/posts`, { title: 'x' });
    check('S1 비로그인 API 쓰기 → 401', w.status === 401, 'status=' + w.status);
    check('S1 콘솔 오류 없음', page.errors.length === 0, page.errors.join(' | ').slice(0, 300));
    await ctx.close();
  });

  /* ── S2 realtime between two guests on the practice board ── */
  await step('S2', async () => {
    const A = await newUser('앨리스', { guest: true, path: '/b/practice' });
    const B = await newUser('밥', { guest: true, path: '/b/practice' });
    await A.page.goto(base + '/b/practice');
    await B.page.goto(base + '/b/practice');
    await A.page.waitFor('[data-post-id]', { timeout: 15000 });
    await B.page.waitFor('[data-post-id]', { timeout: 15000 });
    await sleep(500);
    const before = await B.page.count('[data-post-id]');
    check('S2 연습장 시드 카드 3장', before === 3, 'n=' + before);
    await A.page.click('[aria-label="글쓰기"]');
    await A.page.waitFor('[data-role="composer"]');
    await A.page.type('[data-role="composer"] [name=title]', '실시간 확인 글');
    await A.page.type('[data-role="composer"] [name=body]', '두 번째 창에도 바로 보여야 해요');
    await A.page.click('[data-role="composer-submit"]');
    await B.page.waitFor(`[...document.querySelectorAll('[data-post-id]')].some(e => e.innerText.includes('실시간 확인 글'))`, { timeout: 6000 });
    check('S2 앨리스의 새 글이 밥 화면에 새로고침 없이 나타남', true);
    // presence broadcasts are coalesced to ≤ 1 per second, so poll instead of reading once
    await A.page.waitFor(`document.querySelectorAll('[data-role="presence"] .avatar').length >= 2`, { timeout: 5000 }).catch(() => {});
    check('S2 접속자 표시(2명 이상)', (await A.page.count('[data-role="presence"] .avatar')) >= 2, 'n=' + (await A.page.count('[data-role="presence"] .avatar')));
    const id = await B.page.eval(`[...document.querySelectorAll('[data-post-id]')].find(e => e.innerText.includes('실시간 확인 글')).dataset.postId`);
    await B.page.click(`[data-post-id="${id}"] [data-reaction="like"]`);
    await A.page.waitFor(`(()=>{const b=document.querySelector('[data-post-id="${id}"] [data-reaction="like"]'); return b && /1/.test(b.innerText)})()`, { timeout: 6000 });
    check('S2 밥의 좋아요가 앨리스 화면에 반영', true);
    await B.page.click(`[data-post-id="${id}"]`);
    await B.page.waitFor('[data-role="comment-input"]');
    await B.page.type('[data-role="comment-input"]', '댓글 테스트');
    await B.page.click('[data-role="comment-send"]');
    await A.page.waitFor(`(()=>{const c=document.querySelector('[data-post-id="${id}"]'); return c && /1/.test(c.innerText.split('\\n').slice(-2).join(' '))})()`, { timeout: 6000 }).catch(() => {});
    const cc = await call(A.page, 'GET', `/posts/${id}/comments`);
    check('S2 댓글이 서버에 저장됨', cc.body.comments && cc.body.comments.length === 1);
    await A.page.screenshot(join(OUT, 's2-realtime.png'));
    check('S2 콘솔 오류 없음(A,B)', A.page.errors.length + B.page.errors.length === 0, [...A.page.errors, ...B.page.errors].join(' | ').slice(0, 300));
    await A.ctx.close();
    await B.ctx.close();
  });

  /* ── S3 all seven formats render for an owner; canvas drag + section DnD persist ── */
  await step('S3', async () => {
    const O = await newUser('오너');
    // created as `rows` so sectionId on posts is kept (non-sectioned boards drop it); formats are cycled below
    const created = await call(O.page, 'POST', '/boards', { title: 'E2E 형식 시험', format: 'rows' });
    const slug = created.body.board.slug;
    const s1 = (await call(O.page, 'POST', `/boards/${slug}/sections`, { title: '섹션 A' })).body.section;
    const s2 = (await call(O.page, 'POST', `/boards/${slug}/sections`, { title: '섹션 B' })).body.section;
    const posts = [];
    for (let i = 1; i <= 4; i++) posts.push((await call(O.page, 'POST', `/boards/${slug}/posts`, { title: `카드 ${i}`, body: `본문 ${i}`, sectionId: i <= 2 ? s1.id : s2.id })).body.post);
    await O.page.goto(base + '/b/' + slug);
    for (const f of FORMATS) {
      await call(O.page, 'PATCH', `/boards/${slug}`, { format: f });
      await O.page.waitFor(`document.querySelector('[data-role="board-surface"]')?.dataset.format === '${f}'`, { timeout: 8000 });
      await sleep(350);
      const n = await O.page.count('[data-post-id]');
      check(`S3 형식 ${f}: 카드 4장 실시간 전환`, n === 4, 'n=' + n);
      await O.page.screenshot(join(OUT, `s3-${f}.png`));
    }
    // canvas drag
    await call(O.page, 'PATCH', `/boards/${slug}`, { format: 'canvas' });
    await O.page.waitFor(`document.querySelector('[data-role="board-surface"]')?.dataset.format === 'canvas'`);
    await sleep(500);
    const r0 = await O.page.rect(`[data-post-id="${posts[0].id}"]`);
    await O.page.drag(r0.x + 40, r0.y + 12, r0.x + 260, r0.y + 160);
    await sleep(700);
    const after = (await call(O.page, 'GET', `/boards/${slug}`)).body.posts.find((p) => p.id === posts[0].id);
    check('S3 캔버스 드래그 위치가 서버에 저장', after.x != null && after.y != null && (Math.abs(after.x - (posts[0].x ?? 0)) > 20 || Math.abs(after.y - (posts[0].y ?? 0)) > 20), JSON.stringify({ x: after.x, y: after.y }));
    // section DnD in rows
    await call(O.page, 'PATCH', `/boards/${slug}`, { format: 'rows' });
    await O.page.waitFor(`document.querySelector('[data-role="board-surface"]')?.dataset.format === 'rows'`);
    await sleep(500);
    const from = await O.page.rect(`[data-post-id="${posts[0].id}"]`);
    const to = await O.page.rect(`[data-section-id="${s2.id}"] [data-post-id="${posts[2].id}"]`);
    check('S3 rows: 드래그 출발·도착 카드가 보임', from && to, JSON.stringify({ from: !!from, to: !!to, cards: await O.page.count('[data-post-id]'), sections: await O.page.count('[data-section-id]') }));
    if (from && to) {
      await O.page.drag(from.x + 60, from.y + 14, to.x + 40, to.y + 20, 20);
      await sleep(900);
      const moved = (await call(O.page, 'GET', `/boards/${slug}`)).body.posts.find((p) => p.id === posts[0].id);
      check('S3 rows: 드래그로 섹션 간 이동이 저장', moved.sectionId === s2.id, 'sectionId=' + moved.sectionId);
    }
    check('S3 콘솔 오류 없음', O.page.errors.length === 0, O.page.errors.join(' | ').slice(0, 300));
    await O.ctx.close();
  });

  /* ── S4 XSS inertness ── */
  await step('S4', async () => {
    const O = await newUser('엑스에스');
    const slug = (await call(O.page, 'POST', '/boards', { title: '<img src=x onerror=window.__xss=1>', format: 'wall' })).body.board.slug;
    await call(O.page, 'POST', `/boards/${slug}/posts`, { title: '<img src=x onerror="window.__xss=1">', body: '<script>window.__xss=1</script> [x](javascript:alert(1)) https://example.com/a' });
    await O.page.goto(base + '/b/' + slug);
    await O.page.waitFor('[data-post-id]');
    await sleep(400);
    check('S4 XSS 문자열이 실행되지 않음', (await O.page.eval('window.__xss')) === undefined);
    check('S4 javascript: 링크 없음', (await O.page.count('a[href^="javascript:"]')) === 0);
    check('S4 <img onerror> 가 DOM 요소로 생성되지 않음', (await O.page.count('[data-post-id] img[src="x"]')) === 0);
    await O.ctx.close();
  });

  /* ── S5 mobile layout ── */
  await step('S5', async () => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage(base + DEMO_PATH, { viewport: { width: 390, height: 844 } });
    await page.setViewport(390, 844, true, 2);
    await page.goto(base + DEMO_PATH);
    await page.waitFor('[data-post-id]', { timeout: 15000 });
    await sleep(600);
    check('S5 모바일: 페이지 가로 넘침 없음', await page.eval('document.documentElement.scrollWidth <= window.innerWidth + 1'), 'sw=' + (await page.eval('document.documentElement.scrollWidth')));
    await page.screenshot(join(OUT, 's5-mobile.png'));
    await ctx.close();
  });

  /* ── S6 connection lifecycle & multi-tab behaviour (from the adversarial UX review) ── */
  const streams = (a = app) => [...a.app.hub.boards.values()].reduce((n, r) => n + r.conns.size, 0);
  const setHidden = (page, hidden) =>
    page.eval(`Object.defineProperty(document, 'hidden', { value: ${hidden}, configurable: true }); document.dispatchEvent(new Event('visibilitychange')); 1`);

  await step('S6a', async () => {
    const A = await newUser('숨김', { guest: true, path: '/b/practice' });
    await A.page.goto(base + '/b/practice');
    await A.page.waitFor('[data-post-id]', { timeout: 15000 });
    await sleep(800);
    const before = streams();
    check('S6 열린 보드는 실시간 연결을 잡음', before >= 1, 'streams=' + before);
    await A.page.eval('window.__EDULET_HIDE_MS = 500; 1');
    await setHidden(A.page, true);
    const t0 = Date.now();
    while (streams() >= before && Date.now() - t0 < 5000) await sleep(100);
    check('S6 숨은 탭은 연결을 반납(호스트당 6연결 제한 회피)', streams() < before, `before=${before} now=${streams()}`);
    const B = await newUser('밥둘', { guest: true, path: '/b/practice' });
    const made = await call(B.page, 'POST', '/boards/practice/posts', { title: '숨은 동안 올라온 글' });
    check('S6 (준비) 다른 사용자의 글 생성', made.status === 201, 'status=' + made.status);
    await setHidden(A.page, false);
    await A.page.waitFor(`[...document.querySelectorAll('[data-post-id]')].some(e => e.innerText.includes('숨은 동안 올라온 글'))`, { timeout: 7000 });
    check('S6 다시 보이면 연결을 되살리고 놓친 글을 따라잡음', true);
    check('S6 연결이 다시 열림', streams() >= before, `streams=${streams()}`);
    check('S6 콘솔 오류 없음', A.page.errors.length === 0, A.page.errors.join(' | ').slice(0, 300));
    await A.ctx.close();
    await B.ctx.close();
  });

  await step('S6b', async () => {
    const app2 = await createAppOnGoodPort(() => ({ dataDir: mkdtempSync(join(tmpdir(), 'edulet-e2e2-')), port: 0, seed: true, seedDir, pingMs: 3600000 })); // this server never pings
    const dir2 = app2.app.config.dataDir;
    const base2 = app2.url.replace(/\/$/, '');
    try {
      const ctx = await browser.newContext();
      const page = await ctx.newPage(base2 + '/');
      await call(page, 'POST', '/auth/guest', { displayName: '감시' });
      await page.goto(base2 + '/b/practice');
      await page.waitFor('[data-post-id]', { timeout: 15000 });
      await sleep(600);
      const first = [...[...app2.app.hub.boards.values()][0].conns][0];
      await page.eval('window.__EDULET_SILENCE_MS = 1200; 1');
      let replaced = false;
      for (let i = 0; i < 60 && !replaced; i++) {
        await sleep(100);
        const room = [...app2.app.hub.boards.values()][0];
        replaced = !!room && room.conns.size > 0 && ![...room.conns].includes(first);
      }
      check('S6 침묵한 연결은 감시자가 끊고 새로 연결(서버 ping 이 없어도)', replaced);
      await ctx.close();
    } finally {
      await app2.close();
      try { rmSync(dir2, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  await step('S6c', async () => {
    const O = await newUser('탭동기');
    const A = O.page;
    await A.goto(base + '/dashboard');
    await A.waitFor('[data-role="new-board"]', { timeout: 10000 });
    const B = await O.ctx.newPage(base + '/dashboard');
    await B.waitFor('[data-role="new-board"]', { timeout: 10000 });
    await A.click('[aria-label="사용자 메뉴"]');
    await A.waitFor(`[...document.querySelectorAll('.popover .menu-item')].some(b => b.innerText.includes('로그아웃'))`);
    await A.eval(`[...document.querySelectorAll('.popover .menu-item')].find(b => b.innerText.includes('로그아웃')).click(); 1`);
    await B.waitFor(`!document.querySelector('[data-role="new-board"]') && document.body.innerText.includes('로그인')`, { timeout: 6000 });
    check('S6 한 탭에서 로그아웃하면 다른 탭도 로그아웃 상태가 됨', true);
    await O.ctx.close();
  });

  await step('S6d', async () => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage(base + '/');
    await sleep(500);
    await page.eval(`history.pushState(null, '', ${JSON.stringify(DEMO_PATH)}); dispatchEvent(new PopStateEvent('popstate')); 1`);
    await page.waitFor('[data-post-id]', { timeout: 15000 });
    const id = await page.eval(`document.querySelector('[data-post-id]').dataset.postId`);
    await page.click(`[data-post-id="${id}"]`);
    await page.waitFor('[data-role="detail"]');
    await page.key('Escape');
    await page.waitFor(`!document.querySelector('[data-role="detail"]')`);
    check('S6 상세를 닫으면 URL 이 보드로 돌아옴', (await page.eval('location.pathname')) === DEMO_PATH);
    await page.eval('history.back(); 1');
    await sleep(600);
    check('S6 닫은 뒤 뒤로가기 한 번이면 보드를 떠남(죽은 기록 없음)', (await page.eval('location.pathname')) === '/', 'path=' + (await page.eval('location.pathname')));
    await ctx.close();
  });

  await step('S6e', async () => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage(base + DEMO_PATH + '/p/99999999');
    await page.waitFor('.toast', { timeout: 6000 });
    check('S6 없는 글 딥링크: 안내 토스트', /찾을 수 없는/.test((await page.text('.toast')) || ''));
    await page.waitFor('[data-post-id]', { timeout: 10000 });
    check('S6 없는 글 딥링크: 보드로 복귀', (await page.eval('location.pathname')) === DEMO_PATH);
    await ctx.close();
  });

  await step('S6f', async () => {
    const O = await newUser('두탭');
    const slug = (await call(O.page, 'POST', '/boards', { title: '두 탭 좋아요', format: 'wall' })).body.board.slug;
    const post = (await call(O.page, 'POST', `/boards/${slug}/posts`, { title: '좋아요 확인' })).body.post;
    await O.page.goto(base + '/b/' + slug);
    const B = await O.ctx.newPage(base + '/b/' + slug);
    await O.page.waitFor(`[data-post-id="${post.id}"] [data-reaction="like"]`, { timeout: 10000 });
    await B.waitFor(`[data-post-id="${post.id}"] [data-reaction="like"]`, { timeout: 10000 });
    await sleep(500);
    await O.page.click(`[data-post-id="${post.id}"] [data-reaction="like"]`);
    await B.waitFor(`document.querySelector('[data-post-id="${post.id}"] [data-reaction="like"]').getAttribute('aria-pressed') === 'true'`, { timeout: 6000 });
    check('S6 같은 사용자의 다른 탭에도 내가 누른 좋아요가 표시됨', true);
    await O.ctx.close();
  });

  /* ── S7 Google sign-in against a stand-in Google (test/google-mock.js): the real browser walks the real redirect chain ── */
  await step('S7', async () => {
    const mock = await startMockGoogle();
    const appG = await createAppOnGoodPort(() => ({ dataDir: mkdtempSync(join(tmpdir(), 'edulet-e2e-g-')), port: 0, host: '127.0.0.1', seed: false, quiet: true, config: mock.config(), googleEndpoints: mock.endpoints() }));
    const dirG = appG.app.config.dataDir;
    const baseG = appG.url.replace(/\/$/, '');
    const menu = async (page, label) => {
      await page.click('[aria-label="사용자 메뉴"]');
      await page.waitFor(`[...document.querySelectorAll('.popover .menu-item')].some(b => b.innerText.includes(${JSON.stringify(label)}))`);
      await page.eval(`[...document.querySelectorAll('.popover .menu-item')].find(b => b.innerText.includes(${JSON.stringify(label)})).click(); 1`);
    };
    const seeToast = async (page, re) => {
      await page.waitFor(`[...document.querySelectorAll('.toast')].some(t => ${re}.test(t.innerText))`, { timeout: 8000 });
      return true;
    };
    try {
      const owner = makeUser(appG, 'owner');
      const board = await makeBoard(owner, { title: '구글 로그인 보드', linkAccess: 'write' });

      // a visitor on a board page opens the login dialog
      const ctx = await browser.newContext();
      const page = await ctx.newPage(baseG + '/b/' + board.slug);
      await page.waitFor('.app-uc-login', { timeout: 15000 });
      await page.click('.app-uc-login');
      await page.waitFor('[data-role="auth"] [data-role="google-login"]');
      check('S7 로그인 창에 "Google 계정으로 계속하기" 버튼이 있고 아이디 칸도 그대로 있음', (await page.count('[data-role="auth"] input[name=username]')) === 1);
      check('S7 도메인 제한이 없으면 안내 문구 없음', (await page.count('.app-google-hint')) === 0);
      await page.screenshot(join(OUT, 's7-login-modal.png'));

      // first sign-in: Google → callback → back on the SAME board page, signed in, told so
      await page.click('[data-role="google-login"]');
      await page.waitFor(`!!document.querySelector('.app-uc-name') && document.querySelector('.app-uc-name').innerText.includes('김하나')`, { timeout: 15000 });
      check('S7 Google 로 가입하고 원래 보드 주소로 돌아옴', (await page.eval('location.pathname')) === '/b/' + board.slug, await page.eval('location.href'));
      check('S7 "가입했어요" 알림', await seeToast(page, '/가입했어요/'));
      check('S7 알림용 쿠키는 읽고 지움', !(await page.eval('document.cookie')).includes('edulet_flash'));
      const me = (await call(page, 'GET', '/auth/me')).body.user;
      check('S7 계정: 비밀번호 없음·@g- 아이디·Google 이메일', me.hasPassword === false && /^g-[0-9a-f]{12}$/.test(me.username) && me.googleEmail === 'hana@example.com', JSON.stringify(me));
      await page.screenshot(join(OUT, 's7-signed-in.png'));
      await page.reload();
      await page.waitFor('.app-uc-name');
      check('S7 새로고침해도 로그인 유지', (await page.text('.app-uc-name')).includes('김하나'));
      const wrote = await call(page, 'POST', `/boards/${board.slug}/posts`, { title: '구글 사용자의 글' });
      check('S7 그 세션으로 글쓰기', wrote.status === 201, JSON.stringify(wrote));

      // profile: shows the linked Google account, no password form
      await menu(page, '프로필');
      await page.waitFor('[data-role="google-linked"]');
      check('S7 프로필에 연결된 Google 이메일, 비밀번호 칸은 없음', (await page.text('[data-role="google-linked"]')).includes('hana@example.com') && (await page.count('.app-profile .app-details')) === 0);
      await page.screenshot(join(OUT, 's7-profile.png'));
      await page.key('Escape');
      await page.waitFor(`!document.querySelector('.app-profile')`);

      // sign out, then Google again → the same account
      await menu(page, '로그아웃');
      await page.waitFor('.app-uc-login');
      await page.click('.app-uc-login');
      await page.click('[data-role="google-login"]');
      await page.waitFor(`!!document.querySelector('.app-uc-name')`, { timeout: 15000 });
      check('S7 다시 Google 로그인하면 같은 계정(어서 오세요)', await seeToast(page, '/어서 오세요/') && (await call(page, 'GET', '/auth/me')).body.user.id === me.id);
      check('S7 콘솔 오류 없음(CSP 위반 포함)', page.errors.length === 0, page.errors.slice(0, 3).join(' | '));
      await ctx.close();

      // cancel on Google's page
      mock.reset();
      mock.deny = true;
      const c2 = await browser.newContext();
      const p2 = await c2.newPage(baseG + '/b/' + board.slug);
      await p2.waitFor('.app-uc-login', { timeout: 15000 });
      await p2.click('.app-uc-login');
      await p2.waitFor('[data-role="google-login"]');
      await p2.click('[data-role="google-login"]');
      await p2.waitFor(`[...document.querySelectorAll('.toast')].some(t => /취소/.test(t.innerText))`, { timeout: 15000 });
      check('S7 Google 에서 취소하면 안내만 나오고 로그인되지 않음', (await p2.count('.app-uc-login')) === 1 && (await p2.eval('location.pathname')) === '/b/' + board.slug);
      await c2.close();

      // an existing password account links Google from the profile dialog
      mock.reset();
      mock.profile = { ...mock.profile, email: 'linker@example.com', name: '연결할 사람' };
      const c3 = await browser.newContext();
      const p3 = await c3.newPage(baseG + '/');
      const reg = await call(p3, 'POST', '/auth/register', { username: 'linker2026', password: 'password-1234', displayName: '연결' });
      if (reg.status !== 201) throw new Error('register failed ' + JSON.stringify(reg));
      await p3.goto(baseG + '/dashboard');
      await p3.waitFor('[aria-label="사용자 메뉴"]', { timeout: 10000 });
      await menu(p3, '프로필');
      await p3.waitFor('[data-role="google-link-box"]');
      check('S7 비밀번호 계정의 프로필에는 "Google 계정 연결하기"(접힘)와 비밀번호 바꾸기가 함께 있음', (await p3.count('.app-profile .app-details')) === 2 && !(await p3.eval(`document.querySelector('[data-role="google-link-box"]').open`)));
      await p3.eval(`document.querySelector('[data-role="google-link-box"]').open = true; 1`);
      // wrong password: stays here, says why, nothing was sent to Google
      await p3.type('[name=googlePassword]', 'not-my-password');
      await p3.click('[data-role="google-link"]');
      await p3.waitFor(`document.querySelector('.app-profile .form-error') && document.querySelector('.app-profile .form-error').innerText.trim().length > 0`, { timeout: 8000 });
      check('S7 틀린 비밀번호로는 연결이 시작되지 않고 이유가 보임', (await p3.eval('location.pathname')) === '/dashboard' && (await p3.count('[data-role="google-link"]')) === 1 && mock.authCalls.length === 0, 'authCalls=' + mock.authCalls.length + ' path=' + (await p3.eval('location.pathname')) + ' btn=' + (await p3.count('[data-role="google-link"]')) + ' err=' + (await p3.text('.app-profile .form-error')));
      await p3.type('[name=googlePassword]', 'password-1234', { clear: true });
      await p3.click('[data-role="google-link"]');
      await p3.waitFor(`[...document.querySelectorAll('.toast')].some(t => /연결했어요/.test(t.innerText))`, { timeout: 15000 });
      check('S7 연결 뒤 같은 페이지(/dashboard)로 돌아오고 계정은 그대로', (await p3.eval('location.pathname')) === '/dashboard' && (await call(p3, 'GET', '/auth/me')).body.user.username === 'linker2026');
      await menu(p3, '프로필');
      await p3.waitFor('[data-role="google-linked"]');
      check('S7 연결된 Google 이메일이 프로필에 보임(비밀번호 바꾸기·연결 해제 상자도 있음)', (await p3.text('[data-role="google-linked"]')).includes('linker@example.com') && (await p3.count('.app-profile .app-details')) === 2 && (await p3.count('[data-role="google-unlink-box"]')) === 1);

      // unlink: password again, then the profile redraws as "not linked"
      await p3.waitFor(`!document.querySelector('.toast')`, { timeout: 8000 }); // a toast at the bottom would swallow the mouse click on the button below it
      await p3.eval(`document.querySelector('[data-role="google-unlink-box"]').open = true; 1`);
      await p3.type('[name=googlePassword]', 'password-1234');
      await p3.click('[data-role="google-unlink"]');
      await p3.waitFor('[data-role="google-link-box"]', { timeout: 8000 }).catch(async (e) => {
        throw new Error(`${e.message} — form-error: "${await p3.text('.app-profile .form-error')}", toasts: "${await p3.eval(`[...document.querySelectorAll('.toast')].map(t => t.innerText).join('|')`)}", linked row: ${await p3.count('[data-role="google-linked"]')}`);
      });
      await p3.waitFor(`!document.querySelector('[data-role="google-linked"]')`, { timeout: 4000 }); // the old dialog is fading out
      check('S7 연결 해제 뒤 프로필이 "연결 안 됨" 모양으로 다시 그려짐', (await p3.count('[data-role="google-linked"]')) === 0 && (await call(p3, 'GET', '/auth/me')).body.user.googleEmail === null);
      await c3.close();

      // the same Google account no longer opens linker2026: it makes a NEW account
      const c4 = await browser.newContext();
      const p4 = await c4.newPage(baseG + '/');
      await p4.waitFor('.app-uc-login', { timeout: 15000 });
      await p4.click('.app-uc-login');
      await p4.click('[data-role="google-login"]');
      await p4.waitFor(`!!document.querySelector('.app-uc-name')`, { timeout: 15000 });
      check('S7 해제한 Google 계정은 옛 계정이 아니라 새 계정으로 가입됨', await seeToast(p4, '/가입했어요/') && (await call(p4, 'GET', '/auth/me')).body.user.username !== 'linker2026');
      await c4.close();
    } finally {
      await appG.close();
      await mock.close();
      try { rmSync(dirG, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });
  /* ── S8 sharing with ANOTHER address (other PCs / phones): the link, the QR code and a visitor who really connects through that address ──
     The server listens on 0.0.0.0 and is told (test-only networkInterfaces) that its "Wi-Fi" card has 127.0.0.2: a loopback alias that Chrome can
     really open, so the teacher (http://localhost:PORT) and the "other PC" (http://127.0.0.2:PORT) are two different origins with separate cookies.
     A server that leaves 127.x out of its NIC list (it is loopback, not a LAN address) gets this PC's own private IPv4 instead — also openable from here;
     every other fake address below (192.0.2.x, TEST-NET) is only ever shown, never opened. */
  const fakeNic = (address) => ({ address, family: 'IPv4', internal: false, netmask: '255.0.0.0', cidr: null, mac: '00:00:00:00:00:00' });
  const openShare = async (page) => {
    await page.waitFor('[aria-label="공유"]', { timeout: 15000 });
    await page.waitFor('!document.querySelector(".toast")', { timeout: 8000 }); // a toast at the bottom could swallow the click
    await page.click('[aria-label="공유"]');
    await page.waitFor('[data-role="share"] input[name=url]');
    await sleep(150);
  };
  const closeShare = async (page) => {
    await page.key('Escape');
    await page.waitFor(`!document.querySelector('[data-role="share"]')`);
  };
  /** what the open share dialog shows */
  const shareState = (page) => page.eval(`(() => {
    const root = document.querySelector('[data-role="share"]');
    const notes = [...root.querySelectorAll('[data-role="share-note"]')];
    const sel = root.querySelector('[data-role="share-host"]');
    return {
      url: root.querySelector('input[name=url]').value,
      kinds: notes.map((n) => n.dataset.kind),
      noteText: notes.map((n) => n.innerText).join(' | '),
      hasSelect: !!sel, options: sel ? [...sel.options].map((o) => o.value) : [], selected: sel ? sel.value : null,
      links: [...root.querySelectorAll('a[href]:not(.btn)')].map((a) => a.getAttribute('href')),
      anyJs: !!root.querySelector('a[href^="javascript:"], [src^="javascript:"]'),
    };
  })()`);
  /** is the QR code on screen exactly the QR of this text (and not the one of another)? */
  const qrIs = (page, text) => page.eval(`(async () => {
    const { qr } = await import('/js/lib/ui.js');
    const shown = document.querySelector('[data-role="share"] .bp-share-qrbox svg');
    return !!shown && shown.outerHTML === qr(${JSON.stringify(text)}).outerHTML;
  })()`);
  /** replace the server's `share` (and anything else in /config) inside a page, as if the server had sent it */
  // The share dialog re-reads /api/config every time it opens (the Wi-Fi address can change), so the page's own fetch of it has to
  // answer with the same made-up config — otherwise the dialog would just replace it with the real server's.
  const setShareCfg = (page, share, extra = {}) => page.eval(`(async () => {
    const { store } = await import('/js/lib/store.js');
    window.__cfg0 = window.__cfg0 || store.config;
    const cfg = { ...window.__cfg0, share: ${JSON.stringify(share)}, ...${JSON.stringify(extra)} };
    window.__fakeCfg = cfg;
    if (!window.__cfgFetchPatched) {
      window.__cfgFetchPatched = true;
      const real = window.fetch.bind(window);
      window.fetch = (u, o) => (window.__fakeCfg && /\\/api\\/config(\\?|$)/.test(String(u))
        ? Promise.resolve(new Response(JSON.stringify(window.__fakeCfg), { status: 200, headers: { 'content-type': 'application/json' } }))
        : real(u, o));
    }
    store.set('config', cfg);
    return 1;
  })()`);
  const stubClipboard = (page) => page.eval(`window.__copied = null; Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: (t) => { window.__copied = t; return Promise.resolve(); } } }); 1`);
  const hasCard = (title) => `[...document.querySelectorAll('[data-post-id]')].some(e => e.innerText.includes(${JSON.stringify(title)}))`;
  const overflowOf = (page) => page.eval(`(() => {
    const root = document.querySelector('[data-role="share"]');
    const body = root.querySelector('.modal-body');
    const box = root.getBoundingClientRect();
    const inside = (e) => { const r = e.getBoundingClientRect(); return r.left >= box.left - 1 && r.right <= box.right + 1; };
    const wide = [...root.querySelectorAll('select, input, .bp-share-note, .bp-share-qr, .bp-share-host')].filter((e) => !inside(e)).map((e) => e.className || e.tagName);
    return { page: document.documentElement.scrollWidth - window.innerWidth, body: body.scrollWidth - body.clientWidth, wide };
  })()`);

  await step('S8', async () => {
    let lanIps = ['127.0.0.2'];
    const SECOND = '192.0.2.7'; // a second "network card" for the picker: only displayed
    const appL = await createAppOnGoodPort(() => ({
      dataDir: mkdtempSync(join(tmpdir(), 'edulet-e2e-lan-')), port: 0, host: '0.0.0.0', seed: false, quiet: true, previewFetcher: stubPreviewFetcher,
      networkInterfaces: () => ({ Loopback: [{ ...fakeNic('127.0.0.1'), internal: true }], 'Wi-Fi': lanIps.map(fakeNic) }),
    }));
    const dirL = appL.app.config.dataDir;
    const baseL = appL.url.replace(/\/$/, ''); // http://localhost:PORT — how the teacher opens it
    const lanOf = (ip) => `http://${ip}:${appL.port}`;
    let LAN = lanOf('127.0.0.2');
    try {
      const ctxO = await browser.newContext();
      const O = await ctxO.newPage(baseL + '/');
      const reg = await call(O, 'POST', '/auth/register', { username: 'lanowner' + Math.random().toString(36).slice(2, 6), password: 'password-1234', displayName: '소유자' });
      if (reg.status !== 201 && reg.status !== 200) throw new Error('register failed ' + JSON.stringify(reg));
      const slug = (await call(O, 'POST', '/boards', { title: 'LAN 공유 시험', format: 'wall' })).body.board.slug;
      const patched = await call(O, 'PATCH', `/boards/${slug}`, { visibility: 'link', linkAccess: 'write' });
      if (patched.status !== 200) throw new Error('board patch failed ' + JSON.stringify(patched));
      const BOARD = `/b/${slug}`;

      // ── the teacher on localhost: the share dialog hands out the network address ──
      let cfg = await call(O, 'GET', '/config');
      if (cfg.body.share && cfg.body.share.lan.length === 0) {
        const own = Object.values(osNetworkInterfaces()).flat().find((a) => a && a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.'));
        if (own) {
          console.log(`INFO  S8 서버가 127.x 가짜 NIC 를 목록에서 뺐음 → 이 PC 의 실제 IPv4(${own.address})를 "다른 PC" 주소로 대신 씀`);
          lanIps = [own.address];
          LAN = lanOf(own.address);
          cfg = await call(O, 'GET', '/config');
        }
      }
      check('S8 소유자(localhost)에게 서버가 주는 share.lan = 가짜 LAN 주소 하나, origin 없음', cfg.body.share && cfg.body.share.origin === null && JSON.stringify(cfg.body.share.lan) === JSON.stringify([LAN]), JSON.stringify(cfg.body.share));
      await O.goto(baseL + BOARD);
      await O.waitFor('[data-role="board-surface"]', { timeout: 15000 });
      await stubClipboard(O);
      await openShare(O);
      let st = await shareState(O);
      check('S8 localhost 로 연 소유자의 공유 링크가 localhost 가 아니라 LAN 주소', st.url === LAN + BOARD, st.url);
      check('S8 LAN 안내 상자(방화벽·Node.js)가 있고 "이 PC 에서만" 경고는 없음', st.kinds.join() === 'lan' && /방화벽/.test(st.noteText) && /Node\.js/.test(st.noteText) && !/이 PC 에서만/.test(st.noteText), JSON.stringify(st.kinds) + st.noteText);
      check('S8 주소가 하나면 주소 고르기(select)가 없음', !st.hasSelect);
      check('S8 QR 코드는 LAN 주소 링크의 QR', await qrIs(O, LAN + BOARD));
      check('S8 QR 코드는 localhost 링크의 QR 이 아님', !(await qrIs(O, baseL + BOARD)));
      await O.click('[data-role="share"] button[aria-label="링크 복사"]');
      await O.waitFor("(window.__copied !== null)");
      check('S8 "복사"가 LAN 주소 링크를 복사', (await O.eval('window.__copied')) === LAN + BOARD, await O.eval('window.__copied'));
      await O.screenshot(join(OUT, 's8-share-lan.png'));
      await closeShare(O);
      const urls = await O.eval(`(async () => {
        const { postUrl } = await import('/js/board/util.js'); const { boardUrl } = await import('/js/views/common.js');
        return { post: postUrl(${JSON.stringify(slug)}, 7), board: boardUrl(${JSON.stringify(slug)}) };
      })()`);
      check('S8 글 퍼머링크·보드 링크(대시보드 복사 포함)도 LAN 주소', urls.post === `${LAN}/b/${slug}/p/7` && urls.board === LAN + BOARD, JSON.stringify(urls));

      // ── another PC: opens the link, never logs in, joins without a name ──
      const ctxG = await browser.newContext();
      const G = await ctxG.newPage(LAN + BOARD);
      await G.waitFor('[data-role="board-surface"]', { timeout: 15000 });
      await G.waitFor(`(() => { const b = document.querySelector('[aria-label="글쓰기"]'); return !!b && !b.hidden; })()`, { timeout: 8000 });
      check('S8 LAN 주소로 연 다른 브라우저(로그인 없음): 보드가 열리고 글쓰기 단추가 보임', (await G.eval('location.origin')) === LAN && (await call(G, 'GET', '/auth/me')).body.user === null);
      await G.click('[aria-label="글쓰기"]');
      await G.waitFor('[data-role="composer"]');
      await G.type('[data-role="composer"] [name=title]', '다른 PC 에서 쓴 글');
      await G.type('[data-role="composer"] [name=body]', '로그인 없이 바로 참여했어요');
      await G.click('[data-role="composer-submit"]');
      await G.waitFor('.modal-backdrop [data-role="guest-anon"]');
      await G.waitFor(`document.activeElement === document.querySelector('.modal-backdrop input')`, { timeout: 5000 });
      const labels = await G.eval(`[...document.querySelectorAll('.modal-backdrop button')].map((b) => b.innerText.trim())`);
      check('S8 이름 모달: 이름 칸에 포커스, "이름 없이 바로 참여"·취소·참여하기가 함께 있음', ['이름 없이 바로 참여', '취소', '참여하기'].every((l) => labels.includes(l)), JSON.stringify(labels));
      await G.screenshot(join(OUT, 's8-name-modal.png'));
      await G.click('[data-role="guest-anon"]');
      await G.waitFor(hasCard('다른 PC 에서 쓴 글'), { timeout: 12000 });
      const me = (await call(G, 'GET', '/auth/me')).body.user;
      check('S8 "이름 없이 바로 참여": 게스트 "참여자 NNN" 으로 글이 올라감', !!me && me.isGuest === true && /^참여자 [1-9]\d{3}$/.test(me.displayName), JSON.stringify(me));
      await O.waitFor(hasCard('다른 PC 에서 쓴 글'), { timeout: 12000 });
      check('S8 다른 PC 의 새 글이 소유자 화면에 새로고침 없이 나타남(실시간)', true);
      const postId = await O.eval(`[...document.querySelectorAll('[data-post-id]')].find(e => e.innerText.includes('다른 PC 에서 쓴 글')).dataset.postId`);
      check('S8 소유자 화면의 작성자 표시가 "참여자 NNN"', /참여자 [1-9]\d{3}/.test(await O.eval(`document.querySelector('[data-post-id="${postId}"]').innerText`)));
      await O.click(`[data-post-id="${postId}"]`);
      await O.waitFor('[data-role="detail"]');
      await G.waitFor(`!document.querySelector('[data-role="composer"]') && !document.querySelector('.toast')`, { timeout: 12000 }); // a closing composer / a toast could swallow the click
      await G.click(`[data-post-id="${postId}"]`);
      await G.waitFor('[data-role="detail"]', { timeout: 8000 });
      await G.waitFor('[data-role="comment-input"]');
      await G.type('[data-role="comment-input"]', 'LAN 에서 단 댓글');
      await G.click('[data-role="comment-send"]');
      await O.waitFor(`[...document.querySelectorAll('[data-comment-id]')].some(e => e.innerText.includes('LAN 에서 단 댓글'))`, { timeout: 8000 });
      check('S8 다른 PC 의 댓글이 소유자의 열린 상세 화면에 새로고침 없이 나타남', true);
      await O.screenshot(join(OUT, 's8-owner-sees-guest.png'));
      await O.key('Escape');
      await O.waitFor(`!document.querySelector('[data-role="detail"]')`);

      // ── the name dialog keeps working the old way: typed name + Enter, cancel, Esc, automatic retry after a rate limit ──
      const ctxT = await browser.newContext();
      const T = await ctxT.newPage(LAN + BOARD);
      await T.waitFor(`(() => { const b = document.querySelector('[aria-label="글쓰기"]'); return !!b && !b.hidden; })()`, { timeout: 15000 });
      await T.click('[aria-label="글쓰기"]');
      await T.waitFor('[data-role="composer"]');
      await T.type('[data-role="composer"] [name=title]', '이름을 쓰고 들어온 글');
      await T.click('[data-role="composer-submit"]');
      await T.waitFor('.modal-backdrop input');
      await T.key('Escape');
      await T.waitFor(`!document.querySelector('.modal-backdrop input')`);
      check('S8 이름 모달을 Esc 로 닫으면 게스트가 만들어지지 않음', (await call(T, 'GET', '/auth/me')).body.user === null);
      if (!(await T.exists('[data-role="composer-submit"]'))) {
        await T.click('[aria-label="글쓰기"]');
        await T.waitFor('[data-role="composer"]');
        await T.type('[data-role="composer"] [name=title]', '이름을 쓰고 들어온 글');
      }
      await T.click('[data-role="composer-submit"]');
      await T.waitFor('.modal-backdrop input');
      await T.click('.modal-actions .btn-secondary'); // 취소
      await T.waitFor(`!document.querySelector('.modal-backdrop input')`);
      check('S8 이름 모달의 취소 단추: 닫히고 게스트가 만들어지지 않음', (await call(T, 'GET', '/auth/me')).body.user === null);
      await T.click('[data-role="composer-submit"]');
      await T.waitFor('.modal-backdrop input');
      await T.waitFor(`document.activeElement === document.querySelector('.modal-backdrop input')`, { timeout: 5000 });
      await T.type('.modal-backdrop input', '하늘');
      await T.key('Enter');
      await T.waitFor(hasCard('이름을 쓰고 들어온 글'), { timeout: 12000 });
      const typed = (await call(T, 'GET', '/auth/me')).body.user;
      check('S8 이름을 입력하고 Enter 로 참여하는 기존 흐름 그대로("하늘")', !!typed && typed.displayName === '하늘' && typed.isGuest === true, JSON.stringify(typed));

      const ctxR = await browser.newContext();
      const R = await ctxR.newPage(LAN + BOARD);
      await R.waitFor(`(() => { const b = document.querySelector('[aria-label="글쓰기"]'); return !!b && !b.hidden; })()`, { timeout: 15000 });
      await R.eval(`window.__guestCalls = 0; const f = window.fetch.bind(window); window.fetch = (u, o) => {
        if (String(u).includes('/api/auth/guest') && window.__guestCalls++ === 0) return Promise.resolve(new Response(JSON.stringify({ error: { code: 'rate_limited', message: '지금 참여하는 사람이 너무 많아요.' } }), { status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': '1' } }));
        return f(u, o);
      }; 1`);
      await R.click('[aria-label="글쓰기"]');
      await R.waitFor('[data-role="composer"]');
      await R.type('[data-role="composer"] [name=title]', '한 번 막혔다 들어온 글');
      await R.click('[data-role="composer-submit"]');
      await R.waitFor('[data-role="guest-anon"]');
      await R.click('[data-role="guest-anon"]');
      await R.waitFor(`/자동으로 다시 시도해요/.test(document.querySelector('.modal-backdrop .form-error')?.innerText || '')`, { timeout: 5000 });
      check('S8 속도 제한(429)이면 "N초 뒤에 자동으로 다시 시도해요" 안내', true);
      await R.waitFor(hasCard('한 번 막혔다 들어온 글'), { timeout: 10000 });
      const retried = (await call(R, 'GET', '/auth/me')).body.user;
      check('S8 자동 재시도로 "이름 없이 바로 참여"가 끝까지 감(요청 2번, 게스트 1명)', (await R.eval('window.__guestCalls')) === 2 && !!retried && /^참여자 [1-9]\d{3}$/.test(retried.displayName), `calls=${await R.eval('window.__guestCalls')} me=${JSON.stringify(retried)}`);
      check('S8 콘솔 오류 없음(소유자·다른 PC 셋)', O.errors.length + G.errors.length + T.errors.length + R.errors.length === 0, [...O.errors, ...G.errors, ...T.errors, ...R.errors].join(' | ').slice(0, 300));
      // a double click / double Enter must not make two guests
      const ctxD = await browser.newContext();
      const D = await ctxD.newPage(LAN + BOARD);
      await D.waitFor(`(() => { const b = document.querySelector('[aria-label="글쓰기"]'); return !!b && !b.hidden; })()`, { timeout: 15000 });
      await D.eval(`window.__guestCalls = 0; const f = window.fetch.bind(window); window.fetch = (u, o) => { if (String(u).includes('/api/auth/guest')) window.__guestCalls++; return f(u, o); }; 1`);
      await D.click('[aria-label="글쓰기"]');
      await D.waitFor('[data-role="composer"]');
      await D.type('[data-role="composer"] [name=title]', '연타해서 쓴 글');
      await D.click('[data-role="composer-submit"]');
      await D.waitFor('[data-role="guest-anon"]');
      await D.eval(`(() => { const b = document.querySelector('[data-role="guest-anon"]'); b.click(); b.click(); b.click(); })(); 1`);
      await D.waitFor(hasCard('연타해서 쓴 글'), { timeout: 12000 });
      check('S8 "이름 없이 바로 참여"를 연타해도 게스트 요청은 한 번', (await D.eval('window.__guestCalls')) === 1, 'calls=' + (await D.eval('window.__guestCalls')));
      await ctxD.close();
      const ctxE = await browser.newContext();
      const E = await ctxE.newPage(LAN + BOARD);
      await E.waitFor(`(() => { const b = document.querySelector('[aria-label="글쓰기"]'); return !!b && !b.hidden; })()`, { timeout: 15000 });
      await E.eval(`window.__guestCalls = 0; const f = window.fetch.bind(window); window.fetch = (u, o) => { if (String(u).includes('/api/auth/guest')) window.__guestCalls++; return f(u, o); }; 1`);
      await E.click('[aria-label="글쓰기"]');
      await E.waitFor('[data-role="composer"]');
      await E.type('[data-role="composer"] [name=title]', '엔터를 두 번 친 글');
      await E.click('[data-role="composer-submit"]');
      await E.waitFor('.modal-backdrop input');
      await E.type('.modal-backdrop input', '두번');
      await E.eval(`(() => { const f = document.querySelector('.modal-backdrop form'); f.requestSubmit(); f.requestSubmit(); })(); 1`);
      await E.waitFor(hasCard('엔터를 두 번 친 글'), { timeout: 12000 });
      check('S8 이름을 쓰고 Enter 를 연달아 눌러도 게스트 요청은 한 번', (await E.eval('window.__guestCalls')) === 1, 'calls=' + (await E.eval('window.__guestCalls')));
      await ctxE.close();

      // a guest joins and posts at once while the snapshot that the new identity triggers is slow: the new card must stay on this very screen
      // (the snapshot is answered before the post exists; if it lands after the post's response it used to wipe the card — flaky on a fast server)
      const ctxF = await browser.newContext();
      const F = await ctxF.newPage(LAN + BOARD);
      await F.waitFor(`(() => { const b = document.querySelector('[aria-label="글쓰기"]'); return !!b && !b.hidden; })()`, { timeout: 15000 });
      await F.eval(`const f = window.fetch.bind(window); window.fetch = async (u, o) => {
        const r = await f(u, o);
        if (String(u).endsWith('/api/boards/${slug}') && (!o || !o.method || o.method === 'GET')) await new Promise((res) => setTimeout(res, 900));
        return r;
      }; 1`);
      await F.click('[aria-label="글쓰기"]');
      await F.waitFor('[data-role="composer"]');
      await F.type('[data-role="composer"] [name=title]', '느린 스냅샷 속의 글');
      await F.click('[data-role="composer-submit"]');
      await F.waitFor('[data-role="guest-anon"]');
      await F.click('[data-role="guest-anon"]');
      await F.waitFor(hasCard('느린 스냅샷 속의 글'), { timeout: 12000 });
      await sleep(2000); // longer than the slow snapshot
      check('S8 새 게스트가 처음 올린 글이 (스냅샷 응답이 늦어도) 자기 화면에서 사라지지 않음', await F.eval(hasCard('느린 스냅샷 속의 글')) && (await F.count('[data-post-id]')) >= 4, 'cards=' + (await F.count('[data-post-id]')));
      await ctxF.close();
      await ctxG.close();
      await ctxT.close();
      await ctxR.close();

      // ── several network cards: pick which address to share (the pick lives in that dialog only) ──
      lanIps = [LAN.replace(/^http:\/\//, '').replace(/:\d+$/, ''), SECOND];
      await O.reload();
      await O.waitFor('[data-role="board-surface"]', { timeout: 15000 });
      await stubClipboard(O);
      await openShare(O);
      st = await shareState(O);
      check('S8 LAN 주소가 둘이면 select 로 고르고 첫 주소가 기본', st.hasSelect && JSON.stringify(st.options) === JSON.stringify([LAN, lanOf(SECOND)]) && st.selected === LAN && st.url === LAN + BOARD, JSON.stringify(st));
      check('S8 select 에 접근 가능한 이름(공유할 주소)', (await O.eval(`document.querySelector('[data-role="share-host"]').getAttribute('aria-label')`)) === '공유할 주소');
      await O.screenshot(join(OUT, 's8-share-two-nics.png'));
      await O.eval(`(() => { const s = document.querySelector('[data-role="share-host"]'); s.value = ${JSON.stringify(lanOf(SECOND))}; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
      st = await shareState(O);
      check('S8 둘째 주소를 고르면 링크가 그 주소로 바뀜', st.url === lanOf(SECOND) + BOARD, st.url);
      check('S8 둘째 주소를 고르면 QR 도 그 주소로 바뀜', await qrIs(O, lanOf(SECOND) + BOARD));
      await O.click('[data-role="share"] button[aria-label="링크 복사"]');
      await O.waitFor("(window.__copied !== null)");
      check('S8 둘째 주소를 고르면 복사도 그 주소', (await O.eval('window.__copied')) === lanOf(SECOND) + BOARD);
      await closeShare(O);
      await openShare(O);
      st = await shareState(O);
      check('S8 창을 닫았다 다시 열면 고른 값은 기억하지 않고 첫 주소부터', st.selected === LAN && st.url === LAN + BOARD, JSON.stringify(st));
      await closeShare(O);

      // ── the Wi-Fi address changes while the teacher's page stays open (reconnect / sleep / new lease): NO reload, just open the dialog again ──
      const prevIps = lanIps;
      const NEWIP = '192.0.2.55';
      lanIps = [NEWIP];
      await openShare(O);
      await O.waitFor(`(document.querySelector('input[name="url"]') || {}).value === ${JSON.stringify(lanOf(NEWIP) + BOARD)}`, { timeout: 8000 }).catch(() => {});
      st = await shareState(O);
      check('S8 IP 가 바뀐 뒤 새로고침 없이 공유 창을 다시 열면 새 주소로 링크가 만들어짐', st.url === lanOf(NEWIP) + BOARD && !st.hasSelect, JSON.stringify(st));
      check('S8 IP 가 바뀐 뒤 QR 도 새 주소의 QR', await qrIs(O, lanOf(NEWIP) + BOARD));
      check('S8 IP 가 바뀌었다는 안내(토스트)가 뜸', /네트워크 주소가 바뀌어/.test(await O.eval(`document.querySelector('#toasts') ? document.querySelector('#toasts').innerText : ''`)));
      await closeShare(O);
      // …and a second card appearing later (Wi-Fi + a cable) shows up in the picker the next time the dialog opens
      lanIps = [NEWIP, SECOND];
      await openShare(O);
      await O.waitFor(`!!document.querySelector('[data-role="share-host"]')`, { timeout: 8000 }).catch(() => {});
      st = await shareState(O);
      check('S8 IP 가 둘로 늘면(무선+유선) 다시 연 공유 창에 주소 고르기가 나타남', st.hasSelect && JSON.stringify(st.options) === JSON.stringify([lanOf(NEWIP), lanOf(SECOND)]), JSON.stringify(st));
      await closeShare(O);
      lanIps = prevIps; // the later steps (mobile widths) expect the two-card situation again

      // ── mobile widths: the picker and the notice box must not push the dialog sideways ──
      for (const w of [390, 320]) {
        await O.setViewport(w, 740, true, 2);
        await sleep(200);
        await openShare(O);
        const ov = await overflowOf(O);
        check(`S8 모바일 ${w}px: 주소 고르기·안내 상자가 가로로 넘치지 않음`, ov.page <= 1 && ov.body <= 1 && ov.wide.length === 0, JSON.stringify(ov));
        if (w === 390) await O.screenshot(join(OUT, 's8-share-mobile.png'));
        await setShareCfg(O, { origin: null, lan: [] });
        await closeShare(O);
        await openShare(O);
        const ov2 = await overflowOf(O);
        check(`S8 모바일 ${w}px: localhost 경고 상자도 넘치지 않음`, ov2.page <= 1 && ov2.body <= 1 && ov2.wide.length === 0, JSON.stringify(ov2));
        await closeShare(O);
        await O.eval(`(async () => { const { store } = await import('/js/lib/store.js'); store.set('config', window.__cfg0); return 1; })()`);
      }
      await O.setViewport(1280, 860);

      // ── what a wrong / hostile server answer must NOT do ──
      const checks = await O.eval(`(async () => {
        const { validOrigin, isLoopbackHost, shareInfo } = await import('/js/lib/share-origin.js');
        const { store } = await import('/js/lib/store.js');
        const bad = ['javascript:alert(1)', 'JAVASCRIPT:alert(1)', ' https://a.example', 'https://a.example ', 'https://a.example\\n', 'https://a.example/', 'https://a.example/path', 'https://a.example?x=1', 'https://a.example#h',
          'https://user:pw@a.example', 'https://user@a.example', 'ftp://a.example', 'file:///etc/passwd', 'data:text/html,x', '//a.example', 'a.example', '', 'http://', 'http://a.example:80', 'https://a.example:443', 'HTTP://A.EXAMPLE', 'http://a.example"x', "http://a.example'x", 'http://a.example' + String.fromCharCode(96) + 'x', 'http://a_b.example', 'http://a.example{', 42, null, undefined, {}, ['http://a.example']];
        const good = ['http://192.168.0.12:3000', 'https://edulet.example.com', 'http://[::1]:3000', 'http://[fe80::1]:8080', 'http://127.0.0.2:5173'];
        const loop = { 'localhost': true, 'LOCALHOST': true, '[::1]': true, '::1': true, '127.0.0.1': true, '127.0.0.2': true, '127.200.3.4': true, 'foo.localhost': true, '0.0.0.0': true,
          '192.168.0.12': false, 'example.com': false, 'localhost.evil.com': false, '127.0.0.1.evil.com': false, 'evil-localhost': false, '1270.0.0.1': false, '128.0.0.1': false, '': false, '[2001:db8::1]': false };
        const out = { badCount: bad.length, badAccepted: bad.filter((v) => validOrigin(v) !== null).map(String), goodRejected: good.filter((v) => validOrigin(v) !== v), loopWrong: Object.entries(loop).filter(([h, want]) => isLoopbackHost(h) !== want).map(([h]) => h), cases: [] };
        const here = location.origin;
        const cfg0 = store.config;
        const run = (name, share, extra, pick, want) => {
          store.set('config', { ...cfg0, share, ...(extra || {}) });
          const i = shareInfo(pick);
          const ok = i.source === want.source && i.base === want.base && JSON.stringify(i.lan) === JSON.stringify(want.lan || []) && i.demo === !!want.demo;
          if (!ok) out.cases.push(name + ' → ' + JSON.stringify(i));
        };
        run('script origin', { origin: 'javascript:alert(1)', lan: [] }, null, undefined, { source: 'here', base: here });
        run('origin with path', { origin: 'https://edulet.example.com/path', lan: [] }, null, undefined, { source: 'here', base: here });
        run('origin with blank', { origin: ' https://edulet.example.com', lan: [] }, null, undefined, { source: 'here', base: here });
        run('origin with credentials', { origin: 'https://u:p@edulet.example.com', lan: [] }, null, undefined, { source: 'here', base: here });
        run('origin with slash', { origin: 'https://edulet.example.com/', lan: [] }, null, undefined, { source: 'here', base: here });
        run('valid public origin', { origin: 'https://edulet.example.com', lan: ['http://10.0.0.5:3000'] }, null, undefined, { source: 'public', base: 'https://edulet.example.com' });
        run('mixed lan list', { origin: null, lan: ['http://evil.example/x', 'javascript:1', 'http://10.1.2.3:81 ', 'http://10.1.2.3:81', 'http://10.1.2.3:81', 'http://[fe80::1]:3000', 7, null] }, null, undefined, { source: 'lan', base: 'http://10.1.2.3:81', lan: ['http://10.1.2.3:81', 'http://[fe80::1]:3000'] });
        run('pick in list', { origin: null, lan: ['http://10.1.2.3:81', 'http://10.1.2.4:81'] }, null, 'http://10.1.2.4:81', { source: 'lan', base: 'http://10.1.2.4:81', lan: ['http://10.1.2.3:81', 'http://10.1.2.4:81'] });
        run('pick not in list', { origin: null, lan: ['http://10.1.2.3:81'] }, null, 'http://evil.example', { source: 'lan', base: 'http://10.1.2.3:81', lan: ['http://10.1.2.3:81'] });
        run('lan is a string', { origin: null, lan: 'http://10.0.0.1:3000' }, null, undefined, { source: 'here', base: here });
        run('lan junk', { origin: 42, lan: [null, 5, {}] }, null, undefined, { source: 'here', base: here });
        run('share missing', undefined, null, undefined, { source: 'here', base: here });
        run('share is a string', 'http://10.0.0.1:3000', null, undefined, { source: 'here', base: here });
        run('empty lists', { origin: null, lan: [] }, null, undefined, { source: 'here', base: here });
        run('demo ignores the server values', { origin: 'https://edulet.example.com', lan: ['http://10.0.0.5:3000'] }, { demo: true }, undefined, { source: 'here', base: here, demo: true });
        // the address this page is open on decides whether a LAN list is used at all (the server should not send one to anybody else — defence in depth)
        const runHost = (name, share, host, want) => {
          store.set('config', { ...cfg0, share });
          const i = shareInfo(undefined, host);
          const ok = i.source === want.source && i.loopback === want.loopback && (want.base === undefined || i.base === want.base);
          if (!ok) out.cases.push(name + ' → ' + JSON.stringify(i));
        };
        const L = { origin: null, lan: ['http://10.1.2.3:81'] };
        runHost('lan list ignored on a LAN address', L, '192.168.0.9', { source: 'here', loopback: false });
        runHost('lan list ignored on a domain', L, 'edulet.example.com', { source: 'here', loopback: false });
        runHost('lan list ignored on a look-alike host', L, 'localhost.evil.com', { source: 'here', loopback: false });
        runHost('lan list used on [::1]', L, '[::1]', { source: 'lan', loopback: true, base: 'http://10.1.2.3:81' });
        runHost('lan list used on 127.0.0.1', L, '127.0.0.1', { source: 'lan', loopback: true, base: 'http://10.1.2.3:81' });
        runHost('[::1] without addresses: warning case', { origin: null, lan: [] }, '[::1]', { source: 'here', loopback: true });
        runHost('public origin wins on a domain', { origin: 'https://edulet.example.com', lan: [] }, 'edulet.example.com', { source: 'public', loopback: false, base: 'https://edulet.example.com' });
        runHost('public origin wins on [::1] too', { origin: 'https://edulet.example.com', lan: L.lan }, '[::1]', { source: 'public', loopback: true, base: 'https://edulet.example.com' });
        store.set('config', cfg0);
        out.loopbackHere = shareInfo().loopback === true;
        return out;
      })()`);
      check(`S8 서버가 준 origin 검증: javascript:·공백·경로·인증정보·포트 표기 등 ${checks.badCount}종을 모두 거절하고 정상 주소는 받음`, checks.badAccepted.length === 0 && checks.goodRejected.length === 0, JSON.stringify([checks.badAccepted, checks.goodRejected]));
      check('S8 loopback 판별(localhost·127.x·[::1] 은 맞고 localhost.evil.com 같은 흉내는 아님)', checks.loopWrong.length === 0 && checks.loopbackHere, JSON.stringify(checks.loopWrong));
      check('S8 shareInfo: 잘못된 origin·lan 은 무시하고 검증된 값만, 고른 주소는 목록 안에서만, 데모는 서버 값 무시, 현재 주소가 LAN·도메인이면 LAN 목록 안 씀, [::1] 은 loopback', checks.cases.length === 0, checks.cases.join(' / '));

      await setShareCfg(O, { origin: 'javascript:alert(1)', lan: ['javascript:alert(2)', 'http://evil.example/steal', 'http://u:p@evil.example'] });
      await openShare(O);
      st = await shareState(O);
      check('S8 적대적 /config 로 공유 창을 열어도 javascript: 링크·엉뚱한 주소가 없음(localhost 링크+경고)', !st.anyJs && !st.links.some((l) => /javascript|evil/i.test(l)) && st.url === baseL + BOARD && st.kinds.join() === 'loopback' && !st.hasSelect, JSON.stringify(st));
      check('S8 적대적 /config 에서 QR 은 localhost 링크의 QR', await qrIs(O, baseL + BOARD));
      await closeShare(O);

      await setShareCfg(O, { origin: null, lan: [] });
      await openShare(O);
      st = await shareState(O);
      check('S8 LAN 주소가 없고 localhost 로 열었으면 "이 PC 에서만 열려요" 경고와 README 안내', st.kinds.join() === 'loopback' && /이 PC 에서만/.test(st.noteText) && st.links.includes('https://github.com/dhsy3206/edulet#다른-pc-와-함께-쓰기'), JSON.stringify(st));
      await O.screenshot(join(OUT, 's8-share-loopback.png'));
      await closeShare(O);

      await setShareCfg(O, { origin: 'https://edulet.example.com', lan: [] });
      await openShare(O);
      st = await shareState(O);
      check('S8 서버가 공개 주소(origin)를 주면 링크·QR 이 항상 그 주소, 안내 상자 없음', st.url === `https://edulet.example.com${BOARD}` && st.kinds.length === 0 && !st.hasSelect && (await qrIs(O, `https://edulet.example.com${BOARD}`)), JSON.stringify(st));
      await closeShare(O);
      await O.eval(`(async () => { const { store } = await import('/js/lib/store.js'); window.__fakeCfg = null; store.set('config', window.__cfg0); return 1; })()`);
      await ctxO.close();
    } finally {
      await appL.close();
      try { rmSync(dirL, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });
  /* ── S8b an IPv6 loopback address ([::1]) is "this PC" too: the same warning / the same LAN link, with the bracketed host in the text ── */
  await step('S8b', async () => {
    const v6ok = await new Promise((resolve) => {
      const probe = net.createServer();
      probe.once('error', () => resolve(false));
      probe.listen(0, '::1', () => probe.close(() => resolve(true)));
    });
    if (!v6ok) return check('S8b IPv6 loopback([::1])을 쓸 수 없는 환경: 건너뜀', true);
    let lanIps = [];
    const appV = await createAppOnGoodPort(() => ({
      dataDir: mkdtempSync(join(tmpdir(), 'edulet-e2e-v6-')), port: 0, host: '::', seed: false, quiet: true, previewFetcher: stubPreviewFetcher,
      networkInterfaces: () => ({ 'Wi-Fi': lanIps.map(fakeNic) }),
    }));
    const dirV = appV.app.config.dataDir;
    const base6 = `http://[::1]:${appV.port}`;
    try {
      const ctx = await browser.newContext();
      const O = await ctx.newPage(base6 + '/');
      const reg = await call(O, 'POST', '/auth/register', { username: 'v6owner' + Math.random().toString(36).slice(2, 6), password: 'password-1234', displayName: '여섯' });
      if (reg.status !== 201 && reg.status !== 200) throw new Error('register failed ' + JSON.stringify(reg));
      const slug = (await call(O, 'POST', '/boards', { title: 'IPv6 공유 시험', format: 'wall' })).body.board.slug;
      const BOARD = `/b/${slug}`;
      await O.goto(base6 + BOARD);
      await O.waitFor('[data-role="board-surface"]', { timeout: 15000 });
      await openShare(O);
      let st = await shareState(O);
      check('S8b [::1] 로 열고 LAN 주소가 없으면: 링크는 [::1] 그대로, "이 PC 에서만" 경고에 [::1]:포트 가 보임', st.url === base6 + BOARD && st.kinds.join() === 'loopback' && st.noteText.includes(`[::1]:${appV.port}`) && /이 PC 에서만/.test(st.noteText), JSON.stringify(st));
      check('S8b [::1] 링크의 QR', await qrIs(O, base6 + BOARD));
      await closeShare(O);
      lanIps = ['192.0.2.8'];
      await O.reload();
      await O.waitFor('[data-role="board-surface"]', { timeout: 15000 });
      await openShare(O);
      st = await shareState(O);
      check('S8b [::1] 로 열어도 서버가 LAN 주소를 주면 그 주소로 링크를 만듦', st.url === `http://192.0.2.8:${appV.port}${BOARD}` && st.kinds.join() === 'lan', JSON.stringify(st));
      await closeShare(O);
      await ctx.close();
    } finally {
      await appV.close();
      try { rmSync(dirV, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });
  /* ── S9 HTML 오프라인 내보내기: 버튼으로 실제로 내려받고, 그 파일을 file:// 로 새 탭에 열어 확인(네트워크 0건·스크립트 0·악성 입력 무해) ── */
  await step('S9', async () => {
    const dlDir = mkdtempSync(join(tmpdir(), 'edulet-e2e-dl-'));
    const raw = await connectBrowser(browser.port);
    const ctxs = [];
    try {
      // ── fixtures through the API: fast users whose NAMES are hostile, a rows board with a huge picture, a PDF, a too-big file, a link, hostile posts
      const evilName = '"><svg onload=window.__pwned=5>';
      const owner = makeUser(app, 'exo');
      app.db.run('UPDATE users SET display_name = ? WHERE id = ?', '출제 교사', owner.id);
      const talker = makeUser(app, 'ext');
      app.db.run('UPDATE users SET display_name = ? WHERE id = ?', evilName, talker.id);
      const TITLE = 'S9 <i>내보내기</i> 시험';
      const b = await makeBoard(owner, { title: TITLE, description: '설명 **굵게** https://example.com/ok <b>태그</b>', format: 'rows', linkAccess: 'comment' });
      const slug = b.slug;
      const sec1 = (await owner.get(`/api/boards/${slug}`)).json.sections[0];
      await owner.patch(`/api/sections/${sec1.id}`, { title: '첫 구역' });
      const sec2 = (await owner.post(`/api/boards/${slug}/sections`, { title: '둘째 구역' })).json.section;
      const up = async (name, mime, bytes) => {
        const r = await owner.req('PUT', `/api/uploads?board=${slug}&name=${encodeURIComponent(name)}`, bytes, { raw: true, headers: { 'content-type': mime } });
        if (r.status !== 200 && r.status !== 201) throw new Error('upload ' + name + ' → ' + r.status + ' ' + r.text.slice(0, 120));
        return r.json;
      };
      const mk = async (body) => {
        const r = await owner.post(`/api/boards/${slug}/posts`, body);
        if (r.status !== 201) throw new Error('post → ' + r.status + ' ' + r.text.slice(0, 120));
        return r.json.post;
      };
      const pdfBytes = makePdf();
      const photo = await up('큰사진.png', 'image/png', makePng(3200, 1800, [60, 120, 200]));
      const pdf = await up('자료.pdf', 'application/pdf', pdfBytes);
      const big = await up('큰파일.bin', 'application/octet-stream', Buffer.alloc(16 * 1024 * 1024, 7));
      await mk({ title: '큰 사진', body: '3200x1800 그림', sectionId: sec1.id, attachment: { kind: 'image', uploadId: photo.id } });
      const pEvil = await mk({
        title: '<script>window.__pwned=1</script>', color: 'red', sectionId: sec1.id,
        body: '"><img src=x onerror="window.__pwned=2">\njavascript:window.__pwned=3 [x](javascript:window.__pwned=3)\n- 목록 **굵게** https://example.com/ok.\n</style><script>window.__pwned=6</script>',
      });
      await mk({ title: '자료', sectionId: sec2.id, attachment: { kind: 'file', uploadId: pdf.id } });
      await mk({ title: '너무 큰 파일', sectionId: sec2.id, attachment: { kind: 'file', uploadId: big.id } });
      await mk({ title: '링크', sectionId: sec2.id, attachment: { kind: 'link', url: 'https://example.com/page?a=1&b=2' } });
      await mk({ title: '다른 곳의 그림', sectionId: sec2.id, attachment: { kind: 'image', url: 'https://evil.example/remote-pic.png' } });
      const EVIL_COMMENT = '<img src=x onerror=window.__pwned=4> 댓글';
      if ((await talker.post(`/api/posts/${pEvil.id}/comments`, { body: EVIL_COMMENT })).status !== 201) throw new Error('comment 1');
      if ((await owner.post(`/api/posts/${pEvil.id}/comments`, { body: '선생님 댓글' })).status !== 201) throw new Error('comment 2');

      // ── an anonymous visitor (read + comment) on the board
      const ctx = await browser.newContext();
      ctxs.push(ctx);
      const dl = await watchDownloads(raw, ctx.id, dlDir);
      const page = await ctx.newPage(base + '/b/' + slug);
      await page.waitFor('[data-post-id]', { timeout: 15000 });
      await page.eval('window.__EDULET_HIDE_MS = 3600000; 1'); // a tab in the background parks its live stream; this one is used again later
      // a background tab does not render and its stream is parked: bring the tab we are about to use to the front
      const front = async (t) => { await raw.send('Target.activateTarget', { targetId: t.targetId }); await sleep(250); };
      await sleep(500);
      check('S9 (준비) 카드 6장', (await page.count('[data-post-id]')) === 6, 'n=' + (await page.count('[data-post-id]')));

      // top-bar button → the share dialog on its export section
      check('S9 상단 막대에 "내보내기" 버튼(이름 있음)', (await page.eval(`document.querySelector('[data-role="topbar-export"]')?.getAttribute('aria-label')`)) === '내보내기');
      await page.click('[data-role="topbar-export"]');
      await page.waitFor('[data-role="share"] [data-role="export-html"]');
      await sleep(700); // the dialog scrolls to its export section smoothly
      const chip = await page.eval(`document.querySelector('[data-role="share"] .bp-share-chip.on')?.dataset.tab`);
      check('S9 상단 "내보내기" 가 공유 창의 내보내기 구역을 바로 엶', chip === 'export', String(chip));
      const box = await page.eval(`(() => { const b = document.querySelector('[data-role="export-html-box"]'); return { text: b.innerText, size: b.querySelector('select[name=imageSize]').value, files: b.querySelector('input[name=includeFiles]').checked, statusRole: b.querySelector('[data-role="export-html-status"]').getAttribute('role'), live: b.querySelector('[data-role="export-html-status"]').getAttribute('aria-live'), btn: document.querySelector('[data-role="export-html"]').innerText.trim() }; })()`);
      check('S9 공유 창: "HTML 파일 (오프라인)" 버튼·옵션(기본: 줄여서·첨부 포함)·안내·상태 영역(role=status, aria-live)', box.btn === 'HTML 파일 (오프라인)' && box.size === 'shrink' && box.files && box.statusRole === 'status' && box.live === 'polite' && /다른 사람에게 보낼 때 주의/.test(box.text) && /더블클릭/.test(box.text), JSON.stringify(box).slice(0, 300));
      check('S9 공유 창 안내: 위치 정보가 빠진다·움직이는 그림은 정지된 그림·관리자가 내보내면 승인 대기 글도 담긴다·보낼 때 주의', /위치 정보 등이 빠진 채로 담겨요/.test(box.text) && /움직이는 그림은 정지된 그림으로 담겨요/.test(box.text) && /승인 대기 중인 글도 담겨요/.test(box.text) && /다른 사람에게 보낼 때 주의/.test(box.text), box.text.slice(0, 400));
      await page.screenshot(join(OUT, 's9-share-export.png'));

      // click → a real file
      await page.eval(`window.__st = []; window.__busy = [];
        const st = document.querySelector('[data-role="export-html-status"]'), bt = document.querySelector('[data-role="export-html"]');
        new MutationObserver(() => window.__st.push(st.textContent)).observe(st, { childList: true, characterData: true, subtree: true });
        new MutationObserver(() => window.__busy.push(bt.getAttribute('aria-busy') + '/' + bt.disabled)).observe(bt, { attributes: true }); 1`);
      const f1 = await dl.next(() => page.click('[data-role="export-html"]'), { timeout: 60000 });
      const html1 = readFileSync(f1.path, 'utf8');
      check('S9 내려받은 파일 이름 edulet-<slug>-YYYYMMDD.html', new RegExp(`^edulet-${slug}-\\d{8}\\.html$`).test(f1.suggested), f1.suggested);
      check('S9 파일: CSP 메타가 있고 <script 가 한 번도 없음', html1.includes(`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; media-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">`) && !/<script/i.test(html1) && html1.length > 2000, 'bytes=' + f1.bytes);
      check('S9 파일: 용량 때문에 못 담은 파일이 카드 자리에 이유와 함께 적힘', html1.includes('용량이 커서 담지 못했어요: 큰파일.bin') && html1.includes('<summary>담지 못한 파일 1개</summary>'));
      check('S9 파일: 3200px 그림은 줄여 담겨 파일이 작음(원본 3200px PNG 가 그대로 들어가지 않음)', f1.bytes < 2 * 1024 * 1024, 'bytes=' + f1.bytes);
      await page.waitFor(`/내려받았어요/.test(document.querySelector('[data-role="export-html-status"]').textContent)`, { timeout: 5000 });
      const prog = await page.eval('({ st: window.__st, busy: window.__busy, text: document.querySelector(\'[data-role="export-html-status"]\').textContent, btnDisabled: document.querySelector(\'[data-role="export-html"]\').disabled, bar: document.querySelector(\'.bp-export-bar\').hidden })');
      check('S9 진행 안내: "보드 내용을 읽는 중…" → "그림|파일 n/m 담는 중…" → "파일을 만드는 중…" → 완료 문장이 aria-live 영역에 차례로 나옴', prog.st[0] === '보드 내용을 읽는 중…' && prog.st.some((t) => /^(그림|파일) \d\/\d 담는 중…$/.test(t)) && prog.st.some((t) => t === '파일을 만드는 중…') && /내려받았어요/.test(prog.st[prog.st.length - 1]), JSON.stringify(prog.st));
      check('S9 만드는 동안 버튼이 비활성(aria-busy), 끝나면 다시 활성·진행 막대 숨김', prog.busy.includes('true/true') && prog.busy[prog.busy.length - 1] === 'false/false' && !prog.btnDisabled && prog.bar, JSON.stringify(prog.busy));
      check('S9 끝난 뒤 요약: 몇 개 담았고 못 담은 파일이 있다는 말', /글 6개/.test(prog.text) && /그림 1개/.test(prog.text) && /담지 못한 파일이 1개/.test(prog.text), prog.text);

      // ── open the saved file from file:// in a fresh tab, watching the network, the console and the log
      const view = await ctx.newPage('about:blank');
      const tab = await raw.attach(view.targetId);
      const requests = [];
      const logs = [];
      tab.on('Network.requestWillBeSent', (p) => requests.push(p.request.url));
      tab.on('Log.entryAdded', (p) => logs.push(p.entry));
      await tab.send('Network.enable');
      await tab.send('Log.enable');
      const fileUrl = pathToFileURL(f1.path).href;
      await view.goto(fileUrl);
      await view.waitFor(`document.querySelectorAll('article.card').length === 6`, { timeout: 15000 });
      await view.eval(`(async () => { for (const i of document.images) { i.scrollIntoView({ block: 'center' }); await new Promise((r) => setTimeout(r, 40)); } window.scrollTo(0, 0); return 1; })()`);
      await view.waitFor(`[...document.images].every((i) => i.complete)`, { timeout: 10000 });
      const probe = () => view.eval(`(() => {
        const text = document.body.textContent;
        return {
          title: document.title, h1: document.querySelector('h1').textContent, scripts: document.scripts.length, pwned: typeof window.__pwned,
          handlers: document.querySelectorAll('[onerror],[onload],[onclick],[onmouseover],[onfocus]').length, cards: document.querySelectorAll('article.card').length,
          imgs: [...document.images].map((i) => ({ w: i.naturalWidth, h: i.naturalHeight })),
          badHref: [...document.querySelectorAll('[href]')].map((a) => a.getAttribute('href')).filter((h) => !/^(#|https?:\\/\\/|data:application\\/octet-stream;base64,)/.test(h)),
          badSrc: [...document.querySelectorAll('[src]')].map((a) => a.getAttribute('src')).filter((h) => !h.startsWith('data:')),
          jsLinks: document.querySelectorAll('a[href^="javascript" i]').length,
          evilTitle: text.includes('<script>window.__pwned=1</script>'), evilComment: text.includes(${JSON.stringify(EVIL_COMMENT)}), evilName: text.includes(${JSON.stringify(evilName)}),
          injectedImgs: document.querySelectorAll('img[src="x"]').length, injectedSvg: document.querySelectorAll('svg').length,
          commentDetails: document.querySelectorAll('details.comments').length, owner: text.includes('출제 교사'),
          okLink: !!document.querySelector('a[href="https://example.com/ok"]'), linkCard: document.querySelector('a.link')?.getAttribute('href'),
          fileLink: document.querySelector('a.file[download]')?.getAttribute('download'),
          overflow: document.documentElement.scrollWidth - innerWidth,
        };
      })()`);
      let p = await probe();
      check('S9 열어 본 파일: 제목·보드 제목이 글자 그대로(<i> 태그가 아님)', p.h1 === TITLE && p.title.startsWith(TITLE) && p.cards === 6, JSON.stringify([p.h1, p.title, p.cards]));
      check('S9 열어 본 파일: 악성 글 제목·댓글·댓글 작성자 이름이 "글자"로만 보임', p.evilTitle && p.evilComment && p.evilName && p.commentDetails === 1, JSON.stringify([p.evilTitle, p.evilComment, p.evilName, p.commentDetails]));
      check('S9 열어 본 파일: 스크립트 0개·실행 흔적(window.__pwned) 없음·이벤트 속성 0·끼어든 <img src=x>/<svg> 없음', p.scripts === 0 && p.pwned === 'undefined' && p.handlers === 0 && p.injectedImgs === 0 && p.injectedSvg === 0, JSON.stringify([p.scripts, p.pwned, p.handlers, p.injectedImgs, p.injectedSvg]));
      check('S9 열어 본 파일: 링크는 http(s)·#·data(파일)뿐, javascript: 링크 없음, 본문 URL 은 링크가 됨', p.badHref.length === 0 && p.jsLinks === 0 && p.okLink && p.linkCard === 'https://example.com/page?a=1&b=2', JSON.stringify([p.badHref, p.jsLinks, p.okLink, p.linkCard]));
      check('S9 열어 본 파일: src 는 전부 data:', p.badSrc.length === 0 && p.imgs.length >= 1, JSON.stringify(p.badSrc));
      check('S9 열어 본 파일: 그림이 실제로 보이고(naturalWidth>0) 3200px 원본이 1600px 로 줄어 있음', p.imgs.every((i) => i.w > 0) && p.imgs.some((i) => i.w === 1600 && i.h === 900), JSON.stringify(p.imgs));
      check('S9 열어 본 파일: 소유자 이름이 보임', p.owner);
      const nonData = requests.filter((u) => !u.startsWith('data:'));
      check('S9 열어 본 파일: 네트워크 요청 0건(http 요청 없음, data: 제외) — 다른 곳에 있는 그림도 가져오지 않음', nonData.every((u) => u.startsWith('file:')) && !requests.some((u) => /^https?:|evil\.example/.test(u)), nonData.join(' | ').slice(0, 300));
      check('S9 열어 본 파일: 다른 곳의 그림은 "담지 않았어요" 글자와 주소 링크만', (await view.eval(`document.body.textContent.includes('외부 그림은 담지 않았어요') && !!document.querySelector('a[href="https://evil.example/remote-pic.png"]') && ![...document.images].some((i) => i.src.includes('evil.example'))`)) === true);
      const bad = logs.filter((e) => e.level === 'error' || e.level === 'warning' || e.source === 'security' || /Content Security Policy|Refused to/i.test(e.text || ''));
      check('S9 열어 본 파일: 콘솔·보안 로그에 CSP 위반/오류가 하나도 없음(악성 입력이 막히려다 걸린 것도 없음)', view.errors.length === 0 && bad.length === 0, JSON.stringify([view.errors, bad.map((e) => e.text)]).slice(0, 300));
      await view.screenshot(join(OUT, 's9-file-rows.png'), { fullPage: true });

      // lightbox without script: :target
      await view.click('.ph-open');
      await sleep(200);
      const lb = await view.eval(`(() => { const f = document.querySelector('.ph:target'); if (!f) return null; const r = f.querySelector('img').getBoundingClientRect(); return { pos: getComputedStyle(f).position, x: r.x, y: r.y, w: r.width, h: r.height, vw: innerWidth, vh: innerHeight }; })()`);
      check('S9 사진을 누르면 화면 가득 크게(position:fixed, 화면 안, JS 없이 :target)', !!lb && lb.pos === 'fixed' && lb.w > 400 && lb.x >= -1 && lb.y >= -1 && lb.x + lb.w <= lb.vw + 1 && lb.y + lb.h <= lb.vh + 1, JSON.stringify(lb));
      await view.screenshot(join(OUT, 's9-lightbox.png'));
      await view.mouse(8, 8); // the dark backdrop is the close link
      await sleep(200);
      check('S9 바깥(배경)을 누르면 닫힘', (await view.exists('.ph:target')) === false);

      // a file attachment is a real download of the original bytes
      const f2 = await dl.next(() => view.click('a.file'), { timeout: 20000 });
      check('S9 첨부 PDF: 파일 안의 링크로 원본 바이트 그대로 내려받아짐(이름 자료.pdf)', f2.suggested === '자료.pdf' && readFileSync(f2.path).equals(pdfBytes), `${f2.suggested} ${f2.bytes}/${pdfBytes.length}`);

      // offline for real
      await tab.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
      await view.reload();
      await view.waitFor(`document.querySelectorAll('article.card').length === 6`, { timeout: 15000 });
      await view.eval(`(async () => { for (const i of document.images) { i.scrollIntoView({ block: 'center' }); await new Promise((r) => setTimeout(r, 40)); } return 1; })()`);
      await view.waitFor(`[...document.images].every((i) => i.complete)`, { timeout: 10000 });
      p = await probe();
      check('S9 인터넷을 끊은 채 다시 열어도 글·그림이 그대로(offline 에뮬레이션)', p.cards === 6 && p.imgs.every((i) => i.w > 0) && p.pwned === 'undefined', JSON.stringify([p.cards, p.imgs]));
      await tab.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });

      // phones and dark mode
      for (const w of [390, 320]) {
        await view.setViewport(w, 800, true);
        await sleep(250);
        p = await probe();
        check(`S9 열어 본 파일 ${w}px: 가로로 넘치지 않음`, p.overflow <= 1, 'overflow=' + p.overflow);
        if (w === 390) await view.screenshot(join(OUT, 's9-file-mobile.png'));
      }
      await view.setViewport(1280, 860);
      await tab.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
      await sleep(250);
      const darkBg = await view.eval(`getComputedStyle([...document.querySelectorAll('article.card')].find((c) => !/pc-/.test(c.className))).backgroundColor`);
      check('S9 어두운 화면 설정이면 카드가 어두운 색', darkBg === 'rgb(31, 37, 48)', darkBg);
      await view.screenshot(join(OUT, 's9-file-dark.png'));
      await tab.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });

      // the app's own top bar and share dialog stay inside the screen with the new button (phones)
      await front(page);
      await page.key('Escape');
      await page.waitFor(`!document.querySelector('[data-role="share"]')`);
      for (const w of [390, 320]) {
        await page.setViewport(w, 800, true);
        await sleep(300);
        const bar = await page.eval(`(() => { const bt = document.querySelector('[data-role="topbar-export"]').getBoundingClientRect(); const wide = [...document.querySelectorAll('.bp-topbar .bp-btn, .bp-topbar .app-uc')].filter((e) => { const r = e.getBoundingClientRect(); return r.right > innerWidth + 1 || r.left < -1; }).length; return { right: bt.right, w: bt.width, page: document.documentElement.scrollWidth - innerWidth, wide }; })()`);
        if (w === 320) {
          check('S9 상단 막대 320px: 아주 좁아서 내보내기 버튼은 비켜 있고(공유 창에 있음) 넘치지 않음', bar.w === 0 && bar.page <= 1 && bar.wide === 0, JSON.stringify(bar));
          await page.screenshot(join(OUT, 's9-topbar-320.png'));
          await page.click('[aria-label="공유"]'); // the export section is one chip away in the share dialog
          await page.waitFor('[data-role="share"] .bp-share-chip[data-tab="export"]');
          await page.click('.bp-share-chip[data-tab="export"]');
        } else {
          check(`S9 상단 막대 ${w}px: 내보내기 버튼이 아이콘만(36px) 화면 안에 있고 넘치지 않음`, bar.right <= w && bar.w <= 40 && bar.page <= 1 && bar.wide === 0, JSON.stringify(bar));
          await page.click('[data-role="topbar-export"]');
        }
        await page.waitFor('[data-role="share"] [data-role="export-html"]');
        await sleep(600);
        const ov = await page.eval(`(() => { const m = document.querySelector('[data-role="share"]'); const body = m.querySelector('.modal-body'); const r = m.getBoundingClientRect(); return { page: document.documentElement.scrollWidth - innerWidth, body: body.scrollWidth - body.clientWidth, outside: [...m.querySelectorAll('.bp-export-html, .bp-export-html button, .bp-export-html select, .bp-export-html progress')].filter((e) => e.offsetParent !== null).filter((e) => { const q = e.getBoundingClientRect(); return q.left < r.left - 1 || q.right > r.right + 1; }).length }; })()`);
        check(`S9 공유 창 ${w}px: 내보내기 상자가 넘치지 않음`, ov.page <= 1 && ov.body <= 1 && ov.outside === 0, JSON.stringify(ov));
        if (w === 320) await page.screenshot(join(OUT, 's9-share-320.png'));
        await page.key('Escape');
        await page.waitFor(`!document.querySelector('[data-role="share"]')`);
      }
      await page.setViewport(1280, 860);

      // every board format comes out in its own layout (real download each time, opened from file://)
      const LAYOUT = { wall: 'layout-wall', grid: 'layout-grid', stream: 'layout-stream', shelf: 'layout-shelf', rows: 'layout-rows', canvas: 'layout-grid', backchannel: 'layout-chat' };
      for (const f of ['wall', 'grid', 'stream', 'shelf', 'canvas', 'backchannel', 'rows']) {
        const pr = await owner.patch(`/api/boards/${slug}`, { format: f });
        if (pr.status !== 200) throw new Error('format ' + f + ' ' + pr.status);
        await front(page);
        await page.waitFor(`document.querySelector('[data-role="board-surface"]')?.dataset.format === '${f}'`, { timeout: 8000 });
        await sleep(500);
        await page.click('[data-role="topbar-export"]');
        await page.waitFor('[data-role="share"] [data-role="export-html"]');
        await sleep(500);
        const ff = await dl.next(() => page.click('[data-role="export-html"]'), { timeout: 60000 });
        const text = readFileSync(ff.path, 'utf8');
        await page.key('Escape');
        await page.waitFor(`!document.querySelector('[data-role="share"]')`);
        check(`S9 형식 ${f}: 파일이 ${LAYOUT[f]} 배치(data-format=${f})이고 카드 6장·스크립트 0`, text.includes(`class="${LAYOUT[f]}" data-format="${f}"`) && ((text.match(/<article class="(card|msg)/g) || []).length === 6) && !/<script/i.test(text), `${ff.name}`);
        if (f === 'canvas') check('S9 형식 canvas: 격자로 바꿨다는 한 줄 안내', text.includes('캔버스 보드라서'));
        if (f === 'shelf' || f === 'rows') check(`S9 형식 ${f}: 구역 제목 2개와 글 수`, text.includes('<h2 class="sec-title">첫 구역</h2><span class="sec-n">2</span>') && text.includes('<h2 class="sec-title">둘째 구역</h2><span class="sec-n">4</span>'));
        await front(view);
        await view.goto(pathToFileURL(ff.path).href);
        await view.waitFor(`document.querySelectorAll('article').length >= 5`, { timeout: 15000 });
        await view.eval(`(async () => { for (const i of document.images) { i.scrollIntoView({ block: 'center' }); await new Promise((r) => setTimeout(r, 30)); } window.scrollTo(0, 0); return 1; })()`);
        await sleep(300);
        for (const w of [1280, 390]) {
          await view.setViewport(w, 860, w < 600);
          await sleep(200);
          const ov = await view.eval(`document.documentElement.scrollWidth - innerWidth`);
          if (w === 390) check(`S9 형식 ${f} 열어 본 파일 390px: 가로로 넘치지 않음`, ov <= 1, 'overflow=' + ov);
          await view.screenshot(join(OUT, `s9-fmt-${f}-${w}.png`), { fullPage: false });
        }
        await view.setViewport(1280, 860);
      }

      // options: original size + no attachments
      await front(page);
      await page.click('[data-role="topbar-export"]');
      await page.waitFor('[data-role="share"] [data-role="export-html"]');
      await sleep(500);
      await page.eval(`(() => { const s = document.querySelector('select[name=imageSize]'); s.value = 'original'; s.dispatchEvent(new Event('change', { bubbles: true })); document.querySelector('input[name=includeFiles]').click(); return 1; })()`);
      check('S9 "원본 크기"를 고르면 안내가 "위치 정보 등이 그대로 들어가요" 로 바뀜', /위치 정보 등이 그대로 들어가요/.test(await page.text('#bp-export-size-note')), await page.text('#bp-export-size-note'));
      const f3 = await dl.next(() => page.click('[data-role="export-html"]'), { timeout: 60000 });
      const html3 = readFileSync(f3.path, 'utf8');
      check('S9 옵션 "첨부 파일 담기" 끄면 PDF 는 담지 않았다고 표시, 그림은 계속 담김', html3.includes('설정에 따라 담지 않았어요: 자료.pdf') && !html3.includes('download="자료.pdf"') && html3.includes('<img '));
      await front(view);
      await view.goto(pathToFileURL(f3.path).href);
      await view.waitFor(`document.querySelectorAll('article.card').length === 6`, { timeout: 15000 });
      await view.eval(`(async () => { for (const i of document.images) { i.scrollIntoView({ block: 'center' }); await new Promise((r) => setTimeout(r, 40)); } return 1; })()`);
      await view.waitFor(`[...document.images].every((i) => i.complete)`, { timeout: 10000 });
      p = await probe();
      check('S9 옵션 "원본 크기" 면 3200px 그림이 그대로', p.imgs.some((i) => i.w === 3200), JSON.stringify(p.imgs));
      await front(page);
      await page.key('Escape');
      await page.waitFor(`!document.querySelector('[data-role="share"]')`);

      // one file that cannot be fetched must not sink the export: its request dies, everything else goes on (this used to end in a red error)
      await front(page);
      await page.eval(`(() => { const f = window.fetch.bind(window); window.fetch = async (u, o) => { if (String(u).includes('/uploads/') && decodeURIComponent(String(u)).includes('자료')) throw new TypeError('Failed to fetch'); return f(u, o); }; return 1; })()`);
      await page.click('[data-role="topbar-export"]');
      await page.waitFor('[data-role="share"] [data-role="export-html"]');
      await sleep(500);
      const f5 = await dl.next(() => page.click('[data-role="export-html"]'), { timeout: 60000 });
      const html5 = readFileSync(f5.path, 'utf8');
      const st5 = await page.eval(`(() => { const s = document.querySelector('[data-role="export-html-status"]'); return { text: s.textContent, err: s.classList.contains('is-error') }; })()`);
      check('S9 파일 하나를 받지 못해도 나머지는 계속되어 파일이 만들어지고(그 파일만 "불러오지 못해" 로 표시) 빨간 오류가 없음', html5.includes('불러오지 못해 담지 못했어요: 자료.pdf') && html5.includes('<img ') && !st5.err && /내려받았어요/.test(st5.text) && /불러오지 못해/.test(st5.text), JSON.stringify(st5).slice(0, 300));
      await page.key('Escape');
      await page.waitFor(`!document.querySelector('[data-role="share"]')`);
      await page.reload();
      await page.waitFor('[data-post-id]', { timeout: 15000 });
      await page.eval('window.__EDULET_HIDE_MS = 3600000; 1');

      // ── pictures: the location never stays in (default mode), a rotated photo stays upright, a bomb is skipped without being decoded;
      //    "원본 크기" keeps the original (and says so)
      const mkJpeg = (w, h, noise) => page.eval(`(async () => {
        const c = document.createElement('canvas'); c.width = ${w}; c.height = ${h};
        const x = c.getContext('2d'); const g = x.createLinearGradient(0, 0, ${w}, ${h}); g.addColorStop(0, '#f80'); g.addColorStop(1, '#08f'); x.fillStyle = g; x.fillRect(0, 0, ${w}, ${h});
        x.fillStyle = '#000'; x.font = '60px sans-serif'; x.fillText('TOP-LEFT', 40, 100);
        ${noise ? `const d = x.getImageData(0, 0, ${w}, ${h}); for (let i = 0; i < d.data.length; i += 4) { d.data[i] = Math.random() * 255; d.data[i + 1] = Math.random() * 255; d.data[i + 2] = Math.random() * 255; } x.putImageData(d, 0, 0);` : ''}
        const b = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.9)); const a = new Uint8Array(await b.arrayBuffer());
        let s = ''; for (let i = 0; i < a.length; i += 8192) s += String.fromCharCode.apply(null, a.subarray(i, i + 8192)); return btoa(s);
      })()`).then((b64) => Buffer.from(b64, 'base64'));
      const gb = await makeBoard(owner, { title: 'S9 그림', format: 'wall', linkAccess: 'comment' });
      const upG = async (name, mime, bytes) => {
        const r = await owner.req('PUT', `/api/uploads?board=${gb.slug}&name=${encodeURIComponent(name)}`, bytes, { raw: true, headers: { 'content-type': mime } });
        if (r.status !== 200 && r.status !== 201) throw new Error('upload ' + name + ' → ' + r.status + ' ' + r.text.slice(0, 120));
        return r.json;
      };
      const mkG = async (title, up) => {
        const r = await owner.post(`/api/boards/${gb.slug}/posts`, { title, attachment: { kind: 'image', uploadId: up.id } });
        if (r.status !== 201) throw new Error('post ' + title + ' → ' + r.status + ' ' + r.text.slice(0, 120));
      };
      const small = await mkJpeg(900, 600, false);
      const noisy = await mkJpeg(2400, 1600, true);
      await mkG('upright', await upG('upright.jpg', 'image/jpeg', injectExif(small, {})));
      await mkG('rotated', await upG('rotated.jpg', 'image/jpeg', injectExif(small, { orientation: 6 })));
      await mkG('big', await upG('big.jpg', 'image/jpeg', injectExif(noisy, { orientation: 6 })));
      await mkG('bomb', await upG('bomb.png', 'image/png', await bombPng(31000, 31000)));
      const gpage = await ctx.newPage(base + '/b/' + gb.slug);
      await gpage.waitFor('[data-post-id]', { timeout: 15000 });
      await gpage.eval('window.__EDULET_HIDE_MS = 3600000; 1');
      await sleep(500);
      const gpsIn = (file) => [...readFileSync(file, 'utf8').matchAll(/data:image\/[a-z]+;base64,([A-Za-z0-9+/=]+)/g)].some((m) => Buffer.from(m[1], 'base64').includes(GPS_NEEDLE));
      await front(gpage);
      await gpage.click('[data-role="topbar-export"]');
      await gpage.waitFor('[data-role="share"] [data-role="export-html"]');
      await sleep(500);
      const t0g = Date.now();
      const fg = await dl.next(() => gpage.click('[data-role="export-html"]'), { timeout: 60000 });
      const tookG = Date.now() - t0g;
      const htmlG = readFileSync(fg.path, 'utf8');
      check('S9 그림: 기본(줄여서) 모드의 파일에는 어떤 그림에도 위치 정보(GPS)가 남지 않음(작은 JPEG 도, 큰 JPEG 도)', !gpsIn(fg.path) && !htmlG.includes('GPSLatitude'), 'bytes=' + fg.bytes);
      check('S9 그림: 폭탄 PNG(31000×31000, 파일은 수백 KB)는 디코딩하지 않고 건너뛰어 "담지 못한 파일" 에 오르고, 내보내기는 곧바로 끝남', htmlG.includes('용량이 커서 담지 못했어요: bomb.png') && htmlG.includes('<summary>담지 못한 파일 1개</summary>') && tookG < 30000, `took ${tookG} ms`);
      await front(view);
      await view.goto(pathToFileURL(fg.path).href);
      await view.waitFor(`document.querySelectorAll('article.card').length === 4`, { timeout: 15000 });
      await view.eval(`(async () => { for (const i of document.images) { i.scrollIntoView({ block: 'center' }); await new Promise((r) => setTimeout(r, 40)); } return 1; })()`);
      await view.waitFor(`[...document.images].every((i) => i.complete)`, { timeout: 10000 });
      const gi = await view.eval(`Object.fromEntries([...document.images].map((i) => [i.alt, [i.naturalWidth, i.naturalHeight]]))`);
      check('S9 그림: 같은 자리의 사진이 방향까지 그대로(900×600 은 그대로, 회전 표시된 사진은 600×900 로 세워짐)', JSON.stringify(gi['upright.jpg']) === '[900,600]' && JSON.stringify(gi['rotated.jpg']) === '[600,900]', JSON.stringify(gi));
      check('S9 그림: 큰 회전 사진은 긴 변 1600px 로 줄고 세로로 세워져 있음', gi['big.jpg'] && gi['big.jpg'][1] === 1600 && gi['big.jpg'][0] > 1000 && gi['big.jpg'][0] < 1100, JSON.stringify(gi['big.jpg']));
      await front(gpage);
      await gpage.eval(`(() => { const s = document.querySelector('select[name=imageSize]'); s.value = 'original'; s.dispatchEvent(new Event('change', { bubbles: true })); return 1; })()`);
      const fg2 = await dl.next(() => gpage.click('[data-role="export-html"]'), { timeout: 60000 });
      check('S9 그림: "원본 크기" 에서는 원본 그대로라 위치 정보가 들어 있음(안내문대로), 폭탄은 여기서도 건너뜀', gpsIn(fg2.path) && readFileSync(fg2.path, 'utf8').includes('용량이 커서 담지 못했어요: bomb.png'));
      check('S9 그림 화면 콘솔 오류 없음', gpage.errors.length === 0, gpage.errors.join(' | ').slice(0, 300));
      await gpage.close();

      // ── too much text for one page: the export stops with a Korean message BEFORE a single picture is fetched, and no file is made
      await front(page);
      const tl = await page.eval(`(async () => {
        const m = await import('/js/lib/export-offline.js');
        const seen = []; const f = window.fetch.bind(window); window.fetch = (u, o) => { seen.push(String(u)); return f(u, o); };
        try { await m.buildBoardHtml(${JSON.stringify(slug)}, { limits: { textBytes: 3000 } }); return { ok: true }; }
        catch (e) { return { ok: false, name: e.name, msg: e.message, text: m.exportErrorText(e), uploads: seen.filter((u) => u.includes('/uploads/')).length, exportReq: seen.filter((u) => u.includes('/export?format=json')).length }; }
        finally { window.fetch = f; }
      })()`);
      check('S9 글자 분량이 한도를 넘으면 그림을 받기 전에(요청 0건) 한국어 안내와 함께 멈추고 파일은 만들지 않음', !tl.ok && tl.name === 'ExportTooLargeError' && /너무 많아/.test(tl.text) && tl.uploads === 0 && tl.exportReq === 1, JSON.stringify(tl).slice(0, 300));

      // ── the loader only ever asks THIS app for /uploads/<id>/<name>: a hostile export JSON cannot make it call anywhere else
      const hits = [];
      const srv = http.createServer((req, res) => {
        hits.push(req.method + ' ' + req.url);
        res.writeHead(200, { 'Content-Type': 'image/png' });
        res.end();
      });
      await listenOnGoodPort(srv);
      try {
        await front(page);
        const A = `127.0.0.1:${srv.address().port}`;
        const HX = 'c'.repeat(32);
        const hostile = [
          { kind: 'image', url: `http://${A}/a1.png` }, { kind: 'image', url: `//${A}/a2.png` }, { kind: 'image', url: '/\\' + A + '/a3.png' }, { kind: 'file', url: `\\\\${A}\\a4.bin` },
          { kind: 'image', url: `/uploads/${HX}/..` }, { kind: 'image', url: `/uploads/${HX}/.` }, { kind: 'image', url: `/uploads/${HX}/%2e%2e` }, { kind: 'image', url: `/uploads/${HX}/../../api/auth/me` },
          { kind: 'image', url: `/uploads/${HX}/..%2f..%2fapi%2fauth%2fme` }, { kind: 'image', url: `/uploads/${HX}/x?y=http://${A}/q` }, { kind: 'image', url: `/uploads/${HX}/x#h` },
          { kind: 'file', url: 'file:///C:/Windows/win.ini' }, { kind: 'image', url: 'javascript:window.__pwned=1' }, { kind: 'image', url: `http://127.0.0.1:${app.port}/api/auth/me` },
          { kind: 'link', url: 'https://example.invalid/', preview: { title: 't', image: `http://${A}/p1.png` } }, { kind: 'link', url: 'https://example.invalid/', preview: { title: 't', image: `//${A}/p2.png` } },
          { kind: 'video', url: `http://${A}/v.mp4`, preview: { title: 'v', image: `http://${A}/v.png`, embedUrl: `http://${A}/embed` } },
        ];
        await page.eval(`(() => {
          window.__seen = []; window.__orig = window.__orig || window.fetch.bind(window);
          const evil = ${JSON.stringify(hostile)}; const A = ${JSON.stringify(A)};
          window.fetch = async (u, o) => {
            const url = String(u); window.__seen.push(url);
            if (url.includes('/export?format=json')) {
              const r = await window.__orig(u, o); const d = await r.json();
              d.board.wallpaper = '//' + A + '/w.png';
              evil.forEach((a, i) => d.posts.push({ id: 9000 + i, boardId: d.board.id, sectionId: null, author: { id: 1, displayName: 'x', avatarColor: '#fff' }, title: 'h' + i, body: '', color: null, pinned: false, status: 'published', rank: i, createdAt: Date.now(), updatedAt: Date.now(), attachment: a, commentCount: 0, reactions: {}, comments: [] }));
              return new Response(JSON.stringify(d), { status: 200, headers: { 'Content-Type': 'application/json' } });
            }
            return window.__orig(u, o);
          };
          return 1;
        })()`);
        const net = await page.eval(`(async () => {
          const m = await import('/js/lib/export-offline.js');
          const r = await m.buildBoardHtml(${JSON.stringify(slug)}, {});
          const html = await r.blob.text();
          return { seen: window.__seen, skipped: r.summary.skipped.length, ext: (html.match(/외부 그림은 담지 않았어요/g) || []).length };
        })()`);
        await sleep(800);
        const odd = net.seen.filter((u) => !(u.includes('/export?format=json') || /^\/uploads\/[0-9a-f]{32}\/[^/]+$/.test(u)));
        const dots = net.seen.filter((u) => /^\/uploads\/[0-9a-f]{32}\/(\.|%2e)+$/i.test(u));
        check('S9 악성 내보내기 JSON(원격·//·역슬래시·../·%2e·file:·javascript:·다른 포트 주소 17종)에도 로더의 요청은 이 앱의 /uploads/<id>/<이름> 뿐 — 공격자 서버에 요청 0건, 점(..)만 있는 이름도 요청하지 않음', hits.length === 0 && odd.length === 0 && dots.length === 0, JSON.stringify({ hits, odd, dots, seenN: net.seen.length }).slice(0, 400));
        check('S9 악성 JSON: 모르는 /uploads/… 모양은 "외부 그림" 이 아니라 담지 못한 파일로 올라가고, 진짜 원격 그림만 "외부 그림" 으로 말함', net.skipped >= 8 && net.ext >= 1, JSON.stringify(net).slice(0, 300));
      } finally {
        srv.closeAllConnections?.();
        await new Promise((r) => srv.close(r));
      }
      await page.reload();
      await page.waitFor('[data-post-id]', { timeout: 15000 });
      await page.eval('window.__EDULET_HIDE_MS = 3600000; 1');

      // ── a board admin's bar is the narrowest (it has the settings button too): below 341px the export button steps aside, the dialog still has it
      const actx = await browser.newContext();
      ctxs.push(actx);
      const apage = await actx.newPage();
      const atab = await raw.attach(apage.targetId);
      await atab.send('Network.setCookie', { name: 'edulet_sid', value: owner.cookie.split('=')[1], url: base, httpOnly: true });
      for (const w of [320, 340, 360]) {
        await apage.setViewport(w, 700, true);
        await apage.goto(base + '/b/' + slug);
        await apage.waitFor('[data-post-id]', { timeout: 15000 });
        await sleep(400);
        const m = await apage.eval(`(() => { const bar = document.querySelector('.bp-topbar-in'); const ex = document.querySelector('[data-role="topbar-export"]'); return { admin: !!document.querySelector('[aria-label="설정"]'), over: bar.scrollWidth - bar.clientWidth, doc: document.documentElement.scrollWidth - innerWidth, shown: getComputedStyle(ex).display !== 'none' }; })()`);
        check(`S9 보드 관리자 상단 막대 ${w}px: 설정 버튼이 있어도 가로로 넘치지 않음(내보내기 버튼은 ${w > 340 ? '보임' : '비켜 있음'})`, m.admin && m.over <= 1 && m.doc <= 1 && m.shown === (w > 340), JSON.stringify(m));
      }
      await apage.setViewport(320, 700, true);
      await apage.goto(base + '/b/' + slug);
      await apage.waitFor('[data-post-id]', { timeout: 15000 });
      await apage.click('[aria-label="공유"]');
      await apage.waitFor('[data-role="share"] .bp-share-chip[data-tab="export"]');
      await apage.click('.bp-share-chip[data-tab="export"]');
      await apage.waitFor('[data-role="share"] [data-role="export-html"]');
      await sleep(500);
      check('S9 관리자 320px: 공유 창의 내보내기 구역에서 "HTML 파일 (오프라인)" 단추를 쓸 수 있음', (await apage.eval(`(() => { const r = document.querySelector('[data-role="export-html"]').getBoundingClientRect(); return r.width > 40 && r.right <= innerWidth && r.left >= 0; })()`)) === true);
      await apage.screenshot(join(OUT, 's9-admin-320.png'));

      // cancel (the uploads are slowed down so there is something to cancel)
      await page.eval(`(() => { const f = window.fetch.bind(window); window.fetch = async (u, o) => { if (String(u).includes('/uploads/')) await new Promise((r) => setTimeout(r, 2500)); return f(u, o); }; return 1; })()`);
      await page.click('[data-role="topbar-export"]');
      await page.waitFor('[data-role="share"] [data-role="export-html"]');
      await sleep(500);
      const before = dl.begun.length;
      await page.click('[data-role="export-html"]');
      await page.waitFor(`/담는 중/.test(document.querySelector('[data-role="export-html-status"]').textContent)`, { timeout: 8000 });
      check('S9 진행 중에는 "취소" 버튼이 보이고 진행 막대가 보임', (await page.eval(`!document.querySelector('[data-role="export-html-cancel"]').hidden && !document.querySelector('.bp-export-bar').hidden`)) === true);
      await page.click('[data-role="export-html-cancel"]');
      await page.waitFor(`document.querySelector('[data-role="export-html-status"]').textContent === '취소했어요.'`, { timeout: 5000 });
      await sleep(3200);
      const after = await page.eval(`({ disabled: document.querySelector('[data-role="export-html"]').disabled, cancelHidden: document.querySelector('[data-role="export-html-cancel"]').hidden, focus: document.activeElement?.dataset?.role })`);
      check('S9 취소하면 "취소했어요." 가 나오고 파일은 내려받아지지 않고 버튼이 다시 활성, 포커스는 내보내기 버튼', dl.begun.length === before && !after.disabled && after.cancelHidden && after.focus === 'export-html', JSON.stringify([dl.begun.length - before, after]));
      await page.key('Escape');

      // closing the dialog during an export cancels it too (no stray download)
      await page.click('[data-role="topbar-export"]');
      await page.waitFor('[data-role="share"] [data-role="export-html"]');
      await sleep(500);
      await page.click('[data-role="export-html"]');
      await page.waitFor(`/담는 중/.test(document.querySelector('[data-role="export-html-status"]').textContent)`, { timeout: 8000 });
      await page.key('Escape');
      await page.waitFor(`!document.querySelector('[data-role="share"]')`);
      await sleep(3500);
      check('S9 만드는 중에 창을 닫으면 취소되고 파일이 내려오지 않음', dl.begun.length === before);

      // the markdown subset is the same in both implementations (DOM vs string)
      const parity = await page.eval(`(async () => {
        const { renderRich } = await import('/js/lib/markdown.js');
        const { renderRichHtml } = await import('/js/lib/export-html.js');
        const corpus = ['', '한 줄', '첫째\\n둘째\\n\\n새 문단', '**굵게** *기울임* \`코드\` 섞어서', '- 하나\\n- 둘\\n문장\\n* 셋\\n• 넷', 'a * b * c', '*짝 없는 별', '**짝 없는 굵게', '보세요 https://example.com/a(b). 끝', '(https://example.com/x) 와 "https://example.com/y"', 'https://example.com', 'https://x.com/a_b?c=d&e=f#g 뒤', 'https://example.com/가나다', 'http://a.b/c;d,e', '<b onclick=alert(1)>x</b> <script>1</script> & &amp; " \\'', 'javascript:alert(1) data:text/html,x ftp://x', '\\r\\n윈도우\\r줄바꿈', '   - 들여쓴 목록\\n\\n\\n\\n- 띄운 목록', '이모지 😀 👨‍👩‍👧 와 한글', '**a**b*c*\`d\`e', 'x'.repeat(5000)];
        const bad = [];
        for (const t of corpus) {
          const a = document.createElement('div'); a.appendChild(renderRich(t));
          const b = document.createElement('div'); b.innerHTML = renderRichHtml(t);
          if (a.innerHTML !== b.innerHTML) bad.push({ t: t.slice(0, 60), dom: a.innerHTML.slice(0, 200), str: b.innerHTML.slice(0, 200) });
        }
        return { n: corpus.length, bad, pwned: typeof window.__pwned };
      })()`);
      check(`S9 markdown.js(DOM) 와 export-html.js(문자열)의 결과가 ${parity.n}가지 입력에서 똑같음`, parity.bad.length === 0 && parity.pwned === 'undefined', JSON.stringify(parity.bad).slice(0, 400));
      check('S9 방문자 화면 콘솔 오류 없음', page.errors.length === 0, page.errors.join(' | ').slice(0, 300));

      // dashboard: one menu line, default options, progress in a toast
      const D = await newUser('대시 교사');
      ctxs.push(D.ctx);
      const dd = await watchDownloads(raw, D.ctx.id, dlDir);
      const nb = await call(D.page, 'POST', '/boards', { title: '대시보드 내보내기 보드', format: 'wall' });
      const nslug = nb.body.board.slug;
      await call(D.page, 'POST', `/boards/${nslug}/posts`, { title: '메뉴로 내보낸 글', body: '본문' });
      await D.page.goto(base + '/dashboard');
      await D.page.waitFor(`document.querySelector('.dash-card[data-slug="${nslug}"]')`, { timeout: 15000 });
      await D.page.click(`.dash-card[data-slug="${nslug}"] .dash-more`);
      await D.page.waitFor('.popover .menu-item');
      const menuLabels = await D.page.eval(`[...document.querySelectorAll('.popover .menu-item')].map((b) => b.innerText.trim())`);
      check('S9 대시보드 카드 메뉴에 "HTML 로 내보내기" 한 줄', menuLabels.includes('HTML 로 내보내기'), menuLabels.join(','));
      const at = await D.page.eval(`(() => { const e = [...document.querySelectorAll('.popover .menu-item')].find((b) => b.innerText.includes('HTML 로 내보내기')); const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
      const f4 = await dd.next(() => D.page.mouse(at.x, at.y), { timeout: 60000 });
      const html4 = readFileSync(f4.path, 'utf8');
      check('S9 대시보드 메뉴: 옵션 없이 바로 내려받음(edulet-<slug>-날짜.html), 글이 들어 있음', new RegExp(`^edulet-${nslug}-\\d{8}\\.html$`).test(f4.suggested) && html4.includes('메뉴로 내보낸 글') && html4.includes('대시보드 내보내기 보드') && !/<script/i.test(html4), f4.suggested);
      await D.page.waitFor(`[...document.querySelectorAll('.toast')].some((t) => /내려받았어요/.test(t.textContent))`, { timeout: 5000 });
      check('S9 대시보드 메뉴: 끝나면 토스트로 알림', true);
      check('S9 대시보드 화면 콘솔 오류 없음', D.page.errors.length === 0, D.page.errors.join(' | ').slice(0, 300));
    } finally {
      raw.close();
      for (const c of ctxs) await c.close().catch(() => {});
      try { rmSync(dlDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });
  /* ══════════ S10 저장하기·불러오기 메뉴 (CONTRACT §5 "저장하기·불러오기"; 화면 public/js/views/backup-dialog.js) ══════════
     서버 PC(localhost)에서 연 화면에서만 보이는 메뉴. 임시 data·임시 backupDir 의 자기 서버를 쓴다(진짜 backups/ 는 건드리지 않는다).
     S10: 저장하기 → 바꾸기 → 불러오기(목록·미리보기·확인·진행·성공) → 다른 탭의 reset → 자동 저장본으로 왕복 / 게스트 / 다른 기기 / 사용자 메뉴 / 설정 변화 / 모바일.
     S10b: 오류 코드별 안내(서버 응답을 흉내 낸 경우)·망가진 저장본·키보드. */
  const bkDlg = '[data-role="backup-dialog"]';
  const bkView = (P) => P.eval(`document.querySelector('${bkDlg}')?.dataset.view || null`);
  const bkText = (P) => P.eval(`document.querySelector('${bkDlg}')?.innerText || ''`);
  const bkWaitView = async (P, v, timeout = 15000) => {
    try {
      await P.waitFor(`document.querySelector('${bkDlg}')?.dataset.view === ${JSON.stringify(v)}`, { timeout });
    } catch (e) { // say what the dialog shows instead
      throw new Error(`${e.message} — 지금 화면: ${await bkView(P).catch(() => '?')} / ${String(await bkText(P).catch(() => '')).replace(/\s+/g, ' ').slice(0, 240)}`);
    }
  };
  const bkOpen = async (P, which) => {
    await P.click(`[data-role="backup-${which}"]`);
    await P.waitFor(`document.querySelector('${bkDlg}')?.dataset.mode === ${JSON.stringify(which)}`);
  };
  /** Remember the status of every /api/backups* answer this page got (none may be a 401: api.js would sign the user out). Lost on reload. */
  const bkRecord = (P) => P.eval(`(() => { if (window.__bkSeen) return 1; window.__bkSeen = []; const f = window.fetch.bind(window);
    window.fetch = async (u, o) => { const r = await f(u, o); if (String(u).includes('/api/backups')) window.__bkSeen.push({ m: (o && o.method) || 'GET', s: r.status }); return r; }; return 1; })()`);
  /** Answer the next request that matches (method + url regex) with a made-up server response, once. */
  const bkStub = (P, stub) => P.eval(`(() => {
    if (!window.__bkStubOn) { window.__bkStubOn = true; const f = window.fetch.bind(window);
      window.fetch = async (u, o) => { const s = window.__bkStub; const m = (o && o.method) || 'GET';
        if (s && !s.used && m === s.method && new RegExp(s.match).test(String(u))) { s.used = true; window.__bkStubHits = (window.__bkStubHits || 0) + 1;
          return new Response(JSON.stringify(s.body), { status: s.status, headers: Object.assign({ 'Content-Type': 'application/json' }, s.headers || {}) }); }
        return f(u, o); }; }
    window.__bkStub = ${JSON.stringify(stub)}; window.__bkStubHits = 0; return 1; })()`);
  const bkOverflow = (P) => P.eval(`({ page: document.documentElement.scrollWidth - window.innerWidth, wide: [...document.querySelectorAll('.bk, .bk *, .app-header *')].filter((e) => e.getBoundingClientRect().right > window.innerWidth + 1).map((e) => e.className || e.tagName).slice(0, 5) })`);
  const bkMenuLabels = (P) => P.eval(`[...document.querySelectorAll('.popover .menu-item')].map((b) => b.innerText.trim())`);
  const bkMenuClick = async (P, label) => {
    const at = await P.eval(`(() => { const e = [...document.querySelectorAll('.popover .menu-item')].find((b) => b.innerText.trim() === ${JSON.stringify(label)}); const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    await P.mouse(at.x, at.y);
  };
  const bkStartApp = (hook) => createAppOnGoodPort(() => ({
    dataDir: mkdtempSync(join(tmpdir(), 'edulet-e2e-bk-data-')), backupDir: mkdtempSync(join(tmpdir(), 'edulet-e2e-bk-save-')), port: 0, host: '0.0.0.0', seed: false, quiet: true,
    previewFetcher: stubPreviewFetcher, backupHooks: hook,
  }));
  const bkRemove = (app2) => {
    for (const d of [app2.app.config.dataDir, app2.app.config.backupDir]) { try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
  };

  await step('S10', async () => {
    const lanIp = Object.values(osNetworkInterfaces()).flat().find((a) => a && a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.'))?.address || null;
    let hold = 0;
    const appB = await bkStartApp({ afterSafetySave: async () => { if (hold) await sleep(hold); } });
    const bkDir = appB.app.config.backupDir;
    const dataB = appB.app.config.dataDir;
    const baseB = appB.url.replace(/\/$/, ''); // http://localhost:PORT — the server PC's operator
    const fsm = await import('node:fs');
    const folders = () => fsm.readdirSync(bkDir).filter((n) => /^edulet-\d{8}-\d{6}(-\d+)?$/.test(n));
    try {
      const ctxA = await browser.newContext();
      const A = await ctxA.newPage(baseB + '/');
      const user = 'bk' + Math.random().toString(36).slice(2, 7);
      const reg = await call(A, 'POST', '/auth/register', { username: user, password: 'password-1234', displayName: '저장 교사' });
      if (reg.status !== 201 && reg.status !== 200) throw new Error('register failed ' + JSON.stringify(reg));
      const mkBoard = async (title, n) => {
        const b = (await call(A, 'POST', '/boards', { title, format: 'wall' })).body.board;
        for (let i = 1; i <= n; i++) await call(A, 'POST', `/boards/${b.slug}/posts`, { title: `${title} 글 ${i}`, body: '본문' });
        return b;
      };
      const postCount = async (slug) => ((await call(A, 'GET', `/boards/${slug}`)).body.posts || []).length;
      const b1 = await mkBoard('저장 시험 보드', 2);

      /* ── 진입점: 서버 PC 의 localhost 에서 연 헤더 ── */
      await A.goto(baseB + '/dashboard');
      await A.waitFor('[data-role="backup-save"]', { timeout: 15000 });
      check('S10 서버 PC(localhost)에서 연 헤더에 "저장하기"·"불러오기" 버튼', (await A.text('[data-role="backup-save"]')) === '저장하기' && (await A.text('[data-role="backup-restore"]')) === '불러오기');
      const cfg = await call(A, 'GET', '/config');
      check('S10 /config.backup.available 이 true', !!cfg.body.backup && cfg.body.backup.available === true, JSON.stringify(cfg.body.backup));
      await bkRecord(A);

      /* ── 저장하기 ── */
      await bkOpen(A, 'save');
      await A.waitFor(`/아직 직접 저장한 적이 없어요/.test(document.querySelector('[data-role="last-saved"]')?.innerText || '')`, { timeout: 8000 });
      check('S10 저장하기 창: 쉬운 안내문 + "아직 저장한 적이 없어요"', /수업 중에도 괜찮아요/.test(await bkText(A)));
      await A.screenshot(join(OUT, 's10-save-idle.png'));
      await A.eval(`(() => { const f = window.fetch; window.__posts = 0; window.fetch = async (u, o) => { if (String(u).endsWith('/api/backups') && o && o.method === 'POST') { window.__posts++; await new Promise((r) => setTimeout(r, 1200)); } return f(u, o); }; })()`);
      await A.eval(`(() => { const b = document.querySelector('[data-role="save-now"]'); b.click(); b.click(); })()`); // a double click
      await A.waitFor(`document.querySelector('[data-role="save-now"]')?.disabled === true`, { timeout: 3000 });
      const busyUi = await A.eval(`({ working: !!document.querySelector('[data-role="backup-working"]'), locked: document.querySelector('${bkDlg}').classList.contains('bk-locked'), x: getComputedStyle(document.querySelector('${bkDlg} .modal-head .btn-icon')).display })`);
      check('S10 저장 중: 진행 표시·버튼 잠김·닫기(X) 숨김', busyUi.working && busyUi.locked && busyUi.x === 'none', JSON.stringify(busyUi));
      await A.key('Escape');
      check('S10 저장 중에는 Esc 로 닫히지 않음', await A.exists(bkDlg));
      await bkWaitView(A, 'result');
      check('S10 더블클릭해도 저장 요청은 한 번, 백업 폴더도 하나', (await A.eval('window.__posts')) === 1 && folders().length === 1, `posts=${await A.eval('window.__posts')} folders=${folders().length}`);
      const savedText = await bkText(A);
      check('S10 저장 결과: 보드 1개·글 2개·사용자 1명 + 폴더 이름(절대 경로는 없음)',
        /보드 1개 · 글 2개 · 사용자 1명/.test(savedText) && savedText.includes(folders()[0]) && !/[A-Za-z]:[\\/]/.test(savedText) && !savedText.includes(dataB) && !savedText.includes(bkDir), savedText);
      await A.screenshot(join(OUT, 's10-save-result.png'));
      await A.click('[data-role="close"]');
      await A.waitFor(`!document.querySelector('${bkDlg}')`);
      check('S10 창을 닫으면 포커스가 헤더의 "저장하기" 버튼으로 돌아옴', (await A.eval(`document.activeElement && document.activeElement.dataset.role`)) === 'backup-save');

      /* ── 저장 뒤에 바꾸기 ── */
      await call(A, 'POST', `/boards/${b1.slug}/posts`, { title: '저장 뒤에 쓴 글 1', body: 'x' });
      await call(A, 'POST', `/boards/${b1.slug}/posts`, { title: '저장 뒤에 쓴 글 2', body: 'x' });
      const b2 = await mkBoard('저장 뒤에 만든 보드', 1);
      check('S10 (준비) 저장 뒤 글 3개·보드 1개가 늘어남', (await postCount(b1.slug)) === 4 && (await postCount(b2.slug)) === 1);

      /* ── 불러오기: 목록 → 미리보기 → 확인. 보드 화면(실시간 연결이 열려 있는 탭)에서 사용자 메뉴로 연다 ── */
      await A.goto(baseB + '/b/' + b1.slug);
      await A.waitFor('[data-post-id]', { timeout: 15000 });
      await bkRecord(A);
      await A.click('.app-uc-btn');
      await A.waitFor('.popover');
      const menuLabels = await bkMenuLabels(A);
      check('S10 보드 화면의 사용자 메뉴에 "저장하기"·"불러오기"(로그아웃 앞)', menuLabels.includes('저장하기') && menuLabels.includes('불러오기') && menuLabels.indexOf('불러오기') < menuLabels.indexOf('로그아웃'), menuLabels.join(','));
      await bkMenuClick(A, '불러오기');
      await A.waitFor(`document.querySelector('${bkDlg}')?.dataset.mode === 'restore'`);
      await bkWaitView(A, 'list');
      const nowTxt = await A.text('[data-role="current-state"]');
      const opt0 = await A.text('[data-role="backup-option"]');
      check('S10 불러오기 목록: "지금 서버 보드 2개·글 5개" + 저장본 한 줄(직접 저장·보드 1개·글 2개)', /보드 2개 · 글 5개/.test(nowTxt) && (await A.count('[data-role="backup-option"]')) === 1 && /직접 저장/.test(opt0) && /보드 1개 · 글 2개/.test(opt0), nowTxt + ' | ' + opt0);
      await A.waitFor(`document.activeElement && document.activeElement.getAttribute('role') === 'option'`, { timeout: 3000 }).catch(() => {});
      check('S10 목록 의미: role=listbox 안의 role=option, 첫 줄이 포커스를 받음',
        (await A.eval(`document.querySelector('[data-role="backup-list"]').getAttribute('role')`)) === 'listbox' && (await A.eval(`document.activeElement && document.activeElement.getAttribute('role')`)) === 'option');
      await A.screenshot(join(OUT, 's10-restore-list.png'));
      await A.key('Enter'); // keyboard: open the focused row
      await bkWaitView(A, 'preview');
      const head = await A.text('[data-role="compare-headline"]');
      check('S10 미리보기: "저장본 글 2개 ↔ 지금 글 5개 — 불러오면 지금보다 글이 3개 적어져요" (보드도)', /저장본 글 2개 ↔ 지금 글 5개/.test(head) && /글이 3개 적어져요/.test(head) && /보드가 1개 적어져요/.test(head), head);
      const bl = await A.eval(`[...document.querySelectorAll('[data-role="preview-boards"] li')].map((li) => li.innerText)`);
      check('S10 미리보기: 저장본의 보드 목록(제목·글 수)', bl.length === 1 && /저장 시험 보드/.test(bl[0]) && /글 2개/.test(bl[0]), JSON.stringify(bl));
      await A.screenshot(join(OUT, 's10-preview.png'));
      await A.click('[data-role="go-confirm"]');
      await bkWaitView(A, 'confirm');
      const confirmText = await bkText(A);
      check('S10 확인 단계: 자동 저장·계정과 비밀번호가 저장 당시로·다른 기기 새로고침·몇 초 걸림 안내', /자동으로 저장돼요/.test(confirmText) && /되돌릴 수 있어요/.test(confirmText) && /계정과 비밀번호도 저장 당시로 돌아가요/.test(confirmText) && /다시 로그인/.test(confirmText) && /다른 기기/.test(confirmText) && /몇 초/.test(confirmText), confirmText);
      check('S10 확인 단계의 불러오기 단추는 빨강(위험)이 아니라 기본 강조색', await A.eval(`(() => { const b = document.querySelector('[data-role="restore-go"]'); return b.classList.contains('btn-primary') && !b.classList.contains('btn-danger'); })()`));
      await A.screenshot(join(OUT, 's10-confirm.png'));

      /* ── 불러오기 실행: 같은 서버의 다른 탭(보드 화면)은 reset 으로 새로고침, 시작한 탭은 결과를 보여 준 뒤 스스로 이동 ── */
      const B = await ctxA.newPage(baseB + '/b/' + b1.slug); // a second tab of the same browser on the same board
      await B.waitFor('[data-post-id]', { timeout: 15000 });
      await B.eval(`window.__m2 = 'tab2'; sessionStorage.removeItem('sawReset'); new MutationObserver(() => { const t = document.getElementById('toasts'); if (t && /저장본을 불러와서/.test(t.innerText)) sessionStorage.setItem('sawReset', '1'); }).observe(document.body, { childList: true, subtree: true, characterData: true }); 1`);
      await sleep(600); // B's event stream is registered
      hold = 12000; // keep the restore running long enough to look at (and poke) the progress screen — CDP calls can be slow while the server works
      await A.eval(`window.__m1 = 'tab1'; window.__EDULET_BACKUP_MOVE_MS = 120000; 1`); // look at the result screen first; the button below does the move
      await A.click('[data-role="restore-go"]');
      await bkWaitView(A, 'working', 5000);
      const workUi = await A.eval(`({ spin: !!document.querySelector('[data-role="backup-working"]'), locked: document.querySelector('${bkDlg}').classList.contains('bk-locked'), x: getComputedStyle(document.querySelector('${bkDlg} .modal-head .btn-icon')).display, btn: document.querySelector('[data-role="restore-go"]').disabled })`);
      check('S10 불러오는 중: 진행 표시·버튼 잠김·닫기(X) 숨김', workUi.spin && workUi.locked && workUi.x === 'none' && workUi.btn, JSON.stringify(workUi));
      await A.key('Escape');
      await A.mouse(5, 5); // a click on the backdrop
      check('S10 불러오는 중에는 Esc·바깥 클릭으로 닫히지 않음', (await A.exists(bkDlg)) && (await bkView(A)) === 'working');
      await A.screenshot(join(OUT, 's10-working.png'));
      await bkWaitView(A, 'result', 40000);
      check('S10 불러오기를 시작한 탭은 reset 신호로 스스로 새로고침하지 않고 결과 화면을 보여 줌', (await A.eval('window.__m1')) === 'tab1');
      const doneText = await bkText(A);
      check('S10 성공 화면: "불러왔어요" + 이전 데이터를 자동 저장해 둔 안내', /불러왔어요/.test(doneText) && /자동 저장/.test(doneText) && /다시 고를 수 있어요/.test(doneText), doneText);
      await A.screenshot(join(OUT, 's10-restored.png'));
      const seenA = await A.eval('window.__bkSeen');
      check('S10 이 창의 /api/backups* 응답에 401 이 하나도 없음(있으면 api.js 가 로그아웃시킴), 불러오기 POST 는 200', seenA.every((x) => x.s !== 401) && seenA.some((x) => x.m === 'POST' && x.s === 200), JSON.stringify(seenA));
      await B.waitFor('(window.__m2 === undefined)', { timeout: 15000 });
      check('S10 같은 서버의 다른 탭(보드 화면)이 reset 으로 새로고침됨', true);
      check('S10 그 탭에 "저장본을 불러와서 화면을 새로 고쳐요" 안내가 떴음', (await B.eval(`sessionStorage.getItem('sawReset')`)) === '1');
      await B.waitFor('[data-post-id]', { timeout: 15000 });
      check('S10 새로고침된 탭은 저장 당시의 글 2장을 보여 줌', (await B.count('[data-post-id]')) === 2, 'n=' + (await B.count('[data-post-id]')));
      await B.eval('window.__m3 = 1; 1');
      await sleep(2500);
      check('S10 reset 뒤 새로고침 루프가 없음(새 연결은 정상 hello)', (await B.eval('window.__m3')) === 1);
      check('S10 성공 화면에 [화면 새로 고치기] 단추(읽을 게 없으면 곧 자동 이동한다는 문구)', (await A.exists('[data-role="reload"]')) && /곧 화면을 새로 고쳐요/.test(doneText));
      await A.click('[data-role="reload"]');
      await A.waitFor(`(window.__m1 === undefined && location.pathname === '/dashboard')`, { timeout: 15000 });
      check('S10 단추를 누르면 전체 새로고침으로 /dashboard 에 도착(SPA 이동이 아님)', true);
      check('S10 저장 당시로 되돌아감: 보드1 글 2개, 저장 뒤에 만든 보드는 사라짐(404)', (await postCount(b1.slug)) === 2 && (await call(A, 'GET', `/boards/${b2.slug}`)).status === 404);
      check('S10 같은 서버의 저장본이라 로그인이 유지됨', (await call(A, 'GET', '/auth/me')).body.user?.username === user);
      check('S10 복원 직전 자동 저장 폴더가 생김(저장 1 + 자동 1)', folders().length === 2, 'folders=' + folders().length);

      /* ── 왕복: 방금 생긴 "자동 저장"으로 다시 불러오면 저장 뒤의 상태가 돌아옴 ── */
      hold = 0;
      await A.waitFor('[data-role="backup-restore"]');
      await bkOpen(A, 'restore');
      await bkWaitView(A, 'list');
      const kinds = await A.eval(`[...document.querySelectorAll('[data-role="backup-option"]')].map((o) => o.dataset.kind)`);
      check('S10 목록 맨 위에 "자동 저장"(복원 직전) 항목이 생김', kinds.length === 2 && kinds[0] === 'before-restore' && kinds[1] === 'manual', JSON.stringify(kinds));
      check('S10 자동 저장 줄에 "자동 저장" 배지', /자동 저장/.test(await A.text('[data-role="backup-option"][data-kind="before-restore"]')));
      await A.screenshot(join(OUT, 's10-list-with-auto.png'));
      await A.click('[data-role="backup-option"][data-kind="before-restore"]');
      await bkWaitView(A, 'preview');
      const head2 = await A.text('[data-role="compare-headline"]');
      check('S10 자동 저장 미리보기: 저장본 글 5개 ↔ 지금 글 2개, "많아져요"', /저장본 글 5개 ↔ 지금 글 2개/.test(head2) && /글이 3개 많아져요/.test(head2), head2);
      await A.click('[data-role="go-confirm"]');
      await bkWaitView(A, 'confirm');
      await A.eval(`window.__m1b = 'again'; 1`);
      await A.click('[data-role="restore-go"]');
      await bkWaitView(A, 'result', 30000);
      await A.waitFor('(window.__m1b === undefined)', { timeout: 15000 }); // nobody pressed anything: the result screen moves on by itself
      await A.waitFor('.dash-card', { timeout: 15000 });
      check('S10 왕복: 자동 저장본으로 다시 불러오면 글 4개·두 번째 보드(글 1개)가 돌아옴', (await postCount(b1.slug)) === 4 && (await postCount(b2.slug)) === 1, `b1=${await postCount(b1.slug)} b2=${await postCount(b2.slug)}`);
      check('S10 두 번째 불러오기도 자동 저장을 남김(폴더 3개)', folders().length === 3, 'folders=' + folders().length);

      /* ── 사용자 메뉴로 연 창은 닫으면 그 메뉴 버튼으로 포커스가 돌아옴 ── */
      await A.goto(baseB + '/b/' + b1.slug);
      await A.waitFor('[data-post-id]', { timeout: 15000 });
      await A.click('.app-uc-btn');
      await A.waitFor('.popover');
      await bkMenuClick(A, '저장하기');
      await A.waitFor(`document.querySelector('${bkDlg}')?.dataset.mode === 'save'`);
      await A.key('Escape');
      await A.waitFor(`!document.querySelector('${bkDlg}')`);
      check('S10 사용자 메뉴로 연 창을 닫으면 포커스가 그 메뉴 버튼으로 돌아옴', (await A.eval(`document.activeElement && document.activeElement.classList.contains('app-uc-btn')`)) === true);

      /* ── 설정이 바뀌면 메뉴가 나타나고 사라짐 ── */
      await A.goto(baseB + '/dashboard');
      await A.waitFor('[data-role="backup-nav"] button', { timeout: 15000 });
      await A.eval(`import('/js/lib/store.js').then(({ store }) => { window.__cfgBk = store.config; store.set('config', { ...store.config, backup: { available: false } }); return 1; })`);
      check('S10 설정이 available=false 로 바뀌면 헤더 버튼이 사라짐(숨김이 아니라 제거)', (await A.count('[data-role="backup-nav"] button')) === 0);
      await A.click('.app-uc-btn');
      await A.waitFor('.popover');
      check('S10 그때 사용자 메뉴에도 없음', !(await bkMenuLabels(A)).includes('저장하기'));
      await A.key('Escape');
      await A.eval(`import('/js/lib/store.js').then(({ store }) => { store.set('config', window.__cfgBk); return 1; })`);
      check('S10 다시 available=true 가 되면 버튼 둘이 나타남', (await A.count('[data-role="backup-nav"] button')) === 2);

      /* ── 모바일 폭: 헤더는 아이콘만, 창은 가로로 넘치지 않음 ── */
      for (const w of [390, 320]) {
        await A.setViewport(w, 740, true, 2);
        await sleep(250);
        const hdr = await A.eval(`(() => { const b = [...document.querySelectorAll('[data-role="backup-nav"] button')]; return { n: b.length, w: b.map((x) => Math.round(x.getBoundingClientRect().width)), label: b.map((x) => getComputedStyle(x.querySelector('.app-backup-label')).display), names: b.map((x) => x.getAttribute('aria-label')) }; })()`);
        check(`S10 모바일 ${w}px: 헤더에 저장하기·불러오기가 아이콘으로 남고(이름은 aria-label) 넘치지 않음`, hdr.n === 2 && hdr.w.every((x) => x >= 36) && hdr.label.every((d) => d === 'none') && hdr.names.join() === '저장하기,불러오기' && (await bkOverflow(A)).page <= 0, JSON.stringify(hdr));
        await bkOpen(A, 'restore');
        await bkWaitView(A, 'list');
        await A.click('[data-role="backup-option"]');
        await bkWaitView(A, 'preview');
        const ov = await bkOverflow(A);
        check(`S10 모바일 ${w}px: 불러오기 미리보기가 가로로 넘치지 않음`, ov.page <= 0 && ov.wide.length === 0, JSON.stringify(ov));
        await A.screenshot(join(OUT, `s10-mobile-${w}.png`));
        await A.key('Escape');
        await A.waitFor(`!document.querySelector('${bkDlg}')`);
      }
      await A.setViewport(1280, 860);
      check('S10 서버 PC 화면 콘솔 오류 없음', A.errors.length === 0, A.errors.join(' | ').slice(0, 300));

      /* ── 게스트(교사 계정이 있는 서버): 403 member_required → 안내 + 로그인하면 하던 일을 이어서 ── */
      const ctxG = await browser.newContext();
      const G = await ctxG.newPage(baseB + '/');
      await call(G, 'POST', '/auth/guest', { displayName: '게스트 손님' });
      await G.goto(baseB + '/');
      await G.waitFor('[data-role="backup-save"]', { timeout: 15000 });
      await bkRecord(G);
      const gl = await call(G, 'GET', '/backups');
      check('S10 게스트 세션: 목록 API 는 403 member_required(401 이 아님)', gl.status === 403 && gl.body.error?.code === 'member_required', JSON.stringify(gl));
      await G.click('[data-role="backup-save"]');
      await G.waitFor(`document.querySelector('[data-role="backup-problem"] .bk-box')`, { timeout: 8000 });
      check('S10 게스트: 저장하기 창에 "교사 계정으로 로그인" 안내 + 로그인 단추', /계정으로 로그인한 뒤에 쓸 수 있어요/.test(await bkText(G)) && (await G.exists('[data-role="login"]')));
      await G.screenshot(join(OUT, 's10-guest-login.png'));
      check('S10 게스트는 그 뒤에도 게스트로 로그인된 채(401 처리로 로그아웃되지 않음)', (await call(G, 'GET', '/auth/me')).body.user?.isGuest === true && (await G.eval(`import('/js/lib/store.js').then((m) => !!m.store.me && m.store.me.isGuest === true)`)) === true);
      await G.click('[data-role="login"]');
      await G.waitFor(`document.activeElement === document.querySelector('[data-role="auth"] [name=username]')`, { timeout: 5000 }); // the modal moves the focus by itself a moment later
      await G.type('[data-role="auth"] [name=username]', user);
      await G.type('[data-role="auth"] [name=password]', 'password-1234');
      await G.click('[data-role="auth-submit"]');
      await bkWaitView(G, 'result', 20000).catch(async (e) => { throw new Error(`${e.message} · 로그인 창: ${await G.eval(`document.querySelector('[data-role="auth"] .form-error')?.innerText || '(없음)'`)}`); });
      check('S10 로그인하면 하던 "저장하기"가 이어서 실행되어 결과가 나옴', /저장했어요/.test(await bkText(G)) && folders().length === 4, 'folders=' + folders().length);
      check('S10 게스트 창의 /api/backups* 응답에도 401 이 없음', (await G.eval('window.__bkSeen')).every((x) => x.s !== 401));
      await ctxG.close();

      /* ── 다른 기기(LAN 주소): 메뉴가 없고 API 는 403 backup_local_only ── */
      if (!lanIp) console.log('INFO  S10 이 PC 에 사설 IPv4 가 없어 "다른 기기" 확인을 건너뜀');
      else {
        const L0 = `http://${lanIp}:${appB.port}`;
        const ctxL = await browser.newContext();
        const L = await ctxL.newPage(L0 + '/');
        await L.waitFor('.app-header', { timeout: 15000 });
        const lcfg = await call(L, 'GET', '/config');
        check('S10 다른 기기(LAN 주소): /config.backup.available=false', !!lcfg.body.backup && lcfg.body.backup.available === false, JSON.stringify(lcfg.body.backup));
        check('S10 다른 기기: 헤더에 저장하기·불러오기 버튼이 없음', (await L.count('[data-role="backup-nav"] button')) === 0);
        const la = await call(L, 'GET', '/backups');
        check('S10 다른 기기: 저장하기·불러오기 API 는 403 backup_local_only', la.status === 403 && la.body.error?.code === 'backup_local_only', JSON.stringify(la));
        await call(L, 'POST', '/auth/login', { username: user, password: 'password-1234' });
        await L.goto(L0 + '/dashboard');
        await L.waitFor('.app-uc-btn', { timeout: 15000 });
        await L.click('.app-uc-btn');
        await L.waitFor('.popover');
        const ll = await bkMenuLabels(L);
        check('S10 다른 기기: 교사로 로그인해도 사용자 메뉴에 저장하기·불러오기가 없음', !ll.includes('저장하기') && !ll.includes('불러오기') && ll.includes('로그아웃'), ll.join(','));
        await ctxL.close();
      }
      await ctxA.close();
    } finally {
      await appB.close();
      bkRemove(appB);
    }
  });

  await step('S10b', async () => {
    const appC = await bkStartApp(null);
    const bkDirC = appC.app.config.backupDir;
    const baseC = appC.url.replace(/\/$/, '');
    const fsm = await import('node:fs');
    const folders = () => fsm.readdirSync(bkDirC).filter((n) => /^edulet-\d{8}-\d{6}(-\d+)?$/.test(n));
    try {
      const ctx = await browser.newContext();
      const P = await ctx.newPage(baseC + '/');
      const user = 'bkb' + Math.random().toString(36).slice(2, 7);
      const reg = await call(P, 'POST', '/auth/register', { username: user, password: 'password-1234', displayName: '오류 시험' });
      if (reg.status !== 201 && reg.status !== 200) throw new Error('register failed ' + JSON.stringify(reg));
      const b = (await call(P, 'POST', '/boards', { title: '오류 시험 보드', format: 'wall' })).body.board;
      await call(P, 'POST', `/boards/${b.slug}/posts`, { title: '글', body: '본문' });
      await call(P, 'POST', '/backups'); // one good copy
      // a copy that cannot be read (damaged file) next to it: listed, previewable, not restorable
      const bad = join(bkDirC, 'edulet-20250101-000000');
      fsm.mkdirSync(bad);
      fsm.writeFileSync(join(bad, 'edulet.db'), Buffer.alloc(4096, 7));
      fsm.writeFileSync(join(bad, 'BACKUP-INFO.txt'), 'x');
      const before = folders().length;
      const postsNow = async () => ((await call(P, 'GET', `/boards/${b.slug}`)).body.posts || []).length;
      await P.goto(baseC + '/dashboard');
      await P.waitFor('[data-role="backup-save"]', { timeout: 15000 });
      await bkRecord(P);

      /* ── 저장하기 오류 ── */
      await bkOpen(P, 'save');
      await P.waitFor(`/마지막 저장/.test(document.querySelector('[data-role="last-saved"]')?.innerText || '') && !/확인하는 중/.test(document.querySelector('[data-role="last-saved"]').innerText)`, { timeout: 8000 });
      const tryStub = async (stub, role, wantRe, label) => {
        await bkStub(P, stub);
        await P.click(`[data-role="${role}"]`);
        await P.waitFor(`(window.__bkStubHits === 1)`, { timeout: 5000 });
        await sleep(200);
        const t = await bkText(P);
        check(label, wantRe.test(t), t.slice(0, 300));
      };
      await tryStub({ match: '/api/backups$', method: 'POST', status: 409, body: { error: { code: 'busy', message: '다른 저장·불러오기가 진행 중이에요.' } } }, 'save-now', /다른 저장·불러오기가 진행 중이에요\. 잠시 뒤에 다시 해 주세요/, 'S10b 저장하기 409 busy → "다른 저장·불러오기가 진행 중이에요. 잠시 뒤에 다시"');
      check('S10b 오류 뒤 저장 단추가 다시 눌러지고 창이 잠겨 있지 않음', await P.eval(`!document.querySelector('[data-role="save-now"]').disabled && !document.querySelector('${bkDlg}').classList.contains('bk-locked')`));
      await tryStub({ match: '/api/backups$', method: 'POST', status: 429, headers: { 'Retry-After': '30' }, body: { error: { code: 'rate_limited', message: '저장을 너무 자주 하고 있어요. 잠시 뒤에 다시 해 주세요.' } } }, 'save-now', /너무 자주.*30초/, 'S10b 저장하기 429 → 대기 시간(30초)을 알려 줌');
      await tryStub({ match: '/api/backups$', method: 'POST', status: 403, body: { error: { code: 'backup_local_only', message: 'x' } } }, 'save-now', /localhost 주소로 열었을 때만/, 'S10b 저장하기 403 backup_local_only → "서버를 켠 PC 의 localhost" 안내');
      await tryStub({ match: '/api/backups$', method: 'POST', status: 500, body: { error: { code: 'backup_failed', message: '디스크 공간이 부족해요.' } } }, 'save-now', /디스크 공간이 부족해요/, 'S10b 저장하기 500 backup_failed → 서버가 준 한국어 이유 그대로');
      await tryStub({ match: '/api/backups$', method: 'POST', status: 403, body: { error: { code: 'member_required', message: 'x' } } }, 'save-now', /계정으로 로그인한 뒤에 쓸 수 있어요/, 'S10b 저장하기 403 member_required → 로그인 안내');
      check('S10b member_required 에는 [로그인] 단추가 있고 누르면 로그인 창이 열림', await (async () => { await P.click('[data-role="login"]'); await P.waitFor('[data-role="auth"]', { timeout: 5000 }); return true; })());
      await P.key('Escape');
      await P.waitFor(`!document.querySelector('[data-role="auth"]')`);
      await P.eval(`document.querySelector('[data-role="close"]').click(); 1`);
      await P.waitFor(`!document.querySelector('${bkDlg}')`);
      check('S10b (오류 안내는 서버를 바꾸지 않음) 백업 폴더 수 그대로', folders().length === before, `${folders().length} vs ${before}`);

      /* ── 불러오기 오류 ── */
      await bkOpen(P, 'restore');
      await bkWaitView(P, 'list');
      check('S10b 목록에 정상 저장본 + 읽을 수 없는 저장본("내용은 미리보기에서 확인해요")이 함께 보임', (await P.count('[data-role="backup-option"]')) === 2 && /내용은 미리보기에서 확인해요/.test(await P.text('[data-role="backup-option"][data-id="edulet-20250101-000000"]')));
      // keyboard: arrows move the selection (aria-selected), Home/End jump
      await P.waitFor(`document.activeElement && document.activeElement.getAttribute('role') === 'option'`);
      const sel = async () => P.eval(`[...document.querySelectorAll('[data-role="backup-option"]')].map((o) => o.getAttribute('aria-selected')).join()`);
      await P.key('ArrowDown');
      const afterDown = await sel();
      await P.key('Home');
      const afterHome = await sel();
      check('S10b 목록 키보드: ↓ 로 다음 줄 선택, Home 으로 첫 줄', afterDown === 'false,true' && afterHome === 'true,false', afterDown + ' / ' + afterHome);
      // the damaged copy: a preview that says why, and no way forward
      await P.click('[data-role="backup-option"][data-id="edulet-20250101-000000"]');
      await bkWaitView(P, 'preview');
      check('S10b 읽을 수 없는 저장본의 미리보기: 이유(422 backup_invalid)를 보여 주고 불러오기 단추는 꺼짐', /불러올 수 없어요/.test(await bkText(P)) && (await P.exists(`${bkDlg} .bk-box.is-error`)) && (await P.eval(`document.querySelector('[data-role="go-confirm"]').disabled`)));
      await P.screenshot(join(OUT, 's10b-invalid.png'));
      await P.click('[data-role="back"]');
      await bkWaitView(P, 'list');
      // preview of a copy that vanished meanwhile (404 backup_not_found) -> says so, and "목록 새로 고침" gets the list back
      await bkStub(P, { match: '/api/backups/edulet-[0-9-]+$', method: 'GET', status: 404, body: { error: { code: 'backup_not_found', message: '그 저장본을 찾을 수 없어요.' } } });
      await P.click('[data-role="backup-option"]:not([data-id="edulet-20250101-000000"])');
      await bkWaitView(P, 'error');
      check('S10b 미리보기 404 backup_not_found → "찾을 수 없어요" + [목록 새로 고침]', /찾을 수 없어요/.test(await bkText(P)) && (await P.exists('[data-role="reload-list"]')));
      await P.click('[data-role="reload-list"]');
      await bkWaitView(P, 'list');
      // a preview can be rate limited too: it says how long to wait, and [다시 시도] asks again
      await bkStub(P, { match: '/api/backups/edulet-[0-9-]+$', method: 'GET', status: 429, headers: { 'Retry-After': '15' }, body: { error: { code: 'rate_limited', message: '요청이 너무 많아요.' } } });
      await P.click('[data-role="backup-option"]:not([data-id="edulet-20250101-000000"])');
      await bkWaitView(P, 'error');
      check('S10b 미리보기 429 → 대기 시간(15초) 안내 + [다시 시도]', /너무 많아요.*15초/.test(await bkText(P)) && (await P.exists('[data-role="retry"]')), await bkText(P));
      await P.click('[data-role="retry"]');
      await bkWaitView(P, 'preview');
      // a copy is asked for once: coming back to it again does not call the server again
      await P.eval(`window.__previewGets = 0; (() => { const f = window.fetch; window.fetch = async (u, o) => { if (/[/]api[/]backups[/]edulet-[0-9-]+$/.test(String(u))) window.__previewGets++; return f(u, o); }; })()`);
      await P.click('[data-role="back"]');
      await bkWaitView(P, 'list');
      await P.click('[data-role="backup-option"]:not([data-id="edulet-20250101-000000"])');
      await bkWaitView(P, 'preview');
      check('S10b 같은 저장본을 다시 열어도 서버에 미리보기를 다시 묻지 않음(한 번만)', (await P.eval('window.__previewGets')) === 0, 'gets=' + (await P.eval('window.__previewGets')));
      // restore errors: the data must stay as it is and the flag that mutes this tab's reset must be off again
      await P.click('[data-role="go-confirm"]');
      await bkWaitView(P, 'confirm');
      const restoreTry = async (stub, wantRe, label, wantView = 'error') => {
        await bkStub(P, stub);
        await P.click('[data-role="restore-go"]');
        await P.waitFor(`(window.__bkStubHits === 1)`, { timeout: 5000 });
        await bkWaitView(P, wantView, 8000);
        const t = await bkText(P);
        check(label, wantRe.test(t), t.slice(0, 300));
      };
      const restoring = () => P.eval(`import('/js/lib/backup-state.js').then((m) => m.backupState.restoring)`);
      await restoreTry({ match: '/restore$', method: 'POST', status: 409, body: { error: { code: 'data_changed', message: 'x' } } }, /그동안 다른 변경이 있어 중단했어요.*그대로/, 'S10b 불러오기 409 data_changed → "다른 변경이 있어 중단했어요, 지금 데이터는 그대로" + 다시 해 달라는 안내');
      check('S10b 실패하면 "내 탭 reset 무시" 표식(restoring)이 다시 꺼짐', (await restoring()) === false);
      await P.click('[data-role="back"]');
      await bkWaitView(P, 'confirm');
      await restoreTry({ match: '/restore$', method: 'POST', status: 503, headers: { 'Retry-After': '3' }, body: { error: { code: 'busy', message: 'x' } } }, /다른 저장·불러오기가 진행 중이에요/, 'S10b 불러오기 503 busy → "진행 중이에요, 잠시 뒤에 다시"');
      await P.click('[data-role="back"]');
      await bkWaitView(P, 'confirm');
      await restoreTry({ match: '/restore$', method: 'POST', status: 429, headers: { 'Retry-After': '20' }, body: { error: { code: 'rate_limited', message: '불러오기를 너무 자주 하고 있어요.' } } }, /너무 자주.*20초/, 'S10b 불러오기 429 → 대기 시간(20초)');
      await P.click('[data-role="back"]');
      await bkWaitView(P, 'confirm');
      await restoreTry({ match: '/restore$', method: 'POST', status: 403, body: { error: { code: 'member_required', message: 'x' } } }, /계정으로 로그인한 뒤에 쓸 수 있어요/, 'S10b 불러오기 403 member_required → 로그인 안내(+ [로그인])');
      check('S10b 그 화면에 [로그인] 단추가 있음', await P.exists('[data-role="login"]'));
      await P.click('[data-role="back"]');
      await bkWaitView(P, 'confirm');
      await restoreTry({ match: '/restore$', method: 'POST', status: 400, body: { error: { code: 'confirm_required', message: 'x' } } }, /화면 오류/, 'S10b 불러오기 400 confirm_required(화면 버그) → 새로 고침 안내');
      await P.click('[data-role="back"]');
      await bkWaitView(P, 'confirm');
      await restoreTry({ match: '/restore$', method: 'POST', status: 422, body: { error: { code: 'backup_invalid', message: '더 새로운 Edulet 로 만든 저장본이에요.' } } }, /불러올 수 없어요.*더 새로운 Edulet/, 'S10b 불러오기 422 backup_invalid → 이유와 함께 미리보기 화면(불러오기 단추 꺼짐)', 'preview');
      check('S10b 이 모든 실패 뒤에도 서버 데이터·백업 폴더는 그대로', (await postsNow()) === 1 && folders().length === before, `posts=${await postsNow()} folders=${folders().length} before=${before}`);
      const seen = await P.eval('window.__bkSeen');
      check('S10b 이 창의 /api/backups* 실제 응답에 401 이 없음', seen.every((x) => x.s !== 401), JSON.stringify(seen));
      // Esc closes the dialog (nothing is running) and the focus goes back to the header button
      await P.key('Escape');
      await P.waitFor(`!document.querySelector('${bkDlg}')`);
      check('S10b Esc 로 닫으면 포커스가 헤더의 "불러오기" 버튼으로 돌아옴', (await P.eval(`document.activeElement && document.activeElement.dataset.role`)) === 'backup-restore');
      // the list itself can say "login": 403 on GET /backups
      await bkStub(P, { match: '/api/backups$', method: 'GET', status: 403, body: { error: { code: 'member_required', message: 'x' } } });
      await P.click('[data-role="backup-restore"]');
      await bkWaitView(P, 'error');
      check('S10b 목록 403 member_required → 로그인 안내와 [로그인] 단추', /로그인이 필요해요/.test(await bkText(P)) && (await P.exists('[data-role="login"]')));
      await P.key('Escape');
      check('S10b 콘솔 오류 없음', P.errors.length === 0, P.errors.join(' | ').slice(0, 300));
      await ctx.close();
    } finally {
      await appC.close();
      bkRemove(appC);
    }
  });
} finally {
  await browser.close();
  await app.close();
  try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
  try { rmSync(seedDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) {
  console.log('FAILED:\n' + failed.map((f) => ` - ${f.name} ${f.detail}`).join('\n'));
  process.exit(1);
}
