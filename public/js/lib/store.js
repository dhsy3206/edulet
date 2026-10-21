// Small reactive key/value store for app-level state (current user, server config).
import { api, setUnauthorizedHandler } from './api.js';

const data = { me: null, config: null, authReady: false };
const subs = new Map();

function emit(key) {
  for (const fn of [...(subs.get(key) || [])]) {
    try {
      fn(data[key]);
    } catch (e) {
      console.error(e);
    }
  }
}

export const store = {
  get me() {
    return data.me;
  },
  get config() {
    return data.config;
  },
  get authReady() {
    return data.authReady;
  },
  get(key) {
    return data[key];
  },
  set(key, value) {
    data[key] = value;
    emit(key);
  },
  /** subscribe(key, fn) → unsubscribe. fn runs on every change (not immediately). */
  subscribe(key, fn) {
    if (!subs.has(key)) subs.set(key, new Set());
    subs.get(key).add(fn);
    return () => subs.get(key).delete(fn);
  },

  async loadConfig() {
    try {
      data.config = await api.get('/config');
    } catch {
      data.config = { allowRegister: true, maxUploadMb: 20, linkPreview: true, version: '' };
    }
    emit('config');
    return data.config;
  },
  async loadMe() {
    try {
      const r = await api.get('/auth/me');
      data.me = r.user || null;
    } catch {
      data.me = null;
    }
    data.authReady = true;
    emit('me');
    return data.me;
  },
  async login(username, password) {
    const r = await api.post('/auth/login', { username, password });
    this.set('me', r.user);
    return r.user;
  },
  async register(username, password, displayName) {
    const r = await api.post('/auth/register', { username, password, displayName });
    this.set('me', r.user);
    return r.user;
  },
  async guest(displayName) {
    const r = await api.post('/auth/guest', { displayName });
    this.set('me', r.user);
    return r.user;
  },
  async logout() {
    try {
      await api.post('/auth/logout');
    } finally {
      this.set('me', null);
    }
  },
  async updateProfile(patch) {
    const r = await api.patch('/auth/me', patch);
    this.set('me', r.user);
    return r.user;
  },
};

// A 401 on any call means the session is gone.
setUnauthorizedHandler(() => {
  if (data.me) store.set('me', null);
});
