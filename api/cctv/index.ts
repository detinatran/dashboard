// @ts-expect-error — _cors.js is plain JS with no declaration file; every other
// api/*.ts importer relies on the same implicit-any (see api/create-checkout.ts).
import { getCorsHeaders, isDisallowedOrigin } from '../_cors.js';
import { fetchCctvRegions, getRegionsForBounds, listCctvRegions } from './sources/index';

/**
 * Live CCTV aggregator, ported from OSIRIS (`src/app/api/cctv/route.ts`).
 *
 * Why this exists alongside the `webcam/v1.ListWebcams` RPC: that RPC serves a
 * Redis geo-index seeded by `scripts/seed-webcams.mjs`, which needs both
 * WINDY_API_KEY and Upstash credentials. A self-hosted install with neither gets
 * an empty catalogue. These sources are keyless and fetched at request time, so
 * the map has cameras out of the box. The client merges both (see
 * `src/services/webcams/index.ts`).
 *
 * Node runtime, not edge: the region fetchers parse XML/HTML from ~37 traffic
 * authorities and several exceed the edge CPU budget.
 */
export const config = { runtime: 'nodejs', maxDuration: 60 };

const MIN_CAMERAS_FOR_CACHE = 50;

export default async function handler(request: Request): Promise<Response> {
  // Both helpers take the request and read the Origin header themselves.
  if (isDisallowedOrigin(request)) {
    return new Response('Forbidden', { status: 403 });
  }
  const cors = getCorsHeaders(request) as Record<string, string>;

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors });
  }
  if (request.method !== 'GET') {
    return new Response('Method Not Allowed', { status: 405, headers: cors });
  }

  try {
    const { searchParams } = new URL(request.url);
    const region = searchParams.get('region');
    const lat = Number.parseFloat(searchParams.get('lat') || '0');
    const lng = Number.parseFloat(searchParams.get('lng') || '0');
    const radius = Number.parseFloat(searchParams.get('radius') || '10');

    const available = listCctvRegions();
    let regions: string[];
    if (region === 'all' || (!region && lat === 0 && lng === 0)) {
      regions = available;
    } else if (region) {
      regions = region.split(',').filter((r) => available.includes(r));
    } else {
      regions = getRegionsForBounds(lat, lng, radius);
    }

    const { cameras, sources } = await fetchCctvRegions(regions);

    // A short response is a symptom of upstreams failing, not of an empty
    // world. Caching it would pin that failure in front of every later request.
    const cacheControl = cameras.length < MIN_CAMERAS_FOR_CACHE
      ? 'no-store, max-age=0'
      : 'public, s-maxage=300, stale-while-revalidate=600';

    return new Response(
      JSON.stringify({
        cameras,
        total: cameras.length,
        sources,
        regions,
        timestamp: new Date().toISOString(),
      }),
      {
        status: 200,
        headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': cacheControl },
      },
    );
  } catch (error) {
    console.error('[cctv] aggregate failed:', error);
    return new Response(
      JSON.stringify({ cameras: [], total: 0, error: 'Failed to fetch cameras' }),
      { status: 500, headers: { ...cors, 'Content-Type': 'application/json' } },
    );
  }
}
