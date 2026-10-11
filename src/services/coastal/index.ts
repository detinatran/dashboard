/**
 * Coastal water-level prediction — frontend service.
 *
 * Thin wrapper over the generated RPC client. It NEVER contacts Environment
 * Agency, Open-Meteo or any model: those live server-side behind the coastal
 * seed cron. Everything here reads a cached record.
 *
 * Statuses are passed through untouched. A caller must branch on
 * `waterLevelForecast.status === 'ready'` rather than on the presence of a
 * number, so a refusal can never be rendered as a forecast.
 */

import { CoastalServiceClient } from '@/services/generated-rpc-clients';
import { getRpcBaseUrl } from '@/services/rpc-client';
import type {
  CoastalStation,
  GetForecastResponse,
  GetHistoryResponse,
  ListStationsResponse,
} from '@/generated/client/worldmonitor/coastal/v1/service_client';

const client = new CoastalServiceClient(getRpcBaseUrl(), {
  fetch: (...args: Parameters<typeof globalThis.fetch>) => globalThis.fetch(...args),
});

/** Markers are cheap and shared; the panel payload is per-station and larger. */
const STATIONS_TTL_MS = 5 * 60_000;
const FORECAST_TTL_MS = 60_000;

let stationsCache: { at: number; value: ListStationsResponse } | null = null;
const forecastCache = new Map<string, { at: number; value: GetForecastResponse }>();

const EMPTY_STATIONS: ListStationsResponse = { stations: [], fetchedAt: 0, dataAvailable: false };

export type CoastalDataStatus = 'live' | 'delayed' | 'stale' | 'unknown';
export type CoastalRiskLevel = 'normal' | 'advisory' | 'watch' | 'high' | 'unknown';

export type { CoastalStation, GetForecastResponse, GetHistoryResponse, ListStationsResponse };

/**
 * Active prediction sites. Returns an empty list rather than throwing: the map
 * must still render when the domain is unavailable.
 */
export async function fetchCoastalStations(force = false): Promise<ListStationsResponse> {
  if (!force && stationsCache && Date.now() - stationsCache.at < STATIONS_TTL_MS) {
    return stationsCache.value;
  }
  try {
    const value = await client.listStations({});
    stationsCache = { at: Date.now(), value };
    return value;
  } catch (err) {
    console.warn('[coastal] listStations failed:', err);
    return stationsCache?.value ?? EMPTY_STATIONS;
  }
}

export async function fetchCoastalForecast(
  stationId: string,
  force = false,
): Promise<GetForecastResponse | null> {
  if (!stationId) return null;
  const hit = forecastCache.get(stationId);
  if (!force && hit && Date.now() - hit.at < FORECAST_TTL_MS) return hit.value;
  try {
    const value = await client.getForecast({ stationId });
    forecastCache.set(stationId, { at: Date.now(), value });
    return value;
  } catch (err) {
    console.warn('[coastal] getForecast failed:', err);
    return hit?.value ?? null;
  }
}

/** Observation window for the chart. Fetched lazily, only when a panel opens. */
export async function fetchCoastalHistory(
  stationId: string,
  hours = 24,
): Promise<GetHistoryResponse | null> {
  if (!stationId) return null;
  try {
    return await client.getHistory({ stationId, hours });
  } catch (err) {
    console.warn('[coastal] getHistory failed:', err);
    return null;
  }
}

/** Risk → semantic token. Uses the existing ladder; never a bespoke hex. */
export function riskColorToken(level: string): string {
  switch (level) {
    case 'high': return '--semantic-high';
    case 'watch': return '--semantic-elevated';
    case 'advisory': return '--semantic-info';
    case 'normal': return '--semantic-normal';
    default: return '--text-muted';
  }
}

/**
 * Icon per risk level. Status is never conveyed by colour alone — this pairs
 * with a text label everywhere it is used.
 */
export function riskIcon(level: string): string {
  switch (level) {
    case 'high': return '▲';      // ▲
    case 'watch': return '△';     // △
    case 'advisory': return '◇';  // ◇
    case 'normal': return '●';    // ●
    default: return '○';          // ○
  }
}

export function isCoastalForecastReady(res: GetForecastResponse | null): boolean {
  return Boolean(res?.waterLevelForecast?.status === 'ready'
    && (res.waterLevelForecast.horizons?.length ?? 0) > 0);
}

export function clearCoastalCache(): void {
  stationsCache = null;
  forecastCache.clear();
}
