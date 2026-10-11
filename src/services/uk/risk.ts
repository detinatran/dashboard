// CrisisTwin UK risk outlook: forecast-driven hazard scoring per twin asset
// (next 72h) and a regional resilience index. The model is a transparent,
// explainable scoring function over public forecasts — every score carries
// the drivers that produced it — not an opaque ML model.
//
// Sources (keyless, CORS-open, fetched in the browser):
// - Open-Meteo forecast API: daily precipitation sum and max wind gusts
// - Open-Meteo flood API (GloFAS): river discharge, past 365 days + 7 ahead

import type { UkFloodWarning } from './parsers';
import type { UkRegionId, UkTwinEdge, UkTwinNode } from './twin';

export type UkRiskLevel = 'high' | 'elevated' | 'guarded' | 'low';

export interface UkHazardFeatures {
  /** Precipitation summed over the next three forecast days, mm. */
  precip72: number | null;
  /** Max 10 m wind gust over the next three days, km/h. */
  gustMax: number | null;
  /**
   * Max forecast river discharge (next 7d) ÷ the 95th percentile of the past
   * 365 days — ≥ 1 means the river is heading above a flow it reaches only a
   * few days a year. A climatological baseline: a 30-day median turned every
   * late-summer low-flow channel into a false alarm.
   */
  riverRatio: number | null;
}

export interface UkNodeRisk {
  node: UkTwinNode;
  probability: number;
  level: UkRiskLevel;
  drivers: string[];
  features: UkHazardFeatures;
}

export interface UkRegionResilience {
  region: UkRegionId;
  label: string;
  score: number;
  components: { redundancy: number; exposure: number; concentration: number; hazard: number };
  assets: number;
}

const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

export function riskLevel(p: number): UkRiskLevel {
  if (p >= 0.6) return 'high';
  if (p >= 0.3) return 'elevated';
  if (p >= 0.15) return 'guarded';
  return 'low';
}

// ---------------------------------------------------------------------------
// Distance helpers
// ---------------------------------------------------------------------------

export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(a));
}

/** Probability floor implied by an active EA warning near the asset. */
const WARNING_FLOOR: Record<1 | 2 | 3, number> = { 1: 0.9, 2: 0.6, 3: 0.3 };
const WARNING_RADIUS_KM = 12;

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/** Wind-sensitive asset types: overhead lines, cranes, aviation, exposed plant. */
const WIND_SENSITIVE = new Set<UkTwinNode['type']>(['port', 'airport', 'power_station', 'interconnector', 'lng_terminal']);

export function scoreNodeRisk(
  node: UkTwinNode,
  features: UkHazardFeatures,
  warnings: UkFloodWarning[] = [],
): UkNodeRisk {
  const drivers: string[] = [];
  const precip = features.precip72 ?? 0;
  const gust = features.gustMax ?? 0;
  const ratio = features.riverRatio;

  // Flood: the dominant mechanism depends on the asset's exposure class.
  let pFlood = 0;
  const rainTerm = sigmoid((precip - 45) / 10);
  if (node.floodExposure === 'fluvial') {
    const riverTerm = ratio != null ? sigmoid((ratio - 1) * 6) : 0;
    pFlood = 1 - (1 - riverTerm) * (1 - rainTerm * 0.6);
  } else if (node.floodExposure === 'coastal') {
    // No sea-level forecast here: storm-force gusts stand in for surge
    // potential (a routine 80 km/h coastal gale should not read as a surge).
    pFlood = 1 - (1 - sigmoid((gust - 100) / 8)) * (1 - rainTerm * 0.4);
  } else if (node.floodExposure === 'surface') {
    pFlood = sigmoid((precip - 50) / 12);
  } else {
    pFlood = rainTerm * 0.15;
  }

  // Live official warnings override the model upward, never downward.
  let nearest: { w: UkFloodWarning; km: number } | null = null;
  for (const w of warnings) {
    if (w.lat == null || w.lon == null) continue;
    const km = haversineKm(node.lat, node.lon, w.lat, w.lon);
    if (km <= WARNING_RADIUS_KM && (!nearest || w.severityLevel < nearest.w.severityLevel || (w.severityLevel === nearest.w.severityLevel && km < nearest.km))) {
      nearest = { w, km };
    }
  }
  if (nearest) {
    pFlood = Math.max(pFlood, WARNING_FLOOR[nearest.w.severityLevel]);
    drivers.push(`${nearest.w.severityLabel || 'EA warning'} ${nearest.km.toFixed(0)} km away`);
  }

  const pWind = WIND_SENSITIVE.has(node.type) ? sigmoid((gust - 95) / 9) : sigmoid((gust - 115) / 9) * 0.5;
  const probability = 1 - (1 - pFlood) * (1 - pWind);

  if (ratio != null && ratio >= 0.8 && node.floodExposure === 'fluvial') drivers.push(`River at ${Math.round(ratio * 100)}% of annual high flow`);
  if (precip >= 25) drivers.push(`${Math.round(precip)} mm rain / 72h`);
  if (gust >= 65) drivers.push(`Gusts ${Math.round(gust)} km/h`);
  if (node.floodExposure !== 'low' && pFlood >= 0.15) drivers.push(`${node.floodExposure} flood exposure`);

  return { node, probability, level: riskLevel(probability), drivers, features };
}

// ---------------------------------------------------------------------------
// Forecast fetch (one multi-location request per API)
// ---------------------------------------------------------------------------

const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const FLOOD_URL = 'https://flood-api.open-meteo.com/v1/flood';
const CACHE_MS = 30 * 60_000;
const TIMEOUT_MS = 20_000;

interface DailyBlock { daily?: Record<string, Array<number | null>> }

const sum = (xs: Array<number | null> | undefined) => (xs ?? []).reduce<number>((s, x) => s + (x ?? 0), 0);
const max = (xs: Array<number | null> | undefined) => {
  const vals = (xs ?? []).filter((x): x is number => typeof x === 'number');
  return vals.length ? Math.max(...vals) : null;
};

/** Linear-interpolated percentile, p in 0..1. */
export function percentile(xs: number[], p: number): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const idx = (s.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return s[lo]! + (s[hi]! - s[lo]!) * (idx - lo);
}

/**
 * A location's "annual high flow": the 95th percentile of a year of daily
 * discharge. Needs most of a year to be a climatology, and channels whose
 * high flow is under 1 m³/s give noise ratios, so both return null.
 */
export function annualHighFlow(discharge: Array<number | null> | undefined): number | null {
  const values = (discharge ?? []).filter((q): q is number => typeof q === 'number');
  if (values.length < 200) return null;
  const high = percentile(values, 0.95);
  return high != null && high >= 1 ? high : null;
}

/** Forecast peak ÷ annual high flow; null when either side is unknown. */
export function riverRatio(forecast: Array<number | null> | undefined, highFlow: number | null): number | null {
  const ahead = (forecast ?? []).filter((q): q is number => typeof q === 'number');
  if (highFlow == null || !ahead.length) return null;
  return Math.max(...ahead) / highFlow;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`${url.split('?')[0]} → HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

let cache: { at: number; key: string; features: Map<string, UkHazardFeatures> } | null = null;

// Open-Meteo bills a request by locations × (days ÷ 14). A year of discharge
// for the whole twin is ~3,000 call-equivalents, so the slowly-moving annual
// high flow is cached per grid cell for a week; only the 7-day forecast is
// fetched on every refresh.
const CLIMATOLOGY_KEY = 'wm-uk-river-highflow-v1';
const CLIMATOLOGY_TTL_MS = 7 * 24 * 3600_000;

interface ClimatologyCache { at: number; highFlow: Record<string, number | null> }

function loadClimatology(): ClimatologyCache | null {
  try {
    const raw = localStorage.getItem(CLIMATOLOGY_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ClimatologyCache;
    return Date.now() - parsed.at < CLIMATOLOGY_TTL_MS ? parsed : null;
  } catch {
    return null;
  }
}

function saveClimatology(cacheValue: ClimatologyCache): void {
  try {
    localStorage.setItem(CLIMATOLOGY_KEY, JSON.stringify(cacheValue));
  } catch {
    // Storage blocked or full: the next refresh simply refetches.
  }
}

/** Nodes in the same ~1 km cell share one forecast point. */
const cellKey = (n: UkTwinNode) => `${n.lat.toFixed(2)},${n.lon.toFixed(2)}`;

function locationQuery(cells: string[]): string {
  const lats = cells.map(c => c.split(',')[0]).join(',');
  const lons = cells.map(c => c.split(',')[1]).join(',');
  return `latitude=${lats}&longitude=${lons}`;
}

const asList = (r: PromiseSettledResult<DailyBlock[] | DailyBlock>): DailyBlock[] =>
  r.status === 'fulfilled' ? (Array.isArray(r.value) ? r.value : [r.value]) : [];

export async function fetchHazardFeatures(nodes: UkTwinNode[]): Promise<Map<string, UkHazardFeatures>> {
  const key = nodes.map(n => n.id).join(',');
  if (cache && cache.key === key && Date.now() - cache.at < CACHE_MS) return cache.features;

  const cells = [...new Set(nodes.map(cellKey))];
  const q = locationQuery(cells);
  const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

  const climatology = loadClimatology() ?? { at: Date.now(), highFlow: {} };
  const missing = cells.filter(c => !(c in climatology.highFlow));

  const [weather, flood, history] = await Promise.allSettled([
    getJson<DailyBlock[] | DailyBlock>(`${FORECAST_URL}?${q}&daily=precipitation_sum,wind_gusts_10m_max&forecast_days=3&timezone=UTC`),
    getJson<DailyBlock[] | DailyBlock>(`${FLOOD_URL}?${q}&daily=river_discharge&forecast_days=7`),
    missing.length
      ? getJson<DailyBlock[] | DailyBlock>(`${FLOOD_URL}?${locationQuery(missing)}&daily=river_discharge&start_date=${day(-365)}&end_date=${day(-1)}`)
      : Promise.resolve([] as DailyBlock[]),
  ]);
  if (weather.status === 'rejected' && flood.status === 'rejected') throw weather.reason;
  if (weather.status === 'rejected') console.warn('[uk-risk] weather forecast unavailable:', weather.reason);
  if (flood.status === 'rejected') console.warn('[uk-risk] river forecast unavailable:', flood.reason);
  if (history.status === 'rejected') console.warn('[uk-risk] river climatology unavailable:', history.reason);

  const historyList = asList(history);
  if (missing.length && historyList.length === missing.length) {
    missing.forEach((cell, i) => {
      climatology.highFlow[cell] = annualHighFlow(historyList[i]!.daily?.river_discharge);
    });
    saveClimatology(climatology);
  }

  const w = asList(weather);
  const f = asList(flood);
  const cellIndex = new Map(cells.map((c, i) => [c, i]));
  const features = new Map<string, UkHazardFeatures>();
  for (const node of nodes) {
    const i = cellIndex.get(cellKey(node))!;
    features.set(node.id, {
      precip72: w[i] ? sum(w[i]!.daily?.precipitation_sum) : null,
      gustMax: w[i] ? max(w[i]!.daily?.wind_gusts_10m_max) : null,
      riverRatio: f[i] ? riverRatio(f[i]!.daily?.river_discharge, climatology.highFlow[cellKey(node)] ?? null) : null,
    });
  }
  cache = { at: Date.now(), key, features };
  return features;
}

// ---------------------------------------------------------------------------
// Regional resilience index
// ---------------------------------------------------------------------------

/**
 * 0..100, higher is more resilient. Four components, each 0..1:
 * - redundancy: share of the region's inbound dependencies that have an alternative
 * - exposure: share of the region's critical assets (criticality ≥ 4) that are flood-exposed
 * - concentration: share of dependency weight the region places on providers without alternatives
 * - hazard: mean forecast hazard probability across the region's assets
 */
export function computeRegionalResilience(
  nodes: UkTwinNode[],
  edges: UkTwinEdge[],
  risk: Map<string, number>,
  labels: Record<UkRegionId, string>,
): UkRegionResilience[] {
  const byRegion = new Map<UkRegionId, UkTwinNode[]>();
  for (const n of nodes) {
    const list = byRegion.get(n.region);
    if (list) list.push(n);
    else byRegion.set(n.region, [n]);
  }
  const out: UkRegionResilience[] = [];
  for (const [region, list] of byRegion) {
    const ids = new Set(list.map(n => n.id));
    const inbound = edges.filter(e => ids.has(e.to));
    const withAlt = inbound.filter(e => (e.alternatives?.length ?? 0) > 0).length;
    const redundancy = inbound.length ? withAlt / inbound.length : 1;

    const critical = list.filter(n => n.criticality >= 4);
    const exposedCritical = critical.filter(n => n.floodExposure === 'coastal' || n.floodExposure === 'fluvial').length;
    const exposure = critical.length ? exposedCritical / critical.length : 0;

    const totalWeight = inbound.reduce((s, e) => s + e.dependency, 0);
    const singlePointWeight = inbound.filter(e => !(e.alternatives?.length)).reduce((s, e) => s + e.dependency, 0);
    const concentration = totalWeight ? singlePointWeight / totalWeight : 0;

    const hazard = list.reduce((s, n) => s + (risk.get(n.id) ?? 0), 0) / list.length;

    const score = 100 * (0.35 * redundancy + 0.25 * (1 - exposure) + 0.2 * (1 - concentration) + 0.2 * (1 - hazard));
    out.push({
      region,
      label: labels[region] ?? region,
      score: Math.round(score),
      components: { redundancy, exposure, concentration, hazard },
      assets: list.length,
    });
  }
  // Inbound edges may cross regions on purpose: a region depends on
  // providers outside its boundary (e.g. Drax powering the Midlands).
  return out.sort((a, b) => a.score - b.score || a.label.localeCompare(b.label));
}
