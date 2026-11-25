// CrisisTwin UK crisis ontology. One module owns the incident taxonomy: which
// categories exist, their panel order, and how free-text UK news headlines are
// classified into them. Structured sources (EA, Met Office, NESO, TfL, BGS,
// NCSC) map onto the same categories at parse time; the news classifier below
// covers the categories that have no keyless structured feed — accidents,
// public disorder, strikes, infrastructure failures and live cyber incidents.
// Kept free of fetch/DOM so tests/uk-crisis-sources.test.mts can exercise it
// under plain Node.

import {
  clip,
  parseRssItems,
  toMs,
  type UkAlert,
  type UkAlertCategory,
  type UkAlertSeverity,
} from './parsers';

/** Display order for the full taxonomy (KPI chips and filters). */
export const UK_CRISIS_CATEGORY_ORDER: UkAlertCategory[] = [
  'flood', 'weather', 'accident', 'disorder', 'strike',
  'infrastructure', 'grid', 'transport', 'cyber', 'seismic',
];

// ---------------------------------------------------------------------------
// Free-text classification (news headlines)
// ---------------------------------------------------------------------------

// In UK domestic news "strike" is industrial action; a military strike on a
// named place ("air strikes", "strikes on Kyiv") must not land in that bucket.
const MILITARY_STRIKE = /\b(air ?strikes?|missile|drone strikes?|strikes? (?:on|against|in) [A-Z])/;

/** First match wins, so the order encodes precedence (cyber over transport, …). */
const NEWS_MATCHERS: Array<[UkAlertCategory, RegExp]> = [
  ['cyber', /\b(cyber ?-?attacks?|ransomware|hacked|hackers?|data breach|phishing|ddos|malware|it (outage|failure|meltdown)|systems? (down|offline))\b/i],
  ['strike', /\b(strikes?|strike action|industrial action|walk ?-?outs?|picket(s| line)?|pay dispute|ballot for action)\b/i],
  ['disorder', /\b(riots?|rioters|public disorder|unrest|looting|clashes|disturbances|protests?|protesters|demonstrat(?:ions?|ors))\b/i],
  ['infrastructure', /\b(power (cuts?|outage|failure)|blackouts?|substation|burst (water )?main|water (outage|shortage)|gas leak|crane (collapse|failure|breakdown)|bridge clos(?:ed|ure)|signal failure|national grid)\b/i],
  ['accident', /\b(major incident|explosion|blast|derail(?:ed|ment)?|crash(?:es|ed)?|collisions?|pile[- ]?up|(?:building|bridge|roof|wall|tunnel|scaffold\w*|mine|pier|stadium|stand) collapsed?|capsiz(?:ed|es)|sinking|huge fire|large fire|blaze|chemical (leak|spill))\b/i],
  ['transport', /\b(flights? (cancelled|grounded|diverted|delayed)|airport (closed|closure|disruption|chaos)|trains? (cancelled|halted|stranded)|rail (disruption|chaos)|line (closed|suspended)|motorway clos(?:ed|ure)|road clos(?:ed|ures?)|port (closed|closure|congestion)|ferr(?:y|ies) (cancelled|suspended))\b/i],
  ['flood', /\b(floods?|flooding|flood (warning|alert)s?)\b/i],
  ['weather', /\b(storms?|gales?|heavy (rain|snow)|snow (warning|chaos)|ice warning|heatwaves?|high winds?|weather warning)\b/i],
];

export function classifyUkCrisisText(text: string): UkAlertCategory | null {
  for (const [category, re] of NEWS_MATCHERS) {
    if (category === 'strike' && MILITARY_STRIKE.test(text)) continue;
    if (re.test(text)) return category;
  }
  return null;
}

const SEVERITY_HIGH = /\b(major incident|mass casualt(?:y|ies)|dead|deaths?|killed|fatal(?:ity|ities)?|riots?|explosion|derail|evacuat(?:ed|ion)|state of emergency)\b/i;
const SEVERITY_MEDIUM = /\b(cancelled|suspended|closed|closures?|disrupt(?:ed|ion)|outages?|blackouts?|power cuts?|injur(?:ed|ies)|ransomware|cyber ?-?attacks?|strikes?)\b/i;

export function newsSeverity(text: string): UkAlertSeverity {
  if (SEVERITY_HIGH.test(text)) return 'high';
  if (SEVERITY_MEDIUM.test(text)) return 'medium';
  return 'low';
}

// The Google News queries are already UK-scoped, but stories that merely
// mention the UK in the body still slip through. Require a UK marker in the
// headline itself. `(?<!new )york` keeps New York out.
const UK_MARKERS = /\b(uk|u\.k\.|britain|british|england|english|scotland|scottish|wales|welsh|northern ireland|london|manchester|birmingham|leeds|liverpool|glasgow|edinburgh|cardiff|belfast|bristol|sheffield|newcastle|nottingham|southampton|portsmouth|leicester|coventry|hull|derby|plymouth|aberdeen|dundee|swansea|oxford|cambridge|(?<!new )york|kent|essex|sussex|surrey|yorkshire|cumbria|cornwall|devon|norfolk|suffolk|lancashire|merseyside|midlands|heathrow|gatwick|stansted|nhs|met office|national grid|network rail|tfl|m\d{1,2})\b/i;

export function isUkRelevant(text: string): boolean {
  return UK_MARKERS.test(text);
}

// Most of the noise is figurative "collapse"/"crash"/"riot-torn" in market,
// sport or overseas stories. A headline that names a foreign place is about
// that place even if it mentions the UK, and finance/sport headlines only get
// through if they report a physical incident.
const FOREIGN_MARKERS = /\b(paris|france|french|germany|german|berlin|spain|madrid|italy|rome|greece|ukraine|kyiv|russia|moscow|gaza|israel|iran|china|beijing|taiwan|japan|tokyo|india|pakistan|afghanistan|australia|canada|new york|washington|america|american|texas|california|florida)\b/i;
const NEWS_NOISE = /\b(stocks?|stock market|shares|ftse|bonds?|consumer confidence|gdp|inflation|economy|batting|cricket|odi|t20|football|rugby|premier league|league cup|championship|boxing|grand prix|racing)\b/i;
const PHYSICAL_INCIDENT = /\b(major incident|explosion|killed|dead|deaths?|injured|evacuat\w*|fire crews|derail\w*)\b/i;

export function isNewsSignalCandidate(title: string): boolean {
  if (!isUkRelevant(title)) return false;
  if (FOREIGN_MARKERS.test(title)) return false;
  if (NEWS_NOISE.test(title) && !PHYSICAL_INCIDENT.test(title)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// News-signal source (Google News RSS, en-GB edition, via rss-proxy)
// ---------------------------------------------------------------------------

const UK_SCOPE = '(England OR Scotland OR Wales OR "Northern Ireland" OR Britain OR UK OR London)';

export const UK_NEWS_SIGNAL_QUERIES: string[] = [
  `(strike OR "industrial action" OR walkout OR protest OR riot OR unrest) ${UK_SCOPE} when:1d`,
  `("major incident" OR explosion OR derailment OR crash OR "pile-up" OR collapse OR "gas leak") ${UK_SCOPE} when:1d`,
  `("power cut" OR blackout OR "burst water main" OR "cyber attack" OR ransomware OR "IT outage") ${UK_SCOPE} when:1d`,
];

export function newsSignalUrl(query: string): string {
  return `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-GB&gl=GB&ceid=GB:en`;
}

export const NEWS_SIGNAL_WINDOW_MS = 36 * 3600_000;

// Google News titles end in " - Publisher".
const PUBLISHER_SUFFIX = /\s+-\s+[^-]+$/;

/**
 * Parse one news-signal RSS body into classified alerts. Pass a shared `seen`
 * set when merging several query results so duplicate headlines collapse.
 */
export function parseNewsSignals(
  xml: string,
  now = Date.now(),
  windowMs = NEWS_SIGNAL_WINDOW_MS,
  seen = new Set<string>(),
): UkAlert[] {
  const out: UkAlert[] = [];
  for (const item of parseRssItems(xml)) {
    const time = toMs(item.pubDate);
    if (!time || now - time > windowMs) continue;
    const title = item.title.replace(PUBLISHER_SUFFIX, '').trim();
    if (!title || !isNewsSignalCandidate(title)) continue;
    const category = classifyUkCrisisText(title);
    if (!category) continue;
    const key = title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      id: `uknews:${key}`,
      source: 'uk-news',
      category,
      severity: newsSeverity(title),
      title,
      detail: '',
      time,
      url: item.link || undefined,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// NCSC (cyber advisories and incident reports)
// ---------------------------------------------------------------------------

const NCSC_URGENT = /\b(incident|attacks?|ransomware|exploit(?:ed|ation)?|actively exploited|zero[- ]day|breach|critical vulnerabilit)/i;

export function parseNcscAlerts(xml: string, now = Date.now(), windowMs = 14 * 24 * 3600_000): UkAlert[] {
  const out: UkAlert[] = [];
  for (const item of parseRssItems(xml)) {
    const time = toMs(item.pubDate);
    if (!time || now - time > windowMs) continue;
    out.push({
      id: `ncsc:${item.link || item.title}`,
      source: 'ncsc',
      category: 'cyber',
      severity: NCSC_URGENT.test(`${item.title} ${item.description}`) ? 'medium' : 'low',
      title: item.title,
      detail: clip(item.description),
      time,
      url: item.link || undefined,
    });
  }
  return out.slice(0, 10);
}
