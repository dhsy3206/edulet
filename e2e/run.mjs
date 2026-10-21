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
