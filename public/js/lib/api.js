// Thin fetch wrapper for /api. Throws ApiError on non-2xx. Adds X-Client-Id so the server can tag SSE echoes.
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
    res = await fetch('/api' + path, init);
    data = await parse(res);
  } catch (err) {
    if (ctl.signal.aborted) throw new ApiError(0, 'timeout', '서버가 답하지 않아요. 잠시 뒤에 다시 해 주세요.');
    throw new ApiError(0, 'network', '서버에 연결하지 못했어요. 네트워크를 확인해 주세요.');
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const e = data.error || {};
    if (res.status === 401 && onUnauthorized) onUnauthorized();
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

  /** Upload raw bytes with progress. Resolves to the server's upload JSON. */
  upload(slug, file, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', `/api/uploads?board=${encodeURIComponent(slug)}&name=${encodeURIComponent(file.name || 'file')}`);
      xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
      xhr.setRequestHeader('X-Client-Id', clientId);
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
          if (xhr.status === 401 && onUnauthorized) onUnauthorized();
          const ra = Number(xhr.getResponseHeader('Retry-After'));
          reject(new ApiError(xhr.status, e.code, e.message, Number.isFinite(ra) && ra > 0 ? Math.ceil(ra) : 0));
        }
      };
      xhr.send(file);
    });
  },
};
