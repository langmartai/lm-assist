/**
 * Pending admin-action store (out-of-band confirmation) — worker side.
 *
 * An `admin`-scope MCP tool call does not execute. It parks a pending action
 * here and returns `pending_confirmation`. The action runs only when the
 * operator confirms it through a NON-model channel — the `/mcp/pending/:id/
 * confirm` REST endpoint, surfaced as a button in the MCP settings tab. The
 * model (driving claude.ai) can create a pending but cannot reach the confirm
 * endpoint, so it can never release its own admin action. That break is the
 * whole point.
 *
 * In-memory with a 10-minute TTL. A restart drops in-flight pendings (the
 * operator just re-issues the tool call) — acceptable, and keeps this free of
 * persistence concerns.
 */

import type { McpSubject } from './access-control';

export interface PendingAction {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  subject: McpSubject;
  /** Short human summary for the confirm UI. */
  summary: string;
  createdAt: number;
  expiresAt: number;
}

const TTL_MS = 10 * 60 * 1000;
const store = new Map<string, PendingAction>();

function sweep(): void {
  const now = Date.now();
  for (const [id, p] of store) if (p.expiresAt <= now) store.delete(id);
}

function id(): string {
  // 24 hex chars; runtime randomness is fine here (not a workflow script).
  let s = '';
  for (let i = 0; i < 24; i++) s += '0123456789abcdef'[Math.floor(Math.random() * 16)];
  return s;
}

export function createPending(
  tool: string,
  args: Record<string, unknown>,
  subject: McpSubject,
  summary: string,
): PendingAction {
  sweep();
  const now = Date.now();
  const p: PendingAction = { id: id(), tool, args, subject, summary, createdAt: now, expiresAt: now + TTL_MS };
  store.set(p.id, p);
  return p;
}

export function getPending(pendingId: string): PendingAction | undefined {
  sweep();
  return store.get(pendingId);
}

export function listPending(): PendingAction[] {
  sweep();
  return [...store.values()].sort((a, b) => b.createdAt - a.createdAt);
}

/** Remove + return a pending (used by confirm/deny so it runs at most once). */
export function takePending(pendingId: string): PendingAction | undefined {
  sweep();
  const p = store.get(pendingId);
  if (p) store.delete(pendingId);
  return p;
}
