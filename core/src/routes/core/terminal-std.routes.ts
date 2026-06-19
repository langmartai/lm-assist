/**
 * Standardized terminal routes — the unified, cross-platform grammar that
 * dispatches through the TerminalBackend / CcController interfaces (backend.ts),
 * so the same URLs behave identically on Linux (tmux) and Windows (wt).
 *
 *   Generic terminal (platform-neutral — lm-assist auto-picks its own backend):
 *     GET    /terminal/local                 list terminals
 *     POST   /terminal/local                 launch a command -> new terminal
 *     GET    /terminal/local/:id/capture     read screen text
 *     POST   /terminal/local/:id/send-keys   send keystrokes/text
 *     DELETE /terminal/local/:id             close
 *
 *   `/terminal/local/*` dispatches through getTerminalBackend(), which resolves
 *   to tmux on Linux and wt on Windows — the caller never names the OS. The
 *   richer tmux-native low-level routes remain at /terminal/tmux/* (Linux only).
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
  return [
    // ── Generic local terminal (/terminal/local/*) — backend auto-picked ────
    // getTerminalBackend() resolves to tmux (Linux) or wt (Windows); the caller
    // never names the OS. Resolved per-request so a backend that becomes
    // available after boot (or in tests) is picked up without a restart.
    {
      method: 'GET',
      pattern: /^\/terminal\/local$/,
      handler: async (): Promise<Envelope> => {
        const backend = getTerminalBackend();
        return !backend.available() ? notSupported(backend.id) : wrap(async () => ({ backend: backend.id, terminals: await backend.list() }));
      },
    },
    {
      method: 'POST',
      pattern: /^\/terminal\/local$/,
      handler: async (req: ParsedRequest): Promise<Envelope> => {
        const backend = getTerminalBackend();
        if (!backend.available()) return notSupported(backend.id);
        const b = (req.body ?? {}) as { command?: string; cwd?: string; mode?: string };
        if (typeof b.command !== 'string' || !b.command) return fail('INVALID_BODY', 'body.command (non-empty string) is required');
        return wrap(() => backend.create({ command: b.command!, cwd: b.cwd, mode: b.mode }));
      },
    },
    {
      method: 'GET',
      pattern: /^\/terminal\/local\/(?<id>[^/]+)\/capture$/,
      handler: async (req: ParsedRequest): Promise<Envelope> => {
        const backend = getTerminalBackend();
        return !backend.available() ? notSupported(backend.id) : wrap(() => backend.capture(req.params.id));
      },
    },
    {
      method: 'POST',
      pattern: /^\/terminal\/local\/(?<id>[^/]+)\/send-keys$/,
      handler: async (req: ParsedRequest): Promise<Envelope> => {
        const backend = getTerminalBackend();
        if (!backend.available()) return notSupported(backend.id);
        const b = (req.body ?? {}) as { keys?: string; enter?: boolean; literal?: boolean };
        if (typeof b.keys !== 'string') return fail('INVALID_BODY', 'body.keys (string) is required');
        return wrap(async () => {
          await backend.sendKeys(req.params.id, { keys: b.keys!, enter: b.enter, literal: b.literal });
          return { sent: true };
        });
      },
    },
    {
      method: 'DELETE',
      pattern: /^\/terminal\/local\/(?<id>[^/]+)$/,
      handler: async (req: ParsedRequest): Promise<Envelope> => {
        const backend = getTerminalBackend();
        return !backend.available() ? notSupported(backend.id) : wrap(async () => {
          await backend.close(req.params.id);
          return { closed: req.params.id };
        });
      },
    },

    // ── Claude Code sessions (/terminal/cc-sessions/*) — both platforms ─────
    {
      method: 'GET',
      pattern: /^\/terminal\/cc-sessions$/,
      handler: async (): Promise<Envelope> =>
        wrap(async () => {
          const cc = getCcController();
          const sessions = await cc.list();
          // include the ownership verdict per session, but keep ONLY its new
          // fields — the full verdict re-states sessionId/jsonl/owner/inTmux/
          // tmuxSession/pane which each session already carries (~2x payload).
          const withVerdict = sessions.map((s) => {
            const v = cc.verdict(s.sessionId);
            return {
              ...s,
              verdict: {
                live: v.live,
                allowedModes: v.allowedModes,
                connectStrategy: v.connectStrategy,
                safeToCreateTmux: v.safeToCreateTmux,
                reason: v.reason,
              },
            };
          });
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
