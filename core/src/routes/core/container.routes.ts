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

/** Shape-check a config patch. Returns an error message, or null when it is
 *  safe to persist. Every field is optional; only what was SENT is checked. */
function validateConfigTypes(b: Record<string, unknown>): string | null {
  const isAbs = (s: string) => /^([A-Za-z]:[\\/]|\/)/.test(s);
  if ('volumeRoots' in b) {
    const v = b.volumeRoots;
    if (!Array.isArray(v) || v.some((r) => typeof r !== 'string' || !r.trim() || !isAbs(r))) {
      return `volumeRoots must be an ARRAY of absolute paths (e.g. ["/srv/data"]) — got ${JSON.stringify(v)?.slice(0, 160)}`;
    }
  }
  if ('elevation' in b && !['auto', 'always', 'never'].includes(String(b.elevation))) {
    return `elevation must be auto|always|never — got ${JSON.stringify(b.elevation)?.slice(0, 80)}`;
  }
  for (const k of ['dockerBin', 'dockerHost'] as const) {
    if (k in b && (typeof b[k] !== 'string' || !String(b[k]).trim())) {
      return `${k} must be a non-empty string — got ${JSON.stringify(b[k])?.slice(0, 80)}`;
    }
  }
  if ('defaultNetwork' in b && b.defaultNetwork !== null && typeof b.defaultNetwork !== 'string') {
    return `defaultNetwork must be a string or null — got ${JSON.stringify(b.defaultNetwork)?.slice(0, 80)}`;
  }
  if ('limits' in b) {
    const l = b.limits;
    if (!l || typeof l !== 'object' || Array.isArray(l)) return `limits must be an object of numbers — got ${JSON.stringify(l)?.slice(0, 120)}`;
    for (const [k, v] of Object.entries(l as Record<string, unknown>)) {
      if (!Number.isInteger(v) || (v as number) < 1) return `limits.${k} must be a positive integer — got ${JSON.stringify(v)?.slice(0, 40)}`;
    }
  }
  return null;
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
          // Whitelisting NAMES is not enough — the TYPES have to hold too.
          // `{"volumeRoots":"/srv/data"}` is a plausible single-root call, and
          // persisting the string would make volumeRoots() throw on `.map` for
          // every later read AND every container_run, bricking the feature from
          // a config write. Validate before persisting; echo what was sent.
          const bad = validateConfigTypes(body);
          if (bad) return { success: false, error: { code: 'BAD_ARGS', message: bad } };
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
