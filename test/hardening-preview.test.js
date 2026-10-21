// Hardening: link-preview parser complexity (H1), outbound limits inside the service (M1), SSRF corner cases (L5, L6).
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { makeBoard, makeUser, sleep, startApp } from './helpers.js';
import { isBlockedIp, parseHtmlPreview } from '../server/preview.js';

const html = (title) => ({ status: 200, headers: { 'content-type': 'text/html' }, body: Buffer.from(`<title>${title}</title>`) });

describe('H1: the HTML parser is linear (no backtracking regexes over the page)', () => {
  const SIZE = 512 * 1024;
  const fill = (unit) => unit.repeat(Math.ceil(SIZE / unit.length)).slice(0, SIZE);
  const pathological = {
    'unterminated <meta': fill('<meta '),
    'unterminated <meta with an open quote': fill('<meta content="'),
    'unterminated <title': fill('<title '),
    '<title> never closed': '<title>' + 'x'.repeat(SIZE),
    'only "<"': '<'.repeat(SIZE),
    'attribute spam': fill('<meta a=b c=d e="f" '),
    'nested openers': fill('<title><meta '),
    'entity soup': '<meta property="og:title" content="' + '&amp'.repeat(SIZE / 4) + '">',
    'one huge tag': '<meta ' + 'a '.repeat(SIZE / 2),
  };

  for (const [label, input] of Object.entries(pathological)) {
    it(`512KB of ${label} parses in well under 200 ms`, () => {
      const t0 = performance.now();
      const r = parseHtmlPreview(input, 'https://x.test/');
      const ms = performance.now() - t0;
      assert.ok(ms < 200, `${label}: ${ms.toFixed(1)} ms`);
      assert.equal(typeof r.title, 'string');
    });
  }

  it('still finds the tags that matter: quotes containing ">", upper-case tags, first meta wins, junk before the real tags', () => {
    const p = parseHtmlPreview(
      '<META PROPERTY="og:title" CONTENT="a > b"><meta property="og:title" content="second">' + '<meta '.repeat(300) +
      '<TITLE>Plain</TITLE><meta name="description" content=\'it&#39;s fine\'><meta property="og:image" content="/i.png">',
      'https://example.com/dir/page',
    );
    assert.equal(p.title, 'a > b');
    assert.equal(p.description, "it's fine");
    assert.equal(p.image, 'https://example.com/i.png');
    assert.equal(parseHtmlPreview('<title>Only</title>', 'https://x.test/').title, 'Only');
    assert.equal(parseHtmlPreview('<title>never closed', 'https://x.test/').title, '');
    assert.equal(parseHtmlPreview('<titles>x</titles><title>real</title>', 'https://x.test/').title, 'real');
  });

  it('looks at the head only: tags after the first 128KB are ignored', () => {
    const pad = '<!-- ' + 'x'.repeat(130 * 1024) + ' -->';
    const p = parseHtmlPreview('<title>early</title>' + pad + '<meta property="og:description" content="late">', 'https://x.test/');
    assert.equal(p.title, 'early');
    assert.equal(p.description, '');
  });

  it('a hostile page does not stall the server (end to end, real fetch path)', async () => {
    const evil = fill('<meta ');
    const site = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(evil); });
    await new Promise((r) => site.listen(0, '127.0.0.1', r));
    const app = await startApp({ previewFetcher: null, allowPrivatePreviewHosts: true });
    try {
      const u = makeUser(app, 'evil');
      let worst = 0;
      let stop = false;
      const prober = (async () => {
        while (!stop) {
          const t0 = performance.now();
          await fetch(`${app.url}/api/health`);
          worst = Math.max(worst, performance.now() - t0);
          await sleep(5);
        }
      })();
      const t0 = performance.now();
      const r = await u.post('/api/link-preview', { url: `http://127.0.0.1:${site.address().port}/` });
      const total = performance.now() - t0;
      stop = true;
      await prober;
      assert.equal(r.status, 200);
      assert.ok(total < 2000, `preview took ${total.toFixed(0)} ms`);
      assert.ok(worst < 500, `health probe was blocked for ${worst.toFixed(0)} ms`);
    } finally { await app.close(); site.closeAllConnections(); site.close(); }
  });
});

describe('L5: embedded IPv4 in IPv6 forms is classified by the embedded address', () => {
  it('IPv4-translated ::ffff:0:a.b.c.d and NAT64 64:ff9b::/96', () => {
    for (const ip of ['::ffff:0:7f00:1', '::ffff:0:a9fe:a9fe', '::ffff:0:127.0.0.1', '::ffff:0:10.1.2.3', '::ffff:0:c0a8:1', '0:0:0:0:ffff:0:7f00:1',
      '64:ff9b::7f00:1', '64:ff9b::a9fe:a9fe', '64:ff9b::127.0.0.1', '64:ff9b::169.254.169.254', '64:ff9b:1::1']) {
      assert.equal(isBlockedIp(ip), true, `${ip} must be blocked`);
    }
    for (const ip of ['::ffff:0:808:808', '::ffff:0:8.8.8.8', '64:ff9b::808:808', '64:ff9b::8.8.8.8', '::ffff:8.8.8.8']) {
      assert.equal(isBlockedIp(ip), false, `${ip} embeds a public address`);
    }
  });
});

describe('M1: link-preview limits live inside the service (posts cannot bypass them)', () => {
  const linkPost = (c, slug, url) => c.post(`/api/boards/${slug}/posts`, { attachment: { kind: 'link', url } });

  it('60 concurrent link posts from one user: all saved, at most 20 outbound fetches, the rest get {title:url}', async () => {
    const calls = [];
    const app = await startApp({ previewFetcher: async (u) => { calls.push(u); return html('Fetched'); } });
    try {
      const u = makeUser(app, 'burst');
      const b = await makeBoard(u, { title: 'b' });
      const urls = Array.from({ length: 60 }, (_, i) => `https://site${i % 7}.example/p${i}`);
      const rs = await Promise.all(urls.map((url) => linkPost(u, b.slug, url)));
      for (const r of rs) assert.equal(r.status, 201, r.text);
      assert.ok(calls.length <= 20, `${calls.length} outbound fetches`);
      const fetched = rs.filter((r) => r.json.post.attachment.preview.title === 'Fetched').length;
      assert.equal(fetched, calls.length);
      rs.forEach((r, i) => {
        if (r.json.post.attachment.preview.title !== 'Fetched') assert.equal(r.json.post.attachment.preview.title, new URL(urls[i]).href, 'throttled -> minimal preview');
      });
    } finally { await app.close(); }
  });

  it('PATCH with a link attachment is throttled too', async () => {
    const calls = [];
    const app = await startApp({ previewFetcher: async (u) => { calls.push(u); return html('Fetched'); }, previewLimits: { userPerMin: 2 } });
    try {
      const u = makeUser(app, 'patcher');
      const b = await makeBoard(u, { title: 'b' });
      const p = (await u.post(`/api/boards/${b.slug}/posts`, { title: 'x' })).json.post;
      const titles = [];
      for (let i = 0; i < 4; i++) {
        const r = await u.patch(`/api/posts/${p.id}`, { attachment: { kind: 'link', url: `https://a${i}.example/` } });
        assert.equal(r.status, 200);
        titles.push(r.json.post.attachment.preview.title);
      }
      assert.deepEqual(titles, ['Fetched', 'Fetched', 'https://a2.example/', 'https://a3.example/']);
      assert.equal(calls.length, 2);
    } finally { await app.close(); }
  });

  it('per target host: many users, one host -> only hostPerMin outbound fetches, the others degrade', async () => {
    const calls = [];
    const app = await startApp({ previewFetcher: async (u) => { calls.push(u); return html('Fetched'); }, previewLimits: { hostPerMin: 3 } });
    try {
      const b = await makeBoard(makeUser(app, 'o'), { title: 'b', linkAccess: 'write' });
      const users = Array.from({ length: 10 }, () => makeUser(app, 'w'));
      const rs = await Promise.all(users.map((u, i) => linkPost(u, b.slug, `https://same-host.example/page${i}`)));
      for (const r of rs) assert.equal(r.status, 201);
      assert.equal(calls.length, 3);
      const other = await linkPost(users[0], b.slug, 'https://another-host.example/');
      assert.equal(other.json.post.attachment.preview.title, 'Fetched', 'other hosts have their own budget');
    } finally { await app.close(); }
  });

  it('global in-flight cap: concurrent fetches never exceed maxInFlight', async () => {
    let running = 0;
    let peak = 0;
    const gates = [];
    const fetcher = (u) => new Promise((resolve) => {
      running++; peak = Math.max(peak, running);
      gates.push(() => { running--; resolve(html('Fetched')); });
    });
    const app = await startApp({ previewFetcher: fetcher, previewLimits: { maxInFlight: 2, userPerMin: 1000, hostPerMin: 1000 } });
    try {
      const b = await makeBoard(makeUser(app, 'o'), { title: 'b', linkAccess: 'write' });
      const users = Array.from({ length: 6 }, () => makeUser(app, 'w'));
      const pending = users.map((u, i) => linkPost(u, b.slug, `https://h${i}.example/`));
      await sleep(150);
      assert.equal(gates.length, 2, 'only two fetches started; the others did not wait or fail');
      gates.splice(0).forEach((g) => g());
      const rs = await Promise.all(pending);
      for (const r of rs) assert.equal(r.status, 201);
      assert.equal(peak, 2);
      assert.equal(rs.filter((r) => r.json.post.attachment.preview.title === 'Fetched').length, 2);
    } finally { await app.close(); }
  });

  it('concurrent requests for the same URL share one fetch', async () => {
    const calls = [];
    const app = await startApp({ previewFetcher: async (u) => { calls.push(u); await sleep(60); return html('Shared'); } });
    try {
      const b = await makeBoard(makeUser(app, 'o'), { title: 'b', linkAccess: 'write' });
      const users = Array.from({ length: 5 }, () => makeUser(app, 'w'));
      const rs = await Promise.all(users.map((u) => linkPost(u, b.slug, 'https://one.example/same')));
      assert.equal(calls.length, 1);
      for (const r of rs) assert.equal(r.json.post.attachment.preview.title, 'Shared');
    } finally { await app.close(); }
  });

  it('/api/link-preview: per-user limit stays a 429, a throttled host or a busy server answers a bare preview (200)', async () => {
    const app = await startApp({ previewFetcher: async () => html('Fetched'), previewLimits: { hostPerMin: 1, userPerMin: 3 } });
    try {
      const u = makeUser(app, 'ep');
      const a = await u.post('/api/link-preview', { url: 'https://h.example/a' });
      assert.equal(a.json.title, 'Fetched');
      const b = await u.post('/api/link-preview', { url: 'https://h.example/b' });
      assert.equal(b.status, 200);
      assert.equal(b.json.title, 'https://h.example/b');
      assert.deepEqual(Object.keys(b.json).sort(), ['description', 'image', 'kind', 'site', 'title', 'url']);
      await u.post('/api/link-preview', { url: 'https://h.example/a' }); // cache hit, still counts for the user
      const over = await u.post('/api/link-preview', { url: 'https://h.example/a' });
      assert.equal(over.status, 429);
      assert.equal(over.json.error.code, 'rate_limited');
      assert.ok(over.headers.get('retry-after'));
    } finally { await app.close(); }
  });
});

describe('L6: a name that resolves to a private address looks like an unreachable one', () => {
  let app;
  const dnsLookup = (host, opts, cb) => {
    if (host === 'internal.example') return cb(null, [{ address: '10.0.0.5', family: 4 }]);
    if (host === 'loop6.example') return cb(null, [{ address: '::1', family: 6 }]);
    if (host === 'mixed.example') return cb(null, [{ address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 }]);
    const e = new Error(`getaddrinfo ENOTFOUND ${host}`);
    e.code = 'ENOTFOUND';
    return cb(e);
  };
  before(async () => { app = await startApp({ previewFetcher: null, previewDnsLookup: dnsLookup }); });
  after(async () => { await app.close(); });

  it('/api/link-preview answers identically for resolves-to-private, mixed answers and unresolvable names', async () => {
    const shape = async (host) => {
      const r = await makeUser(app, 'dns').post('/api/link-preview', { url: `https://${host}/x` });
      assert.equal(r.status, 200, `${host}: ${r.text}`);
      return { ...r.json, url: '', site: '', title: r.json.title === `https://${host}/x` ? 'URL' : r.json.title };
    };
    const [a, b, c, d] = [await shape('internal.example'), await shape('loop6.example'), await shape('mixed.example'), await shape('nowhere.example')];
    assert.deepEqual(a, d);
    assert.deepEqual(b, d);
    assert.deepEqual(c, d);
    assert.equal(d.title, 'URL');
  });

  it('URL-text-only blocks (literal IPs, localhost) stay a visible 400 blocked_url', async () => {
    for (const url of ['http://127.0.0.1/', 'http://[::1]/', 'http://10.1.1.1:8080/', 'http://localhost/', 'http://sub.localhost/', 'http://LOCALHOST./']) {
      const r = await makeUser(app, 'dns').post('/api/link-preview', { url });
      assert.equal(r.status, 400, url);
      assert.equal(r.json.error.code, 'blocked_url');
    }
  });

  it('saving a post with such a link stores the same minimal preview as for an unreachable one', async () => {
    const u = makeUser(app, 'dns');
    const b = await makeBoard(u, { title: 'b' });
    const prev = async (host) => (await u.post(`/api/boards/${b.slug}/posts`, { attachment: { kind: 'link', url: `https://${host}/x` } })).json.post.attachment.preview;
    assert.deepEqual(await prev('internal.example'), { title: 'https://internal.example/x', site: 'internal.example' });
    assert.deepEqual(await prev('nowhere.example'), { title: 'https://nowhere.example/x', site: 'nowhere.example' });
  });
});
