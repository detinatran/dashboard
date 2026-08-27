import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  aoiReportToCsv,
  buildAoiGeometry,
  createAoiShape,
  deserializeAoiShapes,
  diffAoiSweep,
  haversine,
  initialAoiDrawState,
  measureAoi,
  pointInPolygon,
  reduceAoiDrawing,
  selectAoiEntities,
  serializeAoiShapes,
  type AoiReport,
} from '../src/services/aoi-tools.ts';

describe('AOI geometry', () => {
  it('measures great-circle distance and a rectangle consistently', () => {
    assert.ok(Math.abs(haversine([0, 0], [1, 0]) - 111.19) < 0.1);
    const rectangle = buildAoiGeometry('rectangle', [[0, 0], [1, 1]]);
    assert.deepEqual(rectangle, [[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]);
    const measurement = measureAoi('rectangle', [[0, 0], [1, 1]]);
    assert.equal(measurement.closable, true);
    assert.ok(measurement.areaKm2 > 12_000 && measurement.areaKm2 < 12_500);
  });

  it('completes two-click geometry and supports undo for paths', () => {
    let rectangle = initialAoiDrawState('rectangle');
    rectangle = reduceAoiDrawing(rectangle, { type: 'click', at: [10, 20] }).state;
    const finished = reduceAoiDrawing(rectangle, { type: 'click', at: [12, 22] });
    assert.equal(finished.result?.kind, 'rectangle');
    assert.equal(finished.result?.coords.length, 5);

    let line = initialAoiDrawState('line');
    line = reduceAoiDrawing(line, { type: 'click', at: [0, 0] }).state;
    line = reduceAoiDrawing(line, { type: 'click', at: [1, 0] }).state;
    line = reduceAoiDrawing(line, { type: 'undo' }).state;
    assert.deepEqual(line.points, [[0, 0]]);
    assert.equal(reduceAoiDrawing(line, { type: 'finish' }).result, undefined);
  });

  it('uses stable point-in-polygon selection with grouped results', () => {
    const ring = [[0, 0], [5, 0], [5, 5], [0, 5], [0, 0]];
    assert.equal(pointInPolygon(2, 2, ring), true);
    assert.equal(pointInPolygon(7, 2, ring), false);
    const report = selectAoiEntities(ring, [{
      key: 'aircraft',
      label: 'Aircraft',
      color: '#00d4ff',
      entities: [
        { id: 'inside', label: 'IN1', lat: 2, lng: 2 },
        { id: 'outside', label: 'OUT1', lat: 10, lng: 10 },
      ],
    }]);
    assert.equal(report.total, 1);
    assert.deepEqual(report.groups[0]?.memberIds, ['inside']);
  });
});

describe('AOI watch and export', () => {
  const initial: AoiReport = {
    total: 1,
    groups: [{
      key: 'aircraft',
      label: 'Aircraft',
      color: '#00d4ff',
      count: 1,
      items: [{ id: 'a', label: 'ALPHA', lat: 1, lng: 1 }],
      memberIds: ['a'],
    }],
  };

  it('seeds silently, then reports both entry and exit', () => {
    const seeded = diffAoiSweep('zone', initial, null, 100);
    assert.deepEqual(seeded.events, []);
    const next: AoiReport = {
      ...initial,
      groups: [{ ...initial.groups[0]!, items: [{ id: 'b', label: 'BRAVO', lat: 2, lng: 2 }], memberIds: ['b'] }],
    };
    const diff = diffAoiSweep('zone', next, seeded.baseline, 200);
    assert.deepEqual(diff.events.map((event) => [event.kind, event.label]), [
      ['enter', 'BRAVO'],
      ['exit', 'a'],
    ]);
  });

  it('round-trips valid shapes and drops malformed storage rows', () => {
    const shape = createAoiShape({
      kind: 'polygon',
      coords: [[0, 0], [1, 0], [1, 1]],
    }, [], 0);
    const restored = deserializeAoiShapes(serializeAoiShapes([shape]));
    assert.equal(restored.length, 1);
    assert.equal(restored[0]?.geojson.geometry.type, 'Polygon');
    assert.deepEqual(deserializeAoiShapes('[{"id":"broken"}]'), []);
  });

  it('quotes CSV cells that contain separators', () => {
    const shape = createAoiShape({
      kind: 'polygon',
      coords: [[0, 0], [1, 0], [1, 1]],
    }, [], 0);
    const csv = aoiReportToCsv(shape, {
      total: 1,
      groups: [{
        key: 'events',
        label: 'Events',
        color: '#fff',
        count: 1,
        items: [{ id: 'event', label: 'Alpha, "Bravo"', detail: 'one\ntwo', lat: 1, lng: 2 }],
        memberIds: ['event'],
      }],
    });
    assert.match(csv, /"Alpha, ""Bravo"""/);
    assert.match(csv, /"one\ntwo"/);
  });

  it('neutralizes spreadsheet formulas in remote labels', () => {
    const shape = createAoiShape({
      kind: 'polygon',
      coords: [[0, 0], [1, 0], [1, 1]],
    }, [], 0);
    const csv = aoiReportToCsv(shape, {
      total: 1,
      groups: [{
        key: 'events',
        label: 'Events',
        color: '#fff',
        count: 1,
        items: [{ id: 'event', label: '=HYPERLINK("bad")', lat: 1, lng: 2 }],
        memberIds: ['event'],
      }],
    });
    assert.match(csv, /"'=HYPERLINK\(""bad""\)"/);
  });
});
