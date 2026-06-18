'use client';

import { useState, useEffect, useCallback } from 'react';
import { Database, Plus, Trash2, KeyRound, RefreshCw, Loader2, ShieldAlert, X } from 'lucide-react';
import { useAppMode } from '@/contexts/AppModeContext';

type BackendKind = 'vector' | 'sql' | 'cache' | 'knowledge' | 'vectors' | 'file';
type DataAction = 'read' | 'query' | 'search' | 'write' | 'delete' | 'manage';
type NodeVisibility = 'local-only' | 'synced' | 'cross-node-readable';

interface CatalogEntry { id: string; backend: BackendKind; visibility: NodeVisibility; readOnly: boolean; actions: DataAction[]; }
interface CatalogResponse { you: { principal: 'local' | 'cloud'; canManage: boolean }; datasets: CatalogEntry[]; }
interface PublicKey {
  keyId: string; principalType: string; principalId?: string; node: string;
  grants: { dataset: string; actions: DataAction[] }[]; label?: string;
  issuedAt: string; expiresAt: string; revoked?: boolean;
}
interface SyncStatus {
  lastRun: string | null; peersChecked: number; datasetsReplicated: number;
  recordsApplied: number; recordsSkipped: number; errors: string[];
}

type Tab = 'datasets' | 'keys' | 'sync';

export function DataPage() {
  const { apiClient, proxy } = useAppMode();

  const apiFetch = useCallback(
    async <T,>(path: string, opts?: { method?: string; body?: unknown }): Promise<T> =>
      apiClient.fetchPath<T>(path, { method: opts?.method, body: opts?.body, machineId: proxy.machineId || undefined }),
    [apiClient, proxy.machineId],
  );

  const [tab, setTab] = useState<Tab>('datasets');
  const [principal, setPrincipal] = useState<'local' | 'cloud' | ''>('');
  const [canManage, setCanManage] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Datasets tab state
  const [datasets, setDatasets] = useState<CatalogEntry[]>([]);
  const [loadingDs, setLoadingDs] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState<{ id: string; backend: BackendKind; visibility: NodeVisibility; syncMode: string }>({
    id: '', backend: 'cache', visibility: 'local-only', syncMode: 'none',
  });
  const [creating, setCreating] = useState(false);
  const [confirmDrop, setConfirmDrop] = useState<string | null>(null);

  const fetchCatalog = useCallback(async () => {
    setLoadingDs(true);
    try {
      const r = await apiFetch<CatalogResponse>('/data/catalog');
      setDatasets(r.datasets || []);
      setPrincipal(r.you?.principal ?? '');
      setCanManage(!!r.you?.canManage);
      setError(null);
    } catch (e) {
      console.error('fetchCatalog failed', e);
      setError(e instanceof Error ? e.message : 'failed to load catalog');
    } finally {
      setLoadingDs(false);
    }
  }, [apiFetch]);

  useEffect(() => { fetchCatalog(); }, [fetchCatalog]);

  const createDataset = useCallback(async () => {
    if (!form.id.trim()) return;
    setCreating(true);
    try {
      await apiFetch('/data/datasets', {
        method: 'POST',
        body: { id: form.id.trim(), backend: form.backend, visibility: form.visibility, syncMode: form.syncMode, config: { kind: form.backend } },
      });
      setShowCreate(false);
      setForm({ id: '', backend: 'cache', visibility: 'local-only', syncMode: 'none' });
      await fetchCatalog();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'create failed');
    } finally {
      setCreating(false);
    }
  }, [apiFetch, form, fetchCatalog]);

  const dropDataset = useCallback(async (id: string) => {
    try {
      await apiFetch(`/data/datasets/${encodeURIComponent(id)}`, { method: 'DELETE' });
      setConfirmDrop(null);
      await fetchCatalog();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'drop failed');
    }
  }, [apiFetch, fetchCatalog]);

  const badgeForBackend = (b: BackendKind) =>
    b === 'sql' ? 'badge-blue' : b === 'vector' ? 'badge-purple' : b === 'cache' ? 'badge-cyan'
      : b === 'file' ? 'badge-orange' : 'badge-default';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden', background: 'var(--color-bg-root)' }}>
      {/* Header */}
      <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--color-border-default)', display: 'flex', alignItems: 'center', gap: 12 }}>
        <Database size={20} style={{ color: 'var(--color-accent)' }} />
        <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--color-text-primary)' }}>Data Service</div>
        <div style={{ flex: 1 }} />
        {principal && (
          <span className={`badge ${canManage ? 'badge-green' : 'badge-default'}`}>
            {canManage ? 'local · can manage' : `${principal} · read-only`}
          </span>
        )}
      </div>

      {/* Tab bar */}
      <div className="tab-bar" style={{ padding: '0 20px' }}>
        <button className={`tab-item ${tab === 'datasets' ? 'active' : ''}`} onClick={() => setTab('datasets')}>Datasets</button>
        <button className={`tab-item ${tab === 'keys' ? 'active' : ''}`} onClick={() => setTab('keys')}>Access Keys</button>
        <button className={`tab-item ${tab === 'sync' ? 'active' : ''}`} onClick={() => setTab('sync')}>Sync</button>
      </div>

      {/* Capability banner for non-local sessions */}
      {!canManage && principal === 'cloud' && (
        <div style={{ margin: '12px 20px 0', padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 10, borderRadius: 'var(--radius-md)', background: 'var(--color-bg-elevated)', border: '1px solid var(--color-border-default)' }}>
          <ShieldAlert size={16} style={{ color: 'var(--color-status-orange)' }} />
          <span style={{ fontSize: 13, color: 'var(--color-text-secondary)' }}>
            This session is remote. Data management (create/drop datasets, keys, sync) is local-only — open this page from a Claude Code / browser session on the data-service host to manage it.
          </span>
        </div>
      )}

      {error && (
        <div style={{ margin: '12px 20px 0', padding: '8px 12px', borderRadius: 'var(--radius-md)', background: 'var(--color-bg-elevated)', border: '1px solid var(--color-status-red)', color: 'var(--color-status-red)', fontSize: 12, display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ flex: 1 }}>{error}</span>
          <button className="btn btn-ghost btn-sm" onClick={() => setError(null)}><X size={12} /></button>
        </div>
      )}

      {/* Tab content */}
      <div style={{ flex: 1, overflow: 'auto', padding: 20 }}>
        {tab === 'datasets' && (
          <div>
            <div style={{ display: 'flex', alignItems: 'center', marginBottom: 12 }}>
              <div style={{ fontSize: 13, color: 'var(--color-text-tertiary)' }}>{datasets.length} dataset{datasets.length === 1 ? '' : 's'}</div>
              <div style={{ flex: 1 }} />
              <button className="btn btn-primary btn-sm" disabled={!canManage} onClick={() => setShowCreate((v) => !v)} title={canManage ? 'Create dataset' : 'Local-only'}>
                <Plus size={14} /> New dataset
              </button>
            </div>

            {showCreate && canManage && (
              <div className="card" style={{ marginBottom: 12, display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'flex-end' }}>
                <label style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>id<br />
                  <input className="input" value={form.id} placeholder="my-dataset" onChange={(e) => setForm({ ...form, id: e.target.value })} />
                </label>
                <label style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>backend<br />
                  <select className="input" value={form.backend} onChange={(e) => setForm({ ...form, backend: e.target.value as BackendKind })}>
                    <option value="cache">cache</option><option value="vector">vector</option><option value="sql">sql</option>
                  </select>
                </label>
                <label style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>visibility<br />
                  <select className="input" value={form.visibility} onChange={(e) => setForm({ ...form, visibility: e.target.value as NodeVisibility })}>
                    <option value="local-only">local-only</option><option value="synced">synced</option><option value="cross-node-readable">cross-node-readable</option>
                  </select>
                </label>
                <label style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>syncMode<br />
                  <select className="input" value={form.syncMode} onChange={(e) => setForm({ ...form, syncMode: e.target.value })}>
                    <option value="none">none</option><option value="full">full</option><option value="partial">partial</option>
                  </select>
                </label>
                <button className="btn btn-primary btn-sm" disabled={creating || !form.id.trim()} onClick={createDataset}>
                  {creating ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> : 'Create'}
                </button>
              </div>
            )}

            {loadingDs ? (
              <div className="empty-state"><Loader2 size={24} style={{ animation: 'spin 1s linear infinite' }} /><span style={{ fontSize: 12 }}>Loading…</span></div>
            ) : datasets.length === 0 ? (
              <div className="empty-state"><Database size={32} className="empty-state-icon" /><div>No datasets</div></div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {datasets.map((d) => (
                  <div key={d.id} className="card" style={{ display: 'flex', alignItems: 'center', gap: 10, padding: 12 }}>
                    <div style={{ fontFamily: 'var(--font-mono)', fontSize: 13, color: 'var(--color-text-primary)', minWidth: 160 }}>{d.id}</div>
                    <span className={`badge ${badgeForBackend(d.backend)}`}>{d.backend}</span>
                    <span className="badge badge-outline">{d.visibility}</span>
                    {d.readOnly && <span className="badge badge-default">read-only</span>}
                    <div style={{ flex: 1, fontSize: 11, color: 'var(--color-text-tertiary)' }}>{d.actions.join(' · ')}</div>
                    {confirmDrop === d.id ? (
                      <>
                        <button className="btn btn-destructive btn-sm" onClick={() => dropDataset(d.id)}>Confirm drop</button>
                        <button className="btn btn-ghost btn-sm" onClick={() => setConfirmDrop(null)}>Cancel</button>
                      </>
                    ) : (
                      <button className="btn btn-ghost btn-sm" disabled={!canManage} onClick={() => setConfirmDrop(d.id)} title={canManage ? 'Drop dataset' : 'Local-only'}>
                        <Trash2 size={14} />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {tab === 'keys' && <KeysTab apiFetch={apiFetch} canManage={canManage} setError={setError} />}
        {tab === 'sync' && <SyncTab apiFetch={apiFetch} canManage={canManage} setError={setError} />}
      </div>
    </div>
  );
}

function KeysTab({ apiFetch, canManage, setError }: { apiFetch: <T,>(p: string, o?: { method?: string; body?: unknown }) => Promise<T>; canManage: boolean; setError: (s: string | null) => void }) {
  const [keys, setKeys] = useState<PublicKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [confirmRevoke, setConfirmRevoke] = useState<string | null>(null);

  const fetchKeys = useCallback(async () => {
    setLoading(true);
    try {
      const r = await apiFetch<{ keys: PublicKey[] }>('/data/keys');
      setKeys(r.keys || []);
    } catch (e) {
      console.error('fetchKeys failed', e);
      setError(e instanceof Error ? e.message : 'failed to load keys');
    } finally {
      setLoading(false);
    }
  }, [apiFetch, setError]);

  useEffect(() => { if (canManage) fetchKeys(); else setLoading(false); }, [canManage, fetchKeys]);

  const revoke = useCallback(async (keyId: string) => {
    try {
      await apiFetch(`/data/access/${encodeURIComponent(keyId)}`, { method: 'DELETE' });
      setConfirmRevoke(null);
      await fetchKeys();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'revoke failed');
    }
  }, [apiFetch, fetchKeys, setError]);

  if (!canManage) {
    return <div className="empty-state"><KeyRound size={32} className="empty-state-icon" /><div>Access-key management is local-only</div></div>;
  }
  if (loading) return <div className="empty-state"><Loader2 size={24} style={{ animation: 'spin 1s linear infinite' }} /><span style={{ fontSize: 12 }}>Loading…</span></div>;
  if (keys.length === 0) return <div className="empty-state"><KeyRound size={32} className="empty-state-icon" /><div>No access keys issued</div></div>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {keys.map((k) => {
        const expired = new Date(k.expiresAt).getTime() < Date.now();
        return (
          <div key={k.keyId} className="card" style={{ display: 'flex', alignItems: 'center', gap: 10, padding: 12 }}>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--color-text-primary)', minWidth: 150 }}>{k.keyId}</div>
            <span className="badge badge-default">{k.principalType}{k.principalId ? `:${k.principalId}` : ''}</span>
            {k.revoked ? <span className="badge badge-red">revoked</span> : expired ? <span className="badge badge-orange">expired</span> : <span className="badge badge-green">active</span>}
            <div style={{ flex: 1, fontSize: 11, color: 'var(--color-text-tertiary)' }}>
              {k.label ? `${k.label} · ` : ''}{k.grants.map((g) => `${g.dataset}[${g.actions.join(',')}]`).join(' ')} · exp {new Date(k.expiresAt).toLocaleString()}
            </div>
            {!k.revoked && (confirmRevoke === k.keyId ? (
              <>
                <button className="btn btn-destructive btn-sm" onClick={() => revoke(k.keyId)}>Confirm revoke</button>
                <button className="btn btn-ghost btn-sm" onClick={() => setConfirmRevoke(null)}>Cancel</button>
              </>
            ) : (
              <button className="btn btn-ghost btn-sm" onClick={() => setConfirmRevoke(k.keyId)}>Revoke</button>
            ))}
          </div>
        );
      })}
    </div>
  );
}

function SyncTab({ apiFetch, canManage, setError }: { apiFetch: <T,>(p: string, o?: { method?: string; body?: unknown }) => Promise<T>; canManage: boolean; setError: (s: string | null) => void }) {
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);

  const fetchStatus = useCallback(async () => {
    setLoading(true);
    try {
      setStatus(await apiFetch<SyncStatus>('/data/sync/status'));
    } catch (e) {
      console.error('fetchStatus failed', e);
      setError(e instanceof Error ? e.message : 'failed to load sync status');
    } finally {
      setLoading(false);
    }
  }, [apiFetch, setError]);

  useEffect(() => { if (canManage) fetchStatus(); else setLoading(false); }, [canManage, fetchStatus]);

  const runSync = useCallback(async () => {
    setRunning(true);
    try {
      setStatus(await apiFetch<SyncStatus>('/data/sync', { method: 'POST' }));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'sync failed');
    } finally {
      setRunning(false);
    }
  }, [apiFetch, setError]);

  if (!canManage) {
    return <div className="empty-state"><RefreshCw size={32} className="empty-state-icon" /><div>Cross-node sync is local-only</div></div>;
  }
  if (loading) return <div className="empty-state"><Loader2 size={24} style={{ animation: 'spin 1s linear infinite' }} /><span style={{ fontSize: 12 }}>Loading…</span></div>;

  const stat = (label: string, value: string | number) => (
    <div className="card" style={{ padding: 12, minWidth: 120 }}>
      <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 600, color: 'var(--color-text-primary)' }}>{value}</div>
    </div>
  );

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 12 }}>
        <div style={{ fontSize: 13, color: 'var(--color-text-tertiary)' }}>Last run: {status?.lastRun ? new Date(status.lastRun).toLocaleString() : 'never'}</div>
        <div style={{ flex: 1 }} />
        <button className="btn btn-primary btn-sm" disabled={running} onClick={runSync}>
          {running ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> : <RefreshCw size={14} />} Reconcile now
        </button>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
        {stat('Peers checked', status?.peersChecked ?? 0)}
        {stat('Datasets', status?.datasetsReplicated ?? 0)}
        {stat('Records applied', status?.recordsApplied ?? 0)}
        {stat('Records skipped', status?.recordsSkipped ?? 0)}
      </div>
      {status && status.errors.length > 0 && (
        <div className="card" style={{ marginTop: 12, borderColor: 'var(--color-status-red)' }}>
          <div style={{ fontSize: 12, color: 'var(--color-status-red)', marginBottom: 6 }}>Errors</div>
          {status.errors.map((er, i) => <div key={i} style={{ fontSize: 12, fontFamily: 'var(--font-mono)', color: 'var(--color-text-secondary)' }}>{er}</div>)}
        </div>
      )}
    </div>
  );
}
