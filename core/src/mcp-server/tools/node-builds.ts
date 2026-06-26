/**
 * node_builds MCP tool — fleet-wide lm-assist build/upgrade tracking.
 *
 * Fans out GET /node/build to every connected node (same pattern as
 * auth_status allNodes sweep). A failed/offline node returns a '?' row.
 * Read-only, no secrets.
 *
 * Registered in EXPANDED_TOOL_DEFS + EXPANDED_HANDLERS (expanded.ts),
 * scoped 'read' in configure.ts TOOL_SCOPES.
 */
import { ok, err, workerGet, type McpToolResult } from './_passthrough';

export const nodeBuildsToolDef = {
  name: 'node_builds',
  description:
    "Show each connected node's lm-assist BUILD version + when it last upgraded — confirm a " +
    'deploy landed across the fleet. Pull/on-demand. (The hub does not carry the build version, ' +
    'so this fans out to each node\'s self-recorded build.) Each row: node name, version, and ' +
    'when the version last changed. Read-only.',
  annotations: { readOnlyHint: true },
  inputSchema: {
    type: 'object' as const,
    properties: {},
  },
};

export const NODE_BUILDS_TOOL_DEFS = [nodeBuildsToolDef] as const;

/**
 * Format build rows into a compact human-readable string.
 * PURE — no I/O.
 */
export function formatBuilds(
  rows: Array<{ node: string; version: string; upgradedAt: string | null }>,
): string {
  if (rows.length === 0) return 'No nodes found.';
  return rows
    .map((r) => {
      const when = r.upgradedAt ? `upgraded ${r.upgradedAt}` : 'upgrade time unknown';
      return `${r.node}  v${r.version}  (${when})`;
    })
    .join('\n');
}

export interface NodeEntry { nodeId: string; hostname: string; isSelf: boolean; }

/**
 * Build the fleet node list to sweep from the raw hub machine list.
 * PURE — no I/O. Filters to ONLINE nodes only (offline/stale/duplicate gateway
 * registrations would otherwise clutter the output as 'v?' rows — same online
 * filter peer-client's selectSyncPeers uses), maps each to a NodeEntry, and
 * guarantees the self node is present even if it is absent/offline in the list.
 */
export function selectFleetNodes(
  machineList: any[],
  selfId: string,
  selfHostname: string,
): NodeEntry[] {
  const online: NodeEntry[] = (machineList || [])
    .filter((m: any) => String(m?.status || '').toLowerCase() === 'online')
    .map((m: any) => ({
      nodeId: String(m.gatewayId || m.machineId || m.id || ''),
      hostname: String(m.hostname || m.machineHostname || m.gatewayId || m.machineId || m.id || ''),
      isSelf: (m.gatewayId || m.machineId || m.id) === selfId,
    }))
    .filter((m: NodeEntry) => m.nodeId);
  if (!online.some((n) => n.isSelf)) {
    online.unshift({ nodeId: selfId, hostname: selfHostname, isSelf: true });
  }
  return online;
}

interface BuildData {
  node?: string;
  current?: string;
  upgradedAt?: string | null;
}

async function sweepNodes(): Promise<McpToolResult> {
  const { getHubConfig } = require('../../hub-client/hub-config') as typeof import('../../hub-client/hub-config');
  const cfg = getHubConfig();
  const selfId = cfg.gatewayId || cfg.machineId;
  const selfHostname = cfg.hostname || selfId || 'this-node';

  let nodes: NodeEntry[] = [{ nodeId: selfId, hostname: selfHostname, isSelf: true }];
  try {
    const hm = await workerGet<{ machines: unknown[] }>('/hub/machines');
    const machineList: unknown[] = Array.isArray(hm) ? hm : ((hm as any).machines || []);
    // Online-only: offline/stale/duplicate gateway registrations would show as 'v?' noise.
    const fleet = selectFleetNodes(machineList as any[], selfId, selfHostname);
    if (fleet.length > 0) nodes = fleet;
  } catch { /* hub not configured or unreachable — sweep self only */ }

  const rows = await Promise.all(
    nodes.map(async (m) => {
      const label = m.hostname || m.nodeId;
      try {
        let data: BuildData = {};
        if (m.isSelf) {
          data = await workerGet<BuildData>('/node/build').catch(() => ({}));
        } else {
          const { proxyGet } = require('../../data/peer-client') as typeof import('../../data/peer-client');
          // proxyGet carries no timeout — race it so a TCP-hung remote node
          // degrades to a '?' row in ~10s instead of stalling Promise.all ~75s.
          const raw = await Promise.race([
            proxyGet(m.nodeId, '/node/build') as Promise<unknown>,
            new Promise<unknown>((_, rej) => setTimeout(() => rej(new Error('timeout')), 10000)),
          ]).catch(() => null);
          data = ((raw as any)?.data ?? (raw as any)) || {};
        }
        return {
          node: label,
          version: data.current ?? '?',
          upgradedAt: data.upgradedAt ?? null,
        };
      } catch {
        return { node: label, version: '?', upgradedAt: null };
      }
    }),
  );

  return ok(formatBuilds(rows));
}

async function handleNodeBuilds(_args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    return await sweepNodes();
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

export const NODE_BUILDS_HANDLERS: Record<string, (args: Record<string, unknown>) => Promise<McpToolResult>> = {
  node_builds: handleNodeBuilds,
};
