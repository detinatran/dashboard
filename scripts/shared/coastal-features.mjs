/**
 * Feature builder for the coastal models, shared by training and live inference.
 *
 * Training and production have to build features the same way or the offline
 * metrics don't mean anything, so this is the only implementation. It sits in
 * `scripts/shared/` so both the Railway seeder (build root `scripts/`) and the
 * Python training scripts (which call it through Node) can use it.
 *
 * No look-ahead (checked by tests/coastal-feature-leakage.test.mts):
 *   buildFeatures(history, t) may only read samples with timestamp <= t.
 *   Forecast weather is allowed, but only through `weatherForecast`, and it is
 *   kept apart from the observed weather.
 *
 * Bump FEATURE_VERSION whenever the vector changes (order, count or meaning).
 * The model loader rejects models trained on another version, because a
 * reordered vector still gives numbers, just wrong ones.
 */

export const FEATURE_VERSION = 'coastal-v1';

/** Window, in hours, of observations required before any prediction. */
export const REQUIRED_HISTORY_HOURS = 24;

/**
 * How old the newest observation can be and still be used for a prediction.
 * This isn't the display freshness rule (see classifyFreshness()); past this
 * point the forecast just wouldn't mean much.
 */
export const MAX_ANCHOR_AGE_MIN = 180;

/**
 * Feature names, in order. ONNX takes a positional float32 tensor, so changing
 * the order changes what each input means.
 */
export const FEATURE_NAMES = Object.freeze([
  // — current state —
  'level',
  'level_delta_15m',
  'level_delta_1h',
  'level_delta_3h',
  // — rolling statistics over the observed level —
  'level_mean_3h', 'level_max_3h', 'level_min_3h', 'level_std_3h',
  'level_mean_6h', 'level_max_6h', 'level_min_6h', 'level_std_6h',
  'level_mean_12h', 'level_max_12h', 'level_min_12h', 'level_std_12h',
  'level_mean_24h', 'level_max_24h', 'level_min_24h', 'level_std_24h',
  // — tidal phase proxies —
  // No tide model here, so recent highs/lows and where the current level sits
  // in the last 12h range give a rough idea of the tide phase.
  'level_range_12h',
  'level_pos_in_range_12h',
  'hours_since_max_12h',
  'hours_since_min_12h',
  // — calendar cyclics (semidiurnal tide is ~12.42h, so encode both) —
  'hour_sin', 'hour_cos',
  'doy_sin', 'doy_cos',
  'lunar_sin', 'lunar_cos',
  // — observed weather (nullable → imputed, with presence flags) —
  'pressure', 'pressure_delta_3h', 'pressure_mean_24h',
  'wind_speed', 'wind_gust', 'wind_u', 'wind_v',
  'precip', 'precip_sum_6h', 'precip_sum_24h',
  'temp',
  'weather_present',
]);

export const FEATURE_COUNT = FEATURE_NAMES.length;

/** Mean lunar synodic month, days. Drives the spring/neap cyclic. */
const SYNODIC_DAYS = 29.530588853;
/** A known new moon (UTC) used as the lunar phase epoch. */
const LUNAR_EPOCH_MS = Date.UTC(2000, 0, 6, 18, 14);

const MS_PER_HOUR = 3_600_000;

function mean(xs) { return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0; }
function stdev(xs) {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length);
}

/**
 * Samples in (t - hours, t]: includes t itself, nothing after it. All window
 * reads go through here, which keeps the leakage test simple.
 */
function windowSamples(history, tMs, hours) {
  const from = tMs - hours * MS_PER_HOUR;
  return history.filter((s) => s.ts > from && s.ts <= tMs);
}

/** Nearest sample at or before `targetMs`, or null. */
function sampleAtOrBefore(history, targetMs) {
  let best = null;
  for (const s of history) {
    if (s.ts <= targetMs && (!best || s.ts > best.ts)) best = s;
  }
  return best;
}

/**
 * @param {{ts:number, level:number}[]} history  observed levels, any order
 * @param {number} tMs                            prediction time (epoch ms)
 * @param {{ts:number, pressure?:number|null, windSpeed?:number|null,
 *          windGust?:number|null, windDirection?:number|null,
 *          precipitation?:number|null, temperature?:number|null}[]} [weather]
 *          OBSERVED weather only. Forecast values must not be passed here.
 * @returns {{features: Float32Array, meta: object} | {error: string}}
 */
export function buildFeatures(history, tMs, weather = []) {
  const past = history
    .filter((s) => Number.isFinite(s.ts) && Number.isFinite(s.level) && s.ts <= tMs)
    .sort((a, b) => a.ts - b.ts);

  if (past.length === 0) return { error: 'no_history' };

  const current = past[past.length - 1];
  // Don't predict from a stale window, or an old sample gets treated as "now".
  // The EA feed often lags real time by over an hour even when the gauge is
  // fine (75 min in one dry run), so a 60 min cap meant we almost never
  // predicted. 3h still keeps us close to a recent reading, and the real age
  // shows up in the live/delayed/stale badge anyway.
  const ageMin = (tMs - current.ts) / 60_000;
  if (ageMin > MAX_ANCHOR_AGE_MIN) {
    return { error: 'history_stale', ageMinutes: Math.round(ageMin) };
  }

  const spanHours = (current.ts - past[0].ts) / MS_PER_HOUR;
  if (spanHours < REQUIRED_HISTORY_HOURS - 1) {
    return { error: 'insufficient_history', haveHours: Number(spanHours.toFixed(2)) };
  }

  const at = (hoursBack) => sampleAtOrBefore(past, current.ts - hoursBack * MS_PER_HOUR);
  const lvl = current.level;
  const d15 = at(0.25), d1 = at(1), d3 = at(3);

  const w = {};
  for (const h of [3, 6, 12, 24]) {
    const xs = windowSamples(past, current.ts, h).map((s) => s.level);
    w[h] = {
      mean: mean(xs),
      max: xs.length ? Math.max(...xs) : lvl,
      min: xs.length ? Math.min(...xs) : lvl,
      std: stdev(xs),
    };
  }

  const win12 = windowSamples(past, current.ts, 12);
  const range12 = w[12].max - w[12].min;
  const posInRange = range12 > 1e-6 ? (lvl - w[12].min) / range12 : 0.5;
  const maxSample = win12.reduce((a, s) => (a && a.level >= s.level ? a : s), null);
  const minSample = win12.reduce((a, s) => (a && a.level <= s.level ? a : s), null);
  const hoursSinceMax = maxSample ? (current.ts - maxSample.ts) / MS_PER_HOUR : 0;
  const hoursSinceMin = minSample ? (current.ts - minSample.ts) / MS_PER_HOUR : 0;

  const dt = new Date(tMs);
  const hourFrac = dt.getUTCHours() + dt.getUTCMinutes() / 60;
  const doy = (Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate())
    - Date.UTC(dt.getUTCFullYear(), 0, 0)) / 86_400_000;
  const lunarPhase = (((tMs - LUNAR_EPOCH_MS) / 86_400_000) % SYNODIC_DAYS) / SYNODIC_DAYS;

  // Observed weather at or before t only.
  const wxPast = (weather || [])
    .filter((x) => Number.isFinite(x.ts) && x.ts <= tMs)
    .sort((a, b) => a.ts - b.ts);
  const wxNow = wxPast[wxPast.length - 1] ?? null;
  const wxWin = (h) => wxPast.filter((x) => x.ts > tMs - h * MS_PER_HOUR);
  const num = (v) => (Number.isFinite(v) ? v : null);

  const pressure = wxNow ? num(wxNow.pressure) : null;
  const wx3 = wxWin(3);
  const pressure3hAgo = wx3.length ? num(wx3[0].pressure) : null;
  const pressures24 = wxWin(24).map((x) => num(x.pressure)).filter((v) => v !== null);
  const precip6 = wxWin(6).map((x) => num(x.precipitation) ?? 0);
  const precip24 = wxWin(24).map((x) => num(x.precipitation) ?? 0);

  const windSpeed = wxNow ? num(wxNow.windSpeed) : null;
  const windDir = wxNow ? num(wxNow.windDirection) : null;
  // Split wind into u/v so direction is continuous. With raw degrees, 359 and 1
  // would look as far apart as possible.
  const dirRad = windDir === null ? null : (windDir * Math.PI) / 180;
  const windU = windSpeed !== null && dirRad !== null ? -windSpeed * Math.sin(dirRad) : null;
  const windV = windSpeed !== null && dirRad !== null ? -windSpeed * Math.cos(dirRad) : null;

  // Missing weather: 0 for deltas and totals, standard pressure for pressure,
  // 0 for the rest. weather_present tells the model when values were filled in.
  const IMPUTE_PRESSURE = 1013.25;
  const f = [
    lvl,
    d15 ? lvl - d15.level : 0,
    d1 ? lvl - d1.level : 0,
    d3 ? lvl - d3.level : 0,
    w[3].mean, w[3].max, w[3].min, w[3].std,
    w[6].mean, w[6].max, w[6].min, w[6].std,
    w[12].mean, w[12].max, w[12].min, w[12].std,
    w[24].mean, w[24].max, w[24].min, w[24].std,
    range12,
    posInRange,
    hoursSinceMax,
    hoursSinceMin,
    Math.sin((2 * Math.PI * hourFrac) / 24), Math.cos((2 * Math.PI * hourFrac) / 24),
    Math.sin((2 * Math.PI * doy) / 365.25), Math.cos((2 * Math.PI * doy) / 365.25),
    Math.sin(2 * Math.PI * lunarPhase), Math.cos(2 * Math.PI * lunarPhase),
    pressure ?? IMPUTE_PRESSURE,
    pressure !== null && pressure3hAgo !== null ? pressure - pressure3hAgo : 0,
    pressures24.length ? mean(pressures24) : (pressure ?? IMPUTE_PRESSURE),
    windSpeed ?? 0,
    wxNow ? (num(wxNow.windGust) ?? 0) : 0,
    windU ?? 0,
    windV ?? 0,
    wxNow ? (num(wxNow.precipitation) ?? 0) : 0,
    precip6.reduce((a, b) => a + b, 0),
    precip24.reduce((a, b) => a + b, 0),
    wxNow ? (num(wxNow.temperature) ?? 0) : 0,
    wxNow ? 1 : 0,
  ];

  if (f.length !== FEATURE_COUNT) {
    throw new Error(`feature count drift: built ${f.length}, declared ${FEATURE_COUNT}`);
  }
  for (let i = 0; i < f.length; i++) {
    if (!Number.isFinite(f[i])) {
      throw new Error(`non-finite feature ${FEATURE_NAMES[i]} at index ${i}`);
    }
  }

  return {
    features: Float32Array.from(f),
    meta: {
      featureVersion: FEATURE_VERSION,
      baseTimestamp: current.ts,
      currentLevel: lvl,
      sampleCount: past.length,
      historyHours: Number(spanHours.toFixed(2)),
      weatherPresent: Boolean(wxNow),
      trend: classifyTrend(lvl, d15?.level ?? null, d1?.level ?? null),
    },
  };
}

/**
 * Trend arrow from recent observations only. Using the forecast here would
 * make a model guess look like a measurement.
 */
export function classifyTrend(current, prev15, prev1h) {
  const ref = prev15 ?? prev1h;
  if (ref === null || ref === undefined) return 'unknown';
  const d = current - ref;
  if (Math.abs(d) < 0.02) return 'stable';
  return d > 0 ? 'rising' : 'falling';
}
