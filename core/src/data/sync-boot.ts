// core/src/data/sync-boot.ts
// Boot wiring for cross-node data sync (M5 Task 7).
// Called once after the hub client is initialized; idempotent (double-start guard).

import { getProjectSettings } from '../project-settings';
import { getHubClient } from '../hub-client';
import type { DatasetUpdatedMessage } from '../hub-client';
import { getSyncQueue } from './sync-queue';
import { getSyncEngine } from './data-service';
import { thisNodeId } from './paths';

let _started = false;
let _flushTimer: NodeJS.Timeout | null = null;
let _reconcileTimer: NodeJS.Timeout | null = null;

export function startDataSync(): void {
  if (_started) return;
  const s = getProjectSettings();
  if (!s.dataServiceEnabled) return; // dormant unless enabled
  _started = true;

  const periodMs = Math.max(1, s.dataSyncPeriodSec ?? 15) * 1000;
  const reconcileMs = Math.max(1, s.dataReconcileSec ?? 300) * 1000;
  const node = thisNodeId();

  // Batched periodic flush -> emit dataset_updated per dirty dataset
  _flushTimer = setInterval(() => {
    try {
      const batches = getSyncQueue().flush();
      if (!batches.length) return;
      const hub = getHubClient();
      for (const b of batches) {
        hub.sendDatasetUpdated({ node, dataset: b.dataset, recordIds: b.recordIds, ts: Date.now() });
      }
    } catch { /* best-effort */ }
  }, periodMs);
  if (_flushTimer.unref) _flushTimer.unref();

  // Periodic reconcile (self-heal / pull full datasets)
  _reconcileTimer = setInterval(() => {
    getSyncEngine().reconcile().catch(() => {});
  }, reconcileMs);
  if (_reconcileTimer.unref) _reconcileTimer.unref();

  // Push: on a peer's dataset_updated, pull that dataset's delta
  getHubClient().on('dataset_updated', (m: DatasetUpdatedMessage) => {
    if (m.node !== node) {
      getSyncEngine().pullDataset(m.node, m.dataset).catch(() => {});
    }
  });

  // Initial reconcile shortly after boot so a fresh node converges quickly
  const initTimer = setTimeout(() => {
    getSyncEngine().reconcile().catch(() => {});
  }, 2000);
  if (initTimer.unref) initTimer.unref();
}

export function stopDataSync(): void {
  if (_flushTimer) clearInterval(_flushTimer);
  if (_reconcileTimer) clearInterval(_reconcileTimer);
  _flushTimer = _reconcileTimer = null;
  _started = false;
}
