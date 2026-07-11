/**
 * machine_access MCP tool — report the machines reachable FROM this node.
 *
 * Read-only; wraps GET /machine-access via the loopback passthrough so the
 * route stays the single source of truth (cluster_list precedent).
 *
 * Registration: MACHINE_ACCESS_TOOL_DEFS + MACHINE_ACCESS_HANDLERS → expanded.ts.
 * Scope: machine_access:'read' → configure.ts.
 */
import { ok, err, workerGet, type McpToolResult } from './_passthrough';

export const machineAccessToolDef = {
  name: 'machine_access',
  description:
    'List machines reachable FROM this lm-assist node and exactly how to access them: SSH ' +
    'profiles (user/host/port/identity-key PATH) each with a ready-to-run `command`, plus ' +
    'per-machine notes/gotchas (OS quirks, what not to touch). Profiles are NODE-LOCAL — the ' +
    'reported commands must run ON this node (its shell/agent/terminal), not from elsewhere; ' +
    'key material is never stored or returned. Non-ssh access types may appear with ' +
    'supported:false (future: windows-account remote exec). Optional filters: `id`, `tag`. ' +
    'Read-only; manage profiles on the node via loopback REST PUT/DELETE ' +
    '/machine-access/machines/<id> or by editing ~/.lm-assist/machine-access.json.',
  annotations: { readOnlyHint: true },
  inputSchema: {
    type: 'object' as const,
    properties: {
      id: { type: 'string', description: 'Return only the machine with this id.' },
      tag: { type: 'string', description: 'Return only machines carrying this tag.' },
    },
  },
};

export const MACHINE_ACCESS_TOOL_DEFS = [machineAccessToolDef] as const;

/** Pure filter (exported for unit tests). */
export function filterMachines<T extends { id?: string; tags?: string[] }>(
  machines: T[],
  opts: { id?: string; tag?: string },
): T[] {
  let out = machines;
  if (opts.id) out = out.filter((m) => m.id === opts.id);
  if (opts.tag) out = out.filter((m) => Array.isArray(m.tags) && m.tags.includes(opts.tag as string));
  return out;
}

interface MachineAccessReport {
  node?: unknown;
  count?: number;
  machines?: Array<{ id?: string; tags?: string[] }>;
  usage?: string;
}

async function handleMachineAccess(args: Record<string, unknown>): Promise<McpToolResult> {
  const id = typeof args.id === 'string' ? args.id.trim() : '';
  const tag = typeof args.tag === 'string' ? args.tag.trim() : '';
  try {
    const data = await workerGet<MachineAccessReport>('/machine-access');
    const all = Array.isArray(data?.machines) ? data.machines : [];
    const machines = filterMachines(all, { id: id || undefined, tag: tag || undefined });
    if (id && machines.length === 0) {
      return err(`no machine with id "${id}". Available: ${all.map((m) => m.id).join(', ') || '(none registered)'}`);
    }
    return ok(JSON.stringify({ ...data, count: machines.length, machines }, null, 2));
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

export const MACHINE_ACCESS_HANDLERS: Record<string, (args: Record<string, unknown>) => Promise<McpToolResult>> = {
  machine_access: handleMachineAccess,
};
