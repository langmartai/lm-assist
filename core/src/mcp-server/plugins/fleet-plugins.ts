/**
 * Fleet node-affinity for third-party plugin tools (ext__<plugin>__<tool>).
 *
 * The hub routes connector MCP traffic to the MOST-RECENTLY-CONNECTED worker,
 * so after any fleet deploy a node WITHOUT a given plugin can end up serving
 * both tools/list and tools/call. Observed 2026-07-21: the connector called
 * ext__chart-context__get_view_summary on a plugin-less node and got
 * '⛔ no plugin named "chart-context" is installed' while the owning node
 * showed it enabled.
 *
 * This module makes routing irrelevant:
 *  - fleetExtToolDefs(): remote ext__ tool defs from every online peer's
 *    /mcp-plugins/tool-defs (LOCAL-only on each node — that is the ownership
 *    signal), merged into this node's /mcp tools/list.
 *  - callExtToolFleetAware(): run locally when the plugin is here; otherwise
 *    forward ONE hop to the owner via POST /mcp-plugins/call {noForward:true}.
 *    The receiving node never forwards a noForward call — loop-proof.
 *
 * Failure posture: every peer probe is timeboxed and fail-open; with no
 * reachable owner the local aggregator produces its normal "not installed"
 * error. A short negative cache keeps a down peer from adding latency to
 * every tools/list.
 */
import { proxyGet, proxyPost, listAllOnlineNodeIds } from '../../data/peer-client';
import { getPluginAggregator, type NamespacedToolDef } from './aggregator';
import { parseToolName } from './model';
import type { McpToolResult } from '../configure';

export interface FleetPluginDeps {
  listNodes(): Promise<string[]>;
  /** GET a peer's LOCAL /mcp-plugins/tool-defs. */
  fetchDefs(node: string): Promise<unknown>;
  /** POST a peer's /mcp-plugins/call. */
  postCall(node: string, body: unknown): Promise<unknown>;
  selfNode(): string | null;
  localDefs(): Promise<NamespacedToolDef[]>;
  localCall(tool: string, args: Record<string, unknown>): Promise<McpToolResult>;
  now(): number;
}

const PROBE_TIMEOUT_MS = 5_000;
const CACHE_TTL_MS = 45_000;
const NEGATIVE_TTL_MS = 20_000;

function timebox<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, rej) => setTimeout(() => rej(new Error('peer probe timeout')), ms).unref?.()),
  ]) as Promise<T>;
}

function defaultDeps(): FleetPluginDeps {
  return {
    listNodes: () => listAllOnlineNodeIds(),
    fetchDefs: (node) => timebox(proxyGet(node, '/mcp-plugins/tool-defs'), PROBE_TIMEOUT_MS),
    postCall: (node, body) => timebox(proxyPost(node, '/mcp-plugins/call', body), PROBE_TIMEOUT_MS * 6),
    selfNode: () => {
      try {
        // Lazy require avoids a hub-client import cycle at module load.
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { getHubClient } = require('../../hub-client') as { getHubClient(): { getGatewayId(): string | null } };
        return getHubClient().getGatewayId();
      } catch { return null; }
    },
    localDefs: () => getPluginAggregator().listToolDefs(),
    localCall: (tool, args) => getPluginAggregator().call(tool, args) as Promise<McpToolResult>,
    now: () => Date.now(),
  };
}

interface FleetCache {
  ts: number;
  /** namespaced tool name → owning node gatewayId */
  owners: Map<string, string>;
  defs: NamespacedToolDef[];
  negative: boolean;
}

let _cache: FleetCache | null = null;
let _deps: FleetPluginDeps | null = null;

/** Test seam: inject deps + reset cache. */
export function _configureFleetPlugins(deps: FleetPluginDeps | null): void {
  _deps = deps;
  _cache = null;
}

function deps(): FleetPluginDeps {
  return _deps || defaultDeps();
}

function parseDefsPayload(raw: unknown): NamespacedToolDef[] {
  // Peer responses arrive as the route envelope {success,data:{tools:[...]}} or bare {tools:[...]}.
  const body = (raw && typeof raw === 'object' && 'data' in (raw as Record<string, unknown>))
    ? (raw as Record<string, unknown>).data : raw;
  const tools = (body && typeof body === 'object') ? (body as Record<string, unknown>).tools : undefined;
  if (!Array.isArray(tools)) return [];
  return tools
    .filter((t): t is Record<string, unknown> => !!t && typeof t === 'object' && typeof (t as Record<string, unknown>).name === 'string')
    .map((t) => ({
      name: String(t.name),
      description: typeof t.description === 'string' ? t.description : '',
      inputSchema: (t.inputSchema && typeof t.inputSchema === 'object' ? t.inputSchema : { type: 'object' }) as Record<string, unknown>,
    }));
}

async function refreshCache(): Promise<FleetCache> {
  const d = deps();
  const self = d.selfNode();
  let nodes: string[] = [];
  let listFailed = false;
  try { nodes = (await d.listNodes()).filter((n) => n && n !== self); } catch { listFailed = true; }

  const owners = new Map<string, string>();
  const defs: NamespacedToolDef[] = [];
  let anyReached = false;

  await Promise.all(nodes.map(async (node) => {
    try {
      const remote = parseDefsPayload(await d.fetchDefs(node));
      anyReached = true;
      for (const t of remote) {
        if (!owners.has(t.name)) {
          owners.set(t.name, node);
          defs.push(t);
        }
      }
    } catch { /* peer down/slow — fail open */ }
  }));

  // Negative (short-TTL) cache when we could not see the fleet at all: the
  // roster fetch failed, or every peer probe failed. An empty-but-healthy
  // fleet (no peers, or peers with no plugins) caches positively.
  const negative = listFailed || (nodes.length > 0 && !anyReached);
  _cache = { ts: d.now(), owners, defs, negative };
  return _cache;
}

async function currentCache(): Promise<FleetCache> {
  const d = deps();
  const c = _cache;
  if (c && d.now() - c.ts < (c.negative ? NEGATIVE_TTL_MS : CACHE_TTL_MS)) return c;
  return refreshCache();
}

/** Remote-owned ext tool defs to merge into THIS node's /mcp tools/list
 *  (local defs win on a name clash — the caller merges local first). */
export async function fleetExtToolDefs(): Promise<NamespacedToolDef[]> {
  try {
    const local = new Set((await deps().localDefs()).map((t) => t.name));
    return (await currentCache()).defs.filter((t) => !local.has(t.name));
  } catch {
    return [];
  }
}

/** Run an ext__ tool with node affinity: locally when this node owns the
 *  plugin, else one forwarded hop to the owner. `noForward` marks an already-
 *  forwarded call — it must execute (or fail) locally, never bounce again. */
export async function callExtToolFleetAware(
  name: string,
  args: Record<string, unknown>,
  opts: { noForward?: boolean } = {},
): Promise<McpToolResult> {
  const d = deps();
  const parsed = parseToolName(name);
  if (!parsed) return d.localCall(name, args);

  let localHas = false;
  try { localHas = (await d.localDefs()).some((t) => t.name === name); } catch { /* treat as absent */ }
  if (localHas || opts.noForward) return d.localCall(name, args);

  let owner: string | undefined;
  try { owner = (await currentCache()).owners.get(name); } catch { owner = undefined; }
  if (!owner) return d.localCall(name, args); // yields the aggregator's proper "not installed" error

  try {
    const raw = await d.postCall(owner, { tool: name, args, noForward: true });
    const body = (raw && typeof raw === 'object' && 'data' in (raw as Record<string, unknown>))
      ? (raw as Record<string, unknown>).data : raw;
    if (body && typeof body === 'object' && Array.isArray((body as Record<string, unknown>).content)) {
      const r = body as unknown as McpToolResult;
      return {
        ...r,
        content: [
          ...r.content,
          { type: 'text', text: `\n⟦ext tool executed on ${owner} (plugin owner)⟧` },
        ],
      };
    }
    return { content: [{ type: 'text', text: `forwarded ${name} to ${owner} but its reply was not a tool result` }], isError: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { content: [{ type: 'text', text: `⛔ "${name}" is owned by node ${owner} but forwarding failed: ${msg}` }], isError: true };
  }
}
