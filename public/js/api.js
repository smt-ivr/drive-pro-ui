/**
 * Session (tokens persisted in localStorage) and the API client.
 * The client refreshes access tokens before they expire, retries rate limits,
 * server hiccups and network drops with exponential backoff, and normalizes errors.
 */
import { storage } from './lib/storage.js';

const SESSION_KEY = 'drivepro.session';
const LEGACY_KEY = 'gdrive_tokens';
const EXPIRY_MARGIN_MS = 60_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class ApiError extends Error {
  constructor(message, { status = 0, code = 'unknown', details } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export class Session extends EventTarget {
  constructor() {
    super();
    this.data = storage.get(SESSION_KEY) || this.migrateLegacy();
  }

  /** Sessions saved by the previous version of the app. */
  migrateLegacy() {
    const legacy = storage.get(LEGACY_KEY);
    storage.remove(LEGACY_KEY);
    if (!legacy?.access_token) return null;
    const data = { access_token: legacy.access_token, refresh_token: legacy.refresh_token, expires_at: 0 };
    storage.set(SESSION_KEY, data);
    return data;
  }

  get isLoggedIn() {
    return Boolean(this.data?.access_token);
  }
  get accessToken() {
    return this.data?.access_token || null;
  }
  get refreshToken() {
    return this.data?.refresh_token || null;
  }
  get isExpired() {
    return !this.data?.expires_at || Date.now() > this.data.expires_at;
  }
  get user() {
    return this.data?.user || null;
  }

  setTokens(tokens) {
    this.data = {
      ...this.data,
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token || this.data?.refresh_token,
      expires_at: Date.now() + (Number(tokens.expires_in) || 3600) * 1000 - EXPIRY_MARGIN_MS,
    };
    storage.set(SESSION_KEY, this.data);
  }

  setUser(user) {
    this.data = { ...this.data, user };
    storage.set(SESSION_KEY, this.data);
  }

  /** @param {'logout' | 'expired'} reason */
  clear(reason = 'logout') {
    const wasLoggedIn = this.isLoggedIn;
    this.data = null;
    storage.remove(SESSION_KEY);
    if (wasLoggedIn) this.dispatchEvent(new CustomEvent('end', { detail: { reason } }));
  }
}

export class ApiClient {
  /**
   * @param {string} base
   * @param {Session} session
   */
  constructor(base, session) {
    this.base = base;
    this.origin = new URL(base, location.href).origin;
    this.session = session;
    this.refreshing = null;
  }

  loginUrl() {
    const params = new URLSearchParams({ origin: location.origin, return_to: location.href.split('#')[0] });
    return `${this.base}/login?${params}`;
  }

  async request(path, { method = 'GET', body, auth = true, retries = 3, signal } = {}) {
    let refreshed = false;

    for (let attempt = 0; ; attempt++) {
      const headers = {};
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      if (auth) {
        const token = await this.validAccessToken();
        if (!token) throw new ApiError('יש להתחבר מחדש.', { status: 401, code: 'missing_token' });
        headers.Authorization = `Bearer ${token}`;
      }

      let res;
      try {
        res = await fetch(this.base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal });
      } catch (err) {
        if (signal?.aborted) throw err;
        if (attempt < retries) {
          await sleep(backoff(attempt));
          continue;
        }
        throw new ApiError('אין חיבור לשרת. בדוק את חיבור האינטרנט ונסה שוב.', { code: 'network' });
      }

      const data = await res.json().catch(() => ({}));
      if (res.ok) return data;

      if (res.status === 401 && auth) {
        if (!refreshed && this.session.refreshToken) {
          refreshed = true;
          await this.refresh();
          continue;
        }
        this.session.clear('expired');
      }

      const retryable = res.status === 429 || res.status === 502 || res.status === 503 || res.status === 504;
      if (retryable && attempt < retries) {
        await sleep(backoff(attempt, res.status === 429 ? 1500 : 600));
        continue;
      }

      throw new ApiError(data.error || `שגיאה בשרת (${res.status}).`, { status: res.status, code: data.code, details: data.details });
    }
  }

  async validAccessToken() {
    if (this.session.isExpired && this.session.refreshToken) await this.refresh();
    return this.session.accessToken;
  }

  /** Single-flight token refresh shared by all concurrent requests. */
  refresh() {
    if (!this.refreshing) {
      this.refreshing = this.request('/refresh', { method: 'POST', auth: false, retries: 2, body: { refreshToken: this.session.refreshToken } })
        .then((tokens) => this.session.setTokens(tokens))
        .catch((err) => {
          if (err.status === 401 || err.status === 400) this.session.clear('expired');
          throw err;
        })
        .finally(() => (this.refreshing = null));
    }
    return this.refreshing;
  }

  me() {
    return this.request('/me');
  }
  fileInfo(linkOrId) {
    return this.request('/file-info', { method: 'POST', body: { linkOrId } });
  }
  listFolder(folderId, resourceKey) {
    return this.request('/list-folder', { method: 'POST', body: { folderId, resourceKey } });
  }
  /** @param {{name?: string, path?: string, parentId?: string}} opts */
  ensureFolder(opts) {
    return this.request('/ensure-folder', { method: 'POST', body: opts });
  }
  /** @param {{fileId: string, resourceKey?: string, targetFolderId: string, name?: string}} opts */
  copyFile(opts) {
    return this.request('/copy-file', { method: 'POST', body: opts });
  }
}

function backoff(attempt, base = 600) {
  return base * 2 ** attempt + Math.random() * 300;
}
