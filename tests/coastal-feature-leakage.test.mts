/**
 * Leakage gate for the coastal feature builder.
 *
 * A water-level model is trivially "accurate" if a single future sample reaches
 * the feature vector, and the failure is silent: offline metrics look superb and
 * production predictions are garbage. These tests are the proof that
 * `buildFeatures(history, t)` reads nothing after `t`.
 *
 * The strongest test is the differential one: poison every future sample with
 * absurd values and assert the vector is byte-identical. That catches a leak
 * through any code path, including ones added later, without enumerating them.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildFeatures,
  classifyTrend,
  FEATURE_COUNT,
  FEATURE_NAMES,
  FEATURE_VERSION,
  MAX_ANCHOR_AGE_MIN,
  REQUIRED_HISTORY_HOURS,
} from '../scripts/shared/coastal-features.mjs';

const MIN = 60_000;
const T0 = Date.UTC(2026, 5, 1, 12, 0, 0);

/** 15-minute cadence, semidiurnal-ish signal, `hours` before and after t. */
function makeHistory(hoursBefore: number, hoursAfter = 0, t = T0) {
  const out: { ts: number; level: number }[] = [];
  const step = 15 * MIN;
  for (let ts = t - hoursBefore * 3_600_000; ts <= t + hoursAfter * 3_600_000; ts += step) {
    out.push({ ts, level: 5 + 3 * Math.sin((2 * Math.PI * (ts / 3_600_000)) / 12.42) });
  }
  return out;
}

function makeWeather(hoursBefore: number, hoursAfter = 0, t = T0) {
  const out = [];
  for (let ts = t - hoursBefore * 3_600_000; ts <= t + hoursAfter * 3_600_000; ts += 3_600_000) {
    out.push({
      ts,
      pressure: 1010 + 5 * Math.sin(ts / 5e7),
      windSpeed: 8,
      windDirection: 220,
      windGust: 12,
      precipitation: 0.2,
      temperature: 14,
    });
  }
  return out;
}

describe('coastal feature builder — contract', () => {
  it('emits exactly the declared number of features, all finite', () => {
    const r = buildFeatures(makeHistory(30), T0, makeWeather(30)) as any;
    assert.equal(r.error, undefined);
    assert.equal(r.features.length, FEATURE_COUNT);
    assert.equal(FEATURE_NAMES.length, FEATURE_COUNT);
    for (let i = 0; i < r.features.length; i++) {
      assert.ok(Number.isFinite(r.features[i]), `feature ${FEATURE_NAMES[i]} not finite`);
    }
    assert.equal(r.meta.featureVersion, FEATURE_VERSION);
  });

  it('feature names are unique', () => {
    assert.equal(new Set(FEATURE_NAMES).size, FEATURE_NAMES.length);
  });
});

describe('coastal feature builder — no future leakage', () => {
  it('ignores samples after t entirely (poisoned-future differential)', () => {
    const clean = makeHistory(30, 0);
    const withFuture = makeHistory(30, 12).map((s) =>
      // Every post-t sample is made absurd. If any of it reaches the vector,
      // the comparison below fails.
      (s.ts > T0 ? { ts: s.ts, level: 9_999 } : s));

    const a = buildFeatures(clean, T0, []) as any;
    const b = buildFeatures(withFuture, T0, []) as any;

    assert.equal(a.error, undefined);
    assert.equal(b.error, undefined);
    assert.deepEqual(Array.from(b.features), Array.from(a.features));
    assert.equal(b.meta.baseTimestamp, a.meta.baseTimestamp);
  });

  it('ignores weather after t (poisoned-future differential)', () => {
    const hist = makeHistory(30);
    const clean = makeWeather(30, 0);
    const poisoned = [
      ...clean,
      ...makeWeather(0, 12).filter((w) => w.ts > T0).map((w) => ({
        ...w, pressure: 1, windSpeed: 999, windGust: 999, precipitation: 999, temperature: 99,
      })),
    ];
    const a = buildFeatures(hist, T0, clean) as any;
    const b = buildFeatures(hist, T0, poisoned) as any;
    assert.deepEqual(Array.from(b.features), Array.from(a.features));
  });

  it('base timestamp never exceeds t', () => {
    const r = buildFeatures(makeHistory(30, 6), T0, []) as any;
    assert.ok(r.meta.baseTimestamp <= T0, 'baseTimestamp is in the future');
  });

  it('a prediction at t and the same call with future data appended agree', () => {
    // Simulates re-running an old prediction after more data has arrived —
    // the classic backfill leak.
    const asOf = T0 - 6 * 3_600_000;
    const then = buildFeatures(makeHistory(30, 0, asOf), asOf, []) as any;
    const later = buildFeatures(makeHistory(36, 0, T0), asOf, []) as any;
    assert.deepEqual(Array.from(later.features), Array.from(then.features));
  });
});

describe('coastal feature builder — refusals', () => {
  it('refuses when history is shorter than the required window', () => {
    const r = buildFeatures(makeHistory(6), T0, []) as any;
    assert.equal(r.error, 'insufficient_history');
    assert.ok(r.haveHours < REQUIRED_HISTORY_HOURS);
  });

  it('refuses when the newest sample is older than the anchor cap', () => {
    const stale = makeHistory(40).filter((s) => s.ts <= T0 - 4 * 3_600_000);
    const r = buildFeatures(stale, T0, []) as any;
    assert.equal(r.error, 'history_stale');
    assert.ok(r.ageMinutes > MAX_ANCHOR_AGE_MIN);
  });

  it('accepts the routine upstream lag seen on the live EA feed', () => {
    // A dry run against Environment Agency saw the newest published sample
    // trailing wall-clock by 75 minutes on a perfectly healthy gauge. That must
    // predict, not refuse — the age is surfaced as delayed/stale instead.
    const lagged = makeHistory(30).filter((s) => s.ts <= T0 - 75 * MIN);
    const r = buildFeatures(lagged, T0, []) as any;
    assert.equal(r.error, undefined, 'routine 75-min lag must not refuse');
    assert.ok(r.meta.baseTimestamp <= T0 - 75 * MIN);
  });

  it('refuses with no history at all', () => {
    assert.equal((buildFeatures([], T0, []) as any).error, 'no_history');
  });

  it('builds without weather, flagging absence rather than inventing it', () => {
    const r = buildFeatures(makeHistory(30), T0, []) as any;
    assert.equal(r.error, undefined);
    const idx = FEATURE_NAMES.indexOf('weather_present');
    assert.equal(r.features[idx], 0);
    assert.equal(r.meta.weatherPresent, false);
  });
});

describe('coastal trend', () => {
  it('classifies from observations, and reports unknown without a reference', () => {
    assert.equal(classifyTrend(5.0, 4.5, null), 'rising');
    assert.equal(classifyTrend(4.5, 5.0, null), 'falling');
    assert.equal(classifyTrend(5.0, 5.005, null), 'stable');
    assert.equal(classifyTrend(5.0, null, null), 'unknown');
  });
});
