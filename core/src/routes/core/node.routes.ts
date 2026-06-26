import type { RouteHandler, RouteContext } from '../index';
import { wrapResponse } from '../../api/helpers';
import { loadBuildHistory, recordBuild } from '../../monitor/build-history';

export function createNodeRoutes(_ctx: RouteContext): RouteHandler[] {
  return [
    {
      method: 'GET',
      pattern: /^\/node\/build$/,
      handler: async () => {
        const start = Date.now();
        const data = loadBuildHistory() ?? recordBuild();
        return wrapResponse(data, start);
      },
    },
  ];
}
