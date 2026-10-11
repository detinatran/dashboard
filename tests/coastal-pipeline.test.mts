/**
 * Coastal ingestion + policy tests.
 *
 * Covers the parts that decide whether a user sees a truthful number: the
 * observation window's dedupe/trim, the risk ladder's thresholds, freshness
 * classification, and — most importantly — that a missing model produces a
 * refusal rather than a value.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { mergeObservations } from '../scripts/seed-coastal.mjs';
import {
  evaluateRisk, classifyFreshness, DEFAULT_RISK_THRESHOLDS, RISK_LEVELS,
} from '../scripts/shared/coastal-risk.mjs';
import { listActiveStations, getStation, COASTAL_KEYS } from '../scripts/shared/coastal-stations.mjs';
import { loadModelMetadata, OnnxWaterLevelModel } from '../scripts/shared/coastal-models.mjs';

const NOW = Date.UTC(2026, 5, 1, 12, 0, 0);
const MIN = 60_000;

describe('observation window', () => {
  it('dedupes by timestamp, keeping the newer value', () => {
    const prior = [{ ts: NOW - 30 * MIN, level: 5.0 }];
    const incoming = [{ ts: NOW - 30 * MIN, level: 5.5 }];
    const out = mergeObservations(prior, incoming, NOW);
    assert.equal(out.length, 1);
    assert.equal(out[0].level, 5.5);
  });

  it('sorts chronologically regardless of input order', () => {
    const out = mergeObservations(
      [{ ts: NOW - 15 * MIN, level: 2 }],
      [{ ts: NOW - 45 * MIN, level: 1 }, { ts: NOW - 5 * MIN, level: 3 }],
      NOW,
    );
    assert.deepEqual(out.map((r) => r.level), [1, 2, 3]);
  });

  it('trims samples older than the retention window', () => {
    const old = { ts: NOW - 40 * 3_600_000, level: 9 };
    const fresh = { ts: NOW - 10 * MIN, level: 4 };
    const out = mergeObservations([old, fresh], [], NOW);
    assert.deepEqual(out.map((r) => r.level), [4]);
  });

  it('rejects malformed rows rather than storing NaN', () => {
    const out = mergeObservations(
      [{ ts: NOW - MIN, level: Number.NaN }, { ts: null, level: 3 }, {}],
      [{ ts: NOW - 2 * MIN, level: 4.2 }],
      NOW,
    );
    assert.deepEqual(out.map((r) => r.level), [4.2]);
  });

  it('drops implausible future timestamps', () => {
    const out = mergeObservations([], [{ ts: NOW + 3_600_000, level: 5 }], NOW);
    assert.equal(out.length, 0);
  });
});

describe('risk policy', () => {
  it('refuses to grade risk without a warning model', () => {
    const r = evaluateRisk({ station: {}, warningForecast: { status: 'model_not_configured' } });
    assert.equal(r.level, 'unknown');
    assert.equal(r.basis, 'none');
  });

  it('grades on the worst horizon using configured thresholds', () => {
    const mk = (p: number) => evaluateRisk({
      station: {},
      warningForecast: { status: 'ready', horizons: { '1h': { probability: p } } },
    });
    assert.equal(mk(0.10).level, 'normal');
    assert.equal(mk(0.35).level, 'advisory');
    assert.equal(mk(0.60).level, 'watch');
    assert.equal(mk(0.90).level, 'high');
  });

  it('does not assume a 0.5 threshold', () => {
    assert.notEqual(DEFAULT_RISK_THRESHOLDS.watch, undefined);
    assert.ok(DEFAULT_RISK_THRESHOLDS.advisory < DEFAULT_RISK_THRESHOLDS.watch);
    assert.ok(DEFAULT_RISK_THRESHOLDS.watch < DEFAULT_RISK_THRESHOLDS.high);
  });

  it('honours per-station threshold overrides', () => {
    const r = evaluateRisk({
      station: { riskThresholds: { advisory: 0.05, watch: 0.10, high: 0.15 } },
      warningForecast: { status: 'ready', horizons: { '3h': { probability: 0.20 } } },
    });
    assert.equal(r.level, 'high');
  });

  it('every produced level is a declared level', () => {
    for (const p of [0, 0.29, 0.31, 0.49, 0.51, 0.74, 0.76, 1]) {
      const r = evaluateRisk({ station: {}, warningForecast: { status: 'ready', horizons: { '1h': { probability: p } } } });
      assert.ok(RISK_LEVELS.includes(r.level), `${r.level} not in RISK_LEVELS`);
    }
  });

  it('describes risk as an estimate, never as an official warning', () => {
    const r = evaluateRisk({ station: {}, warningForecast: { status: 'ready', horizons: { '6h': { probability: 0.8 } } } });
    assert.match(r.reason, /estimated/i);
    assert.doesNotMatch(r.reason, /flood warning|official/i);
  });
});

describe('data freshness', () => {
  it('classifies by age, not by feature availability', () => {
    assert.equal(classifyFreshness(5), 'live');
    assert.equal(classifyFreshness(30), 'live');
    assert.equal(classifyFreshness(31), 'delayed');
    assert.equal(classifyFreshness(90), 'delayed');
    assert.equal(classifyFreshness(91), 'stale');
    assert.equal(classifyFreshness(null as never), 'unknown');
  });
});

describe('station registry', () => {
  it('exposes Liverpool as a configured site with a real EA measure id', () => {
    const s = getStation('liverpool-gladstone');
    assert.ok(s);
    assert.equal(s!.code, 'E70124');
    assert.equal(s!.waterLevelExternalId, 'E70124-level-tidal_level-Mean-15_min-m');
    assert.ok(Math.abs(s!.lat - 53.4497) < 0.01);
    assert.ok(Math.abs(s!.lon - (-3.0182)) < 0.01);
  });

  it('declares the harmonic tide provider now that a fit exists', () => {
    // Was 'none' until a utide harmonic fit of the station's own 362-day
    // record reached 99.32% of variance explained. The station must never
    // claim a tide provider it cannot actually evaluate.
    assert.equal(getStation('liverpool-gladstone')!.tideProvider, 'harmonic-utide');
  });

  it('keys are namespaced per station so adding a site needs no key changes', () => {
    assert.equal(COASTAL_KEYS.observations('london-thames-barrier'), 'coastal:obs:v1:london-thames-barrier');
    assert.notEqual(COASTAL_KEYS.observations('a'), COASTAL_KEYS.observations('b'));
  });

  it('active stations all carry the fields the seeder requires', () => {
    for (const s of listActiveStations()) {
      for (const f of ['id', 'lat', 'lon', 'timezone', 'waterLevelProvider', 'waterLevelExternalId']) {
        assert.ok((s as never)[f] !== undefined, `${s.id} missing ${f}`);
      }
    }
  });
});

describe('model adapter refusals', () => {
  it('reports model_not_configured when no artifact exists', async () => {
    const m = new OnnxWaterLevelModel({ dir: '/tmp/nonexistent-model-dir', stationId: 'liverpool-gladstone' });
    assert.equal(m.status, 'model_not_configured');
    const out = await m.predict(new Float32Array(42));
    assert.equal(out.status, 'model_not_configured');
    assert.equal(out.horizons, undefined, 'must not emit horizons without a model');
  });

  it('reports model_not_configured for an absent metadata sidecar', () => {
    assert.equal(loadModelMetadata('/tmp/nonexistent-model-dir', 'x').status, 'model_not_configured');
  });
});
