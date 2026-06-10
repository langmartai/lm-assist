/**
 * Standardized terminal routes — the unified, cross-platform grammar that
 * dispatches through the TerminalBackend / CcController interfaces (backend.ts),
 * so the same URLs behave identically on Linux (tmux) and Windows (wt).
 *
 *   Generic terminal (backend-prefixed):
 *     GET    /terminal/wt                 list terminals          (Windows; Linux uses /terminal/tmux)
 *     POST   /terminal/wt                 launch a command -> new terminal
 *     GET    /terminal/wt/:id/capture     read screen text
 *     POST   /terminal/wt/:id/send-keys   send keystrokes/text
 *     DELETE /terminal/wt/:id             close
 *
 *   Claude Code sessions (sessionId-keyed, SAME on both platforms):
 *     GET    /terminal/cc-sessions             list live CC sessions + driveable
 *     GET    /terminal/cc-sessions/:id         one session (verdict + mapping)
 *     POST   /terminal/cc-sessions             launch a new Claude session
 *     DELETE /terminal/cc-sessions/:id         terminate (?closeTab=)
 *     POST   /terminal/cc-sessions/:id/prompt  send a prompt { text, submit? }
 *     GET    /terminal/cc-sessions/:id/screen  capture + classify { text, state, ... }
 *     POST   /terminal/cc-sessions/:id/auto-handle  { trust?, answer? }
 *     POST   /terminal/cc-sessions/:id/interrupt    Ctrl-C
 */

import type { RouteHandler, RouteContext, ParsedRequest } from '../index';
import { getCcController, getTerminalBackend } from '../../terminal/backend';
import { wtTerminalBackend } from '../../terminal/wt-backend';

interface Envelope {
  success: boolean;
  data?: unknown;
  error?: { code: string; message: string; details?: unknown };
}
const ok = <T>(data: T): Envelope => ({ success: true, data });
const fail = (code: string, message: string, details?: unknown): Envelope => ({ success: false, error: { code, message, details } });

function wrap(fn: () => Promise<unknown> | unknown): Promise<Envelope> {
  return Promise.resolve()
    .then(fn)
    .then((data) => ok(data))
    .catch((e: unknown) => fail('INTERNAL_ERROR', e instanceof Error ? e.message : String(e)));
}

export function createTerminalStdRoutes(_ctx: RouteContext): RouteHandler[] {
  // The generic terminal backend keyed by URL prefix. Only Windows (wt) is
  // exposed here; Linux generic remains /terminal/tmux/* (richer, in terminal.routes.ts).
  const wt = wtTerminalBackend;

  return [
    // ── Generic Windows Terminal backend (/terminal/wt/*) ──────────────────
    {
      method: 'GET',
      pattern: /^\/terminal\/wt$/,
      handler: async (): Promise<Envelope> =>
        !wt.available() ? notSupported('wt') : wrap(async () => ({ terminals: await wt.list() })),
    },
    {
      method: 'POST',
      pattern: /^\/terminal\/wt$/,
      handler: async (req: ParsedRequest): Promise<Envelope> => {
        if (!wt.available()) return notSupported('wt');
        const b = (req.body ?? {}) as { command?: string; cwd?: string; mode?: string };
        if (typeof b.command !== 'string' || !b.command) return fail('INVALID_BODY', 'body.command (non-empty string) is required');
        return wrap(() => wt.create({ command: b.command!, cwd: b.cwd, mode: b.mode }));
      },
    },
    {
      method: 'GET',
      pattern: /^\/terminal\/wt\/(?<id>[^/]+)\/capture$/,
      handler: async (req: ParsedRequest): Promise<Envelope> =>
        !wt.available() ? notSupported('wt') : wrap(() => wt.capture(req.params.id)),
    },
    {
      method: 'POST',
      pattern: /^\/terminal\/wt\/(?<id>[^/]+)\/send-keys$/,
      handler: async (req: ParsedRequest): Promise<Envelope> => {
        if (!wt.available()) return notSupported('wt');
        const b = (req.body ?? {}) as { keys?: string; enter?: boolean; literal?: boolean };
        if (typeof b.keys !== 'string') return fail('INVALID_BODY', 'body.keys (string) is required');
        return wrap(async () => {
          await wt.sendKeys(req.params.id, { keys: b.keys!, enter: b.enter, literal: b.literal });
          return { sent: true };
        });
      },
    },
    {
      method: 'DELETE',
      pattern: /^\/terminal\/wt\/(?<id>[^/]+)$/,
      handler: async (req: ParsedRequest): Promise<Envelope> =>
        !wt.available() ? notSupported('wt') : wrap(async () => {
          await wt.close(req.params.id);
          return { closed: req.params.id };
        }),
    },

    // ── Claude Code sessions (/terminal/cc-sessions/*) — both platforms ─────
    {
      method: 'GET',
      pattern: /^\/terminal\/cc-sessions$/,
      handler: async (): Promise<Envelope> =>
        wrap(async () => {
          const cc = getCcController();
          const sessions = await cc.list();
          // include the ownership verdict per session (parity with the legacy route)
          const withVerdict = sessions.map((s) => ({ ...s, verdict: cc.verdict(s.sessionId) }));
          return { backend: getTerminalBackend().id, liveCount: sessions.length, sessions: withVerdict };
        }),
    },
    {
      method: 'POST',
      pattern: /^\/terminal\/cc-sessions$/,
      handler: async (req: ParsedRequest): Promise<Envelope> =>
        wrap(() => getCcController().launch((req.body ?? {}) as Record<string, unknown>)),
    },
    {
      method: 'GET',
      pattern: /^\/terminal\/cc-sessions\/(?<id>[^/]+)$/,
      handler: async (req: ParsedRequest): Promise<Envelope> =>
        wrap(() => getCcController().verdict(req.params.id)),
    },
    {
      method: 'DELETE',
      pattern: /^\/terminal\/cc-sessions\/(?<id>[^/]+)$/,
      handler: async (req: ParsedRequest): Promise<Envelope> => {
        const closeTab = req.query?.closeTab === 'true' || (req.body as { closeTab?: boolean })?.closeTab === true;
        return wrap(() => getCcController().close(req.params.id, { closeTab }));
      },
    },
    {
      method: 'POST',
      pattern: /^\/terminal\/cc-sessions\/(?<id>[^/]+)\/prompt$/,
      handler: async (req: ParsedRequest): Promise<Envelope> => {
        const b = (req.body ?? {}) as { text?: string; submit?: boolean };
        if (typeof b.text !== 'string' || !b.text) return fail('INVALID_BODY', 'body.text (non-empty string) is required');
        return wrap(() => getCcController().prompt(req.params.id, b.text!, { submit: b.submit }));
      },
    },
    {
      method: 'GET',
      pattern: /^\/terminal\/cc-sessions\/(?<id>[^/]+)\/screen$/,
      handler: async (req: ParsedRequest): Promise<Envelope> => wrap(() => getCcController().screen(req.params.id)),
    },
    {
      method: 'POST',
      pattern: /^\/terminal\/cc-sessions\/(?<id>[^/]+)\/auto-handle$/,
      handler: async (req: ParsedRequest): Promise<Envelope> => {
        const b = (req.body ?? {}) as { trust?: boolean; answer?: number };
        return wrap(() => getCcController().autoHandle(req.params.id, { trust: b.trust, answer: b.answer }));
      },
    },
    {
      method: 'POST',
      pattern: /^\/terminal\/cc-sessions\/(?<id>[^/]+)\/interrupt$/,
      handler: async (req: ParsedRequest): Promise<Envelope> =>
        wrap(async () => {
          await getCcController().interrupt(req.params.id);
          return { interrupted: req.params.id };
        }),
    },
  ];
}

function notSupported(backend: string): Envelope {
  return fail('NOT_SUPPORTED', `the ${backend} terminal backend is not available on this host`);
}
