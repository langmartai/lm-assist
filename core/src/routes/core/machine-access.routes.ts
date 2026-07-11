/**
 * Machine access profile routes — how to reach OTHER machines FROM this node.
 *
 *   GET    /machine-access                       → report (node identity + machines + usage)
 *   PUT    /machine-access/machines/:id          → loopback-only upsert
 *   DELETE /machine-access/machines/:id          → loopback-only remove
 *
 * Writes are loopback-guarded like POST /cluster/self: registering or altering
 * SSH endpoints is a node-owner action taken ON the node. Reads are normal
 * routes; the MCP tool `machine_access` wraps the GET.
 */
import * as os from 'os';
import type { RouteHandler, RouteContext, ParsedRequest } from '../index';
import { wrapResponse, wrapError } from '../../api/helpers';
import { isLoopbackAddress } from '../../auth/enroll-exempt';
import { getHubConfig } from '../../hub-client/hub-config';
import {
  listMachines,
  upsertMachine,
  removeMachine,
  toReportedMachine,
  MACHINE_ACCESS_USAGE,
  type MachineProfile,
} from '../../machine-access/store';

export function createMachineAccessRoutes(_ctx: RouteContext): RouteHandler[] {
  return [
    // GET /machine-access — full report for this node
    {
      method: 'GET',
      pattern: /^\/machine-access$/,
      handler: async () => {
        const start = Date.now();
        const machines = listMachines().map(toReportedMachine);
        const cfg = getHubConfig();
        return wrapResponse({
          node: { hostname: os.hostname(), gatewayId: cfg.gatewayId || cfg.machineId || '' },
          count: machines.length,
          machines,
          usage: MACHINE_ACCESS_USAGE,
        }, start);
      },
    },

    // PUT /machine-access/machines/:id — loopback-only upsert (path id is authoritative)
    {
      method: 'PUT',
      pattern: /^\/machine-access\/machines\/(?<id>[^/]+)$/,
      handler: async (req: ParsedRequest) => {
        const start = Date.now();
        if (!isLoopbackAddress(req.clientIp)) {
          return wrapError('FORBIDDEN', 'local-only endpoint', start);
        }
        const id = decodeURIComponent(req.params.id || '');
        const body = (req.body || {}) as Partial<MachineProfile>;
        try {
          const machine = upsertMachine({ ...body, id } as MachineProfile);
          return wrapResponse({ machine }, start);
        } catch (e) {
          return wrapError('INVALID_INPUT', e instanceof Error ? e.message : String(e), start);
        }
      },
    },

    // DELETE /machine-access/machines/:id — loopback-only remove
    {
      method: 'DELETE',
      pattern: /^\/machine-access\/machines\/(?<id>[^/]+)$/,
      handler: async (req: ParsedRequest) => {
        const start = Date.now();
        if (!isLoopbackAddress(req.clientIp)) {
          return wrapError('FORBIDDEN', 'local-only endpoint', start);
        }
        const id = decodeURIComponent(req.params.id || '');
        return wrapResponse({ removed: removeMachine(id), id }, start);
      },
    },
  ];
}
