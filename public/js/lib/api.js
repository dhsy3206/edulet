// Thin fetch wrapper for /api. Throws ApiError on non-2xx. Adds X-Client-Id so the server can tag SSE echoes.
import { BASE, DEMO } from './base.js';

const API = BASE + '/api';
const SID_KEY = 'edulet_demo_sid'; // demo mode only: a service worker cannot set cookies, so the session travels as a header
const demoHeaders = (headers) => {
  if (!DEMO) return;
  try {
    const s = localStorage.getItem(SID_KEY);
    if (s) headers['X-Edulet-Session'] = s;
  } catch { /* storage blocked */ }
};
const demoSession = (get) => {
  if (!DEMO) return;
  const s = get('X-Edulet-Session');
  if (s === null) return;
  try {
    if (s) localStorage.setItem(SID_KEY, s);
    else localStorage.removeItem(SID_KEY);
  } catch { /* ignore */ }
};

export class ApiError extends Error {
  constructor(status, code, message, retryAfter) {
    super(message || '요청을 처리하지 못했어요.');
    this.name = 'ApiError';
    this.status = status;
    this.code = code || 'error';
    this.retryAfter = retryAfter || 0; // seconds, from a Retry-After header (429/503)
  }
}

const REQUEST_TIMEOUT_MS = 20000;
const retryAfterOf = (res) => {
  const n = Number(res.headers.get('Retry-After'));
  return Number.isFinite(n) && n > 0 ? Math.ceil(n) : 0;
};

function makeClientId() {
  const a = new Uint8Array(9);
  crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(36).padStart(2, '0')).join('');
}

let cid;
try {
  cid = sessionStorage.getItem('edulet_cid');
  if (!cid) sessionStorage.setItem('edulet_cid', (cid = makeClientId()));
} catch {
  cid = makeClientId();
}
export const clientId = cid;

let onUnauthorized = null;
export function setUnauthorizedHandler(fn) {
  onUnauthorized = fn;
}

async function parse(res) {
  const text = await res.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

async function request(method, path, body) {
  const headers = { 'X-Client-Id': clientId };
  demoHeaders(headers);
  const init = { method, headers, credentials: 'same-origin' };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  // A silently dead link must not leave the UI waiting forever (buttons stuck on "올리는 중…").
  const ctl = new AbortController();
  init.signal = ctl.signal;
  const timer = setTimeout(() => ctl.abort(), REQUEST_TIMEOUT_MS);
  let res, data;
  try {
    res = await fetch(API + path, init);
    demoSession((n) => res.headers.get(n));
    data = await parse(res);
  } catch (err) {
    if (ctl.signal.aborted) throw new ApiError(0, 'timeout', '서버가 답하지 않아요. 잠시 뒤에 다시 해 주세요.');
    throw new ApiError(0, 'network', '서버에 연결하지 못했어요. 네트워크를 확인해 주세요.');
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const e = data.error || {};
    // a wrong password (bad_credentials: sign-in, password change, Google link/unlink) is not "the session is gone"
    if (res.status === 401 && e.code !== 'bad_credentials' && onUnauthorized) onUnauthorized();
    throw new ApiError(res.status, e.code, e.message, retryAfterOf(res));
  }
  return data;
}

export const api = {
  get: (p) => request('GET', p),
  post: (p, b = {}) => request('POST', p, b),
  put: (p, b = {}) => request('PUT', p, b),
  patch: (p, b = {}) => request('PATCH', p, b),
  del: (p) => request('DELETE', p),

  /** Download an API file (export) through fetch so the demo session header is sent; works the same with cookies. */
  async download(path, fallbackName) {
    const headers = {};
    demoHeaders(headers);
    let res;
    try {
      res = await fetch(API + path, { headers, credentials: 'same-origin' });
    } catch {
      throw new ApiError(0, 'network', '내려받지 못했어요. 네트워크를 확인해 주세요.');
    }
    if (!res.ok) {
      const d = await parse(res);
      const e = d.error || {};
      throw new ApiError(res.status, e.code, e.message);
    }
    const cd = res.headers.get('Content-Disposition') || '';
    const m = /filename\*=UTF-8''([^;]+)/i.exec(cd) || /filename="?([^";]+)"?/i.exec(cd);
    let name = fallbackName || 'download';
    try {
      if (m) name = decodeURIComponent(m[1]);
    } catch { /* keep fallback */ }
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  },

  /** Upload raw bytes with progress. Resolves to the server's upload JSON. */
  upload(slug, file, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', `${API}/uploads?board=${encodeURIComponent(slug)}&name=${encodeURIComponent(file.name || 'file')}`);
      xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
      xhr.setRequestHeader('X-Client-Id', clientId);
      const dh = {};
      demoHeaders(dh);
      for (const [k, v] of Object.entries(dh)) xhr.setRequestHeader(k, v);
      xhr.withCredentials = true;
      if (onProgress) xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
      xhr.timeout = 10 * 60 * 1000;
      xhr.ontimeout = () => reject(new ApiError(0, 'timeout', '업로드가 너무 오래 걸려 멈췄어요. 다시 시도해 주세요.'));
      xhr.onerror = () => reject(new ApiError(0, 'network', '업로드하지 못했어요. 네트워크를 확인해 주세요.'));
      xhr.onload = () => {
        let data = {};
        try {
          data = JSON.parse(xhr.responseText || '{}');
        } catch {
          /* ignore */
        }
        if (xhr.status >= 200 && xhr.status < 300) resolve(data);
        else {
          const e = data.error || {};
          if (xhr.status === 401 && e.code !== 'bad_credentials' && onUnauthorized) onUnauthorized();
          const ra = Number(xhr.getResponseHeader('Retry-After'));
          reject(new ApiError(xhr.status, e.code, e.message, Number.isFinite(ra) && ra > 0 ? Math.ceil(ra) : 0));
        }
      };
      xhr.send(file);
    });
  },
};
