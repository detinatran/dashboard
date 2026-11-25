/**
 * ListStations RPC: active coastal prediction sites and what each can do.
 *
 * Reads the snapshot written by scripts/seed-coastal.mjs. Capabilities come
 * from that record, so if a station's model failed to load it reports
 * waterLevelPrediction=false and the UI explains why, instead of the station
 * just disappearing from the map.
 */

import type {
  CoastalServiceHandler,
  ServerContext,
  ListStationsRequest,
  ListStationsResponse,
} from '../../../../src/generated/server/worldmonitor/coastal/v1/service_server';

import { ageMinutesNow, readCoastalMeta, readCoastalSnapshot, toStationSummary } from './_shared';

export const listStations: CoastalServiceHandler['listStations'] = async (
  _ctx: ServerContext,
  _req: ListStationsRequest,
): Promise<ListStationsResponse> => {
  try {
    const [snapshot, meta] = await Promise.all([readCoastalSnapshot(), readCoastalMeta()]);
    if (!snapshot) return { stations: [], fetchedAt: 0, dataAvailable: false };

    const stations = snapshot.stations.map((rec) => toStationSummary(rec, ageMinutesNow(rec.data?.latestUpdate)));

    return {
      stations,
      fetchedAt: Number(snapshot.generatedAt || meta?.fetchedAt || 0),
      dataAvailable: true,
    };
  } catch {
    return { stations: [], fetchedAt: 0, dataAvailable: false };
  }
};
