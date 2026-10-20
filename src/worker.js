/**
 * Drive Pro UI – serves the static app in ./public (Workers Static Assets).
 *
 * The app is mounted at https://smti.uk/drive-pro/ but also works at the root of
 * its workers.dev URL: the "/drive-pro" prefix is stripped before the asset lookup.
 */
const PREFIX = '/drive-pro';

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' https://fonts.googleapis.com https://cdnjs.cloudflare.com",
  "font-src 'self' https://fonts.gstatic.com https://cdnjs.cloudflare.com",
  "img-src 'self' data: https://*.googleusercontent.com https://*.google.com",
  "connect-src 'self' https://smti.uk http://localhost:8787",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

const SECURITY_HEADERS = {
  'Content-Security-Policy': CSP,
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  // Keeps window.opener for the Google sign-in popup.
  'Cross-Origin-Opener-Policy': 'same-origin-allow-popups',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // "/drive-pro" → "/drive-pro/" so relative asset URLs resolve correctly.
    if (url.pathname === PREFIX) {
      url.pathname = `${PREFIX}/`;
      return Response.redirect(url.toString(), 301);
    }

    const mounted = url.pathname.startsWith(`${PREFIX}/`);
    const assetUrl = new URL(url);
    if (mounted) assetUrl.pathname = url.pathname.slice(PREFIX.length);

    let response = await env.ASSETS.fetch(new Request(assetUrl, request));

    // Unknown paths fall back to the app shell.
    if (response.status === 404 && request.method === 'GET' && (request.headers.get('Accept') || '').includes('text/html')) {
      response = await env.ASSETS.fetch(new Request(new URL('/', assetUrl), request));
    }

    response = new Response(response.body, response);

    // Asset redirects (e.g. /index.html → /) must keep the mount prefix.
    const location = response.headers.get('Location');
    if (mounted && location?.startsWith('/')) response.headers.set('Location', PREFIX + location);

    for (const [key, value] of Object.entries(SECURITY_HEADERS)) response.headers.set(key, value);
    if ((response.headers.get('Content-Type') || '').includes('text/html')) {
      response.headers.set('Cache-Control', 'no-cache');
    }
    return response;
  },
};
