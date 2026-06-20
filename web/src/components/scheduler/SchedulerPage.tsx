'use client';

import { useState, useEffect, useCallback } from 'react';
import {
  Clock, RefreshCw, Loader2, Play, Eye, Trash2, Plus, X, Power, PowerOff, AlertTriangle, Save,
} from 'lucide-react';
import { useAppMode } from '@/contexts/AppModeContext';

interface JobView {
  id: string;
  type: string;
  enabled: boolean;
  intervalMinutes: number;
  config: Record<string, unknown>;
  lastRunAt: string | null;
  lastResult: string | null;
  lastStatus: 'ok' | 'error' | 'skipped' | null;
  builtin: boolean;
  nextRunAt: string | null;
  isRunning: boolean;
}

function fmtTime(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

function stateLabel(j: JobView): { text: string; cls: string } {
  if (j.isRunning) return { text: 'running', cls: 'badge-blue' };
  if (!j.enabled) return { text: 'disabled', cls: 'badge-default' };
  if (j.intervalMinutes <= 0) return { text: 'paused', cls: 'badge-default' };
  const m = j.intervalMinutes;
  const human = m % 1440 === 0 ? `${m / 1440}d` : m % 60 === 0 ? `${m / 60}h` : `${m}m`;
  return { text: `every ${human}`, cls: 'badge-green' };
}

/** Is this the destructive cleanup job, armed (dryRun explicitly false)? */
function isArmed(j: JobView): boolean {
  return j.type === 'cleanup-test-conversations' && j.config?.dryRun === false;
}

export function SchedulerPage() {
  const { apiClient, proxy } = useAppMode();

  const apiFetch = useCallback(
    async <T,>(path: string, opts?: { method?: string; body?: unknown }): Promise<T> =>
      apiClient.fetchPath<T>(path, { method: opts?.method, body: opts?.body, machineId: proxy.machineId || undefined }),
    [apiClient, proxy.machineId],
  );

  const [jobs, setJobs] = useState<JobView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [intervalDraft, setIntervalDraft] = useState<Record<string, string>>({});
  const [confirmArm, setConfirmArm] = useState<string | null>(null);
  const [confirmRun, setConfirmRun] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [runResult, setRunResult] = useState<Record<string, string>>({});

  // Create-job form
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState<{ id: string; type: string; intervalMinutes: string }>({ id: '', type: 'noop', intervalMinutes: '1440' });
  const [creating, setCreating] = useState(false);

  const setBusyFor = (id: string, on: boolean) =>
    setBusy((prev) => { const n = new Set(prev); if (on) n.add(id); else n.delete(id); return n; });

  const fetchJobs = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await apiFetch<{ jobs: JobView[]; count: number }>('/scheduler/jobs');
      setJobs(r.jobs || []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [apiFetch]);

  useEffect(() => { fetchJobs(); }, [fetchJobs]);

  const update = useCallback(async (id: string, body: Record<string, unknown>) => {
    setBusyFor(id, true);
    setError(null);
    try {
      const updated = await apiFetch<JobView>(`/scheduler/jobs/${encodeURIComponent(id)}`, { method: 'PUT', body });
      setJobs((prev) => prev.map((j) => (j.id === id ? updated : j)));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyFor(id, false);
    }
  }, [apiFetch]);

  const run = useCallback(async (id: string, dryRun: boolean) => {
    setBusyFor(id, true);
    setError(null);
    setConfirmRun(null);
    try {
      const updated = await apiFetch<JobView>(`/scheduler/jobs/${encodeURIComponent(id)}/run`, { method: 'POST', body: { dryRun } });
      setJobs((prev) => prev.map((j) => (j.id === id ? updated : j)));
      setRunResult((prev) => ({ ...prev, [id]: `${dryRun ? 'Preview' : 'Run'}: ${updated.lastStatus} — ${updated.lastResult}` }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyFor(id, false);
    }
  }, [apiFetch]);

  const remove = useCallback(async (id: string) => {
    setBusyFor(id, true);
    setError(null);
    setConfirmDelete(null);
    try {
      await apiFetch(`/scheduler/jobs/${encodeURIComponent(id)}`, { method: 'DELETE' });
      setJobs((prev) => prev.filter((j) => j.id !== id));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyFor(id, false);
    }
  }, [apiFetch]);

  const createJob = useCallback(async () => {
    if (!form.id.trim()) return;
    setCreating(true);
    setError(null);
    try {
      const created = await apiFetch<JobView>('/scheduler/jobs', {
        method: 'POST',
        body: { id: form.id.trim(), type: form.type.trim() || 'noop', intervalMinutes: Number(form.intervalMinutes) || 1440, enabled: false },
      });
      setJobs((prev) => [...prev, created]);
      setShowCreate(false);
      setForm({ id: '', type: 'noop', intervalMinutes: '1440' });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  }, [apiFetch, form]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden', background: 'var(--color-bg-root)' }}>
      {/* Header */}
      <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--color-border-default)', display: 'flex', alignItems: 'center', gap: 12 }}>
        <Clock size={20} style={{ color: 'var(--color-accent)' }} />
        <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--color-text-primary)' }}>Scheduled Jobs</div>
        <span style={{ fontSize: 12, color: 'var(--color-text-tertiary)' }}>lm-assist internal scheduler (not OS cron)</span>
        <div style={{ flex: 1 }} />
        <button className="btn btn-ghost btn-sm" onClick={fetchJobs} disabled={loading} title="Refresh">
          <RefreshCw size={14} style={loading ? { animation: 'spin 1s linear infinite' } : undefined} />
        </button>
        <button className="btn btn-primary btn-sm" onClick={() => setShowCreate((v) => !v)}>
          <Plus size={14} /> New job
        </button>
      </div>

      {error && (
        <div style={{ margin: '12px 20px 0', padding: '8px 12px', borderRadius: 'var(--radius-md)', background: 'var(--color-bg-elevated)', border: '1px solid var(--color-status-red)', color: 'var(--color-status-red)', fontSize: 12, display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ flex: 1 }}>{error}</span>
          <button className="btn btn-ghost btn-sm" onClick={() => setError(null)}><X size={12} /></button>
        </div>
      )}

      <div style={{ flex: 1, overflow: 'auto', padding: 20 }}>
        {showCreate && (
          <div className="card" style={{ marginBottom: 12, display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'flex-end' }}>
            <label style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>id<br />
              <input className="input" value={form.id} placeholder="my-job" onChange={(e) => setForm({ ...form, id: e.target.value })} />
            </label>
            <label style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>type (handler)<br />
              <input className="input" value={form.type} placeholder="noop" onChange={(e) => setForm({ ...form, type: e.target.value })} />
            </label>
            <label style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>interval (min)<br />
              <input className="input" type="number" value={form.intervalMinutes} onChange={(e) => setForm({ ...form, intervalMinutes: e.target.value })} style={{ width: 110 }} />
            </label>
            <button className="btn btn-primary btn-sm" disabled={creating || !form.id.trim()} onClick={createJob}>
              {creating ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> : 'Create'}
            </button>
            <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)', flexBasis: '100%' }}>
              Custom jobs start disabled. `type` must be a registered handler (currently <code>cleanup-test-conversations</code>; <code>noop</code> is a placeholder).
            </span>
          </div>
        )}

        {loading ? (
          <div className="empty-state"><Loader2 size={24} style={{ animation: 'spin 1s linear infinite' }} /><span style={{ fontSize: 12 }}>Loading…</span></div>
        ) : jobs.length === 0 ? (
          <div className="empty-state"><Clock size={32} className="empty-state-icon" /><div>No scheduled jobs</div></div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {jobs.map((j) => {
              const st = stateLabel(j);
              const armed = isArmed(j);
              const isBusy = busy.has(j.id);
              const draft = intervalDraft[j.id] ?? String(j.intervalMinutes);
              const cleanup = j.type === 'cleanup-test-conversations';
              return (
                <div key={j.id} className="card" style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {/* Top row */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: 14, fontWeight: 600, color: 'var(--color-text-primary)' }}>{j.id}</span>
                    {j.builtin && <span className="badge badge-outline">built-in</span>}
                    <span className={`badge ${st.cls}`}>{st.text}</span>
                    {armed && <span className="badge badge-red" title="Will permanently delete matching conversations"><AlertTriangle size={11} style={{ marginRight: 3 }} />armed · deletes</span>}
                    {cleanup && !armed && <span className="badge badge-green">dry-run · safe</span>}
                    <div style={{ flex: 1 }} />
                    {isBusy && <Loader2 size={14} style={{ animation: 'spin 1s linear infinite', color: 'var(--color-text-tertiary)' }} />}
                  </div>

                  {/* Meta */}
                  <div style={{ fontSize: 12, color: 'var(--color-text-tertiary)', display: 'flex', flexDirection: 'column', gap: 3 }}>
                    <div>type: <span style={{ fontFamily: 'var(--font-mono)' }}>{j.type}</span></div>
                    <div>config: <span style={{ fontFamily: 'var(--font-mono)' }}>{JSON.stringify(j.config)}</span></div>
                    <div>last run: {fmtTime(j.lastRunAt)}{j.lastStatus ? ` — ${j.lastStatus}: ${j.lastResult}` : ''}</div>
                    <div>next run: {j.enabled && j.intervalMinutes > 0 ? fmtTime(j.nextRunAt) : '— (not scheduled)'}</div>
                    {runResult[j.id] && <div style={{ color: 'var(--color-accent)' }}>{runResult[j.id]}</div>}
                  </div>

                  {/* Controls */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', borderTop: '1px solid var(--color-border-subtle)', paddingTop: 10 }}>
                    {/* Enable / disable */}
                    <button className={`btn btn-sm ${j.enabled ? 'btn-ghost' : 'btn-primary'}`} disabled={isBusy} onClick={() => update(j.id, { enabled: !j.enabled })} title={j.enabled ? 'Disable' : 'Enable'}>
                      {j.enabled ? <><PowerOff size={13} /> Disable</> : <><Power size={13} /> Enable</>}
                    </button>

                    {/* Interval */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                      <input className="input" type="number" value={draft} style={{ width: 90 }} disabled={isBusy}
                        onChange={(e) => setIntervalDraft((p) => ({ ...p, [j.id]: e.target.value }))} />
                      <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>min</span>
                      {draft !== String(j.intervalMinutes) && (
                        <button className="btn btn-ghost btn-sm" disabled={isBusy} onClick={() => update(j.id, { intervalMinutes: Number(draft) || 0 })} title="Save interval">
                          <Save size={13} />
                        </button>
                      )}
                    </div>

                    {/* Arm toggle for the cleanup job */}
                    {cleanup && (
                      armed ? (
                        <button className="btn btn-ghost btn-sm" disabled={isBusy} onClick={() => update(j.id, { config: { dryRun: true } })} title="Switch back to safe dry-run mode">
                          Disarm (dry-run)
                        </button>
                      ) : confirmArm === j.id ? (
                        <>
                          <button className="btn btn-destructive btn-sm" disabled={isBusy} onClick={() => { setConfirmArm(null); update(j.id, { config: { dryRun: false } }); }}>
                            Confirm arm
                          </button>
                          <button className="btn btn-ghost btn-sm" onClick={() => setConfirmArm(null)}>Cancel</button>
                        </>
                      ) : (
                        <button className="btn btn-ghost btn-sm" disabled={isBusy} onClick={() => setConfirmArm(j.id)} title="Arm real deletion (turns off dry-run)">
                          <AlertTriangle size={13} /> Arm deletion
                        </button>
                      )
                    )}

                    <div style={{ flex: 1 }} />

                    {/* Preview run (always safe) */}
                    <button className="btn btn-ghost btn-sm" disabled={isBusy} onClick={() => run(j.id, true)} title="Run now in preview (deletes nothing)">
                      <Eye size={13} /> Preview run
                    </button>

                    {/* Real run — only meaningful when armed; needs confirm */}
                    {armed && (
                      confirmRun === j.id ? (
                        <>
                          <button className="btn btn-destructive btn-sm" disabled={isBusy} onClick={() => run(j.id, false)}>Confirm run (deletes)</button>
                          <button className="btn btn-ghost btn-sm" onClick={() => setConfirmRun(null)}>Cancel</button>
                        </>
                      ) : (
                        <button className="btn btn-destructive btn-sm" disabled={isBusy} onClick={() => setConfirmRun(j.id)} title="Run now and actually delete">
                          <Play size={13} /> Run now
                        </button>
                      )
                    )}

                    {/* Delete (custom only) */}
                    {!j.builtin && (
                      confirmDelete === j.id ? (
                        <>
                          <button className="btn btn-destructive btn-sm" disabled={isBusy} onClick={() => remove(j.id)}>Confirm delete</button>
                          <button className="btn btn-ghost btn-sm" onClick={() => setConfirmDelete(null)}>Cancel</button>
                        </>
                      ) : (
                        <button className="btn btn-ghost btn-sm" disabled={isBusy} onClick={() => setConfirmDelete(j.id)} title="Delete job">
                          <Trash2 size={13} />
                        </button>
                      )
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        <div style={{ marginTop: 16, fontSize: 11, color: 'var(--color-text-tertiary)', lineHeight: 1.6 }}>
          The <code>cleanup-test-conversations</code> job sweeps claude.ai conversations whose auto-delete TTL has expired
          (plus any explicit ids in its config). It ships <strong>disabled</strong> and in <strong>dry-run</strong> mode — a
          preview reports what would be deleted without touching anything. Enabling it + arming deletion (dry-run off) is a
          deliberate action; the actual deletion only runs once you arm it.
        </div>
      </div>
    </div>
  );
}
