// core/src/data/sync-boot.ts
// Boot wiring for cross-node data sync (W4 §5 S2). Reactive convergence now rides the W3 bus:
// DataService.put/del publish data:<dataset> change-notify; a SyncListener debounces that into
// SyncEngine.pullDataset. The old per-write hub push-notify message and the unbounded queue that
// batched it are retired; the 300s reconcile stays as the safety net (and covers cross-cluster,
// where bus fan-out doesn't reach).
import { getProjectSettings } from '../project-settings';
import { getSyncEngine } from './data-service';
import { SyncListener } from './sync-listener';
import { getBus } from '../bus';
import { thisNodeId } from './paths';
import { publishSelf } from '../cluster/cluster-store';

let _started = false;
let _listener: SyncListener | null = null;
let _reconcileTimer: NodeJS.Timeout | null = null;
let _initTimer: NodeJS.Timeout | null = null;

export function startDataSync(): void {
  if (_started) return;
  const s = getProjectSettings();
  if (!s.dataServiceEnabled) return; // dormant unless enabled
  _started = true;

  const reconcileMs = Math.max(1, s.dataReconcileSec ?? 300) * 1000;

  // Reactive: bus data:<dataset> change-notify → debounced pull (idempotent; own-origin skipped).
  // onLocalEvent fires for local publishes AND cross-node ingests (incl. catch-up first-sight), so a
  // peer's write converges in ~1-2s. Attaching even when busEnabled=false is harmless (no events fire).
  _listener = new SyncListener({
    selfNode: () => thisNodeId(),
    pull: (dataset, fromNode) => getSyncEngine().pullDataset(fromNode, dataset),
    onLocalEvent: (cb) => getBus().onLocalEvent(cb),
  });
  _listener.start();

  // Periodic reconcile (self-heal / cross-cluster / missed pulls) + republish self cluster membership.
  _reconcileTimer = setInterval(() => {
    getSyncEngine().reconcile().catch(() => {});
    publishSelf().catch(() => {});
  }, reconcileMs);
  if (_reconcileTimer.unref) _reconcileTimer.unref();

  // Initial reconcile shortly after boot so a fresh node converges quickly.
  _initTimer = setTimeout(() => {
    getSyncEngine().reconcile().catch(() => {});
    publishSelf().catch(() => {});
  }, 2000);
  if (_initTimer.unref) _initTimer.unref();
}

export function stopDataSync(): void {
  _listener?.stop();
  _listener = null;
  if (_reconcileTimer) clearInterval(_reconcileTimer);
  if (_initTimer) clearTimeout(_initTimer);
  _reconcileTimer = _initTimer = null;
  _started = false;
}
