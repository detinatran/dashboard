import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  impactLevel,
  simulateCascade,
  summarizeCascade,
  UK_SCENARIOS,
} from '../src/services/uk/cascade.ts';
import { UK_TWIN_EDGES, UK_TWIN_NODES, type UkTwinNode } from '../shared/uk-twin-data.ts';

const node = (id: string, extra: Partial<UkTwinNode> = {}): UkTwinNode => ({
  id,
  name: id,
  type: 'factory',
  lat: 52,
  lon: -1,
  region: 'east-midlands',
  owner: 'sample',
  criticality: 3,
  floodExposure: 'low',
  description: id,
  ...extra,
});

describe('simulateCascade', () => {
  const nodes = [node('a'), node('b'), node('c'), node('alt')];

  it('propagates provider loss scaled by dependency', () => {
    const { losses } = simulateCascade(nodes, [
      { id: 'e1', from: 'a', to: 'b', kind: 'supplies', dependency: 0.8 },
      { id: 'e2', from: 'b', to: 'c', kind: 'transports', dependency: 0.5 },
    ], ['a']);
    assert.equal(losses.get('a'), 1);
    assert.ok(Math.abs(losses.get('b')! - 0.8) < 1e-9);
    assert.ok(Math.abs(losses.get('c')! - 0.4) < 1e-9);
  });

  it('a healthy alternative absorbs most of the transmitted loss', () => {
    const { losses } = simulateCascade(nodes, [
      { id: 'e1', from: 'a', to: 'b', kind: 'supplies', dependency: 1, alternatives: ['alt'] },
    ], ['a']);
    assert.ok(Math.abs(losses.get('b')! - 0.35) < 1e-9);
  });

  it('a failed alternative gives no relief', () => {
    const { losses } = simulateCascade(nodes, [
      { id: 'e1', from: 'a', to: 'b', kind: 'supplies', dependency: 1, alternatives: ['alt'] },
    ], ['a', 'alt']);
    assert.equal(losses.get('b'), 1);
  });

  it('sums multiple providers and caps at 1', () => {
    const { losses } = simulateCascade(nodes, [
      { id: 'e1', from: 'a', to: 'c', kind: 'powers', dependency: 0.7 },
      { id: 'e2', from: 'b', to: 'c', kind: 'powers', dependency: 0.7 },
    ], ['a', 'b']);
    assert.equal(losses.get('c'), 1);
  });

  it('drops noise below the floor and keeps directly failed nodes', () => {
    const { losses } = simulateCascade(nodes, [
      { id: 'e1', from: 'a', to: 'b', kind: 'serves', dependency: 0.04 },
    ], ['a']);
    assert.equal(losses.has('b'), false);
    assert.equal(losses.get('a'), 1);
  });

  it('terminates on a (hypothetical) cyclic graph', () => {
    const { passes } = simulateCascade(nodes, [
      { id: 'e1', from: 'a', to: 'b', kind: 'supplies', dependency: 0.9 },
      { id: 'e2', from: 'b', to: 'a', kind: 'supplies', dependency: 0.9 },
    ], ['a'], { maxPasses: 24 });
    assert.ok(passes <= 24);
  });

  it('runs the real twin dataset and reaches the sample company from Felixstowe', () => {
    const result = simulateCascade(UK_TWIN_NODES, UK_TWIN_EDGES, ['port-felixstowe']);
    assert.ok(result.losses.size > 1, 'closure of Felixstowe must propagate somewhere');
    const summary = summarizeCascade(UK_TWIN_NODES, result);
    assert.ok(summary.impacts.every(i => i.loss > 0 && i.loss <= 1));
    assert.equal(summary.impacts[0]!.node.id, 'port-felixstowe');
    assert.ok(summary.impacts[0]!.direct);
  });
});

describe('impact levels and summary', () => {
  it('bands losses into levels', () => {
    assert.equal(impactLevel(1), 'down');
    assert.equal(impactLevel(0.7), 'severe');
    assert.equal(impactLevel(0.35), 'degraded');
    assert.equal(impactLevel(0.1), 'minor');
  });

  it('computes service disruption over store clusters', () => {
    const stores = [node('s1', { type: 'store_cluster' }), node('s2', { type: 'store_cluster' })];
    const dc = node('dc', { type: 'distribution_centre' });
    const result = simulateCascade([...stores, dc], [
      { id: 'e1', from: 'dc', to: 's1', kind: 'transports', dependency: 1 },
      { id: 'e2', from: 'dc', to: 's2', kind: 'transports', dependency: 0.5 },
    ], ['dc']);
    const summary = summarizeCascade([...stores, dc], result);
    assert.ok(Math.abs(summary.serviceDisruption - 0.75) < 1e-9);
    assert.equal(summary.companyAffected.length, 3);
  });
});

describe('scenario presets', () => {
  it('every scenario selects at least one existing node', () => {
    const ids = new Set(UK_TWIN_NODES.map(n => n.id));
    for (const scenario of UK_SCENARIOS) {
      const selected = scenario.select(UK_TWIN_NODES);
      assert.ok(selected.length > 0, `${scenario.id} selects nothing`);
      for (const id of selected) assert.ok(ids.has(id), `${scenario.id} → unknown node ${id}`);
    }
  });

  it('the Humber surge catches the sample-company Hull factory', () => {
    const humber = UK_SCENARIOS.find(s => s.id === 'humber-surge')!;
    const selected = new Set(humber.select(UK_TWIN_NODES));
    const hullFactory = UK_TWIN_NODES.find(n => n.owner === 'sample' && n.type === 'factory' && n.lat > 53.5 && n.lat < 53.9);
    assert.ok(hullFactory, 'dataset must keep a Humber-area sample factory');
    assert.ok(selected.has(hullFactory.id), 'surge scenario must include the flood-exposed Hull factory');
  });

  it('scenarios are deterministic', () => {
    for (const scenario of UK_SCENARIOS) {
      assert.deepEqual(scenario.select(UK_TWIN_NODES), scenario.select(UK_TWIN_NODES));
    }
  });
});
