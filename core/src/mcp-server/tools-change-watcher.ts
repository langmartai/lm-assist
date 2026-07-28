/**
 * Tell connected clients when this node's tool list changes.
 *
 * The MCP server is a separate stdio process from Core. Core owns the registry
 * overlay (tools on/off, description overrides) and the plugin set, and both
 * change at runtime with no restart — but Core has no channel to the client, and
 * this process has the channel and no idea a change happened. So this polls
 * Core's cheap rev stamp and emits `notifications/tools/list_changed`.
 *
 * Before this, a tool added or re-described was invisible to every connected
 * session until it reconnected; `refresh_connector_tools` could only clear
 * claude.ai's cache for the NEXT bootstrap.
 *
 * Deliberately modest: a slow interval against an in-memory counter, `unref`ed so
 * it can never hold the process open, and every failure swallowed. A missed
 * notification costs a stale tool list until the next poll; a watcher that
 * crashes the MCP server costs the whole session.
 */

import { coreBaseUrl } from './api-client';
import { lmAuthHeaders } from '../auth/api-token';
import { toolsRevTransition } from './registry/tools-rev';

/** Slow on purpose: tool edits are rare and every connected MCP process polls. */
const POLL_MS = 30_000;
/** Bounded so a wedged Core cannot pile up in-flight requests. */
const FETCH_TIMEOUT_MS = 4_000;

async function fetchRev(): Promise<string | null> {
  try {
    const res = await fetch(`${coreBaseUrl()}/mcp-tools/rev`, {
      headers: { ...lmAuthHeaders() },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const json = await res.json() as { success?: boolean; data?: { rev?: string } };
    const rev = json?.data?.rev;
    return typeof rev === 'string' && rev ? rev : null;
  } catch {
    return null; // Core down / restarting / route absent on an older build
  }
}

export interface ToolsChangeWatcher { stop(): void }

/**
 * Start watching. `notify` is the SDK's tool-list-changed sender.
 *
 * Injected rather than reaching for the server instance so the loop is testable
 * and so a send failure (client already gone) cannot take the process down.
 */
export function startToolsChangeWatcher(
  notify: () => Promise<void> | void,
  opts?: { pollMs?: number; fetchRev?: () => Promise<string | null> },
): ToolsChangeWatcher {
  const read = opts?.fetchRev ?? fetchRev;
  let seen: string | null = null;
  let stopped = false;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    const t = toolsRevTransition(seen, await read());
    seen = t.nextSeen;
    if (t.notify) {
      try {
        await notify();
      } catch {
        // The client may have gone away mid-notify. Nothing to do, and it must
        // never propagate: this runs on a timer with no caller to catch it.
      }
    }
  };

  const timer = setInterval(() => { void tick(); }, opts?.pollMs ?? POLL_MS);
  // Never keep a short-lived MCP process alive just to poll.
  if (typeof (timer as { unref?: () => void }).unref === 'function') (timer as { unref: () => void }).unref();
  // Take the baseline immediately so the first real change is caught within one
  // interval rather than two.
  void tick();

  return { stop(): void { stopped = true; clearInterval(timer); } };
}
