/** Fleet-synced node-profile store (dataset `node-profiles`) — the FOURTH
 *  instantiation of the generic overlay-doc store (mcp-tool registry, assist-content,
 *  backlog precede it). Same descriptor family: cache backend, cross-node-readable,
 *  syncMode:'full', scope:'fleet'; reads never create the dataset, writes are
 *  origin-anchored at the routes layer.
 *
 *  Profiles are standalone docs (not overlays over a code default), which the factory
 *  models as "defaults = empty profile" — so an UNPROFILED node is not an error, it is
 *  simply a node with nothing learned about it yet. That matters: the fleet starts
 *  with zero profiles and is taught over time, so every reader must treat "absent" as
 *  "no preference known", never as "unusable". */
import {
  NODE_PROFILE_DATASET, NODE_PROFILE_HISTORY_CAP, NODE_PROFILE_DEFAULTS,
  tokensEqual, validateAvoid, validateCapabilities, validateNodeId, validateNotes, validateWeight,
  type NodeProfileState,
} from './node-profile-model';
import { lenOf, type OverlayDoc, type OverlayDocPort } from './doc-model';
import { createOverlayDocStore } from './doc-store';
import type { MissionActor } from '../../mission/mission-model';

export { NODE_PROFILE_DATASET };

export type NodeProfileDoc = OverlayDoc<NodeProfileState>;
/** The seam the store reads/writes through. Tests inject an in-memory fake. */
export type NodeProfilePort = OverlayDocPort<NodeProfileState>;

const countOf = (v: unknown): unknown => (Array.isArray(v) ? `n:${v.length}` : v);

const profileStore = createOverlayDocStore<NodeProfileState>({
  dataset: NODE_PROFILE_DATASET,
  datasetTitle: 'Node profiles — learned placement preferences',
  label: 'node-profile',
  historyCap: NODE_PROFILE_HISTORY_CAP,
  validateName: validateNodeId,
  fields: [
    { key: 'capabilities', defaultValue: NODE_PROFILE_DEFAULTS.capabilities, validate: validateCapabilities, equals: tokensEqual, summarize: countOf },
    { key: 'avoid', defaultValue: NODE_PROFILE_DEFAULTS.avoid, validate: validateAvoid, equals: tokensEqual, summarize: countOf },
    { key: 'weight', defaultValue: NODE_PROFILE_DEFAULTS.weight, validate: validateWeight },
    { key: 'notes', defaultValue: NODE_PROFILE_DEFAULTS.notes, validate: validateNotes, summarize: (v) => lenOf(v as string) },
  ],
});

export async function getNodeProfile(nodeId: string, port?: NodeProfilePort): Promise<NodeProfileDoc | null> {
  return profileStore.get(nodeId, port);
}

export async function listNodeProfiles(port?: NodeProfilePort): Promise<NodeProfileDoc[]> {
  return profileStore.list(port);
}

/** Write (create-or-update) a profile. Only the supplied fields change — a caller
 *  teaching ONE lesson must not have to restate the others, or it would clobber
 *  another session's learning to record its own. */
export async function putNodeProfile(
  nodeId: string,
  patch: Partial<NodeProfileState>,
  actor: MissionActor,
  port?: NodeProfilePort,
): Promise<{ doc: NodeProfileDoc; changed: boolean }> {
  return profileStore.put({ name: nodeId, ...patch }, actor, port);
}

export async function rollbackNodeProfile(
  nodeId: string, toRev: number, actor: MissionActor, port?: NodeProfilePort,
): Promise<{ doc: NodeProfileDoc } | { error: { code: string; message: string } }> {
  return profileStore.rollback(nodeId, toRev, actor, port);
}

/** Profiles as a plain map for the ranker, which is pure and must not do IO.
 *  A malformed/hand-edited doc is SKIPPED field-by-field, never fatal (the
 *  machine-access precedent): one bad record must not make the whole fleet
 *  unplaceable. Note OverlayDoc spreads state FLAT onto the doc — there is no
 *  `.state` wrapper. */
export function profilesByNode(docs: NodeProfileDoc[]): Map<string, NodeProfileState> {
  const out = new Map<string, NodeProfileState>();
  for (const d of docs) {
    if (!d?.name) continue;
    out.set(d.name, {
      capabilities: Array.isArray(d.capabilities) ? d.capabilities.filter((x) => typeof x === 'string') : [],
      avoid: Array.isArray(d.avoid) ? d.avoid.filter((x) => typeof x === 'string') : [],
      weight: typeof d.weight === 'number' && Number.isFinite(d.weight) ? d.weight : 0,
      notes: typeof d.notes === 'string' ? d.notes : '',
    });
  }
  return out;
}
