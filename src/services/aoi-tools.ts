/**
 * Area-of-interest geometry, selection, watch and export primitives.
 *
 * Portions adapted from OSIRIS (MIT), Copyright (c) 2026 simplifaisoul.
 * The full upstream notice is retained in THIRD_PARTY_NOTICES.md.
 */

export type LngLat = [number, number];
export type AoiDrawMode = 'polygon' | 'rectangle' | 'circle' | 'line';

export interface AoiShape {
  id: string;
  name: string;
  kind: AoiDrawMode;
  geojson: GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.LineString>;
  areaKm2: number;
  perimeterKm: number;
  color: string;
  createdAt: number;
  meta?: { center?: LngLat; radiusKm?: number };
}

export interface AoiDrawProgress {
  mode: AoiDrawMode;
  vertices: number;
  areaKm2: number;
  lengthKm: number;
  radiusKm?: number;
  closable: boolean;
}

export interface AoiDrawResult {
  kind: AoiDrawMode;
  coords: number[][];
  meta?: { center?: LngLat; radiusKm?: number };
}

export interface AoiDrawState {
  mode: AoiDrawMode;
  points: number[][];
}

export type AoiDrawAction =
  | { type: 'click'; at: LngLat }
  | { type: 'double-click' }
  | { type: 'undo' }
  | { type: 'finish' }
  | { type: 'cancel' };

export interface AoiDrawTransition {
  state: AoiDrawState;
  result?: AoiDrawResult;
  cancelled?: boolean;
}

export interface AoiEntity {
  id: string;
  label: string;
  lat: number;
  lng: number;
  detail?: string;
}

export interface AoiEntityGroup {
  key: string;
  label: string;
  color: string;
  entities: AoiEntity[];
}

export interface AoiReportGroup extends Omit<AoiEntityGroup, 'entities'> {
  count: number;
  items: AoiEntity[];
  memberIds: string[];
}

export interface AoiReport {
  total: number;
  groups: AoiReportGroup[];
}

export type AoiWatchEventKind = 'enter' | 'exit';

export interface AoiWatchEvent {
  id: string;
  kind: AoiWatchEventKind;
  aoiId: string;
  layer: string;
  layerLabel: string;
  color: string;
  label: string;
  at: number;
}

export type AoiWatchBaseline = Record<string, Set<string>>;

export interface AoiWatchDiff {
  baseline: AoiWatchBaseline;
  events: AoiWatchEvent[];
}

export interface AoiOverlayState {
  shapes: AoiShape[];
  draft: AoiDrawState | null;
  pointer: LngLat | null;
  selectedShapeId: string | null;
  watchedShapeIds: string[];
}

export interface AoiInteractionHandlers {
  onClick: (at: LngLat) => void;
  onDoubleClick: () => void;
  onPointerMove: (at: LngLat | null) => void;
}

const EARTH_RADIUS_KM = 6371;
const MAX_ITEMS_PER_GROUP = 50;
const MAX_WATCH_EVENTS = 100;
const STORAGE_KEY = 'worldmonitor.aoi.shapes.v1';
const PALETTE = [
  '#00d4ff', '#ff4d5e', '#ffd166', '#44ff88', '#c77dff',
  '#ff9f43', '#4dabf7', '#b197fc', '#20c997', '#f06595',
];

const toRad = (degrees: number): number => degrees * Math.PI / 180;
const toDeg = (radians: number): number => radians * 180 / Math.PI;

export function haversine(a: LngLat, b: LngLat): number {
  const [lng1, lat1] = a;
  const [lng2, lat2] = b;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const value = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(value)));
}

export function destination(origin: LngLat, bearingDegrees: number, distanceKm: number): LngLat {
  const [lng, lat] = origin;
  const angularDistance = distanceKm / EARTH_RADIUS_KM;
  const bearing = toRad(bearingDegrees);
  const latitude = toRad(lat);
  const longitude = toRad(lng);
  const sinLatitude2 = Math.sin(latitude) * Math.cos(angularDistance)
    + Math.cos(latitude) * Math.sin(angularDistance) * Math.cos(bearing);
  const latitude2 = Math.asin(Math.min(1, Math.max(-1, sinLatitude2)));
  const longitude2 = longitude + Math.atan2(
    Math.sin(bearing) * Math.sin(angularDistance) * Math.cos(latitude),
    Math.cos(angularDistance) - Math.sin(latitude) * sinLatitude2,
  );
  return [((toDeg(longitude2) + 540) % 360) - 180, toDeg(latitude2)];
}

export function polygonArea(ring: number[][]): number {
  if (ring.length < 3) return 0;
  let sum = 0;
  for (let index = 0; index < ring.length; index += 1) {
    const next = (index + 1) % ring.length;
    const currentPoint = ring[index] as LngLat;
    const nextPoint = ring[next] as LngLat;
    const latitude1 = toRad(currentPoint[1]);
    const latitude2 = toRad(nextPoint[1]);
    const longitudeDelta = toRad(nextPoint[0] - currentPoint[0]);
    sum += longitudeDelta * (2 + Math.sin(latitude1) + Math.sin(latitude2));
  }
  return Math.abs(sum * EARTH_RADIUS_KM * EARTH_RADIUS_KM / 2);
}

export function pathLength(coords: number[][]): number {
  let total = 0;
  for (let index = 1; index < coords.length; index += 1) {
    total += haversine(coords[index - 1] as LngLat, coords[index] as LngLat);
  }
  return total;
}

export function ringPerimeter(ring: number[][]): number {
  if (ring.length < 2) return 0;
  let total = 0;
  for (let index = 0; index < ring.length; index += 1) {
    total += haversine(ring[index] as LngLat, ring[(index + 1) % ring.length] as LngLat);
  }
  return total;
}

export function circleToRing(center: LngLat, radiusKm: number, steps = 64): number[][] {
  const ring: number[][] = [];
  for (let index = 0; index < steps; index += 1) {
    ring.push(destination(center, 360 / steps * index, radiusKm));
  }
  if (ring[0]) ring.push(ring[0]);
  return ring;
}

export function rectangleToRing(a: LngLat, b: LngLat): number[][] {
  const west = Math.min(a[0], b[0]);
  const east = Math.max(a[0], b[0]);
  const south = Math.min(a[1], b[1]);
  const north = Math.max(a[1], b[1]);
  return [[west, south], [east, south], [east, north], [west, north], [west, south]];
}

export function closeRing(coords: number[][]): number[][] {
  if (coords.length === 0) return coords;
  const first = coords[0] as number[];
  const last = coords[coords.length - 1] as number[];
  return first[0] === last[0] && first[1] === last[1] ? coords : [...coords, first];
}

export function buildAoiGeometry(mode: AoiDrawMode, points: number[][]): number[][] {
  if (mode === 'rectangle' && points.length >= 2) {
    return rectangleToRing(points[0] as LngLat, points[points.length - 1] as LngLat);
  }
  if (mode === 'circle' && points.length >= 2) {
    const center = points[0] as LngLat;
    return circleToRing(center, haversine(center, points[points.length - 1] as LngLat));
  }
  return points;
}

export function minimumAoiPoints(mode: AoiDrawMode): number {
  return mode === 'polygon' ? 3 : 2;
}

export function measureAoi(mode: AoiDrawMode, points: number[][]): AoiDrawProgress {
  const closable = points.length >= minimumAoiPoints(mode);
  if (mode === 'circle') {
    const radiusKm = points.length >= 2
      ? haversine(points[0] as LngLat, points[points.length - 1] as LngLat)
      : 0;
    const ring = closable ? buildAoiGeometry(mode, points) : [];
    return {
      mode,
      vertices: points.length,
      radiusKm,
      closable,
      areaKm2: ring.length ? polygonArea(ring) : 0,
      lengthKm: ring.length ? ringPerimeter(ring) : 0,
    };
  }
  if (mode === 'rectangle') {
    const ring = closable ? buildAoiGeometry(mode, points) : [];
    return {
      mode,
      vertices: points.length,
      closable,
      areaKm2: ring.length ? polygonArea(ring) : 0,
      lengthKm: ring.length ? ringPerimeter(ring) : 0,
    };
  }
  if (mode === 'line') {
    return { mode, vertices: points.length, closable, areaKm2: 0, lengthKm: pathLength(points) };
  }
  return {
    mode,
    vertices: points.length,
    closable,
    areaKm2: closable ? polygonArea(points) : 0,
    lengthKm: closable ? ringPerimeter(points) : pathLength(points),
  };
}

export function initialAoiDrawState(mode: AoiDrawMode): AoiDrawState {
  return { mode, points: [] };
}

function completeDrawing(state: AoiDrawState): AoiDrawResult | undefined {
  if (state.points.length < minimumAoiPoints(state.mode)) return undefined;
  const coords = buildAoiGeometry(state.mode, state.points);
  const meta = state.mode === 'circle'
    ? {
        center: state.points[0] as LngLat,
        radiusKm: haversine(state.points[0] as LngLat, state.points[state.points.length - 1] as LngLat),
      }
    : undefined;
  return { kind: state.mode, coords, meta };
}

export function reduceAoiDrawing(state: AoiDrawState, action: AoiDrawAction): AoiDrawTransition {
  switch (action.type) {
    case 'click': {
      const next = { ...state, points: [...state.points, action.at] };
      if ((state.mode === 'rectangle' || state.mode === 'circle') && next.points.length >= 2) {
        return { state: initialAoiDrawState(state.mode), result: completeDrawing(next) };
      }
      return { state: next };
    }
    case 'double-click': {
      const points = state.points.length > minimumAoiPoints(state.mode)
        ? state.points.slice(0, -1)
        : state.points;
      const candidate = { ...state, points };
      const result = completeDrawing(candidate);
      return result ? { state: initialAoiDrawState(state.mode), result } : { state: candidate };
    }
    case 'finish': {
      const result = completeDrawing(state);
      return result ? { state: initialAoiDrawState(state.mode), result } : { state };
    }
    case 'undo':
      return { state: { ...state, points: state.points.slice(0, -1) } };
    case 'cancel':
      return { state: initialAoiDrawState(state.mode), cancelled: true };
  }
}

export function createAoiShape(result: AoiDrawResult, existing: AoiShape[], index: number): AoiShape {
  const isLine = result.kind === 'line';
  const geometry: GeoJSON.Polygon | GeoJSON.LineString = isLine
    ? { type: 'LineString', coordinates: result.coords }
    : { type: 'Polygon', coordinates: [closeRing(result.coords)] };
  const labels: Record<AoiDrawMode, string> = {
    polygon: 'Area',
    rectangle: 'Box',
    circle: 'Radius',
    line: 'Path',
  };
  return {
    id: `aoi-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    name: `${labels[result.kind]} ${index + 1}`,
    kind: result.kind,
    geojson: { type: 'Feature', properties: {}, geometry },
    areaKm2: isLine ? 0 : polygonArea(result.coords),
    perimeterKm: isLine ? pathLength(result.coords) : ringPerimeter(result.coords),
    color: PALETTE[existing.length % PALETTE.length] ?? '#00d4ff',
    createdAt: Date.now(),
    meta: result.meta,
  };
}

export function queryAoiRing(shape: AoiShape): number[][] | null {
  return shape.geojson.geometry.type === 'Polygon'
    ? shape.geojson.geometry.coordinates[0] as number[][]
    : null;
}

export function pointInPolygon(lng: number, lat: number, ring: number[][]): boolean {
  let inside = false;
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index, index += 1) {
    const [x, y] = ring[index] as LngLat;
    const [previousX, previousY] = ring[previous] as LngLat;
    const straddles = (y > lat) !== (previousY > lat);
    if (straddles && lng < (previousX - x) * (lat - y) / (previousY - y) + x) inside = !inside;
  }
  return inside;
}

export function selectAoiEntities(ring: number[][], sourceGroups: AoiEntityGroup[]): AoiReport {
  if (ring.length < 3) return { total: 0, groups: [] };
  const longitudes = ring.map((point) => (point as LngLat)[0]);
  const latitudes = ring.map((point) => (point as LngLat)[1]);
  const bounds = {
    west: Math.min(...longitudes),
    east: Math.max(...longitudes),
    south: Math.min(...latitudes),
    north: Math.max(...latitudes),
  };
  const groups: AoiReportGroup[] = [];
  let total = 0;
  for (const source of sourceGroups) {
    const matches = source.entities.filter((entity) => entity.lng >= bounds.west
      && entity.lng <= bounds.east
      && entity.lat >= bounds.south
      && entity.lat <= bounds.north
      && pointInPolygon(entity.lng, entity.lat, ring));
    if (matches.length === 0) continue;
    groups.push({
      key: source.key,
      label: source.label,
      color: source.color,
      count: matches.length,
      items: matches.slice(0, MAX_ITEMS_PER_GROUP),
      memberIds: matches.map((entity) => entity.id),
    });
    total += matches.length;
  }
  groups.sort((a, b) => b.count - a.count);
  return { total, groups };
}

let watchEventSequence = 0;

export function diffAoiSweep(
  aoiId: string,
  report: AoiReport,
  previous: AoiWatchBaseline | null,
  now = Date.now(),
): AoiWatchDiff {
  const baseline: AoiWatchBaseline = {};
  const events: AoiWatchEvent[] = [];
  for (const group of report.groups) {
    const ids = new Set(group.memberIds.map((id) => `${group.key}:${id}`));
    baseline[group.key] = ids;
    if (!previous) continue;
    const labels = new Map(group.items.map((item) => [item.id, item.label]));
    const before = previous[group.key] ?? new Set<string>();
    for (const id of group.memberIds) {
      if (before.has(`${group.key}:${id}`)) continue;
      events.push({
        id: `aoi-event-${now}-${watchEventSequence += 1}`,
        kind: 'enter',
        aoiId,
        layer: group.key,
        layerLabel: group.label,
        color: group.color,
        label: labels.get(id) ?? id,
        at: now,
      });
    }
  }
  if (previous) {
    for (const [layer, before] of Object.entries(previous)) {
      const after = baseline[layer] ?? new Set<string>();
      const group = report.groups.find((candidate) => candidate.key === layer);
      for (const key of before) {
        if (after.has(key)) continue;
        events.push({
          id: `aoi-event-${now}-${watchEventSequence += 1}`,
          kind: 'exit',
          aoiId,
          layer,
          layerLabel: group?.label ?? layer,
          color: group?.color ?? '#888888',
          label: key.slice(layer.length + 1),
          at: now,
        });
      }
    }
  }
  return { baseline, events };
}

export function appendAoiEvents(log: AoiWatchEvent[], incoming: AoiWatchEvent[]): AoiWatchEvent[] {
  return incoming.length === 0 ? log : [...[...incoming].reverse(), ...log].slice(0, MAX_WATCH_EVENTS);
}

export function formatAoiDistance(km: number): string {
  if (km < 1) return `${Math.round(km * 1000)} m`;
  if (km < 100) return `${km.toFixed(1)} km`;
  return `${Math.round(km).toLocaleString()} km`;
}

export function formatAoiArea(km2: number): string {
  if (km2 < 0.01) return `${Math.round(km2 * 1_000_000).toLocaleString()} m²`;
  if (km2 < 100) return `${km2.toFixed(2)} km²`;
  return `${Math.round(km2).toLocaleString()} km²`;
}

export function formatAoiAgo(timestamp: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - timestamp) / 1000));
  if (seconds < 10) return 'now';
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

export function shapesToGeoJson(shapes: AoiShape[]): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: shapes.map((shape) => ({
      ...shape.geojson,
      properties: {
        name: shape.name,
        kind: shape.kind,
        area_km2: Number(shape.areaKm2.toFixed(4)),
        perimeter_km: Number(shape.perimeterKm.toFixed(4)),
        color: shape.color,
        created: new Date(shape.createdAt).toISOString(),
        ...(shape.meta?.radiusKm == null ? {} : { radius_km: Number(shape.meta.radiusKm.toFixed(4)) }),
      },
    })),
  };
}

function csvCell(value: unknown): string {
  const raw = value == null ? '' : String(value);
  // Spreadsheet applications may execute formula-like cells on open. Remote
  // entity labels are untrusted data, so neutralize those prefixes before the
  // RFC 4180 quoting pass.
  const text = /^[=+\-@]/.test(raw) ? `'${raw}` : raw;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function aoiReportToCsv(shape: AoiShape, report: AoiReport): string {
  const rows: string[][] = [['aoi', 'layer', 'label', 'detail', 'lat', 'lng']];
  for (const group of report.groups) {
    for (const item of group.items) {
      rows.push([
        shape.name,
        group.label,
        item.label,
        item.detail ?? '',
        item.lat.toFixed(6),
        item.lng.toFixed(6),
      ]);
    }
  }
  return rows.map((row) => row.map(csvCell).join(',')).join('\r\n');
}

export function serializeAoiShapes(shapes: AoiShape[]): string {
  return JSON.stringify(shapes);
}

export function deserializeAoiShapes(raw: string | null): AoiShape[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const shapes: AoiShape[] = [];
  for (const candidate of parsed) {
    if (!candidate || typeof candidate !== 'object') continue;
    const value = candidate as Partial<AoiShape>;
    const geometry = value.geojson?.geometry;
    if (!geometry || (geometry.type !== 'Polygon' && geometry.type !== 'LineString')) continue;
    if (typeof value.id !== 'string' || typeof value.name !== 'string' || typeof value.color !== 'string') continue;
    if (!['polygon', 'rectangle', 'circle', 'line'].includes(value.kind ?? '')) continue;
    shapes.push({
      id: value.id,
      name: value.name,
      kind: value.kind as AoiDrawMode,
      geojson: value.geojson as AoiShape['geojson'],
      areaKm2: Number(value.areaKm2) || 0,
      perimeterKm: Number(value.perimeterKm) || 0,
      color: value.color,
      createdAt: Number(value.createdAt) || Date.now(),
      meta: value.meta,
    });
  }
  return shapes;
}

export function loadAoiShapes(): AoiShape[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    return deserializeAoiShapes(localStorage.getItem(STORAGE_KEY));
  } catch {
    return [];
  }
}

export function saveAoiShapes(shapes: AoiShape[]): boolean {
  if (typeof localStorage === 'undefined') return false;
  try {
    localStorage.setItem(STORAGE_KEY, serializeAoiShapes(shapes));
    return true;
  } catch {
    return false;
  }
}

export function downloadAoiFile(filename: string, content: string, mimeType: string): void {
  if (typeof document === 'undefined') return;
  const url = URL.createObjectURL(new Blob([content], { type: mimeType }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}
