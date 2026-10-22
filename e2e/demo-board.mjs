// Shared fixture for the two end-to-end runs (e2e/run.mjs, e2e/pages.mjs): an example board that the run builds ITSELF through the
// public API — a rows board with 3 sections (7 / 8 / 2 cards = 17), image / PDF / (server run only) link cards, and 2 comments on
// the 4th card in display order — so no run depends on files in the repository's seed/ folder. Everything here is self-written.
//
//   const demo = await buildDemoBoard({ request, upload });   // request(method, path, body) → { status, body }   (path without /api)
//                                                             // upload(slug, name, mime, bytes) → { status, body }
//   demo.slug  demo.total (17)  demo.sections (3)  demo.commentedIndex (3)  demo.comments (2)  demo.images (13)
//
// The public API cannot choose a slug (it is generated), so the board's slug is whatever the API returned.
import { deflateSync, crc32 } from 'node:zlib';
import { mkdtempSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const DEMO = {
  title: '예시 보드',
  description: '시험이 공개 API 로 직접 만든 보드예요.',
  sections: ['첫째 구역', '둘째 구역', '셋째 구역'],
  perSection: [7, 8, 2], // 17 cards
  total: 17,
  commentedIndex: 3, // the 4th card in display order carries the comments
  comments: ['첫 번째 댓글이에요.', '두 번째 댓글이에요.'],
  pdfIndex: 6,
  linkIndexes: [9, 16], // link cards (only when `links: true`; otherwise plain text cards)
  imageCount: 13, // 17 − 1 commented text card − 1 PDF card − 2 text/link cards
  pdfName: 'sample-doc.pdf',
};

/** A valid RGB PNG: vertical stripes in `rgb` and a lighter tint (rows are identical, so it compresses to a few KB). */
export function makePng(w, h, rgb = [80, 140, 220]) {
  const row = Buffer.alloc(1 + 3 * w);
  for (let x = 0; x < w; x++) {
    const light = Math.floor(x / 40) % 2 === 0;
    for (let c = 0; c < 3; c++) row[1 + 3 * x + c] = light ? rgb[c] : Math.min(255, rgb[c] + 70);
  }
  const raw = Buffer.alloc(row.length * h);
  for (let y = 0; y < h; y++) row.copy(raw, y * row.length);
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** A tiny file that starts like a PDF (the servers only look at the declared type; the run only reads the first bytes). */
export function makePdf() {
  return Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n', 'latin1');
}

// Wide pictures (16:9 … 2:1): the mobile "no horizontal overflow" check needs pictures wider than the screen, and short cards keep the
// three section rows close together — the app loads images lazily, so rows far below the first screen would not load on their own.
const IMAGE_VARIANTS = [
  { w: 1200, h: 675, rgb: [80, 140, 220] },
  { w: 1000, h: 750, rgb: [230, 140, 70] },
  { w: 1200, h: 600, rgb: [90, 180, 120] },
  { w: 1600, h: 900, rgb: [170, 100, 200] },
];

/** `preview` stand-in for the Node server (CONTRACT: a fetcher replaces the network): a page with only a title and a description. */
export async function stubPreviewFetcher() {
  return {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
    body: Buffer.from('<html><head><title>예시 링크</title><meta property="og:description" content="시험용 링크 설명"></head></html>'),
  };
}

/** A temp folder holding a copy of the repository's seed/practice.json — the only seed file a run needs; seed/ itself is never read. */
export function makeSeedDir(repoRoot) {
  const dir = mkdtempSync(join(tmpdir(), 'edulet-e2e-seed-'));
  copyFileSync(join(repoRoot, 'seed', 'practice.json'), join(dir, 'practice.json'));
  return dir;
}

/**
 * Build the example board as the signed-in caller (the caller registers/logs in first and logs out afterwards). Throws on any
 * unexpected status. `links: true` makes two of the plain cards link cards (needs a preview stand-in on the server, see above).
 */
export async function buildDemoBoard({ request, upload }, { links = false } = {}) {
  const need = (r, what, ok = [200, 201]) => {
    if (!ok.includes(r.status)) throw new Error(`demo board: ${what} → ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
    return r.body;
  };
  const { board } = need(await request('POST', '/boards', { title: DEMO.title, description: DEMO.description, format: 'rows' }), 'create board', [201]);
  const slug = board.slug;
  // new cards go to the END of their section, so creation order = display order (the 4th created card is the 4th shown)
  need(await request('PATCH', `/boards/${slug}`, { settings: { newPostPosition: 'bottom' } }), 'settings');
  // a new sectioned board already has one default section ("섹션 1"): that one becomes the first, the rest are added
  const existing = need(await request('GET', `/boards/${slug}`), 'snapshot').sections || [];
  const sections = [];
  for (let s = 0; s < DEMO.sections.length; s++) {
    const title = DEMO.sections[s];
    if (existing[s]) sections.push(need(await request('PATCH', `/sections/${existing[s].id}`, { title }), 'rename section').section);
    else sections.push(need(await request('POST', `/boards/${slug}/sections`, { title }), 'section', [201]).section);
  }
  if (existing.length > DEMO.sections.length) throw new Error('demo board: unexpected extra default sections');

  const pngs = IMAGE_VARIANTS.map((v) => makePng(v.w, v.h, v.rgb));
  const posts = [];
  let i = 0;
  for (let s = 0; s < sections.length; s++) {
    for (let k = 0; k < DEMO.perSection[s]; k++, i++) {
      const data = { title: `예시 카드 ${i + 1}`, body: `${DEMO.sections[s]}에 있는 ${k + 1}번째 카드예요.`, sectionId: sections[s].id };
      if (i === DEMO.commentedIndex) {
        // plain text card (the comments go here)
      } else if (i === DEMO.pdfIndex) {
        const up = need(await upload(slug, DEMO.pdfName, 'application/pdf', makePdf()), 'upload pdf', [200, 201]);
        data.attachment = { kind: 'file', uploadId: up.id };
      } else if (DEMO.linkIndexes.includes(i)) {
        if (links) data.attachment = { kind: 'link', url: `https://example.com/demo/${i + 1}` };
      } else {
        const variant = i % IMAGE_VARIANTS.length;
        const up = need(await upload(slug, `photo-${i + 1}.png`, 'image/png', pngs[variant]), 'upload image', [200, 201]);
        data.attachment = { kind: 'image', uploadId: up.id };
      }
      posts.push(need(await request('POST', `/boards/${slug}/posts`, data), 'post', [201]).post);
    }
  }
  const commented = posts[DEMO.commentedIndex];
  for (const body of DEMO.comments) need(await request('POST', `/posts/${commented.id}/comments`, { body }), 'comment', [201]);
  // visitors may now read and comment, nothing more
  const final = need(await request('PATCH', `/boards/${slug}`, { linkAccess: 'comment' }), 'linkAccess').board;
  if (final.linkAccess !== 'comment') throw new Error('demo board: linkAccess was not applied');
  return {
    slug, board: final, sections, posts, commentedPostId: commented.id,
    total: DEMO.total, commentedIndex: DEMO.commentedIndex, comments: DEMO.comments.length, images: posts.filter((p) => p.attachment?.kind === 'image').length,
  };
}
