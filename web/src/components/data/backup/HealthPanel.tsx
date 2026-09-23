'use client';

/**
 * Backup › Health — the "is my data safe" view: every dataset with owned/replica, its origin
 * and whether that origin is online, record and tombstone counts, and what an export would do
 * with it; the last reconcile and its errors; orphan stores; what is never exported. A replica
 * whose origin is not online gets a Take over button behind a typed-confirm dialog.
 */

import { useState } from 'react';
import { Crown, HeartPulse, RefreshCw, ShieldCheck, TriangleAlert } from 'lucide-react';
import {
  formatBytes, originState, takeoverState,
  type BundleApiError, type BundlesApi, type Inventory, type InventoryDataset, type TakeoverResult,
} from '@/lib/data-bundles';
import { formatTimeAgo } from '@/lib/utils';
import { ConfirmDialog, ErrorBanner, Notice, OnlineDot, Panel, Spinner, Stat, attempt, labelStyle, mono, muted, td, th } from './shared';

export function HealthPanel({ api, inventory, loading, error, onRefresh }: {
  api: BundlesApi;
  inventory: Inventory | null;
  loading: boolean;
  error: BundleApiError | null;
  onRefresh: () => void;
}) {
  const [target, setTarget] = useState<InventoryDataset | null>(null);
  const [force, setForce] = useState(false);
  const [busy, setBusy] = useState(false);
  const [dialogError, setDialogError] = useState<BundleApiError | null>(null);
  const [done, setDone] = useState<TakeoverResult | null>(null);

  const openTakeover = (d: InventoryDataset) => { setTarget(d); setForce(false); setDialogError(null); };
  const closeTakeover = () => { if (!busy) setTarget(null); };

  const runTakeover = async () => {
    if (!target) return;
    setBusy(true);
    setDialogError(null);
    // force is only ever sent from the checkbox, which shows only when the roster is unknown.
    const r = await attempt(() => api.takeover(target.id, force), (e) => {
      setDialogError(e);
      // The inventory said the origin was not online; it is now. Refresh so the row stops offering this.
      if (e.code === 'ORIGIN_ONLINE') onRefresh();
    });
    setBusy(false);
    if (r) {
      setTarget(null);
      setDone(r);
      onRefresh();
    }
  };

  if (!inventory) {
    return (
      <div>
        <ErrorBanner error={error} />
        {loading
          ? <div className="empty-state"><Spinner size={24} /><span style={{ fontSize: 12 }}>Reading every dataset…</span></div>
          : <div className="empty-state"><HeartPulse size={32} className="empty-state-icon" /><div>No inventory</div>
              <button className="btn btn-secondary btn-sm" onClick={onRefresh}><RefreshCw size={12} /> Retry</button></div>}
      </div>
    );
  }

  const inv = inventory;
  const owned = inv.datasets.filter((d) => d.owned).length;
  const replicas = inv.datasets.length - owned;
  const records = inv.datasets.reduce((n, d) => n + (d.records ?? 0), 0);
  const stranded = inv.datasets.filter((d) => takeoverState(d).show);
  const roster = inv.roster;
  const rosterText = !roster.queried
    ? 'not needed (no replicas)'
    : roster.available ? `${roster.onlinePeers ?? 0} peer${roster.onlinePeers === 1 ? '' : 's'} online` : `unavailable${roster.reason ? `: ${roster.reason}` : ''}`;
  // Unknown roster per the inventory, or the Core just refused ROSTER_UNAVAILABLE (the hub went
  // away after the inventory was read): either way the takeover needs an explicit force.
  const needsForce = target ? takeoverState(target).needsForce || dialogError?.code === 'ROSTER_UNAVAILABLE' : false;

  return (
    <div>
      <ErrorBanner error={error} />
      {done && (
        <Notice tone="ok" onClose={() => setDone(null)}>
          <b>{done.dataset}</b> is now owned by this node ({done.records} records, {done.tombstones} tombstones{done.forced ? ', forced' : ''}).
          {' '}Superseded {done.superseded.hostname || done.superseded.machineId}. {done.note}
        </Notice>
      )}

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginBottom: 12 }}>
        <Stat label="Datasets" value={inv.datasets.length} sub={`${owned} owned · ${replicas} replica${replicas === 1 ? '' : 's'}`} />
        <Stat label="Records" value={records.toLocaleString()} sub="tombstones included" />
        <Stat label="Stored bundles" value={inv.bundles.count} sub={inv.bundles.newest ? <span style={mono}>{inv.bundles.newest}</span> : 'none yet'} />
        <Stat label="Last reconcile" value={inv.sync?.lastRun ? formatTimeAgo(inv.sync.lastRun) : 'never'}
          sub={inv.sync ? `${inv.sync.peersChecked} peers · ${inv.sync.datasetsReplicated} replicated` : 'sync engine not running'} />
        <Stat label="Fleet roster" value={roster.queried ? (roster.available ? 'ok' : 'down') : '—'} sub={rosterText} />
      </div>

      {stranded.length > 0 && (
        <Notice tone="warn">
          <TriangleAlert size={12} style={{ verticalAlign: -2, marginRight: 4 }} />
          {stranded.length} replica{stranded.length === 1 ? '' : 's'} whose origin is not online: {stranded.map((d) => d.id).join(', ')}.
          {' '}A replica is read-only and is not served to other nodes; export it (Export › include replicas) or take it over if the origin is gone for good.
        </Notice>
      )}

      {inv.sync && inv.sync.errors.length > 0 && (
        <Panel title={`Reconcile errors (${inv.sync.errors.length})`} icon={<TriangleAlert size={14} style={{ color: 'var(--color-status-red)' }} />} style={{ borderColor: 'var(--color-status-red)' }}>
          {inv.sync.errors.map((e, i) => <div key={i} style={{ fontSize: 12, ...mono, color: 'var(--color-text-secondary)', wordBreak: 'break-word' }}>{e}</div>)}
        </Panel>
      )}

      <Panel title="Datasets" icon={<ShieldCheck size={14} style={{ color: 'var(--color-accent)' }} />}
        actions={<button className="btn btn-ghost btn-sm" onClick={onRefresh} disabled={loading}>{loading ? <Spinner size={12} /> : <RefreshCw size={12} />} Refresh</button>}>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ textAlign: 'left', color: 'var(--color-text-tertiary)' }}>
                <th style={th}>dataset</th><th style={th}>ownership</th><th style={th}>origin</th>
                <th style={{ ...th, textAlign: 'right' }}>records</th><th style={{ ...th, textAlign: 'right' }}>tombstones</th>
                <th style={th}>scope · sync</th><th style={{ ...th, textAlign: 'right' }}>size</th><th style={th}>export</th><th style={th} />
              </tr>
            </thead>
            <tbody>
              {inv.datasets.map((d) => {
                const o = originState(d);
                const tk = takeoverState(d);
                return (
                  <tr key={d.id} style={{ borderTop: '1px solid var(--color-border-default)' }}>
                    <td style={td}>
                      <div style={{ ...mono, color: 'var(--color-text-primary)' }}>{d.id}</div>
                      {d.title && d.title !== d.id && <div style={muted}>{d.title}</div>}
                      {d.error && <div style={{ fontSize: 11, color: 'var(--color-status-red)', ...mono }}>{d.error}</div>}
                    </td>
                    <td style={td}>
                      {d.owned ? <span className="badge badge-green">owned</span> : <span className="badge badge-blue">replica</span>}
                      {d.supersedes && (
                        <div style={muted} title={`took over from ${d.supersedes.machineId} at ${d.supersedes.at}`}>
                          supersedes {d.supersedes.hostname || d.supersedes.machineId}
                        </div>
                      )}
                    </td>
                    <td style={td}>
                      {d.origin && o ? (
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }} title={d.origin.machineId}>
                          <OnlineDot state={o} /> {d.origin.hostname || d.origin.machineId}
                        </span>
                      ) : <span style={muted}>this node</span>}
                    </td>
                    <td style={{ ...td, textAlign: 'right', ...mono }}>{d.records ?? '—'}</td>
                    <td style={{ ...td, textAlign: 'right', ...mono }}>{d.tombstones ?? '—'}</td>
                    <td style={td}><span style={{ color: 'var(--color-text-secondary)' }}>{d.scope}</span> <span style={muted}>· {d.syncMode}</span></td>
                    <td style={{ ...td, textAlign: 'right', ...mono }}>{formatBytes(d.approxBytes)}</td>
                    <td style={td}>
                      <span className={`badge ${d.export === 'default' ? 'badge-green' : d.export === 'opt-in' ? 'badge-orange' : 'badge-default'}`} title={d.reason}>
                        {d.export}
                      </span>
                      {d.reason && d.export !== 'default' && <div style={{ ...muted, maxWidth: 220 }}>{d.reason}</div>}
                    </td>
                    <td style={{ ...td, textAlign: 'right' }}>
                      {tk.show && (
                        <button className="btn btn-secondary btn-sm" onClick={() => openTakeover(d)}
                          title={tk.needsForce ? 'The roster is unavailable — takeover will need force' : 'The origin is offline'}>
                          <Crown size={12} /> Take over
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Panel>

      {!!inv.malformedDescriptors && (
        <Notice tone="warn">
          {inv.malformedDescriptors} malformed {inv.malformedDescriptors === 1 ? 'entry' : 'entries'} in this node&apos;s dataset registry (no usable id) — skipped, never exported.
        </Notice>
      )}

      {inv.orphans.length > 0 && (
        <Panel title={`Orphan stores (${inv.orphans.length})`} icon={<TriangleAlert size={14} style={{ color: 'var(--color-status-orange)' }} />}>
          <div style={{ ...muted, marginBottom: 6 }}>Storage directories with no dataset descriptor. They are never exported and are left on disk untouched.</div>
          {inv.orphans.map((o) => (
            <div key={`${o.backend}:${o.id}`} style={{ display: 'flex', gap: 10, fontSize: 12, padding: '2px 0' }}>
              <span style={{ ...mono, color: 'var(--color-text-primary)', minWidth: 180 }}>{o.id}</span>
              <span className="badge badge-default">{o.backend}</span>
              <span style={{ ...mono, color: 'var(--color-text-secondary)' }}>{formatBytes(o.bytes)}</span>
              {o.lockOnly && <span style={muted}>lock file only</span>}
            </div>
          ))}
        </Panel>
      )}

      <Panel title="Never exported" icon={<ShieldCheck size={14} style={{ color: 'var(--color-text-tertiary)' }} />}>
        <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 4 }}>
          {inv.neverExported.map((n, i) => <li key={i} style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>{n}</li>)}
        </ul>
        <div style={{ ...muted, marginTop: 8 }}>Credentials are re-established on a target the normal way; derived stores rebuild themselves.</div>
      </Panel>

      {target && (
        <ConfirmDialog
          title={<>Take over <span style={mono}>{target.id}</span></>}
          confirmLabel="Take over"
          destructive
          typed={target.id}
          gate={!needsForce || force}
          busy={busy}
          error={dialogError}
          onConfirm={runTakeover}
          onCancel={closeTakeover}
        >
          <div>
            This promotes the local read-only replica to the OWNER of <b>{target.id}</b>. Its origin is{' '}
            <b>{target.origin?.hostname || target.origin?.machineId}</b> ({target.origin?.machineId}).
          </div>
          <div>Take over only when that origin is gone (lost disk, retired host). If it comes back, it demotes itself to a replica once nothing of its own would be stranded.</div>
          <div style={muted}>{target.records ?? '?'} records · {target.tombstones ?? '?'} tombstones here now.</div>
          {needsForce && (
            <label style={{ ...labelStyle, display: 'flex', gap: 8, alignItems: 'flex-start', padding: 8, borderRadius: 'var(--radius-md)', border: '1px solid var(--color-status-orange)' }}>
              <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} style={{ marginTop: 2 }} />
              <span>
                The hub roster is unavailable{inv.roster.reason ? ` (${inv.roster.reason})` : ''}, so lm-assist cannot tell whether the origin is online.
                {' '}Force the takeover — I know the origin is gone.
              </span>
            </label>
          )}
        </ConfirmDialog>
      )}
    </div>
  );
}
