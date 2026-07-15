/** Fleet-synced assist-content store (dataset `assist-content-registry`) — the SECOND
 *  instantiation of the generic overlay-doc store (doc-store.ts; the MCP tool registry
 *  is the first). Same descriptor family as the tool/workflow registries: cache
 *  backend, cross-node-readable, syncMode:'full', scope:'fleet'; reads never create
 *  the dataset, writes are origin-anchored at the routes layer. */
import {
  CONTENT_HISTORY_CAP, CONTENT_REGISTRY_DATASET,
  validateContentId, validateContentOverride, validateBlurbOverride,
  type ContentDoc, type ContentState,
} from './content-model';
import { lenOf, type OverlayDocPort } from './doc-model';
import { createOverlayDocStore } from './doc-store';
import type { MissionActor } from '../../mission/mission-model';

export { CONTENT_REGISTRY_DATASET };

/** The seam the store reads/writes through. Tests inject an in-memory fake. */
export type ContentPort = OverlayDocPort<ContentState>;

const contentStore = createOverlayDocStore<ContentState>({
  dataset: CONTENT_REGISTRY_DATASET,
  datasetTitle: 'Assist Content Registry (bootstrap/guide)',
  label: 'assist-content',
  historyCap: CONTENT_HISTORY_CAP,
  validateName: validateContentId,
  fields: [
    {
      key: 'contentOverride',
      defaultValue: null,
      validate: (v) => validateContentOverride(v as string | null),
      summarize: (v) => lenOf(v as string | null),
    },
    {
      key: 'blurbOverride',
      defaultValue: null,
      validate: (v) => validateBlurbOverride(v as string | null),
      summarize: (v) => lenOf(v as string | null),
    },
  ],
  // No refuseWrite hook: content docs cannot disable anything — the worst possible
  // write is bad prose, restorable in one rollback/restore-default call.
});

export async function getContentDoc(id: string, port?: ContentPort): Promise<ContentDoc | null> {
  return contentStore.get(id, port);
}

export async function listContentDocs(port?: ContentPort): Promise<ContentDoc[]> {
  return contentStore.list(port);
}

export async function putContentDoc(
  input: { name: string; contentOverride?: string | null; blurbOverride?: string | null },
  actor: MissionActor,
  port?: ContentPort,
): Promise<{ doc: ContentDoc; changed: boolean }> {
  return contentStore.put(input, actor, port);
}

/** Restore the full state of history entry `toRev` as a NEW revision. */
export async function rollbackContentDoc(
  id: string, toRev: number, actor: MissionActor,
  port?: ContentPort,
): Promise<{ doc: ContentDoc } | { error: { code: string; message: string } }> {
  return contentStore.rollback(id, toRev, actor, port);
}
