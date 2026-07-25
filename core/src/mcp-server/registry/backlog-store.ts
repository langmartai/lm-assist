/** Fleet-synced backlog store (dataset `backlog`) — the THIRD instantiation of the
 *  generic overlay-doc store (mcp-tool registry, assist-content registry precede it).
 *  Same descriptor family: cache backend, cross-node-readable, syncMode:'full',
 *  scope:'fleet'; reads never create the dataset, writes are origin-anchored at the
 *  routes layer. Backlog docs are standalone items (not overlays over code defaults),
 *  which the factory models as "defaults = empty item"; array-valued fields use the
 *  `equals`/`mutate` factory extensions for junk-rev-free, race-free appends. */
import {
  BACKLOG_DATASET, BACKLOG_HISTORY_CAP,
  findIdempotentMatch, findPossibleDuplicates,
  genBacklogId, jsonEq, countOf, normalizeTitleKey, refuseSelfEdges,
  validateBacklogId, validateDescription, validateDiscussion, validateEdges,
  validatePriority, validateRemoved, validateRequestIdField, validateReviews,
  validateStatus, validateTags, validateTitle, validateType,
  type BacklogDoc, type BacklogState,
} from './backlog-model';
import { lenOf, type OverlayDocPort } from './doc-model';
import { createOverlayDocStore } from './doc-store';
import type { MissionActor } from '../../mission/mission-model';

export { BACKLOG_DATASET };

/** The seam the store reads/writes through. Tests inject an in-memory fake. */
export type BacklogPort = OverlayDocPort<BacklogState>;

function throwCoded(code: string, message: string): never {
  const e = new Error(message) as Error & { code: string };
  e.code = code;
  throw e;
}

const backlogStore = createOverlayDocStore<BacklogState>({
  dataset: BACKLOG_DATASET,
  datasetTitle: 'Backlog / feature-idea graph',
  label: 'backlog',
  historyCap: BACKLOG_HISTORY_CAP,
  validateName: validateBacklogId,
  fields: [
    { key: 'title', defaultValue: '', validate: validateTitle },
    { key: 'description', defaultValue: '', validate: validateDescription, summarize: (v) => lenOf(v as string) },
    { key: 'type', defaultValue: 'idea', validate: validateType },
    { key: 'status', defaultValue: 'open', validate: validateStatus },
    { key: 'priority', defaultValue: 'med', validate: validatePriority },
    { key: 'tags', defaultValue: [], validate: validateTags, equals: jsonEq, summarize: countOf },
    { key: 'edges', defaultValue: [], validate: validateEdges, equals: jsonEq, summarize: countOf },
    { key: 'discussion', defaultValue: [], validate: validateDiscussion, equals: jsonEq, summarize: countOf },
    { key: 'reviews', defaultValue: [], validate: validateReviews, equals: jsonEq, summarize: countOf },
    { key: 'removed', defaultValue: false, validate: validateRemoved },
    { key: 'requestId', defaultValue: '', validate: validateRequestIdField },
  ],
  // Self-edges need the doc's own name — refuseWrite covers EVERY write path incl. rollback.
  refuseWrite: refuseSelfEdges,
});

export async function getBacklogDoc(id: string, port?: BacklogPort): Promise<BacklogDoc | null> {
  return backlogStore.get(id, port);
}

export async function listBacklogDocs(port?: BacklogPort): Promise<BacklogDoc[]> {
  return backlogStore.list(port);
}

/** Serialize creates that share an identity key, so two calls racing on the same
 *  requestId (or the same title) cannot both pass the "does it exist yet?" check and
 *  both mint an id. The per-NAME lock inside the doc-store cannot help here: each
 *  create invents a different name, so they never contend. Writes are origin-anchored,
 *  so one process sees them all — same reasoning as the store's own lock. */
const createLocks = new Map<string, Promise<unknown>>();
function withCreateLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = createLocks.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.catch(() => undefined);
  createLocks.set(key, tail);
  void tail.finally(() => { if (createLocks.get(key) === tail) createLocks.delete(key); });
  return run;
}

export interface BacklogCreateResult {
  doc: BacklogDoc;
  changed: boolean;
  /** Set when this create RESOLVED to an existing item instead of minting one. */
  idempotent?: { reason: 'requestId' | 'exact-repeat' };
  /** Advisory near-duplicates (never blocks the write). */
  possibleDuplicates?: { id: string; title: string; score: number }[];
}

/** Create — IDEMPOTENT. A repeat (same `requestId`, or an identical title+description
 *  inside the dedupe window) resolves to the EXISTING item instead of minting a second,
 *  so a caller that retries after a lost/late ack cannot duplicate. Otherwise: atomic
 *  create-if-absent under a freshly generated id (collision ⇒ coded throw — practically
 *  unreachable with 8 hex chars, but never silently merged). */
export async function createBacklogItem(
  fields: Partial<BacklogState> & { title: string },
  actor: MissionActor,
  port?: BacklogPort,
  idGen: () => string = genBacklogId,
  now: number = Date.now(),
): Promise<BacklogCreateResult> {
  const vt = validateTitle(fields.title);
  if (!vt.ok) throwCoded(vt.code, vt.message);
  const requestId = typeof fields.requestId === 'string' ? fields.requestId : '';
  const lockKey = requestId ? `rid:${requestId}` : `title:${normalizeTitleKey(fields.title)}`;
  return withCreateLock(lockKey, async () => {
    const docs = await listBacklogDocs(port);
    const hit = findIdempotentMatch(docs, { requestId, title: fields.title, description: fields.description, now });
    if (hit) return { doc: hit.doc, changed: false, idempotent: { reason: hit.reason } };
    const dups = findPossibleDuplicates(docs, fields.title);
    const id = idGen();
    const r = await backlogStore.mutate(id, (prev) => {
      if (prev) throwCoded('ID_COLLISION', `backlog id ${id} already exists — retry the create`);
      return requestId ? { ...fields, requestId } : fields;
    }, actor, port);
    return { doc: r.doc as BacklogDoc, changed: r.changed, ...(dups.length ? { possibleDuplicates: dups } : {}) };
  });
}

/** Merge-update an EXISTING item (missing ⇒ coded NOT_FOUND, unlike raw put which
 *  would silently create). */
export async function updateBacklogItem(
  id: string,
  patch: Partial<BacklogState>,
  actor: MissionActor,
  port?: BacklogPort,
): Promise<{ doc: BacklogDoc; changed: boolean }> {
  const r = await backlogStore.mutate(id, (prev) => {
    if (!prev) throwCoded('NOT_FOUND', `no backlog item "${id}"`);
    return patch;
  }, actor, port);
  return { doc: r.doc as BacklogDoc, changed: r.changed };
}

/** Race-free read-modify-write on an EXISTING item — link/unlink/discuss/review/remove
 *  compose their array edits here, inside the store's per-name write lock. The
 *  transform may return null for an explicit no-op (e.g. duplicate link). */
export async function mutateBacklogItem(
  id: string,
  transform: (prev: BacklogDoc) => Partial<BacklogState> | null,
  actor: MissionActor,
  port?: BacklogPort,
): Promise<{ doc: BacklogDoc; changed: boolean }> {
  const r = await backlogStore.mutate(id, (prev) => {
    if (!prev) throwCoded('NOT_FOUND', `no backlog item "${id}"`);
    return transform(prev);
  }, actor, port);
  return { doc: r.doc as BacklogDoc, changed: r.changed };
}

/** Restore the full state of history entry `toRev` as a NEW revision. */
export async function rollbackBacklogItem(
  id: string, toRev: number, actor: MissionActor,
  port?: BacklogPort,
): Promise<{ doc: BacklogDoc } | { error: { code: string; message: string } }> {
  return backlogStore.rollback(id, toRev, actor, port);
}
