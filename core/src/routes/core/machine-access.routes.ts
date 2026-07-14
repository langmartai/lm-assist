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
import * as fs from 'fs';
import * as path from 'path';
import type { RouteHandler, RouteContext, ParsedRequest } from '../index';
import { wrapResponse, wrapError } from '../../api/helpers';
import { isLoopbackAddress } from '../../auth/enroll-exempt';
import { getHubConfig } from '../../hub-client/hub-config';
import {
  listMachines,
  getMachine,
  upsertMachine,
  removeMachine,
  toReportedMachine,
  MACHINE_ACCESS_USAGE,
  type MachineProfile,
} from '../../machine-access/store';
import { parseSshConfig, buildImportCandidates } from '../../machine-access/ssh-config';

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

    // POST /machine-access/import — loopback-only ssh-config import.
    // Default DRY-RUN (writes nothing). {apply:true} writes enabled:false drafts,
    // never clobbering an existing id. {path} overrides ~/.ssh/config (test hook).
    {
      method: 'POST',
      pattern: /^\/machine-access\/import$/,
      handler: async (req: ParsedRequest) => {
        const start = Date.now();
        if (!isLoopbackAddress(req.clientIp)) {
          return wrapError('FORBIDDEN', 'local-only endpoint', start);
        }
        const body = (req.body || {}) as { apply?: boolean; path?: string };
        const cfgPath = body.path || path.join(os.homedir(), '.ssh', 'config');
        let text: string;
        try {
          text = fs.readFileSync(cfgPath, 'utf-8');
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
            return wrapError('NOT_FOUND', `no ssh config at ${cfgPath}`, start);
          }
          return wrapError('IO_ERROR', e instanceof Error ? e.message : String(e), start);
        }
        const defaultUser = (() => { try { return os.userInfo().username; } catch { return 'root'; } })();
        const { candidates, skippedInvalid } = buildImportCandidates(parseSshConfig(text), { defaultUser });
        const note = 'Drafts are enabled:false and tagged "imported". Review each, add operational notes ' +
          '(gotchas import cannot know), run POST /machine-access/machines/<id>/check, then enable.';

        if (!body.apply) {
          return wrapResponse({ dryRun: true, source: cfgPath, candidates, skippedInvalid, wouldWrite: candidates.length, note }, start);
        }
        const imported: string[] = [];
        const skippedExisting: string[] = [];
        for (const c of candidates) {
          if (getMachine(c.id)) { skippedExisting.push(c.id); continue; }
          upsertMachine(c);
          imported.push(c.id);
        }
        return wrapResponse({ dryRun: false, source: cfgPath, imported, skippedExisting, skippedInvalid, note }, start);
      },
    },
  ];
}
