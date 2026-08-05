/**
 * VM management MCP tools — surface the `/vm/*` routes (single source of
 * truth) over the connector, fleet-wide.
 *
 *   vm_status   (read)   — backend doctor + bounded VM list, or one VM's detail
 *   vm_create   (write)  — create a VM (Hyper-V on Windows, KVM on Linux)
 *   vm_power    (write)  — start | stop (graceful or force)
 *   vm_snapshot (write)  — list/create/restore/delete snapshots
 *   vm_delete   (admin)  — destroy a VM (+ its disks under the storage root)
 *
 * Every tool automatically carries the fleet `node` selector (withNodeParam in
 * configure.ts), so "create a VM on 107" is just node:"DESKTOP-GDKLATG".
 *
 * Wiring: EXPANDED_TOOL_DEFS + EXPANDED_HANDLERS (expanded.ts), TOOL_SCOPES
 * (configure.ts), and registry/catalog.ts — all three, or Core crashes on
 * tools/list (assertScopesCoverTools) / the catalog test fails.
 */
import { ok, err, workerGet, workerPostRaw, type McpToolResult } from './_passthrough';

function pretty(data: unknown): string {
  return typeof data === 'string' ? data : JSON.stringify(data, null, 2);
}

// ─── definitions ─────────────────────────────────────────────────────────────

export const vmStatusToolDef = {
  name: 'vm_status',
  description:
    'VM backend status + inventory on a host: hypervisor (Hyper-V on Windows, KVM/libvirt on Linux), ' +
    'availability + reason, version, privilege path (direct/worker/sudo), storage root + free space, and ' +
    'the VM LIST ({vms,total,truncated}). name= returns one VM\'s full detail instead. Read-only.',
  annotations: { readOnlyHint: true },
  inputSchema: {
    type: 'object' as const,
    properties: {
      name: { type: 'string', description: 'VM name for full detail.' },
    },
  },
};

export const vmCreateToolDef = {
  name: 'vm_create',
  description:
    'Create a VM (Hyper-V on Windows, KVM/qcow2 on Linux) under the storage root (<root>/<name>/), tagged ' +
    'lm-assist-managed. Name [A-Za-z0-9._-]{1,64}. Defaults: 1 cpu, 1024 MB, 10 GB thin disk, gen 2, no ' +
    'ISO (boots to firmware — fine for infra tests). WRITE — allocates host resources.',
  annotations: { readOnlyHint: false },
  inputSchema: {
    type: 'object' as const,
    properties: {
      name: { type: 'string', description: 'VM name, [A-Za-z0-9._-]{1,64}.' },
      cpus: { type: 'number', description: 'vCPUs (default 1).' },
      memory_mb: { type: 'number', description: 'Memory MB (default 1024).' },
      disk_gb: { type: 'number', description: 'Disk GB, thin (default 10).' },
      iso_path: { type: 'string', description: 'Absolute host path of a boot ISO.' },
      network: { type: ['string', 'null'], description: 'Switch/network name; null = no NIC; omit = node default.' },
      generation: { type: 'number', description: '2 (default) or 1 (BIOS).' },
      storage_path: { type: 'string', description: 'Override storage root (absolute path).' },
      notes: { type: 'string', description: 'Free-text notes.' },
    },
    required: ['name'],
  },
};

export const vmPowerToolDef = {
  name: 'vm_power',
  description:
    'Power a VM: action=start|stop. stop is graceful by default (needs guest ACPI/integration services; ' +
    'waits timeout_sec, default 30); force:true = hard power-off, required for OS-less guests. Idempotent. ' +
    'Returns the resulting state. WRITE.',
  annotations: { readOnlyHint: false },
  inputSchema: {
    type: 'object' as const,
    properties: {
      name: { type: 'string', description: 'VM name.' },
      action: { type: 'string', enum: ['start', 'stop'], description: 'start or stop.' },
      force: { type: 'boolean', description: 'stop: hard power-off (default false).' },
      timeout_sec: { type: 'number', description: 'stop: graceful wait seconds (default 30).' },
    },
    required: ['name', 'action'],
  },
};

export const vmSnapshotToolDef = {
  name: 'vm_snapshot',
  description:
    'VM snapshots (Hyper-V checkpoints / libvirt): action=list|create|restore|delete. create auto-names ' +
    'when snapshot omitted. restore/delete on a non-managed VM needs force:true. WRITE — restore rewinds ' +
    'VM state.',
  annotations: { readOnlyHint: false },
  inputSchema: {
    type: 'object' as const,
    properties: {
      name: { type: 'string', description: 'VM name.' },
      action: { type: 'string', enum: ['list', 'create', 'restore', 'delete'], description: 'Snapshot operation.' },
      snapshot: { type: 'string', description: 'Snapshot name (optional for create).' },
      force: { type: 'boolean', description: 'Allow on a non-managed VM.' },
    },
    required: ['name', 'action'],
  },
};

export const vmDeleteToolDef = {
  name: 'vm_delete',
  description:
    'Delete a VM: power off, unregister, and (delete_disks default true) remove its disk files — only ' +
    'under the VM storage root; others reported kept. Non-managed VMs need force:true. ADMIN / irreversible.',
  annotations: { readOnlyHint: false, destructiveHint: true },
  inputSchema: {
    type: 'object' as const,
    properties: {
      name: { type: 'string', description: 'VM name to delete.' },
      delete_disks: { type: 'boolean', description: 'Delete disks under the storage root (default true).' },
      force: { type: 'boolean', description: 'Allow deleting a non-managed VM.' },
    },
    required: ['name'],
  },
};

export const VM_TOOL_DEFS = [
  vmStatusToolDef,
  vmCreateToolDef,
  vmPowerToolDef,
  vmSnapshotToolDef,
  vmDeleteToolDef,
] as const;

// ─── handlers (loopback to /vm/* — the routes stay the single source) ────────

async function get(routePath: string): Promise<McpToolResult> {
  try {
    return ok(pretty(await workerGet(routePath)));
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

async function post(routePath: string, body: Record<string, unknown>): Promise<McpToolResult> {
  try {
    const r = await workerPostRaw(routePath, body);
    if (r && r.success) return ok(pretty(r.data));
    const e = (r && (r.error as Record<string, unknown>)) || {};
    return err(`${String(e.code || 'VM_OP_FAILED')}: ${String(e.message || 'operation failed')}`);
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

export const VM_HANDLERS: Record<string, (args: Record<string, unknown>) => Promise<McpToolResult>> = {
  vm_status: (args) => get(`/vm/status${args.name ? `?name=${encodeURIComponent(String(args.name))}` : ''}`),
  vm_create: (args) =>
    post('/vm/create', {
      name: args.name,
      cpus: args.cpus,
      memoryMB: args.memory_mb,
      diskGB: args.disk_gb,
      isoPath: args.iso_path,
      network: args.network,
      generation: args.generation,
      storagePath: args.storage_path,
      notes: args.notes,
    }),
  vm_power: (args) =>
    args.action === 'start'
      ? post('/vm/start', { name: args.name })
      : args.action === 'stop'
        ? post('/vm/stop', { name: args.name, force: args.force, timeoutSec: args.timeout_sec })
        : Promise.resolve(err('action must be start or stop')),
  vm_snapshot: (args) =>
    post('/vm/snapshot', { name: args.name, action: args.action, snapshot: args.snapshot, force: args.force }),
  vm_delete: (args) => post('/vm/delete', { name: args.name, deleteDisks: args.delete_disks, force: args.force }),
};
