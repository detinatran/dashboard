// CrisisTwin UK cascading-impact engine. Pure functions over the static twin
// graph (shared/uk-twin-data.ts): fail a set of assets, propagate capacity
// loss along dependency edges, and summarise what degrades downstream.
// Runs entirely in the browser — no Redis, worker or RPC involved.

import type { UkTwinEdge, UkTwinNode } from './twin';

export type UkImpactLevel = 'down' | 'severe' | 'degraded' | 'minor';

export interface UkCascadeOptions {
  /** Transmitted share that survives when a healthy alternative exists. */
  substitutionFactor?: number;
  /** Losses below this are treated as noise and dropped. */
  floor?: number;
  /** Relaxation passes; the dataset is acyclic, so this is a safety bound. */
  maxPasses?: number;
}

export interface UkCascadeResult {
  /** Capacity loss per node id, 0..1. Only nodes above the floor appear. */
  losses: Map<string, number>;
  failed: Set<string>;
  passes: number;
}

export interface UkCascadeImpact {
  node: UkTwinNode;
  loss: number;
  level: UkImpactLevel;
  /** True when the node was failed directly rather than by propagation. */
  direct: boolean;
}

export interface UkCascadeSummary {
  impacts: UkCascadeImpact[];
  counts: Record<UkImpactLevel, number>;
  /** Mean capacity loss across the sample company's store clusters, 0..1. */
  serviceDisruption: number;
  /** Sample-company nodes at degraded or worse. */
  companyAffected: UkCascadeImpact[];
  /** Criticality-5 public assets at degraded or worse. */
  criticalAffected: UkCascadeImpact[];
}

const DEFAULTS: Required<UkCascadeOptions> = {
  substitutionFactor: 0.35,
  floor: 0.05,
  maxPasses: 24,
};

export function impactLevel(loss: number): UkImpactLevel {
  if (loss >= 0.995) return 'down';
  if (loss >= 0.6) return 'severe';
  if (loss >= 0.3) return 'degraded';
  return 'minor';
}

export function simulateCascade(
  nodes: UkTwinNode[],
  edges: UkTwinEdge[],
  failedIds: Iterable<string>,
  options: UkCascadeOptions = {},
): UkCascadeResult {
  const { substitutionFactor, floor, maxPasses } = { ...DEFAULTS, ...options };
  const known = new Set(nodes.map(n => n.id));
  const failed = new Set([...failedIds].filter(id => known.has(id)));

  const incoming = new Map<string, UkTwinEdge[]>();
  for (const edge of edges) {
    if (!known.has(edge.from) || !known.has(edge.to)) continue;
    const list = incoming.get(edge.to);
    if (list) list.push(edge);
    else incoming.set(edge.to, [edge]);
  }

  const losses = new Map<string, number>();
  for (const id of failed) losses.set(id, 1);
  const lossOf = (id: string): number => losses.get(id) ?? 0;

  // Fixed-point relaxation. The dataset is acyclic (tests/uk-twin-data), so
  // this converges in at most the graph depth; maxPasses only guards against
  // a future dataset edit introducing a cycle.
  let passes = 0;
  for (; passes < maxPasses; passes++) {
    let changed = false;
    for (const [to, list] of incoming) {
      if (failed.has(to)) continue;
      let total = 0;
      for (const edge of list) {
        const providerLoss = lossOf(edge.from);
        if (providerLoss <= 0) continue;
        // A healthy substitute absorbs most of the transmitted loss.
        const hasHealthyAlternative = (edge.alternatives ?? [])
          .some(alt => known.has(alt) && lossOf(alt) < 0.25);
        total += edge.dependency * providerLoss * (hasHealthyAlternative ? substitutionFactor : 1);
      }
      const next = Math.min(1, total);
      const current = lossOf(to);
      if (next > current + 1e-6) {
        losses.set(to, next);
        changed = true;
      }
    }
    if (!changed) break;
  }

  for (const [id, loss] of losses) {
    if (loss < floor && !failed.has(id)) losses.delete(id);
  }
  return { losses, failed, passes };
}

export function summarizeCascade(nodes: UkTwinNode[], result: UkCascadeResult): UkCascadeSummary {
  const byId = new Map(nodes.map(n => [n.id, n]));
  const impacts: UkCascadeImpact[] = [...result.losses.entries()]
    .flatMap(([id, loss]) => {
      const node = byId.get(id);
      return node ? [{ node, loss, level: impactLevel(loss), direct: result.failed.has(id) }] : [];
    })
    .sort((a, b) => b.loss - a.loss || a.node.name.localeCompare(b.node.name));

  const counts: Record<UkImpactLevel, number> = { down: 0, severe: 0, degraded: 0, minor: 0 };
  for (const impact of impacts) counts[impact.level]++;

  const stores = nodes.filter(n => n.type === 'store_cluster');
  const storeLoss = stores.reduce((sum, s) => sum + (result.losses.get(s.id) ?? 0), 0);
  const atLeastDegraded = (i: UkCascadeImpact) => i.level !== 'minor';

  return {
    impacts,
    counts,
    serviceDisruption: stores.length ? storeLoss / stores.length : 0,
    companyAffected: impacts.filter(i => i.node.owner === 'sample' && atLeastDegraded(i)),
    criticalAffected: impacts.filter(i => i.node.owner === 'public' && i.node.criticality === 5 && atLeastDegraded(i)),
  };
}

// ---------------------------------------------------------------------------
// What-if scenario presets. Selections are derived from node attributes, so
// dataset edits (new assets in an estuary, a renamed port) stay in sync.
// ---------------------------------------------------------------------------

export interface UkScenario {
  id: string;
  name: string;
  description: string;
  select: (nodes: UkTwinNode[]) => string[];
}

const inBox = (n: UkTwinNode, latMin: number, latMax: number, lonMin: number, lonMax: number) =>
  n.lat >= latMin && n.lat <= latMax && n.lon >= lonMin && n.lon <= lonMax;
const floodable = (n: UkTwinNode) => n.floodExposure === 'coastal' || n.floodExposure === 'fluvial';

export const UK_SCENARIOS: UkScenario[] = [
  {
    id: 'humber-surge',
    name: 'Humber storm surge',
    description: 'A North Sea surge floods coastal and river assets around the Humber estuary.',
    select: nodes => nodes
      .filter(n => floodable(n) && inBox(n, 53.3, 53.9, -1.2, 0.4))
      .map(n => n.id),
  },
  {
    id: 'thames-surge',
    name: 'Thames tidal flood',
    description: 'A tidal flood hits exposed assets along the Thames estuary.',
    select: nodes => nodes
      .filter(n => floodable(n) && inBox(n, 51.25, 51.65, -0.55, 0.75))
      .map(n => n.id),
  },
  {
    id: 'felixstowe-closure',
    name: 'Felixstowe closure',
    description: "Britain's busiest container port shuts (storm, strike or incident).",
    select: nodes => nodes.filter(n => n.id === 'port-felixstowe').map(n => n.id),
  },
  {
    id: 'interconnector-outage',
    name: 'Interconnector outage',
    description: 'Every cross-border electricity interconnector drops offline at once.',
    select: nodes => nodes.filter(n => n.type === 'interconnector').map(n => n.id),
  },
];
