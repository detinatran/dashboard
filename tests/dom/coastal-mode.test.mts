/**
 * Coastal mode UI behaviour.
 *
 * The contract worth pinning is refusal: when no model is configured, or the
 * history window is short, the panel must SAY so and still show the observed
 * level — never render a blank forecast slot that reads as "0 m", and never
 * invent a number.
 *
 * Lives under tests/dom because CoastalStationPanel imports @/services/i18n,
 * whose import.meta.glob graph only a Vite pipeline can transform.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { initTestI18n } from './helpers/i18n.mts';

const { mockForecast, mockHistory } = vi.hoisted(() => ({
  mockForecast: vi.fn(),
  mockHistory: vi.fn(),
}));

vi.mock('@/services/coastal', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/coastal')>()),
  fetchCoastalForecast: (...a: unknown[]) => mockForecast(...a),
  fetchCoastalHistory: (...a: unknown[]) => mockHistory(...a),
}));

const { CoastalStationPanel } = await import('@/components/CoastalStationPanel');

const STATION = {
  id: 'liverpool-gladstone',
  name: 'Liverpool',
  displayName: 'Liverpool (Gladstone Dock)',
  city: 'Liverpool',
  country: 'GB',
  lat: 53.44967,
  lon: -3.01815,
  timezone: 'Europe/London',
  capabilities: { waterLevelPrediction: true, warningPrediction: false, tide: true },
  dataStatus: 'live',
  ageMinutes: 8,
  riskLevel: 'unknown',
  currentWaterLevel: 3.82,
  hasCurrent: true,
  trend: 'rising',
};

function baseResponse(overrides: Record<string, unknown> = {}) {
  return {
    station: STATION,
    baseTimestamp: Date.UTC(2026, 8, 14, 8, 0),
    generatedAt: Date.UTC(2026, 8, 14, 8, 5),
    hasCurrent: true,
    current: { waterLevel: 3.82, trend: 'rising', datum: 'local-gauge-m', hasTide: true, predictedTide: 3.55, residual: 0.27 },
    weather: { present: true, pressure: 1007.2, windSpeed: 8.4, windDirection: 215, windGust: 12.1, precipitation: 0.3, temperature: 16.7 },
    waterLevelForecast: { status: 'ready', reason: '', horizons: [
      { horizon: '1h', timestamp: Date.UTC(2026, 8, 14, 9, 0), waterLevel: 3.96, hasBounds: true, lowerBound: 3.84, upperBound: 4.08 },
      { horizon: '3h', timestamp: Date.UTC(2026, 8, 14, 11, 0), waterLevel: 4.31, hasBounds: true, lowerBound: 4.10, upperBound: 4.52 },
      { horizon: '6h', timestamp: Date.UTC(2026, 8, 14, 14, 0), waterLevel: 4.08, hasBounds: true, lowerBound: 3.80, upperBound: 4.36 },
    ] },
    warningForecast: { status: 'model_not_configured', reason: '', horizons: [] },
    risk: { level: 'unknown', reason: 'No warning model is configured for this site', basis: 'none' },
    data: { status: 'live', ageMinutes: 8, latestUpdate: Date.UTC(2026, 8, 14, 8, 0),
            waterLevelProvider: 'environment-agency', weatherProvider: 'open-meteo',
            tideProvider: 'harmonic-utide', featureVersion: 'coastal-v1' },
    model: { regressionVersion: 'liverpool-water-v1', warningVersion: '' },
    dataAvailable: true,
    ...overrides,
  };
}

describe('coastal station panel', () => {
  beforeAll(async () => { await initTestI18n(); });

  beforeEach(() => {
    document.body.replaceChildren();
    mockForecast.mockReset();
    mockHistory.mockReset();
    mockHistory.mockResolvedValue({ stationId: STATION.id, observations: [], fetchedAt: 0, dataAvailable: false });
  });

  it('renders the observed level and a ready forecast', async () => {
    mockForecast.mockResolvedValue(baseResponse());
    const host = document.createElement('div');
    document.body.append(host);
    const panel = new CoastalStationPanel(host);
    await panel.show(STATION.id);

    const text = host.textContent ?? '';
    expect(text).toContain('Liverpool (Gladstone Dock)');
    expect(text).toContain('3.82 m');
    expect(text).toContain('3.96 m');
    expect(text).toContain('4.31 m');
    expect(text).toContain('4.08 m');
  });

  it('explains a missing model instead of rendering empty forecast slots', async () => {
    mockForecast.mockResolvedValue(baseResponse({
      waterLevelForecast: { status: 'model_not_configured', reason: '', horizons: [] },
      model: { regressionVersion: '', warningVersion: '' },
    }));
    const host = document.createElement('div');
    document.body.append(host);
    await new CoastalStationPanel(host).show(STATION.id);

    const text = host.textContent ?? '';
    expect(text).toContain('not available for this site');
    // The observation is real and must survive the model's absence.
    expect(text).toContain('3.82 m');
    expect(host.querySelectorAll('.coastal-horizon')).toHaveLength(0);
  });

  it('explains a short history window', async () => {
    mockForecast.mockResolvedValue(baseResponse({
      waterLevelForecast: { status: 'insufficient_history', reason: '', horizons: [] },
    }));
    const host = document.createElement('div');
    document.body.append(host);
    await new CoastalStationPanel(host).show(STATION.id);
    expect(host.textContent ?? '').toContain('sufficient historical data');
  });

  it('says the warning model is absent rather than implying a low probability', async () => {
    mockForecast.mockResolvedValue(baseResponse());
    const host = document.createElement('div');
    document.body.append(host);
    await new CoastalStationPanel(host).show(STATION.id);
    const text = host.textContent ?? '';
    expect(text).toContain('Warning model not available');
    expect(text).not.toContain('0%');
  });

  it('labels risk as a model estimate, never an official warning', async () => {
    mockForecast.mockResolvedValue(baseResponse());
    const host = document.createElement('div');
    document.body.append(host);
    await new CoastalStationPanel(host).show(STATION.id);
    const caption = host.querySelector('.coastal-risk-caption')?.textContent ?? '';
    expect(caption).toMatch(/model risk/i);
    expect(caption).toMatch(/not an official/i);
  });

  it('shows tide and residual when a tide model is configured', async () => {
    mockForecast.mockResolvedValue(baseResponse());
    const host = document.createElement('div');
    document.body.append(host);
    await new CoastalStationPanel(host).show(STATION.id);
    const text = host.textContent ?? '';
    expect(text).toContain('Astronomical tide');
    expect(text).toContain('3.55 m');
    expect(text).toContain('+0.27 m');
  });

  it('omits tide and residual when no tide model is configured', async () => {
    // The station registry can carry tideProvider 'none', and the precomputed
    // series also expires. Either way the panel must omit the rows rather than
    // render 0.00 m, which would read as "tide is at chart datum".
    mockForecast.mockResolvedValue(baseResponse({
      current: { waterLevel: 3.82, trend: 'rising', datum: 'local-gauge-m',
                 hasTide: false, predictedTide: 0, residual: 0 },
      data: { ...baseResponse().data, tideProvider: 'none' },
    }));
    const host = document.createElement('div');
    document.body.append(host);
    await new CoastalStationPanel(host).show(STATION.id);
    const text = host.textContent ?? '';
    expect(text).not.toContain('Astronomical tide');
    expect(text).not.toContain('Residual');
  });

  it('conveys freshness with text, not colour alone', async () => {
    mockForecast.mockResolvedValue(baseResponse({
      data: { ...baseResponse().data, status: 'delayed', ageMinutes: 75 },
    }));
    const host = document.createElement('div');
    document.body.append(host);
    await new CoastalStationPanel(host).show(STATION.id);
    expect(host.querySelector('.coastal-status-text')?.textContent ?? '').toBeTruthy();
    expect(host.textContent ?? '').toContain('75');
  });

  it('renders an empty state when the station has no published record', async () => {
    mockForecast.mockResolvedValue(null);
    const host = document.createElement('div');
    document.body.append(host);
    await new CoastalStationPanel(host).show(STATION.id);
    expect(host.querySelector('.coastal-panel-empty')).toBeTruthy();
  });
});
