/** Assist-content registry routes (design §5) — the /assist-content management surface
 *  behind the editor page. Bare {success,data}/{success,error} envelopes (mcp-tools /
 *  mission.routes idiom), handlers port-injected for tests.
 *
 *  Reads are LOCAL: defaults are code-owned per node and the registry replica syncs
 *  fleet-wide. Writes are ORIGIN-anchored through the SHARED origin-anchor (the
 *  workflow/tool-registry pattern): proxy to the dataset origin with the `_originHop`
 *  loop guard, fail CLOSED on unreachable, origin refusals relayed verbatim. */
import type { RouteHandler, RouteContext } from '../index';
import { wrapResponse, wrapError } from '../../api/helpers';
import {
  getContentDoc, listContentDocs, putContentDoc, rollbackContentDoc,
  CONTENT_REGISTRY_DATASET, type ContentPort,
} from '../../mcp-server/registry/content-store';
import { getContentCatalog, CONTENT_GROUP_ORDER, type ContentUnit } from '../../mcp-server/registry/content-catalog';
import { invalidateContentOverlayCache } from '../../mcp-server/registry/content-live';
import type { ContentDoc, ContentState } from '../../mcp-server/registry/content-model';
import { coarseActor, type MissionActor } from '../../mission/mission-model';
import { thisNode } from '../../mission/mission-store';
import { anchorToOrigin, realOriginAnchor, type OriginAnchorDeps } from './origin-anchor';

interface Envelope { success: boolean; data?: unknown; error?: { code: string; message: string } }
const ok = <T>(data: T): Envelope => ({ success: true, data });
const fail = (code: string, message: string): Envelope => ({ success: false, error: { code, message } });

const CONTENT_ANCHOR_LABEL = 'assist-content';

export function realContentOriginAnchor(): OriginAnchorDeps {
  return realOriginAnchor(CONTENT_REGISTRY_DATASET);
}

function apiActor(b: Record<string, unknown>): MissionActor {
  delete (b as Record<string, unknown>)._actor; // transport hint — never persisted
  return coarseActor('api', thisNode(), Date.now());
}

const bytes = (s: string | null | undefined): number => (s == null ? 0 : Buffer.byteLength(s, 'utf8'));

/** One list row: the code-owned defaults joined with the registry delta (if any). */
function unitRow(u: ContentUnit, doc: ContentDoc | null) {
  return {
    id: u.id,
    group: u.group,
    key: u.key,
    title: u.title,
    renderedIn: u.renderedIn,
    hasBlurb: u.hasBlurb,
    defaultBytes: bytes(u.defaultBody),
    hasOverride: doc?.contentOverride != null,
    hasBlurbOverride: doc?.blurbOverride != null,
    ...(doc?.contentOverride != null ? { overrideBytes: bytes(doc.contentOverride) } : {}),
    ...(doc ? { rev: doc.rev, lastUpdatedBy: doc.lastUpdatedBy, updatedAt: doc.updatedAt } : {}),
  };
}

export async function handleContentList(port?: ContentPort): Promise<Envelope> {
  const catalog = getContentCatalog();
  let docs: ContentDoc[] = [];
  try { docs = await listContentDocs(port as ContentPort); } catch { docs = []; }
  const byId = new Map(docs.map((d) => [d.name, d]));
  const units = [...catalog.values()].map((u) => unitRow(u, byId.get(u.id) ?? null));
  const orphanDocs = docs.filter((d) => !catalog.has(d.name));
  return ok({
    units,
    orphanDocs,
    groups: CONTENT_GROUP_ORDER,
    counts: {
      units: units.length,
      overridden: units.filter((r) => r.hasOverride || r.hasBlurbOverride).length,
      orphans: orphanDocs.length,
    },
  });
}

/** Minimal {byId} map — debug/parity with the tool overlay endpoint. */
export async function handleContentOverlay(port?: ContentPort): Promise<Envelope> {
  let docs: ContentDoc[] = [];
  try { docs = await listContentDocs(port as ContentPort); } catch { docs = []; }
  const byId: Record<string, ContentState> = {};
  for (const d of docs) byId[d.name] = { contentOverride: d.contentOverride ?? null, blurbOverride: d.blurbOverride ?? null };
  return ok({ byId });
}

export async function handleContentGet(id: string, port?: ContentPort): Promise<Envelope> {
  const unit = getContentCatalog().get(id) ?? null;
  let doc: ContentDoc | null = null;
  try { doc = await getContentDoc(id, port as ContentPort); } catch { doc = null; }
  if (!unit && !doc) return fail('NOT_FOUND', `no content unit or registry doc with id "${id}"`);
  if (!unit) {
    // Orphan doc: a valid id this build's code doesn't emit (mixed-version fleet or an
    // e2e scratch doc). Manageable — history/rollback work — but it NEVER renders.
    return ok({ id, knownUnit: false, doc, defaultBody: null, defaultBlurb: null, effectiveBody: doc!.contentOverride, renderedIn: [] });
  }
  return ok({
    ...unitRow(unit, doc),
    knownUnit: true,
    defaultBody: unit.defaultBody,
    defaultBlurb: unit.defaultBlurb,
    doc,
    effectiveBody: doc?.contentOverride ?? unit.defaultBody,
    effectiveBlurb: doc?.blurbOverride ?? unit.defaultBlurb,
  });
}

export async function handleContentSet(
  id: string, b: Record<string, unknown>,
  port?: ContentPort, actor?: MissionActor, origin?: OriginAnchorDeps,
): Promise<Envelope> {
  const hopped = b._originHop === true;
  delete b._originHop;
  const anchored = hopped ? null : await anchorToOrigin(origin, `/assist-content/${encodeURIComponent(id)}`, b, CONTENT_ANCHOR_LABEL);
  if (anchored) return anchored;
  const who = actor ?? apiActor(b);
  const unit = getContentCatalog().get(id) ?? null;
  const input: { name: string; contentOverride?: string | null; blurbOverride?: string | null } = { name: id };
  if (b.contentOverride !== undefined) {
    if (b.contentOverride !== null && typeof b.contentOverride !== 'string') {
      return fail('INVALID_INPUT', 'contentOverride must be a string or null');
    }
    input.contentOverride = b.contentOverride as string | null;
  }
  if (b.blurbOverride !== undefined) {
    if (b.blurbOverride !== null && typeof b.blurbOverride !== 'string') {
      return fail('INVALID_INPUT', 'blurbOverride must be a string or null');
    }
    // A blurb only renders where the generated index lists the unit — refuse the
    // write on known units without one (it would be dead state); scratch/unknown
    // docs accept anything grammar-valid (they never render).
    if (unit && !unit.hasBlurb && b.blurbOverride !== null) {
      return fail('NO_BLURB', `"${id}" has no index one-liner — blurbOverride does not apply to it`);
    }
    input.blurbOverride = b.blurbOverride as string | null;
  }
  try {
    const r = await putContentDoc(input, who, port as ContentPort);
    invalidateContentOverlayCache(); // a local write must reach bootstrap/guide on the very next call
    return ok({ doc: r.doc, changed: r.changed, knownUnit: unit != null });
  } catch (e) {
    return fail((e as { code?: string }).code ?? 'INVALID_INPUT', (e as Error).message);
  }
}

export async function handleContentHistory(
  id: string, _opts: Record<string, unknown>, port?: ContentPort,
): Promise<Envelope> {
  let doc: ContentDoc | null = null;
  try { doc = await getContentDoc(id, port as ContentPort); } catch { doc = null; }
  return ok({ history: [...(doc?.history ?? [])].reverse() });
}

export async function handleContentRollback(
  id: string, b: Record<string, unknown>,
  port?: ContentPort, actor?: MissionActor, origin?: OriginAnchorDeps,
): Promise<Envelope> {
  const hopped = b._originHop === true;
  delete b._originHop;
  const anchored = hopped ? null : await anchorToOrigin(origin, `/assist-content/${encodeURIComponent(id)}/rollback`, b, CONTENT_ANCHOR_LABEL);
  if (anchored) return anchored;
  const who = actor ?? apiActor(b);
  const toRevRaw = b.toRev;
  const toRev = typeof toRevRaw === 'number' ? toRevRaw : parseInt(String(toRevRaw ?? ''), 10);
  if (Number.isNaN(toRev)) return fail('INVALID_INPUT', 'toRev (number) is required');
  try {
    const r = await rollbackContentDoc(id, toRev, who, port as ContentPort);
    if ('error' in r) return fail(r.error.code, r.error.message);
    invalidateContentOverlayCache();
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

export function createAssistContentRoutes(_ctx: RouteContext): RouteHandler[] {
  const wrapped = (run: (req: Parameters<RouteHandler['handler']>[0]) => Promise<Envelope>): RouteHandler['handler'] =>
    async (req) => { const start = Date.now(); return toApi(await run(req), start); };
  return [
    // literals MUST precede the /:id patterns
    { method: 'GET', pattern: /^\/assist-content$/, handler: wrapped(() => handleContentList()) },
    { method: 'GET', pattern: /^\/assist-content\/overlay$/, handler: wrapped(() => handleContentOverlay()) },
    { method: 'GET', pattern: /^\/assist-content\/(?<id>[^/]+)\/history$/, handler: wrapped((req) => handleContentHistory(req.params.id, req.query ?? {})) },
    { method: 'POST', pattern: /^\/assist-content\/(?<id>[^/]+)\/rollback$/, handler: wrapped((req) => handleContentRollback(req.params.id, (req.body || {}) as Record<string, unknown>, undefined, undefined, realContentOriginAnchor())) },
    { method: 'GET', pattern: /^\/assist-content\/(?<id>[^/]+)$/, handler: wrapped((req) => handleContentGet(req.params.id)) },
    { method: 'POST', pattern: /^\/assist-content\/(?<id>[^/]+)$/, handler: wrapped((req) => handleContentSet(req.params.id, (req.body || {}) as Record<string, unknown>, undefined, undefined, realContentOriginAnchor())) },
  ];
}
