import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  computeRegionalResilience,
  haversineKm,
  annualHighFlow,
  percentile,
  riskLevel,
  riverRatio,
  scoreNodeRisk,
} from '../src/services/uk/risk.ts';
import { simulateCascade } from '../src/services/uk/cascade.ts';
import { UK_REGION_LABELS, UK_TWIN_EDGES, UK_TWIN_NODES, type UkTwinNode } from '../shared/uk-twin-data.ts';
import type { UkFloodWarning } from '../src/services/uk/parsers.ts';

const node = (extra: Partial<UkTwinNode> = {}): UkTwinNode => ({
  id: 'n', name: 'Node', type: 'factory', lat: 53.74, lon: -0.29, region: 'yorkshire',
  owner: 'sample', criticality: 4, floodExposure: 'fluvial', description: 'test', ...extra,
});

describe('hazard scoring', () => {
  it('is calm when the forecast is calm', () => {
    const r = scoreNodeRisk(node(), { precip72: 3, gustMax: 35, riverRatio: 0.4 });
    assert.equal(r.level, 'low');
    assert.deepEqual(r.drivers, []);
  });

  it('flags a fluvial asset when the river heads above its annual high flow', () => {
    const r = scoreNodeRisk(node(), { precip72: 30, gustMax: 40, riverRatio: 1.3 });
    assert.equal(r.level, 'high');
    assert.ok(r.drivers.some(d => /River at 130% of annual high flow/.test(d)));
    const normal = scoreNodeRisk(node(), { precip72: 5, gustMax: 30, riverRatio: 0.4 });
    assert.equal(normal.level, 'low', 'an ordinary flow is not a flood signal');
  });

  it('uses gusts as the surge proxy for coastal assets', () => {
    const calm = scoreNodeRisk(node({ floodExposure: 'coastal' }), { precip72: 5, gustMax: 50, riverRatio: null });
    const gale = scoreNodeRisk(node({ floodExposure: 'coastal' }), { precip72: 5, gustMax: 80, riverRatio: null });
    const storm = scoreNodeRisk(node({ floodExposure: 'coastal' }), { precip72: 5, gustMax: 115, riverRatio: null });
    assert.ok(storm.probability > 0.8 && calm.probability < 0.1);
    assert.ok(gale.probability < 0.15, `a routine coastal gale should stay low, got ${gale.probability}`);
  });

  it('wind-sensitive assets react to gusts, others barely do', () => {
    const port = scoreNodeRisk(node({ type: 'port', floodExposure: 'low' }), { precip72: 0, gustMax: 110, riverRatio: null });
    const hospital = scoreNodeRisk(node({ type: 'hospital', floodExposure: 'low' }), { precip72: 0, gustMax: 110, riverRatio: null });
    assert.ok(port.probability > 0.8);
    assert.ok(hospital.probability < 0.3);
  });

  it('a nearby official warning sets a floor, a distant one does not', () => {
    const warning = (level: 1 | 2 | 3, lat: number, lon: number): UkFloodWarning => ({
      id: 'w', areaName: 'Hull', county: '', riverOrSea: '', severityLevel: level, severityLabel: 'Flood Warning',
      isTidal: true, message: '', time: 0, lat, lon,
    });
    const calm = { precip72: 0, gustMax: 20, riverRatio: 0.4 };
    const near = scoreNodeRisk(node(), calm, [warning(2, 53.75, -0.3)]);
    const far = scoreNodeRisk(node(), calm, [warning(1, 51.5, -0.1)]);
    assert.ok(near.probability >= 0.6);
    assert.match(near.drivers[0]!, /Flood Warning \d+ km away/);
    assert.equal(far.level, 'low');
  });

  it('bands probabilities', () => {
    assert.deepEqual([0.7, 0.4, 0.2, 0.05].map(riskLevel), ['high', 'elevated', 'guarded', 'low']);
  });
});

describe('forecast feature helpers', () => {
  it('ratios the forecast peak against the annual high flow', () => {
    const year = Array.from({ length: 365 }, (_, i) => (i % 10 === 0 ? 40 : 10));
    const high = annualHighFlow(year)!;
    assert.equal(high, 40);
    assert.equal(riverRatio([12, 50, 18], high), 1.25);
  });

  it('needs a year of history and a real channel', () => {
    assert.equal(annualHighFlow(Array.from({ length: 40 }, () => 10)), null);
    assert.equal(annualHighFlow(Array.from({ length: 365 }, () => 0.3)), null);
    assert.equal(annualHighFlow(undefined), null);
    assert.equal(riverRatio([5, 6], null), null);
    assert.equal(riverRatio([], 10), null);
  });

  it('percentile and distance behave', () => {
    assert.equal(percentile([1, 2, 3, 4, 5], 0.5), 3);
    assert.equal(percentile([0, 10], 0.95), 9.5);
    assert.equal(percentile([], 0.5), null);
    const london = haversineKm(51.5074, -0.1278, 52.4862, -1.8904);
    assert.ok(london > 155 && london < 165, `London–Birmingham ≈ 163 km, got ${london}`);
  });
});

describe('seeded cascade', () => {
  it('propagates partial hazard losses through the real twin', () => {
    const hull = UK_TWIN_NODES.find(n => n.owner === 'sample' && n.type === 'factory' && n.lat > 53.5 && n.lat < 53.9)!;
    const result = simulateCascade(UK_TWIN_NODES, UK_TWIN_EDGES, [], { seedLosses: new Map([[hull.id, 0.7]]) });
    assert.equal(result.losses.get(hull.id), 0.7);
    assert.ok(result.losses.size > 1, 'a 70% Hull outage should reach downstream DCs');
    for (const [id, loss] of result.losses) if (id !== hull.id) assert.ok(loss <= 0.7 + 1e-9);
  });
});

describe('regional resilience', () => {
  it('scores every region 0..100 and ranks the weakest first', () => {
    const regions = computeRegionalResilience(UK_TWIN_NODES, UK_TWIN_EDGES, new Map(), UK_REGION_LABELS);
    assert.ok(regions.length >= 10);
    for (const r of regions) {
      assert.ok(r.score >= 0 && r.score <= 100, `${r.region} out of range`);
      assert.ok(r.assets > 0);
    }
    for (let i = 1; i < regions.length; i++) assert.ok(regions[i - 1]!.score <= regions[i]!.score);
  });

  it('forecast hazard lowers a region score', () => {
    const base = computeRegionalResilience(UK_TWIN_NODES, UK_TWIN_EDGES, new Map(), UK_REGION_LABELS);
    const storm = new Map(UK_TWIN_NODES.filter(n => n.region === 'yorkshire').map(n => [n.id, 0.9]));
    const hit = computeRegionalResilience(UK_TWIN_NODES, UK_TWIN_EDGES, storm, UK_REGION_LABELS);
    const before = base.find(r => r.region === 'yorkshire')!.score;
    const after = hit.find(r => r.region === 'yorkshire')!.score;
    assert.ok(after < before, `yorkshire ${before} → ${after}`);
  });
});
