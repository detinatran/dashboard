import http from 'node:http';
import https from 'node:https';

/**
 * CCTV frame proxy, ported from OSIRIS (`api/cctv/proxy/route.ts`).
 *
 * Camera CDNs set hotlink protection and rarely send CORS headers, so a frame
 * referenced straight from the page fails. This re-fetches server-side.
 *
 * Strictly allowlisted: an unrestricted fetch-by-URL endpoint is an open proxy,
 * usable to reach internal addresses from this host. Only the six CDNs the ported
 * camera catalogue actually references are permitted.
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

// Several camera CDNs serve expired or mis-chained certificates. Verification is
// therefore relaxed — but ONLY for the allowlisted hosts above, and the response
// is treated as an opaque image either way, never as trusted data.
const RELAXED_TLS_HOSTS = ['thb.gov.tw', 'etraffic.dgt.es', 'voyage.aprr.fr'];

const MAX_BYTES = 12 * 1024 * 1024;
const MAX_REDIRECTS = 3;

function hostMatches(hostname: string, list: string[]): boolean {
  return list.some((h) => hostname === h || hostname.endsWith(`.${h}`));
}

interface ProxyResult { status: number; contentType: string; data: Buffer }

function proxyFetch(url: string, referer: string | null, depth = 0): Promise<ProxyResult> {
  return new Promise((resolve, reject) => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      reject(new Error('Invalid redirect target'));
      return;
    }
    // Re-check on every hop: a redirect must not walk off the allowlist.
    const host = parsed.hostname.toLowerCase();
    if (!hostMatches(host, ALLOWED_HOSTS)) {
      reject(new Error('Redirect left the allowlist'));
      return;
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      reject(new Error('Unsupported protocol'));
      return;
    }

    const isHttps = parsed.protocol === 'https:';
    const mod = isHttps ? https : http;
    const headers: Record<string, string> = {
      Accept: 'image/*,*/*',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    };
    if (referer) headers.Referer = referer;

    const options: https.RequestOptions = { headers, timeout: 12_000 };
    if (isHttps && hostMatches(host, RELAXED_TLS_HOSTS)) {
      options.rejectUnauthorized = false;
    }

    const req = mod.get(url, options, (res) => {
      const status = res.statusCode ?? 502;
      if ((status === 301 || status === 302 || status === 307 || status === 308) && res.headers.location) {
        res.resume();
        if (depth >= MAX_REDIRECTS) { reject(new Error('Too many redirects')); return; }
        const next = new URL(res.headers.location, url).toString();
        proxyFetch(next, referer, depth + 1).then(resolve).catch(reject);
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BYTES) { req.destroy(); reject(new Error('Response too large')); return; }
        chunks.push(chunk);
      });
      res.on('end', () => resolve({
        status,
        contentType: String(res.headers['content-type'] || 'image/jpeg'),
        data: Buffer.concat(chunks),
      }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });
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
    const result = await proxyFetch(
      target.toString(),
      hostMatches(host, NO_REFERER_HOSTS) ? null : `https://${target.hostname}/`,
    );
    if (result.status >= 400) {
      return Response.json({ error: `Upstream ${result.status}` }, { status: result.status });
    }
    // Only ever hand back an image. A camera host that starts returning HTML
    // (a login wall, an error page) must not be reflected to the browser.
    const contentType = result.contentType.toLowerCase();
    if (!contentType.startsWith('image/')) {
      return Response.json({ error: 'Upstream did not return an image' }, { status: 502 });
    }
    return new Response(new Uint8Array(result.data), {
      status: 200,
      headers: {
        'Content-Type': result.contentType,
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
