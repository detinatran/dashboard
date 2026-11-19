// CrisisTwin UK criticality ranking: which single asset (N-1), or pair of
// assets (N-2), hurts the system most if it fails. Exhaustive N-1 over the
// twin (~112 cascades, each a cheap acyclic relaxation); N-2 restricted to
// pairs of the top N-1 candidates so the pair table stays interactive. Pure
// functions, exercised by tests/uk-critical.test.mts.

import { simulateCascade } from './cascade';
import type { UkTwinEdge, UkTwinNode } from './twin';

export interface UkCriticalEntry {
  node: UkTwinNode;
  /** Criticality-weighted system capacity loss, 0..1. */
  score: number;
  /** Mean capacity loss across the sample company's store clusters, 0..1. */
  serviceDisruption: number;
  /** Nodes above the cascade floor, the failed asset included. */
  affectedCount: number;
}

export interface UkCriticalPair {
  a: UkTwinNode;
  b: UkTwinNode;
  score: number;
  /** Extra damage over the worse of the two single failures. */
  synergy: number;
}

interface ScoreBreakdown {
  score: number;
  serviceDisruption: number;
  affectedCount: number;
}

function scoreFailure(
  nodes: UkTwinNode[],
  edges: UkTwinEdge[],
  failedIds: string[],
  totalWeight: number,
  stores: UkTwinNode[],
): ScoreBreakdown {
  const { losses } = simulateCascade(nodes, edges, failedIds);
  let weighted = 0;
  for (const node of nodes) {
    const loss = losses.get(node.id);
    if (loss) weighted += loss * node.criticality;
  }
  const storeLoss = stores.reduce((sum, s) => sum + (losses.get(s.id) ?? 0), 0);
  return {
    score: totalWeight > 0 ? weighted / totalWeight : 0,
    serviceDisruption: stores.length ? storeLoss / stores.length : 0,
    affectedCount: losses.size,
  };
}

/** N-1: fail every asset alone and rank by criticality-weighted system loss. */
export function rankCriticalNodes(
  nodes: UkTwinNode[],
  edges: UkTwinEdge[],
  top = 15,
): UkCriticalEntry[] {
  const totalWeight = nodes.reduce((sum, n) => sum + n.criticality, 0);
  const stores = nodes.filter(n => n.type === 'store_cluster');
  return nodes
    .map((node): UkCriticalEntry => ({
      node,
      ...scoreFailure(nodes, edges, [node.id], totalWeight, stores),
    }))
    .sort((a, b) => b.score - a.score || a.node.name.localeCompare(b.node.name))
    .slice(0, Math.max(1, top));
}

/**
 * N-2: worst pairs among the top N-1 candidates. `synergy` above zero means
 * the pair does more damage together than either failure alone — a shared
 * dependency or an exhausted substitute.
 */
export function rankCriticalPairs(
  nodes: UkTwinNode[],
  edges: UkTwinEdge[],
  options: { candidates?: number; top?: number } = {},
): UkCriticalPair[] {
  const candidates = Math.max(2, options.candidates ?? 12);
  const top = Math.max(1, options.top ?? 8);
  const totalWeight = nodes.reduce((sum, n) => sum + n.criticality, 0);
  const stores = nodes.filter(n => n.type === 'store_cluster');
  const singles = rankCriticalNodes(nodes, edges, candidates);

  const pairs: UkCriticalPair[] = [];
  for (let i = 0; i < singles.length; i++) {
    for (let j = i + 1; j < singles.length; j++) {
      const a = singles[i]!;
      const b = singles[j]!;
      const { score } = scoreFailure(nodes, edges, [a.node.id, b.node.id], totalWeight, stores);
      pairs.push({ a: a.node, b: b.node, score, synergy: score - Math.max(a.score, b.score) });
    }
  }
  return pairs
    .sort((x, y) => y.score - x.score || y.synergy - x.synergy)
    .slice(0, top);
}
