// core/src/worker-role/cluster-change-notify.ts
/**
 * Notify LOCAL mission worker sessions when THIS node's cluster changes.
 *
 * When this node moves between clusters, the Mission Controller for the OLD
 * cluster can no longer coordinate the workers running here, and mission-state
 * sync for that cluster degrades on this node. We therefore inject a clear
 * ⟦CLUSTER-CHANGE⟧ notice into each LOCAL active worker session so it can
 * checkpoint + report status and be re-placed by a controller/orchestrator.
 *
 * USER DECISION: the worker KEEPS RUNNING — it is NOT told to stop. A
 * controller/orchestrator picks it up later and re-places it.
 *
 * Best-effort: this never throws. Each injection is wrapped in its own
 * try/catch, store-read failures are swallowed, and the actual transport
 * selection (cloud remote-control vs native cc-session vs raw tmux) is delegated
 * to the session-messaging `injectViaChain` driver chain, which only delivers to
 * a session that is genuinely live/driveable.
 */

import { listRecords } from './worker-store';
import type { WorkerRecord } from './types';
import { injectViaChain } from '../session-messaging/inject';
import type { InjectionResult } from '../session-messaging/types';

/** Build the ⟦CLUSTER-CHANGE⟧ notice injected into each active local worker. */
export function buildClusterChangeMessage(fromCluster: string, toCluster: string): string {
  return (
    `⟦CLUSTER-CHANGE⟧ This node moved from cluster "${fromCluster}" to "${toCluster}". ` +
    `The Mission Controller for the old cluster can no longer coordinate you and ` +
    `mission-state sync for that cluster is degrading on this node. KEEP RUNNING ` +
    `your current task — checkpoint/commit your progress and post a clear status via ` +
    `report_status so a Mission Controller or orchestrator can PICK YOU UP and ` +
    `re-place you. Do not abandon work and do not start new cross-cluster work until ` +
    `re-placed. ⟦/CLUSTER-CHANGE⟧`
  );
}

/**
 * Is this worker still active/running (worth notifying)?
 *
 * LIMITATION: `WorkerRecord` carries no explicit liveness/heartbeat field — the
 * closest signal is its task list. A worker with no tasks (freshly roled) OR with
 * any task that is not terminal (done/skipped) is treated as active. The real
 * backstop is the injector's own driver-availability probe, which only delivers
 * to a session that is actually live/driveable; a dead session simply yields
 * `delivered:false` and is skipped without error.
 */
export function isWorkerActive(rec: WorkerRecord): boolean {
  const tasks = rec.tasks || [];
  if (tasks.length === 0) return true;
  return tasks.some((t) => t.status !== 'done' && t.status !== 'skipped');
}

export interface ClusterChangeNotifyDeps {
  /** Read the LOCAL worker store. Defaults to worker-store.listRecords. */
  listWorkers: () => WorkerRecord[];
  /** Inject text into a LOCAL session by sessionId. Defaults to injectViaChain. */
  inject: (sessionId: string, text: string) => Promise<InjectionResult>;
  /** Active/running predicate. Defaults to isWorkerActive. */
  isActive: (rec: WorkerRecord) => boolean;
}

/**
 * Best-effort notify every LOCAL active worker session that this node moved
 * cluster. NEVER throws.
 *
 * @param fromCluster the cluster this node is leaving
 * @param toCluster   the cluster this node is joining ('default' on unassign)
 * @param deps        optional dependency overrides (for tests)
 */
export async function notifyLocalWorkersOfClusterChange(
  fromCluster: string,
  toCluster: string,
  deps?: Partial<ClusterChangeNotifyDeps>,
): Promise<void> {
  const listWorkers = deps?.listWorkers ?? listRecords;
  const inject = deps?.inject ?? ((sessionId: string, text: string) => injectViaChain(sessionId, text));
  const isActive = deps?.isActive ?? isWorkerActive;

  let workers: WorkerRecord[];
  try {
    workers = listWorkers() || [];
  } catch {
    return; // never throw — store read failed
  }

  const text = buildClusterChangeMessage(fromCluster, toCluster);
  for (const w of workers) {
    try {
      if (!w) continue;
      const sessionId = (w.sessionId || '').trim();
      if (!sessionId) continue; // no injectable session — skip
      if (!isActive(w)) continue; // not active/running — skip
      await inject(sessionId, text); // best-effort; injectViaChain itself never throws
    } catch {
      // best-effort — one worker's failure must not abort the rest or throw
    }
  }
}
