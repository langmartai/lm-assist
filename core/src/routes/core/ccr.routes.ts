/**
 * CCR Routes — Claude Code Remote management endpoints.
 *
 * Envelope pattern identical to terminal.routes.ts.
 * All side-effectful operations enforce the safety gate in ccr-manager.
 *
 * GET  /ccr/preflight/:sessionId   → sessionVerdict (read-only, no side effects)
 * POST /ccr/load     {sessionId?, jsonl?}
 * POST /ccr/mirror   {sessionId}
 * POST /ccr/connect  {sessionId}
 * GET  /ccr/remote                 → list running remotes
 * GET  /ccr/remote/:id             → single remote
 * POST /ccr/remote/:id/stop        → stop + deregister
 */

import type { RouteHandler, RouteContext } from '../index';
import { TerminalError, httpStatusFor } from '../../terminal/errors';
import { sessionVerdict } from '../../terminal/cc-sessions';
import * as ccr from '../../terminal/ccr-manager';
import * as ccrCloud from '../../terminal/ccr-cloud';
import { buildRemoteListReport } from '../../terminal/ccr-liveness';

interface Envelope { success: boolean; data?: unknown; error?: { code: string; message: string; details?: unknown }; }

/** Which node/cluster is answering. Degrades to placeholders; never throws. */
function whereAmI(): { node: string; cluster: string } {
  let node = 'this node';
  let cluster = 'default';
  try {
    const { getHubConfig } = require('../../hub-client/hub-config') as typeof import('../../hub-client/hub-config');
    node = getHubConfig().hostname || node;
  } catch { /* minimal */ }
  try {
    const { getMyCluster } = require('../../cluster/cluster-config') as typeof import('../../cluster/cluster-config');
    cluster = getMyCluster();
  } catch { /* default */ }
  return { node, cluster };
}

function ok<T>(data: T) {
  return { success: true, data } as Envelope;
}
function fail(code: string, message: string, details?: unknown) {
  return { success: false, error: { code, message, details } } as Envelope;
}

// ── Wave 5 — remote-control session list (controller + mission executors named
//    from the mission store, + other local RC sessions from the account list) ──
export interface RemoteControlListDeps {
  getController: () => Promise<{ sessionId: string; cse: string | null; tmux: string; node: string; startedAt: number } | null>;
  listMissions: () => Promise<Array<Record<string, unknown>>>;
  listAccount: () => Promise<Array<{ sid: string; status: string; title?: string }>>;
}

/**
 * Lists local remote-control-connected sessions for the CCR view:
 *  - controller: the Mission Controller (named reliably from the ControllerSession record),
 *  - executors: each mission's bound executor (named via missionSessionTitle),
 *  - accountRc: other account code/RC sessions (`/v1/code/sessions`), titled by claude.
 * DI-testable; never throws on a sub-source failure (degrades to null/[]).
 */
export async function handleRemoteControlList(deps: RemoteControlListDeps): Promise<Envelope> {
  const { missionSessionTitle } = require('../../mission/mission-model') as typeof import('../../mission/mission-model');
  const c = await deps.getController().catch(() => null);
  const controller = c
    ? { sid: c.sessionId, cse: c.cse, tmux: c.tmux, node: c.node, title: 'Mission Controller', startedAt: c.startedAt }
    : null;
  const missions = await deps.listMissions().catch(() => [] as Array<Record<string, unknown>>);
  const executors = missions
    .filter((m) => (m as any).binding?.sessionId)
    .map((m) => {
      const b = (m as any).binding;
      return { sid: b.sessionId as string, cse: (b.ccr?.sid ?? null) as string | null, title: missionSessionTitle(m as any), missionId: (m as any).id as string, status: (m as any).status as string };
    });
  const accountRc = await deps.listAccount().catch(() => [] as Array<{ sid: string; status: string; title?: string }>);
  return ok({ controller, executors, accountRc });
}

async function envelope<T>(fn: () => Promise<T> | T): Promise<Envelope> {
  try {
    const data = await fn();
    return ok(data);
  } catch (e: unknown) {
    if (e instanceof TerminalError) {
      return fail(e.code, e.message, e.details);
    }
    const err = e as Error;
    return fail('INTERNAL_ERROR', err.message || String(e));
  }
}

function parseSessionId(raw: string | undefined): string {
  if (!raw || typeof raw !== 'string' || !/^[0-9a-f-]{36}$/.test(raw)) {
    throw new TerminalError('INVALID_INPUT', 'sessionId must be a UUID');
  }
  return raw;
}

function parseCcrId(raw: string | undefined): string {
  if (!raw || typeof raw !== 'string' || !/^ccr-[0-9a-z]{8}$/.test(raw)) {
    throw new TerminalError('INVALID_INPUT', 'invalid ccr remote id');
  }
  return raw;
}

function parseCloudSid(raw: string | undefined): string {
  if (!raw || typeof raw !== 'string' || !/^(?:session_|cse_)[A-Za-z0-9]+$/.test(raw)) {
    throw new TerminalError('INVALID_INPUT', 'cloud sid must look like session_… or cse_…');
  }
  return raw;
}

export function createCcrRoutes(_ctx: RouteContext): RouteHandler[] {
  return [
    // GET /ccr/preflight/:sessionId — read-only verdict, no side effects
    {
      method: 'GET',
      pattern: /^\/ccr\/preflight\/(?<sessionId>[^/]+)$/,
      handler: async (req) => envelope(() => {
        const sid = parseSessionId(req.params.sessionId);
        return sessionVerdict(sid);
      }),
    },

    // POST /ccr/load — spawn ccr-load-session.js detached (read-only replay)
    {
      method: 'POST',
      pattern: /^\/ccr\/load$/,
      handler: async (req) => envelope(async () => {
        const body = (req.body || {}) as { sessionId?: unknown; jsonl?: unknown };
        const sessionId = typeof body.sessionId === 'string' ? body.sessionId : undefined;
        const jsonl = typeof body.jsonl === 'string' ? body.jsonl : undefined;
        if (sessionId) parseSessionId(sessionId);
        return await ccr.startLoad({ sessionId, jsonl });
      }),
    },

    // POST /ccr/mirror — spawn ccr-oneway-mirror.js detached
    {
      method: 'POST',
      pattern: /^\/ccr\/mirror$/,
      handler: async (req) => envelope(async () => {
        const body = (req.body || {}) as { sessionId?: unknown };
        const sessionId = parseSessionId(body.sessionId as string | undefined);
        return await ccr.startMirror({ sessionId });
      }),
    },

    // POST /ccr/connect — two-way bridge with safety gate
    {
      method: 'POST',
      pattern: /^\/ccr\/connect$/,
      handler: async (req) => {
        const body = (req.body || {}) as { sessionId?: unknown; force?: unknown };
        try {
          const sessionId = parseSessionId(body.sessionId as string | undefined);
          const data = await ccr.connect({ sessionId, force: body.force === true });
          return ok(data);
        } catch (e: unknown) {
          if (e instanceof TerminalError) {
            const status = httpStatusFor(e.code);
            // Return envelope with the right HTTP status in the body — the route
            // layer uses the envelope's success field; the status code is carried
            // in the error code for callers that inspect it.
            return { success: false, error: { code: e.code, message: e.message, details: e.details, httpStatus: status } } as Envelope;
          }
          const err = e as Error;
          return fail('INTERNAL_ERROR', err.message || String(e));
        }
      },
    },

    // POST /ccr/restart — corruption-safe LOCAL session restart so the process
    // re-fetches its MCP tool list. Stops existing bridge remotes → kills the
    // live owner (verify-dead, twice) → only then `claude --resume` fresh.
    // Busy sessions need force:true; kill-failed ⇒ CONFLICT, never resumes.
    {
      method: 'POST',
      pattern: /^\/ccr\/restart$/,
      handler: async (req) => {
        const body = (req.body || {}) as { sessionId?: unknown; force?: unknown; waitMs?: unknown };
        try {
          const sessionId = parseSessionId(body.sessionId as string | undefined);
          const waitMs = Number(body.waitMs);
          const data = await ccr.restart({ sessionId, force: body.force === true, waitMs: Number.isFinite(waitMs) ? waitMs : undefined });
          return ok(data);
        } catch (e: unknown) {
          if (e instanceof TerminalError) {
            const status = httpStatusFor(e.code);
            return { success: false, error: { code: e.code, message: e.message, details: e.details, httpStatus: status } } as Envelope;
          }
          const err = e as Error;
          return fail('INTERNAL_ERROR', err.message || String(e));
        }
      },
    },

    // POST /ccr/drive — deliver a prompt (user turn) to a connected session.
    // Primary: claude.ai cloud endpoint (reaches the session from anywhere).
    // Second option: same-host tmux send-keys (preferTmux, or cloud-failure fallback).
    {
      method: 'POST',
      pattern: /^\/ccr\/drive$/,
      handler: async (req) => envelope(async () => {
        const body = (req.body || {}) as { id?: unknown; sessionId?: unknown; cse?: unknown; text?: unknown; preferTmux?: unknown };
        const text = typeof body.text === 'string' ? body.text : '';
        if (!text.trim()) throw new TerminalError('INVALID_INPUT', 'text is required');
        const id = typeof body.id === 'string' ? body.id : undefined;
        const sessionId = typeof body.sessionId === 'string' ? body.sessionId : undefined;
        const cse = typeof body.cse === 'string' ? body.cse : undefined;
        if (id) parseCcrId(id);
        if (sessionId) parseSessionId(sessionId);
        if (cse && !/^cse_[A-Za-z0-9]+$/.test(cse)) throw new TerminalError('INVALID_INPUT', 'cse must look like cse_…');
        if (!id && !sessionId && !cse) throw new TerminalError('INVALID_INPUT', 'provide one of: id, sessionId, cse');
        const preferTmux = body.preferTmux === true;
        return await ccr.drive({ id, sessionId, cse, text, preferTmux });
      }),
    },

    // ── Cloud CCR (BYOC cloud-run): claude runs in an Anthropic-cloud container ──

    // POST /ccr/cloud/start — create a cloud-run session (seed bundle + initial prompt)
    {
      method: 'POST',
      pattern: /^\/ccr\/cloud\/start$/,
      handler: async (req) => envelope(async () => {
        const body = (req.body || {}) as { prompt?: unknown; repo?: unknown; branch?: unknown; cwd?: unknown; model?: unknown; effort?: unknown; permissionMode?: unknown; title?: unknown; setup?: unknown; role?: unknown; primaryRepo?: unknown; attachments?: unknown };
        const role = body.role === 'worker' || body.role === 'orchestrator' ? body.role : undefined;
        // attachments = refs from POST /cowork/attachments ({file_uuid, file_name, is_image?})
        const attachments = Array.isArray(body.attachments)
          ? (body.attachments as any[]).filter((a) => a && typeof a.file_uuid === 'string' && typeof a.file_name === 'string')
          : undefined;
        return await ccrCloud.cloudStart({
          prompt: typeof body.prompt === 'string' ? body.prompt : undefined,
          repo: typeof body.repo === 'string' ? body.repo : undefined,
          branch: typeof body.branch === 'string' ? body.branch : undefined,
          cwd: typeof body.cwd === 'string' ? body.cwd : undefined,
          model: typeof body.model === 'string' ? body.model : undefined,
          effort: typeof body.effort === 'string' ? body.effort : undefined,
          permissionMode: typeof body.permissionMode === 'string' ? body.permissionMode : undefined,
          title: typeof body.title === 'string' ? body.title : undefined,
          setup: body.setup === true,
          role,
          primaryRepo: typeof body.primaryRepo === 'string' ? body.primaryRepo : undefined,
          attachments,
        });
      }),
    },

    // GET /ccr/cloud/repos — the user's GitHub repos (for the seed picker), most-recent first
    {
      method: 'GET',
      pattern: /^\/ccr\/cloud\/repos$/,
      handler: async () => envelope(() => ({ repos: ccrCloud.listGitHubRepos() })),
    },

    // GET /ccr/cloud/branches?repo=owner/name — branches for the selected repo (for the branch picker)
    {
      method: 'GET',
      pattern: /^\/ccr\/cloud\/branches$/,
      handler: async (req) => envelope(async () => {
        const repo = typeof req.query?.repo === 'string' ? req.query.repo : '';
        if (!repo.trim()) return { branches: [] as string[] };
        return { branches: await ccrCloud.listRepoBranches(repo) };
      }),
    },

    // GET /ccr/cloud — the account's code sessions (cloud + bridge), enriched with claude.ai/code's
    // status fields (status_bucket / worker_status / post_turn_summary). Falls back to the local
    // registry (sessions we created) when the account fetch fails (offline / no OAuth) so the page
    // still renders. `?enriched=0` forces the legacy registry-only shape.
    {
      method: 'GET',
      pattern: /^\/ccr\/cloud$/,
      handler: async (req) => envelope(async () => {
        if (req.query?.enriched === '0') return { sessions: ccrCloud.cloudList(), enriched: false };
        try {
          return { sessions: await ccrCloud.cloudListEnriched(), enriched: true };
        } catch (e) {
          // Degrade to the registry (still shows sessions we created) rather than erroring the page.
          return { sessions: ccrCloud.cloudList(), enriched: false, listError: e instanceof Error ? e.message : String(e) };
        }
      }),
    },

    // POST /ccr/cloud/:sid/rename — rename a cloud/bridge session (PUT title)
    {
      method: 'POST',
      pattern: /^\/ccr\/cloud\/(?<sid>(?:session_|cse_)[^/]+)\/rename$/,
      handler: async (req) => envelope(async () => {
        const sid = parseCloudSid(req.params.sid);
        const body = (req.body || {}) as { title?: unknown };
        const title = typeof body.title === 'string' ? body.title : '';
        if (!title.trim()) throw new TerminalError('INVALID_INPUT', 'title is required');
        return await ccrCloud.cloudRename(sid, title);
      }),
    },

    // POST /ccr/cloud/:sid/archive — archive ({archived:false} to unarchive)
    {
      method: 'POST',
      pattern: /^\/ccr\/cloud\/(?<sid>(?:session_|cse_)[^/]+)\/archive$/,
      handler: async (req) => envelope(async () => {
        const sid = parseCloudSid(req.params.sid);
        const body = (req.body || {}) as { archived?: unknown };
        const archived = body.archived === false ? false : true;
        return await ccrCloud.cloudArchive(sid, archived);
      }),
    },

    // POST /ccr/cloud/:sid/control — apply live model / permission-mode controls
    {
      method: 'POST',
      pattern: /^\/ccr\/cloud\/(?<sid>(?:session_|cse_)[^/]+)\/control$/,
      handler: async (req) => envelope(async () => {
        const sid = parseCloudSid(req.params.sid);
        const body = (req.body || {}) as { model?: unknown; permissionMode?: unknown };
        return await ccrCloud.cloudControl({
          sid,
          model: typeof body.model === 'string' ? body.model : undefined,
          permissionMode: typeof body.permissionMode === 'string' ? body.permissionMode : undefined,
        });
      }),
    },

    // POST /ccr/cloud/:sid/drive — send a follow-up turn
    {
      method: 'POST',
      pattern: /^\/ccr\/cloud\/(?<sid>(?:session_|cse_)[^/]+)\/drive$/,
      handler: async (req) => envelope(async () => {
        const sid = parseCloudSid(req.params.sid);
        const body = (req.body || {}) as { text?: unknown; reBootstrap?: unknown; role?: unknown; primaryRepo?: unknown };
        const text = typeof body.text === 'string' ? body.text : '';
        if (!text.trim()) throw new TerminalError('INVALID_INPUT', 'text is required');
        const role = body.role === 'worker' || body.role === 'orchestrator' ? body.role : undefined;
        return await ccrCloud.cloudDrive({ sid, text, reBootstrap: body.reBootstrap === true, role, primaryRepo: typeof body.primaryRepo === 'string' ? body.primaryRepo : undefined });
      }),
    },

    // POST /ccr/cloud/:sid/answer — answer a pending AskUserQuestion (tool_result).
    // answer = an option's label (a click) OR arbitrary text (free input) — both supported.
    {
      method: 'POST',
      pattern: /^\/ccr\/cloud\/(?<sid>(?:session_|cse_)[^/]+)\/answer$/,
      handler: async (req) => envelope(async () => {
        const sid = parseCloudSid(req.params.sid);
        const body = (req.body || {}) as { answer?: unknown; toolUseId?: unknown; requestId?: unknown };
        const answer = typeof body.answer === 'string' ? body.answer : '';
        if (!answer.trim()) throw new TerminalError('INVALID_INPUT', 'answer is required');
        return await ccrCloud.cloudAnswer({ sid, answer, toolUseId: typeof body.toolUseId === 'string' ? body.toolUseId : undefined, requestId: typeof body.requestId === 'string' ? body.requestId : undefined });
      }),
    },

    // POST /ccr/cloud/:sid/stop — delete the cloud session
    {
      method: 'POST',
      pattern: /^\/ccr\/cloud\/(?<sid>(?:session_|cse_)[^/]+)\/stop$/,
      handler: async (req) => envelope(async () => ccrCloud.cloudStop(parseCloudSid(req.params.sid))),
    },

    // POST /ccr/cloud/:sid/restart — STOP (kill) the old session first, then start
    // a NEW one seeded the same (repo/branch/model/title recovered; body overrides).
    // New session id; a fresh container boot fetches the CURRENT MCP tools. The old
    // container's uncommitted work is gone (fresh clone) — the response says so.
    {
      method: 'POST',
      pattern: /^\/ccr\/cloud\/(?<sid>(?:session_|cse_)[^/]+)\/restart$/,
      handler: async (req) => envelope(async () => {
        const sid = parseCloudSid(req.params.sid);
        const body = (req.body || {}) as Record<string, unknown>;
        return await ccrCloud.cloudRestart({
          sid,
          prompt: typeof body.prompt === 'string' ? body.prompt : undefined,
          repo: typeof body.repo === 'string' ? body.repo : undefined,
          branch: typeof body.branch === 'string' ? body.branch : undefined,
          model: typeof body.model === 'string' ? body.model : undefined,
          title: typeof body.title === 'string' ? body.title : undefined,
          setup: body.setup === true,
          role: body.role === 'worker' || body.role === 'orchestrator' ? body.role : undefined,
          primaryRepo: typeof body.primaryRepo === 'string' ? body.primaryRepo : undefined,
        });
      }),
    },

    // GET /ccr/cloud/:sid/status — raw cloud session status
    {
      method: 'GET',
      pattern: /^\/ccr\/cloud\/(?<sid>(?:session_|cse_)[^/]+)\/status$/,
      handler: async (req) => envelope(async () => ccrCloud.cloudStatus(parseCloudSid(req.params.sid))),
    },

    // GET /ccr/cloud/:sid — read the transcript (teleport-events). ?lastN= limits.
    {
      method: 'GET',
      pattern: /^\/ccr\/cloud\/(?<sid>(?:session_|cse_)[^/]+)$/,
      handler: async (req) => envelope(async () => {
        const sid = parseCloudSid(req.params.sid);
        const lastN = Number(req.query?.lastN);
        return await ccrCloud.cloudRead({ sid, lastN: Number.isFinite(lastN) && lastN > 0 ? lastN : undefined });
      }),
    },

    // GET /ccr/remote — registered remotes with CROSS-CHECKED liveness, plus the
    // scope this answer covers. `searched` is built HERE, on the node that actually
    // served the request, so a hub-relayed call names the right host — the MCP layer
    // would name the local one. An empty list that cannot say where it looked reads
    // as "nothing is running anywhere", which is how the original incident went.
    {
      method: 'GET',
      pattern: /^\/ccr\/remote$/,
      handler: async () => envelope(() => {
        const { rows, reaped } = ccr.list();
        return { remotes: rows, ...buildRemoteListReport(rows, whereAmI(), reaped.length) };
      }),
    },

    // GET /ccr/remote-control — local remote-control sessions: the Mission Controller +
    // mission executors (named from the mission store) + other account RC/code sessions.
    {
      method: 'GET',
      pattern: /^\/ccr\/remote-control$/,
      handler: async () => handleRemoteControlList({
        getController: () => {
          const { getControllerSession } = require('../../mission/mission-store') as typeof import('../../mission/mission-store');
          return getControllerSession();
        },
        listMissions: () => {
          const { listMissions } = require('../../mission/mission-store') as typeof import('../../mission/mission-store');
          return listMissions() as unknown as Promise<Array<Record<string, unknown>>>;
        },
        listAccount: () => ccrCloud.cloudListAccount(),
      }),
    },

    // GET /ccr/remote/:id — single remote
    {
      method: 'GET',
      pattern: /^\/ccr\/remote\/(?<id>[^/]+)$/,
      handler: async (req) => envelope(() => {
        const id = parseCcrId(req.params.id);
        const rec = ccr.get(id);
        if (!rec) throw new TerminalError('SESSION_NOT_FOUND', `ccr remote ${id} not found`);
        return rec;
      }),
    },

    // POST /ccr/remote/:id/stop — kill process and remove from registry
    {
      method: 'POST',
      pattern: /^\/ccr\/remote\/(?<id>[^/]+)\/stop$/,
      handler: async (req) => envelope(async () => {
        const id = parseCcrId(req.params.id);
        return await ccr.stop(id);
      }),
    },
  ];
}
