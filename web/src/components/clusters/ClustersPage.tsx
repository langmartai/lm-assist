'use client';

import { useState, useMemo } from 'react';
import { Boxes, RefreshCw, Plus, X, Crown, Pencil, Check } from 'lucide-react';
import { useClusters, clusterBadge, type Cluster } from '@/hooks/useClusters';
import { useMachineContext } from '@/contexts/MachineContext';
import { getPlatformEmoji } from '@/lib/utils';

export function ClustersPage() {
  const {
    clusters, myCluster, loading, error,
    refresh, assignNode, unassignNode, describeCluster,
  } = useClusters();
  const { machines } = useMachineContext();

  const [showAssign, setShowAssign] = useState(false);
  const [assignNodeId, setAssignNodeId] = useState('');
  const [assignCluster, setAssignCluster] = useState('');
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [editDesc, setEditDesc] = useState('');
  const [editStatus, setEditStatus] = useState('');

  // gatewayId -> machine (for platform emoji + hostname enrichment of members)
  const machineByGw = useMemo(() => {
    const m = new Map<string, (typeof machines)[number]>();
    for (const mc of machines) m.set(mc.gatewayId || mc.id, mc);
    return m;
  }, [machines]);

  const clusterNames = useMemo(() => clusters.map((c) => c.name), [clusters]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setActionError(null);
    try {
      await fn();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const doAssign = () =>
    run(async () => {
      if (!assignNodeId || !assignCluster.trim()) {
        setActionError('pick a node and a cluster name');
        return;
      }
      await assignNode(assignNodeId, assignCluster.trim());
      setShowAssign(false);
      setAssignNodeId('');
      setAssignCluster('');
    });

  const startEdit = (c: Cluster) => {
    setEditing(c.name);
    setEditDesc(c.description || '');
    setEditStatus(c.status || '');
  };
  const saveEdit = (name: string) =>
    run(async () => {
      await describeCluster(name, editDesc, editStatus || undefined);
      setEditing(null);
    });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden', background: 'var(--color-bg-root)' }}>
      {/* Header */}
      <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--color-border-default)', display: 'flex', alignItems: 'center', gap: 12 }}>
        <Boxes size={20} style={{ color: 'var(--color-accent)' }} />
        <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--color-text-primary)' }}>Clusters</div>
        <span style={{ fontSize: 12, color: 'var(--color-text-tertiary)' }}>this node:</span>
        <span className={`badge ${clusterBadge(myCluster)}`}>{myCluster}</span>
        <div style={{ flex: 1 }} />
        <button className="btn btn-ghost btn-sm" onClick={refresh} disabled={loading} title="Refresh">
          <RefreshCw size={14} style={loading ? { animation: 'spin 1s linear infinite' } : undefined} />
        </button>
        <button className="btn btn-primary btn-sm" onClick={() => setShowAssign((v) => !v)}>
          <Plus size={14} /> Assign node
        </button>
      </div>

      {(error || actionError) && (
        <div style={{ margin: '12px 20px 0', padding: '8px 12px', borderRadius: 'var(--radius-md)', background: 'var(--color-bg-elevated)', border: '1px solid var(--color-status-red)', color: 'var(--color-status-red)', fontSize: 12, display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ flex: 1 }}>{actionError || error}</span>
          <button className="btn btn-ghost btn-sm" onClick={() => setActionError(null)}><X size={12} /></button>
        </div>
      )}

      <div style={{ flex: 1, overflow: 'auto', padding: 20 }}>
        {showAssign && (
          <div className="card" style={{ marginBottom: 16, display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'flex-end' }}>
            <label style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>
              node<br />
              <select className="input" value={assignNodeId} onChange={(e) => setAssignNodeId(e.target.value)}>
                <option value="">— pick a node —</option>
                {machines.map((m) => (
                  <option key={m.id} value={m.gatewayId || m.id}>
                    {m.hostname}{m.status === 'online' ? '' : ' (offline)'}
                  </option>
                ))}
              </select>
            </label>
            <label style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>
              cluster<br />
              <input className="input" list="cluster-names" value={assignCluster} placeholder="release / dev / …" onChange={(e) => setAssignCluster(e.target.value)} />
              <datalist id="cluster-names">
                {clusterNames.map((n) => (<option key={n} value={n} />))}
              </datalist>
            </label>
            <button className="btn btn-primary btn-sm" onClick={doAssign} disabled={busy}>Assign</button>
            <button className="btn btn-ghost btn-sm" onClick={() => setShowAssign(false)} disabled={busy}>Cancel</button>
          </div>
        )}

        {loading && clusters.length === 0 ? (
          <div style={{ color: 'var(--color-text-tertiary)', fontSize: 13 }}>Loading clusters…</div>
        ) : clusters.length === 0 ? (
          <div style={{ color: 'var(--color-text-tertiary)', fontSize: 13 }}>
            No clusters yet — all nodes are in the implicit <b>default</b> cluster. Use <b>Assign node</b> to split the fleet.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {clusters.map((c) => (
              <div key={c.name} className="card" style={{ padding: 14 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: c.description || editing === c.name ? 8 : 10 }}>
                  <span className={`badge ${clusterBadge(c.name)}`} style={{ fontSize: 13 }}>{c.name}</span>
                  <span style={{ fontSize: 12, color: 'var(--color-text-tertiary)' }}>{c.members.length} node{c.members.length === 1 ? '' : 's'}</span>
                  {c.status && <span className="badge badge-outline" style={{ fontSize: 11 }}>{c.status}</span>}
                  {c.name === myCluster && <span style={{ fontSize: 11, color: 'var(--color-accent)' }}>• this node</span>}
                  <div style={{ flex: 1 }} />
                  <button className="btn btn-ghost btn-sm" title="Describe cluster" onClick={() => (editing === c.name ? setEditing(null) : startEdit(c))}>
                    <Pencil size={13} />
                  </button>
                </div>

                {editing === c.name ? (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'flex-end', marginBottom: 10 }}>
                    <label style={{ fontSize: 11, color: 'var(--color-text-secondary)', flex: 1, minWidth: 200 }}>
                      description<br />
                      <input className="input" style={{ width: '100%' }} value={editDesc} placeholder="what this cluster is for" onChange={(e) => setEditDesc(e.target.value)} />
                    </label>
                    <label style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}>
                      status<br />
                      <input className="input" value={editStatus} placeholder="stable / busy / frozen" onChange={(e) => setEditStatus(e.target.value)} />
                    </label>
                    <button className="btn btn-primary btn-sm" onClick={() => saveEdit(c.name)} disabled={busy}><Check size={13} /> Save</button>
                  </div>
                ) : c.description ? (
                  <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginBottom: 10 }}>{c.description}</div>
                ) : null}

                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {c.members.map((mem) => {
                    const mc = machineByGw.get(mem.gatewayId);
                    const host = mem.hostname || mc?.hostname || mem.gatewayId.slice(0, 16);
                    const isLeader = c.leader === mem.gatewayId;
                    return (
                      <div key={mem.gatewayId} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', borderRadius: 'var(--radius-sm)', background: 'var(--color-bg-elevated)' }}>
                        {mc && <span>{getPlatformEmoji(mc.platform)}</span>}
                        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--color-text-primary)' }}>{host}</span>
                        <span className={`status-dot ${mem.online ? 'online' : 'offline'}`} title={mem.online ? 'online' : 'offline'} />
                        {isLeader && <span className="badge badge-amber" style={{ fontSize: 10, gap: 3 }}><Crown size={10} /> leader</span>}
                        <div style={{ flex: 1 }} />
                        {c.name !== 'default' && (
                          <button className="btn btn-ghost btn-sm" title="Remove from cluster (→ default)" onClick={() => run(() => unassignNode(mem.gatewayId))} disabled={busy}>
                            <X size={13} />
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
