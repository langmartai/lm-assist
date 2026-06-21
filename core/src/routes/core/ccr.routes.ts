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

interface Envelope { success: boolean; data?: unknown; error?: { code: string; message: string; details?: unknown }; }

function ok<T>(data: T) {
  return { success: true, data } as Envelope;
}
function fail(code: string, message: string, details?: unknown) {
  return { success: false, error: { code, message, details } } as Envelope;
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
  if (!raw || typeof raw !== 'string' || !/^session_[A-Za-z0-9]+$/.test(raw)) {
    throw new TerminalError('INVALID_INPUT', 'cloud sid must look like session_…');
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
        const body = (req.body || {}) as { sessionId?: unknown };
        try {
          const sessionId = parseSessionId(body.sessionId as string | undefined);
          const data = await ccr.connect({ sessionId });
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
        const body = (req.body || {}) as { prompt?: unknown; repo?: unknown; branch?: unknown; cwd?: unknown; model?: unknown; title?: unknown; setup?: unknown };
        return await ccrCloud.cloudStart({
          prompt: typeof body.prompt === 'string' ? body.prompt : undefined,
          repo: typeof body.repo === 'string' ? body.repo : undefined,
          branch: typeof body.branch === 'string' ? body.branch : undefined,
          cwd: typeof body.cwd === 'string' ? body.cwd : undefined,
          model: typeof body.model === 'string' ? body.model : undefined,
          title: typeof body.title === 'string' ? body.title : undefined,
          setup: body.setup === true,
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

    // GET /ccr/cloud — list cloud sessions we created
    {
      method: 'GET',
      pattern: /^\/ccr\/cloud$/,
      handler: async () => envelope(() => ({ sessions: ccrCloud.cloudList() })),
    },

    // POST /ccr/cloud/:sid/drive — send a follow-up turn
    {
      method: 'POST',
      pattern: /^\/ccr\/cloud\/(?<sid>session_[^/]+)\/drive$/,
      handler: async (req) => envelope(async () => {
        const sid = parseCloudSid(req.params.sid);
        const body = (req.body || {}) as { text?: unknown };
        const text = typeof body.text === 'string' ? body.text : '';
        if (!text.trim()) throw new TerminalError('INVALID_INPUT', 'text is required');
        return await ccrCloud.cloudDrive({ sid, text });
      }),
    },

    // POST /ccr/cloud/:sid/stop — delete the cloud session
    {
      method: 'POST',
      pattern: /^\/ccr\/cloud\/(?<sid>session_[^/]+)\/stop$/,
      handler: async (req) => envelope(async () => ccrCloud.cloudStop(parseCloudSid(req.params.sid))),
    },

    // GET /ccr/cloud/:sid/status — raw cloud session status
    {
      method: 'GET',
      pattern: /^\/ccr\/cloud\/(?<sid>session_[^/]+)\/status$/,
      handler: async (req) => envelope(async () => ccrCloud.cloudStatus(parseCloudSid(req.params.sid))),
    },

    // GET /ccr/cloud/:sid — read the transcript (teleport-events). ?lastN= limits.
    {
      method: 'GET',
      pattern: /^\/ccr\/cloud\/(?<sid>session_[^/]+)$/,
      handler: async (req) => envelope(async () => {
        const sid = parseCloudSid(req.params.sid);
        const lastN = Number(req.query?.lastN);
        return await ccrCloud.cloudRead({ sid, lastN: Number.isFinite(lastN) && lastN > 0 ? lastN : undefined });
      }),
    },

    // GET /ccr/remote — list all registered remotes with liveness
    {
      method: 'GET',
      pattern: /^\/ccr\/remote$/,
      handler: async () => envelope(() => ({ remotes: ccr.list() })),
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
