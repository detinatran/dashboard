/**
 * GetForecast RPC — current conditions plus the +1h/+3h/+6h outlook.
 *
 * The status field is the contract. `ready` means a compatible model produced
 * the horizons; anything else means it did not, and the horizon list is empty.
 * Callers must branch on status rather than on the presence of a number, so a
 * refusal can never be mistaken for a forecast of zero.
 */

import type {
  CoastalServiceHandler,
  ServerContext,
  GetForecastRequest,
  GetForecastResponse,
} from '../../../../src/generated/server/worldmonitor/coastal/v1/service_server';

import {
  ageMinutesNow, classifyFreshness, findStation, readCoastalSnapshot,
  type StoredStationRecord,
} from './_shared';

const HORIZON_HOURS: Record<string, number> = { '1h': 1, '3h': 3, '6h': 6 };

function emptyResponse(stationId: string): GetForecastResponse {
  return {
    station: {
      id: stationId, name: '', displayName: '', city: '', country: '',
      lat: 0, lon: 0, timezone: '',
      capabilities: { waterLevelPrediction: false, warningPrediction: false, tide: false },
      dataStatus: 'unknown', ageMinutes: 0, riskLevel: 'unknown',
      currentWaterLevel: 0, hasCurrent: false, trend: 'unknown',
    },
    baseTimestamp: 0,
    generatedAt: 0,
    hasCurrent: false,
    current: { waterLevel: 0, trend: 'unknown', datum: '', hasTide: false, predictedTide: 0, residual: 0 },
    weather: { present: false, pressure: 0, windSpeed: 0, windDirection: 0, windGust: 0, precipitation: 0, temperature: 0 },
    waterLevelForecast: { status: 'unavailable', reason: 'No published record for this station', horizons: [] },
    warningForecast: { status: 'unavailable', reason: '', horizons: [] },
    risk: { level: 'unknown', reason: '', basis: 'none' },
    data: {
      status: 'unknown', ageMinutes: 0, latestUpdate: 0,
      waterLevelProvider: '', weatherProvider: '', tideProvider: '', featureVersion: '',
    },
    model: { regressionVersion: '', warningVersion: '' },
    dataAvailable: false,
  };
}

function buildWaterLevelForecast(rec: StoredStationRecord, baseTimestamp: number) {
  const f = rec.waterLevelForecast;
  const status = f?.status ?? 'unavailable';
  if (status !== 'ready' || !f?.horizons) {
    return { status, reason: f?.reason ?? '', horizons: [] };
  }
  const horizons = Object.entries(f.horizons)
    .filter(([key]) => key in HORIZON_HOURS)
    .sort((a, b) => HORIZON_HOURS[a[0]] - HORIZON_HOURS[b[0]])
    .map(([key, h]) => {
      const hasBounds = Number.isFinite(h?.lowerBound as number) && Number.isFinite(h?.upperBound as number);
      // Tide is only meaningful inside the precomputed series' coverage; the
      // seeder writes null outside it rather than extrapolating a sine wave.
      const tide = (h as { predictedTide?: number | null })?.predictedTide;
      const resid = (h as { predictedResidual?: number | null })?.predictedResidual;
      const hasTide = Number.isFinite(tide as number);
      return {
        horizon: key,
        timestamp: baseTimestamp ? baseTimestamp + HORIZON_HOURS[key] * 3_600_000 : 0,
        waterLevel: Number(h?.waterLevel ?? 0),
        hasBounds,
        lowerBound: hasBounds ? Number(h!.lowerBound) : 0,
        upperBound: hasBounds ? Number(h!.upperBound) : 0,
        hasTide,
        predictedTide: hasTide ? Number(tide) : 0,
        predictedResidual: Number.isFinite(resid as number) ? Number(resid) : 0,
      };
    });
  return { status, reason: '', horizons };
}

function buildWarningForecast(rec: StoredStationRecord) {
  const w = rec.warningForecast;
  const status = w?.status ?? 'unavailable';
  if (status !== 'ready' || !w?.horizons) {
    return { status, reason: w?.reason ?? '', horizons: [] };
  }
  const horizons = Object.entries(w.horizons)
    .filter(([key]) => key in HORIZON_HOURS)
    .sort((a, b) => HORIZON_HOURS[a[0]] - HORIZON_HOURS[b[0]])
    .map(([key, h]) => ({
      horizon: key,
      probability: Number(h?.probability ?? 0),
      warning: h?.warning === true,
      hasThreshold: Number.isFinite(h?.threshold as number),
      threshold: Number.isFinite(h?.threshold as number) ? Number(h!.threshold) : 0,
    }));
  return { status, reason: '', horizons };
}

export const getForecast: CoastalServiceHandler['getForecast'] = async (
  _ctx: ServerContext,
  req: GetForecastRequest,
): Promise<GetForecastResponse> => {
  const stationId = String(req.stationId || '').trim();
  if (!stationId) return emptyResponse('');

  try {
    const snapshot = await readCoastalSnapshot();
    const rec = findStation(snapshot, stationId);
    if (!rec) return emptyResponse(stationId);

    const ageMinutes = ageMinutesNow(rec.data?.latestUpdate);
    const dataStatus = classifyFreshness(ageMinutes);
    const baseTimestamp = Number(rec.baseTimestamp || 0);
    const wx = rec.weather ?? null;

    return {
      station: {
        id: rec.station.id,
        name: rec.station.name,
        displayName: rec.station.displayName,
        city: rec.station.city,
        country: rec.station.country,
        lat: rec.station.lat,
        lon: rec.station.lon,
        timezone: rec.station.timezone,
        capabilities: {
          waterLevelPrediction: Boolean(rec.capabilities?.waterLevelPrediction),
          warningPrediction: Boolean(rec.capabilities?.warningPrediction),
          tide: Boolean(rec.capabilities?.tide),
        },
        dataStatus,
        ageMinutes: ageMinutes ?? 0,
        riskLevel: rec.risk?.level ?? 'unknown',
        currentWaterLevel: rec.current?.waterLevel ?? 0,
        hasCurrent: Boolean(rec.current),
        trend: rec.current?.trend ?? 'unknown',
      },
      baseTimestamp,
      generatedAt: Number(rec.generatedAt || 0),
      hasCurrent: Boolean(rec.current),
      current: {
        waterLevel: rec.current?.waterLevel ?? 0,
        trend: rec.current?.trend ?? 'unknown',
        datum: rec.current?.datum ?? '',
        // No tide source is configured: report absence rather than a zero that
        // reads as "tide is at chart datum".
        hasTide: Number.isFinite(rec.current?.predictedTide as number),
        predictedTide: Number(rec.current?.predictedTide ?? 0),
        residual: Number(rec.current?.residual ?? 0),
      },
      weather: {
        present: Boolean(wx),
        pressure: Number(wx?.pressure ?? 0),
        windSpeed: Number(wx?.windSpeed ?? 0),
        windDirection: Number(wx?.windDirection ?? 0),
        windGust: Number(wx?.windGust ?? 0),
        precipitation: Number(wx?.precipitation ?? 0),
        temperature: Number(wx?.temperature ?? 0),
      },
      waterLevelForecast: buildWaterLevelForecast(rec, baseTimestamp),
      warningForecast: buildWarningForecast(rec),
      risk: {
        level: rec.risk?.level ?? 'unknown',
        reason: rec.risk?.reason ?? '',
        basis: rec.risk?.basis ?? 'none',
      },
      data: {
        status: dataStatus,
        ageMinutes: ageMinutes ?? 0,
        latestUpdate: Number(rec.data?.latestUpdate || 0),
        waterLevelProvider: rec.data?.waterLevelProvider ?? '',
        weatherProvider: rec.data?.weatherProvider ?? '',
        tideProvider: rec.data?.tideProvider ?? '',
        featureVersion: rec.data?.featureVersion ?? '',
      },
      model: {
        regressionVersion: rec.model?.regressionVersion ?? '',
        warningVersion: rec.model?.warningVersion ?? '',
      },
      dataAvailable: true,
    };
  } catch {
    return emptyResponse(stationId);
  }
};
