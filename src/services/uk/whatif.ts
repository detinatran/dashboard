// CrisisTwin UK what-if lab: compare response plans for a hazard over a
// 14-day horizon — "what if we close the DC?" vs "what if we reroute?".
// Pure model estimates over the twin graph; every constant is named so the
// assumptions are reviewable, and the UI labels results as estimates.

import { simulateCascade } from './cascade';
import type { UkTwinEdge, UkTwinNode } from './twin';

export type UkPlan =
  | { kind: 'none' }
  | { kind: 'close'; node: string }
  | { kind: 'reroute'; node: string; target: string };

export interface UkPlanResult {
  plan: UkPlan;
  /** Mean store service level over the horizon, 0..1. */
  serviceLevel: number;
  /** Mean hours from factory to store for goods that still arrive. */
  deliveryHours: number;
  /** Logistics cost over the horizon; a normal fortnight = 100. */
  costIndex: number;
}

/** Hazard duration (storm/flood in force). */
export const EVENT_DAYS = 3;
/**
 * Extra days a flooded, unprotected company site stays down for repairs.
 * Public infrastructure is restored by its operators once the event passes
 * (the GB grid is meshed; ports and utilities run emergency recovery), so
 * only the sample company's own sites carry this tail.
 */
export const RECOVERY_DAYS = 10;
export const HORIZON_DAYS = 14;
/** Cross-docking and re-planning overhead on every rerouted flow. */
export const REROUTE_PENALTY_HOURS = 1.5;
/** When the target has no direct lane to a store, the detour is this much longer. */
export const DETOUR_FACTOR = 1.5;
/** One-off cost of a flooded site (stock write-off, clean-up), in normal days of network logistics spend. */
export const DAMAGE_COST_DAYS = 6;
/** One-off cost of a planned shutdown and restart, in normal days of spend. */
export const CLOSURE_COST_DAYS = 0.5;
/** Lost margin on undelivered goods, per unit of logistics spend they would have used. */
export const LOST_SALES_FACTOR = 3;
/** A rerouted inbound lane that the target did not already run carries this share of its weight. */
const NEW_INBOUND_SHARE = 0.5;
/** Inbound factory→DC time assumed when a DC has no live inbound lane. */
const DEFAULT_INBOUND_HOURS = 3;

const isTransport = (e: UkTwinEdge) => e.kind === 'transports';

/**
 * Move every flow through `node` to `target`: outbound lanes start at the
 * target (reusing its own lane to that store when one exists), inbound lanes
 * deliver to the target. Lanes the target already runs keep their weight.
 */
export function rerouteEdges(edges: UkTwinEdge[], node: string, target: string): UkTwinEdge[] {
  const lanes = new Map<string, UkTwinEdge>();
  const key = (e: Pick<UkTwinEdge, 'from' | 'to' | 'kind'>) => `${e.kind}:${e.from}->${e.to}`;
  for (const e of edges) lanes.set(key(e), e);

  const merged = new Map<string, UkTwinEdge>();
  const put = (e: UkTwinEdge) => {
    const k = key(e);
    const existing = merged.get(k);
    // Two flows on one lane: the store/DC now leans on it at least as much
    // as either flow did — never the sum, which double-counts the provider.
    if (!existing || e.dependency > existing.dependency) merged.set(k, existing ? { ...existing, dependency: e.dependency } : e);
  };

  for (const e of edges) {
    if (e.from === node && isTransport(e)) {
      const own = lanes.get(key({ kind: e.kind, from: target, to: e.to }));
      put({
        ...e,
        id: `${e.id}~via~${target}`,
        from: target,
        leadTimeHours: (own?.leadTimeHours ?? (e.leadTimeHours ?? DEFAULT_INBOUND_HOURS) * DETOUR_FACTOR) + REROUTE_PENALTY_HOURS,
        alternatives: (e.alternatives ?? []).filter(a => a !== target),
      });
    } else if (e.to === node && isTransport(e)) {
      const own = lanes.get(key({ kind: e.kind, from: e.from, to: target }));
      // The target already draws from this provider: its own lane stands.
      if (own) continue;
      put({
        ...e,
        id: `${e.id}~to~${target}`,
        to: target,
        dependency: e.dependency * NEW_INBOUND_SHARE,
        leadTimeHours: (e.leadTimeHours ?? DEFAULT_INBOUND_HOURS) * DETOUR_FACTOR,
        alternatives: (e.alternatives ?? []).filter(a => a !== target),
      });
    } else {
      put(e);
    }
  }
  return [...merged.values()];
}

interface DayState { failed: Set<string>; edges: UkTwinEdge[] }

interface DayMetrics { service: number; hours: number; cost: number }

function evaluateDay(nodes: UkTwinNode[], state: DayState): DayMetrics {
  const { losses } = simulateCascade(nodes, state.edges, state.failed);
  const loss = (id: string) => losses.get(id) ?? 0;
  const stores = nodes.filter(n => n.type === 'store_cluster');
  const service = stores.length ? 1 - stores.reduce((s, n) => s + loss(n.id), 0) / stores.length : 1;

  const inboundTime = (dc: string): number => {
    let w = 0;
    let t = 0;
    for (const e of state.edges) {
      if (e.to !== dc || !isTransport(e) || e.leadTimeHours == null) continue;
      const flow = e.dependency * (1 - loss(e.from));
      w += flow;
      t += flow * e.leadTimeHours;
    }
    return w > 0 ? t / w : DEFAULT_INBOUND_HOURS;
  };

  let storeHours = 0;
  let storesTimed = 0;
  let cost = 0;
  for (const store of stores) {
    let w = 0;
    let t = 0;
    let volume = 0;
    for (const e of state.edges) {
      if (e.to !== store.id || !isTransport(e) || e.leadTimeHours == null) continue;
      volume += e.dependency;
      const flow = e.dependency * (1 - loss(e.from));
      if (flow <= 0) continue;
      const hours = e.leadTimeHours + inboundTime(e.from);
      w += flow;
      t += flow * hours;
    }
    if (w > 0) {
      const hours = t / w;
      storeHours += hours;
      storesTimed++;
      // Everything the store still receives travels somewhere, including the
      // share absorbed by alternative lanes: charge delivered volume at the
      // lanes' mean time, so a closure cannot look cheaper than normal.
      cost += volume * (1 - loss(store.id)) * hours;
    }
  }
  return { service, hours: storesTimed ? storeHours / storesTimed : 0, cost };
}

/** The sites the hazard floods directly (and so damages unless protected). */
export function evaluatePlan(
  nodes: UkTwinNode[],
  edges: UkTwinEdge[],
  hazard: string[],
  plan: UkPlan,
): UkPlanResult {
  const normal = evaluateDay(nodes, { failed: new Set(), edges });
  const hit = new Set(hazard);

  // A closed site is shut and emptied before the event: down for the event,
  // undamaged after. A rerouted site's flows avoid it for the whole horizon.
  const protectedSite = plan.kind === 'close' ? plan.node : null;
  const planEdges = plan.kind === 'reroute' ? rerouteEdges(edges, plan.node, plan.target) : edges;

  const during: DayState = {
    failed: new Set([...hit, ...(protectedSite ? [protectedSite] : [])]),
    edges: planEdges,
  };
  const sample = new Set(nodes.filter(n => n.owner === 'sample').map(n => n.id));
  const damaged = new Set([...hit].filter(id => id !== protectedSite && sample.has(id)));
  const recovering: DayState = { failed: damaged, edges: planEdges };
  const afterRecovery: DayState = { failed: new Set(), edges: plan.kind === 'reroute' ? planEdges : edges };

  const days: Array<[DayState, number]> = [
    [during, EVENT_DAYS],
    [recovering, RECOVERY_DAYS],
    [afterRecovery, HORIZON_DAYS - EVENT_DAYS - RECOVERY_DAYS],
  ];
  let service = 0;
  let hours = 0;
  let cost = 0;
  for (const [state, n] of days) {
    if (n <= 0) continue;
    const m = evaluateDay(nodes, state);
    service += m.service * n;
    hours += m.hours * n;
    // Logistics actually spent, plus the margin lost on what never arrived.
    cost += (m.cost + normal.cost * (1 - m.service) * LOST_SALES_FACTOR) * n;
  }

  cost += normal.cost * (damaged.size * DAMAGE_COST_DAYS + (protectedSite ? CLOSURE_COST_DAYS : 0));

  return {
    plan,
    serviceLevel: service / HORIZON_DAYS,
    deliveryHours: hours / HORIZON_DAYS,
    costIndex: normal.cost > 0 ? (cost / (normal.cost * HORIZON_DAYS)) * 100 : 100,
  };
}

/** Highest service wins; within 2 points of service, the cheaper plan wins. */
export function recommendPlan(results: UkPlanResult[]): UkPlanResult | null {
  return results.reduce<UkPlanResult | null>((best, r) => {
    if (!best) return r;
    const dService = r.serviceLevel - best.serviceLevel;
    if (dService > 0.02) return r;
    if (dService >= -0.02 && r.costIndex < best.costIndex) return r;
    return best;
  }, null);
}

export function normalBaseline(nodes: UkTwinNode[], edges: UkTwinEdge[]): UkPlanResult {
  return evaluatePlan(nodes, edges, [], { kind: 'none' });
}
