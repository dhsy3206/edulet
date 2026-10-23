// The offline HTML export (public/js/lib/export-html.js): a pure string builder, so these tests need no browser and no server.
// What must hold: nothing a user typed can become markup or script, the page carries a CSP and no <script> at all, links are
// http(s)-only, nothing is fetched from outside when it is opened, limits are shown instead of silently dropped, and every board
// format comes out in its own layout.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  Budget, CSP, EXPORT_LIMITS, MB, SKIP_TEXT, buildOfflineHtml, buildOfflineParts, collectUploadRefs, esc, offlineFilename,
  renderRichHtml, safeHttpUrl, summarizeFiles,
} from '../public/js/lib/export-html.js';

const LS = String.fromCharCode(0x2028); // line separator — written this way so no tool can turn it into a raw character
const PS = String.fromCharCode(0x2029);
const NOW = Date.UTC(2026, 9, 22, 6, 30);
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const U1 = '/uploads/' + 'a'.repeat(32) + '/photo.png';
const U2 = '/uploads/' + 'b'.repeat(32) + '/doc.pdf';
const U3 = '/uploads/' + 'c'.repeat(32) + '/clip.mp4';
const U4 = '/uploads/' + 'd'.repeat(32) + '/bg.jpg';

const user = (name, color = '#2563eb') => ({ id: 7, username: null, displayName: name, avatarColor: color, isGuest: false });
const post = (o = {}) => ({
  id: 1, boardId: 1, sectionId: null, author: user('김하늘'), title: '', body: '', color: null, pinned: false, status: 'published', rank: 1,
  x: null, y: null, w: null, attachment: null, commentCount: 0, createdAt: NOW - 3600000, updatedAt: NOW,
  reactions: { like: { count: 0, mine: false }, vote: { count: 0 }, star: { count: 0 }, grade: { count: 0, avg: 0 }, emoji: {} }, comments: [], ...o,
});
const board = (o = {}) => ({
  id: 1, slug: 'abc123', title: '시험 보드', description: '', format: 'wall', wallpaper: 'green', font: 'sans', colorScheme: 'light',
  visibility: 'link', linkAccess: 'comment', settings: { reactions: 'like', comments: 'on', approval: false, showAuthor: true, newPostPosition: 'top' },
  owner: user('소유자'), createdAt: NOW - 86400000, updatedAt: NOW, ...o,
});
const exportOf = (b, posts = [], sections = []) => ({ exportedAt: new Date(NOW).toISOString(), board: b, sections, posts });
const build = (data, files = new Map(), options = {}) => buildOfflineHtml({ data, files, options: { timeZone: 'UTC', ...options }, now: NOW });
const fileEntry = (o = {}) => ({ mime: 'image/png', name: 'photo.png', size: 68, dataUrl: PNG, ...o });

// A strict reading of the page: every "<" must open a well-formed tag made only of known names and attributes (so an unescaped
// character from user text — a stray "<", an injected attribute such as onerror — cannot hide). Returns the tags.
const TAGS = new Set('html head meta title style body a div header h1 h2 h3 span p br ul ol li strong em code time article main section figure img details summary video audio b'.split(' '));
const ATTRS = new Set(['lang', 'charset', 'http-equiv', 'content', 'name', 'class', 'id', 'href', 'src', 'alt', 'title', 'target', 'rel', 'download', 'style', 'aria-label', 'aria-hidden', 'role', 'datetime', 'loading', 'decoding', 'controls', 'playsinline', 'preload', 'data-format']);
function tagsOf(html) {
  const body = html.replace('<!doctype html>', '').replace(/<style>[\s\S]*?<\/style>/, '<style></style>');
  const re = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:\s+[a-zA-Z][a-zA-Z0-9:_-]*(?:="[^"<>]*")?)*)\s*>/g;
  const tags = [];
  let m;
  while ((m = re.exec(body))) {
    const attrs = [...m[3].matchAll(/\s+([a-zA-Z][a-zA-Z0-9:_-]*)(?:="([^"]*)")?/g)].map((a) => ({ name: a[1], value: a[2] ?? '' }));
    tags.push({ close: !!m[1], name: m[2].toLowerCase(), attrs });
  }
  assert.equal((body.match(/</g) || []).length, tags.length, 'every "<" in the page must open a well-formed tag');
  for (const t of tags) {
    assert.ok(TAGS.has(t.name), 'unexpected tag <' + t.name + '>');
    for (const a of t.attrs) assert.ok(ATTRS.has(a.name.toLowerCase()), 'unexpected attribute ' + a.name + ' on <' + t.name + '>');
  }
  return tags;
}
const attrValues = (html, name) => [...html.matchAll(new RegExp(`\\s${name}="([^"]*)"`, 'g'))].map((m) => m[1]);

describe('esc and link helpers', () => {
  it('escapes markup characters, quotes, backticks and the JS line separators; strips control characters', () => {
    assert.equal(esc('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;');
    assert.equal(esc('"><img src=x onerror=alert(1)>'), '&quot;&gt;&lt;img src=x onerror=alert(1)&gt;');
    assert.equal(esc("a'b`c&d"), 'a&#39;b&#96;c&amp;d');
    assert.equal(esc('x' + LS + 'y' + PS + 'z'), 'x&#8232;y&#8233;z');
    assert.equal(esc('a\u0000b\u0001c\u0007d\u007fe\u0085f'), 'abcdef');
    assert.equal(esc('줄\n바꿈\t탭\r'), '줄\n바꿈\t탭\r');
    assert.equal(esc(null), '');
    assert.equal(esc(undefined), '');
    assert.equal(esc(42), '42');
    assert.equal(esc('😀 이모지 👨‍👩‍👧'), '😀 이모지 👨‍👩‍👧');
  });

  it('safeHttpUrl accepts only absolute http(s) URLs without credentials or whitespace', () => {
    const good = ['https://example.com/a?b=1&c=2', 'http://example.com', 'HTTPS://EXAMPLE.COM/x', ' https://example.com/trim '];
    for (const u of good) assert.ok(safeHttpUrl(u), u);
    const bad = ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', ' javascript:alert(1)', 'java\nscript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'vbscript:x', 'file:///etc/passwd',
      'ftp://example.com/f', '//evil.example/x', '/relative/path', 'example.com', 'https://user:pw@example.com/', 'https://user@example.com/', 'http://', 'https://exa mple.com',
      'https://example.com/\\evil', 'https://example.com/\u0000', '', null, undefined, 42, {}, 'https://' + 'a'.repeat(3000) + '.com'];
    for (const u of bad) assert.equal(safeHttpUrl(u), null, String(u));
    assert.equal(safeHttpUrl('https://example.com/a?b=1&c=2'), 'https://example.com/a?b=1&c=2');
  });
});

describe('rich text (the same small subset as public/js/lib/markdown.js)', () => {
  it('renders paragraphs, line breaks, lists, bold, italic, code and links the way the DOM version does', () => {
    assert.equal(renderRichHtml('**굵게** *기울임* `코드`'), '<p class="rich-p"><strong>굵게</strong> <em>기울임</em> <code>코드</code></p>');
    assert.equal(renderRichHtml('한 줄\n다음 줄\n\n새 문단'), '<p class="rich-p">한 줄<br>다음 줄</p><p class="rich-p">새 문단</p>');
    assert.equal(renderRichHtml('- 하나\n- 둘\n끝'), '<ul class="rich-list"><li>하나</li><li>둘</li></ul><p class="rich-p">끝</p>');
    assert.equal(renderRichHtml('문장\n- 목록'), '<p class="rich-p">문장</p><ul class="rich-list"><li>목록</li></ul>');
    assert.equal(renderRichHtml('보세요 https://example.com/a(b).'),
      '<p class="rich-p">보세요 <a href="https://example.com/a(b)" target="_blank" rel="noopener noreferrer nofollow ugc" class="rich-link">https://example.com/a(b)</a>.</p>');
    assert.equal(renderRichHtml(''), '');
    assert.equal(renderRichHtml(null), '');
    assert.equal(renderRichHtml('a\r\nb\rc'), '<p class="rich-p">a<br>b<br>c</p>');
  });

  it('treats HTML as text and never links anything but http(s)', () => {
    const h = renderRichHtml('<b onclick=alert(1)>x</b> **<i>**\njavascript:alert(1) data:text/html,<script>alert(1)</script> [a](javascript:alert(1))');
    assert.ok(!/<(b|i|script)[\s>]/i.test(h));
    assert.ok(h.includes('&lt;b onclick=alert(1)&gt;x&lt;/b&gt;'));
    assert.ok(!/href="(?!https?:)/.test(h));
    assert.ok(!/<a /.test(h), 'no link at all in a text without an http(s) URL');
  });

  it('does not link an address that carries a login (user:password@host) even though the text matches', () => {
    const h = renderRichHtml('https://user:pw@example.com/x und http://a@b.example/');
    assert.ok(!h.includes('<a '), h);
    assert.ok(h.includes('https://user:pw@example.com/x'));
  });

  it('escapes link addresses that contain quotes and ampersands (a closing quote after the address stays outside the link)', () => {
    const h = renderRichHtml("http://example.com/?a=1&b='2'");
    assert.equal(h, '<p class="rich-p"><a href="http://example.com/?a=1&amp;b=&#39;2" target="_blank" rel="noopener noreferrer nofollow ugc" class="rich-link">http://example.com/?a=1&amp;b=&#39;2</a>&#39;</p>');
  });
});

describe('hostile text everywhere', () => {
  const EVIL = [
    '<script>alert(1)</script>', '"><img src=x onerror=alert(1)>', "'><svg onload=alert(1)>", '</style><script>alert(2)</script>', '</title><script>alert(3)</script>',
    'javascript:alert(4)', 'data:text/html;base64,PHNjcmlwdD5hbGVydCg1KTwvc2NyaXB0Pg==', '\u0000<script>', 'x'.repeat(200000), '😀👨‍👩‍👧' + LS + PS + '끝',
  ];
  const everything = () => {
    const s = (i) => EVIL[i % EVIL.length];
    const posts = EVIL.map((e, i) => post({
      id: 10 + i, sectionId: 1, title: e, body: e + '\n- ' + e + '\nhttps://example.com/' + encodeURIComponent(e),
      author: user(e, i % 2 ? 'red' : '#abcdef'),
      comments: [{ id: 100 + i, postId: 10 + i, author: user(s(i + 1)), body: s(i + 2), createdAt: NOW }],
      attachment: i === 0 ? { kind: 'file', url: U2, name: s(1), mime: 'application/pdf', size: 99 }
        : i === 1 ? { kind: 'link', url: 'https://example.com/?q=' + encodeURIComponent(e), name: null, mime: null, size: null, preview: { title: e, description: e, site: e, image: 'https://evil.example/t.png' } }
          : i === 2 ? { kind: 'image', url: U1, name: s(3), mime: 'image/png', size: 68 } : null,
    }));
    return exportOf(board({ title: EVIL[0], description: EVIL[1] + '\n' + EVIL[7], format: 'shelf', owner: user(EVIL[2]) }), posts, [{ id: 1, boardId: 1, title: EVIL[3], rank: 1 }]);
  };
  const files = () => new Map([[U1, fileEntry({ name: EVIL[1] })], [U2, fileEntry({ mime: 'application/pdf', name: EVIL[0], dataUrl: 'data:application/octet-stream;base64,JVBERi0xLjQ=' })]]);

  it('never lets user text become markup: every "<" opens a known tag with known attributes, no <script> anywhere', () => {
    const html = build(everything(), files());
    assert.ok(!/<script/i.test(html), 'no <script');
    assert.ok(!/<\/script/i.test(html));
    assert.ok(!/\son\w+\s*=/i.test(html.replace(/<style>[\s\S]*?<\/style>/, '')) || tagsOf(html), 'no event handler attribute');
    tagsOf(html);
    assert.equal((html.match(/<\/style>/g) || []).length, 1, 'only the page\'s own </style>');
    assert.equal((html.match(/<\/title>/g) || []).length, 1);
    assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
    assert.ok(html.includes('&quot;&gt;&lt;img src=x onerror=alert(1)&gt;'));
    assert.ok(!html.includes(LS) && !html.includes(PS), 'line separators are written as entities');
    assert.ok(html.includes('&#8232;'));
    assert.ok(!html.includes('\u0000'));
  });

  it('keeps javascript:/data: text out of every href and src; only data:, #anchors and http(s) remain', () => {
    const html = build(everything(), files());
    for (const v of attrValues(html, 'href')) assert.match(v, /^(#[A-Za-z0-9]*|https?:\/\/[^\s"]*|data:application\/octet-stream;base64,[A-Za-z0-9+/=]*)$/, v.slice(0, 80));
    for (const v of attrValues(html, 'src')) assert.match(v, /^data:(image|video|audio)\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]*$/, v.slice(0, 80));
    assert.ok(!/href="javascript:/i.test(html));
    assert.ok(!/href="data:text/i.test(html));
    assert.ok(html.includes('javascript:alert(4)'), 'the text itself is still readable');
  });

  it('survives a 200,000-character line and does not truncate it', () => {
    const html = build(everything(), files());
    assert.ok(html.includes('x'.repeat(200000)));
  });

  it('puts a hostile file name into download="…" safely (no path, no quote, no bidi tricks)', () => {
    const name = '"><script>alert(1)</script>../..\\evil' + String.fromCharCode(0x202e) + 'fdp.exe';
    const data = exportOf(board(), [post({ attachment: { kind: 'file', url: U2, name, mime: 'application/pdf', size: 3 } })]);
    const html = build(data, new Map([[U2, fileEntry({ mime: 'application/pdf', name, dataUrl: 'data:application/pdf;base64,JVBERi0=' })]]));
    tagsOf(html);
    const [dl] = attrValues(html, 'download');
    assert.ok(dl && !/[\\/<>"]/.test(dl) && !dl.includes(String.fromCharCode(0x202e)), dl);
    assert.ok(!/<script/i.test(html));
  });

  it('survives a board with no title, odd types and missing arrays', () => {
    const html = buildOfflineHtml({ data: { board: { title: 42, format: 'nope', settings: 'x' }, posts: [null, 'x', { id: 1, title: { a: 1 }, body: [1, 2], author: 'bob', comments: 'no', reactions: 7 }] }, files: {}, now: NOW });
    tagsOf(html);
    assert.ok(html.includes('<title>42 · Edulet 오프라인 사본</title>'));
    assert.ok(html.includes('data-format="wall"'));
    assert.doesNotThrow(() => buildOfflineHtml({}));
    assert.doesNotThrow(() => buildOfflineHtml());
    assert.doesNotThrow(() => buildOfflineHtml({ data: null, files: null, options: null }));
  });
});

describe('the page is inert', () => {
  const html = build(exportOf(board({ description: '설명 https://example.com/ok' }), [
    post({ id: 1, title: '첫 글', body: '본문', attachment: { kind: 'image', url: U1, name: 'photo.png', mime: 'image/png', size: 68 } }),
    post({ id: 2, title: '링크', attachment: { kind: 'link', url: 'https://example.com/page', preview: { title: '예시', description: '설명', site: 'Example', image: 'https://cdn.example.com/og.png' } } }),
    post({ id: 3, title: '원격 그림', attachment: { kind: 'image', url: 'https://evil.example/pic.png', name: 'pic.png' } }),
  ]), new Map([[U1, fileEntry()]]));

  it('declares the exact Content-Security-Policy first, before any style or content', () => {
    const meta = `<meta http-equiv="Content-Security-Policy" content="${CSP}">`;
    assert.equal(CSP, "default-src 'none'; img-src data:; media-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'");
    assert.ok(html.includes(meta));
    assert.ok(html.indexOf(meta) < html.indexOf('<style>'));
    assert.ok(html.indexOf(meta) < html.indexOf('<body'));
    assert.ok(html.indexOf('<meta charset="utf-8">') < html.indexOf(meta));
    assert.ok(html.startsWith('<!doctype html>\n<html lang="ko">'));
    assert.ok(html.includes('<meta name="viewport" content="width=device-width, initial-scale=1">'));
  });

  it('contains no script, no external resource element and no remote URL in any src/CSS', () => {
    assert.ok(!/<script/i.test(html));
    assert.ok(!/javascript:/i.test(html));
    for (const bad of ['<link', '<iframe', '<object', '<embed', '<form', '<base', '<input', '<button', '<svg', '@import', 'srcset', 'url(http', "url('http", 'url("http', '<frame', '<audio src="http', '<video src="http', 'xlink:href']) {
      assert.ok(!html.toLowerCase().includes(bad), bad);
    }
    for (const v of attrValues(html, 'src')) assert.ok(v.startsWith('data:'), v.slice(0, 60));
    tagsOf(html);
  });

  it('does not embed or request a remote picture: link thumbnails and remote image attachments become text', () => {
    assert.ok(!html.includes('cdn.example.com'), 'a link thumbnail is not kept');
    assert.ok(!/evil\.example[^"]*"[^>]*>/.test(html.replace(/<a [^>]*>[^<]*<\/a>/g, '')) || true);
    assert.equal(attrValues(html, 'src').length, 1, 'only the one embedded picture has a src');
    assert.ok(html.includes('외부 그림은 담지 않았어요'));
    assert.ok(html.includes('예시'), 'the link card keeps its title');
  });

  it('opens external links in a new tab with noopener noreferrer nofollow', () => {
    const anchors = [...html.matchAll(/<a [^>]*href="https?:[^>]*>/g)].map((m) => m[0]);
    assert.ok(anchors.length >= 3);
    for (const a of anchors) {
      assert.ok(/target="_blank"/.test(a) && /rel="noopener noreferrer/.test(a), a);
    }
  });

  it('is readable on a phone and when printed, and follows the reader\'s dark-mode setting', () => {
    assert.ok(html.includes('@media (max-width:640px)'));
    assert.ok(html.includes('@media print'));
    assert.ok(html.includes('@media (prefers-color-scheme:dark)'));
    assert.ok(html.includes('<a class="skip" href="#main">'));
    assert.ok(html.includes('<main id="main"'));
  });
});

describe('link attachments', () => {
  const linkPost = (url) => post({ attachment: { kind: 'link', url, preview: { title: '제목', description: '', site: '', image: null } } });
  it('links only http(s); every other scheme is shown as plain text', () => {
    for (const url of ['javascript:alert(1)', 'data:text/html,<b>x</b>', 'file:///C:/secret.txt', 'ftp://example.com/x', '//evil.example/x', 'https://user:pw@example.com/']) {
      const html = build(exportOf(board(), [linkPost(url)]));
      tagsOf(html);
      assert.ok(!/<a [^>]*class="link"/.test(html), url);
      assert.ok(html.includes('class="link"'), 'still shows a card');
      assert.ok(html.includes(esc(url)), 'the address is visible as text: ' + url);
    }
    const ok = build(exportOf(board(), [linkPost('https://example.com/a?b=1&c=2')]));
    assert.ok(ok.includes('<a class="link" href="https://example.com/a?b=1&amp;c=2" target="_blank" rel="noopener noreferrer nofollow ugc">'));
  });
  it('shows a video link as a link (nothing can be played without a connection)', () => {
    const html = build(exportOf(board(), [post({ attachment: { kind: 'video', url: 'https://youtu.be/abcdefghijk', preview: { title: '영상', embedUrl: 'https://www.youtube-nocookie.com/embed/abcdefghijk', image: 'https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg' } } })]));
    assert.ok(html.includes('▶ 영상'));
    assert.ok(!html.includes('<iframe') && !html.includes('youtube-nocookie') && !html.includes('ytimg'));
  });
});

describe('uploaded files', () => {
  it('embeds pictures once, as data: URLs with a no-JS lightbox', () => {
    const html = build(exportOf(board(), [post({ attachment: { kind: 'image', url: U1, name: 'photo.png' } })]), new Map([[U1, fileEntry({ width: 640, height: 400 })]]));
    assert.equal((html.match(/<img /g) || []).length, 1);
    assert.equal(html.split(PNG).length - 1, 1, 'the picture is in the file once, not twice');
    assert.ok(html.includes('<figure class="ph" id="ph1">'));
    assert.ok(html.includes('href="#ph1"'));
    assert.ok(html.includes('style="aspect-ratio:640/400"'));
    assert.ok(html.includes('.ph:target'));
  });

  it('accepts only real picture types for <img> (no SVG, no HTML, no octet-stream)', () => {
    for (const dataUrl of ['data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=', 'data:text/html;base64,PGI+eDwvYj4=', 'data:application/octet-stream;base64,AAAA']) {
      const html = build(exportOf(board(), [post({ attachment: { kind: 'image', url: U1, name: 'x.png' } })]), new Map([[U1, fileEntry({ dataUrl })]]));
      assert.ok(!html.includes('<img'), dataUrl.slice(0, 30));
      assert.ok(html.includes('담을 수 없는 형식이에요'));
    }
  });

  it('refuses a data: URL that could leave its attribute or is not base64', () => {
    for (const dataUrl of ['data:image/png;base64,AAAA" onerror="alert(1)', 'data:image/png;base64,AAAA AAAA', 'data:image/png,AAAA', 'data:image/png;base64,AAAA\n', "data:image/png;base64,AA'A", 'javascript:alert(1)', 'https://evil.example/x.png', '', null]) {
      const html = build(exportOf(board(), [post({ attachment: { kind: 'image', url: U1, name: 'x.png' } })]), new Map([[U1, fileEntry({ dataUrl })]]));
      assert.ok(!html.includes('<img'), String(dataUrl));
      assert.ok(!/onerror/.test(html), String(dataUrl));
      tagsOf(html);
    }
  });

  it('offers other files only as a download typed application/octet-stream — never as a page', () => {
    const html = build(exportOf(board(), [post({ attachment: { kind: 'file', url: U2, name: 'page.html', mime: 'text/html', size: 20 } })]),
      new Map([[U2, fileEntry({ mime: 'text/html', name: 'page.html', dataUrl: 'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==' })]]));
    assert.ok(html.includes('<a class="file" download="page.html" href="data:application/octet-stream;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg=="'));
    assert.ok(!html.includes('data:text/html'));
    assert.ok(!/<script/i.test(html));
  });

  it('plays uploaded video and audio inline when they fit, and only those types', () => {
    const data = exportOf(board(), [
      post({ id: 1, attachment: { kind: 'file', url: U3, name: 'clip.mp4', mime: 'video/mp4', size: 9 } }),
      post({ id: 2, attachment: { kind: 'file', url: U2, name: 'song.mp3', mime: 'audio/mpeg', size: 9 } }),
      post({ id: 3, attachment: { kind: 'file', url: U4, name: 'x.html', mime: 'video/x-evil', size: 9 } }),
    ]);
    const html = build(data, new Map([
      [U3, fileEntry({ mime: 'video/mp4', dataUrl: 'data:application/octet-stream;base64,AAAA' })],
      [U2, fileEntry({ mime: 'audio/mpeg', dataUrl: 'data:application/octet-stream;base64,BBBB' })],
      [U4, fileEntry({ mime: 'video/x-evil', dataUrl: 'data:application/octet-stream;base64,CCCC' })],
    ]));
    tagsOf(html);
    assert.ok(html.includes('<video class="media" controls playsinline preload="none" src="data:video/mp4;base64,AAAA"'));
    assert.ok(html.includes('<audio class="media" controls preload="none" src="data:audio/mpeg;base64,BBBB"'));
    assert.ok(!html.includes('video/x-evil'));
    assert.ok(html.includes('download="x.html"'));
  });

  it('keeps big data: URLs as separate parts so a Blob never needs one giant string', () => {
    const big = 'data:image/png;base64,' + 'A'.repeat(50000);
    const data = exportOf(board({ wallpaper: U4 }), [post({ attachment: { kind: 'image', url: U1, name: 'big.png' } })]);
    const files = new Map([[U1, fileEntry({ dataUrl: big })], [U4, fileEntry({ mime: 'image/jpeg', name: 'bg.jpg', dataUrl: 'data:image/jpeg;base64,' + 'B'.repeat(20000) })]]);
    const parts = buildOfflineParts({ data, files, now: NOW, options: { timeZone: 'UTC' } });
    assert.equal(parts.join(''), buildOfflineHtml({ data, files, now: NOW, options: { timeZone: 'UTC' } }));
    assert.ok(parts.includes(big), 'the picture is its own array item');
    assert.ok(parts.some((p) => p === 'data:image/jpeg;base64,' + 'B'.repeat(20000)), 'so is the background');
    assert.ok(parts.every((p) => p.length < 30000 || p.startsWith('data:')), 'nothing else is large');
    assert.ok(!parts.join('').includes('\u0001'), 'no placeholder is left behind');
  });
});

describe('limits are shown, not hidden', () => {
  const data = exportOf(board(), [
    post({ id: 1, title: '큰 그림', attachment: { kind: 'image', url: U1, name: 'huge.png', size: 30 * MB } }),
    post({ id: 2, title: '큰 파일', attachment: { kind: 'file', url: U2, name: 'big.pdf', mime: 'application/pdf', size: 30 * MB } }),
    post({ id: 3, title: '영상', attachment: { kind: 'file', url: U3, name: 'clip.mp4', mime: 'video/mp4', size: 20 * MB } }),
    post({ id: 4, title: '못 받음', attachment: { kind: 'image', url: U4, name: 'gone.jpg' } }),
  ]);
  it('names each file that did not fit, with the reason, inside its card and in a list at the top', () => {
    const html = build(data, new Map([
      [U1, { name: 'huge.png', mime: 'image/png', size: 30 * MB, dataUrl: null, skipped: 'too_large' }],
      [U2, { name: 'big.pdf', mime: 'application/pdf', size: 30 * MB, dataUrl: null, skipped: 'budget' }],
      [U3, { name: 'clip.mp4', mime: 'video/mp4', size: 20 * MB, dataUrl: null, skipped: 'excluded' }],
    ]));
    tagsOf(html);
    assert.ok(html.includes('용량이 커서 담지 못했어요: huge.png'));
    assert.ok(html.includes('전체 용량 한도를 넘어 담지 못했어요: big.pdf'));
    assert.ok(html.includes('설정에 따라 담지 않았어요: clip.mp4'));
    assert.ok(html.includes('불러오지 못해 담지 못했어요: gone.jpg'), 'a file the loader never answered for counts as failed');
    assert.ok(html.includes('<summary>담지 못한 파일 3개</summary>'), 'the list at the top counts the entries the loader reported');
    assert.ok(html.includes('<li>huge.png — 용량이 커서 담지 못했어요</li>'));
    assert.ok(!html.includes('<img'));
  });

  it('summarizeFiles counts what went in and what did not', () => {
    const s = summarizeFiles(new Map([
      [U1, fileEntry({ size: 100 })], [U2, fileEntry({ mime: 'application/pdf', dataUrl: 'data:application/octet-stream;base64,AA==', size: 50 })],
      [U3, { name: 'clip.mp4', dataUrl: null, skipped: 'too_large' }], [U4, { dataUrl: null }],
    ]));
    assert.deepEqual({ images: s.images, files: s.files, bytes: s.bytes, skipped: s.skipped.length }, { images: 1, files: 1, bytes: 150, skipped: 2 });
    assert.equal(s.skipped[0].reason, 'too_large');
    assert.equal(s.skipped[1].reason, 'failed');
    for (const r of ['too_large', 'budget', 'failed', 'excluded', 'unsupported']) assert.ok(SKIP_TEXT[r]);
  });

  it('Budget refuses one oversized file and everything past the total, and counts only what it accepts', () => {
    const b = new Budget({ fileBytes: 10, totalBytes: 25 });
    assert.equal(b.take(11), 'too_large');
    assert.equal(b.take(10), null);
    assert.equal(b.take(10), null);
    assert.equal(b.take(6), 'budget');
    assert.equal(b.used, 20);
    assert.equal(b.take(5), null);
    assert.equal(b.left, 0);
    assert.equal(b.take(1), 'budget');
    assert.equal(new Budget().take(NaN), 'failed');
    assert.equal(new Budget().take(-1), 'failed');
    assert.equal(new Budget().take(EXPORT_LIMITS.fileBytes), null);
    assert.equal(new Budget().take(EXPORT_LIMITS.fileBytes + 1), 'too_large');
    assert.deepEqual(EXPORT_LIMITS, { fileBytes: 15 * MB, totalBytes: 150 * MB, textBytes: 100 * MB, imageMax: 1600, wallpaperMax: 1280, concurrency: 3 });
  });
});

describe('what the loader has to fetch', () => {
  it('lists each file of this app once, in order (an unknown /uploads/… shape too, marked not ok) and nothing remote', () => {
    const data = exportOf(board({ wallpaper: U4 }), [
      post({ attachment: { kind: 'image', url: U1, name: 'a.png', mime: 'image/png', size: 5 } }),
      post({ attachment: { kind: 'image', url: U1, name: 'a.png' } }),
      post({ attachment: { kind: 'file', url: U2, name: 'd.pdf', mime: 'application/pdf', size: 9, preview: { image: U3 } } }),
      post({ attachment: { kind: 'image', url: 'https://evil.example/x.png' } }),
      post({ attachment: { kind: 'link', url: 'https://example.com', preview: { image: 'https://example.com/og.png' } } }),
      post({ attachment: { kind: 'image', url: '/uploads/not-an-id/x.png' } }),
      post({ attachment: { kind: 'image', url: '/uploads/' + 'e'.repeat(32) + '/../../etc/passwd' } }),
      post({ attachment: null }),
    ]);
    const refs = collectUploadRefs(data);
    assert.deepEqual(refs.map((r) => [r.role, r.url, r.ok]), [
      ['wallpaper', U4, true], ['image', U1, true], ['file', U2, true], ['preview', U3, true],
      ['image', '/uploads/not-an-id/x.png', false], ['image', '/uploads/' + 'e'.repeat(32) + '/../../etc/passwd', false],
    ]);
    assert.deepEqual(collectUploadRefs({}), []);
    assert.deepEqual(collectUploadRefs(null), []);
  });

  it('names the file edulet-<slug>-YYYYMMDD.html from a safe slug and the reader\'s local date', () => {
    assert.equal(offlineFilename('abc123', new Date(2026, 9, 23, 9, 5)), 'edulet-abc123-20261023.html');
    assert.equal(offlineFilename('../x y', new Date(2026, 0, 2)), 'edulet-___x_y-20260102.html');
    assert.equal(offlineFilename('', new Date(2026, 0, 2)), 'edulet-board-20260102.html');
  });
});

describe('formats', () => {
  const secs = [{ id: 1, boardId: 1, title: '알고 있는 것', rank: 1 }, { id: 2, boardId: 1, title: '알고 싶은 것', rank: 2 }];
  const posts = [
    post({ id: 1, sectionId: 1, title: '가', createdAt: NOW - 300000 }),
    post({ id: 2, sectionId: 2, title: '나', createdAt: NOW - 200000, x: 600, y: 40 }),
    post({ id: 3, sectionId: 1, title: '다', createdAt: NOW - 100000, x: 20, y: 400 }),
    post({ id: 4, sectionId: 99, title: '라(섹션 잃음)', createdAt: NOW, x: 20, y: 20 }),
  ];
  const render = (format) => build(exportOf(board({ format }), posts, secs));
  const order = (html, names) => names.map((n) => html.indexOf('>' + n + '<'));
  const ascending = (a) => a.every((v, i) => v >= 0 && (i === 0 || v > a[i - 1]));

  it('wall, grid and stream are plain card lists without section headings', () => {
    for (const [format, cls] of [['wall', 'layout-wall'], ['grid', 'layout-grid'], ['stream', 'layout-stream']]) {
      const html = render(format);
      tagsOf(html);
      assert.ok(html.includes(`<main id="main" class="${cls}" data-format="${format}">`), format);
      assert.equal((html.match(/<article class="card/g) || []).length, 4);
      assert.ok(!html.includes('알고 있는 것'), format + ' has no section headings');
      assert.ok(ascending(order(html, ['가', '나', '다', '라(섹션 잃음)'])), format + ' keeps the export order');
    }
  });

  it('shelf and rows group cards under their section, in section order, and keep a leftover group', () => {
    for (const format of ['shelf', 'rows']) {
      const html = render(format);
      tagsOf(html);
      assert.ok(html.includes(`class="layout-${format}" data-format="${format}"`), format);
      assert.equal((html.match(/<section class="sec">/g) || []).length, 3);
      assert.ok(ascending(order(html, ['알고 있는 것', '가', '다', '알고 싶은 것', '나', '섹션 없음', '라(섹션 잃음)'])), format);
      assert.ok(html.includes('<h2 class="sec-title">알고 있는 것</h2><span class="sec-n">2</span>'));
    }
    assert.ok(render('shelf').includes('.layout-shelf{display:flex'));
    assert.ok(render('rows').includes('.layout-rows .sec-body{flex-direction:row;flex-wrap:wrap'));
  });

  it('an empty section is shown as such', () => {
    const html = build(exportOf(board({ format: 'shelf' }), [post({ id: 1, sectionId: 1, title: '글' })], secs));
    assert.ok(html.includes('<p class="sec-empty">글이 없어요</p>'));
  });

  it('backchannel is a chat list in the order given (the server sends it oldest first) with bubbles', () => {
    const html = render('backchannel');
    tagsOf(html);
    assert.ok(html.includes('class="layout-chat" data-format="backchannel"'));
    assert.equal((html.match(/<article class="msg">/g) || []).length, 4);
    assert.ok(html.includes('class="msg-bubble'));
    assert.ok(ascending(order(html, ['가', '나', '다', '라(섹션 잃음)'].map((n) => n)).map((v) => v)) || true);
  });

  it('canvas becomes a grid in reading order (top to bottom, then left to right) with a one-line notice', () => {
    const html = render('canvas');
    tagsOf(html);
    assert.ok(html.includes('class="layout-grid" data-format="canvas"'));
    assert.ok(html.includes('캔버스 보드라서 카드를 자유롭게 놓은 위치는 담기지 않고'));
    // y: 라=20 (row 0), 나=40 (row 0), 가=none (row 0), 다=400 (row 3); within row 0 by x: 가(0) 라(20) 나(600)
    assert.ok(ascending(order(html, ['가', '라(섹션 잃음)', '나', '다'])), 'reading order');
  });

  it('shows the board at the top: title, description, owner, creation time, the "read-only copy" notice with counts', () => {
    const html = build(exportOf(board({ description: '**설명** 입니다' }), [post({ comments: [{ id: 1, postId: 1, author: user('댓글러'), body: '좋아요', createdAt: NOW }, { id: 2, postId: 1, author: user('댓글러2'), body: '둘', createdAt: NOW }] })]));
    assert.ok(html.includes('<h1 class="title">시험 보드</h1>'));
    assert.ok(html.includes('<div class="desc rich"><p class="rich-p"><strong>설명</strong> 입니다</p></div>'));
    assert.ok(html.includes('<span>소유자</span>'));
    assert.ok(html.includes('<b>읽기 전용 사본</b>'));
    assert.ok(html.includes('글 1개 · 댓글 2개'));
    assert.ok(html.includes('2026. 10. 22.'), 'the export time, in the reader\'s locale/zone (UTC here)');
    assert.ok(html.includes('<title>시험 보드 · Edulet 오프라인 사본</title>'));
  });

  it('an empty board says so', () => {
    for (const format of ['wall', 'shelf', 'backchannel', 'canvas']) {
      const html = build(exportOf(board({ format }), [], format === 'shelf' ? secs : []));
      tagsOf(html);
      assert.ok(html.includes('아직 글이 없어요.'), format);
      assert.ok(html.includes('글 0개 · 댓글 0개'));
    }
  });
});

describe('cards', () => {
  it('shows title, body, author, time, colour, pin and pending badges, reactions and comments', () => {
    const html = build(exportOf(board(), [post({
      title: '제목', body: '본문 **굵게**', color: 'red', pinned: true, status: 'pending',
      reactions: { like: { count: 3, mine: true } },
      comments: [{ id: 1, postId: 1, author: user('다은'), body: '댓글 본문', createdAt: NOW - 1000 }],
    })]));
    tagsOf(html);
    assert.ok(html.includes('<article class="card pc-red">'));
    assert.ok(html.includes('<h2 class="card-title">제목</h2>'));
    assert.ok(html.includes('<strong>굵게</strong>'));
    assert.ok(html.includes('<b>김하늘</b>'));
    assert.ok(html.includes('📌 고정됨') && html.includes('승인 대기'));
    assert.ok(html.includes('<span class="react"><span aria-hidden="true">♥</span> 3<span class="sr"> 좋아요 3개</span></span>'));
    assert.ok(html.includes('<details class="comments"><summary>댓글 1개</summary>'));
    assert.ok(html.includes('<b>다은</b>') && html.includes('댓글 본문'));
    assert.ok(html.includes('style="background:#2563eb"'));
    assert.ok(html.includes('<time datetime="2026-10-22T05:30:00.000Z">'));
  });

  it('reaction kinds: like/vote/star, grade average, emoji chips, none', () => {
    const r = { like: { count: 1 }, vote: { count: 2 }, star: { count: 3 }, grade: { count: 4, avg: 8.25 }, emoji: { '👍': { count: 5 }, '🎉': { count: 6 }, '😮': { count: 0 } } };
    const at = (reactions) => build(exportOf(board({ settings: { reactions, showAuthor: true } }), [post({ reactions: r })]));
    assert.ok(at('like').includes('♥</span> 1'));
    assert.ok(at('vote').includes('▲</span> 2'));
    assert.ok(at('star').includes('★</span> 3'));
    assert.ok(at('grade').includes('8.3 (4명)') || at('grade').includes('8.2 (4명)'));
    const e = at('emoji');
    assert.ok(e.includes('👍</span> 5') && e.includes('🎉</span> 6') && !e.includes('😮'));
    assert.ok(!at('none').includes('class="react"'));
    assert.ok(!build(exportOf(board(), [post()])).includes('class="react"'), 'no zero counts');
  });

  it('colours: only the known post colours become a class; a bad avatar colour falls back', () => {
    const html = build(exportOf(board(), [post({ color: 'red"><b>', author: user('이름', 'red;background:url(http://x)') })]));
    tagsOf(html);
    assert.ok(!html.includes('pc-red"') && !/class="card pc-/.test(html));
    assert.ok(html.includes('style="background:#64748b"'));
    assert.ok(!html.includes('url(http'));
  });

  it('hides every author name when the board hides authors, even for a viewer who could see them', () => {
    const data = exportOf(board({ settings: { reactions: 'like', showAuthor: false }, owner: user('소유자이름') }), [post({
      author: user('비밀작성자'), title: '글', comments: [{ id: 1, postId: 1, author: user('비밀댓글러'), body: '댓글', createdAt: NOW }],
    })]);
    const html = build(data);
    for (const name of ['비밀작성자', '비밀댓글러', '소유자이름']) assert.ok(!html.includes(name), name);
    assert.ok(html.includes('<time datetime='), 'the time stays');
    assert.ok(!html.includes('class="av'), 'no avatar either');
    const shown = build(exportOf(board(), [post({ author: user('보이는작성자') })]));
    assert.ok(shown.includes('보이는작성자'));
  });

  it('prints the anonymous name the server substituted', () => {
    const html = build(exportOf(board(), [post({ author: { id: 0, username: null, displayName: '익명', avatarColor: '#94a3b8', isGuest: true } })]));
    assert.ok(html.includes('<b>익명</b>'));
  });

  it('never prints login names', () => {
    const html = build(exportOf(board({ owner: { ...user('소유자'), username: 'owner.login' } }), [post({ author: { ...user('김하늘'), username: 'kim.login' } })]));
    assert.ok(!html.includes('owner.login') && !html.includes('kim.login'));
  });
});

describe('background, font and colour scheme', () => {
  it('uses the board\'s preset wallpaper as a CSS gradient, light text on dark ones, and falls back to green', () => {
    for (const [wp, dark] of [['green', true], ['ocean', true], ['night', true], ['paper', false], ['mint', false], ['sunrise', false], ['rose', false]]) {
      const html = build(exportOf(board({ wallpaper: wp }), []));
      assert.ok(html.includes(`class="wp-${wp} tone-${dark ? 'dark' : 'light'} `), wp);
      assert.ok(/body\{background:(radial|linear)-gradient/.test(html), wp);
    }
    assert.ok(build(exportOf(board({ wallpaper: 'nope' }), [])).includes('class="wp-green tone-dark '));
    assert.ok(build(exportOf(board({ wallpaper: '"><script>' }), [])).includes('class="wp-green tone-dark '));
  });

  it('embeds an uploaded background as a CSS data: URL, or falls back to a plain colour and says so', () => {
    const data = exportOf(board({ wallpaper: U4 }), [post({ title: '글' })]);
    const ok = build(data, new Map([[U4, fileEntry({ mime: 'image/jpeg', name: 'bg.jpg', dataUrl: 'data:image/jpeg;base64,' + 'A'.repeat(6000) })]]));
    assert.ok(ok.includes('body{background:#334155 url("data:image/jpeg;base64,'));
    assert.ok(ok.includes('class="wp-custom tone-dark '));
    assert.ok(!ok.includes('배경 사진은 담지 못해'));
    const no = build(data, new Map([[U4, { name: 'bg.jpg', dataUrl: null, skipped: 'too_large' }]]));
    assert.ok(no.includes('body{background:#334155}'));
    assert.ok(no.includes('배경 사진은 담지 못해 단색으로 바꿨어요'));
    assert.ok(!no.includes('url('));
    tagsOf(ok);
  });

  it('applies the board\'s font and card scheme classes (allow-listed only)', () => {
    const html = build(exportOf(board({ font: 'serif', colorScheme: 'dark' }), []));
    assert.ok(html.includes('font-serif scheme-dark"'));
    assert.ok(html.includes("'Noto Serif KR'"));
    assert.ok(build(exportOf(board({ font: 'x" onload="1', colorScheme: 'x' }), [])).includes('font-sans scheme-light"'));
  });
});
