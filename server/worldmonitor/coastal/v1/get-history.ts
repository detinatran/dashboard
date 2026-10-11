/**
 * GetHistory RPC — the stored observation window for the chart.
 *
 * Observations only. The forecast is a separate call so the map can render
 * markers without pulling every station's 24h series.
 */

import type {
  CoastalServiceHandler,
  ServerContext,
  GetHistoryRequest,
  GetHistoryResponse,
} from '../../../../src/generated/server/worldmonitor/coastal/v1/service_server';

import { findStation, readCoastalSnapshot } from './_shared';

const DEFAULT_HOURS = 24;
const MAX_HOURS = 48;

export const getHistory: CoastalServiceHandler['getHistory'] = async (
  _ctx: ServerContext,
  req: GetHistoryRequest,
): Promise<GetHistoryResponse> => {
  const stationId = String(req.stationId || '').trim();
  if (!stationId) return { stationId: '', observations: [], fetchedAt: 0, dataAvailable: false };

  try {
    const snapshot = await readCoastalSnapshot();
    const rec = findStation(snapshot, stationId);
    if (!rec) return { stationId, observations: [], fetchedAt: 0, dataAvailable: false };

    const requested = Number(req.hours);
    const hours = Number.isFinite(requested) && requested > 0
      ? Math.min(requested, MAX_HOURS)
      : DEFAULT_HOURS;
    const cutoff = Date.now() - hours * 3_600_000;

    const observations = (rec.observations ?? [])
      .filter((o) => Number.isFinite(o?.ts) && Number.isFinite(o?.level) && o.ts >= cutoff)
      .sort((a, b) => a.ts - b.ts)
      .map((o) => ({ timestamp: o.ts, waterLevel: o.level }));

    return {
      stationId,
      observations,
      fetchedAt: Number(snapshot?.generatedAt || 0),
      dataAvailable: observations.length > 0,
    };
  } catch {
    return { stationId, observations: [], fetchedAt: 0, dataAvailable: false };
  }
};
