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
import { sharedLiveOverlay, overlayDigest } from '../../mcp-server/registry/overlay-live';
import { createHash } from 'crypto';
import type { ToolRegistryDoc } from '../../mcp-server/registry/model';
import { coarseActor, type MissionActor } from '../../mission/mission-model';
import { thisNode } from '../../mission/mission-store';
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
    { method: 'GET', pattern: /^\/mcp-tools\/(?<name>[^/]+)\/history$/, handler: wrapped((req) => handleToolHistory(req.params.name, req.query ?? {})) },
    { method: 'POST', pattern: /^\/mcp-tools\/(?<name>[^/]+)\/rollback$/, handler: wrapped((req) => handleToolRollback(req.params.name, (req.body || {}) as Record<string, unknown>, undefined, undefined, realToolOriginAnchor())) },
    { method: 'GET', pattern: /^\/mcp-tools\/(?<name>[^/]+)$/, handler: wrapped((req) => handleToolGet(req.params.name)) },
    { method: 'POST', pattern: /^\/mcp-tools\/(?<name>[^/]+)$/, handler: wrapped((req) => handleToolSet(req.params.name, (req.body || {}) as Record<string, unknown>, undefined, undefined, realToolOriginAnchor())) },
  ];
}
