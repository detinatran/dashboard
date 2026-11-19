import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { rankCriticalNodes, rankCriticalPairs } from '../src/services/uk/critical.ts';
import { UK_TWIN_EDGES, UK_TWIN_NODES } from '../shared/uk-twin-data.ts';

describe('rankCriticalNodes (N-1)', () => {
  const ranking = rankCriticalNodes(UK_TWIN_NODES, UK_TWIN_EDGES, UK_TWIN_NODES.length);

  it('covers every node with scores in [0,1], sorted descending', () => {
    assert.equal(ranking.length, UK_TWIN_NODES.length);
    for (let i = 0; i < ranking.length; i++) {
      const entry = ranking[i]!;
      assert.ok(entry.score >= 0 && entry.score <= 1, `${entry.node.id} score ${entry.score}`);
      if (i > 0) assert.ok(ranking[i - 1]!.score >= entry.score - 1e-12);
      assert.ok(entry.affectedCount >= 1, 'the failed asset itself is always affected');
    }
  });

  it('ranks shared upstream infrastructure above leaf retail sites', () => {
    const indexOf = (id: string) => ranking.findIndex(e => e.node.id === id);
    const worstStore = Math.min(...ranking.filter(e => e.node.type === 'store_cluster').map(e => indexOf(e.node.id)));
    const felixstowe = indexOf('port-felixstowe');
    assert.ok(felixstowe >= 0, 'felixstowe present');
    assert.ok(felixstowe < worstStore, 'a hub port outranks any single store cluster');
  });

  it('respects the top parameter', () => {
    assert.equal(rankCriticalNodes(UK_TWIN_NODES, UK_TWIN_EDGES, 5).length, 5);
  });
});

describe('rankCriticalPairs (N-2)', () => {
  const pairs = rankCriticalPairs(UK_TWIN_NODES, UK_TWIN_EDGES, { candidates: 8, top: 6 });

  it('returns distinct pairs sorted by score', () => {
    assert.equal(pairs.length, 6);
    for (let i = 0; i < pairs.length; i++) {
      const p = pairs[i]!;
      assert.notEqual(p.a.id, p.b.id);
      if (i > 0) assert.ok(pairs[i - 1]!.score >= p.score - 1e-12);
    }
  });

  it('a pair always does at least as much damage as its worse member', () => {
    for (const p of pairs) {
      assert.ok(p.synergy >= -1e-9, `${p.a.id}+${p.b.id} synergy ${p.synergy}`);
      assert.ok(p.score <= 1 + 1e-9);
    }
  });
});
