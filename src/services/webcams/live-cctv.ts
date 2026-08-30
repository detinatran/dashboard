import type { OsirisCctvCamera, OsirisCctvStreamType } from './osiris-cctv';

/**
 * Client for `/api/cctv`, the live traffic-authority aggregator ported from
 * OSIRIS. Complements two other sources the map already merges:
 *
 *   * `webcam/v1.ListWebcams` — the Windy catalogue, needs a seeded Redis index
 *   * `osiris-cctv.ts`        — 875 static cameras compiled into the bundle
 *
 * This one is keyless and fetched live, so a self-hosted install with neither
 * WINDY_API_KEY nor Upstash still gets the ~37 traffic-authority networks
 * (TfL, WSDOT, Caltrans, Utah UDOT, Taiwan THB, …).
 */

/** Wire shape returned by `/api/cctv` — snake_case, matching OSIRIS' CctvCamera. */
interface LiveCctvWire {
  id: string;
  lat: number;
  lng: number;
  name: string;
  city?: string;
  country?: string;
  feed_url?: string;
  stream_url?: string;
  stream_type?: string;
  external_url?: string;
  source: string;
}

const STREAM_TYPES: readonly OsirisCctvStreamType[] = ['jpg', 'hls', 'mjpeg', 'mp4', 'iframe'];

// A full global sweep hits ~37 upstreams and can take tens of seconds. The map
// must never block on it, so requests are bounded and failures are silent.
const REQUEST_TIMEOUT_MS = 25_000;
const CACHE_TTL_MS = 5 * 60 * 1000;

let cache: { key: string; at: number; cameras: OsirisCctvCamera[] } | null = null;
let inflight: { key: string; promise: Promise<OsirisCctvCamera[]> } | null = null;

function toStreamType(value: string | undefined, feedUrl: string | undefined): OsirisCctvStreamType {
  if (value && (STREAM_TYPES as readonly string[]).includes(value)) {
    return value as OsirisCctvStreamType;
  }
  const url = feedUrl ?? '';
  if (/\.m3u8(\?|$)/i.test(url)) return 'hls';
  if (/\.mp4(\?|$)/i.test(url)) return 'mp4';
  return 'jpg';
}

/**
 * Rewrite the relative `/api/cctv/proxy?url=…` that OSIRIS sources emit onto
 * this origin. MapWebcamViewer's safeHttpUrl() parses with `new URL(value)`,
 * which throws on a relative path and yields '' — the frame would silently not
 * render. An absolute same-origin URL survives that check.
 */
function absolutize(url: string | undefined): string | undefined {
  if (!url) return undefined;
  if (/^https?:\/\//i.test(url)) return url;
  if (url.startsWith('/') && typeof location !== 'undefined') {
    return new URL(url, location.origin).toString();
  }
  return undefined;
}

function toCamera(wire: LiveCctvWire): OsirisCctvCamera | null {
  if (!wire?.id || !Number.isFinite(wire.lat) || !Number.isFinite(wire.lng)) return null;
  const feedUrl = absolutize(wire.feed_url);
  const streamUrl = absolutize(wire.stream_url);
  const externalUrl = absolutize(wire.external_url);
  if (!feedUrl && !streamUrl && !externalUrl) return null;
  return {
    // Namespaced so a live camera can never collide with a bundled static one.
    webcamId: `live-${wire.id}`,
    lat: wire.lat,
    lng: wire.lng,
    title: wire.name || wire.id,
    city: wire.city || '',
    country: wire.country || '',
    category: 'traffic',
    ...(feedUrl ? { feedUrl } : {}),
    ...(streamUrl ? { streamUrl } : {}),
    streamType: toStreamType(wire.stream_type, feedUrl ?? streamUrl),
    source: wire.source || 'CCTV',
    ...(externalUrl ? { externalUrl } : {}),
  };
}

async function requestLiveCameras(region: string): Promise<OsirisCctvCamera[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`/api/cctv?region=${encodeURIComponent(region)}`, {
      signal: controller.signal,
    });
    if (!response.ok) return [];
    const payload = await response.json() as { cameras?: LiveCctvWire[] };
    const cameras: OsirisCctvCamera[] = [];
    for (const wire of payload.cameras ?? []) {
      const camera = toCamera(wire);
      if (camera) cameras.push(camera);
    }
    return cameras;
  } catch {
    // Offline, aborted, or the endpoint is not deployed (a static-host install).
    // The static catalogue still covers the map, so stay quiet.
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch the live catalogue, de-duplicated per region and cached for 5 minutes.
 * Concurrent callers share one in-flight request.
 */
export async function fetchLiveCctvCameras(region = 'all'): Promise<OsirisCctvCamera[]> {
  const now = Date.now();
  if (cache && cache.key === region && now - cache.at < CACHE_TTL_MS) {
    return cache.cameras;
  }
  if (inflight && inflight.key === region) return inflight.promise;

  const promise = requestLiveCameras(region).then((cameras) => {
    // Never cache an empty result: it usually means the upstreams failed, and
    // pinning that for 5 minutes would hide a recovery.
    if (cameras.length > 0) cache = { key: region, at: Date.now(), cameras };
    return cameras;
  }).finally(() => {
    if (inflight?.key === region) inflight = null;
  });

  inflight = { key: region, promise };
  return promise;
}

/** Look up one live camera by the id `fetchLiveCctvCameras` assigned it. */
export function getLiveCctvCamera(webcamId: string): OsirisCctvCamera | null {
  if (!cache) return null;
  return cache.cameras.find((camera) => camera.webcamId === webcamId) ?? null;
}

/** Cameras from the last fetch that fall inside `bounds`. */
export function listLiveCctvCameras(bounds: { w: number; s: number; e: number; n: number }): OsirisCctvCamera[] {
  if (!cache) return [];
  const inLongitude = (lng: number) => (bounds.w <= bounds.e
    ? lng >= bounds.w && lng <= bounds.e
    : lng >= bounds.w || lng <= bounds.e);
  return cache.cameras.filter((camera) => camera.lat >= bounds.s
    && camera.lat <= bounds.n
    && inLongitude(camera.lng));
}

/** Test seam: drop cached state. */
export function resetLiveCctvCache(): void {
  cache = null;
  inflight = null;
}

export type { LiveCctvWire };
