/**
 * Mission MCP tools — 4 core tools + 6 session/rail tools that proxy the /mission REST routes.
 *
 * Core tools:
 *   mission_create         — create a new mission (POST /mission)
 *   mission_list           — list all missions (GET /mission)
 *   mission_update         — update a mission (POST /mission/:id)
 *   mission_control_status — elected controller + last tick (GET /mission/controller)
 *
 * Rail tools (deterministic guardrails):
 *   mission_place          — placement decision for a mission (GET /mission/:id/place)
 *   mission_executor_status — executor liveness (GET /mission/:id/executor-status)
 *
 * Operability tools:
 *   mission_sessions       — list all operable sessions (GET /mission/sessions)
 *   mission_session_read   — read session transcript (POST /mission/session/:sid/read)
 *   mission_session_drive  — send a message to a session (POST /mission/session/:sid/drive)
 *   mission_session_control — control a session (POST /mission/session/:sid/control)
 *
 * Wiring: registered in EXPANDED_TOOL_DEFS + EXPANDED_HANDLERS (expanded.ts),
 * scoped in configure.ts TOOL_SCOPES.
 */
import type { McpToolResult } from '../configure';
import { ok, err, workerGet, workerPost } from './_passthrough';
import { currentMcpContext } from '../principal-context';

export function withActorHint(args: Record<string, unknown>, toolUseId: string | undefined): Record<string, unknown> {
  return { ...args, _actor: { channel: 'mcp', toolUseId: toolUseId ?? null } };
}

const S = { type: 'string' as const };
const SARR = { type: 'array' as const, items: { type: 'string' as const } };
const obj = (props: Record<string, unknown>, required: string[] = []) => ({
  type: 'object' as const,
  properties: props,
  required,
});
const pretty = (v: unknown): McpToolResult => ok(JSON.stringify(v, null, 2));

export const MISSION_TOOL_DEFS = [
  {
    name: 'mission_create',
    description:
      'Create a Mission (durable WHAT-to-achieve). The fleet-elected Mission Controller will ' +
      'place an executor and push it to done. Spans any project(s).',
    inputSchema: obj(
      {
        title: S,
        objective: S,
        projects: SARR,
        dependsOn: SARR,
        plan: S,
        nextSteps: SARR,
        tags: { type: 'object' as const },
        parentId: S,
        env: obj({
          isolation: { ...S, enum: ['cloud', 'worktree', 'shared'] },
          host: S,
          repo: S,
          branch: S,
          resources: SARR,
          exclusive: { type: 'boolean' as const },
        }),
      },
      ['title', 'objective'],
    ),
  },
  {
    name: 'mission_list',
    description: 'List all missions and their status/progress/binding.',
    inputSchema: obj({}),
  },
  {
    name: 'mission_update',
    description:
      'Update a mission (objective/title/plan/nextSteps/status/env/dependsOn/binding). ' +
      'Use to refine, pause, unblock, or BIND a spawned executor. After you ccr_cloud_start (or natively launch) a worker, ' +
      'call mission_update({id, binding:{sessionId:"<the worker sid>", kind:"worker"|"orchestrator"}}) so the supervisor ' +
      'can MONITOR it — binding is REQUIRED for the supervisor to detect the worker\'s pendingQuestion and engage you to ' +
      'answer it FAST (a cloud worker left unanswered idle-suspends and cannot resume). Pass binding:null to unbind.',
    inputSchema: obj(
      {
        id: S,
        title: S,
        objective: S,
        plan: S,
        status: {
          ...S,
          enum: ['draft', 'active', 'waiting', 'paused', 'blocked', 'done', 'failed'],
        },
        nextSteps: SARR,
        dependsOn: SARR,
        projects: SARR,
        tags: { type: 'object' as const },
        parentId: S,
        binding: {
          type: 'object' as const,
          description: 'Bind a spawned executor: {sessionId, kind:"worker"|"orchestrator", node?}. Required so the supervisor monitors it + answers its question fast.',
          properties: { sessionId: { type: 'string' as const }, kind: { type: 'string' as const, enum: ['worker', 'orchestrator'] }, node: { type: 'string' as const } },
        },
      },
      ['id'],
    ),
  },
  {
    name: 'mission_control_status',
    description: 'Who is the elected Mission Controller right now + its last tick result.',
    inputSchema: obj({}),
  },
  // --- Rail tools ---
  {
    name: 'mission_place',
    description: 'Check placement decision for a mission: dependency gate → resource conflict → isolation. Returns {go, reason?, env?, host?, branch?, lease?, waitOn?, conflictWith?}. Call before spawning an executor.',
    inputSchema: obj({ id: S }, ['id']),
  },
  {
    name: 'mission_executor_status',
    description: 'Get the current executor liveness for a mission: {alive, idle, serverStalled, gate?, status}. Deterministic — reads cloudStatus / local verdict.',
    inputSchema: obj({ id: S }, ['id']),
  },
  // --- Operability tools ---
  {
    name: 'mission_sessions',
    description: 'List all operable mission sessions: the controller session + every active mission\'s orchestrator + sub-workers. Each row: {sid, missionId, role, transport, status?, webUrl?}. Optionally filter by missionId.',
    inputSchema: obj({ missionId: S }),
  },
  {
    name: 'mission_session_read',
    description: 'Read the transcript of a mission session (cloud CCR or native). Returns {messages:[...], pendingQuestion}. `pendingQuestion` (when non-null) is an AskUserQuestion the session is BLOCKED on — {toolUseId, requestId?, questions:[{header,question,options}]}; answer it with mission_session_answer (NOT mission_session_drive). Works for a `--remote-control` (bridge) controller/executor too. Use lastN to limit messages. `node` is usually unnecessary — an onboarded session bound to a different in-cluster node is auto-resolved and proxied there; pass it only to force a specific node.',
    inputSchema: obj({ sid: S, lastN: { type: 'number' as const }, node: S }, ['sid']),
  },
  {
    name: 'mission_session_drive',
    description: 'Send a message to a mission session (cloud or native). The session receives the text as an injected prompt. Write tool — creates a turn. NOTE: if the session is blocked on a `pendingQuestion`, use mission_session_answer, not this. `node` is usually unnecessary — an onboarded session bound to a different in-cluster node is auto-resolved and proxied there; pass it only to force a specific node.',
    inputSchema: obj({ sid: S, text: S, node: S }, ['sid', 'text']),
  },
  {
    name: 'mission_session_answer',
    description: 'Answer the PENDING AskUserQuestion a mission session is blocked on (surfaced as `pendingQuestion` by mission_session_read). `answer` = an option LABEL (a "click") OR any free TEXT (a custom reply) — both supported. Works for cloud, native (tmux), AND `--remote-control` bridge sessions (the controller/executor); the bridge requestId auto-resolves (or pass requestId/toolUseId). Write tool — leader-anchored.',
    inputSchema: obj({ sid: S, answer: S, toolUseId: S, requestId: S }, ['sid', 'answer']),
  },
  {
    name: 'mission_session_control',
    description: 'Control a mission session: action=interrupt (stop current action), stop (terminate), restart (controller only — supervisor relaunches next tick). Non-controller restart returns an error.',
    inputSchema: obj({ sid: S, action: { ...S, enum: ['interrupt', 'stop', 'restart'] } }, ['sid', 'action']),
  },
  {
    name: 'mission_session_resume',
    description: 'Resume a mission\'s worker session IN PLACE, preserving its context. Native → `claude --resume` + re-bridge (SAME sessionId); cloud → wake an idle worker (re-drive). Returns {resumed, transport, sid, reason}. reason: ok (resumed) | alive (already running) | needs-force (live session actively busy, not safe to kill without force) | kill-failed (process did not terminate) | conflict (live elsewhere, unsafe to resume) | gone (terminal — spawn a fresh worker as a SEPARATE action; this tool never auto-replaces). Pass missionId for native. Pass force:true to kill-and-resume a live, unreachable, actively-busy worker (idle workers are auto-killed). Write tool — leader-anchored.',
    inputSchema: obj({ sid: S, missionId: S, force: { type: 'boolean' as const } }, ['sid']),
  },
  {
    name: 'mission_tag',
    description:
      'Add/remove/set a mission\'s tags by dimension (e.g. project/feature/component) without read-modify-write. ' +
      '{id, add?:{dim:[vals]}, remove?:{dim:[vals]}, set?:{dim:[vals]}}. set replaces a dimension; add/remove merge or subtract. ' +
      'Recorded in the mission history with provenance.',
    inputSchema: obj({ id: S, add: { type: 'object' as const }, remove: { type: 'object' as const }, set: { type: 'object' as const } }, ['id']),
  },
  {
    name: 'mission_history',
    description:
      'Page a mission\'s full version history (UNBOUNDED — beyond the recent entries embedded in the mission record). ' +
      'Each entry: {rev, at, actor, changes:{field:{from,to}}}. {id, limit?(default 50), beforeRev?(page older)}. Newest-first.',
    inputSchema: obj({ id: S, limit: { type: 'number' as const }, beforeRev: { type: 'number' as const } }, ['id']),
  },
  {
    name: 'mission_onboard',
    description:
      'Onboard an EXISTING Claude Code session into mission control. Omit sessionId to onboard the CALLING session (self-handoff). ' +
      'mode: standby (default — observe only, human stays in charge) | handoff (mission control drives it end-to-end per the workflow playbooks). ' +
      'cluster targets which cluster\'s controller manages it (default: this node\'s). note = free-text intent for the analysis. ' +
      'Returns the created (or existing) mission.',
    inputSchema: obj({ sessionId: S, cluster: S, mode: { ...S, enum: ['handoff', 'standby'] }, note: S, node: S }),
  },
] as const;

export const MISSION_HANDLERS: Record<
  string,
  (args: Record<string, unknown>) => Promise<McpToolResult>
> = {
  mission_create: async (a) => {
    try {
      return pretty(await workerPost('/mission', withActorHint(a, currentMcpContext()?.toolUseId)));
    } catch (e) { return err((e as Error).message); }
  },

  mission_list: async () => {
    try {
      return pretty(await workerGet('/mission'));
    } catch (e) {
      return err((e as Error).message);
    }
  },

  mission_update: async (a) => {
    try {
      const id = String(a.id || '');
      if (!id) return err('id is required');
      return pretty(await workerPost(`/mission/${encodeURIComponent(id)}`, withActorHint(a, currentMcpContext()?.toolUseId)));
    } catch (e) { return err((e as Error).message); }
  },

  mission_control_status: async () => {
    try {
      return pretty(await workerGet('/mission/controller'));
    } catch (e) {
      return err((e as Error).message);
    }
  },

  // --- Rail tools ---
  mission_place: async (a) => {
    try {
      const id = String(a.id || '');
      if (!id) return err('id is required');
      return pretty(await workerGet(`/mission/${encodeURIComponent(id)}/place`));
    } catch (e) { return err((e as Error).message); }
  },

  mission_executor_status: async (a) => {
    try {
      const id = String(a.id || '');
      if (!id) return err('id is required');
      return pretty(await workerGet(`/mission/${encodeURIComponent(id)}/executor-status`));
    } catch (e) { return err((e as Error).message); }
  },

  // --- Operability tools ---
  mission_sessions: async (a) => {
    try {
      const missionId = a.missionId ? String(a.missionId) : undefined;
      const url = missionId ? `/mission/sessions?missionId=${encodeURIComponent(missionId)}` : '/mission/sessions';
      return pretty(await workerGet(url));
    } catch (e) { return err((e as Error).message); }
  },

  mission_session_read: async (a) => {
    try {
      const sid = String(a.sid || '');
      if (!sid) return err('sid is required');
      // Coerce lastN: MCP args arrive as strings over the connector
      const rawLastN = a.lastN;
      const lastN = typeof rawLastN === 'number' ? rawLastN : (typeof rawLastN === 'string' ? parseInt(rawLastN, 10) : undefined);
      // I1: forward `node` when given (string passthrough) — usually unnecessary since the
      // route auto-resolves an onboarded mission's node, but lets a caller force a specific one.
      const node = a.node ? String(a.node) : undefined;
      return pretty(await workerPost(`/mission/session/${encodeURIComponent(sid)}/read`, { lastN, node }));
    } catch (e) { return err((e as Error).message); }
  },

  mission_session_drive: async (a) => {
    try {
      const sid = String(a.sid || '');
      if (!sid) return err('sid is required');
      const text = String(a.text || '');
      if (!text) return err('text is required');
      const node = a.node ? String(a.node) : undefined;
      // withActorHint so drive is attributed to the caller's MCP session
      return pretty(await workerPost(`/mission/session/${encodeURIComponent(sid)}/drive`, withActorHint({ text, node }, currentMcpContext()?.toolUseId)));
    } catch (e) { return err((e as Error).message); }
  },

  mission_session_answer: async (a) => {
    try {
      const sid = String(a.sid || '');
      if (!sid) return err('sid is required');
      const answer = String(a.answer || '');
      if (!answer) return err('answer is required');
      const body: Record<string, unknown> = { answer };
      if (a.toolUseId) body.toolUseId = String(a.toolUseId);
      if (a.requestId) body.requestId = String(a.requestId);
      return pretty(await workerPost(`/mission/session/${encodeURIComponent(sid)}/answer`, withActorHint(body, currentMcpContext()?.toolUseId)));
    } catch (e) { return err((e as Error).message); }
  },

  mission_session_control: async (a) => {
    try {
      const sid = String(a.sid || '');
      if (!sid) return err('sid is required');
      const action = String(a.action || '');
      if (!action) return err('action is required');
      return pretty(await workerPost(`/mission/session/${encodeURIComponent(sid)}/control`, { action }));
    } catch (e) { return err((e as Error).message); }
  },

  mission_session_resume: async (a) => {
    try {
      const sid = String(a.sid || '');
      if (!sid) return err('sid is required');
      const body: Record<string, unknown> = {};
      if (a.missionId) body.missionId = String(a.missionId);
      if (a.force !== undefined) body.force = a.force === true || a.force === 'true';
      return pretty(await workerPost(`/mission/session/${encodeURIComponent(sid)}/resume`, body));
    } catch (e) { return err((e as Error).message); }
  },

  mission_tag: async (a) => {
    try {
      const id = String(a.id || '');
      if (!id) return err('id is required');
      const body: Record<string, unknown> = {};
      if (a.add) body.add = a.add;
      if (a.remove) body.remove = a.remove;
      if (a.set) body.set = a.set;
      return pretty(await workerPost(`/mission/${encodeURIComponent(id)}/tags`, withActorHint(body, currentMcpContext()?.toolUseId)));
    } catch (e) { return err((e as Error).message); }
  },

  mission_history: async (a) => {
    try {
      const id = String(a.id || '');
      if (!id) return err('id is required');
      const num = (v: unknown) => typeof v === 'number' ? v : (typeof v === 'string' && v.trim() ? parseInt(v, 10) : undefined);
      const qs = new URLSearchParams();
      const limit = num(a.limit); const beforeRev = num(a.beforeRev);
      if (limit != null && !Number.isNaN(limit)) qs.set('limit', String(limit));
      if (beforeRev != null && !Number.isNaN(beforeRev)) qs.set('beforeRev', String(beforeRev));
      return pretty(await workerGet(`/mission/${encodeURIComponent(id)}/history${qs.toString() ? `?${qs}` : ''}`));
    } catch (e) { return err((e as Error).message); }
  },

  mission_onboard: async (a) => {
    try {
      return pretty(await workerPost('/mission/onboard', withActorHint(a, currentMcpContext()?.toolUseId)));
    } catch (e) { return err((e as Error).message); }
  },
};
