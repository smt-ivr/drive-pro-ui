import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';

const ASSETS = {
  async fetch(request) {
    const { pathname } = new URL(request.url);
    if (pathname === '/' ) return new Response('<html>app</html>', { headers: { 'Content-Type': 'text/html' } });
    if (pathname === '/index.html') return new Response(null, { status: 307, headers: { Location: '/' } });
    if (pathname === '/js/app.js') return new Response('js', { headers: { 'Content-Type': 'text/javascript' } });
    return new Response('nope', { status: 404 });
  },
};
const get = (path, headers = {}) => worker.fetch(new Request(`https://smti.uk${path}`, { headers }), { ASSETS });

test('redirects the bare mount path to a trailing slash', async () => {
  const res = await get('/drive-pro');
  assert.equal(res.status, 301);
  assert.equal(res.headers.get('Location'), 'https://smti.uk/drive-pro/');
});

test('serves assets under the mount prefix and at the root', async () => {
  assert.equal(await (await get('/drive-pro/')).text(), '<html>app</html>');
  assert.equal(await (await get('/drive-pro/js/app.js')).text(), 'js');
  assert.equal(await (await get('/js/app.js')).text(), 'js');
});

test('adds security headers and no-cache for HTML', async () => {
  const res = await get('/drive-pro/');
  assert.match(res.headers.get('Content-Security-Policy'), /script-src 'self'/);
  assert.equal(res.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.equal(res.headers.get('Cache-Control'), 'no-cache');
});

test('keeps the prefix on asset redirects and falls back to the app shell', async () => {
  assert.equal((await get('/drive-pro/index.html')).headers.get('Location'), '/drive-pro/');
  const res = await get('/drive-pro/some/deep/link', { Accept: 'text/html' });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), '<html>app</html>');
  assert.equal((await get('/drive-pro/missing.js')).status, 404);
});
