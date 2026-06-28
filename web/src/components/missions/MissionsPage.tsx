'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
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
  Square,
  RotateCcw,
  AlertCircle,
  Cloud,
  Monitor,
  Send,
  ListChecks,
  ExternalLink,
} from 'lucide-react';
import { useAppMode } from '@/contexts/AppModeContext';
import { useClusters, clusterBadge } from '@/hooks/useClusters';
import { CcrCloudView } from '@/components/ccr/CcrCloudView';
import { MissionSessionChat } from './MissionSessionChat';
import { MissionDetailView } from './MissionDetailView';
import { FullScreenOverlay, ExpandIconButton } from './FullScreenOverlay';
import type { SessionMessage } from './MissionSessionChat';

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
  tags?: Record<string, string[]>;
  parentId?: string | null;
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
  interim?: { at: number; text: string };
}

interface ControllerSession {
  node: string;
  sessionId: string;
  cse: string | null;
  tmux: string;
  startedAt: number;
}

interface ControllerLeader {
  node: string | null;
  host: string | null;
  isSelf: boolean;
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
  controllerSession?: ControllerSession | null;
  leader?: ControllerLeader | null;
}

type SessionTransport = 'cloud' | 'native';
type SessionRole = 'controller' | 'orchestrator' | 'worker';

interface OperableSession {
  sid: string;
  missionId: string | null;
  role: SessionRole;
  transport: SessionTransport;
  status?: string;
  webUrl?: string;
}

// ── Session-tab types ──────────────────────────────────────────────────────

interface SessionTab {
  sid: string;
  title: string;
  transport: SessionTransport;
  /** Node that owns this session (for cross-node proxy on read/drive). */
  node?: string | null;
  /** Mission id used when resuming a native session. */
  missionId?: string | null;
  /**
   * Tab kind. `undefined`/`'session'` = a session view (cloud or native).
   * `'mission'` = the mission detail tab (sid holds the missionId; no liveness check).
   */
  kind?: 'session' | 'mission';
}

type TabAliveStatus = 'checking' | 'alive' | 'dead' | 'resuming' | 'gone' | 'confirm-resume' | 'resume-gone' | 'resume-conflict';

interface TabState {
  alive: TabAliveStatus;
  autoCloseAt?: number | null;
  notice?: string | null;
}


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
  const { clusterByGateway } = useClusters();

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
  // ── Missions sidebar: search + filters + pagination ──
  const [missionSearch, setMissionSearch] = useState('');
  const [missionStatusFilter, setMissionStatusFilter] = useState<'all' | MissionStatus>('all');
  const [missionTransportFilter, setMissionTransportFilter] = useState<'all' | 'cloud' | 'native'>('all');
  const [missionRecencyFilter, setMissionRecencyFilter] = useState<'all' | '1d' | '3d' | '7d'>('all');
  const [missionVisibleCount, setMissionVisibleCount] = useState(50);
  /** Reset the page size to the top 50 whenever a filter/search changes. */
  const resetMissionPage = () => setMissionVisibleCount(50);
  const missionTransportOf = (m: Mission): 'cloud' | 'native' | null => {
    const sid = m.binding?.sessionId;
    return sid ? (/^(session_|cse_)/.test(sid) ? 'cloud' : 'native') : null;
  };
  // Filter (status AND transport AND recency AND keyword) → sort by recency (most recent first).
  // Keyword search: space-separated terms are ANDed across title/objective/id/status (case-insensitive).
  const _missionTerms = missionSearch.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const _missionRecencyMs =
    missionRecencyFilter === '1d' ? 86_400_000 :
    missionRecencyFilter === '3d' ? 3 * 86_400_000 :
    missionRecencyFilter === '7d' ? 7 * 86_400_000 : 0;
  const filteredMissions = missions
    .filter((m) => missionStatusFilter === 'all' || m.status === missionStatusFilter)
    .filter((m) => missionTransportFilter === 'all' || missionTransportOf(m) === missionTransportFilter)
    .filter((m) => _missionRecencyMs === 0 || Date.now() - (m.updatedAt || m.createdAt || 0) <= _missionRecencyMs)
    .filter((m) => {
      if (_missionTerms.length === 0) return true;
      const tagValues = Object.values(m.tags ?? {}).flat().join(' ');
      const hay = `${m.title} ${m.objective} ${m.id} ${m.status} ${tagValues}`.toLowerCase();
      return _missionTerms.every((t) => hay.includes(t));
    })
    .sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0));
  const visibleMissions = filteredMissions.slice(0, missionVisibleCount);
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

  // Mission whose title is hovered (for the clickable-title underline affordance)
  const [hoverTitleId, setHoverTitleId] = useState<string | null>(null);

  // Connect/drive a mission's cloud executor inline
  const [connectSid, setConnectSid] = useState<string | null>(null);

  // Per-mission session list (populated on demand)
  const [sessionsByMission, setSessionsByMission] = useState<Record<string, MissionSession[]>>({});
  const [sessionsExpanded, setSessionsExpanded] = useState<Set<string>>(new Set());
  const [sessionsFetching, setSessionsFetching] = useState<Set<string>>(new Set());

  // ── Controller session (Wave 2) ──
  // auto-opened on load when controllerSession is present; stays closed once user dismisses
  const [controllerSessionOpen, setControllerSessionOpen] = useState(false);
  // Once the user manually closes the panel, don't auto-reopen it on subsequent polls.
  const [controllerSessionDismissed, setControllerSessionDismissed] = useState(false);

  // Fleet-wide operable sessions list
  const [allSessions, setAllSessions] = useState<OperableSession[]>([]);
  const [allSessionsLoading, setAllSessionsLoading] = useState(false);
  const [allSessionsExpanded, setAllSessionsExpanded] = useState(false);

  // Per-operable-session operate panel: sid -> open state
  const [operatePanelSid, setOperatePanelSid] = useState<string | null>(null);
  // Per-sid: live messages from read
  const [operateMessages, setOperateMessages] = useState<Record<string, SessionMessage[]>>({});
  const [operateReadBusy, setOperateReadBusy] = useState<Record<string, boolean>>({});
  // Per-sid: drive input text
  const [operateDriveText, setOperateDriveText] = useState<Record<string, string>>({});
  const [operateDriveBusy, setOperateDriveBusy] = useState<Record<string, boolean>>({});
  // Per-sid: control busy
  const [operateControlBusy, setOperateControlBusy] = useState<Record<string, boolean>>({});
  const operatePollerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Collapsible contributors
  const [contributorsExpanded, setContributorsExpanded] = useState<Set<string>>(new Set());

  // ── Chat (controller) ── control actions (interrupt/stop/restart) stay here
  const [chatControlBusy, setChatControlBusy] = useState<Record<string, boolean>>({});

  // ── Session tabs (Wave 6) ──
  const [openTabs, setOpenTabs] = useState<SessionTab[]>([]);
  /** null = Mission Controller (tab 0); otherwise the sid of the open session tab. */
  const [activeTabSid, setActiveTabSid] = useState<string | null>(null);
  /** sid of the session tab currently expanded to a full-screen overlay (null = none). */
  const [expandedSessionSid, setExpandedSessionSid] = useState<string | null>(null);
  /** Per-tab alive status + resume state, keyed by sid. */
  const [tabStates, setTabStates] = useState<Record<string, TabState>>({});

  // Sidebar/create toggle (secondary)
  const [showItemsSidebar, setShowItemsSidebar] = useState(true);

  // ── Repo/branch fetching ──

  const fetchRepos = useCallback(async () => {
    setReposLoading(true);
    setReposError(false);
    try {
      const res = await apiFetch<{ repos: Array<string | { repo?: string; slug?: string; full_name?: string }> }>('/ccr/cloud/repos');
      const list = (res?.repos ?? []).map((r) =>
        typeof r === 'string' ? r : r.repo ?? r.slug ?? r.full_name ?? String(r),
      ).filter((s): s is string => !!s && s !== '[object Object]');
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
        const ctrl = (raw.data ?? raw) as ControllerStatus;
        setController(ctrl);
        // The local Core now server-side proxies the leader's controllerSession into the response
        // (handleGetController proxies when !isMonitor). No browser-side cross-node fetch needed.
        if (ctrl?.controllerSession) {
          setControllerSessionDismissed((dismissed) => {
            if (!dismissed) setControllerSessionOpen(true);
            return dismissed;
          });
        }
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

  // ── All sessions (fleet operability) ──
  const fetchAllSessions = useCallback(async () => {
    setAllSessionsLoading(true);
    try {
      const res = await apiFetch<{ data?: { sessions: OperableSession[] }; sessions?: OperableSession[] }>(
        '/mission/sessions',
      );
      const sessions = (res as any).data?.sessions ?? (res as any).sessions ?? [];
      setAllSessions(sessions);
    } catch {
      // silently ignore
    } finally {
      setAllSessionsLoading(false);
    }
  }, [apiFetch]);

  // Open all-sessions panel: fetch on expand
  const toggleAllSessions = useCallback(() => {
    setAllSessionsExpanded((prev) => {
      if (!prev) fetchAllSessions();
      return !prev;
    });
  }, [fetchAllSessions]);

  // ── Operate panel helpers ──
  const readSession = useCallback(
    async (sid: string) => {
      setOperateReadBusy((p) => ({ ...p, [sid]: true }));
      try {
        const res = await apiFetch<{ data?: { messages: SessionMessage[] }; messages?: SessionMessage[] }>(
          `/mission/session/${encodeURIComponent(sid)}/read`,
          { method: 'POST', body: { lastN: 20 } },
        );
        const msgs = (res as any).data?.messages ?? (res as any).messages ?? [];
        setOperateMessages((p) => ({ ...p, [sid]: msgs }));
      } catch {
        // silently ignore
      } finally {
        setOperateReadBusy((p) => ({ ...p, [sid]: false }));
      }
    },
    [apiFetch],
  );

  const driveSession = useCallback(
    async (sid: string) => {
      const text = operateDriveText[sid]?.trim();
      if (!text) return;
      setOperateDriveBusy((p) => ({ ...p, [sid]: true }));
      try {
        await apiFetch(`/mission/session/${encodeURIComponent(sid)}/drive`, {
          method: 'POST',
          body: { text },
        });
        setOperateDriveText((p) => ({ ...p, [sid]: '' }));
        // Refresh messages after sending
        setTimeout(() => readSession(sid), 800);
      } catch {
        // silently ignore
      } finally {
        setOperateDriveBusy((p) => ({ ...p, [sid]: false }));
      }
    },
    [apiFetch, operateDriveText, readSession],
  );

  const controlSession = useCallback(
    async (sid: string, action: 'interrupt' | 'stop' | 'restart') => {
      setOperateControlBusy((p) => ({ ...p, [`${sid}:${action}`]: true }));
      try {
        await apiFetch(`/mission/session/${encodeURIComponent(sid)}/control`, {
          method: 'POST',
          body: { action },
        });
        if (action === 'restart') {
          // Controller is restarting — close panel and dismiss so it doesn't auto-reopen
          // until the supervisor relaunches a new session (user can re-open manually then).
          setControllerSessionOpen(false);
          setControllerSessionDismissed(true);
        }
      } catch {
        // silently ignore
      } finally {
        setOperateControlBusy((p) => ({ ...p, [`${sid}:${action}`]: false }));
      }
    },
    [apiFetch],
  );

  // ── Controller chat helpers ──

  const controllerChatControl = useCallback(
    async (sid: string, leader: ControllerLeader | null | undefined, action: 'interrupt' | 'stop' | 'restart') => {
      setChatControlBusy((p) => ({ ...p, [action]: true }));
      try {
        await apiFetch(
          `/mission/session/${encodeURIComponent(sid)}/control`,
          { method: 'POST', body: { action, node: leader?.node ?? undefined } },
        );
        if (action === 'restart') {
          setControllerSessionDismissed(true);
        }
      } catch {
        // silently ignore
      } finally {
        setChatControlBusy((p) => ({ ...p, [action]: false }));
      }
    },
    [apiFetch],
  );


  // Open/close operate panel and start/stop polling
  const openOperatePanel = useCallback(
    (sid: string) => {
      setOperatePanelSid(sid);
      readSession(sid);
      // Poll every 5s while panel is open
      if (operatePollerRef.current) clearInterval(operatePollerRef.current);
      operatePollerRef.current = setInterval(() => readSession(sid), 5000);
    },
    [readSession],
  );

  const closeOperatePanel = useCallback(() => {
    setOperatePanelSid(null);
    if (operatePollerRef.current) {
      clearInterval(operatePollerRef.current);
      operatePollerRef.current = null;
    }
  }, []);

  // Cleanup poller on unmount
  useEffect(() => {
    return () => {
      if (operatePollerRef.current) clearInterval(operatePollerRef.current);
    };
  }, []);

  // ── Tab handlers (Wave 6) ──

  /** Check liveness and, if closed, trigger the appropriate resume flow. */
  const checkAndHandleTabLiveness = useCallback(
    async (tab: SessionTab) => {
      const sid = tab.sid;
      setTabStates((p) => ({ ...p, [sid]: { ...p[sid], alive: 'checking' } }));
      try {
        const nodeParam = tab.node ? `?node=${encodeURIComponent(tab.node)}` : '';
        const res = await apiFetch<{ data?: { transport: SessionTransport; alive: boolean }; transport?: SessionTransport; alive?: boolean }>(
          `/mission/session/${encodeURIComponent(sid)}/status${nodeParam}`,
        );
        const transport = (res as any).data?.transport ?? (res as any).transport ?? tab.transport;
        const alive = (res as any).data?.alive ?? (res as any).alive ?? false;

        if (alive) {
          setTabStates((p) => ({ ...p, [sid]: { alive: 'alive' } }));
          return;
        }

        // Not alive — handle by transport
        if (transport === 'cloud') {
          // Auto-resume cloud session
          setTabStates((p) => ({ ...p, [sid]: { alive: 'resuming' } }));
          try {
            const resumeRes = await apiFetch<{ data?: { resumed: boolean; sid?: string; transport?: string; reason?: string }; resumed?: boolean; sid?: string; reason?: string }>(
              `/mission/session/${encodeURIComponent(sid)}/resume`,
              { method: 'POST', body: { missionId: tab.missionId ?? undefined, node: tab.node ?? undefined } },
            );
            const d = (resumeRes as any).data ?? resumeRes;
            const reason = d?.reason as string | undefined;
            if (reason === 'gone') {
              setTabStates((p) => ({ ...p, [sid]: { alive: 'resume-gone', notice: "Can't resume — this worker is gone." } }));
            } else if (reason === 'conflict') {
              setTabStates((p) => ({ ...p, [sid]: { alive: 'resume-conflict', notice: "This session is live elsewhere and can't be safely resumed." } }));
            } else if (d?.resumed) {
              setTabStates((p) => ({ ...p, [sid]: { alive: 'alive' } }));
            } else {
              setTabStates((p) => ({ ...p, [sid]: { alive: 'gone', notice: 'Session ended — cannot resume.' } }));
            }
          } catch {
            setTabStates((p) => ({ ...p, [sid]: { alive: 'gone', notice: 'Session ended — cannot resume.' } }));
          }
        } else {
          // Native — show confirm prompt
          setTabStates((p) => ({ ...p, [sid]: { alive: 'confirm-resume' } }));
        }
      } catch {
        // If status check fails, assume alive to avoid blocking the user
        setTabStates((p) => ({ ...p, [sid]: { alive: 'alive' } }));
      }
    },
    [apiFetch],
  );

  /** Open a session as a new tab (deduped by sid), then set it active and check liveness. */
  const openSessionTab = useCallback(
    (tab: SessionTab) => {
      setOpenTabs((prev) => {
        if (prev.some((t) => t.sid === tab.sid)) return prev;
        return [...prev, tab];
      });
      setActiveTabSid(tab.sid);
      // Trigger liveness check — first time only (avoid re-checking on re-activate)
      setTabStates((prev) => {
        if (prev[tab.sid]) return prev;
        return { ...prev, [tab.sid]: { alive: 'checking' } };
      });
      // Async liveness check (fire-and-forget; updates tabStates)
      checkAndHandleTabLiveness(tab);
    },
    [checkAndHandleTabLiveness],
  );

  /**
   * Open a mission detail tab (deduped by missionId-as-sid). A mission tab does
   * NOT participate in liveness checking — it renders MissionDetailView directly.
   */
  const openMissionTab = useCallback((missionId: string, title: string) => {
    setOpenTabs((prev) => {
      if (prev.some((t) => t.sid === missionId)) return prev;
      return [...prev, { sid: missionId, title, transport: 'native', kind: 'mission', missionId }];
    });
    setActiveTabSid(missionId);
  }, []);

  /**
   * Deep-link: open the mission tab named by `?mission=<id>` once the mission list has loaded.
   * Fires once (ref-guarded). Source: the Mission Graph dashboard's "Open in Missions →" link.
   * Reads `window.location.search` (not `useSearchParams`) to avoid a Suspense-boundary requirement.
   */
  const deepLinkHandledRef = useRef(false);
  useEffect(() => {
    if (deepLinkHandledRef.current || typeof window === 'undefined') return;
    const mid = new URLSearchParams(window.location.search).get('mission');
    if (!mid) { deepLinkHandledRef.current = true; return; }
    if (missions.length === 0) return; // wait for the list before resolving the title
    deepLinkHandledRef.current = true;
    const m = missions.find((x) => x.id === mid);
    if (m) openMissionTab(m.id, m.title);
  }, [missions, openMissionTab]);

  /** Close a tab; if it was active, fall back to the controller (null). */
  const closeTab = useCallback((sid: string) => {
    setOpenTabs((prev) => prev.filter((t) => t.sid !== sid));
    setTabStates((prev) => {
      const n = { ...prev };
      delete n[sid];
      return n;
    });
    setActiveTabSid((cur) => (cur === sid ? null : cur));
  }, []);

  /** Confirm-resume a native session: POST .../resume, keep the same sid (backend preserves it). */
  const confirmResumeNative = useCallback(
    async (tab: SessionTab) => {
      const sid = tab.sid;
      setTabStates((p) => ({ ...p, [sid]: { alive: 'resuming' } }));
      try {
        const res = await apiFetch<{ data?: { resumed: boolean; sid?: string; autoCloseAt?: number; reason?: string }; resumed?: boolean; sid?: string; autoCloseAt?: number; reason?: string }>(
          `/mission/session/${encodeURIComponent(sid)}/resume`,
          { method: 'POST', body: { missionId: tab.missionId ?? undefined, node: tab.node ?? undefined } },
        );
        const d = (res as any).data ?? res;
        const reason = d?.reason as string | undefined;
        if (reason === 'gone') {
          setTabStates((p) => ({ ...p, [sid]: { alive: 'resume-gone', notice: "Can't resume — this worker is gone." } }));
        } else if (reason === 'conflict') {
          setTabStates((p) => ({ ...p, [sid]: { alive: 'resume-conflict', notice: "This session is live elsewhere and can't be safely resumed." } }));
        } else if (d?.resumed) {
          // Native resume preserves the same sid — no tab swap needed.
          const autoCloseAt: number | undefined = d.autoCloseAt;
          setTabStates((p) => ({
            ...p,
            [sid]: {
              alive: 'alive',
              autoCloseAt: autoCloseAt ?? null,
              notice: autoCloseAt ? `Session resumed — auto-closes after 30 min idle.` : null,
            },
          }));
        } else {
          setTabStates((p) => ({ ...p, [sid]: { alive: 'gone', notice: 'Failed to resume session.' } }));
        }
      } catch (e) {
        setTabStates((p) => ({ ...p, [sid]: { alive: 'gone', notice: `Resume failed: ${(e as Error).message}` } }));
      }
    },
    [apiFetch],
  );

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

  // ── Operate panel renderer ──
  const renderOperatePanel = useCallback(
    (session: OperableSession) => {
      const { sid, role, transport, status } = session;
      const isOpen = operatePanelSid === sid;
      const msgs = operateMessages[sid] ?? [];
      const readBusy = !!operateReadBusy[sid];
      const driveBusy = !!operateDriveBusy[sid];
      const driveTxt = operateDriveText[sid] ?? '';

      const busyKey = (a: string) => !!operateControlBusy[`${sid}:${a}`];

      const shortSid = sid.length > 12 ? sid.slice(0, 10) + '…' : sid;

      return (
        <div
          key={sid}
          style={{
            border: '1px solid var(--color-border-subtle)',
            borderRadius: 'var(--radius-sm)',
            padding: '8px 10px',
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
            background: role === 'controller' ? 'var(--color-bg-elevated)' : undefined,
          }}
        >
          {/* Row header */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span
              style={{ fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--color-text-secondary)', flex: '1 1 auto' }}
            >
              {shortSid}
            </span>
            <span className={`badge ${role === 'controller' ? 'badge-green' : 'badge-outline'}`}>{role}</span>
            <span className="badge badge-default">{transport}</span>
            {status && <span className="badge badge-default">{status}</span>}
            <button
              className={`btn btn-sm ${isOpen ? 'btn-primary' : 'btn-ghost'}`}
              onClick={() => (isOpen ? closeOperatePanel() : openOperatePanel(sid))}
              title={isOpen ? 'Close operate panel' : 'Open operate panel'}
            >
              <Plug size={11} /> {isOpen ? 'Close' : 'Operate'}
            </button>
            {/* Cloud sessions: open in CcrCloudView */}
            {transport === 'cloud' && /^(session_|cse_)/.test(sid) && (
              <button
                className={`btn btn-sm ${connectSid === sid ? 'btn-primary' : 'btn-ghost'}`}
                onClick={() => setConnectSid(connectSid === sid ? null : sid)}
                title="Open session view"
              >
                <Target size={11} /> View
              </button>
            )}
          </div>

          {/* Operate panel body */}
          {isOpen && (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
                paddingTop: 6,
                borderTop: '1px solid var(--color-border-subtle)',
              }}
            >
              {/* Live messages */}
              <div
                style={{
                  maxHeight: 180,
                  overflow: 'auto',
                  background: 'var(--color-bg-root)',
                  border: '1px solid var(--color-border-subtle)',
                  borderRadius: 'var(--radius-sm)',
                  padding: '6px 8px',
                  fontSize: 11,
                  fontFamily: 'var(--font-mono)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 3,
                }}
              >
                {readBusy && msgs.length === 0 && (
                  <div style={{ color: 'var(--color-text-tertiary)', display: 'flex', alignItems: 'center', gap: 4 }}>
                    <Loader2 size={11} style={{ animation: 'spin 1s linear infinite' }} /> loading…
                  </div>
                )}
                {msgs.length === 0 && !readBusy && (
                  <div style={{ color: 'var(--color-text-tertiary)' }}>No messages</div>
                )}
                {msgs.map((msg, i) => {
                  const msgRole = (msg.role as string) ?? (msg.type as string) ?? 'msg';
                  let text = '';
                  if (typeof msg.text === 'string') {
                    text = msg.text;
                  } else if (typeof msg.content === 'string') {
                    text = msg.content;
                  } else if (Array.isArray(msg.content)) {
                    text = msg.content
                      .map((c) => (typeof c === 'object' && c?.type === 'text' ? c.text : ''))
                      .filter(Boolean)
                      .join(' ');
                  }
                  const preview = text.length > 200 ? text.slice(0, 200) + '…' : text;
                  return (
                    <div key={i} style={{ display: 'flex', gap: 6 }}>
                      <span
                        style={{
                          color:
                            msgRole === 'user'
                              ? 'var(--color-accent)'
                              : msgRole === 'assistant'
                              ? 'var(--color-status-green)'
                              : 'var(--color-text-tertiary)',
                          minWidth: 60,
                        }}
                      >
                        {msgRole}
                      </span>
                      <span style={{ color: 'var(--color-text-secondary)', wordBreak: 'break-word', flex: 1 }}>
                        {preview || '(no text)'}
                      </span>
                    </div>
                  );
                })}
              </div>

              {/* Refresh + send message */}
              <div style={{ display: 'flex', gap: 6, alignItems: 'flex-start' }}>
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() => readSession(sid)}
                  disabled={readBusy}
                  title="Refresh messages"
                >
                  <RefreshCw size={11} style={readBusy ? { animation: 'spin 1s linear infinite' } : undefined} />
                </button>
                <textarea
                  className="input"
                  value={driveTxt}
                  rows={2}
                  placeholder="Send a message…"
                  style={{ flex: 1, resize: 'vertical', fontSize: 11 }}
                  onChange={(e) =>
                    setOperateDriveText((p) => ({ ...p, [sid]: e.target.value }))
                  }
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                      e.preventDefault();
                      driveSession(sid);
                    }
                  }}
                />
                <button
                  className="btn btn-primary btn-sm"
                  onClick={() => driveSession(sid)}
                  disabled={driveBusy || !driveTxt.trim()}
                  title="Send message (Ctrl/Cmd+Enter)"
                >
                  {driveBusy ? (
                    <Loader2 size={11} style={{ animation: 'spin 1s linear infinite' }} />
                  ) : (
                    <Send size={11} />
                  )}
                </button>
              </div>

              {/* Control buttons */}
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() => controlSession(sid, 'interrupt')}
                  disabled={busyKey('interrupt')}
                  title="Interrupt session"
                >
                  {busyKey('interrupt') ? (
                    <Loader2 size={11} style={{ animation: 'spin 1s linear infinite' }} />
                  ) : (
                    <AlertCircle size={11} />
                  )}{' '}
                  Interrupt
                </button>
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() => controlSession(sid, 'stop')}
                  disabled={busyKey('stop')}
                  title="Stop session"
                >
                  {busyKey('stop') ? (
                    <Loader2 size={11} style={{ animation: 'spin 1s linear infinite' }} />
                  ) : (
                    <Square size={11} />
                  )}{' '}
                  Stop
                </button>
                {role === 'controller' && (
                  <button
                    className="btn btn-ghost btn-sm"
                    onClick={() => controlSession(sid, 'restart')}
                    disabled={busyKey('restart')}
                    title="Restart controller (supervisor will relaunch)"
                  >
                    {busyKey('restart') ? (
                      <Loader2 size={11} style={{ animation: 'spin 1s linear infinite' }} />
                    ) : (
                      <RotateCcw size={11} />
                    )}{' '}
                    Restart
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      );
    },
    [
      operatePanelSid,
      operateMessages,
      operateReadBusy,
      operateDriveBusy,
      operateDriveText,
      operateControlBusy,
      connectSid,
      closeOperatePanel,
      openOperatePanel,
      readSession,
      driveSession,
      controlSession,
    ],
  );

  // ── Render helpers ──

  /** Render a single mission item (used in sidebar) */
  const renderMissionItem = useCallback(
    (m: Mission) => {
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
          style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}
        >
          {/* Top row: title + status */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span
              role="button"
              tabIndex={0}
              onClick={() => openMissionTab(m.id, m.title)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openMissionTab(m.id, m.title); } }}
              onMouseEnter={() => setHoverTitleId(m.id)}
              onMouseLeave={() => setHoverTitleId((cur) => (cur === m.id ? null : cur))}
              style={{
                fontSize: 13,
                fontWeight: 600,
                color: hoverTitleId === m.id ? 'var(--color-accent)' : 'var(--color-text-primary)',
                flex: '1 1 auto',
                cursor: 'pointer',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 5,
                textDecoration: hoverTitleId === m.id ? 'underline' : 'none',
              }}
              title="Open mission detail tab"
            >
              {m.title}
              <ListChecks size={11} style={{ color: 'var(--color-text-tertiary)', flexShrink: 0 }} />
            </span>
            <span className={`badge ${STATUS_BADGE[m.status]}`}>{m.status}</span>
            {m.binding ? (
              <span
                className="badge badge-outline"
                style={{ fontSize: 10 }}
                title={`Session: ${m.binding.sessionId ?? '—'} on ${m.binding.node ?? '—'}`}
              >
                {m.binding.kind ?? 'bound'} · {shortId(m.binding.sessionId)}
              </span>
            ) : (
              <span className="badge badge-default">unbound</span>
            )}
            {(() => {
              const node = m.binding?.node;
              if (!node) return null;
              const cl = clusterByGateway.get(node);
              return cl ? (
                <span className={`badge ${clusterBadge(cl)}`} style={{ fontSize: 9 }} title={`executor cluster: ${cl}`}>⬡ {cl}</span>
              ) : null;
            })()}
            {isBusy && <Loader2 size={13} style={{ animation: 'spin 1s linear infinite', color: 'var(--color-text-tertiary)' }} />}
          </div>

          {/* Interim progress — shown for active missions with executor-written progress text */}
          {m.status === 'active' && m.interim?.text && (
            <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)', fontStyle: 'italic' }}>
              ⏳ working — {m.interim.text.length > 120 ? m.interim.text.slice(0, 120) + '…' : m.interim.text}
            </div>
          )}

          {/* Objective — editable */}
          <div style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>
            <textarea
              className="input"
              value={objEdit ?? m.objective}
              rows={2}
              style={{ width: '100%', resize: 'vertical', fontSize: 11 }}
              onChange={(e) => setObjDraft((p) => ({ ...p, [m.id]: e.target.value }))}
            />
            {objEdit !== undefined && objEdit !== m.objective && (
              <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
                <button
                  className="btn btn-ghost btn-sm"
                  disabled={isBusy}
                  onClick={() => {
                    updateMission(m.id, { objective: objEdit });
                    setObjDraft((p) => { const n = { ...p }; delete n[m.id]; return n; });
                  }}
                >
                  Save
                </button>
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() => setObjDraft((p) => { const n = { ...p }; delete n[m.id]; return n; })}
                >
                  Discard
                </button>
              </div>
            )}
          </div>

          {/* Progress bar */}
          {m.progress && (
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2 }}>
                <div style={{ flex: 1, height: 4, background: 'var(--color-bg-elevated)', borderRadius: 2, overflow: 'hidden' }}>
                  <div
                    style={{
                      width: `${Math.min(100, m.progress.percent)}%`,
                      height: '100%',
                      background: STATUS_COLORS[m.status],
                      borderRadius: 2,
                      transition: 'width 0.3s ease',
                    }}
                  />
                </div>
                <span style={{ fontSize: 10, color: 'var(--color-text-tertiary)', minWidth: 28 }}>
                  {m.progress.percent}%
                </span>
              </div>
              {m.progress.summary && (
                <div style={{ fontSize: 10, color: 'var(--color-text-tertiary)' }}>{m.progress.summary}</div>
              )}
            </div>
          )}

          {/* Meta row */}
          <div style={{ fontSize: 10, color: 'var(--color-text-tertiary)', display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            <span>
              <span style={{ fontFamily: 'var(--font-mono)' }}>
                {m.env.isolation}{m.env.repo ? ` · ${m.env.repo}` : ''}
              </span>
            </span>
            <span>id: <span style={{ fontFamily: 'var(--font-mono)' }}>{m.id}</span></span>
            {m.control.waitReason && (
              <span style={{ color: 'var(--color-status-orange)' }}>waiting: {m.control.waitReason}</span>
            )}
          </div>

                    {(Object.keys(m.tags ?? {}).length > 0 || m.parentId || (m.dependsOn?.length ?? 0) > 0) && (
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 4, fontSize: 10 }}>
                        {Object.entries(m.tags ?? {}).flatMap(([dim, vals]) => vals.map((v) => (
                          <span key={`${dim}:${v}`} style={{ background: dim.startsWith('ctl:') ? 'var(--color-bg-elevated, #1e293b)' : 'var(--color-bg-surface, #0f172a)', color: dim.startsWith('ctl:') ? '#fbbf24' : 'var(--color-text-tertiary, #94a3b8)', border: '1px solid var(--color-border, #334155)', borderRadius: 4, padding: '1px 5px' }} title={dim}>{dim.replace(/^ctl:/, '')}: {v}</span>
                        )))}
                        {m.parentId && <span style={{ color: 'var(--color-text-tertiary, #94a3b8)' }} title={`parent ${m.parentId}`}>↑ parent</span>}
                        {(m.dependsOn?.length ?? 0) > 0 && <span style={{ color: 'var(--color-text-tertiary, #94a3b8)' }} title={m.dependsOn.join(', ')}>⛓ {m.dependsOn.length} dep</span>}
                      </div>
                    )}

          {/* Provenance */}
          {(m.createdBy || m.adjustments.length > 0) && (
            <div style={{ fontSize: 10, color: 'var(--color-text-tertiary)', display: 'flex', flexDirection: 'column', gap: 2 }}>
              {m.createdBy && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 3, flexWrap: 'wrap' }}>
                  <span>by</span>
                  <span style={{ color: 'var(--color-text-secondary)' }}>{renderActorLink(m.createdBy, m)}</span>
                  <span>via {m.createdBy.channel}</span>
                </div>
              )}
              {m.adjustments.length > 0 && (
                <div>
                  <button
                    className="btn btn-ghost btn-sm"
                    style={{ padding: '0 2px', fontSize: 10 }}
                    onClick={() => toggleContributors(m.id)}
                  >
                    {contribExpanded ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
                    {' '}Contributors ({m.adjustments.length})
                  </button>
                  {contribExpanded && (
                    <div style={{ marginTop: 3, paddingLeft: 8, borderLeft: '2px solid var(--color-border-subtle)', display: 'flex', flexDirection: 'column', gap: 2 }}>
                      {m.adjustments.slice().reverse().map((adj, i) => (
                        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 3, flexWrap: 'wrap' }}>
                          <span>{fmtTime(adj.at)}</span>
                          <span>·</span>
                          <span style={{ color: 'var(--color-text-secondary)' }}>
                            {adj.actor ? renderActorLink(adj.actor, m) : adj.by}
                          </span>
                          <span>—</span>
                          <span>{adj.change}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Detail toggle */}
          {hasDetail && (
            <button
              className="btn btn-ghost btn-sm"
              style={{ alignSelf: 'flex-start', padding: '0 4px', fontSize: 11 }}
              onClick={() => toggleExpand(m.id)}
            >
              {isExpanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />} detail
            </button>
          )}

          {isExpanded && (
            <div style={{ background: 'var(--color-bg-elevated)', border: '1px solid var(--color-border-subtle)', borderRadius: 'var(--radius-sm)', padding: 8, fontSize: 11, display: 'flex', flexDirection: 'column', gap: 8 }}>
              {m.plan && (
                <div>
                  <div style={{ fontWeight: 600, color: 'var(--color-text-secondary)', marginBottom: 3 }}>Plan</div>
                  <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: 'var(--color-text-secondary)', margin: 0, fontFamily: 'inherit' }}>{m.plan}</pre>
                </div>
              )}
              {(m.nextSteps?.length ?? 0) > 0 && (
                <div>
                  <div style={{ fontWeight: 600, color: 'var(--color-text-secondary)', marginBottom: 3 }}>Next steps</div>
                  <ul style={{ margin: 0, paddingLeft: 14 }}>
                    {m.nextSteps!.map((s, i) => <li key={i} style={{ color: 'var(--color-text-secondary)' }}>{s}</li>)}
                  </ul>
                </div>
              )}
              {m.results.length > 0 && (
                <div>
                  <div style={{ fontWeight: 600, color: 'var(--color-text-secondary)', marginBottom: 3 }}>Results</div>
                  {m.results.map((r, i) => (
                    <div key={i} style={{ color: 'var(--color-text-tertiary)', marginBottom: 2 }}>
                      {fmtTime(r.at)} · {r.ref}{r.summary ? ` — ${r.summary}` : ''}
                    </div>
                  ))}
                </div>
              )}
              {m.adjustments.length > 0 && (
                <div>
                  <div style={{ fontWeight: 600, color: 'var(--color-text-secondary)', marginBottom: 3 }}>
                    Audit trail ({m.adjustments.length})
                  </div>
                  <div style={{ maxHeight: 120, overflow: 'auto', fontFamily: 'var(--font-mono)', fontSize: 10 }}>
                    {m.adjustments.slice().reverse().map((a, i) => (
                      <div key={i} style={{ color: 'var(--color-text-tertiary)', marginBottom: 2 }}>
                        [{fmtTime(a.at)}]{' '}
                        <span style={{ color: 'var(--color-text-secondary)' }}>{a.by}</span>
                        {' · '}{a.trigger} → {a.change}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Action buttons */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', borderTop: '1px solid var(--color-border-subtle)', paddingTop: 8 }}>
            {m.status === 'active' && (
              <button className="btn btn-ghost btn-sm" disabled={isBusy} onClick={() => updateMission(m.id, { status: 'paused' })} title="Pause">
                <Pause size={11} /> Pause
              </button>
            )}
            {(m.status === 'paused' || m.status === 'blocked' || m.status === 'waiting') && (
              <button className="btn btn-primary btn-sm" disabled={isBusy} onClick={() => updateMission(m.id, { status: 'active' })} title="Resume">
                <Play size={11} /> Resume
              </button>
            )}
            {m.status !== 'done' && m.status !== 'failed' && (
              <button className="btn btn-ghost btn-sm" disabled={isBusy} onClick={() => updateMission(m.id, { status: 'done' })} title="Mark done">
                <CheckCircle size={11} /> Done
              </button>
            )}
            {m.binding?.sessionId && (
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => toggleSessionsExpand(m.id, !!m.binding?.sessionId)}
                title={sessionsExpanded.has(m.id) ? 'Hide sessions' : 'Show sessions'}
              >
                <Plug size={11} />
                {sessionsExpanded.has(m.id) ? ' Sessions ▲' : ' Sessions ▾'}
                {sessionsFetching.has(m.id) && <Loader2 size={10} style={{ marginLeft: 3, animation: 'spin 1s linear infinite' }} />}
              </button>
            )}
          </div>

          {/* Session list — with tab-open buttons */}
          {sessionsExpanded.has(m.id) && m.binding?.sessionId && (() => {
            const mSessions = sessionsByMission[m.id] ?? [];
            return (
              <div style={{ background: 'var(--color-bg-elevated)', border: '1px solid var(--color-border-subtle)', borderRadius: 'var(--radius-sm)', padding: '6px 8px', display: 'flex', flexDirection: 'column', gap: 4 }}>
                <div style={{ fontSize: 10, color: 'var(--color-text-tertiary)', marginBottom: 3 }}>Sessions</div>
                {mSessions.length === 0 && !sessionsFetching.has(m.id) && (
                  <div style={{ fontSize: 10, color: 'var(--color-text-tertiary)' }}>No sessions found (binding: {m.binding.sessionId})</div>
                )}
                {mSessions.map((s) => {
                  const isCloud = /^(session_|cse_)/.test(s.sid);
                  const transport: SessionTransport = isCloud ? 'cloud' : 'native';
                  const shortSid = s.sid.replace(/^(session_|cse_)/, '').slice(0, 8);
                  const roleLabel = s.kind === 'orchestrator' ? 'orchestrator' : 'worker';
                  const title = `${roleLabel} · ${shortSid}`;
                  const isTabActive = activeTabSid === s.sid;
                  return (
                    <button
                      key={s.sid}
                      className={`btn ${isTabActive ? 'btn-primary' : 'btn-ghost'} btn-sm`}
                      style={{ justifyContent: 'flex-start', gap: 6, fontSize: 11, fontFamily: 'var(--font-mono)', textAlign: 'left' }}
                      onClick={() => openSessionTab({ sid: s.sid, title, transport, node: m.binding?.node ?? null, missionId: m.id })}
                      title={`Open ${title} in a tab`}
                    >
                      {/* Transport badge */}
                      {isCloud
                        ? <Cloud size={10} style={{ color: 'var(--color-accent)', flexShrink: 0 }} />
                        : <Monitor size={10} style={{ color: 'var(--color-text-tertiary)', flexShrink: 0 }} />
                      }
                      {/* Role badge */}
                      <span className={`badge ${s.kind === 'orchestrator' ? 'badge-green' : 'badge-outline'}`} style={{ fontSize: 9 }}>
                        {roleLabel}
                      </span>
                      <span style={{ flex: 1, color: 'var(--color-text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {shortSid}
                      </span>
                      {/* Live/closed dot — if tab state known */}
                      {tabStates[s.sid] && (
                        <span
                          style={{
                            width: 6, height: 6, borderRadius: '50%', flexShrink: 0,
                            background: tabStates[s.sid].alive === 'alive'
                              ? 'var(--color-status-green)'
                              : tabStates[s.sid].alive === 'checking' || tabStates[s.sid].alive === 'resuming'
                              ? 'var(--color-status-orange)'
                              : 'var(--color-text-tertiary)',
                          }}
                        />
                      )}
                    </button>
                  );
                })}
              </div>
            );
          })()}
        </div>
      );
    },
    [
      busy, expanded, objDraft, contributorsExpanded, sessionsExpanded, sessionsFetching,
      sessionsByMission, connectSid, activeTabSid, tabStates, openSessionTab, openMissionTab,
      hoverTitleId, updateMission, toggleExpand, toggleContributors, toggleSessionsExpand, renderActorLink, apiFetch,
      clusterByGateway,
    ],
  );

  // ── Render ──
  // The local Core server-side proxies the leader's controllerSession into /mission/controller
  // when this node is not the monitor. controller.controllerSession is always authoritative.
  const effectiveController = controller;
  const cs = effectiveController?.controllerSession ?? null;
  const leader = controller?.leader ?? null;
  const leaderLabel = leader
    ? (leader.host || leader.node || 'unknown')
    : (controller?.election.monitorNodeId ? shortId(controller.election.monitorNodeId) : null);
  const isControllerLive = !!cs;

  // Prefer the NATIVE session uuid (its .jsonl holds the full transcript) over the cse (cloud handle,
  // sparse client-events). Reading the controller chat via the cse showed "No turns yet"; the native
  // sid reads the complete transcript and still surfaces the bridge pendingQuestion (bridgeCseFor).
  const controllerSid = cs ? (cs.sessionId ?? cs.cse) : null;
  // The controller's CLOUD/CCR session id for the "Open in Claude app" deep-link.
  // A cloud controller's controllerSid is already cloud; a NATIVE controller with a
  // --remote-control bridge keeps its CCR session in cs.cse (cse_… → session_…), so fall
  // back to that — otherwise the link never shows for a native-with-bridge controller.
  const controllerCloudSid = cs
    ? (controllerSid && /^(session_|cse_)/.test(controllerSid)
        ? controllerSid
        : (cs.cse ? cs.cse.replace(/^cse_/, 'session_') : null))
    : null;

  // Failover state: controllerSession is stale when it belongs to a different node than the
  // current elected leader. This happens during the ~1-min window after election flips but
  // before the new leader's supervisor has launched its controller session.
  const isFailingOver = (() => {
    if (!controller) return false;
    const electedLeaderNode = controller.leader?.node ?? controller.election.monitorNodeId ?? null;
    if (!electedLeaderNode) return false;
    // If controllerSession exists but points at a dead/old node → stale
    if (cs && cs.node !== electedLeaderNode) return true;
    // If no controllerSession yet AND there is an elected leader → in-progress failover
    if (!cs && electedLeaderNode) return true;
    return false;
  })();
  const failoverLeaderLabel = leader ? (leader.host || leader.node || 'unknown') : leaderLabel;

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
          padding: '12px 20px',
          borderBottom: '1px solid var(--color-border-default)',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          flexWrap: 'wrap',
        }}
      >
        <Target size={18} style={{ color: 'var(--color-accent)', flexShrink: 0 }} />
        <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--color-text-primary)' }}>
          Missions
        </div>

        {/* ── Leader badge ── */}
        {controller && leaderLabel && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: '3px 10px',
              borderRadius: 'var(--radius-sm)',
              background: 'var(--color-bg-elevated)',
              border: '1px solid var(--color-border-subtle)',
              fontSize: 12,
              color: 'var(--color-text-secondary)',
            }}
          >
            <span
              style={{
                width: 7,
                height: 7,
                borderRadius: '50%',
                background: isControllerLive ? 'var(--color-status-green)' : 'var(--color-text-tertiary)',
                flexShrink: 0,
              }}
            />
            Leader: <span style={{ fontWeight: 600, color: 'var(--color-text-primary)' }}>{leaderLabel}</span>
            {' '}· promoted
            {!isControllerLive && <span style={{ color: 'var(--color-text-tertiary)', marginLeft: 4 }}>(no controller)</span>}
          </div>
        )}

        <div style={{ flex: 1 }} />
        <button className="btn btn-ghost btn-sm" onClick={fetchAll} disabled={loading} title="Refresh">
          <RefreshCw size={13} style={loading ? { animation: 'spin 1s linear infinite' } : undefined} />
        </button>
        <button
          className="btn btn-ghost btn-sm"
          onClick={() => setShowItemsSidebar((v) => !v)}
          title={showItemsSidebar ? 'Hide missions sidebar' : 'Show missions sidebar'}
        >
          {showItemsSidebar ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
          {' '}Missions
        </button>
      </div>

      {/* ── Error banner ── */}
      {error && (
        <div
          style={{
            margin: '8px 16px 0',
            padding: '6px 10px',
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
          <button className="btn btn-ghost btn-sm" onClick={() => setError(null)}><X size={12} /></button>
        </div>
      )}

      {/* ── Two-pane body ── */}
      <div
        style={{
          flex: 1,
          display: 'flex',
          overflow: 'hidden',
          gap: 0,
        }}
      >
        {/* ── PRIMARY PANE: Controller chat + session tabs ── */}
        <div
          style={{
            flex: showItemsSidebar ? '1 1 0' : '1 1 100%',
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
            borderRight: showItemsSidebar ? '1px solid var(--color-border-default)' : 'none',
            minWidth: 0,
          }}
        >
          {/* ── Tab bar ── */}
          <div
            style={{
              display: 'flex',
              alignItems: 'stretch',
              borderBottom: '1px solid var(--color-border-subtle)',
              background: 'var(--color-bg-elevated)',
              overflowX: 'auto',
              flexShrink: 0,
            }}
          >
            {/* Tab 0: Mission Controller */}
            <button
              className={`btn btn-ghost btn-sm`}
              style={{
                borderRadius: 0,
                borderBottom: activeTabSid === null ? '2px solid var(--color-accent)' : '2px solid transparent',
                padding: '7px 14px',
                fontSize: 12,
                fontWeight: activeTabSid === null ? 600 : 400,
                color: activeTabSid === null ? 'var(--color-accent)' : 'var(--color-text-secondary)',
                whiteSpace: 'nowrap',
              }}
              onClick={() => setActiveTabSid(null)}
              title="Mission Controller chat"
            >
              Mission Controller
              {isControllerLive && (
                <span
                  style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--color-status-green)', marginLeft: 5, flexShrink: 0, display: 'inline-block' }}
                />
              )}
            </button>

            {/* Session tabs */}
            {openTabs.map((tab) => {
              const ts = tabStates[tab.sid];
              const isActive = activeTabSid === tab.sid;
              return (
                <div
                  key={tab.sid}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    borderBottom: isActive ? '2px solid var(--color-accent)' : '2px solid transparent',
                    borderLeft: '1px solid var(--color-border-subtle)',
                  }}
                >
                  <button
                    className="btn btn-ghost btn-sm"
                    style={{
                      borderRadius: 0,
                      padding: '7px 10px',
                      fontSize: 12,
                      fontWeight: isActive ? 600 : 400,
                      color: isActive ? 'var(--color-accent)' : 'var(--color-text-secondary)',
                      whiteSpace: 'nowrap',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 5,
                    }}
                    onClick={() => setActiveTabSid(tab.sid)}
                    title={tab.kind === 'mission' ? `Mission: ${tab.title}` : `${tab.title} (${tab.transport})`}
                  >
                    {tab.kind === 'mission'
                      ? <ListChecks size={10} />
                      : tab.transport === 'cloud'
                      ? <Cloud size={10} />
                      : <Monitor size={10} />
                    }
                    <span style={{ maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis' }}>{tab.title}</span>
                    {/* Status dot — session tabs only (mission tabs have no liveness) */}
                    {tab.kind !== 'mission' && ts && (
                      <span
                        style={{
                          width: 5, height: 5, borderRadius: '50%', flexShrink: 0,
                          background: ts.alive === 'alive'
                            ? 'var(--color-status-green)'
                            : ts.alive === 'checking' || ts.alive === 'resuming'
                            ? 'var(--color-status-orange)'
                            : 'var(--color-text-tertiary)',
                        }}
                      />
                    )}
                  </button>
                  <button
                    className="btn btn-ghost btn-sm"
                    style={{ borderRadius: 0, padding: '7px 6px', color: 'var(--color-text-tertiary)' }}
                    onClick={() => closeTab(tab.sid)}
                    title={`Close ${tab.title}`}
                  >
                    <X size={10} />
                  </button>
                </div>
              );
            })}
          </div>

          {/* ── Active tab: session view ── */}
          {activeTabSid !== null && (() => {
            const tab = openTabs.find((t) => t.sid === activeTabSid);
            if (!tab) return null;

            // Mission detail tab — render the editable detail view (no liveness check).
            if (tab.kind === 'mission') {
              return (
                <MissionDetailView
                  missionId={tab.sid}
                  apiFetch={apiFetch}
                  controllerSid={controllerSid}
                  controllerNode={leader?.node ?? null}
                  onOpenSession={(s) =>
                    openSessionTab({
                      ...s,
                      // Derive transport from the sid (cloud sessions are session_/cse_-prefixed).
                      transport: /^(session_|cse_)/.test(s.sid) ? 'cloud' : 'native',
                    })
                  }
                />
              );
            }

            const ts = tabStates[tab.sid] ?? { alive: 'checking' };

            // Checking/resuming spinner
            if (ts.alive === 'checking' || ts.alive === 'resuming') {
              return (
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, color: 'var(--color-text-tertiary)' }}>
                  <Loader2 size={20} style={{ animation: 'spin 1s linear infinite', color: 'var(--color-status-orange)' }} />
                  <div style={{ fontSize: 12 }}>
                    {ts.alive === 'resuming' ? 'Resuming session…' : 'Checking session status…'}
                  </div>
                </div>
              );
            }

            // Gone — cannot resume
            if (ts.alive === 'gone') {
              return (
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, color: 'var(--color-text-tertiary)', padding: 24 }}>
                  <AlertCircle size={24} style={{ color: 'var(--color-text-tertiary)' }} />
                  <div style={{ fontSize: 13, fontWeight: 500 }}>{ts.notice ?? 'Session ended — cannot resume.'}</div>
                  <button className="btn btn-ghost btn-sm" onClick={() => closeTab(tab.sid)}>
                    <X size={12} /> Close tab
                  </button>
                </div>
              );
            }

            // Confirm-resume for native sessions
            if (ts.alive === 'confirm-resume') {
              return (
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10, color: 'var(--color-text-secondary)', padding: 24 }}>
                  <AlertCircle size={24} style={{ color: 'var(--color-status-orange)' }} />
                  <div style={{ fontSize: 13, fontWeight: 500, textAlign: 'center' }}>
                    This session is closed.
                  </div>
                  <div style={{ fontSize: 12, textAlign: 'center', color: 'var(--color-text-tertiary)' }}>
                    Resume it? It will auto-close after 30 min idle.
                  </div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button
                      className="btn btn-primary btn-sm"
                      onClick={() => confirmResumeNative(tab)}
                    >
                      <Play size={12} /> Resume
                    </button>
                    <button className="btn btn-ghost btn-sm" onClick={() => closeTab(tab.sid)}>
                      <X size={12} /> Cancel
                    </button>
                  </div>
                </div>
              );
            }

            // Resume-gone — session permanently gone; offer "Start fresh worker"
            if (ts.alive === 'resume-gone') {
              return (
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, color: 'var(--color-text-tertiary)', padding: 24 }}>
                  <AlertCircle size={24} style={{ color: 'var(--color-text-tertiary)' }} />
                  <div style={{ fontSize: 13, fontWeight: 500 }}>{ts.notice ?? "Can't resume — this worker is gone."}</div>
                  <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                    {tab.missionId && (
                      <button
                        className="btn btn-primary btn-sm"
                        onClick={async () => {
                          try {
                            // Clear the mission binding so the controller spawns a fresh worker.
                            await apiFetch(`/mission/${encodeURIComponent(tab.missionId!)}`, {
                              method: 'POST',
                              body: { binding: null },
                            });
                          } catch {
                            // Best-effort — proceed to close tab regardless.
                          }
                          closeTab(tab.sid);
                        }}
                      >
                        <RefreshCw size={12} /> Start fresh worker
                      </button>
                    )}
                    <button className="btn btn-ghost btn-sm" onClick={() => closeTab(tab.sid)}>
                      <X size={12} /> Close tab
                    </button>
                  </div>
                </div>
              );
            }

            // Resume-conflict — session is live elsewhere; do NOT offer fresh spawn
            if (ts.alive === 'resume-conflict') {
              return (
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, color: 'var(--color-text-tertiary)', padding: 24 }}>
                  <AlertCircle size={24} style={{ color: 'var(--color-status-orange)' }} />
                  <div style={{ fontSize: 13, fontWeight: 500, textAlign: 'center' }}>{ts.notice ?? "This session is live elsewhere and can't be safely resumed."}</div>
                  <button className="btn btn-ghost btn-sm" style={{ marginTop: 4 }} onClick={() => closeTab(tab.sid)}>
                    <X size={12} /> Close tab
                  </button>
                </div>
              );
            }

            // Alive — render the session view
            // Show auto-close notice if applicable
            const notice = ts.notice;

            const isExpanded = expandedSessionSid === tab.sid;
            const sessionView = (filled: boolean) =>
              tab.transport === 'cloud' ? (
                <CcrCloudView
                  sid={tab.sid}
                  webUrl={`https://claude.ai/code/${tab.sid}`}
                  apiFetch={apiFetch}
                  onClose={() => closeTab(tab.sid)}
                  fill={filled}
                />
              ) : (
                <MissionSessionChat sid={tab.sid} node={tab.node ?? undefined} apiFetch={apiFetch} heightFill />
              );
            return (
              <>
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minHeight: 0 }}>
                  {/* Thin header strip with the expand affordance */}
                  <div style={{ padding: '6px 12px', borderBottom: '1px solid var(--color-border-subtle)', display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                    <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-text-secondary)' }}>Session</span>
                    <span style={{ fontSize: 10, fontFamily: 'var(--font-mono)', color: 'var(--color-text-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{tab.sid}</span>
                    <div style={{ flex: 1 }} />
                    <ExpandIconButton onClick={() => setExpandedSessionSid(tab.sid)} title="Expand session full screen" />
                  </div>
                  {notice && (
                    <div style={{ padding: '5px 14px', fontSize: 11, color: 'var(--color-status-orange)', background: 'var(--color-bg-elevated)', borderBottom: '1px solid var(--color-border-subtle)', flexShrink: 0 }}>
                      ⏱ {notice}
                    </div>
                  )}
                  {isExpanded ? (
                    <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--color-text-tertiary)', fontSize: 12, padding: 24, textAlign: 'center' }}>
                      Viewing full screen — press Esc or Collapse to return.
                    </div>
                  ) : (
                    sessionView(false)
                  )}
                </div>
                {isExpanded && (
                  <FullScreenOverlay
                    title={
                      <>
                        Session — <span style={{ color: 'var(--color-text-tertiary)', fontWeight: 400, fontFamily: 'var(--font-mono)' }}>{tab.sid}</span>
                      </>
                    }
                    onClose={() => setExpandedSessionSid(null)}
                  >
                    {sessionView(true)}
                  </FullScreenOverlay>
                )}
              </>
            );
          })()}

          {/* ── Controller tab content (activeTabSid === null) ── */}
          {activeTabSid === null && (
            <>
              {/* Chat header */}
              <div
                style={{
                  padding: '10px 16px',
                  borderBottom: '1px solid var(--color-border-subtle)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  flexShrink: 0,
                }}
              >
                <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-text-primary)' }}>
                  Mission Controller
                </span>
                {isControllerLive ? (
                  <span className="badge badge-green">live</span>
                ) : (
                  <span className="badge badge-default">offline</span>
                )}
                {cs && (
                  <span style={{ fontSize: 10, fontFamily: 'var(--font-mono)', color: 'var(--color-text-tertiary)' }}>
                    {cs.node} · {shortId(controllerSid)}
                  </span>
                )}
                <div style={{ flex: 1 }} />
                {/* Controller status: tick + job info */}
                {effectiveController && (
                  <>
                    <span className={`badge ${effectiveController.job.enabled ? 'badge-green' : 'badge-default'}`} style={{ fontSize: 10 }}>
                      {effectiveController.job.enabled ? `every ${effectiveController.job.intervalMinutes}m` : 'disabled'}
                    </span>
                    <button
                      className="btn btn-ghost btn-sm"
                      onClick={runTick}
                      disabled={tickBusy}
                      title="Run controller tick now"
                      style={{ fontSize: 11 }}
                    >
                      {tickBusy ? <Loader2 size={11} style={{ animation: 'spin 1s linear infinite' }} /> : <Play size={11} />}
                      {' '}Tick
                    </button>
                  </>
                )}
                {/* Direct deep-link: open the controller's CCR session in the native Claude app
                    — shows for a cloud controller AND a native controller with a CCR bridge. */}
                {controllerCloudSid && (
                  <a
                    className="btn btn-ghost btn-sm"
                    href={`https://claude.ai/code/${controllerCloudSid}`}
                    target="_blank"
                    rel="noreferrer"
                    title="Open this controller's CCR session in the Claude app"
                    style={{ fontSize: 11 }}
                  >
                    <ExternalLink size={11} /> Open in Claude app
                  </a>
                )}
                {/* Cloud view button for cloud sessions */}
                {cs && controllerSid && /^(session_|cse_)/.test(controllerSid) && (
                  <button
                    className={`btn btn-sm ${controllerSessionOpen ? 'btn-primary' : 'btn-ghost'}`}
                    onClick={() => {
                      setControllerSessionOpen((v) => {
                        if (v) setControllerSessionDismissed(true);
                        return !v;
                      });
                    }}
                    style={{ fontSize: 11 }}
                  >
                    <Target size={11} /> {controllerSessionOpen ? 'Close view' : 'Cloud view'}
                  </button>
                )}
              </div>

              {/* Tick result */}
              {tickResult && (
                <div style={{ padding: '4px 16px', fontSize: 11, color: 'var(--color-accent)', background: 'var(--color-bg-elevated)', borderBottom: '1px solid var(--color-border-subtle)' }}>
                  Tick: {tickResult}
                </div>
              )}

              {/* Cloud view (optional) */}
              {controllerSessionOpen && cs && controllerSid && /^(session_|cse_)/.test(controllerSid) && (
                <div style={{ padding: '8px 16px', borderBottom: '1px solid var(--color-border-subtle)', flexShrink: 0 }}>
                  <CcrCloudView
                    sid={controllerSid}
                    webUrl={`https://claude.ai/code/${controllerSid}`}
                    apiFetch={apiFetch}
                    onClose={() => { setControllerSessionOpen(false); setControllerSessionDismissed(true); }}
                  />
                </div>
              )}

              {/* State banners (failover / offline) — shown when no live session chat */}
              <div
                style={{
                  flex: (!cs || isFailingOver) ? 1 : undefined,
                  overflow: 'auto',
                  padding: '12px 16px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 6,
                }}
              >
                {/* Failover banner: shown when controllerSession is stale (node != elected leader) */}
                {isFailingOver && !loading && (
                  <div
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center',
                      justifyContent: 'center',
                      height: '100%',
                      gap: 8,
                      color: 'var(--color-text-tertiary)',
                    }}
                  >
                    <RefreshCw size={28} style={{ color: 'var(--color-status-orange)', animation: 'spin 2s linear infinite' }} />
                    <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--color-status-orange)' }}>
                      Failing over — electing controller
                    </div>
                    <div style={{ fontSize: 12, textAlign: 'center' }}>
                      New leader: <strong>{failoverLeaderLabel}</strong>
                      <br />
                      Supervisor will launch the controller on its next tick (~1 min)
                    </div>
                    {effectiveController && (
                      <button
                        className="btn btn-primary btn-sm"
                        onClick={runTick}
                        disabled={tickBusy}
                        style={{ marginTop: 4 }}
                        title="Force a supervisor tick on the new leader now"
                      >
                        {tickBusy ? <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} /> : <Play size={13} />}
                        {' '}Force tick now
                      </button>
                    )}
                  </div>
                )}
                {!cs && !isFailingOver && !loading && (
                  <div
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center',
                      justifyContent: 'center',
                      height: '100%',
                      gap: 8,
                      color: 'var(--color-text-tertiary)',
                    }}
                  >
                    <AlertCircle size={28} style={{ color: 'var(--color-text-tertiary)' }} />
                    <div style={{ fontSize: 13, fontWeight: 500 }}>No mission controller running</div>
                    <div style={{ fontSize: 12, textAlign: 'center' }}>
                      {controller
                        ? 'Supervisor will launch the controller on the next tick'
                        : 'Loading controller status…'}
                    </div>
                    {effectiveController && (
                      <button
                        className="btn btn-primary btn-sm"
                        onClick={runTick}
                        disabled={tickBusy}
                        style={{ marginTop: 4 }}
                      >
                        {tickBusy ? <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} /> : <Play size={13} />}
                        {' '}Run tick now
                      </button>
                    )}
                  </div>
                )}
              </div>

              {/* Controller chat — rendered via MissionSessionChat when a controller session is live */}
              {cs && controllerSid && !isFailingOver && (
                <>
                  <MissionSessionChat
                    sid={controllerSid}
                    node={leader?.node ?? undefined}
                    apiFetch={apiFetch}
                    heightFill
                  />
                  {/* Control buttons row (interrupt/stop/restart stay in MissionsPage — controller-specific) */}
                  <div
                    style={{
                      padding: '6px 16px 10px',
                      borderTop: '1px solid var(--color-border-subtle)',
                      display: 'flex',
                      gap: 6,
                      flexWrap: 'wrap',
                      flexShrink: 0,
                      background: 'var(--color-bg-root)',
                    }}
                  >
                    <button
                      className="btn btn-ghost btn-sm"
                      onClick={() => controllerChatControl(controllerSid, leader, 'interrupt')}
                      disabled={!!chatControlBusy['interrupt']}
                      title="Interrupt controller"
                    >
                      {chatControlBusy['interrupt'] ? <Loader2 size={11} style={{ animation: 'spin 1s linear infinite' }} /> : <AlertCircle size={11} />} Interrupt
                    </button>
                    <button
                      className="btn btn-ghost btn-sm"
                      onClick={() => controllerChatControl(controllerSid, leader, 'stop')}
                      disabled={!!chatControlBusy['stop']}
                      title="Stop controller"
                    >
                      {chatControlBusy['stop'] ? <Loader2 size={11} style={{ animation: 'spin 1s linear infinite' }} /> : <Square size={11} />} Stop
                    </button>
                    <button
                      className="btn btn-ghost btn-sm"
                      onClick={() => controllerChatControl(controllerSid, leader, 'restart')}
                      disabled={!!chatControlBusy['restart']}
                      title="Restart controller (supervisor will relaunch)"
                    >
                      {chatControlBusy['restart'] ? <Loader2 size={11} style={{ animation: 'spin 1s linear infinite' }} /> : <RotateCcw size={11} />} Restart
                    </button>
                  </div>
                </>
              )}
            </>
          )}
        </div>

        {/* ── SECONDARY PANE: Mission items sidebar ── */}
        {showItemsSidebar && (
          <div
            style={{
              width: 340,
              flexShrink: 0,
              display: 'flex',
              flexDirection: 'column',
              overflow: 'hidden',
            }}
          >
            {/* Sidebar header */}
            <div
              style={{
                padding: '10px 14px',
                borderBottom: '1px solid var(--color-border-subtle)',
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                flexShrink: 0,
              }}
            >
              <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-text-primary)' }}>
                Missions
              </span>
              {missions.length > 0 && (
                <span className="badge badge-outline">{missions.length}</span>
              )}
              <div style={{ flex: 1 }} />
              <button
                className="btn btn-ghost btn-sm"
                onClick={toggleAllSessions}
                title={allSessionsExpanded ? 'Hide all sessions' : 'All sessions'}
              >
                <Plug size={12} />
              </button>
            </div>

            {/* ── Search + filters (fixed; the list below scrolls) ── */}
            <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--color-border-subtle)', display: 'flex', flexDirection: 'column', gap: 6, flexShrink: 0 }}>
              <input
                className="input"
                value={missionSearch}
                placeholder="Search missions…  (space = AND)"
                style={{ width: '100%', fontSize: 12 }}
                onChange={(e) => { setMissionSearch(e.target.value); resetMissionPage(); }}
              />
              <div style={{ display: 'flex', gap: 6 }}>
                <select className="input" value={missionStatusFilter} style={{ flex: 1, fontSize: 11, minWidth: 0 }} title="Filter by status" onChange={(e) => { setMissionStatusFilter(e.target.value as 'all' | MissionStatus); resetMissionPage(); }}>
                  <option value="all">All status</option>
                  <option value="active">active</option>
                  <option value="waiting">waiting</option>
                  <option value="paused">paused</option>
                  <option value="blocked">blocked</option>
                  <option value="done">done</option>
                  <option value="failed">failed</option>
                  <option value="draft">draft</option>
                </select>
                <select className="input" value={missionTransportFilter} style={{ flex: 1, fontSize: 11, minWidth: 0 }} title="Filter by worker transport" onChange={(e) => { setMissionTransportFilter(e.target.value as 'all' | 'cloud' | 'native'); resetMissionPage(); }}>
                  <option value="all">All type</option>
                  <option value="cloud">cloud</option>
                  <option value="native">native</option>
                </select>
                <select className="input" value={missionRecencyFilter} style={{ flex: 1, fontSize: 11, minWidth: 0 }} title="Filter by recency (last updated)" onChange={(e) => { setMissionRecencyFilter(e.target.value as 'all' | '1d' | '3d' | '7d'); resetMissionPage(); }}>
                  <option value="all">Any time</option>
                  <option value="1d">1 day</option>
                  <option value="3d">3 days</option>
                  <option value="7d">7 days</option>
                </select>
              </div>
            </div>

            <div style={{ flex: 1, overflow: 'auto', padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 10 }}>

              {/* ── All sessions panel (fleet operability) ── */}
              {allSessionsExpanded && (
                <div className="card" style={{ padding: 10, flexShrink: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                    <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-text-primary)' }}>All Sessions</span>
                    {allSessions.length > 0 && <span className="badge badge-outline">{allSessions.length}</span>}
                    <div style={{ flex: 1 }} />
                    <button className="btn btn-ghost btn-sm" onClick={fetchAllSessions} disabled={allSessionsLoading}>
                      <RefreshCw size={11} style={allSessionsLoading ? { animation: 'spin 1s linear infinite' } : undefined} />
                    </button>
                    <button className="btn btn-ghost btn-sm" onClick={toggleAllSessions}><X size={11} /></button>
                  </div>
                  {allSessions.length === 0 && !allSessionsLoading && (
                    <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>No active sessions</div>
                  )}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                    {allSessions.map((s) => renderOperatePanel(s))}
                  </div>
                </div>
              )}

              {/* ── + New mission (collapsible) ── */}
              <div className="card" style={{ padding: 10, flexShrink: 0 }}>
                <button
                  className="btn btn-ghost btn-sm"
                  style={{ width: '100%', justifyContent: 'flex-start', gap: 6, fontSize: 12 }}
                  onClick={() => setShowCreate((v) => !v)}
                >
                  {showCreate ? <ChevronDown size={12} /> : <Plus size={12} />}
                  {showCreate ? 'Cancel new mission' : '+ New mission'}
                </button>

                {showCreate && (
                  <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'flex-start' }}>
                      <label style={{ fontSize: 11, color: 'var(--color-text-secondary)', flex: '1 1 140px' }}>
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
                      <label style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}>
                        isolation
                        <br />
                        <select
                          className="input"
                          value={form.isolation}
                          onChange={(e) => setForm({ ...form, isolation: e.target.value as Isolation })}
                        >
                          <option value="cloud">cloud</option>
                          <option value="worktree">worktree</option>
                          <option value="shared">shared</option>
                        </select>
                      </label>
                    </div>
                    <label style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}>
                      objective *
                      <br />
                      <textarea
                        className="input"
                        value={form.objective}
                        placeholder="Describe the goal…"
                        rows={3}
                        style={{ width: '100%', resize: 'vertical' }}
                        onChange={(e) => setForm({ ...form, objective: e.target.value })}
                      />
                    </label>

                    {/* Repo / Branch pickers */}
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                      <label style={{ fontSize: 11, color: 'var(--color-text-secondary)', flex: '1 1 120px' }}>
                        repo (optional)
                        <br />
                        {reposLoading ? (
                          <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 3 }}>
                            <Loader2 size={11} style={{ animation: 'spin 1s linear infinite' }} />
                            <span style={{ fontSize: 10, color: 'var(--color-text-tertiary)' }}>loading…</span>
                          </div>
                        ) : reposError || repos.length === 0 ? (
                          <>
                            <input className="input" value={repoText} placeholder="owner/repo" style={{ width: '100%' }} onChange={(e) => setRepoText(e.target.value)} />
                            {reposError && <span style={{ fontSize: 10, color: 'var(--color-text-tertiary)' }}>type manually</span>}
                          </>
                        ) : customRepo ? (
                          <>
                            <input className="input" value={repoText} placeholder="owner/repo" style={{ width: '100%' }} onChange={(e) => setRepoText(e.target.value)} />
                            <button className="btn btn-ghost btn-sm" style={{ marginTop: 2, fontSize: 10 }} onClick={() => { setCustomRepo(false); setRepoText(''); }}>list</button>
                          </>
                        ) : (
                          <select
                            className="input"
                            value={selectedRepo}
                            style={{ width: '100%' }}
                            onChange={(e) => {
                              const v = e.target.value;
                              if (v === '__custom__') { setCustomRepo(true); setSelectedRepo(''); setBranches([]); setSelectedBranch(''); }
                              else { setSelectedRepo(v); setSelectedBranch(''); setBranches([]); if (v) fetchBranches(v); }
                            }}
                          >
                            <option value="">— none —</option>
                            {repos.map((r) => <option key={r} value={r}>{r}</option>)}
                            <option value="__custom__">— custom —</option>
                          </select>
                        )}
                      </label>
                      <label style={{ fontSize: 11, color: 'var(--color-text-secondary)', flex: '1 1 120px' }}>
                        branch (optional)
                        <br />
                        {branchesLoading ? (
                          <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 3 }}>
                            <Loader2 size={11} style={{ animation: 'spin 1s linear infinite' }} />
                          </div>
                        ) : customBranch ? (
                          <>
                            <input className="input" value={branchText} placeholder="branch" style={{ width: '100%' }} onChange={(e) => setBranchText(e.target.value)} />
                            <button className="btn btn-ghost btn-sm" style={{ marginTop: 2, fontSize: 10 }} onClick={() => { setCustomBranch(false); setBranchText(''); }}>list</button>
                          </>
                        ) : branches.length > 0 ? (
                          <select
                            className="input"
                            value={selectedBranch}
                            style={{ width: '100%' }}
                            onChange={(e) => {
                              const v = e.target.value;
                              if (v === '__custom__') { setCustomBranch(true); setSelectedBranch(''); }
                              else { setSelectedBranch(v); }
                            }}
                          >
                            <option value="">— none —</option>
                            {branches.map((b) => <option key={b} value={b}>{b}</option>)}
                            <option value="__custom__">— custom —</option>
                          </select>
                        ) : (
                          <input className="input" value={branchText} placeholder="branch" style={{ width: '100%' }} onChange={(e) => setBranchText(e.target.value)} />
                        )}
                      </label>
                    </div>

                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                      <label style={{ fontSize: 11, color: 'var(--color-text-secondary)', flex: '1 1 120px' }}>
                        projects (optional)
                        <br />
                        <input className="input" value={form.projects} placeholder="owner/repo, …" style={{ width: '100%' }} onChange={(e) => setForm({ ...form, projects: e.target.value })} />
                      </label>
                      <label style={{ fontSize: 11, color: 'var(--color-text-secondary)', flex: '1 1 120px' }}>
                        depends on
                        <br />
                        <input className="input" value={form.dependsOn} placeholder="ms-abc123, …" style={{ width: '100%' }} onChange={(e) => setForm({ ...form, dependsOn: e.target.value })} />
                      </label>
                    </div>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button
                        className="btn btn-primary btn-sm"
                        disabled={creating || !form.title.trim() || !form.objective.trim()}
                        onClick={createMission}
                      >
                        {creating ? <Loader2 size={12} style={{ animation: 'spin 1s linear infinite' }} /> : 'Create'}
                      </button>
                      <button
                        className="btn btn-ghost btn-sm"
                        onClick={() => { setShowCreate(false); setForm({ title: '', objective: '', isolation: 'cloud', projects: '', dependsOn: '' }); }}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </div>

              {/* ── Mission list (filtered · sorted by recency · top 50 + load more) ── */}
              {loading && missions.length === 0 ? (
                <div className="empty-state">
                  <Loader2 size={20} style={{ animation: 'spin 1s linear infinite' }} />
                </div>
              ) : missions.length === 0 ? (
                <div className="empty-state" style={{ fontSize: 12 }}>
                  <Target size={24} className="empty-state-icon" />
                  <div>No missions yet</div>
                </div>
              ) : visibleMissions.length === 0 ? (
                <div className="empty-state" style={{ fontSize: 12 }}>
                  <Target size={24} className="empty-state-icon" />
                  <div>No missions match</div>
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {visibleMissions.map((m) => renderMissionItem(m))}
                  {filteredMissions.length > visibleMissions.length && (
                    <button
                      className="btn btn-ghost btn-sm"
                      style={{ width: '100%', justifyContent: 'center', gap: 6, fontSize: 11 }}
                      onClick={() => setMissionVisibleCount((c) => c + 50)}
                      title="Load more missions"
                    >
                      <ChevronDown size={13} /> Load {Math.min(50, filteredMissions.length - visibleMissions.length)} more
                      <span style={{ color: 'var(--color-text-tertiary)' }}>({visibleMissions.length}/{filteredMissions.length})</span>
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
