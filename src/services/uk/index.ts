// CrisisTwin UK live sources. Every upstream here is keyless and sends
// `Access-Control-Allow-Origin: *`, so the browser fetches them directly — no
// Redis, seeder or Vercel function involved. The one exception is the Met
// Office warnings RSS (no CORS), which goes through the existing rss-proxy.

import { rssProxyUrl } from '@/utils/proxy';
import {
  compareAlerts,
  earthquakeToAlert,
  floodWarningToAlert,
  parseBgsEarthquakes,
  parseEaFloodWarnings,
  parseGridWarnings,
  parseMetOfficeWarnings,
  parseTflStatus,
  renewableShare,
  type EaFloodItem,
  type GenerationMixEntry,
  type SysWarning,
  type TflLine,
  type UkAlert,
  type UkAlertSource,
  type UkEarthquake,
  type UkFloodWarning,
  type UkGridSnapshot,
} from './parsers';

export * from './parsers';

const EA_ROOT = 'https://environment.data.gov.uk/flood-monitoring';
const CARBON_ROOT = 'https://api.carbonintensity.org.uk';
const ELEXON_ROOT = 'https://data.elexon.co.uk/bmrs/api/v1';
const TFL_STATUS_URL = 'https://api.tfl.gov.uk/Line/Mode/tube,elizabeth-line,overground,dlr/Status';
const BGS_FEED_URL = 'https://earthquakes.bgs.ac.uk/feeds/MhSeismology.xml';
const MET_OFFICE_FEED_URL = 'https://www.metoffice.gov.uk/public/data/PWSCache/WarningsRSS/Region/UK';

const TIMEOUT_MS = 15_000;
const QUAKE_WINDOW_MS = 7 * 24 * 3600_000;

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

async function getText(url: string): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.text();
}

// Flood-area centroids never change, so they are fetched once per area per
// session. A storm can raise several hundred warnings; cap the fan-out.
const areaCentroids = new Map<string, Promise<[number, number] | null>>();
const AREA_CONCURRENCY = 8;

function fetchAreaCentroid(areaId: string): Promise<[number, number] | null> {
  let pending = areaCentroids.get(areaId);
  if (!pending) {
    pending = getJson<{ items: { lat?: number; long?: number } | Array<{ lat?: number; long?: number }> }>(
      `${EA_ROOT}/id/floodAreas/${encodeURIComponent(areaId)}`,
    )
      .then(({ items }) => {
        const area = Array.isArray(items) ? items[0] : items;
        return typeof area?.lat === 'number' && typeof area?.long === 'number' ? [area.long, area.lat] as [number, number] : null;
      })
      .catch(() => {
        areaCentroids.delete(areaId);
        return null;
      });
    areaCentroids.set(areaId, pending);
  }
  return pending;
}

async function attachCentroids(warnings: UkFloodWarning[]): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < warnings.length) {
      const w = warnings[next++]!;
      const centroid = await fetchAreaCentroid(w.id);
      if (centroid) [w.lon, w.lat] = centroid;
    }
  };
  await Promise.all(Array.from({ length: Math.min(AREA_CONCURRENCY, warnings.length) }, worker));
}

export async function fetchFloodWarnings(): Promise<UkFloodWarning[]> {
  const { items } = await getJson<{ items: EaFloodItem[] }>(`${EA_ROOT}/id/floods`);
  const warnings = parseEaFloodWarnings(items ?? []);
  await attachCentroids(warnings);
  return warnings;
}

export async function fetchUkEarthquakes(): Promise<UkEarthquake[]> {
  const now = Date.now();
  return parseBgsEarthquakes(await getText(BGS_FEED_URL)).filter(q => now - q.time <= QUAKE_WINDOW_MS);
}

export async function fetchMetOfficeWarnings(): Promise<UkAlert[]> {
  return parseMetOfficeWarnings(await getText(rssProxyUrl(MET_OFFICE_FEED_URL)));
}

export async function fetchTflAlerts(): Promise<UkAlert[]> {
  return parseTflStatus(await getJson<TflLine[]>(TFL_STATUS_URL));
}

export async function fetchGridWarnings(): Promise<UkAlert[]> {
  const { data } = await getJson<{ data: SysWarning[] }>(`${ELEXON_ROOT}/system/warnings?format=json`);
  return parseGridWarnings(data ?? []);
}

export async function fetchGridSnapshot(): Promise<UkGridSnapshot> {
  const [intensity, generation, regional, demand] = await Promise.allSettled([
    getJson<{ data: Array<{ intensity: { actual: number | null; forecast: number; index: string } }> }>(`${CARBON_ROOT}/intensity`),
    getJson<{ data: { generationmix: GenerationMixEntry[] } }>(`${CARBON_ROOT}/generation`),
    getJson<{ data: Array<{ regions: Array<{ regionid: number; shortname: string; intensity: { forecast: number; index: string } }> }> }>(`${CARBON_ROOT}/regional`),
    getJson<Array<{ startTime: string; demand: number }>>(`${ELEXON_ROOT}/demand/outturn/summary?format=json`),
  ]);
  const current = intensity.status === 'fulfilled' ? intensity.value.data?.[0]?.intensity : undefined;
  const mix = generation.status === 'fulfilled' ? generation.value.data?.generationmix ?? [] : [];
  const regions = regional.status === 'fulfilled' ? regional.value.data?.[0]?.regions ?? [] : [];
  const demandRows = demand.status === 'fulfilled' ? demand.value : [];
  return {
    intensity: current ? current.actual ?? current.forecast : null,
    index: current?.index ?? 'unknown',
    mix,
    renewablePct: renewableShare(mix),
    // The national "GB" rows (ids 15–18) aggregate the DNO regions; keep DNOs only.
    regions: regions
      .filter(r => r.regionid <= 14)
      .map(r => ({ id: r.regionid, name: r.shortname, intensity: r.intensity.forecast, index: r.intensity.index })),
    demandMw: demandRows.length ? demandRows[demandRows.length - 1]!.demand : null,
  };
}

export interface UkSituation {
  alerts: UkAlert[];
  floods: UkFloodWarning[];
  earthquakes: UkEarthquake[];
  grid: UkGridSnapshot | null;
  /** Sources that failed this round — the panel shows them as degraded. */
  failed: UkAlertSource[];
  fetchedAt: number;
}

let lastSituation: UkSituation | null = null;
let inflight: Promise<UkSituation> | null = null;

export function getLastUkSituation(): UkSituation | null {
  return lastSituation;
}

/** The panel and the map layer refresh on the same cadence; let them share a round. */
const SHARE_WINDOW_MS = 60_000;

/** One round across every source; a dead source degrades, never fails, the round. */
export function fetchUkSituation(): Promise<UkSituation> {
  if (inflight) return inflight;
  if (lastSituation && Date.now() - lastSituation.fetchedAt < SHARE_WINDOW_MS) return Promise.resolve(lastSituation);
  inflight = (async () => {
    const [floods, metOffice, tfl, grid, gridSnapshot, quakes] = await Promise.allSettled([
      fetchFloodWarnings(),
      fetchMetOfficeWarnings(),
      fetchTflAlerts(),
      fetchGridWarnings(),
      fetchGridSnapshot(),
      fetchUkEarthquakes(),
    ]);
    const failed: UkAlertSource[] = [];
    const settled = <T>(r: PromiseSettledResult<T>, source: UkAlertSource, fallback: T): T => {
      if (r.status === 'fulfilled') return r.value;
      console.warn(`[uk] ${source} unavailable:`, r.reason);
      failed.push(source);
      return fallback;
    };
    const floodList = settled(floods, 'ea-floods', [] as UkFloodWarning[]);
    const quakeList = settled(quakes, 'bgs', [] as UkEarthquake[]);
    const alerts = [
      ...floodList.map(floodWarningToAlert),
      ...settled(metOffice, 'met-office', [] as UkAlert[]),
      ...settled(tfl, 'tfl', [] as UkAlert[]),
      ...settled(grid, 'neso-grid', [] as UkAlert[]),
      ...quakeList.map(earthquakeToAlert),
    ].sort(compareAlerts);
    const situation: UkSituation = {
      alerts,
      floods: floodList,
      earthquakes: quakeList,
      grid: gridSnapshot.status === 'fulfilled' ? gridSnapshot.value : null,
      failed,
      fetchedAt: Date.now(),
    };
    lastSituation = situation;
    return situation;
  })().finally(() => {
    inflight = null;
  });
  return inflight;
}
