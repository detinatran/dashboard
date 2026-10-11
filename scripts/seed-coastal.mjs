#!/usr/bin/env node

/**
 * Coastal water-level ingestion + scheduled inference.
 *
 * Runs on the Railway cron fleet (and the self-hosted scheduler). Every
 * external call and every model run happens here, on a timer — never inside a
 * user request. The RPC handlers only read what this publishes.
 *
 * Per tick, per active station:
 *   fetch observations -> merge into a 24h window -> fetch weather ->
 *   build features -> run whichever models exist -> publish a prediction record.
 *
 * When a model is absent or incompatible the record still publishes, carrying a
 * status instead of numbers. Observed level, trend and the 24h history remain
 * useful on their own; a fabricated forecast would not be.
 */

import { loadEnvFile, runSeed, readCanonicalValue, writeExtraKey } from './_seed-utils.mjs';
import { listActiveStations, COASTAL_KEYS } from './shared/coastal-stations.mjs';
import { resolveProviders } from './shared/coastal-providers.mjs';
import { buildFeatures, FEATURE_VERSION, REQUIRED_HISTORY_HOURS } from './shared/coastal-features.mjs';
import { OnnxWaterLevelModel, OnnxWarningModel, modelDir, HORIZONS } from './shared/coastal-models.mjs';
import { isTideSeriesValidAt, loadTideModel, predictTideAt, tideModelMeta } from './shared/coastal-tide.mjs';
import { evaluateRisk } from './shared/coastal-risk.mjs';

loadEnvFile(import.meta.url);

const HOUR_MS = 3_600_000;
const WINDOW_HOURS = 30;            // 24h required + margin for late/missing samples
const OBS_TTL = 7 * 24 * 3600;      // observations outlive several missed ticks
const PREDICTION_TTL = 6 * 3600;

const REGRESSION_DIR = modelDir('REGRESSION_MODEL_DIR', '/app/models/regression');
const WARNING_DIR = modelDir('WARNING_MODEL_DIR', '/app/models/warning');
const TIDE_DIR = modelDir('TIDE_MODEL_DIR', REGRESSION_DIR);

// One model instance per process: ONNX sessions are created once and reused
// across ticks, never per prediction.
const regressionModels = new Map();
const warningModels = new Map();

function regressionFor(stationId) {
  if (!regressionModels.has(stationId)) {
    regressionModels.set(stationId, new OnnxWaterLevelModel({ dir: REGRESSION_DIR, stationId }));
  }
  return regressionModels.get(stationId);
}
function warningFor(stationId) {
  if (!warningModels.has(stationId)) {
    warningModels.set(stationId, new OnnxWarningModel({ dir: WARNING_DIR, stationId }));
  }
  return warningModels.get(stationId);
}

/** Merge new readings into the stored window, dedupe by timestamp, trim. */
function mergeObservations(existing, incoming, nowMs) {
  const byTs = new Map();
  for (const r of existing || []) {
    if (Number.isFinite(r?.ts) && Number.isFinite(r?.level)) byTs.set(r.ts, r);
  }
  for (const r of incoming || []) {
    if (Number.isFinite(r?.ts) && Number.isFinite(r?.level)) byTs.set(r.ts, r);
  }
  const cutoff = nowMs - WINDOW_HOURS * HOUR_MS;
  return [...byTs.values()]
    .filter((r) => r.ts >= cutoff && r.ts <= nowMs + 5 * 60_000)
    .sort((a, b) => a.ts - b.ts);
}

async function ingestStation(station, nowMs) {
  const { water, weather } = resolveProviders(station);
  const obsKey = COASTAL_KEYS.observations(station.id);

  // readCanonicalValue unwraps the seed envelope itself, so this is the bare
  // array the previous tick wrote through writeExtraKey.
  const stored = await readCanonicalValue(obsKey).catch(() => null);
  const prior = Array.isArray(stored) ? stored : [];

  // Cold start needs the whole window; a warm process only needs the tail.
  const newest = prior.length ? prior[prior.length - 1].ts : 0;
  const needsBackfill = !prior.length || (nowMs - newest) > 2 * HOUR_MS;

  let fetched = [];
  try {
    fetched = needsBackfill
      ? await water.getHistory(station, nowMs - WINDOW_HOURS * HOUR_MS, nowMs)
      : [await water.getLatest(station)].filter(Boolean);
  } catch (err) {
    console.warn(`[coastal] ${station.id}: water fetch failed: ${err?.message || err}`);
  }

  const observations = mergeObservations(prior, fetched, nowMs);

  // A slow EA day makes getHistory() time out mid-page; it warns and returns
  // what it got, so a window missing its newest hours still publishes and the
  // panel just goes blank. Measured once: a 171s run left the window ending
  // 936 minutes back while /data/readings.csv?latest was only 57 minutes old.
  // Cross-check the cheap `latest` endpoint and pull the tail in rather than
  // letting the gap through silently.
  const newestAfterMerge = observations.length ? observations[observations.length - 1].ts : 0;
  if (nowMs - newestAfterMerge > 3 * HOUR_MS) {
    try {
      const tail = await water.getLatest(station);
      if (tail && tail.ts > newestAfterMerge) {
        console.warn(
          `[coastal] ${station.id}: backfill ended ${Math.round((nowMs - newestAfterMerge) / 60_000)}min back `
          + `but latest is ${Math.round((nowMs - tail.ts) / 60_000)}min back — backfill was incomplete`,
        );
        observations.push(tail);
        observations.sort((a, b) => a.ts - b.ts);
      }
    } catch (err) {
      console.warn(`[coastal] ${station.id}: latest cross-check failed: ${err?.message || err}`);
    }
  }

  let weatherRows = [];
  let weatherForecast = [];
  if (weather) {
    try {
      // past_days=1 gives observed hours; the forward hours are FORECAST and
      // are kept in a separate field so they can never enter the observed block.
      const rows = await weather.getHourlyForecast(station, 2);
      weatherRows = rows.filter((r) => r.ts <= nowMs);
      weatherForecast = rows.filter((r) => r.ts > nowMs);
    } catch (err) {
      console.warn(`[coastal] ${station.id}: weather fetch failed: ${err?.message || err}`);
    }
  }

  return { observations, weatherRows, weatherForecast };
}

async function predictStation(station, observations, weatherRows, nowMs) {
  const built = buildFeatures(observations, nowMs, weatherRows);
  if (built.error) {
    return {
      waterLevelForecast: { status: built.error === 'insufficient_history' ? 'insufficient_history' : built.error },
      warningForecast: { status: 'not_evaluated' },
      featureMeta: null,
    };
  }

  const reg = regressionFor(station.id);
  const warn = warningFor(station.id);
  const [regOut, warnOut] = await Promise.all([
    reg.predict(built.features).catch((e) => ({ status: 'inference_failed', reason: e?.message })),
    warn.predict(built.features).catch((e) => ({ status: 'inference_failed', reason: e?.message })),
  ]);

  return { waterLevelForecast: regOut, warningForecast: warnOut, featureMeta: built.meta };
}

async function fetchCoastal() {
  const nowMs = Date.now();
  const stations = listActiveStations();
  const records = [];

  for (const station of stations) {
    const { observations, weatherRows, weatherForecast } = await ingestStation(station, nowMs);
    const latest = observations.length ? observations[observations.length - 1] : null;
    const { waterLevelForecast, warningForecast, featureMeta } =
      await predictStation(station, observations, weatherRows, nowMs);

    const ageMinutes = latest ? Math.round((nowMs - latest.ts) / 60_000) : null;

    // Triều thiên văn: chuỗi tính sẵn từ phân tích điều hoà trên chính quan
    // trắc của trạm. Ngoài vùng phủ -> null, KHÔNG ngoại suy.
    const tideLoaded = loadTideModel(TIDE_DIR, station.id);
    const tideNow = latest ? predictTideAt(tideLoaded, latest.ts) : null;
    const residualNow = latest && Number.isFinite(tideNow)
      ? Number((latest.level - tideNow).toFixed(3))
      : null;

    // Gắn triều + residual vào từng horizon đã dự báo. Residual dự báo suy ra
    // từ mực nước dự báo trừ triều — không phải một đại lượng mô hình tự sinh.
    if (waterLevelForecast.status === 'ready' && waterLevelForecast.horizons) {
      for (const [key, h] of Object.entries(waterLevelForecast.horizons)) {
        const hours = Number(String(key).replace('h', ''));
        const at = latest && Number.isFinite(hours) ? latest.ts + hours * HOUR_MS : null;
        const tideAtH = at ? predictTideAt(tideLoaded, at) : null;
        h.predictedTide = Number.isFinite(tideAtH) ? Number(tideAtH.toFixed(3)) : null;
        h.predictedResidual = Number.isFinite(tideAtH)
          ? Number((h.waterLevel - tideAtH).toFixed(3))
          : null;
      }
    }

    const risk = evaluateRisk({ station, waterLevelForecast, warningForecast, latest });

    records.push({
      station: {
        id: station.id, name: station.name, displayName: station.displayName,
        city: station.city, country: station.country,
        lat: station.lat, lon: station.lon, timezone: station.timezone,
      },
      baseTimestamp: latest?.ts ?? null,
      generatedAt: nowMs,
      current: latest
        ? {
            waterLevel: Number(latest.level.toFixed(3)),
            predictedTide: Number.isFinite(tideNow) ? Number(tideNow.toFixed(3)) : null,
            residual: residualNow,
            trend: featureMeta?.trend ?? 'unknown',
            datum: station.datum,
          }
        : null,
      observations,
      weather: weatherRows.length ? weatherRows[weatherRows.length - 1] : null,
      weatherForecast,
      waterLevelForecast,
      warningForecast,
      risk,
      capabilities: {
        waterLevelPrediction: waterLevelForecast.status === 'ready',
        warningPrediction: warningForecast.status === 'ready',
        tide: tideLoaded.status === 'ready' && Boolean(latest) && isTideSeriesValidAt(tideLoaded, latest.ts),
      },
      data: {
        ageMinutes,
        latestUpdate: latest?.ts ?? null,
        waterLevelProvider: station.waterLevelProvider,
        weatherProvider: station.weatherProvider,
        tideProvider: station.tideProvider,
        featureVersion: FEATURE_VERSION,
        requiredHistoryHours: REQUIRED_HISTORY_HOURS,
        tide: tideModelMeta(tideLoaded),
      },
      model: {
        regressionVersion: waterLevelForecast.modelVersion ?? null,
        warningVersion: warningForecast.modelVersion ?? null,
      },
    });
  }

  return { stations: records, generatedAt: nowMs };
}

export function validate(data) {
  return Array.isArray(data?.stations) && data.stations.length > 0;
}

export function declareRecords(data) {
  return Array.isArray(data?.stations) ? data.stations.length : 0;
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^.*[\\/]/, ''));
if (isMain) {
  runSeed('coastal', 'predictions', COASTAL_KEYS.stations, fetchCoastal, {
    validateFn: validate,
    ttlSeconds: PREDICTION_TTL,
    declareRecords,
    sourceVersion: `ea-openmeteo-${FEATURE_VERSION}`,
    schemaVersion: 1,
    maxStaleMin: 60,
    // Per-station observation windows are written alongside the canonical
    // record so a failed tick preserves the last good window.
    afterPublish: async (data) => {
      for (const rec of data.stations) {
        await writeExtraKey(COASTAL_KEYS.observations(rec.station.id), rec.observations, OBS_TTL);
      }
    },
  }).catch((err) => {
    console.error('FATAL:', err.message || err);
    process.exit(1);
  });
}

export { fetchCoastal, mergeObservations };
