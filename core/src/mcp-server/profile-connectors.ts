/**
 * This node's claude.ai connectors — one per tool-loading profile
 * (docs/superpowers/specs/2026-09-23-mcp-profile-connectors-design.md §7.1).
 *
 * A claude.ai connector is OURS when its URL is this node's public MCP endpoint:
 *   <base>/mcp            unpinned — advertises the node default profile
 *   <base>/mcp/<profile>  pinned   — advertises <profile>, whatever the node default is
 *
 * Identification is by URL, never by name. The name is cosmetic and user-editable, and the old
 * `/langmart/i` name pick took the FIRST of several per-profile connectors and, from a dev Core,
 * matched the production connector (one claude.ai account and cookie serve both hubs). `base`
 * defaults to THIS node's base, so a dev Core never touches production connectors and vice versa.
 *
 * mcpBase() reads the hub config file on every call. Nothing here may run on the tools/list /
 * initialize path (docs/mcp-surfaces.md); a caller there must pass `base` explicitly.
 */
import { mcpPublicBase } from './connectors';
import { isValidPinSyntax } from './registry/profiles';
import { workerGetLong, workerPost, workerPostLong } from './tools/_passthrough';

export interface ConnectorLike {
  uuid?: string;
  name?: string;
  url?: string;
  connected?: boolean;
  /** claude.ai reports null until the first Connect, so null is accepted. */
  authStatus?: string | null;
  toolCount?: number;
}

/** One of this node's connectors, tagged with the profile its URL pins (null = unpinned `/mcp`). */
export type OurConnector<T extends ConnectorLike = ConnectorLike> = T & { profile: string | null };

/** THIS node's public MCP base (e.g. `https://mcp.langmart.ai`), no trailing slash; '' when the
 *  node has no hub configured — then no connector can be ours. */
export function mcpBase(): string {
  return (mcpPublicBase() || '').replace(/\/+$/, '');
}

/** `<base>/mcp` for null, `<base>/mcp/<profile>` otherwise. Pure string building — callers
 *  validate the profile (isValidPinSyntax / canonicalProfileName) first. */
export function connectorUrlFor(profile: string | null, base: string = mcpBase()): string {
  const b = base.replace(/\/+$/, '');
  return profile ? `${b}/mcp/${profile}` : `${b}/mcp`;
}

/**
 * Is `url` this node's MCP endpoint, and which profile does it pin? Tolerates a trailing slash, a
 * differently-cased host and an explicit default port (URL() normalises both). The query is not
 * looked at: the public contract carries the pin in the PATH, so the hub serves `/mcp?profile=x`
 * as unpinned — and so do we.
 */
export function classifyConnectorUrl(url: string, base: string = mcpBase()): { ours: boolean; profile: string | null } {
  if (!url || !base) return { ours: false, profile: null };
  let u: URL;
  let b: URL;
  try {
    u = new URL(url);
    b = new URL(base);
  } catch {
    return { ours: false, profile: null };
  }
  if (u.protocol !== b.protocol || u.host !== b.host) return { ours: false, profile: null };
  const prefix = b.pathname.replace(/\/+$/, '');
  const p = u.pathname.replace(/\/+$/, '');
  if (p === `${prefix}/mcp`) return { ours: true, profile: null };
  const head = `${prefix}/mcp/`;
  if (!p.startsWith(head)) return { ours: false, profile: null };
  const seg = p.slice(head.length);
  // Grammar, not "known profile": a pin this node does not know (a newer profile, a typo) still
  // points at THIS hub and is served the node default — it is ours. `/mcp/connectors` (the hub's
  // control plane), nested paths and upper case all fail the grammar.
  if (!isValidPinSyntax(seg)) return { ours: false, profile: null };
  return { ours: true, profile: seg };
}

/** Every server in `servers` whose URL is this node's, each tagged with its profile. */
export function ourConnectors<T extends ConnectorLike>(servers: T[], base: string = mcpBase()): OurConnector<T>[] {
  const out: OurConnector<T>[] = [];
  for (const s of servers) {
    const c = classifyConnectorUrl(s.url || '', base);
    if (c.ours) out.push({ ...s, profile: c.profile });
  }
  return out;
}

/** The hub's short name for connector names: `https://mcp.langmart.ai` → `langmart`. */
export function hubLabelFor(base: string = mcpBase()): string {
  let host = '';
  try {
    host = new URL(base).hostname;
  } catch {
    return 'local';
  }
  if (!host.includes('.') || /^[\d.]+$/.test(host) || host.startsWith('[')) return 'local';
  const labels = host.split('.');
  return labels[labels.length - 2];
}

/** `lm-assist <hub>` for the unpinned connector, `lm-assist <hub> <profile>` for a pinned one. */
export function connectorNameFor(profile: string | null, base: string = mcpBase()): string {
  const hub = `lm-assist ${hubLabelFor(base)}`;
  return profile ? `${hub} ${profile}` : hub;
}

/** Deterministic pick when one connector is needed: the unpinned one, else `admin`, else the
 *  widest by toolCount (ties keep input order, so with no counts it is the first). */
export function preferredConnector<T extends ConnectorLike>(conns: OurConnector<T>[]): OurConnector<T> | undefined {
  if (conns.length === 0) return undefined;
  const unpinned = conns.find((c) => c.profile === null);
  if (unpinned) return unpinned;
  const admin = conns.find((c) => c.profile === 'admin');
  if (admin) return admin;
  let best = conns[0];
  for (const c of conns) if ((c.toolCount ?? -1) > (best.toolCount ?? -1)) best = c;
  return best;
}

// ── upkeep after a node-default change ─────────────────────────────────────────

const LOG = '[profile-connectors]';
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
/** The org bootstrap behind /claude-ai/mcp/servers may take up to its own 30 s abort; the default
 *  loopback GET gives up at 15 s. Background upkeep has no relay deadline to meet. */
const LIST_TIMEOUT_MS = 35_000;
/** The batch reads the bootstrap (≤30 s), then the account map, then PATCHes it. */
const BATCH_TIMEOUT_MS = 75_000;

/**
 * The node default changed, so what the UNPINNED connectors advertise changed with it, and
 * claude.ai caches tools/list per connector. Clear the cache of every unpinned connector of this
 * node. Then re-key its always-approve entries in ONE batched write: `carryForward` re-approves
 * exactly the tools that were approved under an older version hash, and never approves anything
 * new. Pinned connectors do not follow the node default and are left alone.
 *
 * Fire-and-forget: never throws, logs one line. Defers when this node holds no claude.ai cookie —
 * another node, or a manual refresh_connector_tools, can do it.
 */
export async function refreshUnpinnedConnectors(): Promise<void> {
  try {
    const base = mcpBase();
    if (!base) {
      console.log(`${LOG} unpinned refresh skipped: no hub configured on this node`);
      return;
    }
    let servers: ConnectorLike[];
    try {
      servers = (await workerGetLong<{ servers?: ConnectorLike[] }>('/claude-ai/mcp/servers', LIST_TIMEOUT_MS)).servers || [];
    } catch (e) {
      console.log(`${LOG} unpinned refresh deferred (no claude.ai access on this node): ${errText(e)}`);
      return;
    }
    const targets = ourConnectors(servers, base).filter(
      (c): c is OurConnector<ConnectorLike> & { uuid: string } =>
        c.profile === null && typeof c.uuid === 'string' && c.uuid.length > 0,
    );
    if (targets.length === 0) {
      console.log(`${LOG} unpinned refresh: no claude.ai connector points at ${base}/mcp`);
      return;
    }
    const cleared: string[] = [];
    for (const c of targets) {
      try {
        await workerPost(`/claude-ai/mcp/servers/${encodeURIComponent(c.uuid)}/clear-cache`, {});
        cleared.push(c.uuid);
      } catch (e) {
        console.warn(`${LOG} clear-cache failed for "${c.name || c.uuid}": ${errText(e)}`);
      }
    }
    if (cleared.length === 0) return;
    try {
      // The batch reads the bootstrap first, which is also what makes claude.ai re-fetch the
      // cleared connectors — so no separate refetch call is needed.
      await workerPostLong('/claude-ai/mcp/tool-settings/batch', {
        updates: cleared.map((connectorUuid) => ({ connectorUuid, autoApprove: { enable: true, carryForward: true } })),
      }, BATCH_TIMEOUT_MS);
    } catch (e) {
      console.warn(`${LOG} always-approve re-key after refresh failed: ${errText(e)}`);
    }
    console.log(`${LOG} unpinned refresh: cleared ${cleared.length}/${targets.length} connector(s)`);
  } catch (e) {
    console.warn(`${LOG} unpinned refresh failed: ${errText(e)}`);
  }
}

// ── node-default change → refresh the unpinned connectors ──────────────────────

type UnpinnedRefresher = () => Promise<void> | void;
let testRefresher: UnpinnedRefresher | null = null;

/** Test seam: install a stand-in for the refresh; `null` restores the default. */
export function _setUnpinnedRefresherForTests(fn: UnpinnedRefresher | null): void {
  testRefresher = fn;
}

/**
 * The node default just changed. THE one hook for that: registry/profile-report.ts's
 * setNodeDefaultProfile (behind `mcp_profile set` and POST /mcp-tools/profile) calls it after the
 * file write and the tools-rev bump. The UNPINNED connectors now advertise a different surface and
 * claude.ai caches tools/list, so refresh them. Fire-and-forget: the profile write has already
 * succeeded and must not wait on, or fail with, claude.ai. Pinned connectors do not follow the
 * node default and are left alone.
 *
 * Under `node --test` (NODE_TEST_CONTEXT is set in every test-file child) the REAL refresh never
 * runs unless a test installed a refresher: a unit test that sets a profile must not clear the
 * cache of the operator's live claude.ai connector. (The plugin routes follow the same rule by
 * skipping the connector sync when a test injects its own `stateFile`.)
 */
export function onNodeDefaultProfileChanged(setBy?: string): void {
  const run = testRefresher ?? (process.env.NODE_TEST_CONTEXT ? null : refreshUnpinnedConnectors);
  if (!run) return;
  void Promise.resolve()
    .then(() => run())
    .catch((e) =>
      console.warn(`${LOG} unpinned refresh after a node-default change${setBy ? ` (by ${setBy})` : ''} failed: ${errText(e)}`),
    );
}
