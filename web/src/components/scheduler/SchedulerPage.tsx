'use client';

import { useState, useEffect, useCallback } from 'react';
import {
  Clock, RefreshCw, Loader2, Play, Eye, Trash2, Plus, X, Power, PowerOff, AlertTriangle, Save,
  ChevronDown, ChevronRight, FlaskConical,
} from 'lucide-react';
import { useAppMode } from '@/contexts/AppModeContext';

interface RunRec {
  at: string;
  status: 'ok' | 'error' | 'skipped';
  result: string;
  trigger: 'schedule' | 'manual' | 'test';
  exitCode?: number | null;
  durationMs?: number;
  stdout?: string;
  stderr?: string;
  condition?: string;
}

interface JobView {
  id: string;
  name?: string;
  description?: string;
  type: string;
  enabled: boolean;
  intervalMinutes: number;
  config: Record<string, unknown>;
  lastRunAt: string | null;
  lastResult: string | null;
  lastStatus: 'ok' | 'error' | 'skipped' | null;
  lastRun?: RunRec | null;
  runLog?: RunRec[];
  runCount?: number;
  builtin: boolean;
  nextRunAt: string | null;
  isRunning: boolean;
}

const statusColor = (s: string | null | undefined): string =>
  s === 'ok' ? 'var(--color-status-green)' : s === 'error' ? 'var(--color-status-red)' : s === 'skipped' ? 'var(--color-status-orange)' : 'var(--color-text-tertiary)';

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
/** Does this job have a dry-run⟷armed toggle? The built-in cleanup job, or any shell job whose
 *  command opts in with a `{{dryRun}}` placeholder. */
function hasDryRunToggle(j: JobView): boolean {
  if (j.type === 'cleanup-test-conversations') return true;
  if (j.type === 'shell') {
    const cmd = (j.config as { command?: unknown })?.command;
    const s = typeof cmd === 'string' ? cmd : Array.isArray(cmd) ? cmd.join(' ') : '';
    return /\{\{\s*dryRun\s*\}\}/.test(s);
  }
  return false;
}

/** Armed = the toggle is set to really act (dryRun off). */
function isArmed(j: JobView): boolean {
  return hasDryRunToggle(j) && j.config?.dryRun === false;
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
  const [form, setForm] = useState<{ id: string; name: string; description: string; type: string; intervalMinutes: string; command: string; runIf: string; maxRuns: string; autoRun: boolean }>(
    { id: '', name: '', description: '', type: 'shell', intervalMinutes: '1440', command: '', runIf: '', maxRuns: '', autoRun: false });
  const [creating, setCreating] = useState(false);
  // Per-job command draft (editing a shell job's command inline)
  const [cmdDraft, setCmdDraft] = useState<Record<string, string>>({});
  // Which jobs have their last-run output / run-log expanded
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

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

  const run = useCallback(async (id: string, opts: { dryRun?: boolean; test?: boolean } = {}) => {
    setBusyFor(id, true);
    setError(null);
    setConfirmRun(null);
    try {
      const updated = await apiFetch<JobView>(`/scheduler/jobs/${encodeURIComponent(id)}/run`, { method: 'POST', body: { dryRun: !!opts.dryRun, test: !!opts.test } });
      setJobs((prev) => prev.map((j) => (j.id === id ? updated : j)));
      const label = opts.test ? 'Test' : opts.dryRun ? 'Preview' : 'Run';
      const r = updated.lastRun;
      const detail = r ? `${r.status}${r.exitCode != null ? ` · exit ${r.exitCode}` : ''}${r.durationMs != null ? ` · ${r.durationMs}ms` : ''}` : `${updated.lastStatus}`;
      setRunResult((prev) => ({ ...prev, [id]: `${label}: ${detail} — ${updated.lastResult}` }));
      setExpanded((prev) => ({ ...prev, [id]: true })); // reveal output after a run
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
      const type = form.type.trim() || 'shell';
      const config: Record<string, unknown> = {};
      if (type === 'shell' && form.command.trim()) config.command = form.command;
      if (form.runIf.trim()) config.runIf = form.runIf.trim();
      if (Number(form.maxRuns) > 0) config.maxRuns = Number(form.maxRuns);
      const created = await apiFetch<JobView>('/scheduler/jobs', {
        method: 'POST',
        body: {
          id: form.id.trim(),
          name: form.name.trim() || undefined,
          description: form.description.trim() || undefined,
          type,
          intervalMinutes: Number(form.intervalMinutes) || 1440,
          enabled: form.autoRun,
          config: Object.keys(config).length ? config : undefined,
        },
      });
      setJobs((prev) => [...prev, created]);
      setShowCreate(false);
      setForm({ id: '', name: '', description: '', type: 'shell', intervalMinutes: '1440', command: '', runIf: '', maxRuns: '', autoRun: false });
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
            <label style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>name<br />
              <input className="input" value={form.name} placeholder="My job" onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </label>
            <label style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>type<br />
              <select className="input" value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
                <option value="shell">shell (run a script/command)</option>
                <option value="noop">noop (placeholder)</option>
              </select>
            </label>
            <label style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>interval (min)<br />
              <input className="input" type="number" value={form.intervalMinutes} onChange={(e) => setForm({ ...form, intervalMinutes: e.target.value })} style={{ width: 100 }} />
            </label>
            <label style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>max runs<br />
              <input className="input" type="number" value={form.maxRuns} placeholder="∞" onChange={(e) => setForm({ ...form, maxRuns: e.target.value })} style={{ width: 80 }} />
            </label>
            <label style={{ fontSize: 12, color: 'var(--color-text-secondary)', display: 'flex', alignItems: 'center', gap: 6, paddingBottom: 6 }}>
              <input type="checkbox" checked={form.autoRun} onChange={(e) => setForm({ ...form, autoRun: e.target.checked })} /> auto-run (enable)
            </label>
            <label style={{ fontSize: 12, color: 'var(--color-text-secondary)', flexBasis: '100%' }}>description<br />
              <input className="input" value={form.description} placeholder="what this job does" style={{ width: '100%' }} onChange={(e) => setForm({ ...form, description: e.target.value })} />
            </label>
            {form.type === 'shell' && (
              <label style={{ fontSize: 12, color: 'var(--color-text-secondary)', flexBasis: '100%' }}>command (runs in a shell — pipes/&&/redirects OK; <code>{'{{dryRun}}'}</code> for a toggle)<br />
                <textarea className="input" value={form.command} placeholder="e.g. cd ~/proj && ./backup.sh" rows={2}
                  style={{ width: '100%', fontFamily: 'var(--font-mono)', resize: 'vertical' }}
                  onChange={(e) => setForm({ ...form, command: e.target.value })} />
              </label>
            )}
            <label style={{ fontSize: 12, color: 'var(--color-text-secondary)', flexBasis: '100%' }}>run condition (optional) — a guard command; a scheduled run only fires if it exits 0<br />
              <input className="input" value={form.runIf} placeholder="e.g. test -f /tmp/ready" style={{ width: '100%', fontFamily: 'var(--font-mono)' }}
                onChange={(e) => setForm({ ...form, runIf: e.target.value })} />
            </label>
            <button className="btn btn-primary btn-sm" disabled={creating || !form.id.trim()} onClick={createJob}>
              {creating ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> : 'Create'}
            </button>
            <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)', flexBasis: '100%' }}>
              Jobs start <strong>disabled</strong> — enable + set an interval to schedule. A <code>shell</code> job runs its command
              on the worker (operator-set, like a crontab line); use <strong>Preview run</strong> to see what would run.
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
              const shell = j.type === 'shell';
              const toggle = hasDryRunToggle(j);
              const cmdVal = (j.config as { command?: unknown })?.command;
              const cmdIsArray = Array.isArray(cmdVal);
              const cmdStr = typeof cmdVal === 'string' ? cmdVal : cmdIsArray ? (cmdVal as string[]).join(' ') : '';
              const cmdEdit = cmdDraft[j.id];
              return (
                <div key={j.id} className="card" style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {/* Top row */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                    {j.name && <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--color-text-primary)' }}>{j.name}</span>}
                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: j.name ? 12 : 14, fontWeight: j.name ? 400 : 600, color: j.name ? 'var(--color-text-tertiary)' : 'var(--color-text-primary)' }}>{j.id}</span>
                    {j.builtin && <span className="badge badge-outline">built-in</span>}
                    <span className={`badge ${st.cls}`}>{st.text}</span>
                    {armed && <span className="badge badge-red" title={cleanup ? 'Will permanently delete matching conversations' : 'Will run for real (dry-run off)'}><AlertTriangle size={11} style={{ marginRight: 3 }} />{cleanup ? 'armed · deletes' : 'armed'}</span>}
                    {toggle && !armed && <span className="badge badge-green">dry-run · safe</span>}
                    <div style={{ flex: 1 }} />
                    {isBusy && <Loader2 size={14} style={{ animation: 'spin 1s linear infinite', color: 'var(--color-text-tertiary)' }} />}
                  </div>
                  {j.description && <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginTop: -4 }}>{j.description}</div>}

                  {/* Meta */}
                  <div style={{ fontSize: 12, color: 'var(--color-text-tertiary)', display: 'flex', flexDirection: 'column', gap: 3 }}>
                    <div>type: <span style={{ fontFamily: 'var(--font-mono)' }}>{j.type}</span></div>
                    {shell ? (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                        <span>command{cmdIsArray ? ' (argv — edit via API/MCP)' : ' (runs in a shell)'}:</span>
                        <textarea className="input" value={cmdEdit ?? cmdStr} disabled={isBusy || cmdIsArray} rows={2}
                          placeholder="e.g. cd ~/proj && ./backup.sh"
                          style={{ width: '100%', fontFamily: 'var(--font-mono)', fontSize: 12, resize: 'vertical' }}
                          onChange={(e) => setCmdDraft((p) => ({ ...p, [j.id]: e.target.value }))} />
                        {!cmdIsArray && cmdEdit !== undefined && cmdEdit !== cmdStr && (
                          <button className="btn btn-ghost btn-sm" style={{ alignSelf: 'flex-start' }} disabled={isBusy}
                            onClick={() => { update(j.id, { config: { command: cmdEdit } }); setCmdDraft((p) => { const n = { ...p }; delete n[j.id]; return n; }); }}>
                            <Save size={13} /> Save command
                          </button>
                        )}
                      </div>
                    ) : (
                      <div>config: <span style={{ fontFamily: 'var(--font-mono)' }}>{JSON.stringify(j.config)}</span></div>
                    )}

                    {/* Execution conditions */}
                    {(j.config?.runIf || (j.config?.maxRuns as number) > 0) && (
                      <div>conditions:{' '}
                        {j.config?.runIf ? <span>runIf <span style={{ fontFamily: 'var(--font-mono)' }}>{String(j.config.runIf).slice(0, 60)}</span></span> : null}
                        {(j.config?.maxRuns as number) > 0 ? <span>{j.config?.runIf ? ' · ' : ''}maxRuns {String(j.config.maxRuns)} (run {j.runCount ?? 0}×)</span> : null}
                      </div>
                    )}

                    {/* Last run — status, exit code, duration; output expandable */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span>last run: {fmtTime(j.lastRunAt)}</span>
                      {j.lastRun ? (
                        <>
                          <span style={{ color: statusColor(j.lastRun.status), fontWeight: 600 }}>{j.lastRun.status}</span>
                          {j.lastRun.exitCode != null && <span>· exit {j.lastRun.exitCode}</span>}
                          {j.lastRun.durationMs != null && <span>· {j.lastRun.durationMs}ms</span>}
                          <span style={{ color: 'var(--color-text-tertiary)' }}>· {j.lastRun.trigger}</span>
                          {(j.lastRun.stdout || j.lastRun.stderr || j.runLog?.length) ? (
                            <button className="btn btn-ghost btn-sm" style={{ padding: '0 4px' }} onClick={() => setExpanded((p) => ({ ...p, [j.id]: !p[j.id] }))}>
                              {expanded[j.id] ? <ChevronDown size={13} /> : <ChevronRight size={13} />} output
                            </button>
                          ) : null}
                        </>
                      ) : j.lastStatus ? <span>— {j.lastStatus}: {j.lastResult}</span> : <span>— never</span>}
                    </div>

                    {expanded[j.id] && j.lastRun && (
                      <div style={{ background: 'var(--color-bg-elevated)', border: '1px solid var(--color-border-subtle)', borderRadius: 'var(--radius-sm)', padding: 8, fontFamily: 'var(--font-mono)', fontSize: 11, whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: 200, overflow: 'auto' }}>
                        <div style={{ color: 'var(--color-text-secondary)' }}>{j.lastRun.result}</div>
                        {j.lastRun.condition && <div style={{ color: 'var(--color-status-orange)' }}>condition: {j.lastRun.condition}</div>}
                        {j.lastRun.stdout && <div style={{ marginTop: 4 }}><span style={{ color: 'var(--color-text-tertiary)' }}>stdout:</span>{'\n'}{j.lastRun.stdout}</div>}
                        {j.lastRun.stderr?.trim() && <div style={{ marginTop: 4, color: 'var(--color-status-red)' }}><span style={{ color: 'var(--color-text-tertiary)' }}>stderr:</span>{'\n'}{j.lastRun.stderr}</div>}
                        {(j.runLog?.length ?? 0) > 1 && (
                          <div style={{ marginTop: 6, paddingTop: 6, borderTop: '1px solid var(--color-border-subtle)', color: 'var(--color-text-tertiary)' }}>
                            history ({j.runLog!.length}):{j.runLog!.slice(0, 8).map((r, i) => (
                              <div key={i}>· {fmtTime(r.at)} [{r.trigger}] <span style={{ color: statusColor(r.status) }}>{r.status}</span>{r.exitCode != null ? ` exit ${r.exitCode}` : ''} — {r.result.slice(0, 50)}</div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}

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

                    {/* Arm toggle — cleanup job or any shell job with a {{dryRun}} placeholder */}
                    {toggle && (
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

                    {/* Test run — execute once, capture full output, don't touch the schedule (safe/dry for toggle jobs) */}
                    <button className="btn btn-ghost btn-sm" disabled={isBusy} onClick={() => run(j.id, { test: true, dryRun: toggle })} title="Test run: execute once and show output; doesn't advance the schedule">
                      <FlaskConical size={13} /> Test
                    </button>

                    {/* Preview run (always safe) */}
                    {toggle && (
                      <button className="btn btn-ghost btn-sm" disabled={isBusy} onClick={() => run(j.id, { dryRun: true })} title="Run now in preview (deletes nothing)">
                        <Eye size={13} /> Preview run
                      </button>
                    )}

                    {/* Real run — for an armed cleanup job (deletes) or any shell job (runs the command). Needs confirm. */}
                    {(armed || shell) && (
                      confirmRun === j.id ? (
                        <>
                          <button className="btn btn-destructive btn-sm" disabled={isBusy} onClick={() => run(j.id, {})}>
                            {armed ? (cleanup ? 'Confirm run (deletes)' : 'Confirm run (live)') : 'Confirm run'}
                          </button>
                          <button className="btn btn-ghost btn-sm" onClick={() => setConfirmRun(null)}>Cancel</button>
                        </>
                      ) : (
                        <button className="btn btn-destructive btn-sm" disabled={isBusy} onClick={() => setConfirmRun(j.id)} title={armed ? 'Run now and actually delete' : 'Run the command now'}>
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
