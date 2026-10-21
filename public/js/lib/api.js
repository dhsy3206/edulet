// Thin fetch wrapper for /api. Throws ApiError on non-2xx. Adds X-Client-Id so the server can tag SSE echoes.
export class ApiError extends Error {
  constructor(status, code, message) {
    super(message || '요청을 처리하지 못했어요.');
    this.name = 'ApiError';
    this.status = status;
    this.code = code || 'error';
  }
}

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
  let res;
  try {
    res = await fetch('/api' + path, init);
  } catch {
    throw new ApiError(0, 'network', '서버에 연결하지 못했어요. 네트워크를 확인해 주세요.');
  }
  const data = await parse(res);
  if (!res.ok) {
    const e = data.error || {};
    if (res.status === 401 && onUnauthorized) onUnauthorized();
    throw new ApiError(res.status, e.code, e.message);
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
          reject(new ApiError(xhr.status, e.code, e.message));
        }
      };
      xhr.send(file);
    });
  },
};
