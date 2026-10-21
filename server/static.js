// Static file serving for public/ with SPA fallback, ETag/Last-Modified, traversal protection.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { sendText } from './http.js';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.pdf': 'application/pdf',
};

async function statFile(p) {
  try {
    const st = await fsp.stat(p);
    return st.isFile() ? st : null;
  } catch { return null; }
}

export async function serveStatic(app, req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return sendText(res, 405, 'Method Not Allowed', { Allow: 'GET, HEAD' });
  const root = app.publicDir;
  let rel;
  try { rel = decodeURIComponent(pathname); } catch { return sendText(res, 400, 'Bad Request'); }
  if (rel.includes('\0')) return sendText(res, 400, 'Bad Request');
  const segs = rel.split('/').filter(Boolean);
  if (segs.some((s) => s === '..' || s === '.' || s.startsWith('.') || /[\:]/.test(s))) return sendText(res, 404, 'Not Found');

  let file = path.join(root, ...segs);
  if (file !== root && !file.startsWith(root + path.sep)) return sendText(res, 404, 'Not Found');
  let st = await statFile(file);
  if (!st && fs.existsSync(file) && fs.statSync(file).isDirectory()) {
    file = path.join(file, 'index.html');
    st = await statFile(file);
  }
  if (!st) {
    const last = segs[segs.length - 1] || '';
    if (path.extname(last)) return sendText(res, 404, 'Not Found');
    file = path.join(root, 'index.html'); // SPA fallback
    st = await statFile(file);
    if (!st) return sendText(res, 404, 'Not Found');
  }

  const etag = `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
  const headers = {
    'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'Content-Length': st.size,
    'Last-Modified': st.mtime.toUTCString(),
    ETag: etag,
    'Cache-Control': 'no-cache',
  };
  const inm = req.headers['if-none-match'];
  const ims = req.headers['if-modified-since'];
  const fresh = inm
    ? inm.split(',').some((t) => t.trim() === etag || t.trim() === '*')
    : ims && Math.floor(st.mtimeMs / 1000) <= Math.floor(Date.parse(ims) / 1000);
  if (fresh) {
    delete headers['Content-Length'];
    res.writeHead(304, headers);
    return res.end();
  }
  res.writeHead(200, headers);
  if (req.method === 'HEAD') return res.end();
  try { await pipeline(fs.createReadStream(file), res); } catch { res.destroy(); }
}
