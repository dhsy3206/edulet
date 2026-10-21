import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Client, makeBoard, makeUser, startApp } from './helpers.js';
import { classifyVideo, isBlockedIp, parseHtmlPreview } from '../server/preview.js';

function listen(handler) {
  return new Promise((resolve) => {
    const hits = [];
    const server = http.createServer((req, res) => { hits.push(req.url); handler(req, res, hits); });
    server.listen(0, '127.0.0.1', () => resolve({ server, hits, port: server.address().port, base: `http://127.0.0.1:${server.address().port}` }));
  });
}
const closeServer = (s) => new Promise((r) => { s.server.closeAllConnections(); s.server.close(r); });
const html = (body, type = 'text/html; charset=utf-8') => (req, res) => { res.writeHead(200, { 'content-type': type }); res.end(body); };

describe('SSRF address classification (unit)', () => {
  it('blocks loopback, private, link-local, CGNAT, multicast, ULA, documentation, mapped and unknown addresses', () => {
    const blocked = [
      '127.0.0.1', '127.255.255.254', '0.0.0.0', '0.1.2.3', '10.0.0.1', '10.255.255.255', '172.16.0.1', '172.31.255.255',
      '192.168.0.1', '169.254.169.254', '169.254.0.1', '100.64.0.1', '100.127.255.255', '192.0.0.1', '192.0.2.5', '198.18.0.1', '198.19.255.1',
      '198.51.100.7', '203.0.113.9', '224.0.0.1', '239.255.255.250', '240.0.0.1', '255.255.255.255',
      '::', '::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.1', '::ffff:169.254.169.254', '::ffff:c0a8:0101',
      'fc00::1', 'fd12:3456:789a::1', 'fe80::1', 'fe80::1%eth0', 'febf::1', 'fec0::1', 'ff02::1', 'ff00::', '2001:db8::1', '2001:0::1',
      '64:ff9b::7f00:1', '64:ff9b::a00:1', '2002:7f00:1::', '2002:0a00:0001::', '::127.0.0.1', '0:0:0:0:0:0:0:1', '100::1',
      'not-an-ip', '', '1.2.3', '256.1.1.1', '[::1]',
    ];
    for (const ip of blocked) assert.equal(isBlockedIp(ip), true, `${ip} must be blocked`);
  });

  it('allows ordinary public addresses', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.15.255.255', '172.32.0.1', '100.63.255.255', '100.128.0.1', '169.253.1.1', '192.0.1.1', '198.17.0.1', '223.255.255.255',
      '2606:4700:4700::1111', '2001:4860:4860::8888', '2a00:1450:4001:81b::200e', '64:ff9b::808:808', '2002:0808:0808::', '::ffff:8.8.8.8']) {
      assert.equal(isBlockedIp(ip), false, `${ip} should be allowed`);
    }
  });
});

describe('URL classification and HTML parsing (unit)', () => {
  it('YouTube (watch, youtu.be, shorts, embed, live) and Vimeo', () => {
    const id = 'dQw4w9WgXcQ';
    for (const u of [`https://www.youtube.com/watch?v=${id}`, `https://youtube.com/watch?v=${id}&t=10`, `https://m.youtube.com/watch?v=${id}`, `https://youtu.be/${id}?si=abc`,
      `https://www.youtube.com/shorts/${id}`, `https://www.youtube.com/embed/${id}`, `https://www.youtube.com/live/${id}`, `https://music.youtube.com/watch?v=${id}`]) {
      const v = classifyVideo(u);
      assert.ok(v, u);
      assert.equal(v.embedUrl, `https://www.youtube-nocookie.com/embed/${id}`);
      assert.equal(v.image, `https://i.ytimg.com/vi/${id}/hqdefault.jpg`);
    }
    const vm = classifyVideo('https://vimeo.com/76979871');
    assert.equal(vm.embedUrl, 'https://player.vimeo.com/video/76979871');
    assert.equal(classifyVideo('https://player.vimeo.com/video/76979871').embedUrl, 'https://player.vimeo.com/video/76979871');
    for (const u of ['https://www.youtube.com/', 'https://www.youtube.com/watch?v=short', 'https://www.youtube.com/user/x', 'https://notyoutube.com/watch?v=dQw4w9WgXcQ',
      'https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ', 'https://vimeo.com/channels/staffpicks', 'https://example.com/']) {
      assert.equal(classifyVideo(u), null, u);
    }
  });

  it('parses OpenGraph / Twitter / title / description, resolves relative images and decodes entities', () => {
    const p = parseHtmlPreview(`<!doctype html><html><head>
      <title> Fallback &amp; title </title>
      <meta property="og:title" content="Hello &quot;World&quot; &#39;x&#39; &#x1F600;">
      <meta property="og:description" content='Line one
        and   two'>
      <meta name="twitter:image" content="/img/card.png">
      <meta property="og:site_name" content="Example Site">
    </head></html>`, 'https://example.com/a/b');
    assert.equal(p.title, 'Hello "World" \'x\' \u{1F600}');
    assert.equal(p.description, 'Line one and two');
    assert.equal(p.image, 'https://example.com/img/card.png');
    assert.equal(p.site, 'Example Site');
    const q = parseHtmlPreview('<title>Only title</title><meta name="description" content="plain desc"><meta property="og:image" content="javascript:alert(1)">', 'https://x.test/');
    assert.deepEqual(q, { title: 'Only title', description: 'plain desc', image: null, site: '' });
    assert.equal(parseHtmlPreview('<meta property="og:image" content="data:image/png;base64,AAAA"><title>t</title>', 'https://x.test/').image, null);
    assert.equal(parseHtmlPreview('<title>' + 'x'.repeat(500) + '</title>', 'https://x.test/').title.length, 200);
  });
});

describe('POST /api/link-preview: SSRF guard (real network code path)', () => {
  let app;
  let local;
  before(async () => {
    local = await listen(html('<title>secret</title>'));
    app = await startApp({ previewFetcher: null });
  });
  after(async () => { await app.close(); await closeServer(local); });

  // a fresh account per call: the endpoint allows only 20 requests per user per minute
  const preview = (url, c = makeUser(app, 'pv')) => c.post('/api/link-preview', { url });

  it('requires login', async () => {
    assert.equal((await preview('https://example.com', new Client(app))).status, 401);
  });

  it('refuses loopback / private / link-local / metadata / IPv6 targets without connecting', async () => {
    const targets = [
      local.base + '/', 'http://localhost:1/', 'http://127.0.0.1/', 'http://127.1/', 'http://2130706433/', 'http://0x7f.0.0.1/', 'http://0177.0.0.1/', 'http://10.0.0.1/', 'http://10.255.255.255:8080/x',
      'http://172.16.5.4/', 'http://192.168.1.1/admin', 'http://169.254.169.254/latest/meta-data/', 'http://[::1]/', 'http://[::1]:8080/', 'http://[::ffff:127.0.0.1]/', 'http://[::ffff:7f00:1]/',
      'http://[fd00::1]/', 'http://[fe80::1]/', 'http://100.64.0.1/', 'http://0.0.0.0/', 'http://224.0.0.1/', 'http://[::]/', 'https://localhost/',
    ];
    for (const url of targets) {
      const r = await preview(url);
      assert.equal(r.status, 400, `${url} -> ${r.status} ${r.text}`);
      assert.equal(r.json.error.code, 'blocked_url', url);
    }
    assert.equal(local.hits.length, 0, 'the loopback server was never contacted');
  });

  it('refuses non-http(s) schemes and junk (400 bad_url)', async () => {
    for (const url of ['javascript:alert(1)', 'ftp://example.com/', 'file:///etc/passwd', 'data:text/html,hi', 'gopher://x/', 'ws://example.com/', 'example.com', '', '   ', 'http://', 'http://user:pw@@', 'http://exa mple.com/', 'x'.repeat(3000)]) {
      const r = await preview(url);
      assert.equal(r.status, 400, `${JSON.stringify(url.slice(0, 40))} -> ${r.status}`);
      assert.equal(r.json.error.code, 'bad_url');
    }
    assert.equal((await makeUser(app, 'pv').post('/api/link-preview', {})).status, 400);
    assert.equal((await makeUser(app, 'pv').post('/api/link-preview', { url: 42 })).status, 400);
    assert.equal((await makeUser(app, 'pv').post('/api/link-preview', { url: ['https://example.com'] })).status, 400);
  });

  it('URLs with credentials are not fetched', async () => {
    const r = await preview('http://user:pass@example.com/');
    assert.equal(r.status, 400);
  });
});

describe('POST /api/link-preview: fetching (loopback allowed via the test-only injection point)', () => {
  let app;
  let user;
  let site;
  before(async () => {
    site = await listen((req, res, hits) => {
      if (req.url === '/page') return html(`<html><head><title>Fallback</title>
        <meta property="og:title" content="Page &amp; Title"><meta property="og:description" content="A &lt;b&gt; page">
        <meta property="og:image" content="/pic.png"><meta property="og:site_name" content="Demo"></head><body>ok</body></html>`)(req, res);
      if (req.url === '/cached') return html('<title>Cached</title>')(req, res);
      if (req.url === '/text') return html('<title>nope</title>', 'text/plain')(req, res);
      if (req.url === '/json') return html('{"title":"nope"}', 'application/json')(req, res);
      if (req.url === '/image') { res.writeHead(200, { 'content-type': 'image/png' }); return res.end('x'); }
      if (req.url === '/big') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.write('<title>Early title</title>');
        res.write('x'.repeat(600 * 1024));
        res.write('<meta property="og:description" content="LATE">');
        return res.end();
      }
      if (req.url === '/redir1') { res.writeHead(302, { location: '/redir2' }); return res.end(); }
      if (req.url === '/redir2') { res.writeHead(301, { location: '/page' }); return res.end(); }
      if (req.url.startsWith('/loop')) { res.writeHead(302, { location: '/loop' + hits.length }); return res.end(); }
      if (req.url === '/hang') return undefined; // never answers
      if (req.url === '/404') { res.writeHead(404, { 'content-type': 'text/html' }); return res.end('<title>Not here</title>'); }
      if (req.url === '/latin1') { res.writeHead(200, { 'content-type': 'text/html; charset=euc-kr' }); return res.end(Buffer.from([0x3c, 0x74, 0x69, 0x74, 0x6c, 0x65, 0x3e, 0xb0, 0xa1, 0x3c, 0x2f, 0x74, 0x69, 0x74, 0x6c, 0x65, 0x3e])); }
      res.writeHead(404); return res.end();
    });
    app = await startApp({ previewFetcher: null, allowPrivatePreviewHosts: true, previewTimeoutMs: 400 });
    user = makeUser(app, 'pv2');
  });
  after(async () => { await app.close(); await closeServer(site); });
  const preview = (path, c = user) => c.post('/api/link-preview', { url: site.base + path });

  it('returns title, description, absolute image, site and kind=link', async () => {
    const r = await preview('/page');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, {
      url: `${site.base}/page`, kind: 'link', title: 'Page & Title', description: 'A <b> page',
      image: `${site.base}/pic.png`, site: 'Demo',
    });
  });

  it('caches results for 10 minutes (a second request does not hit the origin)', async () => {
    const before = site.hits.filter((u) => u === '/cached').length;
    const a = await preview('/cached');
    const b = await preview('/cached');
    assert.deepEqual(a.json, b.json);
    assert.equal(site.hits.filter((u) => u === '/cached').length - before, 1);
  });

  it('only text/html is parsed; other content types degrade to a bare preview', async () => {
    for (const path of ['/text', '/json']) {
      const r = await preview(path);
      assert.equal(r.status, 200);
      assert.equal(r.json.kind, 'link');
      assert.equal(r.json.description, '');
      assert.equal(r.json.image, null);
      assert.notEqual(r.json.title, 'nope');
    }
    const img = await preview('/image');
    assert.equal(img.json.image, `${site.base}/image`);
    const nf = await preview('/404');
    assert.equal(nf.status, 200);
    assert.notEqual(nf.json.title, 'Not here', 'error pages are not parsed');
  });

  it('reads at most 512KB of the body', async () => {
    const r = await preview('/big');
    assert.equal(r.status, 200);
    assert.equal(r.json.title, 'Early title');
    assert.equal(r.json.description, '', 'content past 512KB is ignored');
  });

  it('follows redirects (relative and chained)', async () => {
    const r = await preview('/redir1');
    assert.equal(r.status, 200);
    assert.equal(r.json.title, 'Page & Title');
  });

  it('gives up after 3 redirects and after the timeout, but still answers 200 with a bare preview', async () => {
    const loop = await preview('/loop');
    assert.equal(loop.status, 200);
    assert.equal(loop.json.description, '');
    const t0 = Date.now();
    const hang = await preview('/hang');
    assert.equal(hang.status, 200);
    assert.ok(Date.now() - t0 < 3000, 'timeout fired');
    assert.equal(hang.json.title, `${site.base}/hang`);
    const dead = await user.post('/api/link-preview', { url: 'http://127.0.0.1:1/' });
    assert.equal(dead.status, 200, 'connection refused degrades gracefully');
  });

  it('decodes the declared charset', async () => {
    const r = await preview('/latin1');
    assert.equal(r.json.title, '가');
  });

  it('rate limit: 20 per minute per user, then 429', async () => {
    const u = makeUser(app, 'rl');
    for (let i = 0; i < 20; i++) assert.equal((await u.post('/api/link-preview', { url: `${site.base}/cached` })).status, 200);
    const r = await u.post('/api/link-preview', { url: `${site.base}/cached` });
    assert.equal(r.status, 429);
    assert.equal(r.json.error.code, 'rate_limited');
    assert.equal((await user.post('/api/link-preview', { url: `${site.base}/cached` })).status, 200, 'other users are unaffected');
  });
});

describe('redirects are re-checked on every hop', () => {
  let a;
  let b;
  let app;
  let user;
  before(async () => {
    b = await listen(html('<title>internal secret</title>'));
    a = await listen((req, res) => {
      if (req.url === '/to-internal') { res.writeHead(302, { location: `${b.base}/secret` }); return res.end(); }
      if (req.url === '/to-metadata') { res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' }); return res.end(); }
      if (req.url === '/to-v6') { res.writeHead(307, { location: 'http://[::1]:1/' }); return res.end(); }
      if (req.url === '/to-file') { res.writeHead(302, { location: 'file:///etc/passwd' }); return res.end(); }
      if (req.url === '/to-js') { res.writeHead(302, { location: 'javascript:alert(1)' }); return res.end(); }
      if (req.url === '/to-self') { res.writeHead(302, { location: '/ok' }); return res.end(); }
      if (req.url === '/ok') return html('<title>fine</title>')(req, res);
      res.writeHead(404); return res.end();
    });
    // only A (127.0.0.1:portA) is allowed to be loopback-connected; B and everything else stay blocked
    app = await startApp({ previewFetcher: null, allowPrivatePreviewHosts: [`127.0.0.1:${a.port}`] });
    user = makeUser(app, 'redir');
  });
  after(async () => { await app.close(); await closeServer(a); await closeServer(b); });

  it('sanity: the allow-listed host works, same-host redirect works', async () => {
    assert.equal((await user.post('/api/link-preview', { url: `${a.base}/ok` })).json.title, 'fine');
    assert.equal((await user.post('/api/link-preview', { url: `${a.base}/to-self` })).json.title, 'fine');
    assert.equal((await user.post('/api/link-preview', { url: `${b.base}/secret` })).json.error.code, 'blocked_url', 'B itself is not allow-listed');
  });

  it('redirect to another loopback server / metadata IP / IPv6 loopback / non-http scheme is refused', async () => {
    for (const path of ['/to-internal', '/to-metadata', '/to-v6', '/to-file', '/to-js']) {
      const r = await user.post('/api/link-preview', { url: `${a.base}${path}` });
      assert.equal(r.status, 400, `${path} -> ${r.status} ${r.text}`);
      assert.equal(r.json.error.code, 'blocked_url', path);
    }
    assert.equal(b.hits.length, 0, 'the internal server never saw a request');
  });
});

describe('link preview: switches, videos, attachments', () => {
  it('EDULET_LINK_PREVIEW=0: no outbound request, host name only', async () => {
    const site = await listen(html('<title>should not be read</title>'));
    const app = await startApp({ previewFetcher: null, allowPrivatePreviewHosts: true, config: { linkPreview: false } });
    try {
      const u = makeUser(app, 'off');
      const r = await u.post('/api/link-preview', { url: `${site.base}/x` });
      assert.equal(r.status, 200);
      assert.equal(r.json.title, '127.0.0.1');
      assert.equal(r.json.site, '127.0.0.1');
      assert.equal(r.json.description, '');
      assert.equal(r.json.image, null);
      assert.equal(site.hits.length, 0);
      assert.equal((await new Client(app).get('/api/config')).json.linkPreview, false);
    } finally { await app.close(); await closeServer(site); }
  });

  it('YouTube / Vimeo -> kind=video with nocookie embed URL and thumbnail (page title via the fetcher)', async () => {
    const seen = [];
    const app = await startApp({
      previewFetcher: async (u) => { seen.push(u); return { status: 200, headers: { 'content-type': 'text/html' }, body: Buffer.from('<meta property="og:title" content="Never Gonna"><meta property="og:image" content="https://evil.example/x.jpg">') }; },
    });
    try {
      const u = makeUser(app, 'yt');
      let r = await u.post('/api/link-preview', { url: 'https://youtu.be/dQw4w9WgXcQ' });
      assert.equal(r.status, 200);
      assert.equal(r.json.kind, 'video');
      assert.equal(r.json.title, 'Never Gonna');
      assert.equal(r.json.embedUrl, 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ');
      assert.equal(r.json.image, 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg', 'thumbnail comes from ytimg, not from page content');
      assert.equal(r.json.site, 'YouTube');
      r = await u.post('/api/link-preview', { url: 'https://vimeo.com/76979871' });
      assert.equal(r.json.kind, 'video');
      assert.equal(r.json.embedUrl, 'https://player.vimeo.com/video/76979871');
      const b = await makeBoard(u, { title: 'v' });
      const p = await u.post(`/api/boards/${b.slug}/posts`, { attachment: { kind: 'video', url: 'https://www.youtube.com/shorts/dQw4w9WgXcQ' } });
      assert.equal(p.status, 201);
      assert.equal(p.json.post.attachment.kind, 'video');
      assert.equal(p.json.post.attachment.preview.embedUrl, 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ');
      assert.ok(seen.length >= 2);
    } finally { await app.close(); }
  });

  it('saving a post never fails because of the preview: unreachable and blocked targets store a plain link', async () => {
    const site = await listen(html('<title>secret</title>'));
    const app = await startApp({ previewFetcher: null }); // real fetch path, loopback NOT allowed
    try {
      const u = makeUser(app, 'save');
      const b = await makeBoard(u, { title: 's' });
      const post = (url) => u.post(`/api/boards/${b.slug}/posts`, { attachment: { kind: 'link', url } });
      for (const url of [`${site.base}/internal`, 'http://169.254.169.254/latest', 'http://[::1]:9/', 'http://127.0.0.1:1/']) {
        const r = await post(url);
        assert.equal(r.status, 201, url);
        assert.equal(r.json.post.attachment.kind, 'link');
        assert.equal(r.json.post.attachment.url, new URL(url).href);
        assert.equal(r.json.post.attachment.preview.title, new URL(url).href, 'minimal {title:url} preview');
        assert.equal(r.json.post.attachment.preview.image, undefined);
      }
      assert.equal(site.hits.length, 0, 'blocked target was never contacted');
    } finally { await app.close(); await closeServer(site); }
  });
});
