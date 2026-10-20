/**
 * Runtime configuration.
 *
 * The API lives at https://smti.uk/drive-pro/api. When the UI is served from the same
 * host it is called with a same-origin URL; anywhere else (workers.dev, localhost) the
 * absolute URL is used. For local development override it once in the console:
 *   localStorage.setItem('drivepro.apiBase', JSON.stringify('http://localhost:8787/drive-pro/api'))
 */
import { storage } from './lib/storage.js';

const PRODUCTION_API = 'https://smti.uk/drive-pro/api';

function resolveApiBase() {
  const override = storage.get('drivepro.apiBase');
  if (typeof override === 'string' && override) return override.replace(/\/+$/, '');
  if (location.hostname === 'smti.uk') return `${location.origin}/drive-pro/api`;
  return PRODUCTION_API;
}

export const config = {
  apiBase: resolveApiBase(),
  /** Parallel copy requests. Drive handles 4 comfortably without rate limiting. */
  concurrency: 4,
  rootFolderName: 'Drive Pro',
  historyLimit: 30,
};
