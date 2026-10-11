/**
 * Provider adapters for coastal data.
 *
 * Every external call in this feature happens here, server-side. The browser
 * never contacts Environment Agency or Open-Meteo directly: it reads a cached
 * prediction record through the `coastal` RPC domain.
 *
 * Each provider normalises an upstream response into OUR shape, so swapping
 * Open-Meteo for Met Office later is a change confined to this file.
 */

import { loadTideModel, predictTideAt, predictTideSeries, tideModelMeta } from './coastal-tide.mjs';

const EA_ROOT = 'https://environment.data.gov.uk/flood-monitoring';
const OPEN_METEO_FORECAST = 'https://api.open-meteo.com/v1/forecast';
const OPEN_METEO_ARCHIVE = 'https://archive-api.open-meteo.com/v1/archive';

// The EA service is reliable but SLOW: a measured `latest` call took 72s.
// A 15-minute cron can absorb that; a short timeout would turn a healthy-but-slow
// upstream into a fake outage.
const EA_TIMEOUT_MS = 120_000;
const WX_TIMEOUT_MS = 30_000;

async function fetchText(url, timeoutMs, label) {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    // A custom User-Agent gets the connection held open and timed out by the EA
    // edge: measured side by side, `latest` returned 200 in 0.79s with curl's
    // default UA and hung for the full 60s with 'worldmonitor-coastal/1'.
    // Send an ordinary browser UA so the request is served.
    headers: {
      Accept: 'text/csv,application/json',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
        + '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    },
  });
  if (!res.ok) throw new Error(`${label} HTTP ${res.status}`);
  return res.text();
}

/** Parse EA readings CSV (`dateTime,measure,value`) for one measure id. */
function parseEaCsv(csv, measureId) {
  const out = [];
  const lines = csv.split('\n');
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const firstComma = line.indexOf(',');
    const lastComma = line.lastIndexOf(',');
    if (firstComma < 0 || lastComma <= firstComma) continue;
    const dateTime = line.slice(0, firstComma);
    const measure = line.slice(firstComma + 1, lastComma);
    const rawValue = line.slice(lastComma + 1);
    if (measureId && !measure.includes(measureId)) continue;
    const ts = Date.parse(dateTime);
    const level = Number(rawValue);
    if (!Number.isFinite(ts) || !Number.isFinite(level)) continue;
    out.push({ ts, level });
  }
  // `readings?date=` returns rows UNSORTED (verified: 00:00, 00:30, 00:15…),
  // so sorting here is required, not defensive.
  out.sort((a, b) => a.ts - b.ts);
  return out;
}

export const environmentAgencyWaterLevel = {
  id: 'environment-agency',

  /** Latest single reading. @returns {Promise<{ts:number, level:number}|null>} */
  async getLatest(station) {
    const url = `${EA_ROOT}/data/readings.csv?latest&stationReference=${encodeURIComponent(station.code)}`;
    const csv = await fetchText(url, EA_TIMEOUT_MS, 'EA latest');
    const rows = parseEaCsv(csv, station.waterLevelExternalId);
    return rows.length ? rows[rows.length - 1] : null;
  },

  /**
   * Readings over a date range, inclusive. EA caps a single response, so we
   * page per UTC day — also the only documented range form
   * (`since=` is rejected with HTTP 400 on this endpoint).
   */
  async getHistory(station, fromMs, toMs) {
    const out = [];
    const day = 86_400_000;
    const startDay = Math.floor(fromMs / day) * day;
    for (let d = startDay; d <= toMs; d += day) {
      const ds = new Date(d).toISOString().slice(0, 10);
      const url = `${EA_ROOT}/id/measures/${encodeURIComponent(station.waterLevelExternalId)}/readings.csv?date=${ds}`;
      try {
        const csv = await fetchText(url, EA_TIMEOUT_MS, `EA ${ds}`);
        out.push(...parseEaCsv(csv, station.waterLevelExternalId));
      } catch (err) {
        // A single missing day must not void the window — the caller decides
        // whether what remains is enough (insufficient_history). But a failure
        // on the CURRENT day silently costs the newest samples, which is what
        // makes the panel go blank, so name that case explicitly.
        const isToday = ds === new Date(toMs).toISOString().slice(0, 10);
        console.warn(
          `[coastal] EA history ${ds} failed${isToday ? ' (TODAY — window will lack its newest samples)' : ''}: `
          + `${err?.message || err}`,
        );
      }
    }
    // Dedupe by timestamp: EA publishes the same gauge under several measure
    // ids (E70139 appears once per region), and the day pages can overlap.
    const byTs = new Map();
    for (const r of out) {
      if (r.ts >= fromMs && r.ts <= toMs) byTs.set(r.ts, r);
    }
    return [...byTs.values()].sort((a, b) => a.ts - b.ts);
  },
};

function normaliseOpenMeteo(hourly) {
  const t = hourly?.time || [];
  const pick = (k) => hourly?.[k] || [];
  const pressure = pick('pressure_msl');
  const windSpeed = pick('wind_speed_10m');
  const windDir = pick('wind_direction_10m');
  const windGust = pick('wind_gusts_10m');
  const precip = pick('precipitation');
  const temp = pick('temperature_2m');
  const num = (arr, i) => (Number.isFinite(arr?.[i]) ? arr[i] : null);
  return t.map((iso, i) => ({
    // Open-Meteo returns naive UTC strings when timezone=UTC.
    ts: Date.parse(`${iso}:00Z`.replace(/(:\d{2})?:00Z$/, ':00Z')),
    pressure: num(pressure, i),
    windSpeed: num(windSpeed, i),
    windDirection: num(windDir, i),
    windGust: num(windGust, i),
    precipitation: num(precip, i),
    temperature: num(temp, i),
    soilMoisture: null, // not requested; nullable by contract, never fabricated
  })).filter((x) => Number.isFinite(x.ts));
}

const HOURLY_VARS = 'pressure_msl,wind_speed_10m,wind_direction_10m,wind_gusts_10m,precipitation,temperature_2m';

export const openMeteoWeather = {
  id: 'open-meteo',

  /** Observed/analysed weather for a past window (ERA5 archive). */
  async getRecentHistory(station, fromMs, toMs) {
    const s = new Date(fromMs).toISOString().slice(0, 10);
    const e = new Date(toMs).toISOString().slice(0, 10);
    const url = `${OPEN_METEO_ARCHIVE}?latitude=${station.lat}&longitude=${station.lon}`
      + `&start_date=${s}&end_date=${e}&hourly=${HOURLY_VARS}&timezone=UTC`;
    const json = JSON.parse(await fetchText(url, WX_TIMEOUT_MS, 'open-meteo archive'));
    return normaliseOpenMeteo(json.hourly);
  },

  /** Current conditions = most recent hour at or before now, from the forecast run. */
  async getCurrentConditions(station) {
    const rows = await this.getHourlyForecast(station, 1);
    const now = Date.now();
    const past = rows.filter((r) => r.ts <= now);
    return past.length ? past[past.length - 1] : null;
  },

  /**
   * Forward weather. Labelled as FORECAST by the caller and never merged into
   * the observed-weather block of the feature vector.
   */
  async getHourlyForecast(station, days = 2) {
    const url = `${OPEN_METEO_FORECAST}?latitude=${station.lat}&longitude=${station.lon}`
      + `&hourly=${HOURLY_VARS}&forecast_days=${days}&past_days=1&timezone=UTC`;
    const json = JSON.parse(await fetchText(url, WX_TIMEOUT_MS, 'open-meteo forecast'));
    return normaliseOpenMeteo(json.hourly);
  },
};

/**
 * Astronomical tide, from a harmonic fit of this station's own observations.
 *
 * `training/fit_tide.py` runs utide over 362 days of Environment Agency
 * readings (99.32% of variance explained, 59 constituents, M2 amplitude
 * 3.03 m), and `training/export_tide_series.py` writes a precomputed 15-minute
 * series that `coastal-tide.mjs` interpolates. Verified against the Python
 * reference to 0.0000 m.
 *
 * Still NOT an official source: these are values derived from the gauge, not
 * UKHO/Admiralty predictions, and must not be used for navigation. Outside the
 * precomputed coverage window the provider reports unavailable rather than
 * extrapolating a sine wave into nonsense.
 */
export const harmonicTideProvider = {
  id: 'harmonic-utide',

  /** @returns {{status:string, values?:Array<{ts:number,tide:number|null}>, meta?:object}} */
  getPredictedTide(station, timestamps, modelDir) {
    const loaded = loadTideModel(modelDir, station.id);
    if (loaded.status !== 'ready') {
      return { status: loaded.status, reason: loaded.reason, values: null };
    }
    return {
      status: 'ready',
      values: predictTideSeries(loaded, timestamps),
      meta: tideModelMeta(loaded),
    };
  },

  /** Single instant; null when outside coverage. */
  tideAt(station, tMs, modelDir) {
    const loaded = loadTideModel(modelDir, station.id);
    if (loaded.status !== 'ready') return null;
    return predictTideAt(loaded, tMs);
  },
};

/** Kept for stations that genuinely have no tide model configured. */
export const nullTideProvider = {
  id: 'none',
  getPredictedTide() {
    return { status: 'tide_provider_not_configured', values: null };
  },
};

export function resolveProviders(station) {
  const water = station.waterLevelProvider === 'environment-agency' ? environmentAgencyWaterLevel : null;
  const weather = station.weatherProvider === 'open-meteo' ? openMeteoWeather : null;
  const tide = station.tideProvider === 'harmonic-utide' ? harmonicTideProvider : nullTideProvider;
  if (!water) throw new Error(`no water-level provider for ${station.waterLevelProvider}`);
  return { water, weather, tide };
}
