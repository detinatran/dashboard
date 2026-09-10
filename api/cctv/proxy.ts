/**
 * CCTV frame proxy, ported from OSIRIS (`api/cctv/proxy/route.ts`).
 *
 * Camera CDNs set hotlink protection and rarely send CORS headers, so a frame
 * referenced straight from the page fails. This re-fetches server-side.
 *
 * Strictly allowlisted: an unrestricted fetch-by-URL endpoint is an open proxy,
 * usable to reach internal addresses from this host. Only the six CDNs the
 * ported camera catalogue actually references are permitted.
 *
 * Uses the standard `fetch` rather than node:http. Every other file under api/
 * follows that rule (tests/edge-functions.test.mjs asserts it for the whole
 * directory, regardless of the declared runtime) so the module stays portable
 * across the edge and node runtimes.
 */
export const config = { runtime: 'nodejs', maxDuration: 15 };

const ALLOWED_HOSTS = [
  'cdn.skylinewebcams.com',
  'cdn2.skylinewebcams.com',
  's3-eu-west-1.amazonaws.com',
  'voyage.aprr.fr',
  'thb.gov.tw',
  'etraffic.dgt.es',
];

// Taiwan Highway Bureau cameras are DigiEver encoders that emit a malformed
// response header when the request carries a Referer; Node's parser then
// rejects the whole response with "Parse Error: Invalid header token". Asking
// without a Referer returns a clean JPEG (measured 8/8 across cctv-ss01…08).
// An Accept header is still required or these servers hang up.
const NO_REFERER_HOSTS = ['thb.gov.tw'];

const MAX_BYTES = 12 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const UPSTREAM_TIMEOUT_MS = 12_000;

function hostMatches(hostname: string, list: string[]): boolean {
  return list.some((h) => hostname === h || hostname.endsWith(`.${h}`));
}

/**
 * Follow redirects manually so the allowlist is re-checked on every hop —
 * `redirect: 'follow'` would let an upstream 302 walk the request off the
 * allowlist and turn this into an open proxy.
 */
async function proxyFetch(url: string, referer: string | null, depth = 0): Promise<Response> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('Invalid redirect target');
  }
  const host = parsed.hostname.toLowerCase();
  if (!hostMatches(host, ALLOWED_HOSTS)) throw new Error('Redirect left the allowlist');
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('Unsupported protocol');
  }

  const headers: Record<string, string> = {
    Accept: 'image/*,*/*',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  };
  if (referer) headers.Referer = referer;

  const response = await fetch(url, {
    headers,
    redirect: 'manual',
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });

  const status = response.status;
  if (status === 301 || status === 302 || status === 307 || status === 308) {
    const location = response.headers.get('location');
    if (!location) return response;
    if (depth >= MAX_REDIRECTS) throw new Error('Too many redirects');
    return proxyFetch(new URL(location, url).toString(), referer, depth + 1);
  }
  return response;
}

export default async function handler(request: Request): Promise<Response> {
  if (request.method !== 'GET') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  const url = new URL(request.url).searchParams.get('url');
  if (!url) {
    return Response.json({ error: 'Missing url parameter' }, { status: 400 });
  }

  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return Response.json({ error: 'Invalid URL' }, { status: 400 });
  }

  const host = target.hostname.toLowerCase();
  if (!hostMatches(host, ALLOWED_HOSTS)) {
    return Response.json({ error: 'Forbidden domain' }, { status: 403 });
  }

  try {
    const upstream = await proxyFetch(
      target.toString(),
      hostMatches(host, NO_REFERER_HOSTS) ? null : `https://${target.hostname}/`,
    );

    if (upstream.status >= 400) {
      return Response.json({ error: `Upstream ${upstream.status}` }, { status: upstream.status });
    }

    // Only ever hand back an image. A camera host that starts returning HTML
    // (a login wall, an error page) must not be reflected to the browser.
    const contentType = upstream.headers.get('content-type') || 'image/jpeg';
    if (!contentType.toLowerCase().startsWith('image/')) {
      return Response.json({ error: 'Upstream did not return an image' }, { status: 502 });
    }

    const body = new Uint8Array(await upstream.arrayBuffer());
    if (body.byteLength > MAX_BYTES) {
      return Response.json({ error: 'Response too large' }, { status: 502 });
    }

    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=5, stale-while-revalidate=10',
        'Access-Control-Allow-Origin': '*',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown';
    console.error('[cctv/proxy] failed:', message);
    return Response.json({ error: 'Proxy failed' }, { status: 502 });
  }
}
