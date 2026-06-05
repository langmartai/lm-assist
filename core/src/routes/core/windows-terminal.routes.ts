/**
 * Windows Terminal Routes — the Windows substitute for the tmux send-keys API.
 *
 * On Linux, a live Claude Code session lives in a tmux pane and is driven via
 * /terminal/tmux/:name/send-keys. Windows has no tmux: sessions run in Windows
 * Terminal tabs. These routes list live sessions with their WT window/tab
 * mapping and drive them by bringing the window/tab to the front and pasting
 * text (focus + send-keys equivalent). Backed by terminal/windows-terminal.ts.
 *
 * Endpoints:
 *   GET  /terminal/windows/sessions               list live CC sessions + window mapping + driveable verdict
 *   GET  /terminal/windows/sessions/:sessionId     one session (verdict + window mapping)
 *   POST /terminal/windows/sessions/:sessionId/focus   bring its window/tab to the front
 *   POST /terminal/windows/sessions/:sessionId/send    focus + paste { text, submit? }
 *
 * All endpoints return { success, data } / { success, error }. On non-Windows
 * hosts they return success:false with code NOT_SUPPORTED.
 */

import type { RouteHandler, RouteContext, ParsedRequest } from '../index';
import { IS_WINDOWS } from '../../utils/process-utils';
import { listLiveSessions, sessionVerdict } from '../../terminal/cc-sessions';
import {
  listWindowsSessions,
  mapPidsToWindows,
  focusAndSend,
  launchSession,
  closeSession,
  getTabRid,
  forgetTabRid,
} from '../../terminal/windows-terminal';

interface Envelope {
  success: boolean;
  data?: unknown;
  error?: { code: string; message: string; details?: unknown };
}

function ok<T>(data: T): Envelope {
  return { success: true, data };
}
function fail(code: string, message: string, details?: unknown): Envelope {
  return { success: false, error: { code, message, details } };
}

function notSupported(): Envelope {
  return fail(
    'NOT_SUPPORTED',
    'Windows terminal control is only available on Windows hosts. On Linux use the tmux terminal API (/terminal/tmux/*).',
  );
}

/** Resolve a sessionId to its live owner pid, or null if not a live session. */
function pidForSession(sessionId: string): number | null {
  const s = listLiveSessions().find((x) => x.sessionId === sessionId);
  return s ? s.owner.pid : null;
}

export function createWindowsTerminalRoutes(_ctx: RouteContext): RouteHandler[] {
  return [
    // GET /terminal/windows/sessions
    {
      method: 'GET',
      pattern: /^\/terminal\/windows\/sessions$/,
      handler: async (): Promise<Envelope> => {
        if (!IS_WINDOWS) return notSupported();
        try {
          const sessions = await listWindowsSessions();
          return ok({ sessions, count: sessions.length });
        } catch (e) {
          return fail('INTERNAL_ERROR', (e as Error).message);
        }
      },
    },

    // POST /terminal/windows/sessions  { cwd?, mode?: 'window'|'tab', resume?, waitMs? }
    // Create: launch a new Claude Code session in a WT window (default) or tab.
    {
      method: 'POST',
      pattern: /^\/terminal\/windows\/sessions$/,
      handler: async (req: ParsedRequest): Promise<Envelope> => {
        if (!IS_WINDOWS) return notSupported();
        const body = (req.body ?? {}) as {
          cwd?: string;
          mode?: 'window' | 'tab';
          resume?: string;
          waitMs?: number;
        };
        if (body.mode && body.mode !== 'window' && body.mode !== 'tab') {
          return fail('INVALID_BODY', "mode must be 'window' or 'tab'");
        }
        try {
          const res = await launchSession(body);
          return ok(res);
        } catch (e) {
          return fail('INTERNAL_ERROR', (e as Error).message);
        }
      },
    },

    // DELETE /terminal/windows/sessions/:sessionId  ?closeTab=true | { closeTab? }
    // Delete: terminate the session (optionally close its tab/window).
    {
      method: 'DELETE',
      pattern: /^\/terminal\/windows\/sessions\/(?<sessionId>[^/]+)$/,
      handler: async (req: ParsedRequest): Promise<Envelope> => {
        if (!IS_WINDOWS) return notSupported();
        const sessionId = req.params.sessionId;
        const closeTab =
          req.query?.closeTab === 'true' || (req.body && (req.body as { closeTab?: boolean }).closeTab === true);
        const pid = pidForSession(sessionId);
        if (!pid) return fail('SESSION_NOT_LIVE', `no live session ${sessionId} on this host`);
        try {
          const res = await closeSession(pid, !!closeTab, getTabRid(sessionId));
          if (res.ok) forgetTabRid(sessionId);
          return res.ok ? ok({ sessionId, ...res }) : fail('CLOSE_FAILED', res.error || 'close failed', res);
        } catch (e) {
          return fail('INTERNAL_ERROR', (e as Error).message);
        }
      },
    },

    // GET /terminal/windows/sessions/:sessionId
    {
      method: 'GET',
      pattern: /^\/terminal\/windows\/sessions\/(?<sessionId>[^/]+)$/,
      handler: async (req: ParsedRequest): Promise<Envelope> => {
        if (!IS_WINDOWS) return notSupported();
        const sessionId = req.params.sessionId;
        try {
          const verdict = sessionVerdict(sessionId);
          const pid = verdict.owner?.pid ?? pidForSession(sessionId);
          const win = pid ? (await mapPidsToWindows([pid]))[0] ?? null : null;
          return ok({ sessionId, verdict, win, driveable: !!(win && win.driveable) });
        } catch (e) {
          return fail('INTERNAL_ERROR', (e as Error).message);
        }
      },
    },

    // POST /terminal/windows/sessions/:sessionId/focus
    {
      method: 'POST',
      pattern: /^\/terminal\/windows\/sessions\/(?<sessionId>[^/]+)\/focus$/,
      handler: async (req: ParsedRequest): Promise<Envelope> => {
        if (!IS_WINDOWS) return notSupported();
        const sessionId = req.params.sessionId;
        const pid = pidForSession(sessionId);
        if (!pid) return fail('SESSION_NOT_LIVE', `no live session ${sessionId} on this host`);
        try {
          const res = await focusAndSend({ pid, rid: getTabRid(sessionId) });
          return res.ok ? ok(res) : fail('NOT_LOCATABLE', res.error || 'could not focus', { origTitle: res.origTitle });
        } catch (e) {
          return fail('INTERNAL_ERROR', (e as Error).message);
        }
      },
    },

    // POST /terminal/windows/sessions/:sessionId/send  { text, submit? }
    {
      method: 'POST',
      pattern: /^\/terminal\/windows\/sessions\/(?<sessionId>[^/]+)\/send$/,
      handler: async (req: ParsedRequest): Promise<Envelope> => {
        if (!IS_WINDOWS) return notSupported();
        const sessionId = req.params.sessionId;
        const body = (req.body ?? {}) as { text?: string; submit?: boolean };
        if (typeof body.text !== 'string' || body.text.length === 0) {
          return fail('INVALID_BODY', 'body.text (non-empty string) is required');
        }
        const pid = pidForSession(sessionId);
        if (!pid) return fail('SESSION_NOT_LIVE', `no live session ${sessionId} on this host`);
        try {
          const res = await focusAndSend({ pid, rid: getTabRid(sessionId), text: body.text, submit: !!body.submit });
          return res.ok ? ok(res) : fail('NOT_LOCATABLE', res.error || 'could not send', { origTitle: res.origTitle });
        } catch (e) {
          return fail('INTERNAL_ERROR', (e as Error).message);
        }
      },
    },
  ];
}
