// Test-only seed fixture (not a *.test.js file, so test/index.js does not load it).
//
// seed.test.js must not depend on whatever happens to sit in the repository's seed/ folder (CI has only practice.json, a
// developer PC may carry extra local boards), so it seeds a TEMPORARY folder made here:
//   - practice.json  = a byte copy of the real seed/practice.json
//   - demo-board.json = an own fixture board (rows format, 3 sections, 7 / 8 / 2 cards, 2 comments on the 4th card, ageDays 31)
//   - img/*          = tiny fake files that only start with the right magic bytes (JPEG / PNG / WebP / PDF)
// Every wording here is self-written and neutral.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from './helpers.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const tag = (s) => Buffer.from(`fixture:${s}`, 'latin1');

function webp(name) {
  const payload = Buffer.concat([Buffer.from('VP8 ', 'latin1'), Buffer.alloc(4), tag(name)]);
  const size = Buffer.alloc(4);
  size.writeUInt32LE(payload.length + 4, 0);
  return Buffer.concat([Buffer.from('RIFF', 'latin1'), size, Buffer.from('WEBP', 'latin1'), payload]);
}

/** relative path (inside the temp seed folder) -> bytes. All different, so a mix-up between files is detected. */
export const FIXTURE_FILES = {
  'img/sample-photo.jpg': Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), Buffer.from('JFIF\0', 'latin1'), tag('sample-photo.jpg'), Buffer.from([0xff, 0xd9])]),
  'img/sample-screen.png': Buffer.concat([PNG, tag('sample-screen.png')]),
  'img/link-thumb.webp': webp('link-thumb.webp'),
  'img/handout.pdf': Buffer.from('%PDF-1.4\n% fixture handout\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n', 'latin1'),
  'img/handout-preview.png': Buffer.concat([PNG, tag('handout-preview.png'), tag('handout-preview.png')]),
};

const ORDINALS = ['첫 번째', '두 번째', '세 번째', '네 번째', '다섯 번째', '여섯 번째', '일곱 번째', '여덟 번째', '아홉 번째', '열 번째',
  '열한 번째', '열두 번째', '열세 번째', '열네 번째', '열다섯 번째', '열여섯 번째'];
const card = (i) => (i < ORDINALS.length ? `${ORDINALS[i]} 카드` : '질문 & 답변 정리'); // the 17th title also carries an "&"

/** Names the tests look cards up by. */
export const FX = {
  slug: 'demo-board',
  title: '예시 보드',
  description: '시험용으로 만든 예시 보드입니다.',
  ownerName: '예시 선생님',
  ageDays: 31,
  sectionTitles: ['1단계: 준비', '2단계: 실습', '3단계: 정리'],
  sectionSizes: [7, 8, 2],
  cards: {
    // by position in the listing (also the display order)
    first: card(0), // jpeg image
    commented: card(3), // 2 comments
    link: card(5), // link + preview image (webp)
    file: card(9), // pdf file + png preview
    last: card(16), // png image, 2nd card of the last section
    all: Array.from({ length: 17 }, (_, i) => card(i)),
  },
  commentBodies: ['첫 번째 댓글\nhttps://example.com/one', '두 번째 댓글\nhttps://example.com/two'],
  image: { file: 'img/sample-photo.jpg', name: 'sample-photo.jpg' },
  png: { file: 'img/sample-screen.png', name: 'sample-screen.png' },
  link: { url: 'https://example.com/lab', title: 'example.com', description: 'An example link preview', site: 'example.com', imageFile: 'img/link-thumb.webp', imageName: 'link-thumb.webp' },
  pdf: { file: 'img/handout.pdf', name: '예시 자료 - 1.pdf', previewFile: 'img/handout-preview.png', previewName: 'handout-preview.png' },
};

function boardSpec() {
  const posts = [];
  let i = 0;
  FX.sectionSizes.forEach((n, s) => {
    for (let k = 0; k < n; k++, i++) {
      const p = { section: `s${s + 1}`, title: card(i), body: `${card(i)}의 본문입니다.` };
      if (i === 0) p.image = FX.image.file;
      if (i === 3) p.comments = FX.commentBodies.map((body) => ({ body }));
      if (i === 5) {
        p.attachment = {
          kind: 'link',
          url: FX.link.url,
          preview: { title: FX.link.title, description: FX.link.description, site: FX.link.site, imageFile: FX.link.imageFile },
        };
      }
      if (i === 9) p.attachment = { kind: 'file', file: FX.pdf.file, name: FX.pdf.name, mime: 'application/pdf', previewImageFile: FX.pdf.previewFile };
      if (i === 16) p.image = FX.png.file;
      posts.push(p);
    }
  });
  return {
    owner: { displayName: FX.ownerName },
    board: {
      slug: FX.slug,
      title: FX.title,
      description: FX.description,
      format: 'rows',
      wallpaper: 'green',
      visibility: 'link',
      linkAccess: 'comment',
      settings: { reactions: 'like', comments: 'on', approval: false, showAuthor: true, newPostPosition: 'bottom' },
      ageDays: FX.ageDays,
    },
    sections: FX.sectionTitles.map((title, s) => ({ key: `s${s + 1}`, title })),
    posts,
  };
}

/** A new temp seed folder: practice.json (copy of the repository's) + demo-board.json + img/*. */
export function makeSeedFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'edulet-seedfx-'));
  fs.copyFileSync(path.join(ROOT, 'seed', 'practice.json'), path.join(dir, 'practice.json'));
  fs.mkdirSync(path.join(dir, 'img'));
  for (const [rel, buf] of Object.entries(FIXTURE_FILES)) fs.writeFileSync(path.join(dir, rel), buf);
  fs.writeFileSync(path.join(dir, `${FX.slug}.json`), JSON.stringify(boardSpec(), null, 2));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) };
}
