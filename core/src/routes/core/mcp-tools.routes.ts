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
import {
  getToolDoc, listToolDocs, putToolDoc, rollbackToolDoc,
  TOOL_REGISTRY_DATASET, type ToolRegistryPort,
} from '../../mcp-server/registry/store';
import { getToolCatalog, handlerSourceFor, CATEGORY_ORDER, type ToolCatalogEntry } from '../../mcp-server/registry/catalog';
import { overlayFromDocs } from '../../mcp-server/registry/overlay';
import { invalidateOverlayCache } from '../../mcp-server/registry/overlay-live';
import type { ToolRegistryDoc } from '../../mcp-server/registry/model';
import { coarseActor, type MissionActor } from '../../mission/mission-model';
import { thisNode } from '../../mission/mission-store';

interface Envelope { success: boolean; data?: unknown; error?: { code: string; message: string } }
const ok = <T>(data: T): Envelope => ({ success: true, data });
const fail = (code: string, message: string): Envelope => ({ success: false, error: { code, message } });

// --- origin-anchoring (the registry lives on its dataset's ORIGIN node) ---

export interface ToolOriginAnchorDeps {
  getOrigin: () => Promise<string | null>;
  thisNode: () => string;
  proxyPost: (node: string, path: string, body: unknown) => Promise<unknown>;
}

export function realToolOriginAnchor(): ToolOriginAnchorDeps {
  return {
    getOrigin: async () => {
      const { getDatasetRegistry } = require('../../data/dataset-registry') as typeof import('../../data/dataset-registry');
      return getDatasetRegistry().get(TOOL_REGISTRY_DATASET)?.origin?.machineId ?? null;
    },
    thisNode: () => thisNode(),
    proxyPost: (n, p, b) => { const { proxyPost } = require('../../data/peer-client') as typeof import('../../data/peer-client'); return proxyPost(n, p, b); },
  };
}

/** Proxy a write to the dataset origin when it is another node; null ⇒ handle locally
 *  (owned here / unstamped / no deps). Fail-CLOSED on proxy errors. */
async function anchorToOrigin(origin: ToolOriginAnchorDeps | undefined, path: string, body: unknown): Promise<Envelope | null> {
  if (!origin) return null;
  let target: string | null;
  try { target = await origin.getOrigin(); } catch { return null; }
  if (!target || target === origin.thisNode()) return null;
  try {
    // `_originHop` marks the proxied request so the receiver NEVER re-anchors it
    // (mixed-version fleet loop guard, stripped at handler entry).
    const result = await origin.proxyPost(target, path, { ...(body as Record<string, unknown> ?? {}), _originHop: true });
    if (result && typeof result === 'object' && 'success' in (result as object)) return result as Envelope;
    return ok((result as { data?: unknown })?.data ?? result);
  } catch (e) {
    return fail('ORIGIN_UNREACHABLE', `tool-registry dataset origin "${target}" unreachable; retry shortly (${(e as Error).message})`);
  }
}

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
  const anchored = hopped ? null : await anchorToOrigin(origin, `/mcp-tools/${encodeURIComponent(name)}`, b);
  if (anchored) return anchored;
  const who = actor ?? apiActor(b);
  const input: { name: string; descriptionOverride?: string | null; enabled?: boolean } = { name };
  if (b.descriptionOverride !== undefined) {
    if (b.descriptionOverride !== null && typeof b.descriptionOverride !== 'string') {
      return fail('INVALID_INPUT', 'descriptionOverride must be a string or null');
    }
    input.descriptionOverride = b.descriptionOverride as string | null;
  }
  if (b.enabled !== undefined) input.enabled = b.enabled === true || b.enabled === 'true';
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
  const anchored = hopped ? null : await anchorToOrigin(origin, `/mcp-tools/${encodeURIComponent(name)}/rollback`, b);
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

export function createMcpToolsRoutes(_ctx: RouteContext): RouteHandler[] {
  return [
    // literals MUST precede the /:name patterns
    { method: 'GET', pattern: /^\/mcp-tools$/, handler: async () => handleToolList() },
    { method: 'GET', pattern: /^\/mcp-tools\/overlay$/, handler: async () => handleToolOverlay() },
    { method: 'GET', pattern: /^\/mcp-tools\/(?<name>[^/]+)\/history$/, handler: async (req) => handleToolHistory(req.params.name, req.query ?? {}) },
    { method: 'POST', pattern: /^\/mcp-tools\/(?<name>[^/]+)\/rollback$/, handler: async (req) => handleToolRollback(req.params.name, (req.body || {}) as Record<string, unknown>, undefined, undefined, realToolOriginAnchor()) },
    { method: 'GET', pattern: /^\/mcp-tools\/(?<name>[^/]+)$/, handler: async (req) => handleToolGet(req.params.name) },
    { method: 'POST', pattern: /^\/mcp-tools\/(?<name>[^/]+)$/, handler: async (req) => handleToolSet(req.params.name, (req.body || {}) as Record<string, unknown>, undefined, undefined, realToolOriginAnchor()) },
  ];
}
