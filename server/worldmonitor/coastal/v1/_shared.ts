/**
 * Shared read helpers for the coastal RPCs.
 *
 * Every handler here is a pure Redis reader. External providers and model
 * inference belong to scripts/seed-coastal.mjs, which runs on a timer — a
 * request must never trigger a fetch or an inference.
 */

import { getCachedJson } from '../../../_shared/redis';

export const COASTAL_CANONICAL_KEY = 'coastal:stations:v1';
export const COASTAL_META_KEY = 'seed-meta:coastal:predictions';

/** Freshness bands. Mirrors scripts/shared/coastal-risk.mjs. */
const LIVE_MAX_MIN = 30;
const DELAYED_MAX_MIN = 90;

export function classifyFreshness(ageMinutes: number | null | undefined): string {
  if (!Number.isFinite(ageMinutes as number)) return 'unknown';
  const age = ageMinutes as number;
  if (age <= LIVE_MAX_MIN) return 'live';
  if (age <= DELAYED_MAX_MIN) return 'delayed';
  return 'stale';
}

export interface StoredHorizon {
  waterLevel?: number;
  lowerBound?: number | null;
  upperBound?: number | null;
  /** Null outside the precomputed tide coverage — never a fabricated zero. */
  predictedTide?: number | null;
  predictedResidual?: number | null;
}

export interface StoredStationRecord {
  station: {
    id: string; name: string; displayName: string; city: string; country: string;
    lat: number; lon: number; timezone: string;
  };
  baseTimestamp: number | null;
  generatedAt: number;
  current: { waterLevel: number; predictedTide: number | null; residual: number | null;
             trend: string; datum: string } | null;
  observations?: { ts: number; level: number }[];
  weather?: Record<string, number | null> | null;
  waterLevelForecast: { status: string; reason?: string; horizons?: Record<string, StoredHorizon>;
                        modelVersion?: string | null };
  warningForecast: { status: string; reason?: string;
                     horizons?: Record<string, { probability: number; warning: boolean | null; threshold: number | null }>;
                     modelVersion?: string | null };
  risk: { level: string; reason: string; basis: string };
  capabilities: { waterLevelPrediction: boolean; warningPrediction: boolean; tide: boolean };
  data: { ageMinutes: number | null; latestUpdate: number | null;
          waterLevelProvider: string; weatherProvider: string; tideProvider: string;
          featureVersion: string };
  model: { regressionVersion: string | null; warningVersion: string | null };
}

export interface StoredCoastalSnapshot {
  stations: StoredStationRecord[];
  generatedAt: number;
}

/** Read the published snapshot. `raw = true`: seeders write unprefixed keys. */
export async function readCoastalSnapshot(): Promise<StoredCoastalSnapshot | null> {
  const value = (await getCachedJson(COASTAL_CANONICAL_KEY, true)) as StoredCoastalSnapshot | null;
  if (!value || !Array.isArray(value.stations)) return null;
  return value;
}

export async function readCoastalMeta(): Promise<{ fetchedAt?: number } | null> {
  return (await getCachedJson(COASTAL_META_KEY, true)) as { fetchedAt?: number } | null;
}

export function findStation(
  snapshot: StoredCoastalSnapshot | null,
  stationId: string,
): StoredStationRecord | null {
  if (!snapshot) return null;
  return snapshot.stations.find((s) => s.station?.id === stationId) ?? null;
}

/**
 * Recompute age at READ time. The stored ageMinutes was true when the seeder
 * ran; serving it verbatim would report a snapshot up to 15 minutes old as if
 * it were current.
 */
export function ageMinutesNow(latestUpdate: number | null | undefined): number | null {
  if (!Number.isFinite(latestUpdate as number)) return null;
  return Math.max(0, Math.round((Date.now() - (latestUpdate as number)) / 60_000));
}
