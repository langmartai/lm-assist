'use client';

import { useState, useEffect, useCallback } from 'react';
import {
  Target,
  RefreshCw,
  Loader2,
  Plus,
  X,
  Play,
  Pause,
  CheckCircle,
  ChevronDown,
  ChevronRight,
  Plug,
} from 'lucide-react';
import { useAppMode } from '@/contexts/AppModeContext';
import { CcrCloudView } from '@/components/ccr/CcrCloudView';

// ── Types ──────────────────────────────────────────────────────────────────

type MissionStatus = 'draft' | 'active' | 'waiting' | 'paused' | 'blocked' | 'done' | 'failed';
type Isolation = 'cloud' | 'worktree' | 'shared';

interface MissionEnv {
  isolation: Isolation;
  host?: string;
  repo?: string;
  branch?: string;
  resources: string[];
  exclusive?: boolean;
}

interface MissionBinding {
  sessionId: string | null;
  node: string | null;
  kind: 'orchestrator' | 'worker' | null;
}

interface MissionProgress {
  percent: number;
  summary: string;
  updatedAt: number;
}

interface MissionControl {
  nudgeCount: number;
  backoffStep: number;
  lastTickAt?: number;
  waitReason?: string;
}

interface MissionAdjustment {
  at: number;
  trigger: string;
  change: string;
  by: 'controller' | 'user';
}

interface Mission {
  id: string;
  title: string;
  objective: string;
  plan?: string;
  nextSteps?: string[];
  projects: string[];
  dependsOn: string[];
  env: MissionEnv;
  binding: MissionBinding | null;
  progress: MissionProgress | null;
  control: MissionControl;
  results: Array<{ at: number; ref: string; summary?: string }>;
  adjustments: MissionAdjustment[];
  status: MissionStatus;
  ownerNode: string;
  createdAt: number;
  updatedAt: number;
}

interface ControllerStatus {
  election: {
    isMonitor: boolean;
    monitorNodeId: string | null;
    selfId: string;
  };
  job: {
    enabled: boolean;
    intervalMinutes: number;
    lastRun?: {
      at: string;
      status: 'ok' | 'error' | 'skipped';
      result: string;
    } | null;
  };
}

// ── Helpers ────────────────────────────────────────────────────────────────

const STATUS_COLORS: Record<MissionStatus, string> = {
  draft: 'var(--color-text-tertiary)',
  active: 'var(--color-status-green)',
  waiting: 'var(--color-status-orange)',
  paused: 'var(--color-text-tertiary)',
  blocked: 'var(--color-status-red)',
  done: 'var(--color-accent)',
  failed: 'var(--color-status-red)',
};

const STATUS_BADGE: Record<MissionStatus, string> = {
  draft: 'badge-default',
  active: 'badge-green',
  waiting: 'badge-blue',
  paused: 'badge-default',
  blocked: 'badge-red',
  done: 'badge-outline',
  failed: 'badge-red',
};

function fmtTime(ts: number | string | null | undefined): string {
  if (!ts) return '—';
  const d = typeof ts === 'number' ? new Date(ts) : new Date(ts);
  if (Number.isNaN(d.getTime())) return String(ts);
  return d.toLocaleString();
}

function shortId(id: string | null): string {
  if (!id) return '—';
  return id.length > 12 ? id.slice(0, 8) + '…' : id;
}

// ── Main component ─────────────────────────────────────────────────────────

export function MissionsPage() {
  const { apiClient, proxy } = useAppMode();

  const apiFetch = useCallback(
    async <T,>(path: string, opts?: { method?: string; body?: unknown }): Promise<T> =>
      apiClient.fetchPath<T>(path, {
        method: opts?.method,
        body: opts?.body,
        machineId: proxy.machineId || undefined,
      }),
    [apiClient, proxy.machineId],
  );

  // ── State ──
  const [missions, setMissions] = useState<Mission[]>([]);
  const [controller, setController] = useState<ControllerStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [tickBusy, setTickBusy] = useState(false);
  const [tickResult, setTickResult] = useState<string | null>(null);

  // Create form
  const [showCreate, setShowCreate] = useState(false);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({
    title: '',
    objective: '',
    isolation: 'cloud' as Isolation,
    projects: '',
    dependsOn: '',
  });

  // Per-mission objective editing
  const [objDraft, setObjDraft] = useState<Record<string, string>>({});

  // Connect/drive a mission's cloud executor inline
  const [connectSid, setConnectSid] = useState<string | null>(null);

  // ── Data loading ──
  const fetchAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [missionsRes, ctrlRes] = await Promise.allSettled([
        apiFetch<{ missions?: Mission[]; data?: Mission[] } | Mission[]>('/mission'),
        apiFetch<{ data?: ControllerStatus } | ControllerStatus>('/mission/controller'),
      ]);

      if (missionsRes.status === 'fulfilled') {
        const raw = missionsRes.value as any;
        const list: Mission[] = Array.isArray(raw) ? raw : raw.missions ?? raw.data ?? [];
        setMissions(list);
      } else {
        setError(missionsRes.reason instanceof Error ? missionsRes.reason.message : String(missionsRes.reason));
      }

      if (ctrlRes.status === 'fulfilled') {
        const raw = ctrlRes.value as any;
        setController((raw.data ?? raw) as ControllerStatus);
      }
    } finally {
      setLoading(false);
    }
  }, [apiFetch]);

  // Initial load + 5s auto-refresh
  useEffect(() => {
    fetchAll();
    const interval = setInterval(fetchAll, 5000);
    return () => clearInterval(interval);
  }, [fetchAll]);

  // ── Helpers ──
  const setBusyFor = (id: string, on: boolean) =>
    setBusy((prev) => {
      const n = new Set(prev);
      if (on) n.add(id);
      else n.delete(id);
      return n;
    });

  const toggleExpand = (id: string) =>
    setExpanded((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  // ── Actions ──
  const updateMission = useCallback(
    async (id: string, body: Record<string, unknown>) => {
      setBusyFor(id, true);
      setError(null);
      try {
        const updated = await apiFetch<Mission>(`/mission/${encodeURIComponent(id)}`, {
          method: 'POST',
          body,
        });
        setMissions((prev) => prev.map((m) => (m.id === id ? updated : m)));
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusyFor(id, false);
      }
    },
    [apiFetch],
  );

  const createMission = useCallback(async () => {
    if (!form.title.trim() || !form.objective.trim()) return;
    setCreating(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {
        title: form.title.trim(),
        objective: form.objective.trim(),
        env: { isolation: form.isolation },
      };
      if (form.projects.trim()) {
        body.projects = form.projects.split(',').map((s) => s.trim()).filter(Boolean);
      }
      if (form.dependsOn.trim()) {
        body.dependsOn = form.dependsOn.split(',').map((s) => s.trim()).filter(Boolean);
      }
      const created = await apiFetch<Mission>('/mission', { method: 'POST', body });
      setMissions((prev) => [created, ...prev]);
      setShowCreate(false);
      setForm({ title: '', objective: '', isolation: 'cloud', projects: '', dependsOn: '' });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  }, [apiFetch, form]);

  const runTick = useCallback(async () => {
    setTickBusy(true);
    setTickResult(null);
    setError(null);
    try {
      const res = await apiFetch<any>('/scheduler/jobs/mission-controller/run', { method: 'POST' });
      const status = res?.lastStatus ?? res?.status ?? 'ok';
      const result = res?.lastResult ?? res?.result ?? 'tick triggered';
      setTickResult(`${status}: ${result}`);
      // Refresh mission list after tick
      setTimeout(() => fetchAll(), 1000);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setTickBusy(false);
    }
  }, [apiFetch, fetchAll]);

  // ── Render ──
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        overflow: 'hidden',
        background: 'var(--color-bg-root)',
      }}
    >
      {/* ── Header ── */}
      <div
        style={{
          padding: '16px 20px',
          borderBottom: '1px solid var(--color-border-default)',
          display: 'flex',
          alignItems: 'center',
          gap: 12,
        }}
      >
        <Target size={20} style={{ color: 'var(--color-accent)' }} />
        <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--color-text-primary)' }}>
          Missions
        </div>
        <span style={{ fontSize: 12, color: 'var(--color-text-tertiary)' }}>
          Mission Controller
        </span>
        <div style={{ flex: 1 }} />
        <button
          className="btn btn-ghost btn-sm"
          onClick={fetchAll}
          disabled={loading}
          title="Refresh"
        >
          <RefreshCw
            size={14}
            style={loading ? { animation: 'spin 1s linear infinite' } : undefined}
          />
        </button>
        <button
          className="btn btn-primary btn-sm"
          onClick={() => setShowCreate((v) => !v)}
        >
          <Plus size={14} /> New mission
        </button>
      </div>

      {/* ── Error banner ── */}
      {error && (
        <div
          style={{
            margin: '12px 20px 0',
            padding: '8px 12px',
            borderRadius: 'var(--radius-md)',
            background: 'var(--color-bg-elevated)',
            border: '1px solid var(--color-status-red)',
            color: 'var(--color-status-red)',
            fontSize: 12,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
          }}
        >
          <span style={{ flex: 1 }}>{error}</span>
          <button className="btn btn-ghost btn-sm" onClick={() => setError(null)}>
            <X size={12} />
          </button>
        </div>
      )}

      <div style={{ flex: 1, overflow: 'auto', padding: 20, display: 'flex', flexDirection: 'column', gap: 16 }}>

        {/* ── Controller status card ── */}
        {controller && (
          <div className="card" style={{ padding: 14 }}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                marginBottom: 8,
                flexWrap: 'wrap',
              }}
            >
              <span
                style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-text-primary)' }}
              >
                Controller
              </span>
              {controller.election.isMonitor ? (
                <span className="badge badge-green">this node is monitor</span>
              ) : (
                <span className="badge badge-default">
                  monitor: {shortId(controller.election.monitorNodeId)}
                </span>
              )}
              <span className={`badge ${controller.job.enabled ? 'badge-green' : 'badge-default'}`}>
                {controller.job.enabled ? `enabled · every ${controller.job.intervalMinutes}m` : 'disabled'}
              </span>
              <div style={{ flex: 1 }} />
              <button
                className="btn btn-ghost btn-sm"
                onClick={runTick}
                disabled={tickBusy}
                title="Run controller tick now"
              >
                {tickBusy ? (
                  <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} />
                ) : (
                  <Play size={13} />
                )}{' '}
                Run tick now
              </button>
            </div>
            <div style={{ fontSize: 12, color: 'var(--color-text-tertiary)', display: 'flex', flexDirection: 'column', gap: 3 }}>
              <div>
                self: <span style={{ fontFamily: 'var(--font-mono)' }}>{controller.election.selfId}</span>
              </div>
              {controller.job.lastRun ? (
                <div>
                  last tick:{' '}
                  <span>{fmtTime(controller.job.lastRun.at)}</span>{' '}
                  <span
                    style={{
                      color:
                        controller.job.lastRun.status === 'ok'
                          ? 'var(--color-status-green)'
                          : 'var(--color-status-red)',
                      fontWeight: 600,
                    }}
                  >
                    {controller.job.lastRun.status}
                  </span>{' '}
                  — {controller.job.lastRun.result}
                </div>
              ) : (
                <div>last tick: never</div>
              )}
              {tickResult && (
                <div style={{ color: 'var(--color-accent)', marginTop: 2 }}>
                  tick result: {tickResult}
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── Create form ── */}
        {showCreate && (
          <div
            className="card"
            style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}
          >
            <div
              style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-text-primary)', marginBottom: 2 }}
            >
              New Mission
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'flex-start' }}>
              <label style={{ fontSize: 12, color: 'var(--color-text-secondary)', flex: '1 1 200px' }}>
                title *
                <br />
                <input
                  className="input"
                  value={form.title}
                  placeholder="e.g. Migrate auth module"
                  style={{ width: '100%' }}
                  onChange={(e) => setForm({ ...form, title: e.target.value })}
                />
              </label>
              <label style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>
                isolation
                <br />
                <select
                  className="input"
                  value={form.isolation}
                  onChange={(e) =>
                    setForm({ ...form, isolation: e.target.value as Isolation })
                  }
                >
                  <option value="cloud">cloud</option>
                  <option value="worktree">worktree</option>
                  <option value="shared">shared</option>
                </select>
              </label>
            </div>
            <label style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>
              objective * — what the mission must accomplish
              <br />
              <textarea
                className="input"
                value={form.objective}
                placeholder="Describe the goal in detail…"
                rows={3}
                style={{ width: '100%', resize: 'vertical' }}
                onChange={(e) => setForm({ ...form, objective: e.target.value })}
              />
            </label>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              <label style={{ fontSize: 12, color: 'var(--color-text-secondary)', flex: '1 1 180px' }}>
                projects (comma-separated, optional)
                <br />
                <input
                  className="input"
                  value={form.projects}
                  placeholder="owner/repo, …"
                  style={{ width: '100%' }}
                  onChange={(e) => setForm({ ...form, projects: e.target.value })}
                />
              </label>
              <label style={{ fontSize: 12, color: 'var(--color-text-secondary)', flex: '1 1 180px' }}>
                depends on (mission IDs, comma-separated)
                <br />
                <input
                  className="input"
                  value={form.dependsOn}
                  placeholder="ms-abc123, …"
                  style={{ width: '100%' }}
                  onChange={(e) => setForm({ ...form, dependsOn: e.target.value })}
                />
              </label>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                className="btn btn-primary btn-sm"
                disabled={creating || !form.title.trim() || !form.objective.trim()}
                onClick={createMission}
              >
                {creating ? (
                  <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} />
                ) : (
                  'Create'
                )}
              </button>
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => {
                  setShowCreate(false);
                  setForm({
                    title: '',
                    objective: '',
                    isolation: 'cloud',
                    projects: '',
                    dependsOn: '',
                  });
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {/* ── Mission list ── */}
        {loading && missions.length === 0 ? (
          <div className="empty-state">
            <Loader2 size={24} style={{ animation: 'spin 1s linear infinite' }} />
            <span style={{ fontSize: 12 }}>Loading…</span>
          </div>
        ) : missions.length === 0 ? (
          <div className="empty-state">
            <Target size={32} className="empty-state-icon" />
            <div>No missions yet</div>
            <div style={{ fontSize: 12, color: 'var(--color-text-tertiary)' }}>
              Create a mission to get started.
            </div>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {missions.map((m) => {
              const isBusy = busy.has(m.id);
              const isExpanded = expanded.has(m.id);
              const objEdit = objDraft[m.id];
              const hasDetail =
                m.plan ||
                (m.nextSteps?.length ?? 0) > 0 ||
                m.adjustments.length > 0 ||
                m.results.length > 0;

              return (
                <div
                  key={m.id}
                  className="card"
                  style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}
                >
                  {/* Top row: title + status + binding */}
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 10,
                      flexWrap: 'wrap',
                    }}
                  >
                    <span
                      style={{
                        fontSize: 14,
                        fontWeight: 600,
                        color: 'var(--color-text-primary)',
                        flex: '1 1 auto',
                      }}
                    >
                      {m.title}
                    </span>
                    <span className={`badge ${STATUS_BADGE[m.status]}`}>{m.status}</span>
                    {m.binding ? (
                      <span
                        className="badge badge-outline"
                        title={`Session: ${m.binding.sessionId ?? '—'} on ${m.binding.node ?? '—'}`}
                      >
                        {m.binding.kind ?? 'bound'} · {shortId(m.binding.sessionId)} ·{' '}
                        {shortId(m.binding.node)}
                      </span>
                    ) : (
                      <span className="badge badge-default">unbound</span>
                    )}
                    {isBusy && (
                      <Loader2
                        size={14}
                        style={{
                          animation: 'spin 1s linear infinite',
                          color: 'var(--color-text-tertiary)',
                        }}
                      />
                    )}
                  </div>

                  {/* Objective — editable */}
                  <div style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>
                    <textarea
                      className="input"
                      value={objEdit ?? m.objective}
                      rows={2}
                      style={{ width: '100%', resize: 'vertical', fontSize: 12 }}
                      onChange={(e) =>
                        setObjDraft((p) => ({ ...p, [m.id]: e.target.value }))
                      }
                    />
                    {objEdit !== undefined && objEdit !== m.objective && (
                      <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
                        <button
                          className="btn btn-ghost btn-sm"
                          disabled={isBusy}
                          onClick={() => {
                            updateMission(m.id, { objective: objEdit });
                            setObjDraft((p) => {
                              const n = { ...p };
                              delete n[m.id];
                              return n;
                            });
                          }}
                        >
                          Save objective
                        </button>
                        <button
                          className="btn btn-ghost btn-sm"
                          onClick={() =>
                            setObjDraft((p) => {
                              const n = { ...p };
                              delete n[m.id];
                              return n;
                            })
                          }
                        >
                          Discard
                        </button>
                      </div>
                    )}
                  </div>

                  {/* Progress bar */}
                  {m.progress && (
                    <div>
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 8,
                          marginBottom: 4,
                        }}
                      >
                        <div
                          style={{
                            flex: 1,
                            height: 6,
                            background: 'var(--color-bg-elevated)',
                            borderRadius: 3,
                            overflow: 'hidden',
                          }}
                        >
                          <div
                            style={{
                              width: `${Math.min(100, m.progress.percent)}%`,
                              height: '100%',
                              background: STATUS_COLORS[m.status],
                              borderRadius: 3,
                              transition: 'width 0.3s ease',
                            }}
                          />
                        </div>
                        <span
                          style={{
                            fontSize: 11,
                            color: 'var(--color-text-tertiary)',
                            minWidth: 32,
                          }}
                        >
                          {m.progress.percent}%
                        </span>
                      </div>
                      {m.progress.summary && (
                        <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>
                          {m.progress.summary}
                        </div>
                      )}
                    </div>
                  )}

                  {/* Meta row: env, projects, depends */}
                  <div
                    style={{
                      fontSize: 11,
                      color: 'var(--color-text-tertiary)',
                      display: 'flex',
                      flexWrap: 'wrap',
                      gap: 12,
                    }}
                  >
                    <span>
                      isolation:{' '}
                      <span style={{ fontFamily: 'var(--font-mono)' }}>
                        {m.env.isolation}
                        {m.env.host ? ` @ ${m.env.host}` : ''}
                        {m.env.repo ? ` · ${m.env.repo}` : ''}
                        {m.env.resources.length > 0
                          ? ` · resources: ${m.env.resources.join(', ')}`
                          : ''}
                      </span>
                    </span>
                    {m.projects.length > 0 && (
                      <span>projects: {m.projects.join(', ')}</span>
                    )}
                    {m.dependsOn.length > 0 && (
                      <span>depends: {m.dependsOn.map(shortId).join(', ')}</span>
                    )}
                    <span>id: <span style={{ fontFamily: 'var(--font-mono)' }}>{m.id}</span></span>
                    <span>updated: {fmtTime(m.updatedAt)}</span>
                    {m.control.nudgeCount > 0 && (
                      <span>
                        nudges: {m.control.nudgeCount} · backoff step: {m.control.backoffStep}
                      </span>
                    )}
                    {m.control.waitReason && (
                      <span style={{ color: 'var(--color-status-orange)' }}>
                        waiting: {m.control.waitReason}
                      </span>
                    )}
                  </div>

                  {/* Expand detail: plan, nextSteps, adjustments, results */}
                  {hasDetail && (
                    <button
                      className="btn btn-ghost btn-sm"
                      style={{ alignSelf: 'flex-start', padding: '0 4px' }}
                      onClick={() => toggleExpand(m.id)}
                    >
                      {isExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />} detail
                    </button>
                  )}

                  {isExpanded && (
                    <div
                      style={{
                        background: 'var(--color-bg-elevated)',
                        border: '1px solid var(--color-border-subtle)',
                        borderRadius: 'var(--radius-sm)',
                        padding: 10,
                        fontSize: 12,
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 10,
                      }}
                    >
                      {m.plan && (
                        <div>
                          <div
                            style={{
                              fontWeight: 600,
                              color: 'var(--color-text-secondary)',
                              marginBottom: 4,
                            }}
                          >
                            Plan
                          </div>
                          <pre
                            style={{
                              whiteSpace: 'pre-wrap',
                              wordBreak: 'break-word',
                              color: 'var(--color-text-secondary)',
                              margin: 0,
                              fontFamily: 'inherit',
                            }}
                          >
                            {m.plan}
                          </pre>
                        </div>
                      )}
                      {(m.nextSteps?.length ?? 0) > 0 && (
                        <div>
                          <div
                            style={{
                              fontWeight: 600,
                              color: 'var(--color-text-secondary)',
                              marginBottom: 4,
                            }}
                          >
                            Next steps
                          </div>
                          <ul style={{ margin: 0, paddingLeft: 16 }}>
                            {m.nextSteps!.map((s, i) => (
                              <li key={i} style={{ color: 'var(--color-text-secondary)' }}>
                                {s}
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                      {m.results.length > 0 && (
                        <div>
                          <div
                            style={{
                              fontWeight: 600,
                              color: 'var(--color-text-secondary)',
                              marginBottom: 4,
                            }}
                          >
                            Results
                          </div>
                          {m.results.map((r, i) => (
                            <div
                              key={i}
                              style={{ color: 'var(--color-text-tertiary)', marginBottom: 2 }}
                            >
                              {fmtTime(r.at)} · {r.ref}
                              {r.summary ? ` — ${r.summary}` : ''}
                            </div>
                          ))}
                        </div>
                      )}
                      {m.adjustments.length > 0 && (
                        <div>
                          <div
                            style={{
                              fontWeight: 600,
                              color: 'var(--color-text-secondary)',
                              marginBottom: 4,
                            }}
                          >
                            Controller audit trail ({m.adjustments.length})
                          </div>
                          <div
                            style={{
                              maxHeight: 160,
                              overflow: 'auto',
                              fontFamily: 'var(--font-mono)',
                              fontSize: 11,
                            }}
                          >
                            {m.adjustments
                              .slice()
                              .reverse()
                              .map((a, i) => (
                                <div
                                  key={i}
                                  style={{
                                    color: 'var(--color-text-tertiary)',
                                    marginBottom: 2,
                                  }}
                                >
                                  [{fmtTime(a.at)}]{' '}
                                  <span style={{ color: 'var(--color-text-secondary)' }}>
                                    {a.by}
                                  </span>{' '}
                                  · {a.trigger} → {a.change}
                                </div>
                              ))}
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Action buttons */}
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      flexWrap: 'wrap',
                      borderTop: '1px solid var(--color-border-subtle)',
                      paddingTop: 10,
                    }}
                  >
                    {m.status === 'active' && (
                      <button
                        className="btn btn-ghost btn-sm"
                        disabled={isBusy}
                        onClick={() => updateMission(m.id, { status: 'paused' })}
                        title="Pause mission"
                      >
                        <Pause size={13} /> Pause
                      </button>
                    )}
                    {(m.status === 'paused' || m.status === 'blocked' || m.status === 'waiting') && (
                      <button
                        className="btn btn-primary btn-sm"
                        disabled={isBusy}
                        onClick={() => updateMission(m.id, { status: 'active' })}
                        title="Resume mission"
                      >
                        <Play size={13} /> Resume
                      </button>
                    )}
                    {m.status !== 'done' && m.status !== 'failed' && (
                      <button
                        className="btn btn-ghost btn-sm"
                        disabled={isBusy}
                        onClick={() => updateMission(m.id, { status: 'done' })}
                        title="Mark as done"
                      >
                        <CheckCircle size={13} /> Mark done
                      </button>
                    )}
                    {m.binding?.sessionId && /^session_/.test(m.binding.sessionId) && (
                      <button
                        className="btn btn-ghost btn-sm"
                        onClick={() =>
                          setConnectSid(
                            connectSid === m.binding!.sessionId ? null : m.binding!.sessionId,
                          )
                        }
                        title={
                          connectSid === m.binding!.sessionId
                            ? 'Disconnect from executor'
                            : 'Connect to executor session'
                        }
                      >
                        <Plug size={13} />
                        {connectSid === m.binding!.sessionId ? ' Disconnect' : ' Connect'}
                      </button>
                    )}
                  </div>

                  {/* Inline executor view — shown beneath action row when connected */}
                  {m.binding?.sessionId &&
                    /^session_/.test(m.binding.sessionId) &&
                    connectSid === m.binding.sessionId && (
                      <CcrCloudView
                        sid={m.binding.sessionId}
                        webUrl={`https://claude.ai/code/${m.binding.sessionId}`}
                        apiFetch={apiFetch}
                        onClose={() => setConnectSid(null)}
                      />
                    )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
