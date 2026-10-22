// End-to-end acceptance run (docs/CONTRACT.md §10): boots a real server on a temp DB, drives isolated headless
// browsers with tools/cdp.mjs. No dependencies.   usage: npm run e2e   (needs Chrome/Edge; CHROME_PATH to override)
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir, networkInterfaces as osNetworkInterfaces } from 'node:os';
import net from 'node:net';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser, findChrome } from '../tools/cdp.mjs';
import { Client, createAppOnGoodPort, makeBoard, makeUser } from '../test/helpers.js';
import { startMockGoogle } from '../test/google-mock.js';
import { buildDemoBoard, makeSeedDir, stubPreviewFetcher } from './demo-board.mjs';

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
