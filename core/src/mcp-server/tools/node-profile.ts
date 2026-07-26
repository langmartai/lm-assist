/** Node-profile + node-selection MCP tools (proxy the /node-profiles and /node-select
 *  routes). Writes ride the `_actor` hint so the route attributes them to the precise
 *  caller session, like the backlog tools. */
import type { McpToolResult } from '../configure';
import { ok, workerGet, workerPost, workerPut } from './_passthrough';
import { currentMcpContext } from '../principal-context';
import { withActorHint } from './mission-query';

const S = { type: 'string' as const };
const STR_ARR = { type: 'array' as const, items: S };
const obj = (props: Record<string, unknown>, required: string[] = []) => ({ type: 'object' as const, properties: props, required });
const pretty = (v: unknown): McpToolResult => ok(JSON.stringify(v, null, 2));

export const nodeProfileToolDef = {
  name: 'node_profile',
  description:
    'READ or TEACH what a node is good and bad for — the fleet-synced `node-profiles` registry that ' +
    'node_select ranks on. Omit `node` to list every profile; pass `node` alone to read one; pass any ' +
    'of capabilities/avoid/weight/notes to WRITE (create-or-update; only the fields you send change, so ' +
    'recording one lesson never clobbers another session\'s). ' +
    '🔴 THIS REGISTRY IS TAUGHT BY YOU. When you discover that a node can or cannot do something — it ' +
    'holds an IP-pinned credential, its headless browser cannot navigate, it must never have a given ' +
    'service installed — WRITE IT BACK HERE so the next placement starts from that lesson instead of ' +
    'rediscovering it. Record ONLY what cannot be observed live: online status, platform, cluster, repos ' +
    'present and current load are read fresh at selection time and must not be duplicated here, because ' +
    'a stale placement fact is worse than a missing one. `capabilities`/`avoid` are lowercase tokens ' +
    'matched EXACTLY against a need (e.g. "claudeai-cookie", "browser-navigation"); `notes` is free prose ' +
    'read by agents. Keyed by hostId from list_nodes, never a hostname. Versioned — every write is a rev.',
  inputSchema: obj({
    node: { ...S, description: 'hostId/gatewayId (NOT hostname). Omit to list all profiles.' },
    capabilities: { ...STR_ARR, description: 'WRITE: lowercase tokens this node CAN serve, e.g. ["claudeai-cookie","elevated-worker"].' },
    avoid: { ...STR_ARR, description: 'WRITE: tokens this node must NOT be used for, e.g. ["browser-navigation"]. An avoid hit ELIMINATES the node for that need.' },
    weight: { type: 'number' as const, description: 'WRITE: tie-break preference, -100..100. 0 is neutral; negative de-prioritises without excluding.' },
    notes: { ...S, description: 'WRITE: the reasoning — WHY this node suits or does not suit certain work. Read by agents; never scored, so it cannot silently change automated placement.' },
  }),
};

export const nodeSelectToolDef = {
  name: 'node_select',
  description:
    'WHICH NODE should this work run on? Ranks the nodes in your cluster by combining LIVE facts ' +
    '(online, in-cluster, repos present, what is already running there via session_footprints) with the ' +
    'LEARNED `node-profiles` registry, and returns candidates ordered best-first — each with `why[]`, and ' +
    'every ELIMINATED node with `blockers[]` so "why not node X?" is always answerable. ' +
    'Pass `missionId` to rank for a mission (its repo/branch/resources become the need), or `need` tokens ' +
    'to ask standalone (e.g. need:["claudeai-cookie"]). The Mission Controller calls this before placing ' +
    'an executor. `recommended` is a suggestion, not a decision — read the candidates\' notes and reasons ' +
    'and override when you know better, then teach what you learned back via node_profile. Read-only.',
  inputSchema: obj({
    missionId: { ...S, description: 'Rank for this mission — its env.repo/branch/resources become the need.' },
    need: { ...STR_ARR, description: 'Capability tokens the work requires, e.g. ["claudeai-cookie","linux"]. Combined with the mission\'s own need when both are given.' },
    repo: { ...S, description: 'Absolute repo path the work must run in. A node whose EXHAUSTIVE inventory lacks it is eliminated.' },
    branch: { ...S, description: 'Branch the work will use — a node already holding it ranks higher (warm worktree).' },
    resources: { ...STR_ARR, description: 'Resource leases the work will take; an exclusive conflict eliminates the node.' },
  }),
};

export async function handleNodeProfile(a: Record<string, unknown>): Promise<McpToolResult> {
  const node = typeof a.node === 'string' && a.node.trim() ? a.node.trim() : '';
  const isWrite = ['capabilities', 'avoid', 'weight', 'notes'].some((k) => a[k] !== undefined);

  if (!node) {
    if (isWrite) {
      return pretty({
        error: 'NODE_REQUIRED',
        message: 'writing a profile needs `node` — the hostId/gatewayId from list_nodes (not the hostname). Three nodes in this fleet have shared a hostname; a display name is not an identity.',
      });
    }
    return pretty(await workerGet('/node-profiles'));
  }
  if (!isWrite) return pretty(await workerGet(`/node-profiles/${encodeURIComponent(node)}`));

  const body: Record<string, unknown> = {};
  for (const k of ['capabilities', 'avoid', 'weight', 'notes']) if (a[k] !== undefined) body[k] = a[k];
  return pretty(await workerPut(
    `/node-profiles/${encodeURIComponent(node)}`,
    withActorHint(body, currentMcpContext()?.toolUseId),
  ));
}

export async function handleNodeSelect(a: Record<string, unknown>): Promise<McpToolResult> {
  return pretty(await workerPost('/node-select', a));
}

export const NODE_PROFILE_TOOL_DEFS = [nodeProfileToolDef, nodeSelectToolDef] as const;

export const NODE_PROFILE_HANDLERS: Record<string, (args: Record<string, unknown>) => Promise<McpToolResult>> = {
  node_profile: handleNodeProfile,
  node_select: handleNodeSelect,
};
