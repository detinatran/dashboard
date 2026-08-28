import type { WebcamEntry } from '@/generated/client/worldmonitor/webcam/v1/service_client';

export type OsirisCctvStreamType = 'jpg' | 'hls' | 'mjpeg' | 'mp4' | 'iframe';

export interface OsirisCctvCamera extends WebcamEntry {
  city: string;
  source: string;
  feedUrl?: string;
  streamUrl?: string;
  streamType: OsirisCctvStreamType;
  externalUrl?: string;
}

// Small zero-credential fallback adapted from OSIRIS' public CCTV catalogue.
// The primary WorldMonitor/Windy catalogue is still used whenever available;
// these entries keep the merged camera workflow usable in local/self-hosted
// installs that have not seeded Redis or configured WINDY_API_KEY yet.
const OSIRIS_CCTV_CAMERAS: readonly OsirisCctvCamera[] = [
  {
    webcamId: 'osiris-us-tx-starbase-labpadre-rover',
    lat: 25.997,
    lng: -97.155,
    title: 'Starbase Rover Cam',
    city: 'Starbase, Texas',
    country: 'USA',
    category: 'city',
    feedUrl: 'https://i.ytimg.com/vi/jbZZYZXB1ZY/maxresdefault.jpg',
    streamUrl: 'https://www.youtube-nocookie.com/embed/jbZZYZXB1ZY?autoplay=1&mute=1',
    streamType: 'iframe',
    source: 'LABPADRE SPACE',
    externalUrl: 'https://www.youtube.com/live/jbZZYZXB1ZY',
  },
  {
    webcamId: 'osiris-bg-sofia-tsarigradsko-uab',
    lat: 42.662,
    lng: 23.376,
    title: 'Tsarigradsko Shose (UAB)',
    city: 'Sofia',
    country: 'Bulgaria',
    category: 'traffic',
    feedUrl: 'https://cdn.uab.org/images/cctv/images/cctv/cctv_103/cctv.jpg',
    streamType: 'jpg',
    source: 'UAB / KAMEPA',
  },
] as const;

function longitudeInBounds(lng: number, west: number, east: number): boolean {
  return west <= east ? lng >= west && lng <= east : lng >= west || lng <= east;
}

export function listOsirisCctvCameras(bounds: { w: number; s: number; e: number; n: number }): OsirisCctvCamera[] {
  return OSIRIS_CCTV_CAMERAS.filter((camera) =>
    camera.lat >= bounds.s
    && camera.lat <= bounds.n
    && longitudeInBounds(camera.lng, bounds.w, bounds.e),
  ).map((camera) => ({ ...camera }));
}

export function getOsirisCctvCamera(webcamId: string): OsirisCctvCamera | null {
  const camera = OSIRIS_CCTV_CAMERAS.find((entry) => entry.webcamId === webcamId);
  return camera ? { ...camera } : null;
}
