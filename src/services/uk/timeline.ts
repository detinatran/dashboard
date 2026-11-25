// CrisisTwin UK hourly cascade timeline. The static engine (cascade.ts)
// answers "where does the loss end up"; this one answers "when does it
// arrive". Loss travels one dependency edge per hour, and each asset first
// rides out the deficit on its own buffer — backup generation, fuel, water
// storage or inventory — before ramping toward the transmitted loss. With
// enough hours the final frame converges to the static fixed point. Pure
// functions, browser-only, exercised by tests/uk-timeline.test.mts.

import {
  buildIncomingMap,
  CASCADE_DEFAULTS,
  meanStoreLoss,
  storeClusters,
  transmittedPressure,
  type UkCascadeOptions,
} from './cascade';
import type { UkNodeType, UkTwinEdge, UkTwinNode } from './twin';

/**
 * Hours an asset keeps operating at full capacity after its providers start
 * failing. Coarse public-knowledge figures: hospitals must carry ~48h of
 * backup fuel, data centres ~24h, water works hold treated-water storage,
 * stores and depots hold inventory; grid and transport assets have none.
 */
export const UK_AUTONOMY_HOURS: Record<UkNodeType, number> = {
  power_station: 0,
  interconnector: 0,
  gas_terminal: 0,
  lng_terminal: 0,
  port: 0,
  airport: 2,
  rail_hub: 1,
  road_junction: 0,
  logistics_hub: 4,
  hospital: 48,
  water_works: 8,
  data_centre: 24,
  factory: 8,
  supplier: 12,
  distribution_centre: 36,
  store_cluster: 24,
};

/** Hours over which a node slides from "buffer exhausted" to full transmitted loss. */
export const RAMP_HOURS = 3;

export const DEFAULT_TIMELINE_HOURS = 72;

export interface UkTimelineFrame {
  hour: number;
  /** Capacity loss per node id at this hour (0..1), pruned below the floor. */
  losses: Map<string, number>;
  /** Mean capacity loss across the sample company's store clusters, 0..1. */
  serviceDisruption: number;
  /** Nodes above the floor at this hour. */
  affectedCount: number;
}

export interface UkTimelineResult {
  frames: UkTimelineFrame[];
  failed: Set<string>;
  hours: number;
  /** First hour at which store-service disruption reaches its maximum. */
  peakHour: number;
}

export interface UkTimelineOptions {
  hours?: number;
  cascade?: Pick<UkCascadeOptions, 'substitutionFactor' | 'floor'>;
}

export function simulateCascadeTimeline(
  nodes: UkTwinNode[],
  edges: UkTwinEdge[],
  failedIds: Iterable<string>,
  options: UkTimelineOptions = {},
): UkTimelineResult {
  const hours = Math.max(1, Math.round(options.hours ?? DEFAULT_TIMELINE_HOURS));
  const substitutionFactor = options.cascade?.substitutionFactor ?? CASCADE_DEFAULTS.substitutionFactor;
  const floor = options.cascade?.floor ?? CASCADE_DEFAULTS.floor;

  const { incoming, known } = buildIncomingMap(nodes, edges);
  const byId = new Map(nodes.map(n => [n.id, n]));
  const failed = new Set([...failedIds].filter(id => known.has(id)));
  const stores = storeClusters(nodes);

  let losses = new Map<string, number>();
  for (const id of failed) losses.set(id, 1);
  /** Hour each node's providers first put it under pressure. */
  const deficitStart = new Map<string, number>();

  const makeFrame = (hour: number, current: Map<string, number>): UkTimelineFrame => {
    const pruned = new Map<string, number>();
    for (const [id, loss] of current) {
      if (loss >= floor || failed.has(id)) pruned.set(id, loss);
    }
    return {
      hour,
      losses: pruned,
      serviceDisruption: meanStoreLoss(stores, pruned),
      affectedCount: pruned.size,
    };
  };

  const frames: UkTimelineFrame[] = [makeFrame(0, losses)];

  for (let hour = 1; hour <= hours; hour++) {
    // Jacobi step: pressure reads the previous hour only, so loss travels one
    // edge per hour regardless of map iteration order.
    const prev = losses;
    const lossOf = (id: string): number => prev.get(id) ?? 0;
    const next = new Map(prev);
    for (const [to, list] of incoming) {
      if (failed.has(to)) continue;
      const pressure = Math.min(1, transmittedPressure(list, lossOf, known, substitutionFactor));
      if (pressure < floor) {
        deficitStart.delete(to);
        continue;
      }
      if (!deficitStart.has(to)) deficitStart.set(to, hour);
      const autonomy = UK_AUTONOMY_HOURS[byId.get(to)?.type ?? 'road_junction'];
      const held = hour - deficitStart.get(to)!;
      if (held < autonomy) continue; // still riding generators / storage / inventory
      const ramp = RAMP_HOURS > 0 ? Math.min(1, (held - autonomy + 1) / RAMP_HOURS) : 1;
      const target = pressure * ramp;
      if (target > (next.get(to) ?? 0) + 1e-6) next.set(to, target);
    }
    losses = next;
    frames.push(makeFrame(hour, losses));
  }

  let peakHour = 0;
  let peak = -1;
  for (const frame of frames) {
    if (frame.serviceDisruption > peak + 1e-9) {
      peak = frame.serviceDisruption;
      peakHour = frame.hour;
    }
  }

  return { frames, failed, hours, peakHour };
}
