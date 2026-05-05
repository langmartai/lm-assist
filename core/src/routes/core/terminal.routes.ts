/**
 * Terminal Routes
 *
 * REST endpoints for managing terminal tabs (GNOME Terminal on Linux,
 * Windows Terminal via SSH on Windows) and controlling them through tmux.
 *
 * All endpoints are also reachable cross-machine via the Hub API relay —
 * the caller targets whichever lm-assist host actually owns the tmux
 * session (or the GUI capable of opening the desired tab kind).
 *
 * Tab lifecycle:
 *   POST   /terminal/tabs                            Create a new tab
 *   GET    /terminal/tabs                            List tabs tracked by this host
 *   GET    /terminal/tabs/:id                        Get one tab record
 *   DELETE /terminal/tabs/:id                        Remove tab (kills its tmux session)
 *
 * tmux control (this host's tmux server):
 *   GET    /terminal/tmux                            list-sessions
 *   POST   /terminal/tmux                            new-session (detached)
 *   DELETE /terminal/tmux/:name                      kill-session
 *   POST   /terminal/tmux/:name/send-keys            send-keys (optional -l, optional Enter)
 *   GET    /terminal/tmux/:name/capture              capture-pane -p
 *   POST   /terminal/tmux/:name/wait-for             poll capture-pane until pattern matches
 *
 * Claude Code convenience layer (tmux-pivot pattern):
 *   POST   /terminal/cc/:name/launch                 create tmux + run `claude` + wait for ready
 *   POST   /terminal/cc/:name/pivot                  /resume <id> + re-send prompt
 *   POST   /terminal/cc/:name/prompt                 send literal prompt + Enter
 */

import type { RouteHandler, RouteContext } from '../index';
import {
  getTerminalManager,
  tmuxList, tmuxCreate, tmuxKill, tmuxSendKeys, tmuxCapture, tmuxWaitFor,
  TmuxError, type CreateTabOptions,
} from '../../terminal-manager';
import { IS_WINDOWS } from '../../utils/process-utils';

function ok<T>(data: T) {
  return { success: true, data };
}
function fail(message: string) {
  return { success: false, error: { code: 'TERMINAL_ERROR', message } } as any;
}
function handleTmuxErr(e: unknown) {
  if (e instanceof TmuxError) return fail(e.message);
  const msg = e instanceof Error ? e.message : String(e);
  return fail(msg);
}

export function createTerminalRoutes(_ctx: RouteContext): RouteHandler[] {
  const mgr = getTerminalManager();

  return [
    // --------- Tabs ----------------------------------------------------

    // POST /terminal/tabs — create a tab
    {
      method: 'POST',
      pattern: /^\/terminal\/tabs$/,
      handler: async (req) => {
        const body: CreateTabOptions = req.body || {};
        try {
          const rec = mgr.createTab(body);
          return ok(rec);
        } catch (e) {
          return handleTmuxErr(e);
        }
      },
    },

    // GET /terminal/tabs — list tabs
    {
      method: 'GET',
      pattern: /^\/terminal\/tabs$/,
      handler: async () => ok({ tabs: mgr.listTabs() }),
    },

    // GET /terminal/tabs/:id
    {
      method: 'GET',
      pattern: /^\/terminal\/tabs\/(?<id>[^/]+)$/,
      handler: async (req) => {
        const rec = mgr.getTab(req.params.id);
        if (!rec) return fail('tab not found');
        return ok(rec);
      },
    },

    // DELETE /terminal/tabs/:id
    {
      method: 'DELETE',
      pattern: /^\/terminal\/tabs\/(?<id>[^/]+)$/,
      handler: async (req) => {
        const res = mgr.deleteTab(req.params.id);
        if (!res.removed) return fail('tab not found');
        return ok(res);
      },
    },

    // --------- tmux sessions -------------------------------------------

    // GET /terminal/tmux — list sessions
    {
      method: 'GET',
      pattern: /^\/terminal\/tmux$/,
      handler: async () => {
        if (IS_WINDOWS) return ok({ sessions: [], platformSupported: false });
        try { return ok({ sessions: tmuxList(), platformSupported: true }); }
        catch (e) { return handleTmuxErr(e); }
      },
    },

    // POST /terminal/tmux — create a detached session (persistent).
    // If `command` is given it is sent via send-keys after creation, so the
    // shell stays alive after the command exits. For "run command as shell
    // and exit" semantics use a plain `tmux` CLI call instead.
    {
      method: 'POST',
      pattern: /^\/terminal\/tmux$/,
      handler: async (req) => {
        const { name, cwd, cols, rows, command } = req.body || {};
        if (!name) return fail('name is required');
        try {
          tmuxCreate({ name, cwd, cols, rows });
          if (command) tmuxSendKeys(name, { keys: command, enter: true });
          return ok({ name });
        } catch (e) { return handleTmuxErr(e); }
      },
    },

    // DELETE /terminal/tmux/:name
    {
      method: 'DELETE',
      pattern: /^\/terminal\/tmux\/(?<name>[^/]+)$/,
      handler: async (req) => {
        try { tmuxKill(req.params.name); return ok({ killed: req.params.name }); }
        catch (e) { return handleTmuxErr(e); }
      },
    },

    // POST /terminal/tmux/:name/send-keys
    {
      method: 'POST',
      pattern: /^\/terminal\/tmux\/(?<name>[^/]+)\/send-keys$/,
      handler: async (req) => {
        const { keys, literal, enter, target } = req.body || {};
        if (typeof keys !== 'string') return fail('keys (string) required');
        try {
          tmuxSendKeys(req.params.name, { keys, literal, enter, target });
          return ok({ sent: true });
        } catch (e) { return handleTmuxErr(e); }
      },
    },

    // GET /terminal/tmux/:name/capture
    {
      method: 'GET',
      pattern: /^\/terminal\/tmux\/(?<name>[^/]+)\/capture$/,
      handler: async (req) => {
        const lines = req.query.lines ? parseInt(req.query.lines, 10) : undefined;
        const start = req.query.start ? parseInt(req.query.start, 10) : undefined;
        const target = req.query.target;
        try {
          const screen = tmuxCapture(req.params.name, { lines, start, target });
          return ok({ screen });
        } catch (e) { return handleTmuxErr(e); }
      },
    },

    // POST /terminal/tmux/:name/wait-for
    {
      method: 'POST',
      pattern: /^\/terminal\/tmux\/(?<name>[^/]+)\/wait-for$/,
      handler: async (req) => {
        const { pattern, literal, flags, timeoutMs, pollMs, target, lines } = req.body || {};
        if (typeof pattern !== 'string') return fail('pattern (string) required');
        try {
          const res = await tmuxWaitFor(req.params.name, { pattern, literal, flags, timeoutMs, pollMs, target, lines });
          return ok(res);
        } catch (e) { return handleTmuxErr(e); }
      },
    },

    // --------- Claude Code wrappers ------------------------------------

    // POST /terminal/cc/:name/launch
    {
      method: 'POST',
      pattern: /^\/terminal\/cc\/(?<name>[^/]+)\/launch$/,
      handler: async (req) => {
        const { cwd, model, flags, readyPattern, readyTimeoutMs } = req.body || {};
        if (!cwd) return fail('cwd is required');
        try {
          const res = await mgr.ccLaunch({
            tmuxSession: req.params.name,
            cwd, model, flags, readyPattern, readyTimeoutMs,
          });
          return ok(res);
        } catch (e) { return handleTmuxErr(e); }
      },
    },

    // POST /terminal/cc/:name/pivot
    {
      method: 'POST',
      pattern: /^\/terminal\/cc\/(?<name>[^/]+)\/pivot$/,
      handler: async (req) => {
        const { newSessionId, prompt, promptPattern, timeoutMs } = req.body || {};
        if (!newSessionId || !prompt) return fail('newSessionId and prompt required');
        try {
          const res = await mgr.ccPivot({
            tmuxSession: req.params.name,
            newSessionId, prompt, promptPattern, timeoutMs,
          });
          return ok(res);
        } catch (e) { return handleTmuxErr(e); }
      },
    },

    // POST /terminal/cc/:name/prompt
    {
      method: 'POST',
      pattern: /^\/terminal\/cc\/(?<name>[^/]+)\/prompt$/,
      handler: async (req) => {
        const { text } = req.body || {};
        if (typeof text !== 'string') return fail('text (string) required');
        try {
          mgr.ccPrompt(req.params.name, text);
          return ok({ sent: true });
        } catch (e) { return handleTmuxErr(e); }
      },
    },
  ];
}
