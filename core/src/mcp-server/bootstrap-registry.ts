/**
 * Fleet-shared bootstrap flags — the CROSS-NODE half of "one bootstrap per
 * conversation".
 *
 * The per-node half (the flag surviving a Core restart) is bootstrap-persist.ts
 * (bl_5169a15c). This module covers the other way the flag was lost: it was
 * per-node, so a claude.ai conversation that bootstrapped through node A was
 * refused BOOTSTRAP_REQUIRED the moment the hub routed one of its calls to node
 * B — a ~35 KB re-bootstrap per hop (2026-09). Each bootstrap is published to a
 * fleet-scope synced dataset keyed by the conversation/session id, and a node
 * consults its LOCAL copy of that dataset before refusing a first offence.
 *
 * Bounded by construction: the hot path is untouched (the resolver's Map). The
 * fleet read happens ONLY on a would-be refusal, and it is a local read of a
 * synced dataset — no network on the call path. Publishes are fire-and-forget.
 * Nothing here may throw into a call; no data service ⇒ everything degrades to
 * per-node behaviour.
 */

export const BOOTSTRAP_DATASET = 'mcp-bootstrap';

export interface FleetBootstrapRow { bootstrappedAt: number; node?: string }

/** The fleet side (a synced dataset). Injectable; null = no fleet store. */
export interface FleetBootstrapStore {
  get(id: string): Promise<FleetBootstrapRow | null>;
  put(id: string, row: FleetBootstrapRow): Promise<void>;
}

function systemCtx(): any { return { principal: { type: 'local' } }; }

const FLEET_ACL = [
  { principal: '*', actions: ['read', 'query', 'search'] },
  { principal: 'local', actions: ['write', 'delete', 'manage'] },
];

let datasetEnsured = false;

/**
 * The fleet store over the cross-node data service — same recipe as
 * cluster-store's node-clusters dataset (cache backend, scope fleet, syncMode
 * full, '*':read ACL so relayed peers can pull it). Returns null when the data
 * service is not initialised/enabled on this node.
 */
export function dataServiceBootstrapStore(): FleetBootstrapStore | null {
  let svc: any;
  try {
    const { peekDataService } = require('../data/data-service') as typeof import('../data/data-service');
    svc = peekDataService();
  } catch { return null; }
  if (!svc || !svc.isEnabled()) return null;

  const ensure = async (): Promise<void> => {
    if (datasetEnsured) return;
    datasetEnsured = true;
    try {
      await svc.createDataset(systemCtx(), {
        id: BOOTSTRAP_DATASET, backend: 'cache', title: 'MCP bootstrap flags',
        visibility: 'cross-node-readable', syncMode: 'full', scope: 'fleet', acl: FLEET_ACL, config: { kind: 'cache' },
      });
    } catch { /* exists */ }
    try {
      const { getDatasetRegistry } = require('../data/dataset-registry') as typeof import('../data/dataset-registry');
      getDatasetRegistry().update(BOOTSTRAP_DATASET, { acl: FLEET_ACL } as any);
    } catch { /* not registered yet */ }
  };

  return {
    async get(id) {
      await ensure();
      const r = await svc.get(systemCtx(), BOOTSTRAP_DATASET, id);
      if (!r || !r.ok || !r.value) return null;
      const f = (r.value.fields || {}) as Record<string, unknown>;
      const at = typeof f.bootstrappedAt === 'number' ? f.bootstrappedAt : 0;
      return at ? { bootstrappedAt: at, node: typeof f.node === 'string' ? f.node : undefined } : null;
    },
    async put(id, row) {
      await ensure();
      const now = new Date().toISOString();
      await svc.put(systemCtx(), BOOTSTRAP_DATASET, {
        id, version: 0, fields: { id, bootstrappedAt: row.bootstrappedAt, node: row.node ?? '' }, createdAt: now, updatedAt: now,
      });
    },
  };
}

function selfNodeId(): string {
  try {
    const { getHubConfig } = require('../hub-client/hub-config') as typeof import('../hub-client/hub-config');
    const c = getHubConfig();
    return c.gatewayId || c.machineId || '';
  } catch { return ''; }
}

/** Publish a bootstrap to the fleet. Fire-and-forget; never throws. */
export function publishBootstrapToFleet(id: string, bootstrappedAt: number, store: FleetBootstrapStore | null = dataServiceBootstrapStore()): void {
  if (!store) return;
  try { store.put(id, { bootstrappedAt, node: selfNodeId() || undefined }).catch(() => { /* best-effort */ }); }
  catch { /* best-effort */ }
}

/**
 * Did ANOTHER node record a bootstrap for this id? Consulted only on the refusal
 * path. Returns the row (so the caller can merge it locally) or null on any
 * failure — a failed fleet read is never a refusal reason.
 */
export async function fleetBootstrappedAt(id: string, store: FleetBootstrapStore | null = dataServiceBootstrapStore()): Promise<FleetBootstrapRow | null> {
  if (!store) return null;
  try {
    const row = await store.get(id);
    return row && row.bootstrappedAt ? row : null;
  } catch { return null; }
}
