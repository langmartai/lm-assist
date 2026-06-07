/**
 * Injection driver chain.
 *
 * Given a target session name and an already-wrapped body, deliver it into the
 * session by driving its terminal. Drivers are tried in order; the first one
 * whose precondition holds and whose send succeeds wins. If none can deliver,
 * the message stays PENDING and the sweeper retries later.
 *
 * Drivers (in order):
 *   1. cc-prompt       — the Claude Code adapter. Only usable when the session
 *                        is a live CC session at the idle prompt (phase==='idle').
 *                        This is the "remote-session interface" — it types the
 *                        wrapped body as a prompt and submits it.
 *   2. tmux-send-keys  — raw tmux injection. Usable when the tmux session
 *                        exists (POSIX hosts). Lower-level fallback for a tmux
 *                        session that is not a CC idle prompt (e.g. a plain
 *                        shell, or CC busy — keystrokes queue in the TUI input).
 *
 * "Driver available?" is decided by probing the session's live state through
 * the existing lm-assist routes — NOT by config. cc-prompt checks
 * GET /terminal/cc/:name/status (phase). tmux-send-keys checks the session
 * appears in GET /terminal/tmux.
 *
 * All driving goes through the EXISTING terminal-control routes on loopback;
 * this module never re-implements tmux/CC mechanics.
 */

import type { InjectionDriverName, InjectionResult } from './types';

/**
 * Minimal transport the drivers use to reach lm-assist's own routes. Defaults
 * to loopback fetch (same pattern as mcp-server/tools/_passthrough.ts); a test
 * can supply mocks. `get` returns parsed JSON; `post` returns parsed JSON.
 */
export interface DriverTransport {
  get(routePath: string): Promise<unknown>;
  post(routePath: string, body: Record<string, unknown>): Promise<unknown>;
}

function resolveApiPort(): string {
  if (process.env.API_PORT) return process.env.API_PORT;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('fs') as typeof import('fs');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const os = require('os') as typeof import('os');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const path = require('path') as typeof import('path');
    const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude-code-config.json'), 'utf-8'));
    if (cfg.devModeEnabled) return '3200';
  } catch {
    /* default below */
  }
  return '3100';
}

/** Default loopback transport — calls lm-assist's own HTTP API. */
export function loopbackTransport(): DriverTransport {
  const base = `http://127.0.0.1:${resolveApiPort()}`;
  return {
    async get(routePath) {
      const res = await fetch(`${base}${routePath}`, { signal: AbortSignal.timeout(10000) });
      return res.json();
    },
    async post(routePath, body) {
      const res = await fetch(`${base}${routePath}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
      });
      return res.json();
    },
  };
}

function enc(s: string): string {
  return encodeURIComponent(s);
}

/** Unwrap the standard {success,data,error} envelope; throw on failure. */
function unwrap(json: unknown): Record<string, unknown> {
  const j = (json || {}) as { success?: boolean; data?: unknown; error?: unknown };
  if (j.success === false) {
    const msg =
      typeof j.error === 'string'
        ? j.error
        : (j.error as { message?: string })?.message || 'request failed';
    throw new Error(msg);
  }
  return (j.data ?? j) as Record<string, unknown>;
}

/** A single driver: probe availability + attempt delivery. */
export interface InjectionDriver {
  name: InjectionDriverName;
  /** True if this driver can plausibly deliver to `session` right now. */
  available(session: string, t: DriverTransport): Promise<boolean>;
  /** Deliver `wrapped` to `session`. Throws on failure. */
  deliver(session: string, wrapped: string, t: DriverTransport): Promise<void>;
}

/** Driver 1 — Claude Code remote-session interface (POST /terminal/cc/:name/prompt). */
export const ccPromptDriver: InjectionDriver = {
  name: 'cc-prompt',
  async available(session, t) {
    try {
      const data = unwrap(await t.get(`/terminal/cc/${enc(session)}/status`));
      // cc.prompt asserts phase 'idle'; only claim availability when idle.
      return (data as { phase?: string }).phase === 'idle';
    } catch {
      return false;
    }
  },
  async deliver(session, wrapped, t) {
    // allowNewlines so the multi-line preamble + body is typed as one prompt.
    unwrap(await t.post(`/terminal/cc/${enc(session)}/prompt`, { text: wrapped, allowNewlines: true }));
  },
};

/** Driver 2 — raw tmux injection (POST /terminal/tmux/:name/send-keys). */
export const tmuxSendKeysDriver: InjectionDriver = {
  name: 'tmux-send-keys',
  async available(session, t) {
    try {
      const data = unwrap(await t.get('/terminal/tmux')) as {
        sessions?: Array<{ name?: string }>;
        platformSupported?: boolean;
      };
      if (data.platformSupported === false) return false;
      return (data.sessions || []).some((s) => s.name === session);
    } catch {
      return false;
    }
  },
  async deliver(session, wrapped, t) {
    // literal text + Enter — types the wrapped body into whatever is at the pane.
    unwrap(await t.post(`/terminal/tmux/${enc(session)}/send-keys`, { keys: wrapped, literal: true, enter: true }));
  },
};

/** The default driver chain, in fallback order. */
export const DEFAULT_DRIVERS: InjectionDriver[] = [ccPromptDriver, tmuxSendKeysDriver];

/**
 * Try each driver in order. Returns the result of the first driver that
 * reports available AND delivers successfully. If a driver is available but
 * throws on delivery, that's recorded and the chain continues to the next.
 * If no driver delivers, returns { driver:'none', delivered:false }.
 */
export async function injectViaChain(
  session: string,
  wrapped: string,
  drivers: InjectionDriver[] = DEFAULT_DRIVERS,
  transport: DriverTransport = loopbackTransport(),
): Promise<InjectionResult> {
  const skipped: string[] = [];
  for (const d of drivers) {
    let isAvail = false;
    try {
      isAvail = await d.available(session, transport);
    } catch {
      isAvail = false;
    }
    if (!isAvail) {
      skipped.push(`${d.name}:unavailable`);
      continue;
    }
    try {
      await d.deliver(session, wrapped, transport);
      return { driver: d.name, delivered: true, detail: `delivered via ${d.name}` };
    } catch (e) {
      skipped.push(`${d.name}:error(${e instanceof Error ? e.message : String(e)})`);
    }
  }
  return {
    driver: 'none',
    delivered: false,
    detail: skipped.length ? `no driver delivered — ${skipped.join('; ')}` : 'no drivers available',
  };
}
