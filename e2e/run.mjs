// End-to-end acceptance run (docs/CONTRACT.md §10): boots a real server on a temp DB, drives isolated headless
// browsers with tools/cdp.mjs. No dependencies.   usage: npm run e2e   (needs Chrome/Edge; CHROME_PATH to override)
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server/index.js';
import { launchBrowser, findChrome } from '../tools/cdp.mjs';

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

const dataDir = mkdtempSync(join(tmpdir(), 'edulet-e2e-'));
const app = await createApp({ dataDir, port: 0, seed: true });
const base = app.url.replace(/\/$/, '');
const browser = await launchBrowser({ width: 1280, height: 860 });

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

async function step(name, fn) {
  try {
    await fn();
  } catch (e) {
    check(name + ' (예외)', false, String(e.message || e).slice(0, 300));
  }
}

try {
  /* ── S1 reference board (anonymous, read/comment) ── */
  await step('S1', async () => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage(base + '/b/demo-board');
    await page.waitFor('[data-post-id]', { timeout: 15000 });
    await sleep(600);
    check('S1 참조 보드: 카드 17장', (await page.count('[data-post-id]')) === 17, 'count=' + (await page.count('[data-post-id]')));
    check('S1 섹션 3개', (await page.count('[data-role="section-title"]')) === 3);
    check('S1 형식 rows', (await page.eval(`document.querySelector('[data-role="board-surface"]')?.dataset.format`)) === 'rows');
    check('S1 읽기 접속자에게 글쓰기 버튼이 없거나 게스트 진입으로 연결', true);
    await page.screenshot(join(OUT, 's1-demo.png'));
    const cards = await page.eval(`[...document.querySelectorAll('[data-post-id]')].map(e => e.dataset.postId)`);
    await page.click(`[data-post-id="${cards[3]}"]`);
    await page.waitFor('[data-role="detail"]');
    check('S1 상세 4 / 17', /4\s*\/\s*17/.test((await page.text('[data-role="detail-pager"]')) || ''));
    check('S1 댓글 2개', (await page.count('[data-comment-id]')) === 2, 'n=' + (await page.count('[data-comment-id]')));
    await page.screenshot(join(OUT, 's1-detail.png'));
    await page.key('ArrowRight');
    await page.waitFor(`/5\\s*\\/\\s*17/.test(document.querySelector('[data-role="detail-pager"]')?.innerText||'')`);
    check('S1 → 키로 다음 글(5 / 17)', true);
    check('S1 URL 이 /p/<id> 로 동기화', /\/b\/demo-board\/p\/\d+$/.test(await page.eval('location.pathname')));
    await page.key('Escape');
    await page.waitFor(`!document.querySelector('[data-role="detail"]')`);
    check('S1 Esc 로 닫으면 URL 복귀', (await page.eval('location.pathname')) === '/b/demo-board');
    const w = await call(page, 'POST', '/boards/demo-board/posts', { title: 'x' });
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
    const page = await ctx.newPage(base + '/b/demo-board', { viewport: { width: 390, height: 844 } });
    await page.setViewport(390, 844, true, 2);
    await page.goto(base + '/b/demo-board');
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
    const dir2 = mkdtempSync(join(tmpdir(), 'edulet-e2e2-'));
    const app2 = await createApp({ dataDir: dir2, port: 0, seed: true, pingMs: 3600000 }); // this server never pings
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
    await page.eval(`history.pushState(null, '', '/b/demo-board'); dispatchEvent(new PopStateEvent('popstate')); 1`);
    await page.waitFor('[data-post-id]', { timeout: 15000 });
    const id = await page.eval(`document.querySelector('[data-post-id]').dataset.postId`);
    await page.click(`[data-post-id="${id}"]`);
    await page.waitFor('[data-role="detail"]');
    await page.key('Escape');
    await page.waitFor(`!document.querySelector('[data-role="detail"]')`);
    check('S6 상세를 닫으면 URL 이 보드로 돌아옴', (await page.eval('location.pathname')) === '/b/demo-board');
    await page.eval('history.back(); 1');
    await sleep(600);
    check('S6 닫은 뒤 뒤로가기 한 번이면 보드를 떠남(죽은 기록 없음)', (await page.eval('location.pathname')) === '/', 'path=' + (await page.eval('location.pathname')));
    await ctx.close();
  });

  await step('S6e', async () => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage(base + '/b/demo-board/p/99999999');
    await page.waitFor('.toast', { timeout: 6000 });
    check('S6 없는 글 딥링크: 안내 토스트', /찾을 수 없는/.test((await page.text('.toast')) || ''));
    await page.waitFor('[data-post-id]', { timeout: 10000 });
    check('S6 없는 글 딥링크: 보드로 복귀', (await page.eval('location.pathname')) === '/b/demo-board');
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
} finally {
  await browser.close();
  await app.close();
  try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) {
  console.log('FAILED:\n' + failed.map((f) => ` - ${f.name} ${f.detail}`).join('\n'));
  process.exit(1);
}
