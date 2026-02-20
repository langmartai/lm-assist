import type {
  Machine,
  Session,
  SessionDetail,
  SessionMessage,
  Milestone,
  Project,
  ProjectArchitecture,
  TaskList,
  Terminal,
  IndexedSessionResult,
  AppMode,
  ProxyInfo,
  RunningProcessesResponse,
} from './types';

// ============================================
// API Client Interface
// ============================================

// ============================================
// Process Identification Types
// ============================================

export interface ProcessScreenTurn {
  lastReadTurnIndex: number | null;
  lastReadTimestamp: string | null;
  matchedVia: 'userPrompt' | 'response' | null;
  matchedText: string | null;
  contentLength: number;
  capturedAt: string;
}

export interface IdentifiedProcess {
  pid: number;
  sessionId: string | null;
  managedBy: string;
  tmuxSessionName: string | null;
  role: 'original' | 'console-tab' | 'resumed' | 'unknown' | null;
  processStartedAt: string | null;
  sessionBirthtime: string | null;
  timeDeltaMs: number | null;
  identification: { confidence: number; matchDetails: any } | null;
  screenTurn: ProcessScreenTurn | null;
  sessionStats: { numTurns: number; lastTurnIndex: number; lastTimestamp: string | null } | null;
  error?: string;
}

// Batch Check Types
// ============================================

export interface BatchCheckRequest {
  sessions?: Array<{
    sessionId: string;
    knownFileSize?: number;
    knownAgentCount?: number;
  }>;
  listCheck?: {
    projectPath?: string;
    knownSessionCount?: number;
    knownLatestModified?: string;
  };
}

export interface BatchCheckSessionResult {
  exists: boolean;
  lineCount: number;
  fileSize: number;
  agentIds: string[];
  lastModified: string;
  changed: boolean;
  agentsChanged: boolean;
}

export interface BatchCheckListSession {
  sessionId: string;
  lastModified: string;
  fileSize: number;
  isRunning: boolean;
  numTurns?: number;
  totalCostUsd?: number;
  model?: string;
  lastUserMessage?: string;
  agentCount?: number;
  userPromptCount?: number;
  taskCount?: number;
  teamName?: string;
  allTeams?: string[];
  forkedFromSessionId?: string;
}

export interface BatchCheckResponse {
  sessions: Record<string, BatchCheckSessionResult>;
  listStatus?: {
    totalSessions: number;
    latestModified: string;
    changed: boolean;
    sessions?: BatchCheckListSession[];
  };
}

export interface ApiClient {
  mode: AppMode;

  // Machines
  getMachines(): Promise<Machine[]>;

  // Sessions
  getSessions(machineId?: string): Promise<Session[]>;
  getSessionDetail(sessionId: string, machineId?: string): Promise<SessionDetail>;
  getSessionConversation(
    sessionId: string,
    opts: { lastN?: number; fromLine?: number },
    machineId?: string,
  ): Promise<SessionDetail>;
  checkSessionUpdate(
    sessionId: string,
    machineId?: string,
  ): Promise<{ exists: boolean; lineCount: number; agentIds?: string[]; lastModified?: string }>;
  batchCheckSessions(
    request: BatchCheckRequest,
    machineId?: string,
  ): Promise<BatchCheckResponse>;

  // Projects
  getProjects(machineId?: string): Promise<Project[]>;

  // Tasks
  getTaskLists(machineId?: string): Promise<TaskList[]>;
  getTaskStoreAll(machineId?: string): Promise<{ tasks: import('./types').SessionTask[] }>;

  // Terminals
  startTerminal(sessionId: string, projectPath?: string, machineId?: string, options?: { existingTmuxSession?: string; connectPid?: number }): Promise<{ consoleUrl: string }>;
  startAllTerminals(machineId?: string): Promise<{
    results: Array<{ sessionId: string; consoleUrl?: string; port?: number; alreadyRunning?: boolean; error?: string }>;
    summary: { total: number; started: number; alreadyRunning: number; failed: number };
  }>;
  stopTerminal(sessionId: string, machineId?: string): Promise<void>;
  getTerminalStatus(machineId?: string): Promise<{ active: boolean; url?: string; sessions?: string[]; managed?: any[] }>;
  killSessionProcesses(sessionId: string, machineId?: string): Promise<{ success: boolean; killed: number[]; errors: string[] }>;
  killProcess(pid: number, machineId?: string): Promise<{ success: boolean }>;
  identifyProcesses(pids: number[], machineId?: string): Promise<{ processes: IdentifiedProcess[] }>;

  // Shell terminals
  startShellTerminal(projectPath: string, machineId?: string): Promise<{ consoleUrl: string }>;
  getShellConfig(machineId?: string): Promise<{ shell: string }>;
  updateShellConfig(shell: string, machineId?: string): Promise<void>;

  // Subagents
  getSessionSubagents(sessionId: string, machineId?: string): Promise<{
    invocations: any[];
    sessions: import('./types').SubagentSession[];
  }>;

  // Milestones
  getMilestones(sessionId: string, machineId?: string): Promise<{ milestones: Milestone[]; phase: number | null }>;

  // Architecture
  getProjectArchitecture(projectPath?: string, machineId?: string): Promise<ProjectArchitecture | null>;
  getArchitectureModel(projectPath?: string, machineId?: string): Promise<import('./types').ArchitectureModelResponse | null>;
  generateArchitectureModel(projectPath?: string, machineId?: string, model?: string): Promise<{ model: import('./types').ArchitectureModel; generatedAt: number; sessionId?: string } | null>;

  // Session Index
  getIndexedSession(sessionId: string, machineId?: string): Promise<IndexedSessionResult | null>;

  // Running Processes
  getRunningProcesses(machineId?: string): Promise<RunningProcessesResponse>;
  /** Delta check: returns { changed: false, hash } if unchanged, or full data if changed */
  checkRunningProcesses(knownHash: string, machineId?: string): Promise<{ changed: boolean; hash: string; data?: RunningProcessesResponse }>;

  // Plans
  getPlanFileContent(planFile: string, machineId?: string): Promise<string | null>;

  // Session Search
  searchSessions(query: string, opts?: { projectPath?: string; scope?: string; limit?: number; directory?: string }, machineId?: string): Promise<{ results: any[]; total: number; query: string; scope: string; searchTimeMs: number; sessionsScanned: number }>;
  searchSessionsAi(query: string, opts?: { projectPath?: string; scope?: string; limit?: number; model?: string }, machineId?: string): Promise<{ jobId: string; status: string; candidatesFound: number }>;
  getAiSearchJob(jobId: string, machineId?: string): Promise<any>;
  getRecentMilestones(machineId?: string, opts?: { projectPath?: string; directory?: string }): Promise<{ results: any[] }>;

  // Generic fetch — routes any path through the correct client (local/hub) with auth
  fetchPath<T = any>(path: string, opts?: { method?: string; body?: any; machineId?: string }): Promise<T>;
}

// ============================================
// Proxy session expiry callback
// ============================================

/** Module-level callback for proxy session expiry (401 from web-proxy) */
let _onProxySessionExpired: (() => void) | null = null;

export function setProxySessionExpiredCallback(cb: (() => void) | null) {
  _onProxySessionExpired = cb;
}

// ============================================
// Shared fetch helper
// ============================================

async function fetchJson<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json', ...options?.headers },
    ...options,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    // Detect proxy token expiry (401 from web-proxy)
    if (res.status === 401 && text.includes('proxy token') && _onProxySessionExpired) {
      _onProxySessionExpired();
    }
    throw new Error(`API ${res.status}: ${text || res.statusText}`);
  }
  const json = await res.json();
  // Unwrap { data: ... } or { result: ... } wrappers
  if (json && typeof json === 'object') {
    if ('data' in json) return json.data as T;
    if ('result' in json) return json.result as T;
  }
  return json as T;
}

/**
 * Fetch JSON without unwrapping { data: ... } wrappers.
 * Used for hub endpoints that return top-level fields alongside a `data` key
 * (e.g. { success: true, consoleUrl: "...", data: {} }).
 */
async function fetchJsonRaw<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json', ...options?.headers },
    ...options,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    // Detect proxy token expiry (401 from web-proxy)
    if (res.status === 401 && text.includes('proxy token') && _onProxySessionExpired) {
      _onProxySessionExpired();
    }
    throw new Error(`API ${res.status}: ${text || res.statusText}`);
  }
  return res.json() as Promise<T>;
}

/**
 * Normalize console URLs returned by the hub.
 * The hub returns localhost URLs like "http://localhost:8081/api/tier-agent/machines/.../ttyd/port/?token=..."
 * which aren't accessible from the browser when accessed via langmart.ai.
 *
 * Converts to relative paths so they route through the current origin.
 * On langmart.ai, the main web app's Next.js rewrites proxy
 * /api/tier-agent/* to Gateway Type 1, keeping the iframe same-origin.
 */
function normalizeConsoleUrl(url: string): string {
  if (!url) return url;
  try {
    if (url.match(/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?/)) {
      const parsed = new URL(url);
      return parsed.pathname + parsed.search;
    }
  } catch { /* not a valid URL, return as-is */ }
  return url;
}

/**
 * Resolve console URLs for LAN access.
 * The tier-agent API always returns ttyd URLs as http://localhost:PORT.
 * When the browser is on a LAN IP (not localhost), replace "localhost"
 * with the current hostname so the iframe can reach the server.
 */
export function resolveConsoleUrl(url: string): string {
  if (!url) return url;
  if (typeof window === 'undefined') return url;
  const hostname = window.location.hostname;
  // If already on localhost, no rewriting needed
  if (hostname === 'localhost' || hostname === '127.0.0.1') return url;
  // Replace localhost/127.0.0.1 in the URL with the current hostname
  try {
    if (url.match(/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)/)) {
      return url.replace(/^(https?:\/\/)(localhost|127\.0\.0\.1)/, `$1${hostname}`);
    }
  } catch { /* not a valid URL, return as-is */ }
  return url;
}

// ============================================
// Local API Client
// Direct HTTP to local tier-agent API
// ============================================

export function createLocalClient(baseUrl: string, proxyInfo?: ProxyInfo): ApiClient {
  const api = (path: string) => `${baseUrl}${path}`;

  // In proxy mode, hub API calls go through the proxy's hub API forwarding
  // The web-proxy intercepts /api/tier-agent/ and forwards internally to hub
  const hubApi = (path: string) =>
    proxyInfo?.isProxied
      ? `${proxyInfo.basePath}/api/tier-agent${path}`
      : null;

  // Cache for ifModifiedSince optimization — avoids re-fetching unchanged data
  let cachedSessions: Session[] | null = null;
  let cachedSessionsLastModified: string | null = null;

  return {
    mode: 'local',

    async getMachines(): Promise<Machine[]> {
      // Fetch local machine info and hub machines in parallel
      const [healthResult, hubResult] = await Promise.allSettled([
        fetchJson<{ hostname?: string; platform?: string }>(api('/health')),
        fetchJson<any>(api('/hub/machines')),
      ]);

      const health = healthResult.status === 'fulfilled' ? healthResult.value : {};
      const localMachine: Machine = {
        id: 'localhost',
        hostname: health.hostname || 'localhost',
        platform: health.platform || 'linux',
        status: 'online',
        lastHeartbeat: new Date().toISOString(),
      };

      // If hub machines available, merge (same logic as hybrid client)
      const hubData = hubResult.status === 'fulfilled' ? hubResult.value : null;
      const hubMachines: any[] = hubData?.machines || [];

      if (hubMachines.length === 0) {
        return [localMachine];
      }

      // Get local gatewayId from hub status (cached in AppModeContext, but we need it here)
      let localGatewayId: string | null = null;
      try {
        const statusResult = await fetchJson<any>(api('/hub/status'));
        localGatewayId = statusResult?.gatewayId || null;
      } catch { /* ignore */ }

      const result: Machine[] = [];
      let localFound = false;

      for (const w of hubMachines) {
        const machineId = w.gatewayId || w.id;
        if (localGatewayId && (machineId === localGatewayId || w.gatewayId === localGatewayId)) {
          // This is the local machine — merge with local health data
          result.push({
            id: machineId,
            hostname: localMachine.hostname,
            platform: localMachine.platform,
            status: 'online',
            lastHeartbeat: w.lastHeartbeat,
            connectedAt: w.connectedAt,
            gatewayId: w.gatewayId,
            osVersion: w.osVersion,
            isLocal: true,
          });
          localFound = true;
        } else {
          result.push({
            id: machineId,
            hostname: w.hostname || w.name,
            platform: w.platform || 'linux',
            status: w.status === 'online' || w.connected ? 'online' : 'offline',
            lastHeartbeat: w.lastHeartbeat,
            connectedAt: w.connectedAt,
            gatewayId: w.gatewayId,
            osVersion: w.osVersion,
          });
        }
      }

      // If local machine wasn't in hub list, add it
      if (!localFound) {
        result.unshift({
          ...localMachine,
          id: localGatewayId || 'localhost',
          isLocal: true,
        });
      }

      return result;
    },

    async getSessions(machineId?: string): Promise<Session[]> {
      // Single call to get all sessions across all projects
      // Uses ifModifiedSince to avoid re-fetching unchanged data
      const params = new URLSearchParams();
      if (cachedSessionsLastModified) {
        params.set('ifModifiedSince', cachedSessionsLastModified);
      }
      const qs = params.toString() ? `?${params.toString()}` : '';
      const result = await fetchJson<any>(api(`/projects/sessions${qs}`));

      // Server returns { notModified: true } when nothing changed at all
      if (result.notModified && cachedSessions) {
        return cachedSessions;
      }

      const sessions: any[] = Array.isArray(result) ? result : result.sessions || [];

      const mapSession = (s: any): Session => ({
        sessionId: s.sessionId || s.id,
        projectPath: s.projectPath || '',
        projectName: extractProjectName(s.projectPath),
        model: s.model,
        lastModified: s.lastModified,
        size: s.fileSize || s.size,
        messageCount: s.messageCount,
        summary: s.summary,
        isRunning: s.isRunning || s.isActive || !!s.running || false,
        isPaused: false,
        totalCostUsd: s.totalCostUsd,
        numTurns: s.numTurns,
        agentCount: s.agentCount,
        userPromptCount: s.userPromptCount,
        taskCount: s.taskCount,
        lastUserMessage: s.lastUserMessage,
        running: s.running || undefined,
        forkedFromSessionId: s.forkedFromSessionId,
        machineId: 'localhost',
        machineHostname: 'localhost',
        machinePlatform: 'linux',
        machineStatus: 'online',
      });

      let mapped: Session[];
      const total: number | undefined = result.total;

      // Partial response: server sent fewer sessions than total (ifModifiedSince filtered)
      // Merge changed sessions into cached list, adding any new sessions
      const isPartial = cachedSessions && cachedSessionsLastModified
        && total !== undefined && sessions.length < total;

      if (isPartial) {
        const updatedById = new Map<string, Session>();
        for (const s of sessions) updatedById.set(s.sessionId || s.id, mapSession(s));

        // Update existing cached sessions
        mapped = cachedSessions.map(cached =>
          updatedById.get(cached.sessionId) || cached
        );
        // Add any new sessions not in cache
        for (const [id, session] of updatedById) {
          if (!cachedSessions.some(c => c.sessionId === id)) {
            mapped.push(session);
          }
        }
      } else {
        // Full response (first fetch or all sessions returned)
        mapped = sessions.map(mapSession);
      }

      // Update cache for next call
      cachedSessions = mapped;
      cachedSessionsLastModified = result.lastModified || null;

      return mapped;
    },

    async getSessionDetail(sessionId: string): Promise<SessionDetail> {
      return fetchJson<SessionDetail>(api(`/sessions/${sessionId}`));
    },

    async getSessionConversation(sessionId, opts): Promise<SessionDetail> {
      // Use /sessions/:id endpoint (pre-parsed arrays) like admin-web,
      // then transform into flat SessionMessage[] for components
      const params = new URLSearchParams();
      if (opts.lastN) params.set('lastNUserPrompts', String(opts.lastN));
      if (opts.fromLine) params.set('fromLineIndex', String(opts.fromLine));
      params.set('includeRawMessages', 'true');
      const qs = params.toString();
      const raw = await fetchJson<any>(api(`/sessions/${sessionId}${qs ? '?' + qs : ''}`));
      return transformSessionResponse(raw, sessionId);
    },

    async checkSessionUpdate(sessionId): Promise<{ exists: boolean; lineCount: number; agentIds?: string[]; lastModified?: string }> {
      try {
        const result = await fetchJson<any>(api(`/sessions/${sessionId}/has-update`));
        return {
          exists: result.exists ?? true,
          lineCount: result.lineCount || 0,
          agentIds: result.agentIds,
          lastModified: result.lastModified,
        };
      } catch {
        return { exists: false, lineCount: 0 };
      }
    },

    async batchCheckSessions(request: BatchCheckRequest): Promise<BatchCheckResponse> {
      try {
        return await fetchJson<BatchCheckResponse>(api('/sessions/batch-check'), {
          method: 'POST',
          body: JSON.stringify(request),
        });
      } catch {
        return { sessions: {} };
      }
    },

    async getProjects(): Promise<Project[]> {
      const result = await fetchJson<any>(api('/projects'));
      const projects: any[] = Array.isArray(result) ? result : result.projects || [];
      return projects.map(p => ({
        projectPath: p.projectPath || p.path,
        projectName: extractProjectName(p.projectPath || p.path),
        machineId: 'localhost',
        machineHostname: 'localhost',
        machinePlatform: 'linux',
        machineStatus: 'online',
        sessionCount: p.sessionCount || 0,
        runningSessionCount: p.runningSessionCount || 0,
        activeTerminalCount: 0,
        totalCost: p.totalCost || 0,
        lastActivity: p.lastActivity || p.lastModified,
        storageSize: p.storageSize || 0,
        lastUserMessage: p.lastUserMessage || undefined,
        hasClaudeMd: p.hasClaudeMd || false,
        isGitProject: p.isGitProject ?? true,
      }));
    },

    async getTaskLists(): Promise<TaskList[]> {
      const result = await fetchJson<any>(api('/tasks'));
      return Array.isArray(result) ? result : result.taskLists || result.tasks || [];
    },

    async getTaskStoreAll(): Promise<{ tasks: import('./types').SessionTask[] }> {
      try {
        const result = await fetchJson<any>(api('/tasks/all'));
        return { tasks: Array.isArray(result) ? result : result.tasks || [] };
      } catch {
        // Fall back to /task-store/tasks
        try {
          const result = await fetchJson<any>(api('/task-store/tasks'));
          const tasks = Array.isArray(result) ? result : result.tasks || [];
          if (tasks.length > 0) return { tasks };
        } catch { /* continue to next fallback */ }
        return { tasks: [] };
      }
    },

    async startTerminal(sessionId, projectPath, _machineId?, options?): Promise<{ consoleUrl: string }> {
      // In proxy mode, use hub's console start endpoint (returns iframe URL with token)
      const hubPath = hubApi(`/machines/${proxyInfo?.machineId}/console/${sessionId}/start`);
      if (proxyInfo?.isProxied && hubPath) {
        // Use fetchJsonRaw to avoid unwrapping the hub's { data: {} } field
        // which would lose the top-level consoleUrl
        const result = await fetchJsonRaw<any>(hubPath, {
          method: 'POST',
          body: JSON.stringify({ projectPath, force: true, ...options }),
        });
        // Hub returns { success: true, consoleUrl: "http://localhost:8081/...", data: {} }
        const rawUrl = result?.consoleUrl || result?.data?.url || result?.url;
        // normalizeConsoleUrl strips to /api/tier-agent/... relative path.
        // DON'T prepend basePath — the ttyd iframe must load directly through
        // the /api/tier-agent/ path (handled by Next.js rewrite → gateway),
        // not through the web-proxy which can't relay WebSocket upgrades.
        const consoleUrl = normalizeConsoleUrl(rawUrl);
        return { consoleUrl };
      }

      // Local mode: call machine's ttyd endpoint directly
      const result = await fetchJson<any>(api(`/ttyd/session/${sessionId}/start`), {
        method: 'POST',
        body: JSON.stringify({ projectPath, directMode: false, resume: true, force: true, ...options }),
      });
      const url = result?.data?.url || result?.url;
      return { consoleUrl: resolveConsoleUrl(url) };
    },

    async startAllTerminals(_machineId?) {
      // In proxy mode, use hub's bulk console start endpoint
      const hubPath = hubApi(`/machines/${proxyInfo?.machineId}/console/start-all`);
      if (proxyInfo?.isProxied && hubPath) {
        const result = await fetchJsonRaw<any>(hubPath, { method: 'POST' });
        const results = (result?.results || []).map((r: any) => ({
          ...r,
          consoleUrl: r.consoleUrl ? normalizeConsoleUrl(r.consoleUrl) : undefined,
        }));
        return {
          results,
          summary: result?.summary || { total: 0, started: 0, alreadyRunning: 0, failed: 0 },
        };
      }

      // Local mode: call tier-agent directly
      const result = await fetchJsonRaw<any>(api('/ttyd/start-all'), { method: 'POST' });
      const data = result?.data || result;
      const results = (data?.results || []).map((r: any) => ({
        sessionId: r.sessionId,
        consoleUrl: r.url ? resolveConsoleUrl(r.url) : undefined,
        port: r.port,
        alreadyRunning: r.alreadyRunning,
        error: r.error,
      }));
      return {
        results,
        summary: data?.summary || { total: 0, started: 0, alreadyRunning: 0, failed: 0 },
      };
    },

    async stopTerminal(sessionId): Promise<void> {
      // In proxy mode, use hub's console stop endpoint
      const hubPath = hubApi(`/machines/${proxyInfo?.machineId}/console/${sessionId}/stop`);
      if (proxyInfo?.isProxied && hubPath) {
        await fetchJson<any>(hubPath, { method: 'POST' });
        return;
      }

      // Local mode
      await fetchJson<any>(api(`/ttyd/session/${sessionId}/stop`), { method: 'POST' });
    },

    async startShellTerminal(projectPath, _machineId?): Promise<{ consoleUrl: string }> {
      const result = await fetchJson<any>(api('/ttyd/shell/start'), {
        method: 'POST',
        body: JSON.stringify({ projectPath }),
      });
      const url = result?.data?.url || result?.url;
      return { consoleUrl: resolveConsoleUrl(url) };
    },

    async getShellConfig(_machineId?): Promise<{ shell: string }> {
      const result = await fetchJson<any>(api('/shell/config'));
      return { shell: result?.data?.shell || result?.shell || '/bin/bash' };
    },

    async updateShellConfig(shell, _machineId?): Promise<void> {
      await fetchJson<any>(api('/shell/config'), {
        method: 'PUT',
        body: JSON.stringify({ shell }),
      });
    },

    async killSessionProcesses(sessionId): Promise<{ success: boolean; killed: number[]; errors: string[] }> {
      try {
        const result = await fetchJson<any>(api(`/ttyd/session/${sessionId}/kill`), { method: 'POST' });
        return {
          success: result.success ?? true,
          killed: result.killed || result.data?.killed || [],
          errors: result.errors || result.data?.errors || [],
        };
      } catch {
        return { success: false, killed: [], errors: ['Request failed'] };
      }
    },

    async killProcess(pid: number): Promise<{ success: boolean }> {
      try {
        const result = await fetchJson<any>(api(`/ttyd/process/${pid}/kill`), { method: 'POST' });
        return { success: result.success ?? true };
      } catch {
        return { success: false };
      }
    },

    async identifyProcesses(pids: number[]): Promise<{ processes: IdentifiedProcess[] }> {
      try {
        const result = await fetchJson<any>(api('/ttyd/process/identify'), {
          method: 'POST',
          body: JSON.stringify({ pids }),
        });
        const data = result.data || result;
        return { processes: data.processes || [] };
      } catch {
        return { processes: [] };
      }
    },

    async getTerminalStatus(): Promise<{ active: boolean; url?: string; sessions?: string[]; managed?: any[] }> {
      try {
        const result = await fetchJson<any>(api('/ttyd/processes'));
        const data = result.data || result;
        const managed: any[] = data.managed || [];
        const allProcesses: any[] = data.allClaudeProcesses || [];

        // Collect session IDs from managed and all running Claude processes
        const sessionIds = new Set<string>();
        for (const p of managed) {
          if (p.sessionId) sessionIds.add(p.sessionId);
        }
        for (const p of allProcesses) {
          if (p.sessionId && p.sessionId !== 'unknown' && p.sessionId !== 'chrome-session') {
            sessionIds.add(p.sessionId);
          }
        }

        if (sessionIds.size > 0) {
          return {
            active: true,
            sessions: Array.from(sessionIds),
            managed,
          };
        }
        return { active: false };
      } catch {
        return { active: false };
      }
    },

    async getSessionSubagents(sessionId) {
      try {
        const result = await fetchJson<any>(api(`/sessions/${sessionId}/subagents`));
        return {
          invocations: result.invocations || [],
          sessions: (result.sessions || []).map(mapSubagentSession),
        };
      } catch {
        return { invocations: [], sessions: [] };
      }
    },

    async getMilestones(sessionId): Promise<{ milestones: Milestone[]; phase: number | null }> {
      try {
        return await fetchJson<{ milestones: Milestone[]; phase: number | null }>(api(`/milestones/${sessionId}`));
      } catch {
        return { milestones: [], phase: null };
      }
    },

    async getProjectArchitecture(projectPath?) {
      try {
        const qs = projectPath ? `?project=${encodeURIComponent(projectPath)}` : '';
        return await fetchJson<ProjectArchitecture>(api(`/architecture${qs}`));
      } catch {
        return null;
      }
    },

    async getArchitectureModel(projectPath?) {
      try {
        const qs = projectPath ? `?project=${encodeURIComponent(projectPath)}` : '';
        const resp = await fetchJson<{ model: import('./types').ArchitectureModel; stale: boolean; generatedAt: number; sessionId?: string } | null>(api(`/architecture/model${qs}`));
        return resp;
      } catch {
        return null;
      }
    },

    async generateArchitectureModel(projectPath?, _machineId?, model?) {
      try {
        const qs = projectPath ? `?project=${encodeURIComponent(projectPath)}` : '';
        const body = model ? { model } : {};
        const resp = await fetch(api(`/architecture/generate${qs}`), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!resp.ok) return null;
        const json = await resp.json();
        // Route returns { success, data: { model, generatedAt, sessionId } }
        const inner = json?.data;
        if (!inner?.model) return null;
        return { model: inner.model, generatedAt: inner.generatedAt, sessionId: inner.sessionId };
      } catch {
        return null;
      }
    },

    async getIndexedSession(sessionId): Promise<IndexedSessionResult | null> {
      try {
        return await fetchJson<IndexedSessionResult>(api(`/session-index/sessions/${sessionId}`));
      } catch {
        return null;
      }
    },

    async getRunningProcesses(): Promise<RunningProcessesResponse> {
      try {
        const result = await fetchJson<any>(api('/ttyd/processes'));
        const data = result.data || result;
        return {
          managed: data.managed || [],
          allClaudeProcesses: data.allClaudeProcesses || [],
          summary: data.summary || { totalManaged: 0, totalClaude: 0, unmanagedCount: 0, byCategory: {} },
          systemStats: data.systemStats,
          hash: result.hash,
        };
      } catch {
        return { managed: [], allClaudeProcesses: [], summary: { totalManaged: 0, totalClaude: 0, unmanagedCount: 0, byCategory: {} } };
      }
    },

    async checkRunningProcesses(knownHash: string) {
      try {
        const result = await fetchJson<any>(api(`/ttyd/processes?hash=${knownHash}`));
        if (result.unchanged) {
          return { changed: false, hash: knownHash };
        }
        const data = result.data || result;
        return {
          changed: true,
          hash: result.hash || '',
          data: {
            managed: data.managed || [],
            allClaudeProcesses: data.allClaudeProcesses || [],
            summary: data.summary || { totalManaged: 0, totalClaude: 0, unmanagedCount: 0, byCategory: {} },
            systemStats: data.systemStats,
            hash: result.hash,
          },
        };
      } catch {
        return { changed: true, hash: '' }; // on error, force full fetch next time
      }
    },

    async getPlanFileContent(planFile): Promise<string | null> {
      try {
        const result = await fetchJson<any>(api(`/plans/${encodeURIComponent(planFile)}`));
        return result?.data?.content || result?.content || null;
      } catch {
        return null;
      }
    },

    async searchSessions(query, opts) {
      return fetchJson(api('/session-search'), {
        method: 'POST',
        body: JSON.stringify({ query, ...opts }),
      });
    },

    async searchSessionsAi(query, opts) {
      return fetchJson(api('/session-search/ai'), {
        method: 'POST',
        body: JSON.stringify({ query, ...opts }),
      });
    },

    async getAiSearchJob(jobId) {
      return fetchJson(api(`/session-search/ai/${jobId}`));
    },

    async getRecentMilestones(_machineId?, opts?) {
      const params = new URLSearchParams();
      if (opts?.projectPath) params.set('projectPath', opts.projectPath);
      if (opts?.directory) params.set('directory', opts.directory);
      const qs = params.toString();
      const res = await fetchJson<any>(api(`/session-search/recent${qs ? '?' + qs : ''}`));
      return res?.data || res;
    },

    async fetchPath(path, opts) {
      const options: RequestInit = {};
      if (opts?.method) options.method = opts.method;
      if (opts?.body) options.body = JSON.stringify(opts.body);
      return fetchJson(api(path), options);
    },
  };
}

// ============================================
// Hub API Client
// HTTP via LangMart hub relay to remote machines
// ============================================

export function createHubClient(hubBaseUrl: string, apiKey?: string): ApiClient {
  const api = (path: string) => `${hubBaseUrl}${path}`;
  const machineApi = (machineId: string, path: string) =>
    `${hubBaseUrl}/api/tier-agent/machines/${machineId}${path}`;

  // Auth headers for hub API calls (needed when calling from localhost in hybrid mode)
  const authHeaders: Record<string, string> = apiKey
    ? { 'Authorization': `Bearer ${apiKey}` }
    : {};

  // Wrap fetchJson/fetchJsonRaw to inject auth headers
  function hubFetch<T>(url: string, options?: RequestInit): Promise<T> {
    return fetchJson<T>(url, {
      ...options,
      headers: { ...authHeaders, ...options?.headers },
    });
  }
  function hubFetchRaw<T>(url: string, options?: RequestInit): Promise<T> {
    return fetchJsonRaw<T>(url, {
      ...options,
      headers: { ...authHeaders, ...options?.headers },
    });
  }

  return {
    mode: 'hub',

    async getMachines(): Promise<Machine[]> {
      const result = await hubFetch<any>(api('/api/tier-agent/machines'));
      const machines: any[] = Array.isArray(result) ? result : result.machines || [];
      return machines.map(w => ({
        id: w.gatewayId || w.id,
        hostname: w.hostname || w.name,
        platform: w.platform || 'linux',
        status: w.status === 'online' || w.connected ? 'online' : 'offline',
        lastHeartbeat: w.lastHeartbeat,
        connectedAt: w.connectedAt,
        gatewayId: w.gatewayId,
        osVersion: w.osVersion,
      }));
    },

    async getSessions(machineId?: string): Promise<Session[]> {
      if (!machineId) throw new Error('Hub mode requires machineId');
      const machine = { id: machineId, hostname: machineId, platform: 'linux', status: 'online' as const };
      // Try to get machine info
      try {
        const machines = await this.getMachines();
        const m = machines.find(m => m.id === machineId);
        if (m) Object.assign(machine, m);
      } catch { /* use defaults */ }

      const result = await hubFetch<any>(machineApi(machineId, '/sessions'));
      const sessions: any[] = Array.isArray(result) ? result : result.sessions || [];
      return sessions.map(s => ({
        sessionId: s.sessionId || s.id,
        projectPath: s.projectPath || '',
        projectName: extractProjectName(s.projectPath),
        model: s.model,
        lastModified: s.lastModified || s.updatedAt,
        size: s.size,
        messageCount: s.messageCount,
        summary: s.summary,
        isRunning: s.isRunning || !!s.running,
        isPaused: s.isPaused,
        totalCostUsd: s.totalCostUsd || s.cost,
        numTurns: s.numTurns || s.turns,
        agentCount: s.agentCount,
        userPromptCount: s.userPromptCount,
        taskCount: s.taskCount,
        lastUserMessage: s.lastUserMessage,
        running: s.running || undefined,
        machineId: machine.id,
        machineHostname: machine.hostname,
        machinePlatform: machine.platform,
        machineStatus: machine.status,
      }));
    },

    async getSessionDetail(sessionId, machineId): Promise<SessionDetail> {
      if (!machineId) throw new Error('Hub mode requires machineId');
      return hubFetch<SessionDetail>(machineApi(machineId, `/sessions/${sessionId}`));
    },

    async getSessionConversation(sessionId, opts, machineId): Promise<SessionDetail> {
      if (!machineId) throw new Error('Hub mode requires machineId');
      const params = new URLSearchParams();
      if (opts.lastN) params.set('lastNUserPrompts', String(opts.lastN));
      if (opts.fromLine) params.set('fromLineIndex', String(opts.fromLine));
      params.set('includeRawMessages', 'true');
      const qs = params.toString();
      const raw = await hubFetch<any>(
        machineApi(machineId, `/sessions/${sessionId}${qs ? '?' + qs : ''}`)
      );
      return transformSessionResponse(raw, sessionId);
    },

    async checkSessionUpdate(sessionId, machineId) {
      if (!machineId) throw new Error('Hub mode requires machineId');
      try {
        const result = await hubFetch<any>(machineApi(machineId, `/sessions/${sessionId}/has-update`));
        return {
          exists: result.exists ?? true,
          lineCount: result.lineCount || 0,
          agentIds: result.agentIds,
          lastModified: result.lastModified,
        };
      } catch {
        return { exists: false, lineCount: 0 };
      }
    },

    async batchCheckSessions(request: BatchCheckRequest, machineId?: string): Promise<BatchCheckResponse> {
      if (!machineId) throw new Error('Hub mode requires machineId');
      try {
        // Use GET with query params to avoid Next.js rewrite stripping POST body (NEXT-1104)
        const params = new URLSearchParams();
        if (request.listCheck?.projectPath) {
          params.set('listCheck.projectPath', request.listCheck.projectPath);
        }
        if (request.listCheck?.since) {
          params.set('listCheck.since', request.listCheck.since);
        }
        if (request.sessions) {
          params.set('sessions', JSON.stringify(request.sessions));
        }
        const sep = '?';
        return await hubFetch<BatchCheckResponse>(machineApi(machineId, `/sessions/batch-check${sep}${params.toString()}`));
      } catch {
        return { sessions: {} };
      }
    },

    async getProjects(machineId): Promise<Project[]> {
      if (!machineId) throw new Error('Hub mode requires machineId');
      const machine = { id: machineId, hostname: machineId, platform: 'linux', status: 'online' as const };
      try {
        const machines = await this.getMachines();
        const m = machines.find(m => m.id === machineId);
        if (m) Object.assign(machine, m);
      } catch { /* use defaults */ }

      const result = await hubFetch<any>(machineApi(machineId, '/projects'));
      const projects: any[] = Array.isArray(result) ? result : result.projects || [];
      return projects.map(p => ({
        projectPath: p.projectPath || p.path,
        projectName: extractProjectName(p.projectPath || p.path),
        machineId: machine.id,
        machineHostname: machine.hostname,
        machinePlatform: machine.platform,
        machineStatus: machine.status,
        sessionCount: p.sessionCount || 0,
        runningSessionCount: p.runningSessionCount || 0,
        activeTerminalCount: 0,
        totalCost: p.totalCost || 0,
        lastActivity: p.lastActivity || p.lastModified,
        isGitProject: p.isGitProject ?? true,
      }));
    },

    async getTaskLists(machineId): Promise<TaskList[]> {
      if (!machineId) throw new Error('Hub mode requires machineId');
      const result = await hubFetch<any>(machineApi(machineId, '/tasks'));
      return Array.isArray(result) ? result : result.taskLists || result.tasks || [];
    },

    async getTaskStoreAll(machineId) {
      if (!machineId) throw new Error('Hub mode requires machineId');
      try {
        const result = await hubFetch<any>(machineApi(machineId, '/tasks/all'));
        return { tasks: Array.isArray(result) ? result : result.tasks || [] };
      } catch {
        // Fall back to /task-store/tasks
        try {
          const result = await hubFetch<any>(machineApi(machineId, '/task-store/tasks'));
          const tasks = Array.isArray(result) ? result : result.tasks || [];
          if (tasks.length > 0) return { tasks };
        } catch { /* continue to next fallback */ }
        return { tasks: [] };
      }
    },

    async startTerminal(sessionId, projectPath, machineId, options?): Promise<{ consoleUrl: string }> {
      if (!machineId) throw new Error('Hub mode requires machineId');
      // Use hubFetchRaw to avoid unwrapping the hub's { data: {} } field
      // which would lose the top-level consoleUrl
      const result = await hubFetchRaw<any>(
        `${hubBaseUrl}/api/tier-agent/machines/${machineId}/console/${sessionId}/start`,
        {
          method: 'POST',
          body: JSON.stringify({ projectPath, force: true, ...options }),
        },
      );
      // Hub returns { success: true, consoleUrl: "http://localhost:8081/...", data: {} }
      const rawUrl = result?.consoleUrl || result?.data?.url || result?.url;
      return { consoleUrl: normalizeConsoleUrl(rawUrl) };
    },

    async startAllTerminals(machineId?) {
      if (!machineId) throw new Error('Hub mode requires machineId');
      const result = await hubFetchRaw<any>(
        `${hubBaseUrl}/api/tier-agent/machines/${machineId}/console/start-all`,
        { method: 'POST' },
      );
      const results = (result?.results || []).map((r: any) => ({
        ...r,
        consoleUrl: r.consoleUrl ? normalizeConsoleUrl(r.consoleUrl) : undefined,
      }));
      return {
        results,
        summary: result?.summary || { total: 0, started: 0, alreadyRunning: 0, failed: 0 },
      };
    },

    async stopTerminal(sessionId, machineId): Promise<void> {
      if (!machineId) throw new Error('Hub mode requires machineId');
      await hubFetch<any>(
        `${hubBaseUrl}/api/tier-agent/machines/${machineId}/console/${sessionId}/stop`,
        { method: 'POST' },
      );
    },

    async startShellTerminal(projectPath, machineId?): Promise<{ consoleUrl: string }> {
      if (!machineId) throw new Error('Hub mode requires machineId');
      const result = await hubFetchRaw<any>(
        `${hubBaseUrl}/api/tier-agent/machines/${machineId}/ttyd/shell/start`,
        {
          method: 'POST',
          body: JSON.stringify({ projectPath }),
        },
      );
      const rawUrl = result?.consoleUrl || result?.data?.url || result?.url;
      return { consoleUrl: normalizeConsoleUrl(rawUrl) };
    },

    async getShellConfig(machineId?): Promise<{ shell: string }> {
      if (!machineId) throw new Error('Hub mode requires machineId');
      const result = await hubFetch<any>(machineApi(machineId, '/shell/config'));
      return { shell: result?.data?.shell || result?.shell || '/bin/bash' };
    },

    async updateShellConfig(shell, machineId?): Promise<void> {
      if (!machineId) throw new Error('Hub mode requires machineId');
      await hubFetch<any>(machineApi(machineId, '/shell/config'), {
        method: 'PUT',
        body: JSON.stringify({ shell }),
      });
    },

    async killSessionProcesses(sessionId, machineId): Promise<{ success: boolean; killed: number[]; errors: string[] }> {
      if (!machineId) throw new Error('Hub mode requires machineId');
      try {
        const result = await hubFetch<any>(machineApi(machineId, `/ttyd/session/${sessionId}/kill`), { method: 'POST' });
        return {
          success: result.success ?? true,
          killed: result.killed || result.data?.killed || [],
          errors: result.errors || result.data?.errors || [],
        };
      } catch {
        return { success: false, killed: [], errors: ['Request failed'] };
      }
    },

    async killProcess(pid: number, machineId?: string): Promise<{ success: boolean }> {
      if (!machineId) throw new Error('Hub mode requires machineId');
      try {
        const result = await hubFetch<any>(machineApi(machineId, `/ttyd/process/${pid}/kill`), { method: 'POST' });
        return { success: result.success ?? true };
      } catch {
        return { success: false };
      }
    },

    async identifyProcesses(pids: number[], machineId?: string): Promise<{ processes: IdentifiedProcess[] }> {
      if (!machineId) throw new Error('Hub mode requires machineId');
      try {
        const result = await hubFetch<any>(machineApi(machineId, '/ttyd/process/identify'), {
          method: 'POST',
          body: JSON.stringify({ pids }),
        });
        const data = result.data || result;
        return { processes: data.processes || [] };
      } catch {
        return { processes: [] };
      }
    },

    async getTerminalStatus(machineId) {
      if (!machineId) throw new Error('Hub mode requires machineId');
      try {
        const result = await hubFetch<any>(machineApi(machineId, '/ttyd/processes'));
        const data = result.data || result;
        const managed: any[] = data.managed || [];
        const allProcesses: any[] = data.allClaudeProcesses || [];

        const sessionIds = new Set<string>();
        for (const p of managed) {
          if (p.sessionId) sessionIds.add(p.sessionId);
        }
        for (const p of allProcesses) {
          if (p.sessionId && p.sessionId !== 'unknown' && p.sessionId !== 'chrome-session') {
            sessionIds.add(p.sessionId);
          }
        }

        if (sessionIds.size > 0) {
          return {
            active: true,
            sessions: Array.from(sessionIds),
            managed,
          };
        }
        return { active: false };
      } catch {
        return { active: false };
      }
    },

    async getSessionSubagents(sessionId, machineId) {
      if (!machineId) throw new Error('Hub mode requires machineId');
      try {
        const result = await hubFetch<any>(machineApi(machineId, `/sessions/${sessionId}/subagents`));
        return {
          invocations: result.invocations || [],
          sessions: (result.sessions || []).map(mapSubagentSession),
        };
      } catch {
        return { invocations: [], sessions: [] };
      }
    },

    async getMilestones(sessionId, machineId) {
      if (!machineId) throw new Error('Hub mode requires machineId');
      try {
        return await hubFetch<{ milestones: Milestone[]; phase: number | null }>(
          machineApi(machineId, `/milestones/${sessionId}`)
        );
      } catch {
        return { milestones: [], phase: null };
      }
    },

    async getProjectArchitecture(projectPath?, machineId?) {
      if (!machineId) throw new Error('Hub mode requires machineId');
      try {
        const qs = projectPath ? `?project=${encodeURIComponent(projectPath)}` : '';
        return await hubFetch<ProjectArchitecture>(machineApi(machineId, `/architecture${qs}`));
      } catch {
        return null;
      }
    },

    async getArchitectureModel(projectPath?, machineId?) {
      if (!machineId) throw new Error('Hub mode requires machineId');
      try {
        const qs = projectPath ? `?project=${encodeURIComponent(projectPath)}` : '';
        return await hubFetch<import('./types').ArchitectureModelResponse | null>(machineApi(machineId, `/architecture/model${qs}`));
      } catch {
        return null;
      }
    },

    async generateArchitectureModel(projectPath?, machineId?, model?) {
      if (!machineId) throw new Error('Hub mode requires machineId');
      try {
        const qs = projectPath ? `?project=${encodeURIComponent(projectPath)}` : '';
        const body = model ? { model } : {};
        // hubFetch auto-unwraps { data: { model, generatedAt, sessionId } }
        const result = await hubFetch<{ model: any; generatedAt: number; sessionId?: string }>(machineApi(machineId, `/architecture/generate${qs}`), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!result?.model) return null;
        return { model: result.model, generatedAt: result.generatedAt, sessionId: result.sessionId };
      } catch {
        return null;
      }
    },

    async getIndexedSession(sessionId, machineId) {
      if (!machineId) throw new Error('Hub mode requires machineId');
      try {
        return await hubFetch<IndexedSessionResult>(
          machineApi(machineId, `/session-index/sessions/${sessionId}`)
        );
      } catch {
        return null;
      }
    },

    async getRunningProcesses(machineId): Promise<RunningProcessesResponse> {
      if (!machineId) throw new Error('Hub mode requires machineId');
      try {
        const result = await hubFetch<any>(machineApi(machineId, '/ttyd/processes'));
        const data = result.data || result;
        return {
          managed: data.managed || [],
          allClaudeProcesses: data.allClaudeProcesses || [],
          summary: data.summary || { totalManaged: 0, totalClaude: 0, unmanagedCount: 0, byCategory: {} },
          systemStats: data.systemStats,
          hash: result.hash,
        };
      } catch {
        return { managed: [], allClaudeProcesses: [], summary: { totalManaged: 0, totalClaude: 0, unmanagedCount: 0, byCategory: {} } };
      }
    },

    async checkRunningProcesses(knownHash: string, machineId?: string) {
      if (!machineId) throw new Error('Hub mode requires machineId');
      try {
        const result = await hubFetch<any>(machineApi(machineId, `/ttyd/processes?hash=${knownHash}`));
        if (result.unchanged) {
          return { changed: false, hash: knownHash };
        }
        const data = result.data || result;
        return {
          changed: true,
          hash: result.hash || '',
          data: {
            managed: data.managed || [],
            allClaudeProcesses: data.allClaudeProcesses || [],
            summary: data.summary || { totalManaged: 0, totalClaude: 0, unmanagedCount: 0, byCategory: {} },
            systemStats: data.systemStats,
            hash: result.hash,
          },
        };
      } catch {
        return { changed: true, hash: '' };
      }
    },

    async getPlanFileContent(planFile, machineId) {
      if (!machineId) throw new Error('Hub mode requires machineId');
      try {
        const result = await hubFetch<any>(
          machineApi(machineId, `/plans/${encodeURIComponent(planFile)}`)
        );
        return result?.data?.content || result?.content || null;
      } catch {
        return null;
      }
    },

    async searchSessions(query, opts, machineId) {
      if (!machineId) throw new Error('Hub mode requires machineId');
      return hubFetch(machineApi(machineId, '/session-search'), {
        method: 'POST',
        body: JSON.stringify({ query, ...opts }),
      });
    },

    async searchSessionsAi(query, opts, machineId) {
      if (!machineId) throw new Error('Hub mode requires machineId');
      return hubFetch(machineApi(machineId, '/session-search/ai'), {
        method: 'POST',
        body: JSON.stringify({ query, ...opts }),
      });
    },

    async getAiSearchJob(jobId, machineId) {
      if (!machineId) throw new Error('Hub mode requires machineId');
      return hubFetch(machineApi(machineId, `/session-search/ai/${jobId}`));
    },

    async getRecentMilestones(machineId, opts?) {
      if (!machineId) throw new Error('Hub mode requires machineId');
      const params = new URLSearchParams();
      if (opts?.projectPath) params.set('projectPath', opts.projectPath);
      if (opts?.directory) params.set('directory', opts.directory);
      const qs = params.toString();
      return hubFetch(machineApi(machineId, `/session-search/recent${qs ? '?' + qs : ''}`)) as any;
    },

    async fetchPath(path, opts) {
      const machineId = opts?.machineId;
      if (!machineId) throw new Error('Hub mode requires machineId');
      const options: RequestInit = {};
      if (opts?.method) options.method = opts.method;
      if (opts?.body) options.body = JSON.stringify(opts.body);
      return hubFetch(machineApi(machineId, path), options);
    },
  };
}

// ============================================
// Hybrid API Client
// Local + Hub combined: local API for own data, hub API for remote machines
// ============================================

export interface HybridClientOptions {
  /** Base URL for local tier-agent API (e.g., http://localhost:3100) */
  localBaseUrl: string;
  /** Base URL for hub API (e.g., http://localhost:8081 or https://api.langmart.ai) */
  hubBaseUrl: string;
  /** Gateway ID of the local machine (from hub registration) */
  localGatewayId: string;
  /** API key for authenticating hub API calls */
  apiKey?: string;
}

export function createHybridClient(options: HybridClientOptions): ApiClient {
  const { localBaseUrl, hubBaseUrl, localGatewayId, apiKey } = options;
  const localClient = createLocalClient(localBaseUrl);
  const hubClient = createHubClient(hubBaseUrl, apiKey);

  /**
   * Determine if a machineId refers to the local machine.
   * Returns true when:
   * - machineId is undefined/null (default to local)
   * - machineId is 'localhost' (local client convention)
   * - machineId matches the local gateway ID
   */
  function isLocal(machineId?: string): boolean {
    if (!machineId) return true;
    if (machineId === 'localhost') return true;
    return machineId === localGatewayId;
  }

  return {
    mode: 'hybrid',

    async getMachines(): Promise<Machine[]> {
      // Fetch both local machine info and hub machine list in parallel
      const [localMachines, hubMachines] = await Promise.allSettled([
        localClient.getMachines(),
        hubClient.getMachines(),
      ]);

      const local = localMachines.status === 'fulfilled' ? localMachines.value : [];
      const hub = hubMachines.status === 'fulfilled' ? hubMachines.value : [];

      // Build result: use hub list as base (includes all machines)
      // but replace the local machine entry with enriched local data
      if (hub.length === 0) {
        // Hub not reachable — fall back to local only
        return local;
      }

      const result: Machine[] = [];
      let localFound = false;

      for (const w of hub) {
        if (w.id === localGatewayId || w.gatewayId === localGatewayId) {
          // This is the local machine — merge with local health data
          const localInfo = local[0];
          result.push({
            ...w,
            id: w.id || localGatewayId,
            hostname: localInfo?.hostname || w.hostname,
            platform: localInfo?.platform || w.platform,
            status: 'online', // We know it's online since we can reach it directly
            isLocal: true,
          } as Machine & { isLocal?: boolean });
          localFound = true;
        } else {
          result.push(w);
        }
      }

      // If local machine wasn't in hub list (e.g., just connected), add it
      if (!localFound && local.length > 0) {
        result.unshift({
          ...local[0],
          id: localGatewayId,
          isLocal: true,
        } as Machine & { isLocal?: boolean });
      }

      return result;
    },

    async getSessions(machineId?: string): Promise<Session[]> {
      if (isLocal(machineId)) {
        // Use fast local API — sessions come with machineId = local gatewayId
        const sessions = await localClient.getSessions();
        // Stamp sessions with the gateway ID so they can be matched to the correct machine
        return sessions.map(s => ({
          ...s,
          machineId: localGatewayId,
        }));
      }
      return hubClient.getSessions(machineId);
    },

    async getSessionDetail(sessionId, machineId): Promise<SessionDetail> {
      if (isLocal(machineId)) {
        return localClient.getSessionDetail(sessionId);
      }
      return hubClient.getSessionDetail(sessionId, machineId);
    },

    async getSessionConversation(sessionId, opts, machineId): Promise<SessionDetail> {
      if (isLocal(machineId)) {
        return localClient.getSessionConversation(sessionId, opts);
      }
      return hubClient.getSessionConversation(sessionId, opts, machineId);
    },

    async checkSessionUpdate(sessionId, machineId) {
      if (isLocal(machineId)) {
        return localClient.checkSessionUpdate(sessionId);
      }
      return hubClient.checkSessionUpdate(sessionId, machineId);
    },

    async batchCheckSessions(request, machineId) {
      if (isLocal(machineId)) {
        return localClient.batchCheckSessions(request);
      }
      return hubClient.batchCheckSessions(request, machineId);
    },

    async getProjects(machineId): Promise<Project[]> {
      if (isLocal(machineId)) {
        const projects = await localClient.getProjects();
        return projects.map(p => ({ ...p, machineId: localGatewayId }));
      }
      return hubClient.getProjects(machineId);
    },

    async getTaskLists(machineId): Promise<TaskList[]> {
      if (isLocal(machineId)) {
        return localClient.getTaskLists();
      }
      return hubClient.getTaskLists(machineId);
    },

    async getTaskStoreAll(machineId) {
      if (isLocal(machineId)) {
        return localClient.getTaskStoreAll();
      }
      return hubClient.getTaskStoreAll(machineId);
    },

    async startTerminal(sessionId, projectPath, machineId, options?): Promise<{ consoleUrl: string }> {
      if (isLocal(machineId)) {
        // Direct local ttyd — fast, no hub relay needed
        return localClient.startTerminal(sessionId, projectPath, undefined, options);
      }
      // Remote machine — go through hub relay
      return hubClient.startTerminal(sessionId, projectPath, machineId, options);
    },

    async startAllTerminals(machineId?) {
      if (isLocal(machineId)) {
        return localClient.startAllTerminals();
      }
      return hubClient.startAllTerminals(machineId);
    },

    async stopTerminal(sessionId, machineId): Promise<void> {
      if (isLocal(machineId)) {
        return localClient.stopTerminal(sessionId);
      }
      return hubClient.stopTerminal(sessionId, machineId);
    },

    async killSessionProcesses(sessionId, machineId) {
      if (isLocal(machineId)) {
        return localClient.killSessionProcesses(sessionId);
      }
      return hubClient.killSessionProcesses(sessionId, machineId);
    },

    async killProcess(pid: number, machineId?: string) {
      if (isLocal(machineId)) {
        return localClient.killProcess(pid);
      }
      return hubClient.killProcess(pid, machineId);
    },

    async identifyProcesses(pids: number[], machineId?: string) {
      if (isLocal(machineId)) {
        return localClient.identifyProcesses(pids);
      }
      return hubClient.identifyProcesses(pids, machineId);
    },

    async getTerminalStatus(machineId) {
      if (isLocal(machineId)) {
        return localClient.getTerminalStatus();
      }
      return hubClient.getTerminalStatus(machineId);
    },

    async startShellTerminal(projectPath, machineId?) {
      if (isLocal(machineId)) {
        return localClient.startShellTerminal(projectPath);
      }
      return hubClient.startShellTerminal(projectPath, machineId);
    },

    async getShellConfig(machineId?) {
      if (isLocal(machineId)) {
        return localClient.getShellConfig();
      }
      return hubClient.getShellConfig(machineId);
    },

    async updateShellConfig(shell, machineId?) {
      if (isLocal(machineId)) {
        return localClient.updateShellConfig(shell);
      }
      return hubClient.updateShellConfig(shell, machineId);
    },

    async getSessionSubagents(sessionId, machineId) {
      if (isLocal(machineId)) {
        return localClient.getSessionSubagents(sessionId);
      }
      return hubClient.getSessionSubagents(sessionId, machineId);
    },

    async getMilestones(sessionId, machineId) {
      if (isLocal(machineId)) {
        return localClient.getMilestones(sessionId);
      }
      return hubClient.getMilestones(sessionId, machineId);
    },

    async getProjectArchitecture(projectPath?, machineId?) {
      if (isLocal(machineId)) {
        return localClient.getProjectArchitecture(projectPath);
      }
      return hubClient.getProjectArchitecture(projectPath, machineId);
    },

    async getArchitectureModel(projectPath?, machineId?) {
      if (isLocal(machineId)) {
        return localClient.getArchitectureModel(projectPath);
      }
      return hubClient.getArchitectureModel(projectPath, machineId);
    },

    async generateArchitectureModel(projectPath?, machineId?, model?) {
      if (isLocal(machineId)) {
        return localClient.generateArchitectureModel(projectPath, undefined, model);
      }
      return hubClient.generateArchitectureModel(projectPath, machineId, model);
    },

    async getIndexedSession(sessionId, machineId) {
      if (isLocal(machineId)) {
        return localClient.getIndexedSession(sessionId);
      }
      return hubClient.getIndexedSession(sessionId, machineId);
    },

    async getRunningProcesses(machineId) {
      if (isLocal(machineId)) {
        return localClient.getRunningProcesses();
      }
      return hubClient.getRunningProcesses(machineId);
    },

    async checkRunningProcesses(knownHash: string, machineId?: string) {
      if (isLocal(machineId)) {
        return localClient.checkRunningProcesses(knownHash);
      }
      return hubClient.checkRunningProcesses(knownHash, machineId);
    },

    async getPlanFileContent(planFile, machineId) {
      if (isLocal(machineId)) {
        return localClient.getPlanFileContent(planFile);
      }
      return hubClient.getPlanFileContent(planFile, machineId);
    },

    async searchSessions(query, opts, machineId) {
      if (isLocal(machineId)) {
        return localClient.searchSessions(query, opts);
      }
      return hubClient.searchSessions(query, opts, machineId);
    },

    async searchSessionsAi(query, opts, machineId) {
      if (isLocal(machineId)) {
        return localClient.searchSessionsAi(query, opts);
      }
      return hubClient.searchSessionsAi(query, opts, machineId);
    },

    async getAiSearchJob(jobId, machineId) {
      if (isLocal(machineId)) {
        return localClient.getAiSearchJob(jobId);
      }
      return hubClient.getAiSearchJob(jobId, machineId);
    },

    async getRecentMilestones(machineId, opts?) {
      if (isLocal(machineId)) {
        return localClient.getRecentMilestones(undefined, opts);
      }
      return hubClient.getRecentMilestones(machineId, opts);
    },

    async fetchPath(path, opts) {
      const machineId = opts?.machineId;
      if (isLocal(machineId)) {
        return localClient.fetchPath(path, opts);
      }
      return hubClient.fetchPath(path, { ...opts, machineId });
    },
  };
}

// ============================================
// Mode detection & factory
// ============================================

export function detectAppMode(): { mode: AppMode; baseUrl: string } {
  if (typeof window === 'undefined') {
    // SSR — default to local
    return { mode: 'local', baseUrl: 'http://localhost:3100' };
  }

  const hostname = window.location.hostname;

  // Hub mode: running on langmart.ai (includes proxy mode)
  if (hostname.includes('langmart.ai')) {
    return { mode: 'hub', baseUrl: '' }; // Same origin
  }

  // Local mode: localhost or local IP
  // The local tier-agent API port — configurable via env or default
  const localPort = process.env.NEXT_PUBLIC_LOCAL_API_PORT || '3100';
  return { mode: 'local', baseUrl: `http://${hostname}:${localPort}` };
}

/**
 * Detect whether the app is running through the hub web proxy.
 *
 * Proxy mode is detected by checking the URL path for the proxy pattern:
 *   /w/:machineId/assist/...
 *
 * Or by checking __NEXT_DATA__.basePath which the proxy shim injects.
 *
 * When proxied:
 *   - API calls go through hub relay (handled by hub mode + proxy shim)
 *   - Some features need special handling (e.g., ttyd terminal WebSocket)
 */
export function detectProxyInfo(): import('./types').ProxyInfo {
  if (typeof window === 'undefined') {
    return { isProxied: false, basePath: '', machineId: null };
  }

  const path = window.location.pathname;

  // Check URL pattern: /w/:machineId/assist/...
  const proxyMatch = path.match(/^\/w\/([^/]+)\/assist(\/|$)/);
  if (proxyMatch) {
    const machineId = proxyMatch[1];
    return {
      isProxied: true,
      basePath: `/w/${machineId}/assist`,
      machineId,
    };
  }

  // Also check __NEXT_DATA__.basePath (set by proxy shim)
  const nextData = (window as any).__NEXT_DATA__;
  if (nextData?.basePath && nextData.basePath.includes('/w/')) {
    const baseMatch = nextData.basePath.match(/^\/w\/([^/]+)\/assist$/);
    if (baseMatch) {
      return {
        isProxied: true,
        basePath: nextData.basePath,
        machineId: baseMatch[1],
      };
    }
  }

  return { isProxied: false, basePath: '', machineId: null };
}

export function createApiClient(mode?: AppMode, baseUrl?: string): ApiClient {
  const detected = detectAppMode();
  const resolvedMode = mode || detected.mode;
  const resolvedUrl = baseUrl || detected.baseUrl;

  if (resolvedMode === 'local' || resolvedMode === 'hybrid') {
    // Pass proxy info to local client for proxy-aware terminal handling
    const proxyInfo = detectProxyInfo();
    return createLocalClient(resolvedUrl, proxyInfo);
  }
  return createHubClient(resolvedUrl);
}

/**
 * Compute the hub HTTP base URL for hybrid mode.
 * Converts machine's hub WebSocket URL to HTTP, or defaults based on window host.
 */
export function getHubHttpUrl(hubWsUrl?: string): string {
  if (hubWsUrl) {
    return hubWsUrl.replace(/^ws:/, 'http:').replace(/^wss:/, 'https:');
  }
  if (typeof window === 'undefined') return 'http://localhost:8081';
  const host = window.location.hostname;
  if (host.includes('langmart')) return 'https://api.langmart.ai';
  return 'http://localhost:8081';
}

// ============================================
// Map raw subagent session data to SubagentSession type
// ============================================

function mapSubagentSession(s: any): import('./types').SubagentSession {
  return {
    agentId: s.agentId,
    type: s.type,
    model: s.model,
    status: s.status || 'running',
    prompt: s.prompt,
    lastActivityAt: s.lastActivityAt || s.startedAt,
    turns: s.numTurns,
    numTurns: s.numTurns,
    toolUses: Array.isArray(s.toolUses) ? s.toolUses.length : s.toolUses,
    tokensUsed: s.usage ? (s.usage.inputTokens || 0) + (s.usage.outputTokens || 0) : undefined,
    toolSummary: Array.isArray(s.toolUses)
      ? s.toolUses.reduce((acc: Record<string, number>, t: any) => {
          const name = t.name || t.tool_name || 'unknown';
          acc[name] = (acc[name] || 0) + 1;
          return acc;
        }, {})
      : undefined,
    lastResponse: s.responses?.length
      ? s.responses[s.responses.length - 1]?.text
      : undefined,
    fileSize: s.fileSize,
    parentUuid: s.parentUuid,
    parentSessionId: s.parentSessionId,
    cwd: s.cwd,
    conversation: s.conversation?.map((c: any) => ({
      type: c.type,
      turnIndex: c.turnIndex,
      lineIndex: c.lineIndex,
      content: typeof c.content === 'string' ? c.content : JSON.stringify(c.content),
    })),
    responses: s.responses,
    usage: s.usage,
  };
}

// ============================================
// Transform backend pre-parsed arrays into flat SessionMessage[]
// Mirrors admin-web SessionDetailView.tsx lines 1059-1296
// ============================================

function transformSessionResponse(raw: any, sessionId: string): SessionDetail {
  const allMessages: SessionMessage[] = [];

  // 1. User prompts -> type: 'human'
  if (raw.userPrompts) {
    for (let i = 0; i < raw.userPrompts.length; i++) {
      const p = raw.userPrompts[i];
      allMessages.push({
        id: `user-${i}`,
        type: 'human',
        content: typeof p === 'string' ? p : p.text || p.content || JSON.stringify(p),
        timestamp: p.timestamp,
        turnIndex: p.turnIndex,
        lineIndex: p.lineIndex,
      });
    }
  }

  // 2. Responses -> type: 'assistant' (or 'error' for Anthropic API errors)
  if (raw.responses) {
    for (let i = 0; i < raw.responses.length; i++) {
      const r = raw.responses[i];
      const text = r.text || r.content || (typeof r === 'string' ? r : '');
      allMessages.push({
        id: `assistant-${r.id || i}`,
        type: r.isApiError ? 'error' : 'assistant',
        content: text,
        timestamp: r.timestamp,
        turnIndex: r.turnIndex,
        lineIndex: r.lineIndex,
      });
    }
  }

  // 3. Tool uses -> type: 'assistant' with toolName/toolInput
  // Build task map for resolving TaskUpdate subjects
  const taskMap = new Map<string, { subject: string; status: string }>();
  if (raw.tasks) {
    for (const t of raw.tasks) {
      taskMap.set(t.id, { subject: t.subject, status: t.status });
    }
  }

  if (raw.toolUses) {
    for (let i = 0; i < raw.toolUses.length; i++) {
      const tool = raw.toolUses[i];
      const name = tool.name || tool.tool_name || '';

      // TodoWrite -> type: 'todo'
      if (name === 'TodoWrite' || name === 'TodoRead') {
        const todos = tool.input?.todos || [];
        allMessages.push({
          id: `todo-${tool.id || i}`,
          type: 'todo',
          content: `${todos.length} todos`,
          timestamp: tool.timestamp,
          turnIndex: tool.turnIndex,
          lineIndex: tool.lineIndex,
          toolName: name,
          toolInput: tool.input,
          todos: todos.map((t: any) => ({
            content: t.content || t.title || t.subject || '',
            status: t.status || 'pending',
          })),
        });
        continue;
      }

      // TaskCreate/TaskUpdate -> type: 'task'
      if (name === 'TaskCreate' || name === 'TaskUpdate' || name === 'TaskGet' || name === 'TaskList') {
        const inp = tool.input || {};
        let subject = inp.subject || '';
        if (!subject && name === 'TaskUpdate' && inp.taskId) {
          const existing = taskMap.get(String(inp.taskId));
          if (existing) subject = existing.subject;
        }
        allMessages.push({
          id: `task-${tool.id || i}`,
          type: 'task',
          subtype: name,
          content: subject || `${name} ${inp.taskId || ''}`,
          timestamp: tool.timestamp,
          turnIndex: tool.turnIndex,
          lineIndex: tool.lineIndex,
          toolName: name,
          toolInput: tool.input,
          toolResult: tool.output || tool.result || tool.resultSummary,
        });
        continue;
      }

      // EnterPlanMode/ExitPlanMode -> type: 'plan'
      if (name === 'EnterPlanMode' || name === 'ExitPlanMode') {
        const isEnter = name === 'EnterPlanMode';
        // Look up plan metadata from raw.plans
        const planMeta = raw.plans?.find((p: any) => p.toolUseId === tool.id);
        const planTitle = planMeta?.planTitle || '';
        const content = isEnter
          ? 'Entering plan mode'
          : `Plan approved${planTitle ? `: ${planTitle}` : ''}`;
        allMessages.push({
          id: `plan-${tool.id || i}`,
          type: 'plan',
          content,
          turnIndex: tool.turnIndex,
          lineIndex: tool.lineIndex,
          toolName: name,
          toolInput: {
            ...tool.input,
            ...(planMeta ? {
              planTitle: planMeta.planTitle,
              planFile: planMeta.planFile,
              planSummary: planMeta.planSummary,
              allowedPrompts: planMeta.allowedPrompts,
            } : {}),
            _status: isEnter ? 'entering' : 'approved',
          },
        });
        continue;
      }

      // Regular tool call
      allMessages.push({
        id: `tool-${tool.id || i}`,
        type: 'assistant',
        subtype: 'tool_use',
        content: tool.resultSummary || `[${name}]`,
        timestamp: tool.timestamp,
        turnIndex: tool.turnIndex,
        lineIndex: tool.lineIndex,
        toolName: name,
        toolInput: tool.input,
        toolResult: tool.output || tool.result || tool.resultSummary,
      });
    }
  }

  // 4. Thinking blocks -> type: 'thinking'
  if (raw.thinkingBlocks) {
    for (let i = 0; i < raw.thinkingBlocks.length; i++) {
      const t = raw.thinkingBlocks[i];
      allMessages.push({
        id: `thinking-${i}`,
        type: 'thinking',
        content: t.thinking || t.content || '',
        turnIndex: t.turnIndex,
        lineIndex: t.lineIndex,
      });
    }
  }

  // 5. Raw messages -> system/result/progress/summary/file-history-snapshot/queue-operation
  if (raw.rawMessages) {
    for (let i = 0; i < raw.rawMessages.length; i++) {
      const msg = raw.rawMessages[i];
      const msgType = msg.type;

      // Skip user/assistant — already handled by userPrompts/responses
      if (msgType === 'user' || msgType === 'assistant') continue;

      // Include raw message types for the chat view
      if (['system', 'result', 'progress', 'summary', 'file-history-snapshot', 'queue-operation'].includes(msgType)) {
        // Extract content based on message type structure
        let contentStr = '';

        if (msgType === 'progress') {
          // Progress: data is an object like {type: 'hook_progress', hookEvent: '...', hookName: '...'}
          // or {type: 'bash_progress', output: '...'} etc.
          const data = msg.data || {};
          if (data.type === 'bash_progress' && data.output) {
            contentStr = data.output;
          } else if (data.type === 'hook_progress') {
            contentStr = `${data.hookEvent || ''}: ${data.hookName || ''}`;
          } else if (data.type === 'waiting_for_task') {
            contentStr = `Waiting: ${data.taskDescription || ''}`;
          } else if (data.type === 'mcp_progress') {
            contentStr = `MCP ${data.status || ''}: ${data.serverName || ''}/${data.toolName || ''}`;
          } else if (data.type === 'agent_progress') {
            contentStr = 'Agent progress';
          } else {
            contentStr = JSON.stringify(data);
          }
        } else if (msgType === 'system') {
          // System: subtype like 'turn_duration' (with durationMs) or 'compact_boundary' (with content)
          if (msg.subtype === 'turn_duration' && msg.durationMs) {
            const secs = Math.round(msg.durationMs / 1000);
            const mins = Math.floor(secs / 60);
            contentStr = `Turn duration: ${mins > 0 ? `${mins}m ${secs % 60}s` : `${secs}s`}`;
          } else if (msg.subtype === 'compact_boundary') {
            contentStr = msg.content || 'Conversation compacted';
          } else if (msg.subtype === 'stop_hook_summary') {
            contentStr = msg.content || 'Stop hook summary';
          } else {
            contentStr = msg.content || `System: ${msg.subtype || ''}`;
          }
        } else if (msgType === 'file-history-snapshot') {
          contentStr = 'File history snapshot';
        } else if (msgType === 'queue-operation') {
          contentStr = msg.content || `Queue: ${msg.operation || ''}`;
        } else if (msgType === 'result') {
          // Results from tool executions
          const msgContent = msg.message?.content;
          if (typeof msgContent === 'string') {
            contentStr = msgContent;
          } else if (Array.isArray(msgContent)) {
            contentStr = msgContent
              .map((b: any) => b.text || b.content || '')
              .filter(Boolean)
              .join('\n');
          }
        } else if (msgType === 'summary') {
          contentStr = msg.content || msg.summary || '';
        }

        allMessages.push({
          id: `raw-${msgType}-${msg.uuid || i}`,
          type: msgType as any,
          subtype: msg.subtype || msg.slug,
          content: contentStr || JSON.stringify(msg).slice(0, 500),
          timestamp: msg.timestamp,
          turnIndex: msg.turnIndex,
          lineIndex: msg.lineIndex,
          // Store full raw data for non-smart display
          rawData: msg,
        });
      }
    }
  }

  // 6. Subagent prompt messages (basic — full conversations merged by useSessionDetail hook)
  // Only add agent_user if we don't have full subagent data from /subagents endpoint
  if (raw.subagents) {
    for (let i = 0; i < raw.subagents.length; i++) {
      const agent = raw.subagents[i];
      if (agent.prompt) {
        allMessages.push({
          id: `agent-${agent.agentId || i}-user`,
          type: 'agent_user',
          content: agent.prompt,
          turnIndex: agent.turnIndex,
          lineIndex: agent.lineIndex,
          agentId: agent.agentId,
          subagentType: agent.type,
        });
      }
    }
  }

  // Sort all messages by lineIndex, then turnIndex
  allMessages.sort((a, b) => {
    const aLine = a.lineIndex ?? Infinity;
    const bLine = b.lineIndex ?? Infinity;
    if (aLine !== bLine) return aLine - bLine;
    const aTurn = a.turnIndex ?? 0;
    const bTurn = b.turnIndex ?? 0;
    return aTurn - bTurn;
  });

  const result: any = {
    sessionId,
    projectPath: raw.projectPath || '',
    model: raw.model,
    status: raw.status,
    isActive: raw.isActive,
    lastModified: raw.lastModified || raw.lastActivityAt,
    totalCostUsd: raw.totalCostUsd,
    numTurns: raw.numTurns || raw.totalTurns,
    messageCount: allMessages.length,
    inputTokens: raw.usage?.inputTokens,
    outputTokens: raw.usage?.outputTokens,
    cacheReadInputTokens: raw.usage?.cacheReadInputTokens,
    cacheCreationInputTokens: raw.usage?.cacheCreationInputTokens,
    duration: raw.durationMs ? Math.round(raw.durationMs / 1000) : undefined,
    cwd: raw.cwd,
    claudeCodeVersion: raw.claudeCodeVersion,
    permissionMode: raw.permissionMode,
    messages: allMessages,
    todos: raw.todos,
    tasks: raw.tasks,
    plans: raw.plans,
    toolUses: raw.toolUses,
    subagents: raw.subagents?.map((a: any) => ({
      agentId: a.agentId,
      type: a.type,
      model: a.model,
      status: a.status || 'running',
      prompt: a.prompt,
      lastActivityAt: a.startedAt,
      turns: a.turns,
      toolUses: a.toolUses,
      tokensUsed: a.tokensUsed,
      toolSummary: a.toolSummary,
      lastResponse: a.lastResponse,
      // Positioning in parent session (from SubagentInvocation)
      turnIndex: a.turnIndex,
      lineIndex: a.lineIndex,
    })),
    // Pre-extracted file changes from backend
    fileChanges: raw.fileChanges?.map((fc: any) => ({
      filePath: fc.path || fc.filePath,
      action: fc.action,
      turnIndex: fc.turnIndex,
    })),
    // Pre-extracted git operations from backend
    gitOperations: raw.gitOperations?.map((go: any) => ({
      type: go.type,
      command: go.command,
      branch: go.branch,
      remote: go.remote,
      files: go.files,
      commitMessage: go.commitMessage,
      repoUrl: go.repoUrl,
      commitRef: go.commitRef,
      prNumber: go.prNumber,
      tag: go.tag,
      turnIndex: go.turnIndex,
    })),
    // Pre-extracted db operations from backend
    dbOperations: raw.dbOperations,
    teamName: raw.teamName,
    allTeams: raw.allTeams,
    taskSubjects: raw.taskSubjects,
    running: raw.running || undefined,
    forkedFromSessionId: raw.forkedFromSessionId,
    lineCount: raw.lastLineIndex ?? allMessages.length,
    // Attach raw data for subagent UUID positioning (not part of SessionDetail type)
    _rawMessages: raw.rawMessages || [],
    _responses: raw.responses || [],
  };

  return result as SessionDetail;
}

// ============================================
// Helpers
// ============================================

function extractProjectName(projectPath: string): string {
  if (!projectPath) return 'Unknown';
  const parts = projectPath.replace(/\/$/, '').split('/');
  return parts[parts.length - 1] || 'Unknown';
}

// ============================================
// Hub user info fetcher
// ============================================

/**
 * Fetch the authenticated user's info from the hub's web proxy.
 *
 * When proxied through langmart.ai, the web-proxy
 * already authenticates the user via proxy-access-token cookie.
 * The /__hub_user__ endpoint returns user info directly from the
 * database using the authenticated userId — no API key needed.
 */
export async function fetchHubUserInfo(): Promise<import('./types').HubUserInfo | null> {
  if (typeof window === 'undefined') return null;

  const proxy = detectProxyInfo();
  if (!proxy.isProxied) return null; // Only works in proxy mode

  try {
    // The web-proxy intercepts /__hub_user__ and returns the authenticated
    // user's info. Auth is handled by the proxy cookie — no API key needed.
    const res = await fetch(`${proxy.basePath}/__hub_user__`);

    if (!res.ok) return null;

    const data = await res.json();
    if (!data.valid || !data.user) return null;

    return {
      id: data.user.id,
      email: data.user.email,
      displayName: data.user.displayName,
      avatarUrl: data.user.avatarUrl,
      oauthProvider: data.user.oauthProvider,
      organizationId: data.user.organizationId,
    };
  } catch (err) {
    console.warn('[fetchHubUserInfo] Failed to fetch user info:', err);
    return null;
  }
}

