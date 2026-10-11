/**
 * ListStations RPC — active coastal prediction sites and what each can do.
 *
 * Reads the snapshot published by scripts/seed-coastal.mjs. Capabilities come
 * from that record, so a station whose model failed to load reports
 * waterLevelPrediction=false and the UI explains the gap rather than the
 * station silently vanishing from the map.
 */

import type {
  CoastalServiceHandler,
  ServerContext,
  ListStationsRequest,
  ListStationsResponse,
} from '../../../../src/generated/server/worldmonitor/coastal/v1/service_server';

import { ageMinutesNow, classifyFreshness, readCoastalMeta, readCoastalSnapshot } from './_shared';

export const listStations: CoastalServiceHandler['listStations'] = async (
  _ctx: ServerContext,
  _req: ListStationsRequest,
): Promise<ListStationsResponse> => {
  try {
    const [snapshot, meta] = await Promise.all([readCoastalSnapshot(), readCoastalMeta()]);
    if (!snapshot) return { stations: [], fetchedAt: 0, dataAvailable: false };

    const stations = snapshot.stations.map((rec) => {
      const ageMinutes = ageMinutesNow(rec.data?.latestUpdate);
      return {
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
        dataStatus: classifyFreshness(ageMinutes),
        ageMinutes: ageMinutes ?? 0,
        riskLevel: rec.risk?.level ?? 'unknown',
        currentWaterLevel: rec.current?.waterLevel ?? 0,
        hasCurrent: Boolean(rec.current),
        trend: rec.current?.trend ?? 'unknown',
      };
    });

    return {
      stations,
      fetchedAt: Number(snapshot.generatedAt || meta?.fetchedAt || 0),
      dataAvailable: true,
    };
  } catch {
    return { stations: [], fetchedAt: 0, dataAvailable: false };
  }
};
