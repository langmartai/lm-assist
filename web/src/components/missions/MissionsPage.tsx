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
type ActorKind = 'local-session' | 'ccr' | 'claudeai-conversation' | 'controller' | 'user';
type ActorChannel = 'mcp' | 'controller' | 'user' | 'api';

interface MissionActor {
  kind: ActorKind;
  id?: string | null;
  node?: string | null;
  channel: ActorChannel;
  label?: string;
  toolUseId?: string | null;
  at: number;
}

interface MissionSession {
  sid: string;
  kind: 'orchestrator' | 'worker';
  role: 'primary' | 'sub';
  lastContact?: number;
}
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
  actor?: MissionActor;
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
  createdBy?: MissionActor;
  lastUpdatedBy?: MissionActor;
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

/** Display label for a MissionActor */
function labelOf(actor: MissionActor): string {
  return actor.label || actor.id || actor.kind;
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

  // Repo/branch dropdowns
  const [repos, setRepos] = useState<string[]>([]);
  const [reposLoading, setReposLoading] = useState(false);
  const [reposError, setReposError] = useState(false);
  const [selectedRepo, setSelectedRepo] = useState('');
  const [customRepo, setCustomRepo] = useState(false);
  const [repoText, setRepoText] = useState('');
  const [branches, setBranches] = useState<string[]>([]);
  const [branchesLoading, setBranchesLoading] = useState(false);
  const [selectedBranch, setSelectedBranch] = useState('');
  const [customBranch, setCustomBranch] = useState(false);
  const [branchText, setBranchText] = useState('');

  // Per-mission objective editing
  const [objDraft, setObjDraft] = useState<Record<string, string>>({});

  // Connect/drive a mission's cloud executor inline
  const [connectSid, setConnectSid] = useState<string | null>(null);

  // Per-mission session list (populated on demand)
  const [sessionsByMission, setSessionsByMission] = useState<Record<string, MissionSession[]>>({});
  const [sessionsExpanded, setSessionsExpanded] = useState<Set<string>>(new Set());
  const [sessionsFetching, setSessionsFetching] = useState<Set<string>>(new Set());

  // Collapsible contributors
  const [contributorsExpanded, setContributorsExpanded] = useState<Set<string>>(new Set());

  // ── Repo/branch fetching ──

  const fetchRepos = useCallback(async () => {
    setReposLoading(true);
    setReposError(false);
    try {
      const res = await apiFetch<{ repos: Array<string | { slug?: string; full_name?: string }> }>('/ccr/cloud/repos');
      const list = (res?.repos ?? []).map((r) =>
        typeof r === 'string' ? r : r.slug ?? r.full_name ?? String(r),
      );
      setRepos(list);
      if (list.length === 0) setReposError(true); // empty → fall back to text
    } catch {
      setReposError(true);
    } finally {
      setReposLoading(false);
    }
  }, [apiFetch]);

  const fetchBranches = useCallback(
    async (repo: string) => {
      if (!repo) { setBranches([]); return; }
      setBranchesLoading(true);
      try {
        const res = await apiFetch<{ branches: string[] }>(`/ccr/cloud/branches?repo=${encodeURIComponent(repo)}`);
        setBranches(res?.branches ?? []);
      } catch {
        setBranches([]);
      } finally {
        setBranchesLoading(false);
      }
    },
    [apiFetch],
  );

  // Fetch repos when create form opens
  useEffect(() => {
    if (showCreate) {
      fetchRepos();
    } else {
      // Reset repo/branch state when form closes
      setSelectedRepo('');
      setCustomRepo(false);
      setRepoText('');
      setBranches([]);
      setSelectedBranch('');
      setCustomBranch(false);
      setBranchText('');
    }
  }, [showCreate, fetchRepos]);

  // ── Data loading ──

  const fetchMissionSessions = useCallback(
    async (missionId: string) => {
      setSessionsFetching((prev) => { const n = new Set(prev); n.add(missionId); return n; });
      try {
        const res = await apiFetch<{ sessions: MissionSession[] } | { data: { sessions: MissionSession[] } }>(
          `/mission/${encodeURIComponent(missionId)}/sessions`,
        );
        const sessions = (res as any).sessions ?? (res as any).data?.sessions ?? [];
        setSessionsByMission((prev) => ({ ...prev, [missionId]: sessions }));
      } catch {
        // silently ignore — sessions list stays empty
      } finally {
        setSessionsFetching((prev) => { const n = new Set(prev); n.delete(missionId); return n; });
      }
    },
    [apiFetch],
  );

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
        // Re-fetch sessions for any already-expanded missions that have bindings
        setSessionsExpanded((expanded) => {
          for (const mid of expanded) {
            const m = list.find((x) => x.id === mid);
            if (m?.binding?.sessionId) fetchMissionSessions(mid);
          }
          return expanded;
        });
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
  }, [apiFetch, fetchMissionSessions]);

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

  const toggleContributors = (id: string) =>
    setContributorsExpanded((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const toggleSessionsExpand = useCallback(
    (missionId: string, hasBinding: boolean) => {
      setSessionsExpanded((prev) => {
        const n = new Set(prev);
        if (n.has(missionId)) {
          n.delete(missionId);
        } else {
          n.add(missionId);
          if (hasBinding) {
            // fetch (or re-fetch) on expand
            fetchMissionSessions(missionId);
          }
        }
        return n;
      });
    },
    [fetchMissionSessions],
  );

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
      // Determine final repo/branch values
      const finalRepo = customRepo ? repoText.trim() : selectedRepo;
      const finalBranch = customBranch ? branchText.trim() : selectedBranch;

      const body: Record<string, unknown> = {
        title: form.title.trim(),
        objective: form.objective.trim(),
        env: {
          isolation: form.isolation,
          ...(finalRepo ? { repo: finalRepo } : {}),
          ...(finalBranch ? { branch: finalBranch } : {}),
        },
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
  }, [apiFetch, form, customRepo, repoText, selectedRepo, customBranch, branchText, selectedBranch]);

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

  // ── Actor link renderer ──
  const renderActorLink = useCallback(
    (actor: MissionActor, m: Mission) => {
      const lbl = labelOf(actor);
      if (actor.kind === 'ccr' && actor.id && /^session_/.test(actor.id)) {
        const sid = actor.id;
        const isOpen = connectSid === sid;
        return (
          <button
            className="btn btn-ghost btn-sm"
            style={{ padding: '0 4px', fontSize: 11, display: 'inline' }}
            onClick={() => setConnectSid(isOpen ? null : sid)}
          >
            {lbl}
          </button>
        );
      }
      if (actor.kind === 'claudeai-conversation' && actor.id) {
        return (
          <a
            href={`https://claude.ai/chat/${actor.id}`}
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: 'var(--color-accent)', textDecoration: 'underline' }}
          >
            {lbl}
          </a>
        );
      }
      if (actor.kind === 'local-session' && actor.id) {
        // Link to the sessions page view — carry node context
        const nodeParam = actor.node ? `&node=${encodeURIComponent(actor.node)}` : '';
        return (
          <a
            href={`/sessions?id=${encodeURIComponent(actor.id)}${nodeParam}`}
            style={{ color: 'var(--color-accent)', textDecoration: 'underline' }}
          >
            {lbl}
          </a>
        );
      }
      // controller / user — plain text with node
      return (
        <span>
          {lbl}
          {actor.node ? <span style={{ color: 'var(--color-text-tertiary)' }}> @{actor.node}</span> : null}
        </span>
      );
    },
    [connectSid],
  );

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

            {/* ── Repo / Branch pickers ── */}
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              {/* Repo */}
              <label style={{ fontSize: 12, color: 'var(--color-text-secondary)', flex: '1 1 180px' }}>
                repo (optional)
                <br />
                {reposLoading ? (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4 }}>
                    <Loader2 size={12} style={{ animation: 'spin 1s linear infinite' }} />
                    <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>loading repos…</span>
                  </div>
                ) : reposError || repos.length === 0 ? (
                  <>
                    <input
                      className="input"
                      value={repoText}
                      placeholder="owner/repo"
                      style={{ width: '100%' }}
                      onChange={(e) => setRepoText(e.target.value)}
                    />
                    {reposError && (
                      <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>
                        couldn&apos;t load repos — type manually
                      </span>
                    )}
                  </>
                ) : customRepo ? (
                  <>
                    <input
                      className="input"
                      value={repoText}
                      placeholder="owner/repo"
                      style={{ width: '100%' }}
                      onChange={(e) => setRepoText(e.target.value)}
                    />
                    <button
                      className="btn btn-ghost btn-sm"
                      style={{ marginTop: 2, fontSize: 11 }}
                      onClick={() => { setCustomRepo(false); setRepoText(''); }}
                    >
                      pick from list
                    </button>
                  </>
                ) : (
                  <select
                    className="input"
                    value={selectedRepo}
                    style={{ width: '100%' }}
                    onChange={(e) => {
                      const v = e.target.value;
                      if (v === '__custom__') {
                        setCustomRepo(true);
                        setSelectedRepo('');
                        setBranches([]);
                        setSelectedBranch('');
                      } else {
                        setSelectedRepo(v);
                        setSelectedBranch('');
                        setBranches([]);
                        if (v) fetchBranches(v);
                      }
                    }}
                  >
                    <option value="">— none —</option>
                    {repos.map((r) => (
                      <option key={r} value={r}>{r}</option>
                    ))}
                    <option value="__custom__">— custom —</option>
                  </select>
                )}
              </label>

              {/* Branch */}
              <label style={{ fontSize: 12, color: 'var(--color-text-secondary)', flex: '1 1 180px' }}>
                branch (optional)
                <br />
                {branchesLoading ? (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4 }}>
                    <Loader2 size={12} style={{ animation: 'spin 1s linear infinite' }} />
                    <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>loading branches…</span>
                  </div>
                ) : customBranch ? (
                  <>
                    <input
                      className="input"
                      value={branchText}
                      placeholder="branch name"
                      style={{ width: '100%' }}
                      onChange={(e) => setBranchText(e.target.value)}
                    />
                    <button
                      className="btn btn-ghost btn-sm"
                      style={{ marginTop: 2, fontSize: 11 }}
                      onClick={() => { setCustomBranch(false); setBranchText(''); }}
                    >
                      pick from list
                    </button>
                  </>
                ) : branches.length > 0 ? (
                  <select
                    className="input"
                    value={selectedBranch}
                    style={{ width: '100%' }}
                    onChange={(e) => {
                      const v = e.target.value;
                      if (v === '__custom__') {
                        setCustomBranch(true);
                        setSelectedBranch('');
                      } else {
                        setSelectedBranch(v);
                      }
                    }}
                  >
                    <option value="">— none —</option>
                    {branches.map((b) => (
                      <option key={b} value={b}>{b}</option>
                    ))}
                    <option value="__custom__">— custom —</option>
                  </select>
                ) : (
                  <input
                    className="input"
                    value={branchText}
                    placeholder="branch name"
                    style={{ width: '100%' }}
                    onChange={(e) => setBranchText(e.target.value)}
                  />
                )}
              </label>
            </div>

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

              const contribExpanded = contributorsExpanded.has(m.id);

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

                  {/* ── Provenance: created by + contributors ── */}
                  {(m.createdBy || m.adjustments.length > 0) && (
                    <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)', display: 'flex', flexDirection: 'column', gap: 3 }}>
                      {m.createdBy && (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
                          <span>Created by</span>
                          <span style={{ color: 'var(--color-text-secondary)' }}>
                            {renderActorLink(m.createdBy, m)}
                          </span>
                          <span style={{ color: 'var(--color-text-tertiary)' }}>
                            via {m.createdBy.channel}
                          </span>
                        </div>
                      )}
                      {m.adjustments.length > 0 && (
                        <div>
                          <button
                            className="btn btn-ghost btn-sm"
                            style={{ padding: '0 2px', fontSize: 11 }}
                            onClick={() => toggleContributors(m.id)}
                          >
                            {contribExpanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                            {' '}Contributors ({m.adjustments.length})
                          </button>
                          {contribExpanded && (
                            <div
                              style={{
                                marginTop: 4,
                                paddingLeft: 8,
                                borderLeft: '2px solid var(--color-border-subtle)',
                                display: 'flex',
                                flexDirection: 'column',
                                gap: 2,
                              }}
                            >
                              {m.adjustments
                                .slice()
                                .reverse()
                                .map((adj, i) => (
                                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
                                    <span style={{ color: 'var(--color-text-tertiary)' }}>
                                      {fmtTime(adj.at)}
                                    </span>
                                    <span>·</span>
                                    <span style={{ color: 'var(--color-text-tertiary)' }}>
                                      {adj.actor ? adj.actor.channel : adj.by}
                                    </span>
                                    <span>·</span>
                                    <span style={{ color: 'var(--color-text-secondary)' }}>
                                      {adj.actor ? renderActorLink(adj.actor, m) : adj.by}
                                    </span>
                                    <span>—</span>
                                    <span style={{ color: 'var(--color-text-tertiary)' }}>{adj.change}</span>
                                  </div>
                                ))}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )}

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
                    {m.binding?.sessionId && (
                      <button
                        className="btn btn-ghost btn-sm"
                        onClick={() => toggleSessionsExpand(m.id, !!m.binding?.sessionId)}
                        title={sessionsExpanded.has(m.id) ? 'Hide sessions' : 'Show sessions'}
                      >
                        <Plug size={13} />
                        {sessionsExpanded.has(m.id) ? ' Sessions ▲' : ' Sessions ▾'}
                        {sessionsFetching.has(m.id) && (
                          <Loader2 size={11} style={{ marginLeft: 4, animation: 'spin 1s linear infinite' }} />
                        )}
                      </button>
                    )}
                  </div>

                  {/* Session list — expanded on demand */}
                  {sessionsExpanded.has(m.id) && m.binding?.sessionId && (() => {
                    const mSessions = sessionsByMission[m.id] ?? [];
                    return (
                      <div
                        style={{
                          background: 'var(--color-bg-elevated)',
                          border: '1px solid var(--color-border-subtle)',
                          borderRadius: 'var(--radius-sm)',
                          padding: '8px 10px',
                          display: 'flex',
                          flexDirection: 'column',
                          gap: 4,
                        }}
                      >
                        <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)', marginBottom: 4 }}>
                          Sessions
                        </div>
                        {mSessions.length === 0 && !sessionsFetching.has(m.id) && (
                          <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>
                            No sessions found (binding: {m.binding.sessionId})
                          </div>
                        )}
                        {mSessions.map((s) => {
                          const isCloud = /^session_/.test(s.sid);
                          const shortSid = s.sid.replace(/^session_/, '').slice(0, 8);
                          const label = `${s.role} · ${s.kind} · ${shortSid}`;
                          const isOpen = connectSid === s.sid;
                          return (
                            <div
                              key={s.sid}
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: 8,
                                fontSize: 12,
                                fontFamily: 'var(--font-mono)',
                              }}
                            >
                              <span style={{ flex: 1, color: 'var(--color-text-secondary)' }}>
                                {label}
                              </span>
                              {isCloud ? (
                                <button
                                  className={`btn btn-sm ${isOpen ? 'btn-primary' : 'btn-ghost'}`}
                                  onClick={() => setConnectSid(isOpen ? null : s.sid)}
                                  title={isOpen ? 'Close session view' : 'Open session view'}
                                >
                                  <Plug size={11} />
                                  {isOpen ? ' Close' : ' Open'}
                                </button>
                              ) : (
                                <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>
                                  (local)
                                </span>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    );
                  })()}

                  {/* Inline cloud session view — shown for whichever session is open, if it belongs to this mission */}
                  {connectSid && (() => {
                    const mSessions = sessionsByMission[m.id] ?? [];
                    const owns = mSessions.some((s) => s.sid === connectSid) ||
                      (m.binding?.sessionId === connectSid && mSessions.length === 0);
                    // Also open when a provenance actor (ccr kind) triggered the connect
                    const ownsActor = !owns && connectSid && (
                      (m.createdBy?.kind === 'ccr' && m.createdBy?.id === connectSid) ||
                      m.adjustments.some((adj) => adj.actor?.kind === 'ccr' && adj.actor?.id === connectSid)
                    );
                    return (owns || ownsActor) && /^session_/.test(connectSid) ? (
                      <CcrCloudView
                        sid={connectSid}
                        webUrl={`https://claude.ai/code/${connectSid}`}
                        apiFetch={apiFetch}
                        onClose={() => setConnectSid(null)}
                      />
                    ) : null;
                  })()}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
