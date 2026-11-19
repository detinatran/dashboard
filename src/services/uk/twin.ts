// CrisisTwin UK digital twin: the static infrastructure + sample-company graph
// from shared/uk-twin-data.ts. Loaded lazily — ~1k lines of coordinates the
// other variants never need in their startup bundle.

import type {
  UkEdgeKind,
  UkNodeType,
  UkRegionId,
  UkTwinEdge,
  UkTwinNode,
} from '../../../shared/uk-twin-data';

export type { UkEdgeKind, UkNodeType, UkRegionId, UkTwinEdge, UkTwinNode };

export interface UkTwinGraph {
  nodes: UkTwinNode[];
  edges: UkTwinEdge[];
  regionLabels: Record<UkRegionId, string>;
  regionCentroids: Record<UkRegionId, [number, number]>;
  sampleCompany: { id: string; name: string; sector: string; description: string };
}

let twinPromise: Promise<UkTwinGraph> | null = null;

export function loadUkTwin(): Promise<UkTwinGraph> {
  if (!twinPromise) {
    twinPromise = import('../../../shared/uk-twin-data')
      .then((m) => ({
        nodes: m.UK_TWIN_NODES,
        edges: m.UK_TWIN_EDGES,
        regionLabels: m.UK_REGION_LABELS,
        regionCentroids: m.UK_REGION_CENTROIDS,
        sampleCompany: m.SAMPLE_COMPANY,
      }))
      .catch((error) => {
        twinPromise = null;
        throw error;
      });
  }
  return twinPromise;
}

/** Display label per node type; also the legend order. */
export const UK_NODE_TYPE_LABELS: Record<UkNodeType, string> = {
  port: 'Port',
  airport: 'Airport',
  power_station: 'Power station',
  interconnector: 'Interconnector',
  gas_terminal: 'Gas terminal',
  lng_terminal: 'LNG terminal',
  rail_hub: 'Rail hub',
  road_junction: 'Road junction',
  logistics_hub: 'Logistics hub',
  hospital: 'Hospital',
  water_works: 'Water works',
  data_centre: 'Data centre',
  factory: 'Factory',
  supplier: 'Supplier',
  distribution_centre: 'Distribution centre',
  store_cluster: 'Store cluster',
};

/**
 * Four sector families, not sixteen hues: identity reads at sector level
 * (energy amber, transport blue, care/utilities green-teal, company violet)
 * with same-family types separated by lightness. The family bases pass the
 * CVD/contrast palette checks on both light and dark surfaces alongside the
 * #f03e3e failure red; per-type identity is carried by tooltip and the
 * impact list, never by hue alone.
 */
export type UkSectorId = 'energy' | 'transport' | 'care' | 'company';

export const UK_SECTORS: Array<{ id: UkSectorId; label: string; color: string }> = [
  { id: 'energy', label: 'Energy', color: '#d97706' },
  { id: 'transport', label: 'Transport & logistics', color: '#1c7ed6' },
  { id: 'care', label: 'Care & utilities', color: '#2f9e44' },
  { id: 'company', label: 'Albion Provisions', color: '#9775fa' },
];

export const UK_NODE_SECTOR: Record<UkNodeType, UkSectorId> = {
  power_station: 'energy',
  interconnector: 'energy',
  gas_terminal: 'energy',
  lng_terminal: 'energy',
  port: 'transport',
  airport: 'transport',
  rail_hub: 'transport',
  road_junction: 'transport',
  logistics_hub: 'transport',
  hospital: 'care',
  water_works: 'care',
  data_centre: 'care',
  factory: 'company',
  supplier: 'company',
  distribution_centre: 'company',
  store_cluster: 'company',
};

export const UK_NODE_TYPE_COLORS: Record<UkNodeType, [number, number, number]> = {
  power_station: [217, 119, 6],
  interconnector: [242, 164, 68],
  gas_terminal: [194, 65, 12],
  lng_terminal: [232, 89, 12],
  port: [25, 113, 194],
  airport: [77, 171, 247],
  rail_hub: [28, 126, 214],
  road_junction: [127, 143, 160],
  logistics_hub: [15, 140, 168],
  hospital: [47, 158, 68],
  water_works: [12, 166, 120],
  data_centre: [12, 133, 153],
  factory: [112, 72, 232],
  supplier: [151, 117, 250],
  distribution_centre: [194, 37, 92],
  store_cluster: [230, 73, 128],
};
