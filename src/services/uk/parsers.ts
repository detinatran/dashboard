// Pure parsers for the CrisisTwin UK live sources. Kept free of fetch/DOM so
// tests/uk-crisis-sources.test.mts can exercise them under plain Node.

export type UkAlertSource = 'ea-floods' | 'met-office' | 'neso-grid' | 'tfl' | 'bgs';
export type UkAlertCategory = 'flood' | 'weather' | 'grid' | 'transport' | 'seismic';
export type UkAlertSeverity = 'critical' | 'high' | 'medium' | 'low';

export interface UkAlert {
  id: string;
  source: UkAlertSource;
  category: UkAlertCategory;
  severity: UkAlertSeverity;
  title: string;
  detail: string;
  /** Epoch ms the source raised or last changed the alert. */
  time: number;
  lat?: number;
  lon?: number;
  url?: string;
}

export const SEVERITY_RANK: Record<UkAlertSeverity, number> = { critical: 4, high: 3, medium: 2, low: 1 };

export function compareAlerts(a: UkAlert, b: UkAlert): number {
  return SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || b.time - a.time;
}

function toMs(value: unknown): number {
  const ms = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(ms) ? ms : 0;
}

function clip(text: string, max = 280): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max).replace(/\s+\S*$/, '')}…`;
}

// ---------------------------------------------------------------------------
// Environment Agency flood-monitoring (England)
// https://environment.data.gov.uk/flood-monitoring/doc/reference#flood-warnings
// ---------------------------------------------------------------------------

export interface EaFloodItem {
  floodAreaID?: string;
  description?: string;
  eaAreaName?: string;
  floodArea?: { county?: string; riverOrSea?: string; polygon?: string };
  isTidal?: boolean;
  message?: string;
  severity?: string;
  severityLevel?: number;
  timeRaised?: string;
  timeMessageChanged?: string;
  timeSeverityChanged?: string;
}

export interface UkFloodWarning {
  id: string;
  areaName: string;
  county: string;
  riverOrSea: string;
  /** 1 Severe Flood Warning · 2 Flood Warning · 3 Flood Alert. */
  severityLevel: 1 | 2 | 3;
  severityLabel: string;
  isTidal: boolean;
  message: string;
  time: number;
  polygonUrl?: string;
  lat?: number;
  lon?: number;
}

const EA_SEVERITY: Record<number, UkAlertSeverity> = { 1: 'critical', 2: 'high', 3: 'medium' };

/** Active warnings only — level 4 ("no longer in force") is dropped. */
export function parseEaFloodWarnings(items: EaFloodItem[]): UkFloodWarning[] {
  const out: UkFloodWarning[] = [];
  for (const item of items) {
    const level = item.severityLevel;
    if (level !== 1 && level !== 2 && level !== 3) continue;
    if (!item.floodAreaID) continue;
    out.push({
      id: item.floodAreaID,
      areaName: item.description?.trim() || item.floodAreaID,
      county: item.floodArea?.county ?? '',
      riverOrSea: item.floodArea?.riverOrSea ?? '',
      severityLevel: level,
      severityLabel: item.severity ?? '',
      isTidal: Boolean(item.isTidal),
      message: clip(item.message ?? '', 600),
      time: Math.max(toMs(item.timeMessageChanged), toMs(item.timeSeverityChanged), toMs(item.timeRaised)),
      polygonUrl: item.floodArea?.polygon,
    });
  }
  return out;
}

export function floodWarningToAlert(w: UkFloodWarning): UkAlert {
  return {
    id: `ea:${w.id}`,
    source: 'ea-floods',
    category: 'flood',
    severity: EA_SEVERITY[w.severityLevel] ?? 'medium',
    title: `${w.severityLabel || 'Flood warning'}: ${w.areaName}`,
    detail: [w.county, w.riverOrSea].filter(Boolean).join(' · '),
    time: w.time,
    lat: w.lat,
    lon: w.lon,
    url: `https://check-for-flooding.service.gov.uk/target-area/${encodeURIComponent(w.id)}`,
  };
}

// ---------------------------------------------------------------------------
// Minimal RSS item extraction (Met Office warnings, BGS earthquakes)
// ---------------------------------------------------------------------------

export interface RssItem {
  title: string;
  description: string;
  link: string;
  pubDate: string;
  fields: Record<string, string>;
}

function decodeXml(text: string): string {
  return text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .trim();
}

export function parseRssItems(xml: string): RssItem[] {
  const items: RssItem[] = [];
  for (const match of xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/g)) {
    const fields: Record<string, string> = {};
    for (const tag of match[1]!.matchAll(/<([\w:]+)\b[^>]*>([\s\S]*?)<\/\1>/g)) {
      fields[tag[1]!] = decodeXml(tag[2]!);
    }
    items.push({
      title: fields.title ?? '',
      description: fields.description ?? '',
      link: fields.link ?? '',
      pubDate: fields.pubDate ?? '',
      fields,
    });
  }
  return items;
}

// Met Office titles read "Yellow warning of rain affecting London & South East England".
const MET_OFFICE_LEVELS: Array<[RegExp, UkAlertSeverity]> = [
  [/\bred\b/i, 'critical'],
  [/\bamber\b/i, 'high'],
  [/\byellow\b/i, 'medium'],
];

export function parseMetOfficeWarnings(xml: string): UkAlert[] {
  return parseRssItems(xml).map((item, i) => {
    const severity = MET_OFFICE_LEVELS.find(([re]) => re.test(item.title))?.[1] ?? 'low';
    return {
      id: `metoffice:${item.link || i}:${item.title}`,
      source: 'met-office' as const,
      category: 'weather' as const,
      severity,
      title: item.title,
      detail: clip(item.description),
      time: toMs(item.pubDate),
      url: item.link || undefined,
    };
  });
}

export interface UkEarthquake {
  id: string;
  place: string;
  magnitude: number;
  depthKm: number;
  time: number;
  lat: number;
  lon: number;
  url: string;
}

// BGS pubDate has no zone ("Fri, 09 Oct 2026 05:24:03"); the feed is UTC.
function parseBgsTime(pubDate: string): number {
  return toMs(/\b(GMT|UTC|[+-]\d{4})\b/.test(pubDate) ? pubDate : `${pubDate} GMT`);
}

export function parseBgsEarthquakes(xml: string): UkEarthquake[] {
  const out: UkEarthquake[] = [];
  for (const item of parseRssItems(xml)) {
    const lat = Number(item.fields['geo:lat']);
    const lon = Number(item.fields['geo:long']);
    const magnitude = Number(/Magnitude:\s*(-?[\d.]+)/.exec(item.description)?.[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(magnitude)) continue;
    const url = item.link.replace(/^http:\/\//, 'https://');
    out.push({
      id: url || `${lat},${lon},${item.pubDate}`,
      place: /Location:\s*([^;]+)/.exec(item.description)?.[1]?.trim() ?? '',
      magnitude,
      depthKm: Number(/Depth:\s*([\d.]+)/.exec(item.description)?.[1] ?? NaN),
      time: parseBgsTime(item.pubDate),
      lat,
      lon,
      url,
    });
  }
  return out;
}

export function earthquakeToAlert(q: UkEarthquake): UkAlert {
  const severity: UkAlertSeverity = q.magnitude >= 4 ? 'high' : q.magnitude >= 3 ? 'medium' : 'low';
  return {
    id: `bgs:${q.id}`,
    source: 'bgs',
    category: 'seismic',
    severity,
    title: `M${q.magnitude.toFixed(1)} earthquake — ${q.place}`,
    detail: Number.isFinite(q.depthKm) ? `Depth ${q.depthKm} km` : '',
    time: q.time,
    lat: q.lat,
    lon: q.lon,
    url: q.url,
  };
}

// ---------------------------------------------------------------------------
// TfL line status
// https://api.tfl.gov.uk/swagger/ui/index.html — statusSeverity 10 = Good Service
// ---------------------------------------------------------------------------

export interface TflLine {
  id: string;
  name: string;
  modeName: string;
  lineStatuses: Array<{ statusSeverity: number; statusSeverityDescription: string; reason?: string | null }>;
}

// Unplanned disruption ranks above planned engineering closures.
const TFL_SEVERITY: Record<number, UkAlertSeverity> = {
  1: 'high', // Closed
  2: 'high', // Suspended
  16: 'high', // Not Running
  3: 'medium', // Part Suspended
  6: 'medium', // Severe Delays
  17: 'medium', // Issues Reported
  7: 'low', // Reduced Service
  9: 'low', // Minor Delays
  4: 'low', // Planned Closure
  5: 'low', // Part Closure
  11: 'low', // Part Closed
  15: 'low', // Diverted
};

export function parseTflStatus(lines: TflLine[], now = Date.now()): UkAlert[] {
  const out: UkAlert[] = [];
  for (const line of lines) {
    for (const status of line.lineStatuses ?? []) {
      const severity = TFL_SEVERITY[status.statusSeverity];
      if (!severity) continue;
      out.push({
        id: `tfl:${line.id}:${status.statusSeverity}`,
        source: 'tfl',
        category: 'transport',
        severity,
        title: `${line.name}: ${status.statusSeverityDescription}`,
        detail: clip(status.reason ?? ''),
        time: now,
        lat: 51.5074,
        lon: -0.1278,
        url: `https://tfl.gov.uk/tube-dlr-overground/status/`,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// NESO system warnings via Elexon BMRS (SYSWARN)
// ---------------------------------------------------------------------------

export interface SysWarning {
  publishTime: string;
  warningType: string;
  warningText: string;
}

// Routine market notices (SO-SO trades, NRAPM price notices) are not crises.
const GRID_WARNING_LEVELS: Array<[RegExp, UkAlertSeverity]> = [
  [/demand control|load shedding|DEMAND REDUCTION/i, 'critical'],
  [/margin notice|capacity market notice|system warning|insufficient/i, 'high'],
  [/inadequate system margin|electricity margin/i, 'high'],
];

export function parseGridWarnings(rows: SysWarning[], now = Date.now(), windowMs = 72 * 3600_000): UkAlert[] {
  const out: UkAlert[] = [];
  for (const row of rows) {
    const time = toMs(row.publishTime);
    if (!time || now - time > windowMs) continue;
    const haystack = `${row.warningType} ${row.warningText}`;
    const severity = GRID_WARNING_LEVELS.find(([re]) => re.test(haystack))?.[1];
    if (!severity) continue;
    out.push({
      id: `neso:${row.publishTime}:${row.warningType}`,
      source: 'neso-grid',
      category: 'grid',
      severity,
      title: `NESO: ${row.warningType.toLowerCase().replace(/\b\w/g, c => c.toUpperCase())}`,
      detail: clip(row.warningText.replace(/\\n/g, ' ')),
      time,
      url: 'https://bmrs.elexon.co.uk/system-warnings',
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Carbon Intensity API (NESO) — context, not alerts
// ---------------------------------------------------------------------------

export interface GenerationMixEntry { fuel: string; perc: number }

export interface UkGridSnapshot {
  intensity: number | null;
  index: string;
  mix: GenerationMixEntry[];
  renewablePct: number;
  regions: Array<{ id: number; name: string; intensity: number; index: string }>;
  demandMw: number | null;
}

const RENEWABLE_FUELS = new Set(['wind', 'solar', 'hydro', 'biomass']);

export function renewableShare(mix: GenerationMixEntry[]): number {
  return Math.round(mix.filter(m => RENEWABLE_FUELS.has(m.fuel)).reduce((s, m) => s + m.perc, 0) * 10) / 10;
}
