/**
 * VM management routes — the REST face of core/src/vm/service.ts.
 *
 *   GET  /vm/status        → backend doctor (+ ?name= for one VM's detail)
 *   GET  /vm/list          → bounded list {vms, total, truncated}
 *   GET  /vm/config        → effective config (file + defaults + env)
 *   PUT  /vm/config        → patch whitelist fields (unknown ⇒ UNSUPPORTED_FIELD)
 *   POST /vm/create        → create a VM {name, cpus?, memoryMB?, diskGB?, ...}
 *   POST /vm/start         → {name}
 *   POST /vm/stop          → {name, force?, timeoutSec?}
 *   POST /vm/delete        → {name, deleteDisks?, force?}  (managed gate)
 *   GET  /vm/snapshots     → ?name=
 *   POST /vm/snapshot      → {name, action: create|restore|delete, snapshot?, force?}
 *
 * Route return convention (mirrors elevated/gmail routes): `success` + typed
 * `error.code` from VmError; on non-VM errors code=VM_OP_FAILED. Every mutating
 * route echoes the resulting VM state so callers never have to assume.
 */

import type { RouteHandler, RouteContext, ParsedRequest } from '../index';
import {
  CONFIG_FIELDS,
  defaultNetwork,
  effectiveLimits,
  elevationMode,
  libvirtUri,
  readVmConfig,
  storageRoot,
  vmConfigFile,
  writeVmConfig,
} from '../../vm/config';
import {
  vmCreate,
  vmDelete,
  vmList,
  vmSnapshot,
  vmSnapshotList,
  vmStart,
  vmStatus,
  vmStop,
} from '../../vm/service';
import { VmError } from '../../vm/types';

function fail(e: unknown): { success: false; error: { code: string; message: string } } {
  if (e instanceof VmError) return { success: false, error: { code: e.code, message: e.message } };
  return { success: false, error: { code: 'VM_OP_FAILED', message: e instanceof Error ? e.message : String(e) } };
}

export function createVmRoutes(_ctx: RouteContext): RouteHandler[] {
  return [
    {
      method: 'GET',
      pattern: /^\/vm\/status$/,
      handler: async (req: ParsedRequest) => {
        try {
          return { success: true, data: await vmStatus(req.query.name) };
        } catch (e) {
          return fail(e);
        }
      },
    },
    {
      method: 'GET',
      pattern: /^\/vm\/list$/,
      handler: async () => {
        try {
          return { success: true, data: await vmList() };
        } catch (e) {
          return fail(e);
        }
      },
    },
    {
      method: 'GET',
      pattern: /^\/vm\/config$/,
      handler: async () => {
        try {
          const cfg = readVmConfig();
          return {
            success: true,
            data: {
              file: vmConfigFile(),
              config: cfg,
              effective: {
                storageRoot: storageRoot(cfg),
                defaultNetwork: defaultNetwork(cfg),
                elevation: elevationMode(cfg),
                libvirtUri: libvirtUri(cfg),
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
      pattern: /^\/vm\/config$/,
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
          const cfg = writeVmConfig(body);
          return { success: true, data: { config: cfg, effective: { storageRoot: storageRoot(cfg), elevation: elevationMode(cfg) } } };
        } catch (e) {
          return fail(e);
        }
      },
    },
    {
      method: 'POST',
      pattern: /^\/vm\/create$/,
      handler: async (req: ParsedRequest) => {
        try {
          const b = (req.body || {}) as Record<string, unknown>;
          const vm = await vmCreate({
            name: b.name,
            cpus: b.cpus,
            memoryMB: b.memoryMB,
            diskGB: b.diskGB,
            isoPath: b.isoPath,
            network: b.network as string | null | undefined,
            generation: b.generation,
            storagePath: b.storagePath,
            notes: b.notes,
          });
          return { success: true, data: { vm } };
        } catch (e) {
          return fail(e);
        }
      },
    },
    {
      method: 'POST',
      pattern: /^\/vm\/start$/,
      handler: async (req: ParsedRequest) => {
        try {
          return { success: true, data: { vm: await vmStart((req.body || {}).name) } };
        } catch (e) {
          return fail(e);
        }
      },
    },
    {
      method: 'POST',
      pattern: /^\/vm\/stop$/,
      handler: async (req: ParsedRequest) => {
        try {
          const b = (req.body || {}) as Record<string, unknown>;
          return { success: true, data: { vm: await vmStop(b.name, { force: b.force, timeoutSec: b.timeoutSec }) } };
        } catch (e) {
          return fail(e);
        }
      },
    },
    {
      method: 'POST',
      pattern: /^\/vm\/delete$/,
      handler: async (req: ParsedRequest) => {
        try {
          const b = (req.body || {}) as Record<string, unknown>;
          return { success: true, data: await vmDelete(b.name, { deleteDisks: b.deleteDisks, force: b.force }) };
        } catch (e) {
          return fail(e);
        }
      },
    },
    {
      method: 'GET',
      pattern: /^\/vm\/snapshots$/,
      handler: async (req: ParsedRequest) => {
        try {
          return { success: true, data: await vmSnapshotList(req.query.name) };
        } catch (e) {
          return fail(e);
        }
      },
    },
    {
      method: 'POST',
      pattern: /^\/vm\/snapshot$/,
      handler: async (req: ParsedRequest) => {
        try {
          const b = (req.body || {}) as Record<string, unknown>;
          return { success: true, data: await vmSnapshot(b.action, b.name, b.snapshot, { force: b.force }) };
        } catch (e) {
          return fail(e);
        }
      },
    },
  ];
}
