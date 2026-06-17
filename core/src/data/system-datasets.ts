// core/src/data/system-datasets.ts
// Reserved system datasets that expose existing stores through the generic data service.
// Registered idempotently at service init. Gating: read open to all authed callers;
// write/delete/manage local-only by default (an operator adds a cloud { userId, actions } rule to grant more).
import type { DatasetRegistry } from './dataset-registry';
import type { BackendKind, BackendConfig, AclRule } from './types';

const GATING_ACL: AclRule[] = [
  { principal: '*', actions: ['read', 'query', 'search'] },
  { principal: 'local', actions: ['write', 'delete', 'manage'] },
];

export const SYSTEM_DATASETS: Array<{ id: string; backend: BackendKind; config: BackendConfig; title: string }> = [
  { id: 'knowledge', backend: 'knowledge', config: { kind: 'knowledge' }, title: 'Knowledge base (system)' },
  { id: 'vectors', backend: 'vectors', config: { kind: 'vectors' }, title: 'Vector index (system)' },
];

/** Idempotently ensure the reserved system datasets exist in the registry. */
export function ensureSystemDatasets(registry: DatasetRegistry): void {
  for (const s of SYSTEM_DATASETS) {
    if (registry.get(s.id)) continue;
    registry.create({
      id: s.id, backend: s.backend, title: s.title,
      visibility: 'cross-node-readable', // reads allowed cross-node; mutate/manage still ACL+key gated
      system: true,
      config: s.config,
      acl: GATING_ACL.map((a) => ({ ...a, actions: [...a.actions] })),
      syncMode: 'none',
    });
  }
}
