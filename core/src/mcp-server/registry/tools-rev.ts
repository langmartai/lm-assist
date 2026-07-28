/**
 * A cheap revision stamp for "would `tools/list` answer differently now?".
 *
 * Why this exists: the MCP server is a SEPARATE stdio process from Core. Core
 * owns the registry overlay (tools flipped on/off, descriptions overridden) and
 * the plugin set, and both change at runtime with no restart — but the process
 * holding the client's notification channel is not the process that knows. So
 * the MCP process polls this stamp and, when it moves, tells the client its tool
 * list is stale (`notifications/tools/list_changed`).
 *
 * The stamp is `<bootId>.<counter>`, not a content hash: hashing the effective
 * tool set on every poll would mean reading the store, and this is checked
 * repeatedly by every connected MCP process. A counter is enough — clients only
 * need to know THAT something changed, then they re-fetch.
 *
 * The bootId means a Core restart looks like a change, so a client re-fetches
 * once after Core comes back. That is deliberate: Core may well have restarted
 * WITH a different tool set, and a spurious re-fetch is far cheaper than a client
 * silently holding a stale list.
 */

import { randomBytes } from 'crypto';

const BOOT_ID = randomBytes(4).toString('hex');
let counter = 0;

/**
 * Record that the effective tool set may have changed.
 *
 * Call from every funnel that can alter what `tools/list` returns — overlay
 * writes, content-overlay writes, plugin enable/disable/sync. Over-calling is
 * harmless (a client re-fetches); UNDER-calling is the bug, because the client
 * is never told and keeps a stale list until it reconnects.
 */
export function bumpToolsRev(): void {
  counter++;
}

/** The current stamp. Pure read — no store access, safe to call on a hot path. */
export function currentToolsRev(): string {
  return `${BOOT_ID}.${counter}`;
}

// ─── the poller's decision (pure, so its edges are testable) ────────────────

export interface RevTransition {
  /** Tell the client its tool list is stale. */
  notify: boolean;
  /** What the caller should remember for next time. */
  nextSeen: string | null;
  reason: string;
}

/**
 * Should a change from `lastSeen` to `current` notify the client?
 *
 * 🔴 The first observation must NOT notify. It is the baseline — firing there
 * would make every MCP process emit a spurious list_changed at startup, right
 * when the client has just fetched the list.
 */
export function toolsRevTransition(lastSeen: string | null, current: string | null): RevTransition {
  if (current === null) {
    // Fetch failed. Keep the old baseline: forgetting it would make the NEXT
    // successful poll look like a change and fire a false notification.
    return { notify: false, nextSeen: lastSeen, reason: 'rev unavailable — keeping the last known baseline' };
  }
  if (lastSeen === null) {
    return { notify: false, nextSeen: current, reason: 'first observation — baseline only, never a notification' };
  }
  if (lastSeen === current) {
    return { notify: false, nextSeen: current, reason: 'unchanged' };
  }
  return { notify: true, nextSeen: current, reason: `tool set changed (${lastSeen} -> ${current})` };
}
