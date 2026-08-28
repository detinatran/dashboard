import { getRpcBaseUrl } from '@/services/rpc-client';
import type { WebcamEntry, WebcamCluster, ListWebcamsResponse, GetWebcamImageResponse } from '@/generated/client/worldmonitor/webcam/v1/service_client';
import { WebcamServiceClient } from '@/services/generated-rpc-clients';
import { getOsirisCctvCamera, listOsirisCctvCameras } from './osiris-cctv';

const client = new WebcamServiceClient(getRpcBaseUrl(), {
  fetch: (...args) => globalThis.fetch(...args),
});

const emptyResponse: ListWebcamsResponse = { webcams: [], clusters: [], totalInView: 0 };

// Client-side image cache (9 min, under Windy's 10-min token expiry)
const IMAGE_CACHE_MS = 9 * 60 * 1000;
const IMAGE_CACHE_MAX = 200;
const imageCacheMap = new Map<string, { data: GetWebcamImageResponse; expires: number }>();

export interface NearestWebcamResult {
  camera: WebcamEntry | null;
  distanceKm: number | null;
  markers: Array<WebcamEntry | WebcamCluster>;
}

const EARTH_RADIUS_KM = 6_371;

export function webcamDistanceKm(
  from: { lat: number; lon: number },
  camera: Pick<WebcamEntry, 'lat' | 'lng'>,
): number {
  const toRadians = (degrees: number) => degrees * Math.PI / 180;
  const lat1 = toRadians(from.lat);
  const lat2 = toRadians(camera.lat);
  const deltaLat = lat2 - lat1;
  const deltaLon = toRadians(camera.lng - from.lon);
  const a = Math.sin(deltaLat / 2) ** 2
    + Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

export function nearestWebcamFrom(
  cameras: readonly WebcamEntry[],
  location: { lat: number; lon: number },
  maxDistanceKm: number,
): { camera: WebcamEntry; distanceKm: number } | null {
  let nearest: { camera: WebcamEntry; distanceKm: number } | null = null;
  for (const camera of cameras) {
    const distanceKm = webcamDistanceKm(location, camera);
    if (distanceKm > maxDistanceKm || (nearest && distanceKm >= nearest.distanceKm)) continue;
    nearest = { camera, distanceKm };
  }
  return nearest ? { camera: { ...nearest.camera }, distanceKm: nearest.distanceKm } : null;
}

function normalizeLongitude(value: number): number {
  return ((value + 180) % 360 + 360) % 360 - 180;
}

function withOsirisFallback(
  response: ListWebcamsResponse,
  bounds: { w: number; s: number; e: number; n: number },
): ListWebcamsResponse {
  const fallback = listOsirisCctvCameras(bounds);
  if (fallback.length === 0) return response;
  const existingIds = new Set(response.webcams.map((camera) => camera.webcamId));
  const additions = fallback.filter((camera) => !existingIds.has(camera.webcamId));
  if (additions.length === 0) return response;
  return {
    ...response,
    webcams: [...response.webcams, ...additions],
    totalInView: response.totalInView + additions.length,
  };
}

export async function fetchWebcams(
  zoom: number,
  bounds: { w: number; s: number; e: number; n: number },
): Promise<ListWebcamsResponse> {
  try {
    const response = await client.listWebcams({
      zoom,
      boundW: bounds.w,
      boundS: bounds.s,
      boundE: bounds.e,
      boundN: bounds.n,
    });
    return withOsirisFallback(response, bounds);
  } catch (err) {
    console.warn('[webcams] fetch failed:', err);
    return withOsirisFallback(emptyResponse, bounds);
  }
}

/**
 * Fetches a deliberately local, high-zoom camera catalogue around a selected
 * map location and resolves the closest usable leaf marker.
 */
export async function fetchNearestWebcam(
  lat: number,
  lon: number,
  maxDistanceKm = 150,
): Promise<NearestWebcamResult> {
  const safeLat = Math.max(-85, Math.min(85, lat));
  const safeLon = normalizeLongitude(lon);
  const latDelta = Math.min(90, maxDistanceKm / 110.574);
  const longitudeKmPerDegree = Math.max(1, 111.320 * Math.cos(safeLat * Math.PI / 180));
  const lonDelta = Math.min(180, maxDistanceKm / longitudeKmPerDegree);
  const west = normalizeLongitude(safeLon - lonDelta);
  const east = normalizeLongitude(safeLon + lonDelta);
  const result = await fetchWebcams(12, {
    w: lonDelta >= 180 ? -180 : west,
    s: Math.max(-90, safeLat - latDelta),
    e: lonDelta >= 180 ? 180 : east,
    n: Math.min(90, safeLat + latDelta),
  });
  const nearest = nearestWebcamFrom(result.webcams, { lat: safeLat, lon: safeLon }, maxDistanceKm);
  return {
    camera: nearest?.camera ?? null,
    distanceKm: nearest?.distanceKm ?? null,
    markers: [...result.webcams, ...result.clusters],
  };
}

export async function fetchWebcamImage(webcamId: string): Promise<GetWebcamImageResponse> {
  const osirisCamera = getOsirisCctvCamera(webcamId);
  if (osirisCamera) {
    return {
      thumbnailUrl: osirisCamera.feedUrl || '',
      playerUrl: osirisCamera.streamUrl || '',
      title: osirisCamera.title,
      windyUrl: osirisCamera.externalUrl || osirisCamera.feedUrl || osirisCamera.streamUrl || '',
      lastUpdated: '',
      error: '',
    };
  }

  // Check client cache
  const cached = imageCacheMap.get(webcamId);
  if (cached && cached.expires > Date.now()) return cached.data;

  try {
    const result = await client.getWebcamImage({ webcamId });
    if (!result.error) {
      if (imageCacheMap.size >= IMAGE_CACHE_MAX) {
        const oldest = imageCacheMap.keys().next().value;
        if (oldest) imageCacheMap.delete(oldest);
      }
      imageCacheMap.set(webcamId, { data: result, expires: Date.now() + IMAGE_CACHE_MS });
    }
    return result;
  } catch (err) {
    console.warn('[webcams] image fetch failed:', err);
    return {
      thumbnailUrl: '', playerUrl: '', title: '',
      windyUrl: `https://www.windy.com/webcams/${webcamId}`,
      lastUpdated: '', error: 'unavailable',
    };
  }
}

// Category mapping for marker rendering
export const WEBCAM_CATEGORIES: Record<string, { color: string; emoji: string }> = {
  traffic:   { color: '#ffd700', emoji: '\u{1F697}' },    // 🚗
  city:      { color: '#00d4ff', emoji: '\u{1F3D9}\uFE0F' }, // 🏙️
  landscape: { color: '#45b7d1', emoji: '\u{1F3D4}\uFE0F' }, // 🏔️
  nature:    { color: '#96ceb4', emoji: '\u{1F33F}' },    // 🌿
  beach:     { color: '#f4a460', emoji: '\u{1F3D6}\uFE0F' }, // 🏖️
  water:     { color: '#4169e1', emoji: '\u{1F30A}' },    // 🌊
  other:     { color: '#888888', emoji: '\u{1F4F7}' },    // 📷
};

export function getClusterCellSize(zoom: number): number {
  if (zoom < 3) return 8;
  if (zoom <= 4) return 5;
  if (zoom <= 6) return 2;
  if (zoom <= 8) return 0.5;
  return 0.5;
}

export function getCategoryStyle(category: string) {
  return WEBCAM_CATEGORIES[category] ?? WEBCAM_CATEGORIES.other!;
}

export type { WebcamEntry, WebcamCluster, GetWebcamImageResponse };
export { getOsirisCctvCamera } from './osiris-cctv';
export type { OsirisCctvCamera } from './osiris-cctv';
