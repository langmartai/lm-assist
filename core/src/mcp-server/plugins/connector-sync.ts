/**
 * Propagate MCP capability changes (plugin tools appearing/disappearing) to the
 * claude.ai connector WITHOUT restarting anything.
 *
 * Registration on lm-assist's own /mcp surface is already live (the aggregator
 * is dynamic), but claude.ai holds three more layers of per-account state that
 * previously required a manual chain (root-caused 2026-07-21 driving the
 * chart-context e2e — each missing layer produced a different failure):
 *
 *   1. connector tool CACHE   → stale list           ("TOOLS-MISSING")
 *   2. bootstrap refetch      → cache cleared but never re-read
 *   3. account tool ACCESS    → tool listed but not enabled for conversations
 *   4. per-tool auto-approve  → tool callable but "No approval received."
 *
 * syncConnectorForPluginTools() runs the full chain against the langmart
 * connector (auto-picked, same heuristic as the refresh_connector_tools MCP
 * tool) via the same cookie-backed claude.ai routes. Safe to re-run —
 * every step is idempotent read-modify-write on claude.ai's side. On a node
 * with no claude.ai cookie the first step fails and the rest are skipped;
 * callers treat that as "propagation deferred", not an error (another node's
 * sync, or a manual POST /mcp-plugins/sync-connector, can do it).
 */
import { workerGet, workerPost } from '../tools/_passthrough';

export interface ConnectorSyncStep {
  step: 'resolve-connector' | 'clear-cache' | 'bootstrap-refetch' | 'tool-access' | 'auto-approve';
  ok: boolean;
  detail?: string;
}

export interface ConnectorSyncResult {
  ok: boolean;
  connector?: { uuid: string; label: string };
  /** true when every added tool name was seen in the refetched bootstrap list */
  toolsListed?: boolean;
  steps: ConnectorSyncStep[];
}

interface ConnectorEntry { uuid: string; name?: string; url?: string }

async function pickLangmartConnector(): Promise<{ uuid: string; label: string } | { error: string }> {
  let servers: ConnectorEntry[];
  try {
    const list = (await workerGet('/claude-ai/mcp/servers')) as { servers?: ConnectorEntry[] };
    servers = list.servers || [];
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
  if (servers.length === 0) return { error: 'no claude.ai MCP connectors found (cookie not configured on this node?)' };
  const pick =
    servers.find((s) => /langmart/i.test(s.url || '') || /langmart/i.test(s.name || '')) ||
    (servers.length === 1 ? servers[0] : undefined);
  if (!pick) return { error: 'multiple connectors and none matches langmart — sync manually with the connector tools' };
  return { uuid: pick.uuid, label: pick.name || pick.uuid };
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
  const autoApprove = opts.autoApprove !== false;

  const conn = await pickLangmartConnector();
  if ('error' in conn) {
    steps.push({ step: 'resolve-connector', ok: false, detail: conn.error });
    return { ok: false, steps };
  }
  steps.push({ step: 'resolve-connector', ok: true, detail: `${conn.label} (${conn.uuid})` });

  // 1. Clear claude.ai's cached tools/list for the connector.
  try {
    await workerPost(`/claude-ai/mcp/servers/${encodeURIComponent(conn.uuid)}/clear-cache`, {});
    steps.push({ step: 'clear-cache', ok: true });
  } catch (e) {
    steps.push({ step: 'clear-cache', ok: false, detail: e instanceof Error ? e.message : String(e) });
    return { ok: false, connector: conn, steps };
  }

  // 2. Force the refetch NOW (reading the org mcp-bootstrap makes claude.ai
  //    re-pull tools/list from the hub) and verify the new tools appear.
  let toolsListed: boolean | undefined;
  try {
    const boot = await workerGet('/claude-ai/org/mcp-bootstrap');
    const s = JSON.stringify(boot);
    toolsListed = added.length === 0 ? undefined : added.every((t) => s.includes(t));
    steps.push({
      step: 'bootstrap-refetch',
      ok: true,
      detail: added.length ? `added tools listed: ${toolsListed}` : 'refetched',
    });
  } catch (e) {
    steps.push({ step: 'bootstrap-refetch', ok: false, detail: e instanceof Error ? e.message : String(e) });
  }

  // 3. Enable account-level tool access for the new tools (read-modify-write
  //    server-side; other tools/connectors preserved). Removed tools simply
  //    drop out of the refreshed list — their orphaned access keys are inert.
  if (added.length) {
    try {
      await workerPost(`/claude-ai/mcp/servers/${encodeURIComponent(conn.uuid)}/tool-access`, { enable: added, block: [] });
      steps.push({ step: 'tool-access', ok: true, detail: `enabled ${added.length}` });
    } catch (e) {
      steps.push({ step: 'tool-access', ok: false, detail: e instanceof Error ? e.message : String(e) });
    }
  }

  // 4. Auto-approve the new tools (per-version keys are resolved from the live
  //    bootstrap server-side, so this must run AFTER the refetch).
  if (added.length && autoApprove) {
    try {
      await workerPost(`/claude-ai/mcp/servers/${encodeURIComponent(conn.uuid)}/auto-approve`, { enable: true, tools: added });
      steps.push({ step: 'auto-approve', ok: true, detail: `approved ${added.length}` });
    } catch (e) {
      steps.push({ step: 'auto-approve', ok: false, detail: e instanceof Error ? e.message : String(e) });
    }
  }

  const ok = steps.every((s) => s.ok);
  return { ok, connector: conn, toolsListed, steps };
}
