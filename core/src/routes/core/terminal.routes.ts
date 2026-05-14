/**
 * Terminal Routes — thin pass-throughs to the layered terminal/ modules.
 *
 * Every body goes through validate.* before reaching the manager. URL :name
 * is the SOURCE OF TRUTH for the session; body cannot override it (the body
 * may carry a `paneQualifier` like "0.1" to target a specific pane within
 * the URL session).
 *
 * Error handling: TerminalError carries a typed code that maps to an HTTP
 * status (see errors.ts). Everything else becomes a generic 500.
 */

import type { RouteHandler, RouteContext, ParsedRequest } from '../index';
import { IS_WINDOWS } from '../../utils/process-utils';
import { TerminalError, httpStatusFor } from '../../terminal/errors';
import * as validate from '../../terminal/validate';
import * as manager from '../../terminal/manager';
import * as tmux from '../../terminal/tmux';
import * as cc from '../../terminal/cc';
import { withAudit } from '../../terminal/audit';

interface Envelope { success: boolean; data?: unknown; error?: { code: string; message: string; details?: unknown }; }

function ok<T>(data: T, status = 200) {
  return { status, body: { success: true, data } as Envelope };
}
function failEnv(code: string, message: string, status: number, details?: unknown) {
  return { status, body: { success: false, error: { code, message, details } } as Envelope };
}

function handle<T>(fn: () => Promise<T> | T): Promise<{ status: number; body: Envelope }> {
  return Promise.resolve()
    .then(fn)
    .then((data) => ok(data))
    .catch((e: unknown) => {
      if (e instanceof TerminalError) {
        return failEnv(e.code, e.message, httpStatusFor(e.code), e.details);
      }
      const err = e as Error;
      return failEnv('INTERNAL_ERROR', err.message || String(e), 500);
    });
}

// Note: existing route handlers in this codebase return a plain envelope
// (not {status, body}). Keep the same convention — the route layer doesn't
// expose HTTP status codes today. We still compute the code so audit/logs
// reflect the right severity, but only the envelope is returned.
async function envelope<T>(fn: () => Promise<T> | T) {
  const res = await handle(fn);
  return res.body;
}

function callerFromReq(req: ParsedRequest): string | undefined {
  const headers = req.raw?.req?.headers as Record<string, string | string[] | undefined> | undefined;
  const h = headers?.['x-lm-caller'];
  if (Array.isArray(h)) return h[0];
  return typeof h === 'string' ? h : undefined;
}

export function createTerminalRoutes(_ctx: RouteContext): RouteHandler[] {
  return [
    // --------- Tabs ----------------------------------------------------

    // POST /terminal/tabs
    {
      method: 'POST',
      pattern: /^\/terminal\/tabs$/,
      handler: async (req) => envelope(async () => {
        const parsed = validate.parseCreateTab(req.body);
        return await manager.createTab(parsed, callerFromReq(req));
      }),
    },

    // GET /terminal/tabs
    {
      method: 'GET',
      pattern: /^\/terminal\/tabs$/,
      handler: async () => envelope(() => ({ tabs: manager.listTabs() })),
    },

    // GET /terminal/tabs/:id
    {
      method: 'GET',
      pattern: /^\/terminal\/tabs\/(?<id>[^/]+)$/,
      handler: async (req) => envelope(() => {
        const id = validate.parseTabId(req.params.id);
        const rec = manager.getTab(id);
        if (!rec) throw new TerminalError('SESSION_NOT_FOUND', 'tab not found');
        return rec;
      }),
    },

    // DELETE /terminal/tabs/:id
    {
      method: 'DELETE',
      pattern: /^\/terminal\/tabs\/(?<id>[^/]+)$/,
      handler: async (req) => envelope(async () => {
        const id = validate.parseTabId(req.params.id);
        return await manager.deleteTab(id, callerFromReq(req));
      }),
    },

    // POST /terminal/tabs/prune-dead
    {
      method: 'POST',
      pattern: /^\/terminal\/tabs\/prune-dead$/,
      handler: async (req) => envelope(async () => await manager.pruneDead(callerFromReq(req))),
    },

    // POST /terminal/windows/close — close all gnome-terminal windows in a
    // windowGroup (closes orphan tabs the registry can no longer reach).
    {
      method: 'POST',
      pattern: /^\/terminal\/windows\/close$/,
      handler: async (req) => envelope(async () => {
        const body = (req.body || {}) as { windowGroup?: unknown };
        const group = typeof body.windowGroup === 'string' && body.windowGroup.length > 0
          ? body.windowGroup
          : 'lm-assist';
        return await manager.closeWindows(group, callerFromReq(req));
      }),
    },

    // --------- tmux sessions -------------------------------------------

    // GET /terminal/tmux
    {
      method: 'GET',
      pattern: /^\/terminal\/tmux$/,
      handler: async () => envelope(() => {
        if (IS_WINDOWS) return { sessions: [], platformSupported: false };
        return { sessions: tmux.list(), platformSupported: true };
      }),
    },

    // POST /terminal/tmux
    {
      method: 'POST',
      pattern: /^\/terminal\/tmux$/,
      handler: async (req) => envelope(async () => {
        const p = validate.parseCreateTmux(req.body);
        return await withAudit({ op: 'tmux.create', session: p.name, caller: callerFromReq(req) }, async () => {
          const res = await tmux.create(p.name, { cwd: p.cwd, cols: p.cols, rows: p.rows });
          if (p.command) {
            await tmux.sendKeys(p.name, { keys: p.command, literal: false, enter: true, paneQualifier: null });
          }
          return { name: p.name, existed: res.existed };
        });
      }),
    },

    // DELETE /terminal/tmux/:name
    {
      method: 'DELETE',
      pattern: /^\/terminal\/tmux\/(?<name>[^/]+)$/,
      handler: async (req) => envelope(async () => {
        const name = validate.parseSessionName(req.params.name);
        return await withAudit({ op: 'tmux.kill', session: name, caller: callerFromReq(req) }, async () => {
          return await tmux.kill(name);
        });
      }),
    },

    // POST /terminal/tmux/:name/send-keys
    {
      method: 'POST',
      pattern: /^\/terminal\/tmux\/(?<name>[^/]+)\/send-keys$/,
      handler: async (req) => envelope(async () => {
        const name = validate.parseSessionName(req.params.name);
        const p = validate.parseSendKeys(req.body);
        return await withAudit({ op: 'tmux.sendKeys', session: name, caller: callerFromReq(req) }, async () => {
          await tmux.sendKeys(name, p);
          return { sent: true };
        });
      }),
    },

    // GET /terminal/tmux/:name/capture
    {
      method: 'GET',
      pattern: /^\/terminal\/tmux\/(?<name>[^/]+)\/capture$/,
      handler: async (req) => envelope(() => {
        const name = validate.parseSessionName(req.params.name);
        const p = validate.parseCapture(req.query);
        return { screen: tmux.capture(name, p) };
      }),
    },

    // POST /terminal/tmux/:name/wait-for
    {
      method: 'POST',
      pattern: /^\/terminal\/tmux\/(?<name>[^/]+)\/wait-for$/,
      handler: async (req) => envelope(async () => {
        const name = validate.parseSessionName(req.params.name);
        const p = validate.parseWaitFor(req.body);
        return await tmux.waitFor(name, p);
      }),
    },

    // GET /terminal/tmux/:name/windows — list windows in session
    {
      method: 'GET',
      pattern: /^\/terminal\/tmux\/(?<name>[^/]+)\/windows$/,
      handler: async (req) => envelope(() => {
        const name = validate.parseSessionName(req.params.name);
        return { windows: tmux.listWindows(name) };
      }),
    },

    // POST /terminal/tmux/:name/windows — create new window
    {
      method: 'POST',
      pattern: /^\/terminal\/tmux\/(?<name>[^/]+)\/windows$/,
      handler: async (req) => envelope(async () => {
        const name = validate.parseSessionName(req.params.name);
        const p = validate.parseCreateWindow(req.body);
        return await withAudit({ op: 'tmux.newWindow', session: name, caller: callerFromReq(req), details: { name: p.name } }, async () => {
          return await tmux.createWindow(name, p);
        });
      }),
    },

    // POST /terminal/tmux/:name/windows/:target/select — focus window
    {
      method: 'POST',
      pattern: /^\/terminal\/tmux\/(?<name>[^/]+)\/windows\/(?<target>[^/]+)\/select$/,
      handler: async (req) => envelope(async () => {
        const name = validate.parseSessionName(req.params.name);
        const target = validate.parseWindowTarget(req.params.target);
        await tmux.selectWindow(name, target);
        return { selected: target };
      }),
    },

    // DELETE /terminal/tmux/:name/windows/:target — kill specific window
    {
      method: 'DELETE',
      pattern: /^\/terminal\/tmux\/(?<name>[^/]+)\/windows\/(?<target>[^/]+)$/,
      handler: async (req) => envelope(async () => {
        const name = validate.parseSessionName(req.params.name);
        const target = validate.parseWindowTarget(req.params.target);
        return await withAudit({ op: 'tmux.killWindow', session: name, caller: callerFromReq(req), details: { target } }, async () => {
          return await tmux.killWindow(name, target);
        });
      }),
    },

    // --------- Claude Code wrappers ------------------------------------

    // POST /terminal/cc/:name/launch
    {
      method: 'POST',
      pattern: /^\/terminal\/cc\/(?<name>[^/]+)\/launch$/,
      handler: async (req) => envelope(async () => {
        const name = validate.parseSessionName(req.params.name);
        const p = validate.parseCCLaunch(req.body);
        return await withAudit({ op: 'cc.launch', session: name, caller: callerFromReq(req) }, async () => {
          return await cc.launch(name, p);
        });
      }),
    },

    // POST /terminal/cc/:name/pivot
    {
      method: 'POST',
      pattern: /^\/terminal\/cc\/(?<name>[^/]+)\/pivot$/,
      handler: async (req) => envelope(async () => {
        const name = validate.parseSessionName(req.params.name);
        const p = validate.parseCCPivot(req.body);
        return await withAudit({ op: 'cc.pivot', session: name, caller: callerFromReq(req) }, async () => {
          return await cc.pivot(name, p);
        });
      }),
    },

    // POST /terminal/cc/:name/prompt
    {
      method: 'POST',
      pattern: /^\/terminal\/cc\/(?<name>[^/]+)\/prompt$/,
      handler: async (req) => envelope(async () => {
        const name = validate.parseSessionName(req.params.name);
        const p = validate.parseCCPrompt(req.body);
        return await withAudit({ op: 'cc.prompt', session: name, caller: callerFromReq(req) }, async () => {
          await cc.prompt(name, p);
          return { sent: true };
        });
      }),
    },

    // GET /terminal/cc/:name/status
    {
      method: 'GET',
      pattern: /^\/terminal\/cc\/(?<name>[^/]+)\/status$/,
      handler: async (req) => envelope(() => {
        const name = validate.parseSessionName(req.params.name);
        return cc.status(name);
      }),
    },

    // POST /terminal/cc/:name/await-idle — block until phase=idle
    {
      method: 'POST',
      pattern: /^\/terminal\/cc\/(?<name>[^/]+)\/await-idle$/,
      handler: async (req) => envelope(async () => {
        const name = validate.parseSessionName(req.params.name);
        const p = validate.parseAwaitIdle(req.body);
        return await cc.awaitIdle(name, p);
      }),
    },

    // POST /terminal/cc/:name/interrupt — send Ctrl-C
    {
      method: 'POST',
      pattern: /^\/terminal\/cc\/(?<name>[^/]+)\/interrupt$/,
      handler: async (req) => envelope(async () => {
        const name = validate.parseSessionName(req.params.name);
        return await withAudit({ op: 'cc.interrupt', session: name, caller: callerFromReq(req) }, async () => {
          await cc.interrupt(name);
          return { interrupted: true };
        });
      }),
    },

    // POST /terminal/cc/:name/slash — send /cmd args
    {
      method: 'POST',
      pattern: /^\/terminal\/cc\/(?<name>[^/]+)\/slash$/,
      handler: async (req) => envelope(async () => {
        const name = validate.parseSessionName(req.params.name);
        const p = validate.parseSlash(req.body);
        return await withAudit({ op: 'cc.slash', session: name, caller: callerFromReq(req), details: { cmd: p.cmd } }, async () => {
          await cc.slash(name, p);
          return { sent: `/${p.cmd}` };
        });
      }),
    },

    // POST /terminal/cc/:name/accept-dialog — Enter on default option
    {
      method: 'POST',
      pattern: /^\/terminal\/cc\/(?<name>[^/]+)\/accept-dialog$/,
      handler: async (req) => envelope(async () => {
        const name = validate.parseSessionName(req.params.name);
        return await withAudit({ op: 'cc.acceptDialog', session: name, caller: callerFromReq(req) }, async () => {
          return await cc.acceptDialog(name);
        });
      }),
    },

    // POST /terminal/cc/:name/reject-dialog — Esc
    {
      method: 'POST',
      pattern: /^\/terminal\/cc\/(?<name>[^/]+)\/reject-dialog$/,
      handler: async (req) => envelope(async () => {
        const name = validate.parseSessionName(req.params.name);
        return await withAudit({ op: 'cc.rejectDialog', session: name, caller: callerFromReq(req) }, async () => {
          return await cc.rejectDialog(name);
        });
      }),
    },

    // POST /terminal/cc/:name/select-choice — press digit 1..9
    {
      method: 'POST',
      pattern: /^\/terminal\/cc\/(?<name>[^/]+)\/select-choice$/,
      handler: async (req) => envelope(async () => {
        const name = validate.parseSessionName(req.params.name);
        const p = validate.parseSelectChoice(req.body);
        return await withAudit({ op: 'cc.selectChoice', session: name, caller: callerFromReq(req), details: { n: p.n } }, async () => {
          return await cc.selectChoice(name, p);
        });
      }),
    },
  ];
}
