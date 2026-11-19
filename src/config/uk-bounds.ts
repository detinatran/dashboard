// CrisisTwin UK geography clip. The global infrastructure datasets (cables,
// pipelines, nuclear sites, AI data centres) stay canonical for the other
// variants; the uk variant shows and indexes only what touches this box —
// the UK and its immediate waters, wide enough to keep interconnector and
// cable landings on both shores of the Channel and North Sea approaches.

export const UK_BOUNDS = {
  latMin: 49.5,
  latMax: 61.2,
  lonMin: -8.8,
  lonMax: 2.2,
} as const;

export function inUkBounds(lat?: number | null, lon?: number | null): boolean {
  return typeof lat === 'number' && typeof lon === 'number'
    && lat >= UK_BOUNDS.latMin && lat <= UK_BOUNDS.latMax
    && lon >= UK_BOUNDS.lonMin && lon <= UK_BOUNDS.lonMax;
}

/** For path geometries stored as [lon, lat] pairs (cables, pipelines). */
export function anyPointInUkBounds(points: ReadonlyArray<readonly [number, number]> | undefined): boolean {
  return !!points?.some(([lon, lat]) => inUkBounds(lat, lon));
}
