// Configuration: environment variables (prefix EDULET_) + programmatic overrides (tests).
import path from 'node:path';

const FALSE_WORDS = ['0', 'false', 'off', 'no', ''];

function normalizeSeed(v) {
  if (v === undefined || v === null) return 'auto';
  if (v === false || v === 0) return 'off';
  if (v === true || v === 1) return 'on';
  const s = String(v).toLowerCase();
  if (s === 'auto') return 'auto';
  if (FALSE_WORDS.includes(s)) return 'off';
  return 'on';
}

export function loadConfig(o = {}) {
  const env = process.env;
  const get = (k, d) => {
    const v = env['EDULET_' + k];
    return v === undefined || v === '' ? d : v;
  };
  const bool = (v) => !FALSE_WORDS.includes(String(v).toLowerCase());
  const cfg = {
    port: o.port ?? Number(get('PORT', 3000)),
    host: o.host ?? get('HOST', '0.0.0.0'),
    dataDir: path.resolve(o.dataDir ?? get('DATA_DIR', './data')),
    sessionDays: Number(get('SESSION_DAYS', 30)),
    maxUploadMb: Number(get('MAX_UPLOAD_MB', 20)),
    allowRegister: bool(get('ALLOW_REGISTER', '1')),
    seed: normalizeSeed(o.seed ?? get('SEED', 'auto')),
    trustProxy: bool(get('TRUST_PROXY', '0')),
    linkPreview: bool(get('LINK_PREVIEW', '1')),
    cookieSecure: String(get('COOKIE_SECURE', 'auto')).toLowerCase(), // auto | 1 | 0
  };
  return Object.assign(cfg, o.config || {});
}
