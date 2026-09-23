'use client';

/**
 * /data › Backup — export / import bundles and guarded dataset takeover (spec 2026-09-23,
 * "Surfaces > Web"). Four views over ONE node — the node picked in the top bar
 * (useMachineContext().selectedMachineId), reached through apiClient.fetchPath, so it works
 * locally, over the LAN and through the hub relay alike:
 *
 *   Health   inventory: owned/replica, origin + online dot, records/tombstones, takeover,
 *            last reconcile + errors, orphans, what is never exported
 *   Export   section checkboxes + note → Create bundle
 *   Bundles  stored bundles: Download (chunk route → Blob), Plan import, Copy to node…, Delete
 *   Import   upload / stored / fetch from node → policy, sections, datasets → Plan → Apply
 *
 * Deliberately NOT gated on the catalog's canManage: the node owner uses this from LAN and hub
 * sessions too. The Core route is the auth boundary (API token or hub relay), and every write
 * here sits behind a dry run and a confirm dialog.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Archive, FileSearch, HeartPulse, Package, Server } from 'lucide-react';
import { useAppMode } from '@/contexts/AppModeContext';
import { useMachineContext } from '@/contexts/MachineContext';
import type { Machine } from '@/lib/types';
import {
  createBundlesApi, toBundleApiError,
  type BundleApiError, type BundlesApi, type Inventory, type JsonCall, type StoredBundleInfo,
} from '@/lib/data-bundles';
import { HealthPanel } from './backup/HealthPanel';
import { ExportPanel } from './backup/ExportPanel';
import { BundlesPanel } from './backup/BundlesPanel';
import { ImportPanel } from './backup/ImportPanel';
import { Notice, mono } from './backup/shared';

type View = 'health' | 'export' | 'bundles' | 'import';

/** A bundle copied to another node, to open in that node's Import view once it is selected. */
interface Handoff { machineId: string; bundleId: string }

export function BackupTab() {
  const { apiClient, proxy, mode } = useAppMode();
  const { machines, onlineMachines, selectedMachineId, selectedMachine, setSelectedMachineId } = useMachineContext();

  // Plain local mode has no hub client: every call lands on this browser's own Core whatever
  // machineId says, so only target another node when the client can actually reach it.
  const crossNode = mode !== 'local';
  // undefined = the Core serving this page. The local machine resolves to undefined too, so the
  // selection settling from null to the local id does not re-read the inventory.
  let targetId: string | undefined;
  if (proxy.isProxied && proxy.machineId) targetId = proxy.machineId; // a proxied page is pinned to its machine
  else if (crossNode && selectedMachineId && !machines.find((m) => m.id === selectedMachineId)?.isLocal) targetId = selectedMachineId;
  const target: Machine | null = (targetId ? machines.find((m) => m.id === targetId) : machines.find((m) => m.isLocal)) ?? null;
  const shownId = targetId ?? target?.id;

  const apiFor = useCallback((machineId?: string): BundlesApi => {
    const call: JsonCall = <T,>(path: string, opts?: { method?: string; body?: unknown }) =>
      apiClient.fetchPath<T>(path, { method: opts?.method, body: opts?.body, machineId });
    return createBundlesApi(call);
  }, [apiClient]);
  const api = useMemo(() => apiFor(targetId), [apiFor, targetId]);

  const peers = useMemo(() => onlineMachines.filter((m) => m.id !== shownId), [onlineMachines, shownId]);

  const [handoff, setHandoff] = useState<Handoff | null>(null);
  const openNode = useCallback((machineId: string, bundleId: string) => {
    setHandoff({ machineId, bundleId });
    setSelectedMachineId(machineId);
  }, [setSelectedMachineId]);

  if (mode === 'hub' && !targetId) {
    return <div className="empty-state"><Server size={32} className="empty-state-icon" /><div>Select a node in the top bar to manage its backups</div></div>;
  }

  return (
    <div>
      {!crossNode && selectedMachine && !selectedMachine.isLocal && (
        <Notice tone="warn">
          {selectedMachine.hostname} is selected, but this browser session has no hub connection, so Backup shows the node serving this page.
        </Notice>
      )}
      <BackupNode
        key={targetId ?? 'local'}
        api={api}
        apiFor={apiFor}
        targetId={targetId}
        fallbackLabel={target?.hostname ?? 'this node'}
        fallbackNodeId={target?.id ?? null}
        peers={peers}
        crossNode={crossNode}
        handoff={handoff && handoff.machineId === shownId ? handoff : null}
        onHandoffDone={() => setHandoff(null)}
        // A hub-proxied page is pinned to its machine: it cannot switch to the copy's node.
        onOpenNode={proxy.isProxied ? undefined : openNode}
      />
    </div>
  );
}

function BackupNode({
  api, apiFor, targetId, fallbackLabel, fallbackNodeId, peers, crossNode, handoff, onHandoffDone, onOpenNode,
}: {
  api: BundlesApi;
  apiFor: (machineId: string) => BundlesApi;
  targetId?: string;
  fallbackLabel: string;
  fallbackNodeId: string | null;
  peers: Machine[];
  crossNode: boolean;
  handoff: Handoff | null;
  onHandoffDone: () => void;
  onOpenNode?: (machineId: string, bundleId: string) => void;
}) {
  const [view, setView] = useState<View>('health');

  const [inventory, setInventory] = useState<Inventory | null>(null);
  const [invLoading, setInvLoading] = useState(true);
  const [invError, setInvError] = useState<BundleApiError | null>(null);

  const [bundles, setBundles] = useState<StoredBundleInfo[]>([]);
  const [bLoading, setBLoading] = useState(true);
  const [bError, setBError] = useState<BundleApiError | null>(null);

  const [importId, setImportId] = useState<string | null>(null);

  const loadInventory = useCallback(async () => {
    setInvLoading(true);
    try {
      setInventory(await api.inventory());
      setInvError(null);
    } catch (e) {
      console.error('backup inventory failed', e);
      setInvError(toBundleApiError(e));
    } finally {
      setInvLoading(false);
    }
  }, [api]);

  const loadBundles = useCallback(async () => {
    setBLoading(true);
    try {
      setBundles(await api.list());
      setBError(null);
    } catch (e) {
      console.error('backup bundle list failed', e);
      setBError(toBundleApiError(e));
    } finally {
      setBLoading(false);
    }
  }, [api]);

  useEffect(() => { loadInventory(); loadBundles(); }, [loadInventory, loadBundles]);

  // Arrived here from "Copy to node… → Open": plan the copied bundle.
  useEffect(() => {
    if (!handoff) return;
    setImportId(handoff.bundleId);
    setView('import');
    onHandoffDone();
  }, [handoff, onHandoffDone]);

  const planImport = useCallback((bundleId: string) => { setImportId(bundleId); setView('import'); }, []);

  const nodeLabel = inventory?.node.hostname || fallbackLabel;
  // The id the hub routes on: a peer pulls from this node by it (Copy to node…).
  const selfNodeId = inventory?.node.nodeId ?? targetId ?? fallbackNodeId;
  const stranded = inventory?.datasets.filter((d) => !d.owned && d.originOnline !== true).length ?? 0;

  const navBtn = (v: View, label: string, icon: React.ReactNode, badge?: number) => (
    <button className={`btn btn-sm ${view === v ? 'btn-secondary' : 'btn-ghost'}`} style={view === v ? { color: 'var(--color-accent)' } : undefined} onClick={() => setView(v)}>
      {icon} {label}
      {badge !== undefined && badge > 0 && <span className="tab-badge">{badge}</span>}
    </button>
  );

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
        <Server size={14} style={{ color: 'var(--color-text-tertiary)' }} />
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-text-primary)' }}>{nodeLabel}</span>
        {inventory && <span style={{ ...mono, fontSize: 11, color: 'var(--color-text-tertiary)' }}>{inventory.node.nodeId}</span>}
        {inventory?.node.cluster && <span className="badge badge-outline">cluster {inventory.node.cluster}</span>}
        {inventory && <span className={`badge ${inventory.node.mode === 'prod' ? 'badge-green' : 'badge-blue'}`}>{inventory.node.mode}</span>}
        <div style={{ flex: 1 }} />
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
          {navBtn('health', 'Health', <HeartPulse size={12} />, stranded)}
          {navBtn('export', 'Export', <Archive size={12} />)}
          {navBtn('bundles', 'Bundles', <Package size={12} />, bundles.length)}
          {navBtn('import', 'Import', <FileSearch size={12} />)}
        </div>
      </div>

      {/* Views stay mounted so a half-done plan or upload survives switching views. */}
      <div style={{ display: view === 'health' ? 'block' : 'none' }}>
        <HealthPanel api={api} inventory={inventory} loading={invLoading} error={invError} onRefresh={loadInventory} />
      </div>
      <div style={{ display: view === 'export' ? 'block' : 'none' }}>
        <ExportPanel api={api} inventory={inventory} nodeLabel={nodeLabel}
          onCreated={() => { loadBundles(); loadInventory(); }} onPlan={planImport} />
      </div>
      <div style={{ display: view === 'bundles' ? 'block' : 'none' }}>
        <BundlesPanel api={api} apiFor={apiFor} bundles={bundles} loading={bLoading} error={bError} onRefresh={loadBundles}
          nodeLabel={nodeLabel} selfNodeId={selfNodeId} peers={peers} crossNode={crossNode} onPlan={planImport} onOpenNode={onOpenNode} />
      </div>
      <div style={{ display: view === 'import' ? 'block' : 'none' }}>
        <ImportPanel api={api} apiFor={apiFor} bundles={bundles} bundleId={importId} onSelectBundle={setImportId}
          onBundlesChanged={loadBundles} onApplied={loadInventory} nodeLabel={nodeLabel} peers={peers} crossNode={crossNode} />
      </div>
    </div>
  );
}
