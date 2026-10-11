import type { CoastalServiceHandler } from '../../../../src/generated/server/worldmonitor/coastal/v1/service_server';

import { getForecast } from './get-forecast';
import { getHistory } from './get-history';
import { listStations } from './list-stations';

export const coastalHandler: CoastalServiceHandler = {
  listStations,
  getForecast,
  getHistory,
};
