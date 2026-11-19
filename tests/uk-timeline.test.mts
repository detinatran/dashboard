import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { simulateCascade, UK_SCENARIOS } from '../src/services/uk/cascade.ts';
import {
  RAMP_HOURS,
  simulateCascadeTimeline,
  UK_AUTONOMY_HOURS,
} from '../src/services/uk/timeline.ts';
import { UK_TWIN_EDGES, UK_TWIN_NODES, type UkTwinEdge, type UkTwinNode } from '../shared/uk-twin-data.ts';

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

const edge = (from: string, to: string, dependency = 1, extra: Partial<UkTwinEdge> = {}): UkTwinEdge =>
  ({ from, to, kind: 'powers', dependency, ...extra } as UkTwinEdge);

describe('simulateCascadeTimeline', () => {
  it('holds a hospital at full capacity for its autonomy hours, then ramps', () => {
    const nodes = [node('grid', { type: 'power_station' }), node('hosp', { type: 'hospital' })];
    const { frames } = simulateCascadeTimeline(nodes, [edge('grid', 'hosp')], ['grid'], { hours: 60 });
    const lossAt = (h: number) => frames[h]!.losses.get('hosp') ?? 0;
    const autonomy = UK_AUTONOMY_HOURS.hospital;
    // Pressure arrives at hour 1; the buffer holds through hour autonomy.
    assert.equal(lossAt(autonomy), 0);
    assert.ok(lossAt(autonomy + 1) > 0, 'ramp starts after the buffer is spent');
    assert.ok(lossAt(autonomy + RAMP_HOURS) >= 0.99, 'full transmitted loss after the ramp');
  });

  it('propagates one edge per hour before buffers apply', () => {
    // a -> b -> c, all zero-autonomy types.
    const nodes = [
      node('a', { type: 'power_station' }),
      node('b', { type: 'power_station' }),
      node('c', { type: 'power_station' }),
    ];
    const edges = [edge('a', 'b'), edge('b', 'c')];
    const { frames } = simulateCascadeTimeline(nodes, edges, ['a'], { hours: 10 });
    assert.equal(frames[0]!.losses.get('b'), undefined);
    assert.ok((frames[1]!.losses.get('b') ?? 0) > 0, 'b hit in hour 1');
    assert.equal(frames[1]!.losses.get('c'), undefined, 'c not yet hit in hour 1');
    assert.ok((frames[2]!.losses.get('c') ?? 0) > 0, 'c hit in hour 2');
  });

  it('losses never decrease over time', () => {
    const { frames } = simulateCascadeTimeline(UK_TWIN_NODES, UK_TWIN_EDGES, ['port-felixstowe'], { hours: 72 });
    for (let h = 1; h < frames.length; h++) {
      for (const [id, loss] of frames[h - 1]!.losses) {
        assert.ok((frames[h]!.losses.get(id) ?? 0) >= loss - 1e-9, `${id} regressed at hour ${h}`);
      }
    }
  });

  it('converges to the static cascade fixed point given enough hours', () => {
    const failed = ['port-immingham'];
    const staticResult = simulateCascade(UK_TWIN_NODES, UK_TWIN_EDGES, failed);
    const { frames } = simulateCascadeTimeline(UK_TWIN_NODES, UK_TWIN_EDGES, failed, { hours: 200 });
    const last = frames[frames.length - 1]!.losses;
    for (const [id, loss] of staticResult.losses) {
      assert.ok(Math.abs((last.get(id) ?? 0) - loss) < 0.02, `${id}: timeline ${last.get(id)} vs static ${loss}`);
    }
  });

  it('reports the peak hour of store-service disruption', () => {
    // Humber surge fails the Hull factory, which does reach the stores.
    const humber = UK_SCENARIOS.find(s => s.id === 'humber-surge')!;
    const result = simulateCascadeTimeline(UK_TWIN_NODES, UK_TWIN_EDGES, humber.select(UK_TWIN_NODES), { hours: 96 });
    const peakFrame = result.frames[result.peakHour]!;
    for (const frame of result.frames) {
      assert.ok(frame.serviceDisruption <= peakFrame.serviceDisruption + 1e-9);
    }
    assert.ok(peakFrame.serviceDisruption > 0, 'the surge reaches the stores');
    assert.ok(result.peakHour > 0, 'stores hold inventory, so the peak is never at hour 0');
  });
});
