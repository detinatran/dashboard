import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  evaluatePlan,
  normalBaseline,
  recommendPlan,
  rerouteEdges,
  REROUTE_PENALTY_HOURS,
  type UkPlanResult,
} from '../src/services/uk/whatif.ts';
import { UK_SCENARIOS } from '../src/services/uk/cascade.ts';
import { UK_TWIN_EDGES as E, UK_TWIN_NODES as N } from '../shared/uk-twin-data.ts';

const humber = UK_SCENARIOS.find(s => s.id === 'humber-surge')!.select(N);
const thames = UK_SCENARIOS.find(s => s.id === 'thames-surge')!.select(N);
const HULL = 'albion-factory-hull';
const BURTON = 'albion-factory-burton';

describe('what-if baseline', () => {
  it('a normal fortnight is full service at cost 100', () => {
    const r = normalBaseline(N, E);
    assert.equal(r.serviceLevel, 1);
    assert.ok(Math.abs(r.costIndex - 100) < 1e-6);
    assert.ok(r.deliveryHours > 0);
  });

  it('acting without a threat to the company only adds cost', () => {
    const none = evaluatePlan(N, E, thames, { kind: 'none' });
    const close = evaluatePlan(N, E, thames, { kind: 'close', node: HULL });
    assert.ok(close.costIndex > none.costIndex);
    assert.deepEqual(recommendPlan([none, close])?.plan, { kind: 'none' });
  });
});

describe('Humber storm surge plans', () => {
  const none = evaluatePlan(N, E, humber, { kind: 'none' });
  const close = evaluatePlan(N, E, humber, { kind: 'close', node: HULL });
  const reroute = evaluatePlan(N, E, humber, { kind: 'reroute', node: HULL, target: BURTON });

  it('the storm hurts service and cost when nothing is done', () => {
    assert.ok(none.serviceLevel < 0.95);
    assert.ok(none.costIndex > 150);
  });

  it('closing the flood-exposed factory protects it: cheaper and better than no action', () => {
    assert.ok(close.costIndex < none.costIndex);
    assert.ok(close.serviceLevel > none.serviceLevel);
  });

  it('rerouting production keeps the most stores served, at a time and cost premium', () => {
    assert.ok(reroute.serviceLevel > close.serviceLevel && reroute.serviceLevel > none.serviceLevel);
    assert.ok(reroute.deliveryHours > close.deliveryHours);
    assert.ok(reroute.costIndex > close.costIndex);
    assert.deepEqual(recommendPlan([none, close, reroute])?.plan, reroute.plan);
  });
});

describe('rerouteEdges', () => {
  const moved = rerouteEdges(E, 'albion-dc-doncaster', 'albion-dc-magna-park');

  it('leaves no lane touching the rerouted site and duplicates no lane', () => {
    assert.ok(!moved.some(e => e.kind === 'transports' && (e.from === 'albion-dc-doncaster' || e.to === 'albion-dc-doncaster')));
    const keys = moved.map(e => `${e.kind}:${e.from}->${e.to}`);
    assert.equal(new Set(keys).size, keys.length);
  });

  it('reuses the target lane time plus the reroute penalty', () => {
    const own = E.find(e => e.from === 'albion-dc-magna-park' && e.to === 'albion-stores-leeds');
    const lane = moved.find(e => e.from === 'albion-dc-magna-park' && e.to === 'albion-stores-leeds')!;
    assert.ok(lane, 'Leeds stores must now be served from Magna Park');
    if (own) assert.equal(lane.leadTimeHours, own.leadTimeHours! + REROUTE_PENALTY_HOURS);
    else assert.ok(lane.leadTimeHours! > REROUTE_PENALTY_HOURS);
  });

  it('keeps an inbound lane the target already runs instead of stacking dependency', () => {
    const original = E.find(e => e.from === HULL && e.to === 'albion-dc-magna-park')!;
    const after = moved.find(e => e.from === HULL && e.to === 'albion-dc-magna-park')!;
    assert.equal(after.dependency, original.dependency);
  });
});

describe('recommendPlan', () => {
  const r = (service: number, cost: number): UkPlanResult => ({
    plan: { kind: 'close', node: `${service}-${cost}` }, serviceLevel: service, deliveryHours: 4, costIndex: cost,
  });
  it('prefers service, then cost within a 2-point band', () => {
    assert.equal(recommendPlan([r(0.9, 120), r(0.95, 200)])?.costIndex, 200);
    assert.equal(recommendPlan([r(0.95, 200), r(0.94, 150)])?.costIndex, 150);
    assert.equal(recommendPlan([]), null);
  });
});
