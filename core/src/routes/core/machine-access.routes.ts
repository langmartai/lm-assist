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
  setLastCheck,
  toReportedMachine,
  isSshAccess,
  MACHINE_ACCESS_USAGE,
  type MachineProfile,
} from '../../machine-access/store';
import { execFile } from 'child_process';
import { parseSshConfig, buildImportCandidates } from '../../machine-access/ssh-config';
import { buildSshProbeArgs, classifyProbe } from '../../machine-access/probe';
import type { LastCheck } from '../../machine-access/store';

const PROBE_CONNECT_TIMEOUT_S = 8;

/** Spawn `ssh` for a probe (no shell, argv array). Never rejects — resolves the
 *  classified result. A hard timeout backstops a wedged ssh beyond ConnectTimeout. */
function runSshProbe(args: string[]): Promise<LastCheck> {
  return new Promise((resolve) => {
    execFile('ssh', args, {
      timeout: (PROBE_CONNECT_TIMEOUT_S + 5) * 1000,
      killSignal: 'SIGKILL',
      maxBuffer: 256 * 1024,
      windowsHide: true,
    }, (err, _stdout, stderr) => {
      const code = err && typeof (err as NodeJS.ErrnoException).code === 'number'
        ? (err as unknown as { code: number }).code
        : err ? 255 : 0;
      resolve(classifyProbe(code, stderr?.toString() ?? ''));
    });
  });
}

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

    // POST /machine-access/machines/:id/check — loopback-only reachability probe.
    // Probes the machine's first ssh access (BatchMode, no known_hosts mutation)
    // and records lastCheck WITHOUT bumping updatedAt.
    {
      method: 'POST',
      pattern: /^\/machine-access\/machines\/(?<id>[^/]+)\/check$/,
      handler: async (req: ParsedRequest) => {
        const start = Date.now();
        if (!isLoopbackAddress(req.clientIp)) {
          return wrapError('FORBIDDEN', 'local-only endpoint', start);
        }
        const id = decodeURIComponent(req.params.id || '');
        const machine = getMachine(id);
        if (!machine) return wrapError('NOT_FOUND', `no machine with id "${id}"`, start);
        const ssh = (machine.access || []).find(isSshAccess);
        if (!ssh) return wrapError('NO_SSH_ACCESS', `machine "${id}" has no ssh access method to probe`, start);
        const result = await runSshProbe(buildSshProbeArgs(ssh, { connectTimeout: PROBE_CONNECT_TIMEOUT_S }));
        setLastCheck(id, result);
        return wrapResponse({ id, check: result }, start);
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
        // Import reads ONLY from within the ssh dir (~/.ssh by default; LM_SSH_CONFIG_DIR
        // redirects it for tests). body.path is an advanced/test hook that MUST resolve
        // inside that dir — never an arbitrary filesystem path — so this loopback endpoint
        // cannot be turned into an arbitrary file read (defense-in-depth behind the
        // loopback gate: a local low-priv process must not be able to exfiltrate files).
        const sshDir = path.resolve(process.env.LM_SSH_CONFIG_DIR || path.join(os.homedir(), '.ssh'));
        let cfgPath = path.join(sshDir, 'config');
        if (body.path) {
          const resolved = path.resolve(body.path);
          if (resolved !== sshDir && !resolved.startsWith(sshDir + path.sep)) {
            return wrapError('FORBIDDEN', `path must be within ${sshDir}`, start);
          }
          cfgPath = resolved;
        }
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
