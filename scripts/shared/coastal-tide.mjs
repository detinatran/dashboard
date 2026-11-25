/**
 * Astronomical tide, interpolated from a precomputed series.
 *
 * We don't rebuild the tide from the harmonic coefficients here. I tried, and
 * it came out up to 6 m off (nearly opposite phase): utide uses Greenwich phase
 * in astronomical time plus nodal corrections that change over time, not a
 * plain `A·cos(2πft − g)` from some epoch. So `training/export_tide_series.py`
 * has utide compute a 15-minute series and this module just interpolates it.
 *
 * Linear interpolation on 15-minute steps of a 12.4h tide is off by less than
 * 1 cm, well under the 0.19 m residual stdev.
 *
 * Note: the tide is derived from the station's own data, not official
 * UKHO/Admiralty predictions, so don't use it for navigation. The series ends
 * at coverageTo; after that lookups return null instead of extrapolating.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export function loadTideModel(dir, stationId) {
  const path = join(dir, `${stationId}.tide.json`);
  if (!existsSync(path)) return { status: 'tide_model_not_configured' };
  let m;
  try {
    m = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    return { status: 'tide_model_incompatible', reason: String(err?.message || err) };
  }
  if (!Array.isArray(m.values) || m.values.length < 2) {
    return { status: 'tide_model_incompatible', reason: 'chuỗi triều rỗng' };
  }
  if (!(Number(m.varianceExplained) > 0.9)) {
    return {
      status: 'tide_model_incompatible',
      reason: `khớp điều hoà chỉ giải thích ${(Number(m.varianceExplained) * 100).toFixed(2)}% phương sai`,
    };
  }
  if (!Number.isFinite(m.startMs) || !Number.isFinite(m.stepMs) || m.stepMs <= 0) {
    return { status: 'tide_model_incompatible', reason: 'thiếu startMs/stepMs' };
  }
  return { status: 'ready', model: m };
}

/**
 * Tide at tMs, linearly interpolated. Returns null outside the series; we
 * don't extrapolate because it drifts off quickly and would still be shown
 * as a real value.
 */
export function predictTideAt(loaded, tMs) {
  if (loaded?.status !== 'ready') return null;
  const { startMs, stepMs, values } = loaded.model;
  const pos = (tMs - startMs) / stepMs;
  if (!Number.isFinite(pos) || pos < 0 || pos > values.length - 1) return null;
  const i = Math.floor(pos);
  const frac = pos - i;
  const a = values[i];
  const b = values[Math.min(i + 1, values.length - 1)];
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return a + (b - a) * frac;
}

// Only harmonicTideProvider (commented out) called this.
// /** Tide for several instants; any instant outside the series gets tide = null. */
// export function predictTideSeries(loaded, timestamps) {
//   if (loaded?.status !== 'ready') return null;
//   return timestamps.map((ts) => ({ ts, tide: predictTideAt(loaded, ts) }));
// }

/** Does the series cover this instant? */
export function isTideSeriesValidAt(loaded, tMs) {
  if (loaded?.status !== 'ready') return false;
  const { startMs, stepMs, values } = loaded.model;
  const endMs = startMs + (values.length - 1) * stepMs;
  return tMs >= startMs && tMs <= endMs;
}

export function tideModelMeta(loaded) {
  if (loaded?.status !== 'ready') return { status: loaded?.status ?? 'unknown', reason: loaded?.reason };
  const m = loaded.model;
  return {
    status: 'ready',
    method: m.method,
    varianceExplained: m.varianceExplained,
    residualStd: m.residualStd,
    coverageFrom: m.coverageFrom,
    coverageTo: m.coverageTo,
    caveats: m.caveats ?? [],
  };
}
