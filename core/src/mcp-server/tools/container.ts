/**
 * Container management MCP tools — surface the `/container/*` routes (single
 * source of truth) over the connector, fleet-wide.
 *
 *   container_status (read)  — engine doctor + bounded inventory, or one container
 *   container_run    (write) — run a new container (create + start)
 *   container_power  (write) — start | stop | restart
 *   container_logs   (read)  — bounded log tail
 *   container_delete (admin) — remove a container (+ optionally its image)
 *
 * Five tools, not nine: `list` is absorbed into `container_status` and
 * start/stop/restart into one `container_power`, because the connect-time
 * catalogue is a shared byte budget — see core/src/__tests__/mcp-catalog-size.test.ts.
 *
 * Every tool automatically carries the fleet `node` selector (withNodeParam in
 * configure.ts), so "run nginx on 117" is just node:"ubuntu-Virtual-Machine".
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

export const containerStatusToolDef = {
  name: 'container_status',
  description:
    'Docker status + inventory on a host: available + why not (daemon down / not installed), versions, ' +
    'privilege (direct/sudo/root), endpoint, counts, and the CONTAINER LIST ({containers,total,truncated}). ' +
    'name= one container in full; images=true adds images. Read-only.',
  annotations: { readOnlyHint: true },
  inputSchema: {
    type: 'object' as const,
    properties: {
      name: { type: 'string', description: 'Container name for full detail.' },
      images: { type: 'boolean', description: 'Also list images.' },
    },
  },
};

export const containerRunToolDef = {
  name: 'container_run',
  description:
    'Run a new container (docker run -d), labelled lm-assist-managed. Name [A-Za-z0-9][A-Za-z0-9._-]{0,63}; ' +
    'the image is pulled if missing. Bind mounts are REFUSED unless the node configures volumeRoots. ' +
    'WRITE — consumes host CPU/memory/ports.',
  annotations: { readOnlyHint: false },
  inputSchema: {
    type: 'object' as const,
    properties: {
      name: { type: 'string', description: 'Container name.' },
      image: { type: 'string', description: 'Image ref, e.g. alpine:3.20.' },
      command: { type: 'array', items: { type: 'string' }, description: 'Override the image command (argv, no shell).' },
      env: { type: 'object', description: 'Environment as {KEY: value}.' },
      ports: { type: 'array', items: { type: 'string' }, description: 'Publish, e.g. ["8080:80","53:53/udp"].' },
      volumes: { type: 'array', items: { type: 'string' }, description: 'Bind mounts "/host:/ctr[:ro]" (needs volumeRoots).' },
      restart: { type: 'string', enum: ['no', 'always', 'unless-stopped', 'on-failure'], description: 'Restart policy (default no).' },
      memory_mb: { type: 'number', description: 'Memory cap MB.' },
      cpus: { type: 'number', description: 'CPU cores, may be fractional.' },
      network: { type: ['string', 'null'], description: 'Network name; null = no network.' },
      notes: { type: 'string', description: 'Free-text notes.' },
    },
    required: ['name', 'image'],
  },
};

export const containerPowerToolDef = {
  name: 'container_power',
  description:
    'Power a container: action=start|stop|restart. stop/restart of a container lm-assist did not create needs ' +
    'force:true — they interrupt whatever it serves; force also makes stop a kill. Idempotent; returns the new ' +
    'state. WRITE.',
  annotations: { readOnlyHint: false },
  inputSchema: {
    type: 'object' as const,
    properties: {
      name: { type: 'string', description: 'Container name.' },
      action: { type: 'string', enum: ['start', 'stop', 'restart'], description: 'What to do.' },
      force: { type: 'boolean', description: 'Allow on a non-managed container; kill instead of stop.' },
      timeout_sec: { type: 'number', description: 'Graceful wait before SIGKILL (default 10).' },
    },
    required: ['name', 'action'],
  },
};

export const containerLogsToolDef = {
  name: 'container_logs',
  description:
    "Tail a container's logs (stdout+stderr merged), bounded: lines default 100, max 1000, ~100KB — the OLDEST " +
    'output is dropped first and truncated says so. since= takes "10m"/"2h" or an RFC3339 time. Read-only.',
  annotations: { readOnlyHint: true },
  inputSchema: {
    type: 'object' as const,
    properties: {
      name: { type: 'string', description: 'Container name.' },
      lines: { type: 'number', description: 'Tail lines (default 100, max 1000).' },
      since: { type: 'string', description: 'Only output after this, e.g. "10m".' },
    },
    required: ['name'],
  },
};

export const containerDeleteToolDef = {
  name: 'container_delete',
  description:
    'Delete a container: stop it if running, then remove it. remove_image also deletes its image when no other ' +
    'container needs it. Containers lm-assist did not create need force:true. ADMIN / irreversible.',
  annotations: { readOnlyHint: false, destructiveHint: true },
  inputSchema: {
    type: 'object' as const,
    properties: {
      name: { type: 'string', description: 'Container name to delete.' },
      force: { type: 'boolean', description: 'Allow deleting a non-managed container; kill it.' },
      remove_image: { type: 'boolean', description: 'Also remove its image if unused.' },
    },
    required: ['name'],
  },
};

export const CONTAINER_TOOL_DEFS = [
  containerStatusToolDef,
  containerRunToolDef,
  containerPowerToolDef,
  containerLogsToolDef,
  containerDeleteToolDef,
] as const;

// ─── handlers (loopback to /container/* — the routes stay the single source) ─

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
    return err(`${String(e.code || 'CONTAINER_OP_FAILED')}: ${String(e.message || 'operation failed')}`);
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

function qs(params: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    parts.push(`${k}=${encodeURIComponent(String(v))}`);
  }
  return parts.length ? `?${parts.join('&')}` : '';
}

export const CONTAINER_HANDLERS: Record<string, (args: Record<string, unknown>) => Promise<McpToolResult>> = {
  container_status: (args) => get(`/container/status${qs({ name: args.name, images: args.images === true ? '1' : '' })}`),
  container_run: (args) =>
    post('/container/run', {
      name: args.name,
      image: args.image,
      command: args.command,
      env: args.env,
      ports: args.ports,
      volumes: args.volumes,
      restart: args.restart,
      memoryMB: args.memory_mb,
      cpus: args.cpus,
      network: args.network,
      notes: args.notes,
    }),
  container_power: (args) =>
    post('/container/power', { name: args.name, action: args.action, force: args.force, timeoutSec: args.timeout_sec }),
  container_logs: (args) => get(`/container/logs${qs({ name: args.name, lines: args.lines, since: args.since })}`),
  container_delete: (args) => post('/container/delete', { name: args.name, force: args.force, removeImage: args.remove_image }),
};
