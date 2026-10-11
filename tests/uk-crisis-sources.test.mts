import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  compareAlerts,
  earthquakeToAlert,
  floodWarningToAlert,
  parseBgsEarthquakes,
  parseEaFloodWarnings,
  parseGridWarnings,
  parseMetOfficeWarnings,
  parseTflStatus,
  renewableShare,
  type UkAlert,
} from '../src/services/uk/parsers.ts';

describe('EA flood warnings', () => {
  const items = [
    { floodAreaID: '052WATCSTHUN', description: 'Hunstanton coast in Norfolk', severity: 'Flood alert', severityLevel: 3, isTidal: true,
      floodArea: { county: 'Norfolk', riverOrSea: 'North Sea' }, timeRaised: '2026-10-11T10:00:00', timeMessageChanged: '2026-10-11T12:00:00' },
    { floodAreaID: '053FWFPUWI06', description: 'Lincoln', severity: 'Severe Flood Warning', severityLevel: 1, timeRaised: '2026-10-11T13:00:00' },
    { floodAreaID: 'GONE', description: 'Porlock Weir', severity: 'Warning no longer in force', severityLevel: 4 },
    { description: 'no id', severityLevel: 2 },
  ];

  it('keeps active warnings only and maps severity levels', () => {
    const warnings = parseEaFloodWarnings(items);
    assert.deepEqual(warnings.map(w => w.id), ['052WATCSTHUN', '053FWFPUWI06']);
    const alerts = warnings.map(floodWarningToAlert);
    assert.deepEqual(alerts.map(a => a.severity), ['medium', 'critical']);
    assert.equal(alerts[0]!.detail, 'Norfolk · North Sea');
    assert.match(alerts[0]!.url!, /check-for-flooding\.service\.gov\.uk\/target-area\/052WATCSTHUN$/);
  });

  it('uses the latest of raised / message / severity change times', () => {
    const [w] = parseEaFloodWarnings(items);
    assert.equal(w!.time, Date.parse('2026-10-11T12:00:00'));
  });
});

describe('RSS sources', () => {
  const bgs = `<rss><channel><item>
    <title>UK Earthquake alert : M  1.4 :MULL,ARGYLL AND BUTE, Fri, 09 Oct 2026 05:24:03</title>
    <description>Origin date/time: Fri, 09 Oct 2026 05:24:03 ; Location: MULL,ARGYLL AND BUTE ; Lat/long: 56.416,-5.641 ; Depth: 3 km ; Magnitude:  1.4</description>
    <link>http://earthquakes.bgs.ac.uk/earthquakes/recent_events/20261009052257.html</link>
    <pubDate>Fri, 09 Oct 2026 05:24:03</pubDate>
    <geo:lat>56.416</geo:lat><geo:long>-5.641</geo:long>
  </item><item><title>broken</title><description>no coords</description></item></channel></rss>`;

  it('parses BGS quakes as UTC with https links and skips items without coordinates', () => {
    const quakes = parseBgsEarthquakes(bgs);
    assert.equal(quakes.length, 1);
    const q = quakes[0]!;
    assert.equal(q.place, 'MULL,ARGYLL AND BUTE');
    assert.equal(q.magnitude, 1.4);
    assert.equal(q.depthKm, 3);
    assert.equal(q.time, Date.UTC(2026, 9, 9, 5, 24, 3));
    assert.ok(q.url.startsWith('https://'));
    assert.equal(earthquakeToAlert(q).severity, 'low');
    assert.equal(earthquakeToAlert({ ...q, magnitude: 4.2 }).severity, 'high');
  });

  it('maps Met Office warning colours to severities and decodes entities', () => {
    const xml = `<rss><channel>
      <item><title>Amber warning of wind affecting South West England &amp; Wales</title><link>https://www.metoffice.gov.uk/a</link><pubDate>Sun, 11 Oct 2026 09:00:00 GMT</pubDate><description><![CDATA[Very strong winds]]></description></item>
      <item><title>Yellow warning of rain affecting Scotland</title><link>https://www.metoffice.gov.uk/b</link><description>Rain</description></item>
      <item><title>Red warning of wind affecting Northern Ireland</title><link>https://www.metoffice.gov.uk/c</link></item>
    </channel></rss>`;
    const alerts = parseMetOfficeWarnings(xml);
    assert.deepEqual(alerts.map(a => a.severity), ['high', 'medium', 'critical']);
    assert.equal(alerts[0]!.title, 'Amber warning of wind affecting South West England & Wales');
    assert.equal(alerts[0]!.detail, 'Very strong winds');
  });

  it('returns no alerts for an empty Met Office feed', () => {
    assert.deepEqual(parseMetOfficeWarnings('<rss><channel><title>Met Office warnings for UK</title></channel></rss>'), []);
  });
});

describe('TfL status', () => {
  it('drops good service and ranks unplanned disruption above engineering work', () => {
    const alerts = parseTflStatus([
      { id: 'central', name: 'Central', modeName: 'tube', lineStatuses: [{ statusSeverity: 2, statusSeverityDescription: 'Suspended', reason: 'Signal failure' }] },
      { id: 'district', name: 'District', modeName: 'tube', lineStatuses: [{ statusSeverity: 5, statusSeverityDescription: 'Part Closure' }] },
      { id: 'victoria', name: 'Victoria', modeName: 'tube', lineStatuses: [{ statusSeverity: 10, statusSeverityDescription: 'Good Service' }] },
    ], 1000);
    assert.deepEqual(alerts.map(a => [a.title, a.severity]), [['Central: Suspended', 'high'], ['District: Part Closure', 'low']]);
    assert.equal(alerts[0]!.detail, 'Signal failure');
  });
});

describe('NESO grid warnings', () => {
  const now = Date.parse('2026-10-11T18:00:00Z');
  it('ignores routine SO-SO trade notices and stale warnings', () => {
    const alerts = parseGridWarnings([
      { publishTime: '2026-10-11T13:37:00Z', warningType: 'SO-SO TRADES', warningText: 'NOTIFICATION of excess energy prices' },
      { publishTime: '2026-10-11T15:00:00Z', warningType: 'ELECTRICITY MARGIN NOTICE', warningText: 'Margin shortfall 18:00-19:00' },
      { publishTime: '2026-10-11T16:00:00Z', warningType: 'DEMAND CONTROL IMMINENT', warningText: 'Demand control may be required' },
      { publishTime: '2026-09-01T16:00:00Z', warningType: 'ELECTRICITY MARGIN NOTICE', warningText: 'old' },
    ], now);
    assert.deepEqual(alerts.map(a => [a.title, a.severity]), [
      ['NESO: Electricity Margin Notice', 'high'],
      ['NESO: Demand Control Imminent', 'critical'],
    ]);
  });
});

describe('alert ordering and grid helpers', () => {
  it('sorts by severity, then newest first', () => {
    const mk = (id: string, severity: UkAlert['severity'], time: number): UkAlert =>
      ({ id, severity, time, source: 'tfl', category: 'transport', title: id, detail: '' });
    const sorted = [mk('a', 'low', 9), mk('b', 'critical', 1), mk('c', 'critical', 5), mk('d', 'medium', 3)].sort(compareAlerts);
    assert.deepEqual(sorted.map(a => a.id), ['c', 'b', 'd', 'a']);
  });

  it('counts wind, solar, hydro and biomass as renewable', () => {
    assert.equal(renewableShare([
      { fuel: 'gas', perc: 41.7 }, { fuel: 'wind', perc: 6.3 }, { fuel: 'solar', perc: 1.4 },
      { fuel: 'biomass', perc: 11.1 }, { fuel: 'nuclear', perc: 14.9 }, { fuel: 'hydro', perc: 0.2 },
    ]), 19);
  });
});
