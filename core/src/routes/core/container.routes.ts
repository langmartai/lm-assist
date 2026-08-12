/**
 * Container management routes — the REST face of core/src/container/service.ts.
 *
 *   GET  /container/status   → engine doctor (+ ?name= detail, ?images=1 images)
 *   GET  /container/list     → bounded list {containers, total, truncated}
 *   GET  /container/images   → bounded image list
 *   GET  /container/logs     → ?name=&lines=&since=&timestamps=
 *   GET  /container/config   → effective config (file + defaults + env)
 *   PUT  /container/config   → patch whitelist fields (unknown ⇒ UNSUPPORTED_FIELD)
 *   POST /container/run      → run a container {name, image, ...}
 *   POST /container/power    → {name, action: start|stop|restart, force?, timeoutSec?}
 *   POST /container/delete   → {name, force?, removeImage?}  (managed gate)
 *
 * Route return convention (mirrors the vm/elevated/gmail routes): `success` +
 * typed `error.code` from ContainerError; on other errors code=CONTAINER_OP_FAILED.
 * Every mutating route echoes the resulting container state so callers never
 * have to assume.
 */

import type { RouteHandler, RouteContext, ParsedRequest } from '../index';
import {
  CONFIG_FIELDS,
  containerConfigFile,
  defaultEndpoint,
  defaultNetwork,
  dockerBin,
  dockerHost,
  effectiveLimits,
  elevationMode,
  readContainerConfig,
  volumeRoots,
  writeContainerConfig,
} from '../../container/config';
import {
  containerDelete,
  containerImages,
  containerList,
  containerLogs,
  containerPower,
  containerRun,
  containerStatus,
} from '../../container/service';
import { ContainerError } from '../../container/types';

function fail(e: unknown): { success: false; error: { code: string; message: string } } {
  if (e instanceof ContainerError) return { success: false, error: { code: e.code, message: e.message } };
  return { success: false, error: { code: 'CONTAINER_OP_FAILED', message: e instanceof Error ? e.message : String(e) } };
}

function truthy(v: unknown): boolean {
  return v === true || v === '1' || v === 'true' || v === 'yes';
}

export function createContainerRoutes(_ctx: RouteContext): RouteHandler[] {
  return [
    {
      method: 'GET',
      pattern: /^\/container\/status$/,
      handler: async (req: ParsedRequest) => {
        try {
          return { success: true, data: await containerStatus(req.query.name, { images: truthy(req.query.images) }) };
        } catch (e) {
          return fail(e);
        }
      },
    },
    {
      method: 'GET',
      pattern: /^\/container\/list$/,
      handler: async () => {
        try {
          return { success: true, data: await containerList() };
        } catch (e) {
          return fail(e);
        }
      },
    },
    {
      method: 'GET',
      pattern: /^\/container\/images$/,
      handler: async () => {
        try {
          return { success: true, data: await containerImages() };
        } catch (e) {
          return fail(e);
        }
      },
    },
    {
      method: 'GET',
      pattern: /^\/container\/logs$/,
      handler: async (req: ParsedRequest) => {
        try {
          const q = req.query;
          return {
            success: true,
            data: await containerLogs(q.name, { lines: q.lines, since: q.since, timestamps: truthy(q.timestamps) }),
          };
        } catch (e) {
          return fail(e);
        }
      },
    },
    {
      method: 'GET',
      pattern: /^\/container\/config$/,
      handler: async () => {
        try {
          const cfg = readContainerConfig();
          return {
            success: true,
            data: {
              file: containerConfigFile(),
              config: cfg,
              effective: {
                dockerBin: dockerBin(cfg),
                dockerHost: dockerHost(cfg) || defaultEndpoint(),
                elevation: elevationMode(cfg),
                volumeRoots: volumeRoots(cfg),
                defaultNetwork: defaultNetwork(cfg),
                limits: effectiveLimits(cfg),
              },
            },
          };
        } catch (e) {
          return fail(e);
        }
      },
    },
    {
      method: 'PUT',
      pattern: /^\/container\/config$/,
      handler: async (req: ParsedRequest) => {
        try {
          const body = (req.body || {}) as Record<string, unknown>;
          // Refuse unknown fields LOUDLY, echoing what was sent (the
          // backlog-registry lesson — silent drops manufacture phantom bugs).
          const unknown = Object.keys(body).filter((k) => !(CONFIG_FIELDS as readonly string[]).includes(k));
          if (unknown.length) {
            return {
              success: false,
              error: {
                code: 'UNSUPPORTED_FIELD',
                message: `unsupported config field(s): ${unknown.join(', ')}. Allowed: ${CONFIG_FIELDS.join(', ')}`,
              },
            };
          }
          const cfg = writeContainerConfig(body);
          return {
            success: true,
            data: { config: cfg, effective: { elevation: elevationMode(cfg), volumeRoots: volumeRoots(cfg), limits: effectiveLimits(cfg) } },
          };
        } catch (e) {
          return fail(e);
        }
      },
    },
    {
      method: 'POST',
      pattern: /^\/container\/run$/,
      handler: async (req: ParsedRequest) => {
        try {
          const b = (req.body || {}) as Record<string, unknown>;
          const container = await containerRun({
            name: b.name,
            image: b.image,
            command: b.command,
            env: b.env,
            ports: b.ports,
            volumes: b.volumes,
            restart: b.restart,
            memoryMB: b.memoryMB,
            cpus: b.cpus,
            network: b.network as string | null | undefined,
            workdir: b.workdir,
            autoRemove: b.autoRemove,
            pull: b.pull,
            notes: b.notes,
          });
          return { success: true, data: { container } };
        } catch (e) {
          return fail(e);
        }
      },
    },
    {
      method: 'POST',
      pattern: /^\/container\/power$/,
      handler: async (req: ParsedRequest) => {
        try {
          const b = (req.body || {}) as Record<string, unknown>;
          return {
            success: true,
            data: { container: await containerPower(b.action, b.name, { force: b.force, timeoutSec: b.timeoutSec }) },
          };
        } catch (e) {
          return fail(e);
        }
      },
    },
    {
      method: 'POST',
      pattern: /^\/container\/delete$/,
      handler: async (req: ParsedRequest) => {
        try {
          const b = (req.body || {}) as Record<string, unknown>;
          return { success: true, data: await containerDelete(b.name, { force: b.force, removeImage: b.removeImage }) };
        } catch (e) {
          return fail(e);
        }
      },
    },
  ];
}
