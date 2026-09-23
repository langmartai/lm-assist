/**
 * Propagate MCP capability changes (plugin tools appearing/disappearing) to this node's claude.ai
 * connectors WITHOUT restarting anything.
 *
 * Registration on lm-assist's own /mcp surface is already live (the aggregator is dynamic), but
 * claude.ai holds three more layers of per-account state that previously required a manual chain
 * (root-caused 2026-07-21 driving the chart-context e2e — each missing layer produced a different
 * failure):
 *
 *   1. connector tool CACHE   → stale list           ("TOOLS-MISSING")
 *   2. bootstrap refetch      → cache cleared but never re-read
 *   3. account tool ACCESS    → tool listed but not enabled for conversations
 *   4. per-tool auto-approve  → tool callable but "No approval received."
 *
 * A node can have SEVERAL claude.ai connectors: the unpinned `<base>/mcp` and one per profile at
 * `<base>/mcp/<profile>` (profile-connectors.ts). This runs the chain against EVERY one of them,
 * found by URL (never a name regex), and each gets only the added tools ITS profile advertises —
 * a `basic` connector never advertises `ext__` tools, so enabling a plugin leaves it alone. Tool
 * access + auto-approve for all of them go out as ONE batched, serialized read-modify-write of the
 * account's enabled_mcp_tools (POST /claude-ai/mcp/tool-settings/batch). Safe to re-run. On a node
 * with no claude.ai cookie the listing fails and nothing else runs; callers treat that as
 * "propagation deferred", not an error (another node's sync, or a manual
 * POST /mcp-plugins/sync-connector, can do it).
 */
import { workerGetLong, workerPost, workerPostLong } from '../tools/_passthrough';
import { mcpBase, ourConnectors, preferredConnector, type ConnectorLike } from '../profile-connectors';
import { applyProfileToToolDefs, resolveEffectiveProfile } from '../registry/profiles';

export interface ConnectorSyncStep {
  step: 'resolve-connector' | 'clear-cache' | 'bootstrap-refetch' | 'tool-access' | 'auto-approve';
  ok: boolean;
  detail?: string;
  /** The connector (label) the step ran against, when it ran against one. */
  connector?: string;
}

export interface ConnectorSyncTarget {
  uuid: string;
  label: string;
  /** The profile its URL pins; null = the unpinned `/mcp` connector. */
  profile: string | null;
  /** The profile its tools/list is filtered by (the node default for an unpinned one). */
  effectiveProfile: string;
  connected: boolean;
  /** The added tools THIS connector advertises. */
  added: string[];
  /** Whether every one of `added` is in its refetched tool list; undefined when none were added. */
  toolsListed?: boolean;
  /** false = it advertises none of the changed tools, so it was left alone. */
  touched: boolean;
}

export interface ConnectorSyncResult {
  ok: boolean;
  /** The preferred connector (unpinned, else admin, else the widest) — for callers that show one. */
  connector?: { uuid: string; label: string };
  /** Every connector of this node the pass considered. */
  connectors?: ConnectorSyncTarget[];
  /** true when every touched connector lists its added tools after the refetch. */
  toolsListed?: boolean;
  steps: ConnectorSyncStep[];
}

type ServerEntry = ConnectorLike & { uuid: string; tools?: string[] };

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
/** The org bootstrap behind /claude-ai/mcp/servers may take up to its own 30 s abort; the default
 *  loopback GET gives up at 15 s. This runs in the background, with no relay deadline to meet. */
const LIST_TIMEOUT_MS = 35_000;
/** The batch reads the bootstrap (≤30 s), then the account map, then PATCHes it. */
const BATCH_TIMEOUT_MS = 75_000;

/** The names out of `names` that `profileName` advertises. */
function advertisedUnder(names: string[], profileName: string): string[] {
  if (names.length === 0) return [];
  return applyProfileToToolDefs(names.map((name) => ({ name })), profileName).map((d) => d.name);
}

async function listServers(): Promise<ServerEntry[]> {
  const list = await workerGetLong<{ servers?: ServerEntry[] }>('/claude-ai/mcp/servers', LIST_TIMEOUT_MS);
  return (list.servers || []).filter((s) => typeof s.uuid === 'string' && s.uuid.length > 0);
}

export async function syncConnectorForPluginTools(opts: {
  /** Namespaced tool names that just became available (ext__<plugin>__<tool>). */
  addedTools?: string[];
  /** Namespaced tool names that just went away (plugin disabled/removed). */
  removedTools?: string[];
  /** Also mark added tools "always allow" so driven calls skip the approval
   *  gate. Default true: enabling the plugin was already a loopback human
   *  action, and without this every driven call dies "No approval received." */
  autoApprove?: boolean;
}): Promise<ConnectorSyncResult> {
  const steps: ConnectorSyncStep[] = [];
  const added = (opts.addedTools || []).filter(Boolean);
  const removed = (opts.removedTools || []).filter(Boolean);
  const autoApprove = opts.autoApprove !== false;

  // 0. Which claude.ai connectors are THIS node's — by URL, all of them.
  const base = mcpBase();
  if (!base) {
    steps.push({ step: 'resolve-connector', ok: false, detail: 'no hub configured on this node, so no claude.ai connector can point at it' });
    return { ok: false, steps };
  }
  let servers: ServerEntry[];
  try {
    servers = await listServers();
  } catch (e) {
    steps.push({ step: 'resolve-connector', ok: false, detail: errText(e) });
    return { ok: false, steps };
  }
  const mine = ourConnectors(servers, base);
  if (mine.length === 0) {
    steps.push({
      step: 'resolve-connector',
      ok: false,
      detail: servers.length === 0
        ? 'no claude.ai MCP connectors found (cookie not configured on this node?)'
        : `no claude.ai connector points at ${base}/mcp or ${base}/mcp/<profile> — create one with POST /mcp/profile-connectors`,
    });
    return { ok: false, steps };
  }
  const pref = preferredConnector(mine)!;
  const connector = { uuid: pref.uuid, label: pref.name || pref.uuid };

  const targets: ConnectorSyncTarget[] = mine.map((c) => {
    // Unpinned → the node default; pinned → its pin (an unknown pin falls back to the default,
    // exactly as the node serves it).
    const effectiveProfile = resolveEffectiveProfile(c.profile).name;
    const cAdded = advertisedUnder(added, effectiveProfile);
    const cRemoved = advertisedUnder(removed, effectiveProfile);
    // No tool names at all = a plain "refresh everything" pass: touch every connector.
    const touched = cAdded.length > 0 || cRemoved.length > 0 || (added.length === 0 && removed.length === 0);
    return {
      uuid: c.uuid, label: c.name || c.uuid, profile: c.profile, effectiveProfile,
      connected: c.connected !== false, added: cAdded, touched,
    };
  });
  for (const t of targets) {
    steps.push({
      step: 'resolve-connector', ok: true, connector: t.label,
      detail: `${t.label} (${t.uuid}) · profile ${t.effectiveProfile}${t.profile === null ? ' (node default)' : ''}` +
        (t.touched ? '' : ' · advertises none of the changed tools — left alone'),
    });
  }

  // 1. Clear claude.ai's cached tools/list for each touched connector.
  const cleared: ConnectorSyncTarget[] = [];
  for (const t of targets.filter((x) => x.touched)) {
    try {
      await workerPost(`/claude-ai/mcp/servers/${encodeURIComponent(t.uuid)}/clear-cache`, {});
      steps.push({ step: 'clear-cache', ok: true, connector: t.label });
      cleared.push(t);
    } catch (e) {
      steps.push({ step: 'clear-cache', ok: false, connector: t.label, detail: errText(e) });
    }
  }
  if (cleared.length === 0) return { ok: steps.every((s) => s.ok), connector, connectors: targets, steps };

  // 2. Refetch NOW (listing reads the org bootstrap, which makes claude.ai re-pull tools/list for
  //    each cleared connector) and check each connector against ITS OWN tool list — not the whole
  //    org stream, where a tool listed on any other connector would pass.
  try {
    const after = await listServers();
    const toolsOf = new Map(after.map((s) => [s.uuid, new Set(s.tools || [])]));
    for (const t of cleared) {
      if (t.added.length === 0) continue;
      const have = toolsOf.get(t.uuid) || new Set<string>();
      t.toolsListed = t.added.every((n) => have.has(n));
    }
    const withAdds = cleared.filter((t) => t.added.length > 0);
    steps.push({
      step: 'bootstrap-refetch', ok: true,
      detail: withAdds.length ? withAdds.map((t) => `${t.label}: added tools listed ${t.toolsListed}`).join('; ') : 'refetched',
    });
  } catch (e) {
    steps.push({ step: 'bootstrap-refetch', ok: false, detail: errText(e) });
  }

  // 3 + 4. Tool access (+ auto-approve) for every cleared connector's added tools — ONE batched,
  //        serialized read-modify-write. A not-connected connector lists no tool objects, so it
  //        gets access keys (inert until it connects) but no auto-approve.
  const withAdds = cleared.filter((t) => t.added.length > 0);
  if (withAdds.length) {
    const updates = withAdds.map((t) => ({
      connectorUuid: t.uuid,
      access: Object.fromEntries(t.added.map((n) => [n, true])),
      ...(autoApprove && t.connected ? { autoApprove: { enable: true, tools: t.added } } : {}),
    }));
    try {
      const r = await workerPostLong<{ results?: Array<{ connectorUuid: string; approved?: string[]; error?: string }> }>(
        '/claude-ai/mcp/tool-settings/batch', { updates }, BATCH_TIMEOUT_MS);
      const results = r.results || [];
      const labelOf = (uuid: string) => targets.find((t) => t.uuid === uuid)?.label || uuid;
      steps.push({
        step: 'tool-access', ok: true,
        detail: `enabled ${withAdds.reduce((n, t) => n + t.added.length, 0)} on ${withAdds.length} connector(s)`,
      });
      if (autoApprove) {
        const bad = results.filter((x) => x.error);
        steps.push({
          step: 'auto-approve', ok: bad.length === 0,
          detail: bad.length
            ? bad.map((x) => `${labelOf(x.connectorUuid)}: ${x.error}`).join('; ')
            : `approved ${results.reduce((n, x) => n + (x.approved?.length || 0), 0)}`,
        });
      }
    } catch (e) {
      steps.push({ step: 'tool-access', ok: false, detail: errText(e) });
      if (autoApprove) steps.push({ step: 'auto-approve', ok: false, detail: 'skipped: the batched write failed' });
    }
  }

  const listed = cleared.filter((t) => t.toolsListed !== undefined);
  const toolsListed = listed.length === 0 ? undefined : listed.every((t) => t.toolsListed === true);
  return { ok: steps.every((s) => s.ok), connector, connectors: targets, toolsListed, steps };
}
