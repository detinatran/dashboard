import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  SAMPLE_COMPANY,
  UK_REGION_CENTROIDS,
  UK_REGION_LABELS,
  UK_TWIN_EDGES,
  UK_TWIN_NODES,
  type UkRegionId,
} from '../shared/uk-twin-data.ts';

const REGION_IDS = Object.keys(UK_REGION_LABELS) as UkRegionId[];
const NODE_IDS = new Set(UK_TWIN_NODES.map((n) => n.id));

const UK_BBOX = { minLat: 49.8, maxLat: 60.9, minLon: -8.7, maxLon: 1.9 };

describe('UK twin dataset — nodes', () => {
  it('has at least 80 nodes in total', () => {
    assert.ok(UK_TWIN_NODES.length >= 80, `only ${UK_TWIN_NODES.length} nodes`);
  });

  it('has unique, kebab-case node ids', () => {
    assert.equal(NODE_IDS.size, UK_TWIN_NODES.length, 'duplicate node id');
    for (const n of UK_TWIN_NODES) {
      assert.match(n.id, /^[a-z0-9]+(?:-[a-z0-9]+)*$/, `bad id ${n.id}`);
    }
  });

  it('places every node inside the UK bounding box', () => {
    for (const n of UK_TWIN_NODES) {
      assert.ok(Number.isFinite(n.lat) && Number.isFinite(n.lon), `${n.id} has non-finite coords`);
      assert.ok(n.lat >= UK_BBOX.minLat && n.lat <= UK_BBOX.maxLat, `${n.id} lat ${n.lat} out of range`);
      assert.ok(n.lon >= UK_BBOX.minLon && n.lon <= UK_BBOX.maxLon, `${n.id} lon ${n.lon} out of range`);
    }
  });

  it('assigns every node a valid region', () => {
    for (const n of UK_TWIN_NODES) {
      assert.ok(REGION_IDS.includes(n.region), `${n.id} has invalid region ${n.region}`);
    }
  });

  it('uses criticality 1..5', () => {
    for (const n of UK_TWIN_NODES) {
      assert.ok(Number.isInteger(n.criticality) && n.criticality >= 1 && n.criticality <= 5, `${n.id} criticality ${n.criticality}`);
    }
  });

  it('has non-empty names and descriptions', () => {
    for (const n of UK_TWIN_NODES) {
      assert.ok(n.name.trim().length > 0, `${n.id} has empty name`);
      assert.ok(n.description.trim().length > 0, `${n.id} has empty description`);
    }
  });

  it('has a sample company with nodes of every sample type', () => {
    assert.equal(SAMPLE_COMPANY.name, 'Albion Provisions Ltd');
    const sampleTypes = new Set(UK_TWIN_NODES.filter((n) => n.owner === 'sample').map((n) => n.type));
    for (const t of ['factory', 'supplier', 'distribution_centre', 'store_cluster'] as const) {
      assert.ok(sampleTypes.has(t), `no sample node of type ${t}`);
    }
  });
});

describe('UK twin dataset — regions', () => {
  it('has a label and an in-bbox centroid for every region', () => {
    assert.equal(REGION_IDS.length, 12);
    for (const r of REGION_IDS) {
      assert.ok(UK_REGION_LABELS[r].length > 0);
      const [lon, lat] = UK_REGION_CENTROIDS[r];
      assert.ok(lat >= UK_BBOX.minLat && lat <= UK_BBOX.maxLat, `${r} centroid lat`);
      assert.ok(lon >= UK_BBOX.minLon && lon <= UK_BBOX.maxLon, `${r} centroid lon`);
    }
  });
});

describe('UK twin dataset — edges', () => {
  it('has unique edge ids', () => {
    const ids = new Set(UK_TWIN_EDGES.map((e) => e.id));
    assert.equal(ids.size, UK_TWIN_EDGES.length, 'duplicate edge id');
  });

  it('references existing nodes for every endpoint and alternative', () => {
    for (const e of UK_TWIN_EDGES) {
      assert.ok(NODE_IDS.has(e.from), `${e.id}: unknown from ${e.from}`);
      assert.ok(NODE_IDS.has(e.to), `${e.id}: unknown to ${e.to}`);
      for (const alt of e.alternatives ?? []) {
        assert.ok(NODE_IDS.has(alt), `${e.id}: unknown alternative ${alt}`);
        assert.notEqual(alt, e.from, `${e.id}: alternative equals from`);
      }
    }
  });

  it('has no self-loops', () => {
    for (const e of UK_TWIN_EDGES) {
      assert.notEqual(e.from, e.to, `${e.id} is a self-loop`);
    }
  });

  it('keeps dependency in (0, 1]', () => {
    for (const e of UK_TWIN_EDGES) {
      assert.ok(e.dependency > 0 && e.dependency <= 1, `${e.id} dependency ${e.dependency}`);
    }
  });

  it('uses positive lead times when present', () => {
    for (const e of UK_TWIN_EDGES) {
      if (e.leadTimeHours !== undefined) assert.ok(e.leadTimeHours > 0, `${e.id} leadTimeHours ${e.leadTimeHours}`);
    }
  });

  it('connects every sample-company node to at least one edge', () => {
    const touched = new Set<string>();
    for (const e of UK_TWIN_EDGES) {
      touched.add(e.from);
      touched.add(e.to);
    }
    for (const n of UK_TWIN_NODES.filter((x) => x.owner === 'sample')) {
      assert.ok(touched.has(n.id), `sample node ${n.id} has no edges`);
    }
  });

  it('is acyclic in the provider -> dependent direction', () => {
    const indegree = new Map<string, number>([...NODE_IDS].map((id) => [id, 0]));
    const out = new Map<string, string[]>();
    for (const e of UK_TWIN_EDGES) {
      indegree.set(e.to, (indegree.get(e.to) ?? 0) + 1);
      out.set(e.from, [...(out.get(e.from) ?? []), e.to]);
    }
    const queue = [...indegree].filter(([, d]) => d === 0).map(([id]) => id);
    let visited = 0;
    while (queue.length > 0) {
      const id = queue.shift()!;
      visited += 1;
      for (const next of out.get(id) ?? []) {
        const d = (indegree.get(next) ?? 0) - 1;
        indegree.set(next, d);
        if (d === 0) queue.push(next);
      }
    }
    const stuck = [...indegree].filter(([, d]) => d > 0).map(([id]) => id);
    assert.equal(visited, NODE_IDS.size, `cycle involving: ${stuck.join(', ')}`);
  });
});
