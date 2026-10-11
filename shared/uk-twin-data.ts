/**
 * CrisisTwin UK — static digital-twin dataset.
 *
 * Two layers:
 *  1. Real, publicly documented UK infrastructure (owner: 'public'). Coordinates
 *     are WGS84 and were checked against Wikipedia / OpenStreetMap (Nominatim)
 *     in October 2026; operating status reflects public announcements up to then
 *     (e.g. Ratcliffe-on-Soar closed Sept 2024 and is excluded; Heysham 1 and
 *     Hartlepool extended to March 2028; Heysham 2 and Torness to March 2030;
 *     Hinkley Point C still under construction).
 *  2. A fictional sample company, "Albion Provisions Ltd" (owner: 'sample'),
 *     placed on real industrial estates so supply-chain cascades can be demoed.
 *
 * Edges point provider -> dependent and the graph is kept acyclic.
 * `dependency` is the approximate share of the dependent's operation that relies
 * on the provider; it is an illustrative modelling estimate, not an
 * operator-published figure. `floodExposure` is a coarse best-public-knowledge
 * tag (EA / NRW / SEPA flood maps and known flood history), not a formal rating.
 */

export type UkRegionId =
  | 'north-east'
  | 'north-west'
  | 'yorkshire'
  | 'east-midlands'
  | 'west-midlands'
  | 'east'
  | 'london'
  | 'south-east'
  | 'south-west'
  | 'wales'
  | 'scotland'
  | 'northern-ireland';

export type UkNodeType =
  | 'port'
  | 'airport'
  | 'power_station'
  | 'interconnector'
  | 'gas_terminal'
  | 'lng_terminal'
  | 'rail_hub'
  | 'road_junction'
  | 'logistics_hub'
  | 'hospital'
  | 'water_works'
  | 'data_centre'
  // sample-company assets
  | 'factory'
  | 'supplier'
  | 'distribution_centre'
  | 'store_cluster';

export interface UkTwinNode {
  /** kebab-case, unique, stable (e.g. 'port-felixstowe') */
  id: string;
  /** real public name (or fictional name for sample-company assets) */
  name: string;
  type: UkNodeType;
  /** WGS84 latitude */
  lat: number;
  /** WGS84 longitude */
  lon: number;
  /** ITL1 region the asset sits in */
  region: UkRegionId;
  /** 'sample' = fictional sample company */
  owner: 'public' | 'sample';
  /** 5 = nationally critical */
  criticality: 1 | 2 | 3 | 4 | 5;
  capacity?: { value: number; unit: string };
  floodExposure: 'coastal' | 'fluvial' | 'surface' | 'low';
  status?: 'operational' | 'construction';
  description: string;
}

export type UkEdgeKind = 'powers' | 'supplies_gas' | 'ships_via' | 'supplies' | 'transports' | 'serves' | 'depends_on';

export interface UkTwinEdge {
  id: string;
  /** upstream node id (provider) */
  from: string;
  /** downstream node id (dependent) */
  to: string;
  kind: UkEdgeKind;
  /** 0..1 — share of `to`'s operation that relies on `from` */
  dependency: number;
  /** for transport/supply edges: normal transit time */
  leadTimeHours?: number;
  /** node ids that could substitute `from` for this dependency */
  alternatives?: string[];
}

export const SAMPLE_COMPANY: { id: string; name: string; sector: string; description: string } = {
  id: 'albion-provisions',
  name: 'Albion Provisions Ltd',
  sector: 'Grocery & household goods manufacturing and distribution',
  description:
    'Fictional sample company (not a real business): a UK maker of chilled ready meals, bakery lines and household cleaning goods, with three factories, four regional distribution centres and six store clusters.',
};

export const UK_REGION_LABELS: Record<UkRegionId, string> = {
  'north-east': 'North East',
  'north-west': 'North West',
  yorkshire: 'Yorkshire and The Humber',
  'east-midlands': 'East Midlands',
  'west-midlands': 'West Midlands',
  east: 'East of England',
  london: 'London',
  'south-east': 'South East',
  'south-west': 'South West',
  wales: 'Wales',
  scotland: 'Scotland',
  'northern-ireland': 'Northern Ireland',
};

/** Approximate geographic centroids, as [lon, lat]. */
export const UK_REGION_CENTROIDS: Record<UkRegionId, [lon: number, lat: number]> = {
  'north-east': [-1.85, 55.0],
  'north-west': [-2.7, 54.05],
  yorkshire: [-1.25, 53.95],
  'east-midlands': [-0.85, 52.95],
  'west-midlands': [-2.1, 52.48],
  east: [0.5, 52.25],
  london: [-0.12, 51.5],
  'south-east': [-0.55, 51.3],
  'south-west': [-3.3, 50.9],
  wales: [-3.75, 52.35],
  scotland: [-4.2, 56.8],
  'northern-ireland': [-6.7, 54.6],
};

export const UK_TWIN_NODES: UkTwinNode[] = [
  // ───────────────────────────── Ports ─────────────────────────────
  {
    id: 'port-felixstowe', name: 'Port of Felixstowe', type: 'port', lat: 51.955, lon: 1.31, region: 'east',
    owner: 'public', criticality: 5, capacity: { value: 4.0, unit: 'M TEU/yr' }, floodExposure: 'coastal', status: 'operational',
    description: "Britain's busiest container port, handling over a third of GB container traffic.",
  },
  {
    id: 'port-southampton', name: 'Port of Southampton', type: 'port', lat: 50.8965, lon: -1.3968, region: 'south-east',
    owner: 'public', criticality: 5, capacity: { value: 1.9, unit: 'M TEU/yr' }, floodExposure: 'coastal', status: 'operational',
    description: "UK's second-largest container port and main cruise and vehicle-export gateway.",
  },
  {
    id: 'port-london-gateway', name: 'DP World London Gateway', type: 'port', lat: 51.5052, lon: 0.4902, region: 'east',
    owner: 'public', criticality: 5, capacity: { value: 2.0, unit: 'M TEU/yr' }, floodExposure: 'coastal', status: 'operational',
    description: 'Deep-water container port on the Thames estuary with an adjoining logistics park.',
  },
  {
    id: 'port-tilbury', name: 'Port of Tilbury', type: 'port', lat: 51.46, lon: 0.345, region: 'east',
    owner: 'public', criticality: 4, floodExposure: 'coastal', status: 'operational',
    description: "London's principal port for food, grain, forest products and short-sea ro-ro.",
  },
  {
    id: 'port-dover', name: 'Port of Dover', type: 'port', lat: 51.1192, lon: 1.3294, region: 'south-east',
    owner: 'public', criticality: 5, capacity: { value: 2.2, unit: 'M freight vehicles/yr' }, floodExposure: 'coastal', status: 'operational',
    description: 'Busiest ro-ro ferry port in Europe and the main short-strait link to Calais and Dunkirk.',
  },
  {
    id: 'port-immingham', name: 'Port of Immingham', type: 'port', lat: 53.6281, lon: -0.1915, region: 'yorkshire',
    owner: 'public', criticality: 5, capacity: { value: 46, unit: 'Mt/yr (Grimsby & Immingham)' }, floodExposure: 'coastal', status: 'operational',
    description: "Humber deep-water port; with Grimsby the UK's largest port complex by tonnage.",
  },
  {
    id: 'port-hull', name: 'Port of Hull (King George Dock)', type: 'port', lat: 53.7428, lon: -0.2671, region: 'yorkshire',
    owner: 'public', criticality: 4, floodExposure: 'coastal', status: 'operational',
    description: 'ABP Humber port with ro-ro ferry links to Rotterdam and Zeebrugge.',
  },
  {
    id: 'port-liverpool', name: 'Port of Liverpool (Royal Seaforth / Liverpool2)', type: 'port', lat: 53.4592, lon: -3.025, region: 'north-west',
    owner: 'public', criticality: 5, floodExposure: 'coastal', status: 'operational',
    description: "Peel Ports' main west-coast container and bulk gateway serving the North and Midlands.",
  },
  {
    id: 'port-teesport', name: 'Teesport', type: 'port', lat: 54.604, lon: -1.158, region: 'north-east',
    owner: 'public', criticality: 4, floodExposure: 'coastal', status: 'operational',
    description: 'PD Ports deep-sea port on the Tees serving North East industry and container trades.',
  },
  {
    id: 'port-bristol-avonmouth', name: 'Port of Bristol (Avonmouth Docks)', type: 'port', lat: 51.505, lon: -2.707, region: 'south-west',
    owner: 'public', criticality: 4, floodExposure: 'coastal', status: 'operational',
    description: 'Severn estuary port handling bulk, vehicles and containers for the South West.',
  },
  {
    id: 'port-milford-haven', name: 'Port of Milford Haven', type: 'port', lat: 51.7142, lon: -5.0427, region: 'wales',
    owner: 'public', criticality: 5, floodExposure: 'coastal', status: 'operational',
    description: "UK's leading energy port, serving two LNG terminals and the Valero Pembroke refinery.",
  },
  {
    id: 'port-belfast', name: 'Belfast Harbour', type: 'port', lat: 54.6178, lon: -5.9017, region: 'northern-ireland',
    owner: 'public', criticality: 5, capacity: { value: 24, unit: 'Mt/yr' }, floodExposure: 'coastal', status: 'operational',
    description: "Northern Ireland's main port, handling most of its seaborne trade with GB.",
  },
  {
    id: 'port-grangemouth', name: 'Port of Grangemouth', type: 'port', lat: 56.0286, lon: -3.6934, region: 'scotland',
    owner: 'public', criticality: 4, floodExposure: 'coastal', status: 'operational',
    description: "Scotland's largest container port, on the Firth of Forth.",
  },

  // ──────────────────────────── Airports ────────────────────────────
  {
    id: 'airport-heathrow', name: 'Heathrow Airport', type: 'airport', lat: 51.47, lon: -0.4543, region: 'london',
    owner: 'public', criticality: 5, capacity: { value: 83.9, unit: 'M pax/yr (2024)' }, floodExposure: 'low', status: 'operational',
    description: "UK's hub airport and largest air-freight gateway by value.",
  },
  {
    id: 'airport-gatwick', name: 'Gatwick Airport', type: 'airport', lat: 51.1481, lon: -0.1903, region: 'south-east',
    owner: 'public', criticality: 4, capacity: { value: 43.2, unit: 'M pax/yr (2024)' }, floodExposure: 'fluvial', status: 'operational',
    description: "London's second airport; River Mole flooding disrupted the North Terminal in December 2013.",
  },
  {
    id: 'airport-manchester', name: 'Manchester Airport', type: 'airport', lat: 53.3539, lon: -2.275, region: 'north-west',
    owner: 'public', criticality: 4, capacity: { value: 30.9, unit: 'M pax/yr (2024)' }, floodExposure: 'low', status: 'operational',
    description: 'Largest UK airport outside London and the main northern long-haul gateway.',
  },
  {
    id: 'airport-stansted', name: 'London Stansted Airport', type: 'airport', lat: 51.885, lon: 0.235, region: 'east',
    owner: 'public', criticality: 4, capacity: { value: 29.7, unit: 'M pax/yr (2024)' }, floodExposure: 'low', status: 'operational',
    description: 'Major London passenger and dedicated-freighter airport in Essex.',
  },
  {
    id: 'airport-east-midlands', name: 'East Midlands Airport', type: 'airport', lat: 52.8311, lon: -1.3281, region: 'east-midlands',
    owner: 'public', criticality: 4, floodExposure: 'low', status: 'operational',
    description: "UK's busiest pure-cargo airport and a hub for express parcel integrators.",
  },
  {
    id: 'airport-birmingham', name: 'Birmingham Airport', type: 'airport', lat: 52.4539, lon: -1.7481, region: 'west-midlands',
    owner: 'public', criticality: 3, floodExposure: 'low', status: 'operational',
    description: 'Main West Midlands airport, beside the M42 and the NEC.',
  },
  {
    id: 'airport-edinburgh', name: 'Edinburgh Airport', type: 'airport', lat: 55.95, lon: -3.3725, region: 'scotland',
    owner: 'public', criticality: 3, capacity: { value: 15.8, unit: 'M pax/yr (2024)' }, floodExposure: 'low', status: 'operational',
    description: "Scotland's busiest airport.",
  },
  {
    id: 'airport-glasgow', name: 'Glasgow Airport', type: 'airport', lat: 55.8719, lon: -4.4331, region: 'scotland',
    owner: 'public', criticality: 3, floodExposure: 'low', status: 'operational',
    description: 'Main airport for west-central Scotland.',
  },

  // ───────────────────────── Power stations ─────────────────────────
  {
    id: 'power-drax', name: 'Drax Power Station', type: 'power_station', lat: 53.7358, lon: -0.9964, region: 'yorkshire',
    owner: 'public', criticality: 5, capacity: { value: 2600, unit: 'MW' }, floodExposure: 'fluvial', status: 'operational',
    description: 'Four biomass units near Selby; new CfD runs Apr 2027–Mar 2031 at a capped load factor.',
  },
  {
    id: 'power-heysham-1', name: 'Heysham 1 Nuclear Power Station', type: 'power_station', lat: 54.0296, lon: -2.9166, region: 'north-west',
    owner: 'public', criticality: 4, capacity: { value: 1060, unit: 'MW' }, floodExposure: 'coastal', status: 'operational',
    description: 'EDF AGR station; generation extended to March 2028.',
  },
  {
    id: 'power-heysham-2', name: 'Heysham 2 Nuclear Power Station', type: 'power_station', lat: 54.028, lon: -2.915, region: 'north-west',
    owner: 'public', criticality: 4, capacity: { value: 1240, unit: 'MW' }, floodExposure: 'coastal', status: 'operational',
    description: 'EDF AGR station scheduled to generate until March 2030.',
  },
  {
    id: 'power-hartlepool', name: 'Hartlepool Nuclear Power Station', type: 'power_station', lat: 54.635, lon: -1.1808, region: 'north-east',
    owner: 'public', criticality: 4, capacity: { value: 1185, unit: 'MW' }, floodExposure: 'coastal', status: 'operational',
    description: 'EDF AGR station on Teesmouth; generation extended to March 2028.',
  },
  {
    id: 'power-torness', name: 'Torness Nuclear Power Station', type: 'power_station', lat: 55.968, lon: -2.4091, region: 'scotland',
    owner: 'public', criticality: 4, capacity: { value: 1200, unit: 'MW' }, floodExposure: 'coastal', status: 'operational',
    description: 'EDF AGR station in East Lothian scheduled to generate until March 2030.',
  },
  {
    id: 'power-sizewell-b', name: 'Sizewell B Nuclear Power Station', type: 'power_station', lat: 52.2145, lon: 1.6189, region: 'east',
    owner: 'public', criticality: 5, capacity: { value: 1198, unit: 'MW' }, floodExposure: 'coastal', status: 'operational',
    description: "UK's only PWR, on the Suffolk coast; EDF is seeking a 20-year life extension beyond 2035.",
  },
  {
    id: 'power-pembroke', name: 'Pembroke Power Station', type: 'power_station', lat: 51.6831, lon: -4.9884, region: 'wales',
    owner: 'public', criticality: 5, capacity: { value: 2200, unit: 'MW' }, floodExposure: 'coastal', status: 'operational',
    description: "RWE CCGT on the Milford Haven waterway, one of Europe's largest gas-fired stations.",
  },
  {
    id: 'power-grain', name: 'Grain Power Station (CHP)', type: 'power_station', lat: 51.4461, lon: 0.7131, region: 'south-east',
    owner: 'public', criticality: 4, capacity: { value: 1275, unit: 'MW' }, floodExposure: 'coastal', status: 'operational',
    description: 'Uniper CCGT on the Isle of Grain whose waste heat warms the adjacent LNG terminal.',
  },
  {
    id: 'power-staythorpe', name: 'Staythorpe C Power Station', type: 'power_station', lat: 53.0748, lon: -0.8557, region: 'east-midlands',
    owner: 'public', criticality: 4, capacity: { value: 1750, unit: 'MW' }, floodExposure: 'fluvial', status: 'operational',
    description: 'RWE CCGT beside the River Trent near Newark.',
  },
  {
    id: 'power-west-burton-b', name: 'West Burton B Power Station', type: 'power_station', lat: 53.3642, lon: -0.7963, region: 'east-midlands',
    owner: 'public', criticality: 4, capacity: { value: 1332, unit: 'MW' }, floodExposure: 'fluvial', status: 'operational',
    description: 'TotalEnergies CCGT on the Trent near Gainsborough.',
  },
  {
    id: 'power-saltend', name: 'Saltend Power Station', type: 'power_station', lat: 53.7336, lon: -0.2428, region: 'yorkshire',
    owner: 'public', criticality: 3, capacity: { value: 1200, unit: 'MW' }, floodExposure: 'coastal', status: 'operational',
    description: 'Triton Power CCGT/CHP on the Humber bank serving the Saltend Chemicals Park.',
  },
  {
    id: 'power-didcot-b', name: 'Didcot B Power Station', type: 'power_station', lat: 51.6236, lon: -1.2676, region: 'south-east',
    owner: 'public', criticality: 4, capacity: { value: 1450, unit: 'MW' }, floodExposure: 'low', status: 'operational',
    description: 'RWE CCGT in Oxfordshire supporting the Thames Valley and London grid.',
  },
  {
    id: 'power-peterhead', name: 'Peterhead Power Station', type: 'power_station', lat: 57.4772, lon: -1.7889, region: 'scotland',
    owner: 'public', criticality: 4, capacity: { value: 1180, unit: 'MW' }, floodExposure: 'coastal', status: 'operational',
    description: "SSE CCGT at Boddam, Scotland's only large gas-fired station.",
  },
  {
    id: 'power-connahs-quay', name: "Connah's Quay Power Station", type: 'power_station', lat: 53.2322, lon: -3.0813, region: 'wales',
    owner: 'public', criticality: 4, capacity: { value: 1380, unit: 'MW' }, floodExposure: 'coastal', status: 'operational',
    description: 'Uniper CCGT on the Dee estuary supplying North Wales and Merseyside.',
  },
  {
    id: 'power-keadby-2', name: 'Keadby 2 Power Station', type: 'power_station', lat: 53.5944, lon: -0.7504, region: 'yorkshire',
    owner: 'public', criticality: 3, capacity: { value: 893, unit: 'MW' }, floodExposure: 'fluvial', status: 'operational',
    description: 'SSE/Equinor high-efficiency CCGT on the tidal Trent, commissioned 2023.',
  },
  {
    id: 'power-hornsea-killingholme', name: 'Hornsea One & Two onshore substations (North Killingholme)', type: 'power_station',
    lat: 53.645, lon: -0.262, region: 'yorkshire',
    owner: 'public', criticality: 4, capacity: { value: 2604, unit: 'MW' }, floodExposure: 'coastal', status: 'operational',
    description: 'Grid entry point for the Hornsea One and Two offshore wind farms (cable landfall at Horseshoe Point).',
  },
  {
    id: 'power-east-anglia-one-bramford', name: 'East Anglia ONE onshore substation (Bramford)', type: 'power_station',
    lat: 52.068, lon: 1.057, region: 'east',
    owner: 'public', criticality: 3, capacity: { value: 714, unit: 'MW' }, floodExposure: 'low', status: 'operational',
    description: 'Grid connection near Ipswich for the East Anglia ONE offshore wind farm (landfall at Bawdsey).',
  },
  {
    id: 'power-hinkley-point-c', name: 'Hinkley Point C Nuclear Power Station', type: 'power_station', lat: 51.2059, lon: -3.1429, region: 'south-west',
    owner: 'public', criticality: 3, capacity: { value: 3260, unit: 'MW' }, floodExposure: 'coastal', status: 'construction',
    description: 'Twin-EPR nuclear station under construction in Somerset; not yet generating.',
  },
  {
    id: 'power-ballylumford', name: 'Ballylumford Power Station', type: 'power_station', lat: 54.8449, lon: -5.7851, region: 'northern-ireland',
    owner: 'public', criticality: 5, capacity: { value: 688, unit: 'MW' }, floodExposure: 'coastal', status: 'operational',
    description: "EP UK gas-fired station at Islandmagee supplying a large share of Northern Ireland's demand.",
  },

  // ─────────────────── Interconnectors (GB converter stations) ───────────────────
  {
    id: 'ic-ifa-sellindge', name: 'IFA interconnector (Sellindge converter)', type: 'interconnector', lat: 51.1058, lon: 0.9756, region: 'south-east',
    owner: 'public', criticality: 5, capacity: { value: 2000, unit: 'MW' }, floodExposure: 'low', status: 'operational',
    description: 'HVDC link to France (Les Mandarins) via Kent.',
  },
  {
    id: 'ic-ifa2-daedalus', name: 'IFA2 interconnector (Daedalus converter, Fareham)', type: 'interconnector', lat: 50.818, lon: -1.194, region: 'south-east',
    owner: 'public', criticality: 4, capacity: { value: 1000, unit: 'MW' }, floodExposure: 'coastal', status: 'operational',
    description: 'HVDC link to Normandy landing on the Solent coast near Lee-on-the-Solent.',
  },
  {
    id: 'ic-britned-grain', name: 'BritNed interconnector (Isle of Grain converter)', type: 'interconnector', lat: 51.44, lon: 0.7167, region: 'south-east',
    owner: 'public', criticality: 4, capacity: { value: 1000, unit: 'MW' }, floodExposure: 'coastal', status: 'operational',
    description: 'HVDC link to Maasvlakte, Netherlands.',
  },
  {
    id: 'ic-eleclink-folkestone', name: 'ElecLink interconnector (Folkestone converter)', type: 'interconnector', lat: 51.0984, lon: 1.1447, region: 'south-east',
    owner: 'public', criticality: 4, capacity: { value: 1000, unit: 'MW' }, floodExposure: 'low', status: 'operational',
    description: 'HVDC link to France running through the Channel Tunnel.',
  },
  {
    id: 'ic-nemo-richborough', name: 'Nemo Link (Richborough converter)', type: 'interconnector', lat: 51.31, lon: 1.346, region: 'south-east',
    owner: 'public', criticality: 4, capacity: { value: 1000, unit: 'MW' }, floodExposure: 'coastal', status: 'operational',
    description: 'HVDC link to Zeebrugge, Belgium, on the former Richborough power station site.',
  },
  {
    id: 'ic-nsl-blyth', name: 'North Sea Link (Blyth converter, East Sleekburn)', type: 'interconnector', lat: 55.147, lon: -1.54, region: 'north-east',
    owner: 'public', criticality: 4, capacity: { value: 1400, unit: 'MW' }, floodExposure: 'coastal', status: 'operational',
    description: 'HVDC link to Kvilldal, Norway, importing hydro power to the North East.',
  },
  {
    id: 'ic-viking-bicker-fen', name: 'Viking Link (Bicker Fen converter)', type: 'interconnector', lat: 52.9303, lon: -0.2206, region: 'east-midlands',
    owner: 'public', criticality: 4, capacity: { value: 1400, unit: 'MW' }, floodExposure: 'fluvial', status: 'operational',
    description: 'HVDC link to Revsing, Denmark, landing in the Lincolnshire Fens.',
  },
  {
    id: 'ic-moyle-auchencrosh', name: 'Moyle interconnector (Auchencrosh converter)', type: 'interconnector', lat: 55.0694, lon: -4.9806, region: 'scotland',
    owner: 'public', criticality: 5, capacity: { value: 500, unit: 'MW' }, floodExposure: 'low', status: 'operational',
    description: 'HVDC link from Ayrshire to Ballycronan More, the only GB–Northern Ireland power link.',
  },
  {
    id: 'ic-ewic-shotton', name: 'East–West Interconnector (Shotton converter)', type: 'interconnector', lat: 53.2272, lon: -3.0728, region: 'wales',
    owner: 'public', criticality: 3, capacity: { value: 500, unit: 'MW' }, floodExposure: 'coastal', status: 'operational',
    description: 'HVDC link from Deeside to Woodland, County Meath, Ireland.',
  },
  {
    id: 'ic-greenlink-pembroke', name: 'Greenlink interconnector (Pembroke converter)', type: 'interconnector', lat: 51.681, lon: -4.985, region: 'wales',
    owner: 'public', criticality: 3, capacity: { value: 504, unit: 'MW' }, floodExposure: 'coastal', status: 'operational',
    description: 'HVDC link to Great Island, County Wexford; commercial operation since early 2025.',
  },

  // ─────────────────────── Gas & LNG terminals ───────────────────────
  {
    id: 'gas-bacton', name: 'Bacton Gas Terminal', type: 'gas_terminal', lat: 52.8608, lon: 1.4575, region: 'east',
    owner: 'public', criticality: 5, floodExposure: 'coastal', status: 'operational',
    description: 'Norfolk terminal for southern North Sea gas and the IUK and BBL pipelines to Belgium and the Netherlands.',
  },
  {
    id: 'gas-easington', name: 'Easington Gas Terminal', type: 'gas_terminal', lat: 53.6572, lon: 0.1174, region: 'yorkshire',
    owner: 'public', criticality: 5, floodExposure: 'coastal', status: 'operational',
    description: 'Landing point for the Langeled pipeline from Norway and the Rough storage field, on an eroding coast.',
  },
  {
    id: 'gas-st-fergus', name: 'St Fergus Gas Terminal', type: 'gas_terminal', lat: 57.5761, lon: -1.8397, region: 'scotland',
    owner: 'public', criticality: 5, floodExposure: 'coastal', status: 'operational',
    description: 'Aberdeenshire terminal receiving northern North Sea and Norwegian gas into the NTS.',
  },
  {
    id: 'lng-south-hook', name: 'South Hook LNG Terminal', type: 'lng_terminal', lat: 51.714, lon: -5.0759, region: 'wales',
    owner: 'public', criticality: 5, capacity: { value: 15.6, unit: 'mtpa' }, floodExposure: 'coastal', status: 'operational',
    description: "Milford Haven regasification terminal, one of Europe's largest, chiefly supplied from Qatar.",
  },
  {
    id: 'lng-dragon', name: 'Dragon LNG Terminal', type: 'lng_terminal', lat: 51.7066, lon: -4.9912, region: 'wales',
    owner: 'public', criticality: 4, capacity: { value: 5.6, unit: 'mtpa' }, floodExposure: 'coastal', status: 'operational',
    description: 'Second Milford Haven LNG import terminal at Waterston.',
  },
  {
    id: 'lng-isle-of-grain', name: 'Grain LNG Terminal', type: 'lng_terminal', lat: 51.4504, lon: 0.6826, region: 'south-east',
    owner: 'public', criticality: 5, capacity: { value: 15, unit: 'mtpa' }, floodExposure: 'coastal', status: 'operational',
    description: "Europe's largest LNG import terminal by storage, on the Thames/Medway estuary.",
  },

  // ─────────────────────── Rail freight hubs ───────────────────────
  {
    id: 'rail-dirft', name: 'Daventry International Rail Freight Terminal (DIRFT)', type: 'rail_hub', lat: 52.3497, lon: -1.1678, region: 'east-midlands',
    owner: 'public', criticality: 4, floodExposure: 'low', status: 'operational',
    description: 'Largest UK inland rail-freight and distribution park, at M1 J18.',
  },
  {
    id: 'rail-crewe-basford-hall', name: 'Crewe Basford Hall freight yard', type: 'rail_hub', lat: 53.075, lon: -2.428, region: 'north-west',
    owner: 'public', criticality: 4, floodExposure: 'low', status: 'operational',
    description: 'Principal West Coast Main Line freight marshalling and crew-change yard.',
  },
  {
    id: 'rail-doncaster-iport', name: 'iPort Doncaster rail terminal', type: 'rail_hub', lat: 53.4774, lon: -1.1115, region: 'yorkshire',
    owner: 'public', criticality: 3, floodExposure: 'low', status: 'operational',
    description: 'Intermodal terminal and logistics park beside the M18 at Rossington.',
  },
  {
    id: 'rail-hams-hall', name: 'Hams Hall rail freight terminal', type: 'rail_hub', lat: 52.5256, lon: -1.7027, region: 'west-midlands',
    owner: 'public', criticality: 3, floodExposure: 'low', status: 'operational',
    description: 'West Midlands intermodal terminal and distribution park near Coleshill.',
  },
  {
    id: 'rail-felixstowe-north', name: 'Felixstowe North Rail Terminal', type: 'rail_hub', lat: 51.9607, lon: 1.31, region: 'east',
    owner: 'public', criticality: 4, floodExposure: 'coastal', status: 'operational',
    description: "On-port rail terminal dispatching Felixstowe containers to inland terminals.",
  },
  {
    id: 'rail-wakefield-europort', name: 'Wakefield Europort', type: 'rail_hub', lat: 53.7147, lon: -1.4083, region: 'yorkshire',
    owner: 'public', criticality: 3, floodExposure: 'low', status: 'operational',
    description: 'Intermodal rail terminal and distribution park at M62 J31.',
  },

  // ───────────────────── Strategic road junctions ─────────────────────
  {
    id: 'road-m1-m6-catthorpe', name: 'Catthorpe Interchange (M1 J19 / M6 / A14)', type: 'road_junction', lat: 52.4008, lon: -1.1756, region: 'east-midlands',
    owner: 'public', criticality: 5, floodExposure: 'low', status: 'operational',
    description: "Junction of the M1, M6 and A14, the heart of the 'golden triangle' logistics area.",
  },
  {
    id: 'road-m25-m1-j21', name: 'M25 J21 / M1 J6A interchange', type: 'road_junction', lat: 51.715, lon: -0.382, region: 'east',
    owner: 'public', criticality: 5, floodExposure: 'low', status: 'operational',
    description: 'Where the M1 meets the M25, the main road route from the Midlands into London.',
  },
  {
    id: 'road-m62-m1-lofthouse', name: 'Lofthouse Interchange (M62 J29 / M1 J42)', type: 'road_junction', lat: 53.7306, lon: -1.5113, region: 'yorkshire',
    owner: 'public', criticality: 4, floodExposure: 'low', status: 'operational',
    description: 'Key West Yorkshire junction of the M62 trans-Pennine route and the M1.',
  },
  {
    id: 'road-m6-m42-coleshill', name: 'M6 / M42 interchange (Coleshill)', type: 'road_junction', lat: 52.485, lon: -1.711, region: 'west-midlands',
    owner: 'public', criticality: 5, floodExposure: 'low', status: 'operational',
    description: 'M6 J4–4A / M42 J7–8 complex east of Birmingham, serving the airport and NEC.',
  },
  {
    id: 'road-m4-m5-almondsbury', name: 'Almondsbury Interchange (M4 J20 / M5 J15)', type: 'road_junction', lat: 51.5514, lon: -2.5524, region: 'south-west',
    owner: 'public', criticality: 4, floodExposure: 'low', status: 'operational',
    description: 'Four-level M4/M5 junction north of Bristol.',
  },
  {
    id: 'road-m6-m62-croft', name: 'Croft Interchange (M6 J21A / M62 J10)', type: 'road_junction', lat: 53.426, lon: -2.562, region: 'north-west',
    owner: 'public', criticality: 4, floodExposure: 'low', status: 'operational',
    description: 'M6/M62 junction near Warrington linking Liverpool, Manchester and the north–south spine.',
  },
  {
    id: 'road-m18-j3-doncaster', name: 'M18 J3 (Doncaster / Great Yorkshire Way)', type: 'road_junction', lat: 53.4875, lon: -1.109, region: 'yorkshire',
    owner: 'public', criticality: 3, floodExposure: 'low', status: 'operational',
    description: 'M18 junction and Great Yorkshire Way link serving iPort Doncaster.',
  },

  // ───────────────────────── Logistics hubs ─────────────────────────
  {
    id: 'logistics-magna-park', name: 'Magna Park Lutterworth', type: 'logistics_hub', lat: 52.4611, lon: -1.2458, region: 'east-midlands',
    owner: 'public', criticality: 4, floodExposure: 'low', status: 'operational',
    description: "One of Europe's largest dedicated distribution parks, near M1 J20 and the A5.",
  },
  {
    id: 'logistics-east-midlands-gateway', name: 'East Midlands Gateway (SEGRO Logistics Park)', type: 'logistics_hub', lat: 52.8339, lon: -1.3008, region: 'east-midlands',
    owner: 'public', criticality: 4, floodExposure: 'low', status: 'operational',
    description: 'Logistics park with rail-freight terminal at M1 J24, beside East Midlands Airport.',
  },
  {
    id: 'logistics-trafford-park', name: 'Trafford Park', type: 'logistics_hub', lat: 53.47, lon: -2.325, region: 'north-west',
    owner: 'public', criticality: 4, floodExposure: 'surface', status: 'operational',
    description: 'Large Manchester industrial and distribution estate with Freightliner rail terminals.',
  },
  {
    id: 'logistics-thurrock', name: 'Thurrock logistics cluster (West Thurrock / Purfleet)', type: 'logistics_hub', lat: 51.4771, lon: 0.2721, region: 'east',
    owner: 'public', criticality: 4, floodExposure: 'coastal', status: 'operational',
    description: 'Thames-side warehousing cluster serving London from Tilbury and London Gateway.',
  },
  {
    id: 'logistics-avonmouth-severnside', name: 'Avonmouth & Severnside Enterprise Area', type: 'logistics_hub', lat: 51.528, lon: -2.67, region: 'south-west',
    owner: 'public', criticality: 3, floodExposure: 'coastal', status: 'operational',
    description: 'Large distribution zone on the Severn estuary levels behind tidal flood defences.',
  },

  // ─────────────────────── Major trauma centres ───────────────────────
  {
    id: 'hospital-st-marys-london', name: "St Mary's Hospital, Paddington", type: 'hospital', lat: 51.5172, lon: -0.1731, region: 'london',
    owner: 'public', criticality: 5, floodExposure: 'surface', status: 'operational',
    description: 'Major trauma centre for North West London (Imperial College Healthcare).',
  },
  {
    id: 'hospital-qe-birmingham', name: 'Queen Elizabeth Hospital Birmingham', type: 'hospital', lat: 52.4517, lon: -1.9431, region: 'west-midlands',
    owner: 'public', criticality: 5, floodExposure: 'low', status: 'operational',
    description: 'Major trauma centre and home of the Royal Centre for Defence Medicine.',
  },
  {
    id: 'hospital-leeds-general', name: 'Leeds General Infirmary', type: 'hospital', lat: 53.8021, lon: -1.5508, region: 'yorkshire',
    owner: 'public', criticality: 5, floodExposure: 'low', status: 'operational',
    description: 'Major trauma centre for West Yorkshire.',
  },
  {
    id: 'hospital-salford-royal', name: 'Salford Royal Hospital', type: 'hospital', lat: 53.4881, lon: -2.3214, region: 'north-west',
    owner: 'public', criticality: 5, floodExposure: 'low', status: 'operational',
    description: 'Major trauma centre for Greater Manchester.',
  },
  {
    id: 'hospital-southmead-bristol', name: 'Southmead Hospital, Bristol', type: 'hospital', lat: 51.4968, lon: -2.5916, region: 'south-west',
    owner: 'public', criticality: 5, floodExposure: 'low', status: 'operational',
    description: 'Adult major trauma centre for the Severn region.',
  },
  {
    id: 'hospital-royal-infirmary-edinburgh', name: 'Royal Infirmary of Edinburgh', type: 'hospital', lat: 55.9229, lon: -3.1366, region: 'scotland',
    owner: 'public', criticality: 5, floodExposure: 'low', status: 'operational',
    description: 'Major trauma centre for South East Scotland.',
  },
  {
    id: 'hospital-qeuh-glasgow', name: 'Queen Elizabeth University Hospital, Glasgow', type: 'hospital', lat: 55.8622, lon: -4.3411, region: 'scotland',
    owner: 'public', criticality: 5, floodExposure: 'low', status: 'operational',
    description: 'Major trauma centre for West of Scotland.',
  },
  {
    id: 'hospital-royal-victoria-belfast', name: 'Royal Victoria Hospital, Belfast', type: 'hospital', lat: 54.5948, lon: -5.9549, region: 'northern-ireland',
    owner: 'public', criticality: 5, floodExposure: 'low', status: 'operational',
    description: "Northern Ireland's regional trauma centre.",
  },
  {
    id: 'hospital-hull-royal', name: 'Hull Royal Infirmary', type: 'hospital', lat: 53.7443, lon: -0.3566, region: 'yorkshire',
    owner: 'public', criticality: 4, floodExposure: 'surface', status: 'operational',
    description: 'Major trauma centre for Hull and East Yorkshire, in a city hit by 2007 surface-water floods.',
  },
  {
    id: 'hospital-rvi-newcastle', name: 'Royal Victoria Infirmary, Newcastle', type: 'hospital', lat: 54.9795, lon: -1.6197, region: 'north-east',
    owner: 'public', criticality: 5, floodExposure: 'low', status: 'operational',
    description: 'Major trauma centre for the North East.',
  },
  {
    id: 'hospital-uhw-cardiff', name: 'University Hospital of Wales, Cardiff', type: 'hospital', lat: 51.5069, lon: -3.1895, region: 'wales',
    owner: 'public', criticality: 5, floodExposure: 'low', status: 'operational',
    description: 'Major trauma centre for South Wales.',
  },

  // ─────────────────────────── Water works ───────────────────────────
  {
    id: 'water-beckton-stw', name: 'Beckton Sewage Treatment Works', type: 'water_works', lat: 51.5207, lon: 0.0866, region: 'london',
    owner: 'public', criticality: 5, floodExposure: 'coastal', status: 'operational',
    description: "Thames Water's largest sewage works, treating wastewater for about four million Londoners.",
  },
  {
    id: 'water-mogden-stw', name: 'Mogden Sewage Treatment Works', type: 'water_works', lat: 51.463, lon: -0.3402, region: 'london',
    owner: 'public', criticality: 4, floodExposure: 'fluvial', status: 'operational',
    description: 'West London sewage works at Isleworth whose catchment includes Heathrow.',
  },
  {
    id: 'water-coppermills-wtw', name: 'Coppermills Water Treatment Works', type: 'water_works', lat: 51.5765, lon: -0.0461, region: 'london',
    owner: 'public', criticality: 5, floodExposure: 'fluvial', status: 'operational',
    description: 'Lee Valley works supplying drinking water to North and East London via the London Ring Main.',
  },
  {
    id: 'water-davyhulme-wwtw', name: 'Davyhulme Wastewater Treatment Works', type: 'water_works', lat: 53.4635, lon: -2.3723, region: 'north-west',
    owner: 'public', criticality: 4, floodExposure: 'fluvial', status: 'operational',
    description: "United Utilities' main Manchester wastewater works beside the Manchester Ship Canal.",
  },
  {
    id: 'water-frankley-wtw', name: 'Frankley Water Treatment Works', type: 'water_works', lat: 52.4198, lon: -1.9925, region: 'west-midlands',
    owner: 'public', criticality: 4, floodExposure: 'low', status: 'operational',
    description: 'Severn Trent works treating Elan Valley water for Birmingham.',
  },

  // ─────────────────────────── Data centres ───────────────────────────
  {
    id: 'dc-slough-trading-estate', name: 'Slough Trading Estate data-centre cluster', type: 'data_centre', lat: 51.5226, lon: -0.6275, region: 'south-east',
    owner: 'public', criticality: 5, floodExposure: 'low', status: 'operational',
    description: "One of Europe's densest data-centre clusters, west of London.",
  },
  {
    id: 'dc-telehouse-docklands', name: 'Telehouse Docklands campus', type: 'data_centre', lat: 51.5121, lon: -0.0015, region: 'london',
    owner: 'public', criticality: 5, floodExposure: 'coastal', status: 'operational',
    description: 'Major LINX internet-exchange campus on the defended tidal Thames floodplain.',
  },
  {
    id: 'dc-vantage-newport', name: 'Vantage Data Centres CWL1 (Newport, ex-NGD)', type: 'data_centre', lat: 51.5561, lon: -3.0405, region: 'wales',
    owner: 'public', criticality: 3, floodExposure: 'coastal', status: 'operational',
    description: 'Large hyperscale campus at Imperial Park on the Gwent Levels.',
  },

  // ═══════════════ Sample company: Albion Provisions Ltd (fictional) ═══════════════
  // Factories
  {
    id: 'albion-factory-hull', name: 'Albion Provisions Hull chilled-food factory (Hedon Road)', type: 'factory', lat: 53.747, lon: -0.29, region: 'yorkshire',
    owner: 'sample', criticality: 4, capacity: { value: 1800, unit: 't/week' }, floodExposure: 'coastal', status: 'operational',
    description: 'Fictional ready-meal plant on the Humber bank, exposed to tidal surges like December 2013.',
  },
  {
    id: 'albion-bakery-leeds', name: 'Albion Provisions Leeds bakery (Cross Green)', type: 'factory', lat: 53.785, lon: -1.512, region: 'yorkshire',
    owner: 'sample', criticality: 3, capacity: { value: 600, unit: 't/week' }, floodExposure: 'fluvial', status: 'operational',
    description: 'Fictional bread and morning-goods bakery near the River Aire in east Leeds.',
  },
  {
    id: 'albion-factory-burton', name: 'Albion Provisions Burton household-goods plant (Centrum 100)', type: 'factory', lat: 52.8008, lon: -1.6594, region: 'west-midlands',
    owner: 'sample', criticality: 3, capacity: { value: 900, unit: 't/week' }, floodExposure: 'low', status: 'operational',
    description: 'Fictional detergent and cleaning-products plant in Burton upon Trent.',
  },
  // Suppliers
  {
    id: 'albion-sup-fenland-veg', name: 'Fenland Fresh Growers (Spalding)', type: 'supplier', lat: 52.809, lon: -0.142, region: 'east-midlands',
    owner: 'sample', criticality: 3, floodExposure: 'fluvial', status: 'operational',
    description: 'Fictional Lincolnshire vegetable packer on low-lying Fenland.',
  },
  {
    id: 'albion-sup-selby-flour', name: 'Ouse Valley Flour Mill (Selby)', type: 'supplier', lat: 53.776, lon: -1.064, region: 'yorkshire',
    owner: 'sample', criticality: 3, floodExposure: 'fluvial', status: 'operational',
    description: 'Fictional flour mill in Selby, a town with a long River Ouse flood history.',
  },
  {
    id: 'albion-sup-warrington-packaging', name: 'Mersey Packaging (Birchwood, Warrington)', type: 'supplier', lat: 53.4252, lon: -2.5195, region: 'north-west',
    owner: 'sample', criticality: 2, floodExposure: 'low', status: 'operational',
    description: 'Fictional food-grade trays, films and cartons supplier.',
  },
  {
    id: 'albion-sup-runcorn-surfactants', name: 'Halton Surfactants (Weston Point, Runcorn)', type: 'supplier', lat: 53.3254, lon: -2.7534, region: 'north-west',
    owner: 'sample', criticality: 3, floodExposure: 'coastal', status: 'operational',
    description: 'Fictional chemicals supplier on the Mersey estuary providing detergent feedstock.',
  },
  {
    id: 'albion-sup-ningbo-household', name: 'Overseas household-goods supplier (Ningbo, China) via Felixstowe', type: 'supplier',
    lat: 51.958, lon: 1.305, region: 'east',
    owner: 'sample', criticality: 3, floodExposure: 'coastal', status: 'operational',
    description: 'Fictional Chinese maker of sponges, cloths and dispensers; modelled at its GB entry port, Felixstowe.',
  },
  {
    id: 'albion-sup-rotterdam-frozen', name: 'Overseas frozen-veg & dairy supplier (Rotterdam, Netherlands) via Immingham', type: 'supplier',
    lat: 53.631, lon: -0.196, region: 'yorkshire',
    owner: 'sample', criticality: 3, floodExposure: 'coastal', status: 'operational',
    description: 'Fictional Dutch frozen-vegetable and dairy exporter; modelled at its GB entry port, Immingham.',
  },
  // Distribution centres
  {
    id: 'albion-dc-magna-park', name: 'Albion Provisions DC – Magna Park Lutterworth', type: 'distribution_centre', lat: 52.449, lon: -1.241, region: 'east-midlands',
    owner: 'sample', criticality: 4, capacity: { value: 60000, unit: 'pallets' }, floodExposure: 'low', status: 'operational',
    description: 'Fictional national DC for ambient and household lines.',
  },
  {
    id: 'albion-dc-dirft', name: 'Albion Provisions DC – DIRFT Daventry', type: 'distribution_centre', lat: 52.353, lon: -1.172, region: 'east-midlands',
    owner: 'sample', criticality: 4, capacity: { value: 45000, unit: 'pallets' }, floodExposure: 'low', status: 'operational',
    description: 'Fictional rail-connected DC serving London and the South.',
  },
  {
    id: 'albion-dc-doncaster', name: 'Albion Provisions DC – iPort Doncaster', type: 'distribution_centre', lat: 53.48, lon: -1.105, region: 'yorkshire',
    owner: 'sample', criticality: 4, capacity: { value: 40000, unit: 'pallets' }, floodExposure: 'low', status: 'operational',
    description: 'Fictional chilled and ambient DC for the North and Scotland.',
  },
  {
    id: 'albion-dc-avonmouth', name: 'Albion Provisions DC – Central Park Avonmouth', type: 'distribution_centre', lat: 51.537, lon: -2.65, region: 'south-west',
    owner: 'sample', criticality: 3, capacity: { value: 25000, unit: 'pallets' }, floodExposure: 'coastal', status: 'operational',
    description: 'Fictional South West and South Wales DC on the Severnside levels.',
  },
  // Store clusters
  {
    id: 'albion-stores-london', name: 'Albion store cluster – Greater London', type: 'store_cluster', lat: 51.5072, lon: -0.1276, region: 'london',
    owner: 'sample', criticality: 3, capacity: { value: 140, unit: 'stores' }, floodExposure: 'surface', status: 'operational',
    description: 'Fictional cluster of convenience and grocery stockists in Greater London.',
  },
  {
    id: 'albion-stores-manchester', name: 'Albion store cluster – Greater Manchester', type: 'store_cluster', lat: 53.4808, lon: -2.2426, region: 'north-west',
    owner: 'sample', criticality: 2, capacity: { value: 70, unit: 'stores' }, floodExposure: 'surface', status: 'operational',
    description: 'Fictional cluster of stockists across Greater Manchester.',
  },
  {
    id: 'albion-stores-birmingham', name: 'Albion store cluster – Birmingham & Black Country', type: 'store_cluster', lat: 52.4862, lon: -1.8904, region: 'west-midlands',
    owner: 'sample', criticality: 2, capacity: { value: 65, unit: 'stores' }, floodExposure: 'low', status: 'operational',
    description: 'Fictional cluster of stockists across the West Midlands conurbation.',
  },
  {
    id: 'albion-stores-leeds', name: 'Albion store cluster – Leeds & West Yorkshire', type: 'store_cluster', lat: 53.7997, lon: -1.5492, region: 'yorkshire',
    owner: 'sample', criticality: 2, capacity: { value: 55, unit: 'stores' }, floodExposure: 'fluvial', status: 'operational',
    description: 'Fictional cluster of stockists across West Yorkshire.',
  },
  {
    id: 'albion-stores-bristol', name: 'Albion store cluster – Bristol & Bath', type: 'store_cluster', lat: 51.4545, lon: -2.5879, region: 'south-west',
    owner: 'sample', criticality: 2, capacity: { value: 40, unit: 'stores' }, floodExposure: 'low', status: 'operational',
    description: 'Fictional cluster of stockists across the West of England.',
  },
  {
    id: 'albion-stores-glasgow', name: 'Albion store cluster – Glasgow & Clyde', type: 'store_cluster', lat: 55.8642, lon: -4.2518, region: 'scotland',
    owner: 'sample', criticality: 2, capacity: { value: 45, unit: 'stores' }, floodExposure: 'low', status: 'operational',
    description: 'Fictional cluster of stockists across west-central Scotland.',
  },
];

type EdgeOpts = Pick<UkTwinEdge, 'leadTimeHours' | 'alternatives'>;

function edge(from: string, to: string, kind: UkEdgeKind, dependency: number, opts: EdgeOpts = {}): UkTwinEdge {
  return { id: `${from}--${kind}--${to}`, from, to, kind, dependency, ...opts };
}

export const UK_TWIN_EDGES: UkTwinEdge[] = [
  // ─────────────── Gas & LNG terminals → gas-fired stations ───────────────
  edge('gas-bacton', 'power-grain', 'supplies_gas', 0.4, { alternatives: ['lng-isle-of-grain'] }),
  edge('lng-isle-of-grain', 'power-grain', 'supplies_gas', 0.6, { alternatives: ['gas-bacton'] }),
  edge('lng-south-hook', 'power-pembroke', 'supplies_gas', 0.7, { alternatives: ['lng-dragon'] }),
  edge('lng-dragon', 'power-pembroke', 'supplies_gas', 0.3, { alternatives: ['lng-south-hook'] }),
  edge('gas-easington', 'power-saltend', 'supplies_gas', 0.7, { alternatives: ['gas-bacton'] }),
  edge('gas-easington', 'power-keadby-2', 'supplies_gas', 0.6, { alternatives: ['gas-bacton'] }),
  edge('gas-easington', 'power-staythorpe', 'supplies_gas', 0.45, { alternatives: ['gas-bacton', 'gas-st-fergus'] }),
  edge('gas-bacton', 'power-staythorpe', 'supplies_gas', 0.35, { alternatives: ['gas-easington'] }),
  edge('gas-easington', 'power-west-burton-b', 'supplies_gas', 0.5, { alternatives: ['gas-bacton'] }),
  edge('gas-bacton', 'power-didcot-b', 'supplies_gas', 0.5, { alternatives: ['lng-isle-of-grain', 'lng-south-hook'] }),
  edge('lng-south-hook', 'power-didcot-b', 'supplies_gas', 0.3, { alternatives: ['gas-bacton'] }),
  edge('gas-st-fergus', 'power-peterhead', 'supplies_gas', 0.8),
  edge('gas-st-fergus', 'power-connahs-quay', 'supplies_gas', 0.4, { alternatives: ['lng-south-hook'] }),
  edge('lng-south-hook', 'power-connahs-quay', 'supplies_gas', 0.4, { alternatives: ['gas-st-fergus'] }),
  // NI gas arrives via Moffat and the Scotland–NI pipeline, fed mainly from St Fergus.
  edge('gas-st-fergus', 'power-ballylumford', 'supplies_gas', 0.6),

  // ─────────────── Power: London, South East & East ───────────────
  edge('power-didcot-b', 'airport-heathrow', 'powers', 0.35, { alternatives: ['power-grain', 'ic-ifa2-daedalus'] }),
  edge('ic-ifa-sellindge', 'airport-gatwick', 'powers', 0.35, { alternatives: ['ic-ifa2-daedalus', 'power-grain'] }),
  edge('power-sizewell-b', 'airport-stansted', 'powers', 0.3, { alternatives: ['power-grain', 'power-east-anglia-one-bramford'] }),
  edge('power-grain', 'hospital-st-marys-london', 'powers', 0.3, { alternatives: ['ic-britned-grain', 'ic-ifa-sellindge'] }),
  edge('power-grain', 'water-beckton-stw', 'powers', 0.4, { alternatives: ['ic-britned-grain'] }),
  edge('ic-britned-grain', 'water-beckton-stw', 'powers', 0.25, { alternatives: ['power-grain'] }),
  edge('power-didcot-b', 'water-mogden-stw', 'powers', 0.35, { alternatives: ['power-grain'] }),
  edge('ic-ifa-sellindge', 'water-coppermills-wtw', 'powers', 0.3, { alternatives: ['power-grain', 'power-sizewell-b'] }),
  edge('power-grain', 'dc-telehouse-docklands', 'powers', 0.35, { alternatives: ['ic-britned-grain', 'ic-ifa-sellindge'] }),
  edge('ic-nemo-richborough', 'dc-telehouse-docklands', 'powers', 0.25, { alternatives: ['ic-eleclink-folkestone'] }),
  edge('power-didcot-b', 'dc-slough-trading-estate', 'powers', 0.45, { alternatives: ['power-grain', 'ic-ifa2-daedalus'] }),
  edge('ic-ifa2-daedalus', 'port-southampton', 'powers', 0.4, { alternatives: ['power-didcot-b'] }),
  edge('ic-eleclink-folkestone', 'port-dover', 'powers', 0.4, { alternatives: ['ic-ifa-sellindge', 'ic-nemo-richborough'] }),
  edge('power-grain', 'port-london-gateway', 'powers', 0.35, { alternatives: ['ic-britned-grain', 'power-sizewell-b'] }),
  edge('power-grain', 'port-tilbury', 'powers', 0.35, { alternatives: ['ic-britned-grain'] }),
  edge('power-sizewell-b', 'port-felixstowe', 'powers', 0.45, { alternatives: ['power-east-anglia-one-bramford'] }),
  edge('power-east-anglia-one-bramford', 'port-felixstowe', 'powers', 0.25, { alternatives: ['power-sizewell-b'] }),
  edge('power-grain', 'logistics-thurrock', 'powers', 0.4, { alternatives: ['ic-britned-grain'] }),

  // ─────────────── Power: Midlands ───────────────
  edge('power-staythorpe', 'airport-east-midlands', 'powers', 0.4, { alternatives: ['power-west-burton-b'] }),
  edge('power-staythorpe', 'logistics-east-midlands-gateway', 'powers', 0.4, { alternatives: ['power-west-burton-b', 'ic-viking-bicker-fen'] }),
  edge('power-west-burton-b', 'logistics-magna-park', 'powers', 0.35, { alternatives: ['power-staythorpe'] }),
  edge('power-west-burton-b', 'rail-dirft', 'powers', 0.3, { alternatives: ['power-staythorpe', 'power-didcot-b'] }),
  edge('power-staythorpe', 'hospital-qe-birmingham', 'powers', 0.3, { alternatives: ['power-west-burton-b', 'power-connahs-quay'] }),
  edge('power-west-burton-b', 'water-frankley-wtw', 'powers', 0.3, { alternatives: ['power-staythorpe'] }),
  edge('power-staythorpe', 'airport-birmingham', 'powers', 0.3, { alternatives: ['power-west-burton-b'] }),
  edge('power-west-burton-b', 'rail-hams-hall', 'powers', 0.3, { alternatives: ['power-staythorpe'] }),
  edge('power-west-burton-b', 'albion-factory-burton', 'powers', 0.4, { alternatives: ['power-staythorpe'] }),
  edge('power-staythorpe', 'albion-dc-magna-park', 'powers', 0.35, { alternatives: ['power-west-burton-b', 'ic-viking-bicker-fen'] }),
  edge('power-staythorpe', 'albion-dc-dirft', 'powers', 0.35, { alternatives: ['power-west-burton-b', 'power-didcot-b'] }),
  edge('ic-viking-bicker-fen', 'albion-sup-fenland-veg', 'powers', 0.3, { alternatives: ['power-west-burton-b'] }),

  // ─────────────── Power: Yorkshire & Humber ───────────────
  edge('power-saltend', 'albion-factory-hull', 'powers', 0.45, { alternatives: ['power-hornsea-killingholme', 'power-keadby-2'] }),
  edge('power-hornsea-killingholme', 'albion-factory-hull', 'powers', 0.2, { alternatives: ['power-saltend'] }),
  edge('power-hornsea-killingholme', 'port-immingham', 'powers', 0.35, { alternatives: ['power-keadby-2', 'power-saltend'] }),
  edge('power-saltend', 'port-hull', 'powers', 0.45, { alternatives: ['power-hornsea-killingholme', 'power-drax'] }),
  edge('power-saltend', 'hospital-hull-royal', 'powers', 0.4, { alternatives: ['power-drax', 'power-keadby-2'] }),
  edge('power-drax', 'hospital-leeds-general', 'powers', 0.4, { alternatives: ['power-keadby-2', 'power-west-burton-b'] }),
  edge('power-drax', 'albion-bakery-leeds', 'powers', 0.45, { alternatives: ['power-keadby-2'] }),
  edge('power-drax', 'rail-doncaster-iport', 'powers', 0.35, { alternatives: ['power-keadby-2', 'power-west-burton-b'] }),
  edge('power-keadby-2', 'albion-dc-doncaster', 'powers', 0.4, { alternatives: ['power-drax', 'power-west-burton-b'] }),
  edge('power-drax', 'rail-wakefield-europort', 'powers', 0.35, { alternatives: ['power-keadby-2'] }),
  edge('power-drax', 'albion-sup-selby-flour', 'powers', 0.5, { alternatives: ['power-keadby-2'] }),

  // ─────────────── Power: North West & North Wales ───────────────
  edge('power-heysham-2', 'port-liverpool', 'powers', 0.35, { alternatives: ['power-heysham-1', 'power-connahs-quay'] }),
  edge('ic-ewic-shotton', 'port-liverpool', 'powers', 0.15, { alternatives: ['power-connahs-quay'] }),
  edge('power-heysham-1', 'airport-manchester', 'powers', 0.3, { alternatives: ['power-heysham-2', 'power-connahs-quay'] }),
  edge('power-heysham-2', 'hospital-salford-royal', 'powers', 0.35, { alternatives: ['power-connahs-quay'] }),
  edge('power-connahs-quay', 'water-davyhulme-wwtw', 'powers', 0.35, { alternatives: ['power-heysham-2'] }),
  edge('power-heysham-1', 'logistics-trafford-park', 'powers', 0.3, { alternatives: ['power-connahs-quay'] }),
  edge('power-connahs-quay', 'rail-crewe-basford-hall', 'powers', 0.35, { alternatives: ['power-heysham-2'] }),
  edge('power-heysham-2', 'albion-sup-warrington-packaging', 'powers', 0.4, { alternatives: ['power-connahs-quay'] }),
  edge('power-connahs-quay', 'albion-sup-runcorn-surfactants', 'powers', 0.5, { alternatives: ['power-heysham-1', 'ic-ewic-shotton'] }),

  // ─────────────── Power: North East ───────────────
  edge('power-hartlepool', 'port-teesport', 'powers', 0.45, { alternatives: ['ic-nsl-blyth'] }),
  edge('power-hartlepool', 'hospital-rvi-newcastle', 'powers', 0.35, { alternatives: ['ic-nsl-blyth'] }),
  edge('ic-nsl-blyth', 'hospital-rvi-newcastle', 'powers', 0.3, { alternatives: ['power-hartlepool'] }),

  // ─────────────── Power: Scotland ───────────────
  edge('power-torness', 'hospital-royal-infirmary-edinburgh', 'powers', 0.45, { alternatives: ['power-peterhead'] }),
  edge('power-torness', 'airport-edinburgh', 'powers', 0.4, { alternatives: ['power-peterhead'] }),
  edge('power-torness', 'port-grangemouth', 'powers', 0.35, { alternatives: ['power-peterhead'] }),
  edge('power-torness', 'hospital-qeuh-glasgow', 'powers', 0.35, { alternatives: ['power-peterhead'] }),
  edge('power-peterhead', 'airport-glasgow', 'powers', 0.3, { alternatives: ['power-torness'] }),

  // ─────────────── Power: South Wales & South West ───────────────
  edge('power-pembroke', 'port-milford-haven', 'powers', 0.5, { alternatives: ['ic-greenlink-pembroke'] }),
  edge('ic-greenlink-pembroke', 'port-milford-haven', 'powers', 0.2, { alternatives: ['power-pembroke'] }),
  edge('power-pembroke', 'hospital-uhw-cardiff', 'powers', 0.35, { alternatives: ['power-didcot-b', 'power-connahs-quay'] }),
  edge('power-pembroke', 'dc-vantage-newport', 'powers', 0.45, { alternatives: ['power-didcot-b'] }),
  edge('power-didcot-b', 'port-bristol-avonmouth', 'powers', 0.3, { alternatives: ['power-pembroke'] }),
  edge('power-pembroke', 'hospital-southmead-bristol', 'powers', 0.3, { alternatives: ['power-didcot-b'] }),
  edge('power-didcot-b', 'albion-dc-avonmouth', 'powers', 0.35, { alternatives: ['power-pembroke'] }),
  edge('power-didcot-b', 'logistics-avonmouth-severnside', 'powers', 0.3, { alternatives: ['power-pembroke'] }),

  // ─────────────── Power: Northern Ireland ───────────────
  edge('power-ballylumford', 'port-belfast', 'powers', 0.55, { alternatives: ['ic-moyle-auchencrosh'] }),
  edge('power-ballylumford', 'hospital-royal-victoria-belfast', 'powers', 0.55, { alternatives: ['ic-moyle-auchencrosh'] }),
  edge('ic-moyle-auchencrosh', 'hospital-royal-victoria-belfast', 'powers', 0.2, { alternatives: ['power-ballylumford'] }),

  // ─────────────── Water → hospitals / airport / data centre ───────────────
  edge('water-coppermills-wtw', 'hospital-st-marys-london', 'depends_on', 0.4),
  edge('water-beckton-stw', 'hospital-st-marys-london', 'depends_on', 0.25),
  edge('water-frankley-wtw', 'hospital-qe-birmingham', 'depends_on', 0.5),
  edge('water-davyhulme-wwtw', 'hospital-salford-royal', 'depends_on', 0.3),
  edge('water-mogden-stw', 'airport-heathrow', 'depends_on', 0.25),
  edge('water-coppermills-wtw', 'dc-telehouse-docklands', 'depends_on', 0.3),

  // ─────────────── Airports → hospitals (medical supply) / air freight ───────────────
  edge('airport-heathrow', 'hospital-st-marys-london', 'serves', 0.1, { alternatives: ['airport-gatwick', 'airport-stansted'] }),
  edge('airport-east-midlands', 'hospital-qe-birmingham', 'serves', 0.1, { alternatives: ['airport-birmingham'] }),
  edge('airport-east-midlands', 'hospital-leeds-general', 'serves', 0.08, { alternatives: ['airport-manchester'] }),
  edge('airport-manchester', 'hospital-salford-royal', 'serves', 0.1, { alternatives: ['airport-east-midlands'] }),
  edge('airport-edinburgh', 'hospital-royal-infirmary-edinburgh', 'serves', 0.1, { alternatives: ['airport-glasgow'] }),
  edge('airport-glasgow', 'hospital-qeuh-glasgow', 'serves', 0.1, { alternatives: ['airport-edinburgh'] }),
  edge('airport-east-midlands', 'logistics-east-midlands-gateway', 'serves', 0.25),

  // ─────────────── Road junctions → public hubs ───────────────
  edge('road-m1-m6-catthorpe', 'logistics-magna-park', 'depends_on', 0.5, { alternatives: ['road-m6-m42-coleshill'] }),
  edge('road-m1-m6-catthorpe', 'rail-dirft', 'depends_on', 0.5, { alternatives: ['road-m6-m42-coleshill'] }),
  edge('road-m1-m6-catthorpe', 'port-felixstowe', 'depends_on', 0.25, { alternatives: ['road-m25-m1-j21'] }),
  edge('road-m6-m42-coleshill', 'rail-hams-hall', 'depends_on', 0.5, { alternatives: ['road-m1-m6-catthorpe'] }),
  edge('road-m6-m42-coleshill', 'airport-birmingham', 'depends_on', 0.3),
  edge('road-m62-m1-lofthouse', 'rail-wakefield-europort', 'depends_on', 0.45),
  edge('road-m6-m62-croft', 'port-liverpool', 'depends_on', 0.3),
  edge('road-m6-m62-croft', 'logistics-trafford-park', 'depends_on', 0.3),
  edge('road-m4-m5-almondsbury', 'port-bristol-avonmouth', 'depends_on', 0.45),
  edge('road-m4-m5-almondsbury', 'logistics-avonmouth-severnside', 'depends_on', 0.5),
  edge('road-m18-j3-doncaster', 'rail-doncaster-iport', 'depends_on', 0.5, { alternatives: ['road-m62-m1-lofthouse'] }),

  // ─────────────── Ports → rail hubs → inland terminals ───────────────
  edge('port-felixstowe', 'rail-felixstowe-north', 'transports', 0.9, { leadTimeHours: 2 }),
  edge('rail-felixstowe-north', 'rail-dirft', 'transports', 0.35, { leadTimeHours: 8, alternatives: ['rail-hams-hall'] }),
  edge('rail-felixstowe-north', 'rail-hams-hall', 'transports', 0.3, { leadTimeHours: 9, alternatives: ['rail-dirft'] }),
  edge('rail-felixstowe-north', 'rail-doncaster-iport', 'transports', 0.3, { leadTimeHours: 9, alternatives: ['rail-wakefield-europort'] }),
  edge('port-southampton', 'rail-hams-hall', 'transports', 0.25, { leadTimeHours: 6, alternatives: ['rail-felixstowe-north'] }),
  edge('port-southampton', 'rail-wakefield-europort', 'transports', 0.2, { leadTimeHours: 8, alternatives: ['rail-felixstowe-north'] }),
  edge('port-london-gateway', 'rail-doncaster-iport', 'transports', 0.2, { leadTimeHours: 7, alternatives: ['rail-felixstowe-north'] }),
  edge('rail-crewe-basford-hall', 'logistics-trafford-park', 'transports', 0.15, { leadTimeHours: 2 }),

  // ─────────────── Ports → logistics hubs ───────────────
  edge('port-tilbury', 'logistics-thurrock', 'ships_via', 0.4, { leadTimeHours: 0.5, alternatives: ['port-london-gateway'] }),
  edge('port-london-gateway', 'logistics-thurrock', 'ships_via', 0.4, { leadTimeHours: 0.75, alternatives: ['port-tilbury'] }),
  edge('port-liverpool', 'logistics-trafford-park', 'ships_via', 0.35, { leadTimeHours: 1.5, alternatives: ['port-felixstowe'] }),
  edge('port-felixstowe', 'logistics-magna-park', 'ships_via', 0.25, { leadTimeHours: 3.5, alternatives: ['port-southampton', 'port-london-gateway'] }),
  edge('port-bristol-avonmouth', 'logistics-avonmouth-severnside', 'ships_via', 0.45, { leadTimeHours: 0.5, alternatives: ['port-southampton'] }),

  // ═══════════════ Albion Provisions supply chain (fictional) ═══════════════
  // Overseas suppliers enter GB through ports (ocean transit in leadTimeHours).
  edge('port-felixstowe', 'albion-sup-ningbo-household', 'ships_via', 0.85, {
    leadTimeHours: 840, alternatives: ['port-london-gateway', 'port-southampton'],
  }),
  edge('port-immingham', 'albion-sup-rotterdam-frozen', 'ships_via', 0.8, { leadTimeHours: 16, alternatives: ['port-hull'] }),
  edge('port-hull', 'albion-factory-hull', 'ships_via', 0.15, { leadTimeHours: 0.5, alternatives: ['port-immingham'] }),

  // Suppliers → factories (and one direct-to-DC import flow)
  edge('albion-sup-fenland-veg', 'albion-factory-hull', 'supplies', 0.45, { leadTimeHours: 3, alternatives: ['albion-sup-rotterdam-frozen'] }),
  edge('albion-sup-rotterdam-frozen', 'albion-factory-hull', 'supplies', 0.3, { leadTimeHours: 1.5, alternatives: ['albion-sup-fenland-veg'] }),
  edge('albion-sup-selby-flour', 'albion-factory-hull', 'supplies', 0.2, { leadTimeHours: 1.5 }),
  edge('albion-sup-selby-flour', 'albion-bakery-leeds', 'supplies', 0.7, { leadTimeHours: 1 }),
  edge('albion-sup-warrington-packaging', 'albion-factory-hull', 'supplies', 0.25, { leadTimeHours: 3 }),
  edge('albion-sup-warrington-packaging', 'albion-bakery-leeds', 'supplies', 0.3, { leadTimeHours: 2 }),
  edge('albion-sup-warrington-packaging', 'albion-factory-burton', 'supplies', 0.3, { leadTimeHours: 2 }),
  edge('albion-sup-runcorn-surfactants', 'albion-factory-burton', 'supplies', 0.6, { leadTimeHours: 2 }),
  edge('albion-sup-ningbo-household', 'albion-factory-burton', 'supplies', 0.35, { leadTimeHours: 5 }),
  edge('albion-sup-ningbo-household', 'albion-dc-magna-park', 'supplies', 0.2, { leadTimeHours: 4 }),

  // Factories → DCs. Alternatives = other DCs that could cover this flow by stock transfer.
  edge('albion-factory-hull', 'albion-dc-doncaster', 'transports', 0.5, { leadTimeHours: 1.5, alternatives: ['albion-dc-magna-park'] }),
  edge('albion-factory-hull', 'albion-dc-magna-park', 'transports', 0.35, { leadTimeHours: 3.5, alternatives: ['albion-dc-doncaster', 'albion-dc-dirft'] }),
  edge('albion-factory-hull', 'albion-dc-dirft', 'transports', 0.25, { leadTimeHours: 3.5, alternatives: ['albion-dc-magna-park'] }),
  edge('albion-factory-hull', 'albion-dc-avonmouth', 'transports', 0.3, { leadTimeHours: 5, alternatives: ['albion-dc-dirft'] }),
  edge('albion-bakery-leeds', 'albion-dc-doncaster', 'transports', 0.4, { leadTimeHours: 1, alternatives: ['albion-dc-magna-park'] }),
  edge('albion-bakery-leeds', 'albion-dc-magna-park', 'transports', 0.25, { leadTimeHours: 2.5, alternatives: ['albion-dc-dirft'] }),
  edge('albion-factory-burton', 'albion-dc-magna-park', 'transports', 0.35, { leadTimeHours: 1, alternatives: ['albion-dc-dirft'] }),
  edge('albion-factory-burton', 'albion-dc-dirft', 'transports', 0.45, { leadTimeHours: 1.5, alternatives: ['albion-dc-magna-park'] }),
  edge('albion-factory-burton', 'albion-dc-avonmouth', 'transports', 0.3, { leadTimeHours: 2.5, alternatives: ['albion-dc-dirft'] }),

  // Ports → DCs (imported ambient goods)
  edge('port-felixstowe', 'albion-dc-magna-park', 'ships_via', 0.3, { leadTimeHours: 3.5, alternatives: ['port-london-gateway', 'port-southampton'] }),
  edge('port-london-gateway', 'albion-dc-dirft', 'ships_via', 0.3, { leadTimeHours: 2.5, alternatives: ['port-felixstowe', 'port-southampton'] }),
  edge('port-immingham', 'albion-dc-doncaster', 'ships_via', 0.25, { leadTimeHours: 1, alternatives: ['port-hull'] }),
  edge('port-bristol-avonmouth', 'albion-dc-avonmouth', 'ships_via', 0.25, { leadTimeHours: 0.5, alternatives: ['port-southampton'] }),

  // DCs → store clusters
  edge('albion-dc-dirft', 'albion-stores-london', 'transports', 0.5, { leadTimeHours: 2.5, alternatives: ['albion-dc-magna-park'] }),
  edge('albion-dc-magna-park', 'albion-stores-london', 'transports', 0.3, { leadTimeHours: 3, alternatives: ['albion-dc-dirft'] }),
  edge('albion-dc-magna-park', 'albion-stores-birmingham', 'transports', 0.55, { leadTimeHours: 1, alternatives: ['albion-dc-dirft'] }),
  edge('albion-dc-dirft', 'albion-stores-birmingham', 'transports', 0.3, { leadTimeHours: 1.25, alternatives: ['albion-dc-magna-park'] }),
  edge('albion-dc-doncaster', 'albion-stores-leeds', 'transports', 0.65, { leadTimeHours: 1, alternatives: ['albion-dc-magna-park'] }),
  edge('albion-dc-doncaster', 'albion-stores-manchester', 'transports', 0.45, { leadTimeHours: 2, alternatives: ['albion-dc-magna-park'] }),
  edge('albion-dc-magna-park', 'albion-stores-manchester', 'transports', 0.3, { leadTimeHours: 2.5, alternatives: ['albion-dc-doncaster'] }),
  edge('albion-dc-avonmouth', 'albion-stores-bristol', 'transports', 0.7, { leadTimeHours: 0.75, alternatives: ['albion-dc-dirft'] }),
  edge('albion-dc-doncaster', 'albion-stores-glasgow', 'transports', 0.6, { leadTimeHours: 5.5, alternatives: ['albion-dc-magna-park'] }),
  edge('albion-dc-magna-park', 'albion-stores-glasgow', 'transports', 0.25, { leadTimeHours: 6.5, alternatives: ['albion-dc-doncaster'] }),

  // DCs / sites → road junctions and host logistics parks
  edge('road-m1-m6-catthorpe', 'albion-dc-magna-park', 'depends_on', 0.6, { alternatives: ['road-m6-m42-coleshill'] }),
  edge('logistics-magna-park', 'albion-dc-magna-park', 'depends_on', 0.4, { alternatives: ['logistics-east-midlands-gateway'] }),
  edge('road-m1-m6-catthorpe', 'albion-dc-dirft', 'depends_on', 0.6, { alternatives: ['road-m6-m42-coleshill', 'road-m25-m1-j21'] }),
  edge('rail-dirft', 'albion-dc-dirft', 'depends_on', 0.35, { alternatives: ['logistics-magna-park'] }),
  edge('road-m18-j3-doncaster', 'albion-dc-doncaster', 'depends_on', 0.6, { alternatives: ['road-m62-m1-lofthouse'] }),
  edge('rail-doncaster-iport', 'albion-dc-doncaster', 'depends_on', 0.35, { alternatives: ['logistics-east-midlands-gateway'] }),
  edge('road-m4-m5-almondsbury', 'albion-dc-avonmouth', 'depends_on', 0.6),
  edge('logistics-avonmouth-severnside', 'albion-dc-avonmouth', 'depends_on', 0.4),
  edge('road-m25-m1-j21', 'albion-stores-london', 'depends_on', 0.4),
  edge('road-m6-m62-croft', 'albion-stores-manchester', 'depends_on', 0.3, { alternatives: ['road-m62-m1-lofthouse'] }),
  edge('road-m62-m1-lofthouse', 'albion-stores-leeds', 'depends_on', 0.4, { alternatives: ['road-m18-j3-doncaster'] }),
  edge('road-m6-m42-coleshill', 'albion-stores-birmingham', 'depends_on', 0.35, { alternatives: ['road-m1-m6-catthorpe'] }),
  edge('road-m4-m5-almondsbury', 'albion-stores-bristol', 'depends_on', 0.35),
  edge('road-m62-m1-lofthouse', 'albion-bakery-leeds', 'depends_on', 0.35, { alternatives: ['road-m18-j3-doncaster'] }),
  edge('road-m6-m62-croft', 'albion-sup-warrington-packaging', 'depends_on', 0.35),
  edge('road-m6-m42-coleshill', 'albion-factory-burton', 'depends_on', 0.3, { alternatives: ['road-m1-m6-catthorpe'] }),

  // IT: warehouse-management system hosted in Slough, with Newport as DR site
  edge('dc-telehouse-docklands', 'dc-slough-trading-estate', 'depends_on', 0.2, { alternatives: ['dc-vantage-newport'] }),
  edge('dc-slough-trading-estate', 'albion-dc-magna-park', 'depends_on', 0.25, { alternatives: ['dc-vantage-newport'] }),
  edge('dc-slough-trading-estate', 'albion-dc-dirft', 'depends_on', 0.25, { alternatives: ['dc-vantage-newport'] }),
  edge('dc-slough-trading-estate', 'albion-dc-doncaster', 'depends_on', 0.25, { alternatives: ['dc-vantage-newport'] }),
  edge('dc-slough-trading-estate', 'albion-dc-avonmouth', 'depends_on', 0.25, { alternatives: ['dc-vantage-newport'] }),
];
