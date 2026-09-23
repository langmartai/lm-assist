/** MCP tool registry routes (spec §4.5) — the /mcp-tools management surface behind
 *  the web page. Bare {success,data}/{success,error} envelopes (mission.routes idiom).
 *
 *  Reads are LOCAL: this node's advertised tools are defined by ITS code, and the
 *  registry replica syncs fleet-wide — no leader anchoring (deliberate deviation
 *  from mission reads, documented in the design brief).
 *  Writes are ORIGIN-anchored exactly like the workflow registry: the dataset is
 *  writable only on its origin node (READ_ONLY_REPLICA elsewhere), so set/rollback
 *  proxy to the origin with the `_originHop` loop guard and fail CLOSED when the
 *  origin is unreachable — a silent local fallback would be the silent-drop defect
 *  the workflow arc fixed. */
import type { RouteHandler, RouteContext } from '../index';
import { wrapResponse, wrapError } from '../../api/helpers';
import {
  getToolDoc, listToolDocs, putToolDoc, rollbackToolDoc,
  TOOL_REGISTRY_DATASET, type ToolRegistryPort,
} from '../../mcp-server/registry/store';
import { getToolCatalog, handlerSourceFor, CATEGORY_ORDER, type ToolCatalogEntry } from '../../mcp-server/registry/catalog';
import { overlayFromDocs } from '../../mcp-server/registry/overlay';
import { invalidateOverlayCache } from '../../mcp-server/registry/overlay-live';
import { currentToolsRev } from '../../mcp-server/registry/tools-rev';
import {
  PROFILE_DEFINITIONS, activeProfileName, readProfileState,
  resolveProfileTools, unmatchedSelectors, knownSelectors,
  canonicalProfileName, isValidPinSyntax,
} from '../../mcp-server/registry/profiles';
import { profileReport, setNodeDefaultProfile } from '../../mcp-server/registry/profile-report';
import {
  mcpBase, connectorUrlFor, connectorNameFor, hubLabelFor, ourConnectors, type ConnectorLike,
} from '../../mcp-server/profile-connectors';
import { listMcpRemoteServers, createMcpRemoteServer, deleteMcpRemoteServer } from '../../utils/claudeai-session';
import { sharedLiveOverlay, overlayDigest } from '../../mcp-server/registry/overlay-live';
import { createHash } from 'crypto';
import type { ToolRegistryDoc } from '../../mcp-server/registry/model';
import { coarseActor, type MissionActor } from '../../mission/mission-model';
import { thisNode } from '../../mission/mission-store';
import { getPluginAggregator } from '../../mcp-server/plugins/aggregator';
import { anchorToOrigin, realOriginAnchor, type OriginAnchorDeps } from './origin-anchor';

interface Envelope { success: boolean; data?: unknown; error?: { code: string; message: string } }
const ok = <T>(data: T): Envelope => ({ success: true, data });
const fail = (code: string, message: string): Envelope => ({ success: false, error: { code, message } });

// --- origin-anchoring (the registry lives on its dataset's ORIGIN node) ---
// Shared implementation in origin-anchor.ts (this file's improved variant, extracted
// so the assist-content registry doesn't fork a third copy).

export type ToolOriginAnchorDeps = OriginAnchorDeps;

export function realToolOriginAnchor(): ToolOriginAnchorDeps {
  return realOriginAnchor(TOOL_REGISTRY_DATASET);
}

const TOOL_ANCHOR_LABEL = 'tool-registry';

// --- testable handlers (port-injected) ---

function apiActor(b: Record<string, unknown>): MissionActor {
  delete (b as Record<string, unknown>)._actor; // transport hint — never persisted
  return coarseActor('api', thisNode(), Date.now());
}

/** One list row: the code-owned defaults joined with the registry delta (if any). */
function toolRow(e: ToolCatalogEntry, doc: ToolRegistryDoc | null) {
  const defaultDescription = (e.def as { description?: string }).description ?? '';
  return {
    name: e.name,
    category: e.category,
    module: e.module,
    scope: e.scope,
    protected: e.protected,
    defaultDescription,
    effectiveDescription: doc?.descriptionOverride ?? defaultDescription,
    enabled: doc?.enabled ?? true,
    hasOverride: doc?.descriptionOverride != null,
    ...(doc ? { rev: doc.rev, lastUpdatedBy: doc.lastUpdatedBy, updatedAt: doc.updatedAt } : {}),
  };
}

/**
 * The staleness stamp: this process's counter PLUS a digest of the effective
 * overlay.
 *
 * The counter alone is not enough. Registry writes are ORIGIN-anchored, so a
 * write lands on the origin node and reaches every other node by SYNC — a
 * replica's tools/list changes with no local write to bump anything, and its
 * clients would never be told. Measured on stage: a write proxied to the origin
 * left this node's rev untouched through the whole change.
 *
 * Reads through the TTL-cached live provider, so polling it is cheap.
 */
export async function composedToolsRev(): Promise<string> {
  let digest = 'na';
  try {
    digest = createHash('sha1').update(overlayDigest(await sharedLiveOverlay().get())).digest('hex').slice(0, 8);
  } catch { /* fail-open: the counter still tracks local writes */ }
  return `${currentToolsRev()}.${digest}`;
}

export async function handleToolList(port?: ToolRegistryPort): Promise<Envelope> {
  const catalog = getToolCatalog();
  let docs: ToolRegistryDoc[] = [];
  try { docs = await listToolDocs(port as ToolRegistryPort); } catch { docs = []; }
  const byName = new Map(docs.map((d) => [d.name, d]));
  const tools = [...catalog.values()].map((e) => toolRow(e, byName.get(e.name) ?? null));
  const orphanDocs = docs.filter((d) => !catalog.has(d.name));
  return ok({
    tools,
    orphanDocs,
    categories: CATEGORY_ORDER,
    counts: {
      tools: tools.length,
      overridden: tools.filter((t) => t.hasOverride).length,
      disabled: tools.filter((t) => !t.enabled).length,
      orphans: orphanDocs.length,
    },
  });
}

/** Minimal {byName} map — the stdio transport's overlay fetch (spec §4.4). */
export async function handleToolOverlay(port?: ToolRegistryPort): Promise<Envelope> {
  let docs: ToolRegistryDoc[] = [];
  try { docs = await listToolDocs(port as ToolRegistryPort); } catch { docs = []; }
  return ok(overlayFromDocs(docs));
}

export async function handleToolGet(name: string, port?: ToolRegistryPort): Promise<Envelope> {
  const entry = getToolCatalog().get(name) ?? null;
  let doc: ToolRegistryDoc | null = null;
  try { doc = await getToolDoc(name, port as ToolRegistryPort); } catch { doc = null; }
  if (!entry && !doc) return fail('NOT_FOUND', `no advertised tool or registry doc named "${name}"`);
  if (!entry) {
    // Orphan doc: registered name this build doesn't advertise (mixed-version fleet
    // or an e2e scratch doc). Manageable, but has no code-side def/implementation.
    return ok({ name, knownTool: false, doc, def: null, implementation: null });
  }
  const impl = handlerSourceFor(name);
  return ok({
    ...toolRow(entry, doc),
    knownTool: true,
    def: entry.def,
    doc,
    implementation: impl ? { module: impl.module, handlerSource: impl.source } : null,
  });
}

export async function handleToolSet(
  name: string, b: Record<string, unknown>,
  port?: ToolRegistryPort, actor?: MissionActor, origin?: ToolOriginAnchorDeps,
): Promise<Envelope> {
  const hopped = b._originHop === true;
  delete b._originHop;
  const anchored = hopped ? null : await anchorToOrigin(origin, `/mcp-tools/${encodeURIComponent(name)}`, b, TOOL_ANCHOR_LABEL);
  if (anchored) return anchored;
  const who = actor ?? apiActor(b);
  const input: { name: string; descriptionOverride?: string | null; enabled?: boolean } = { name };
  if (b.descriptionOverride !== undefined) {
    if (b.descriptionOverride !== null && typeof b.descriptionOverride !== 'string') {
      return fail('INVALID_INPUT', 'descriptionOverride must be a string or null');
    }
    input.descriptionOverride = b.descriptionOverride as string | null;
  }
  if (b.enabled !== undefined) {
    // Strict: silently coercing 1/'True'/'yes' to FALSE would write a disable when an
    // enable was asked for. Strings allowed because connector args arrive stringly-typed.
    if (typeof b.enabled === 'boolean') input.enabled = b.enabled;
    else if (b.enabled === 'true' || b.enabled === 'false') input.enabled = b.enabled === 'true';
    else return fail('INVALID_INPUT', `enabled must be a boolean (or "true"/"false"), got ${JSON.stringify(b.enabled)}`);
  }
  try {
    const r = await putToolDoc(input, who, port as ToolRegistryPort);
    invalidateOverlayCache(); // a local write must reach tools/list on the very next request
    return ok({ doc: r.doc, changed: r.changed, knownTool: getToolCatalog().has(name) });
  } catch (e) {
    return fail((e as { code?: string }).code ?? 'INVALID_INPUT', (e as Error).message);
  }
}

export async function handleToolHistory(
  name: string, _opts: Record<string, unknown>, port?: ToolRegistryPort,
): Promise<Envelope> {
  let doc: ToolRegistryDoc | null = null;
  try { doc = await getToolDoc(name, port as ToolRegistryPort); } catch { doc = null; }
  return ok({ history: [...(doc?.history ?? [])].reverse() });
}

export async function handleToolRollback(
  name: string, b: Record<string, unknown>,
  port?: ToolRegistryPort, actor?: MissionActor, origin?: ToolOriginAnchorDeps,
): Promise<Envelope> {
  const hopped = b._originHop === true;
  delete b._originHop;
  const anchored = hopped ? null : await anchorToOrigin(origin, `/mcp-tools/${encodeURIComponent(name)}/rollback`, b, TOOL_ANCHOR_LABEL);
  if (anchored) return anchored;
  const who = actor ?? apiActor(b);
  const toRevRaw = b.toRev;
  const toRev = typeof toRevRaw === 'number' ? toRevRaw : parseInt(String(toRevRaw ?? ''), 10);
  if (Number.isNaN(toRev)) return fail('INVALID_INPUT', 'toRev (number) is required');
  try {
    const r = await rollbackToolDoc(name, toRev, who, port as ToolRegistryPort);
    if ('error' in r) return fail(r.error.code, r.error.message);
    invalidateOverlayCache();
    return ok({ doc: r.doc });
  } catch (e) {
    return fail((e as { code?: string }).code ?? 'INVALID_INPUT', (e as Error).message);
  }
}

// --- route registration ---

/** Route-layer envelope→ApiResponse: handlers stay pure {success,data|error} (tested
 *  as such); the wire carries the repo-wide wrapResponse/wrapError shape with meta. */
function toApi(e: Envelope, start: number) {
  return e.success
    ? wrapResponse(e.data, start)
    : wrapError(e.error?.code ?? 'ERROR', e.error?.message ?? 'error', start);
}

/** GET /mcp-tools/profile — the node default, what else is available, what each costs, and this
 *  fleet's connector URL per profile.
 *
 *  REST carries no pin (it is the node's management surface), so `effective` === `nodeDefault`
 *  and `source` is always 'node-default' here. The fields exist so the UI, `mcp_profile` and
 *  GET /mcp/profile-connectors share one vocabulary. `active` STAYS: deployed panes and
 *  older UIs read it, and it is — and always was — the node default. */
export async function handleProfileGet(): Promise<Envelope> {
  // Built-ins AND the ext plugin tools. getToolCatalog() covers only the built-ins, so
  // counting from it alone made every `ext__*` selector match nothing — `platform`
  // (then named `langmart`) reported the same size as `basic` and the plugin list came
  // back empty, while the real tools/list was 33 tools larger. Fail-open, like tools/list.
  let extNames: string[] = [];
  try {
    extNames = (await getPluginAggregator().listToolDefs()).map((d) => d.name);
  } catch {
    extNames = [];
  }
  const advertised = [...getToolCatalog().keys(), ...extNames];
  const active = activeProfileName();
  const report = profileReport();
  return ok({
    active,
    setAt: readProfileState().setAt ?? null,
    setBy: readProfileState().setBy ?? null,
    effective: report.effective,
    source: report.source,
    pin: report.pin,
    nodeDefault: report.nodeDefault,
    connectors: report.connectors,
    selectors: knownSelectors(advertised),
    profiles: Object.entries(PROFILE_DEFINITIONS).map(([name, def]) => ({
      name,
      description: def.description,
      tools: resolveProfileTools(def, advertised).size,
      unmatchedSelectors: unmatchedSelectors(def, advertised),
      active: name === active,
    })),
  });
}

/** POST /mcp-tools/profile {profile} — set the NODE DEFAULT (unpinned clients only).
 *
 *  Deliberately NOT origin-anchored, unlike the per-tool set/rollback above. Those write
 *  a fleet-synced dataset and must land on its origin; this is NODE-LOCAL state, and a
 *  node must be able to change its own context budget even when every other machine is
 *  down. Anchoring it would also be wrong on the merits: dataset scope is cluster/fleet,
 *  so a shared doc would flip every node's tool surface at once.
 *
 *  The write, the tools-rev bump and the background refresh of UNPINNED claude.ai connectors
 *  all go through setNodeDefaultProfile — the same path `mcp_profile set` takes. */
export async function handleProfileSet(body: Record<string, unknown>, actor?: string): Promise<Envelope> {
  const name = typeof body.profile === 'string' ? body.profile.trim() : '';
  if (!name) return fail('INVALID_PROFILE', 'body.profile is required');
  let note: string;
  try {
    note = setNodeDefaultProfile(name, actor || 'rest').note;
  } catch (e) {
    return fail('UNKNOWN_PROFILE', e instanceof Error ? e.message : String(e));
  }
  const got = await handleProfileGet();
  return got.success ? ok({ ...(got.data as Record<string, unknown>), note }) : got;
}

// --- per-profile claude.ai connectors (spec §7.3) ---
// REST for these lives under /mcp/ (§7.3, amended d7a4d0c), NOT /mcp-tools/: an older Core has
// no /mcp/<x> catch-all (rest-server.ts special-cases only the exact path '/mcp'; every other
// /mcp/* route in mcp-api.routes.ts is a literal), so it answers a clean 404 instead of a mistaken
// Core reading POST /mcp-tools/profile-connectors as the registry's POST /mcp-tools/:name and
// minting a junk tool doc. The handlers stay in THIS file (their dependencies — profiles.ts,
// profile-connectors.ts, claudeai-session.ts — are already imported above); only the route
// patterns below are anchored to /mcp/profile-connectors.

/** The seam the connector handlers work through; tests inject a fake claude.ai roster. */
export interface ProfileConnectorDeps {
  /** THIS node's public MCP base ('' = no hub configured). */
  base(): string;
  /** claude.ai's connector roster for the account (throws when this node has no cookie). */
  listServers(): Promise<ConnectorLike[]>;
  createServer(url: string, name: string): Promise<{ status: number; body: unknown }>;
  deleteServer(uuid: string): Promise<{ status: number; body: unknown }>;
}

export function realProfileConnectorDeps(): ProfileConnectorDeps {
  return {
    base: () => mcpBase(),
    listServers: async () => {
      const r = await listMcpRemoteServers();
      if (r.status >= 400) throw new Error(`claude.ai responded ${r.status} ${r.statusText}`);
      return r.body.servers;
    },
    createServer: async (url, name) => {
      const r = await createMcpRemoteServer({ url, name });
      return { status: r.status, body: r.body };
    },
    deleteServer: async (uuid) => {
      const r = await deleteMcpRemoteServer(uuid);
      return { status: r.status, body: r.body };
    },
  };
}

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const NO_HUB = 'this node has no hub configured, so it has no public MCP URL for claude.ai to connect to';
const CONNECT_STEP =
  'Connect it once in a browser: claude.ai → Customize → Connectors → "Connect" on this connector ' +
  '(claude.ai generates the OAuth state in-page, so this step cannot be done server-side).';

/** A pinned profile as the node serves it (alias → canonical; an unknown pin stays as-is). */
const canonPin = (p: string): string => canonicalProfileName(p) ?? p;

/** The bounded view of one claude.ai connector — never its tool names. */
function connectorView(c: ConnectorLike | undefined) {
  if (!c) return null;
  return {
    uuid: c.uuid ?? null,
    name: c.name ?? '',
    connected: !!c.connected,
    authStatus: c.authStatus ?? null,
    toolCount: typeof c.toolCount === 'number' ? c.toolCount : null,
  };
}

/** claude.ai's create and the hub's client registration are both read-modify-writes, and
 *  concurrent registrations can lose a client — so create/delete run one at a time. */
let connectorWriteChain: Promise<unknown> = Promise.resolve();
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const run = connectorWriteChain.then(() => fn());
  connectorWriteChain = run.catch(() => undefined);
  return run;
}

/** GET /mcp/profile-connectors — per profile: its URL on this hub and its claude.ai
 *  connector (or null), plus the unpinned one. Bounded by construction: one row per profile. */
export async function handleProfileConnectorsList(deps: ProfileConnectorDeps = realProfileConnectorDeps()): Promise<Envelope> {
  const base = deps.base();
  if (!base) return fail('HUB_NOT_CONFIGURED', NO_HUB);
  let servers: ConnectorLike[] = [];
  let claudeai: { ok: boolean; error?: string } = { ok: true };
  try {
    servers = await deps.listServers();
  } catch (e) {
    // The URLs are still worth showing: they are what a user pastes into claude.ai by hand.
    claudeai = { ok: false, error: errMsg(e) };
  }
  const mine = ourConnectors(servers, base);
  const pinned = (profile: string) => mine.filter((c) => c.profile !== null && canonPin(c.profile) === profile);
  const unpinned = mine.filter((c) => c.profile === null);
  return ok({
    base,
    hub: hubLabelFor(base),
    nodeDefault: activeProfileName(),
    claudeai,
    unpinned: {
      url: connectorUrlFor(null, base),
      suggestedName: connectorNameFor(null, base),
      connector: connectorView(unpinned[0]),
      duplicates: Math.max(0, unpinned.length - 1),
    },
    profiles: Object.keys(PROFILE_DEFINITIONS).map((profile) => {
      const hits = pinned(profile);
      return {
        profile,
        url: connectorUrlFor(profile, base),
        suggestedName: connectorNameFor(profile, base),
        connector: connectorView(hits[0]),
        duplicates: Math.max(0, hits.length - 1),
      };
    }),
    // Pinned to a name this node does not know (a newer profile, a typo): it is served the node default.
    unknownPins: mine
      .filter((c) => c.profile !== null && !canonicalProfileName(c.profile))
      .map((c) => ({ profile: c.profile as string, url: c.url ?? '', connector: connectorView(c) })),
  });
}

/** POST /mcp/profile-connectors {profile} — idempotent by URL: an existing connector for
 *  that profile's URL is returned, otherwise one is registered on claude.ai as
 *  `lm-assist <hub> <profile>`. The OAuth Connect stays one browser step (named in `nextStep`). */
export async function handleProfileConnectorCreate(
  body: Record<string, unknown>, deps: ProfileConnectorDeps = realProfileConnectorDeps(),
): Promise<Envelope> {
  const known = Object.keys(PROFILE_DEFINITIONS).join(', ');
  const raw = typeof body.profile === 'string' ? body.profile.trim() : '';
  if (!raw) return fail('INVALID_PROFILE', `body.profile is required (one of: ${known})`);
  const profile = canonicalProfileName(raw);
  if (!profile) return fail('UNKNOWN_PROFILE', `unknown profile "${raw}". Known profiles: ${known}.`);
  const base = deps.base();
  if (!base) return fail('HUB_NOT_CONFIGURED', NO_HUB);
  const url = connectorUrlFor(profile, base);
  const name = connectorNameFor(profile, base);
  return serialized(async () => {
    let servers: ConnectorLike[];
    try {
      servers = await deps.listServers();
    } catch (e) {
      return fail('CLAUDEAI_UNAVAILABLE', errMsg(e));
    }
    const existing = ourConnectors(servers, base).find((c) => c.profile !== null && canonPin(c.profile) === profile);
    if (existing) {
      return ok({ created: false, profile, url: existing.url ?? url, connector: connectorView(existing), nextStep: existing.connected ? null : CONNECT_STEP });
    }
    let r: { status: number; body: unknown };
    try {
      r = await deps.createServer(url, name);
    } catch (e) {
      return fail('CLAUDEAI_UNAVAILABLE', errMsg(e));
    }
    if (r.status >= 400) {
      return fail(`UPSTREAM_${r.status}`, `claude.ai refused to create the connector: ${JSON.stringify(r.body ?? null).slice(0, 300)}`);
    }
    const b = (r.body && typeof r.body === 'object' ? r.body : {}) as Record<string, unknown>;
    let uuid = typeof b.uuid === 'string' ? b.uuid : null;
    if (!uuid) {
      // The create response's shape is claude.ai's, not ours: re-list once to name the new uuid.
      try {
        uuid = ourConnectors(await deps.listServers(), base).find((c) => c.profile !== null && canonPin(c.profile) === profile)?.uuid ?? null;
      } catch {
        /* it exists; its uuid shows on the next list */
      }
    }
    return ok({
      created: true, profile, url,
      connector: { uuid, name, connected: false, authStatus: null, toolCount: null },
      nextStep: CONNECT_STEP,
    });
  });
}

/** DELETE /mcp/profile-connectors/:profile — removes the claude.ai connector(s) pinned to
 *  that profile's URL. The unpinned connector is not deletable through this route. */
export async function handleProfileConnectorDelete(
  rawProfile: string, deps: ProfileConnectorDeps = realProfileConnectorDeps(),
): Promise<Envelope> {
  let seg = rawProfile;
  try { seg = decodeURIComponent(rawProfile); } catch { /* keep raw — the grammar check below refuses it */ }
  if (!isValidPinSyntax(seg)) {
    return fail('INVALID_PROFILE', `"${seg}" is not a profile name (want ^[a-z][a-z0-9-]{0,31}$). The unpinned connector is not deleted through this route.`);
  }
  const base = deps.base();
  if (!base) return fail('HUB_NOT_CONFIGURED', NO_HUB);
  const want = canonPin(seg);
  return serialized(async () => {
    let servers: ConnectorLike[];
    try {
      servers = await deps.listServers();
    } catch (e) {
      return fail('CLAUDEAI_UNAVAILABLE', errMsg(e));
    }
    const hits = ourConnectors(servers, base).filter(
      (c): c is typeof c & { uuid: string } => c.profile !== null && canonPin(c.profile) === want && typeof c.uuid === 'string',
    );
    if (hits.length === 0) return fail('NOT_FOUND', `no claude.ai connector points at ${connectorUrlFor(want, base)}`);
    const removed: Array<{ uuid: string; name: string }> = [];
    const failed: Array<{ uuid: string; error: string }> = [];
    for (const c of hits) {
      try {
        const r = await deps.deleteServer(c.uuid);
        if (r.status >= 400) failed.push({ uuid: c.uuid, error: `claude.ai responded ${r.status}` });
        else removed.push({ uuid: c.uuid, name: c.name ?? '' });
      } catch (e) {
        failed.push({ uuid: c.uuid, error: errMsg(e) });
      }
    }
    if (removed.length === 0) return fail('DELETE_FAILED', failed.map((f) => `${f.uuid}: ${f.error}`).join('; '));
    return ok({ profile: want, url: connectorUrlFor(want, base), removed, failed });
  });
}

export function createMcpToolsRoutes(_ctx: RouteContext): RouteHandler[] {
  const wrapped = (run: (req: Parameters<RouteHandler['handler']>[0]) => Promise<Envelope>): RouteHandler['handler'] =>
    async (req) => { const start = Date.now(); return toApi(await run(req), start); };
  return [
    // literals MUST precede the /:name patterns
    { method: 'GET', pattern: /^\/mcp-tools$/, handler: wrapped(() => handleToolList()) },
    { method: 'GET', pattern: /^\/mcp-tools\/overlay$/, handler: wrapped(() => handleToolOverlay()) },
    // The staleness stamp the (separate-process) MCP servers poll. Deliberately
    // trivial — an in-memory counter, no store access — because every connected
    // MCP process hits it on an interval.
    { method: 'GET', pattern: /^\/mcp-tools\/rev$/, handler: wrapped(async () => ok({ rev: await composedToolsRev() })) },
    // Must precede the /(?<name>)/ patterns below, which would otherwise match "profile"
    // as a tool name — the same reason /overlay and /rev sit up here.
    { method: 'GET', pattern: /^\/mcp-tools\/profile$/, handler: wrapped(() => handleProfileGet()) },
    { method: 'POST', pattern: /^\/mcp-tools\/profile$/, handler: wrapped((req) => handleProfileSet((req.body || {}) as Record<string, unknown>)) },
    { method: 'GET', pattern: /^\/mcp-tools\/(?<name>[^/]+)\/history$/, handler: wrapped((req) => handleToolHistory(req.params.name, req.query ?? {})) },
    { method: 'POST', pattern: /^\/mcp-tools\/(?<name>[^/]+)\/rollback$/, handler: wrapped((req) => handleToolRollback(req.params.name, (req.body || {}) as Record<string, unknown>, undefined, undefined, realToolOriginAnchor())) },
    { method: 'GET', pattern: /^\/mcp-tools\/(?<name>[^/]+)$/, handler: wrapped((req) => handleToolGet(req.params.name)) },
    { method: 'POST', pattern: /^\/mcp-tools\/(?<name>[^/]+)$/, handler: wrapped((req) => handleToolSet(req.params.name, (req.body || {}) as Record<string, unknown>, undefined, undefined, realToolOriginAnchor())) },
    // Per-profile claude.ai connectors (spec §7.3, amended d7a4d0c): a DIFFERENT prefix
    // (/mcp/, not /mcp-tools/) on purpose — an older Core has no /mcp/<x> catch-all (only the
    // literal /mcp/* routes in mcp-api.routes.ts, plus the exact-path '/mcp' MCP-protocol
    // special-case in rest-server.ts), so it answers a clean 404 here instead of misrouting
    // into handleToolSet/handleToolGet above and minting a junk registry doc named
    // "profile-connectors". No ordering concern versus the /mcp-tools/(?<name>)/ patterns
    // above: different literal prefix, so these can sit anywhere in this file's route list.
    { method: 'GET', pattern: /^\/mcp\/profile-connectors$/, handler: wrapped(() => handleProfileConnectorsList()) },
    { method: 'POST', pattern: /^\/mcp\/profile-connectors$/, handler: wrapped((req) => handleProfileConnectorCreate((req.body || {}) as Record<string, unknown>)) },
    { method: 'DELETE', pattern: /^\/mcp\/profile-connectors\/(?<profile>[^/]+)$/, handler: wrapped((req) => handleProfileConnectorDelete(req.params.profile)) },
  ];
}
