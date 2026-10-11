export const config = { runtime: 'edge' };

import { createDomainGateway, serverOptions } from '../../../server/gateway';
import { createCoastalServiceRoutes } from '../../../src/generated/server/worldmonitor/coastal/v1/service_server';
import { coastalHandler } from '../../../server/worldmonitor/coastal/v1/handler';

export default createDomainGateway(
  createCoastalServiceRoutes(coastalHandler, serverOptions),
);
