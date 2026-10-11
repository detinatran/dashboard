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

/** Node colours grouped by sector: energy warm, transport blue, care/utilities green, company violet. */
export const UK_NODE_TYPE_COLORS: Record<UkNodeType, [number, number, number]> = {
  power_station: [255, 176, 0],
  interconnector: [255, 214, 102],
  gas_terminal: [255, 120, 70],
  lng_terminal: [255, 140, 100],
  port: [79, 195, 247],
  airport: [129, 212, 250],
  rail_hub: [100, 160, 255],
  road_junction: [144, 164, 174],
  logistics_hub: [77, 182, 172],
  hospital: [239, 83, 80],
  water_works: [38, 198, 218],
  data_centre: [171, 130, 255],
  factory: [206, 147, 216],
  supplier: [186, 104, 200],
  distribution_centre: [224, 64, 251],
  store_cluster: [240, 98, 146],
};
