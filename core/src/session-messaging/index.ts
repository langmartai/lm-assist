/**
 * Cross-node session-to-session messaging — public API (worker side).
 *
 * This module runs ON the node where the TARGET session lives. The send MCP
 * tool is node-routed (the existing `node` selector → the hub relays the call
 * to the target node), so by the time `sendMessage` executes it is already on
 * the right host. It then: stores the message, wraps it with the category
 * preamble, injects it into the target session via the driver chain, and
 * records the resulting status + ack.
 *
 *   sendMessage   — store + inject + ack (returns the messageId)
 *   listMessages  — list stored messages (optionally per session/status)
 *   getStatus     — status + ack history for one message
 *   markRead      — receiver reports it has seen a message
 *   markExecuted  — receiver reports it acted on a message
 *   markFailed    — receiver reports it could not act on a message
 *   sweepPending  — retry injection for messages still pending
 *   startSweeper / stopSweeper — periodic retry loop
 */

import * as crypto from 'crypto';
import * as store from './store';
import { wrapForInjection } from './preamble';
import { injectViaChain, type InjectionDriver, type DriverTransport } from './inject';
import type {
  SessionMessage,
  SendMessageArgs,
  MessageStatus,
} from './types';

function genId(): string {
  return 'msg-' + crypto.randomBytes(9).toString('hex');
}

function isCategory(v: unknown): v is SessionMessage['category'] {
  return v === 'reference' || v === 'guided' || v === 'overwrite';
}

export interface SendResult {
  id: string;
  status: MessageStatus;
  driver?: string;
  detail?: string;
}

/**
 * Store, inject, and ack a message destined for a local session.
 * Optional `drivers`/`transport` overrides exist for testing.
 */
export async function sendMessage(
  args: SendMessageArgs,
  opts?: { drivers?: InjectionDriver[]; transport?: DriverTransport; localNode?: string },
): Promise<SendResult> {
  const toSession = String(args.toSession || '').trim();
  if (!toSession) throw new Error('toSession is required');
  if (!isCategory(args.category)) {
    throw new Error(`category must be one of reference|guided|overwrite (got ${String(args.category)})`);
  }
  const body = String(args.body ?? '');
  if (!body.trim()) throw new Error('body is required');

  const now = new Date().toISOString();
  const msg: SessionMessage = {
    id: genId(),
    fromNode: String(args.fromNode || '').trim(),
    fromSession: String(args.fromSession || '').trim(),
    toNode: String(args.toNode || opts?.localNode || '').trim(),
    toSession,
    category: args.category,
    body,
    createdAt: now,
    status: 'pending',
    acks: [{ state: 'pending', at: now, detail: 'stored' }],
  };
  store.insert(msg);

  const wrapped = wrapForInjection(msg);
  const result = await injectViaChain(toSession, wrapped, opts?.drivers, opts?.transport);

  if (result.delivered) {
    store.transition(msg.id, 'received', result.detail, result.driver);
    return { id: msg.id, status: 'received', driver: result.driver, detail: result.detail };
  }
  // Leave pending so the sweeper retries when a driver becomes available.
  store.transition(msg.id, 'pending', result.detail, result.driver);
  return { id: msg.id, status: 'pending', detail: result.detail };
}

/** List stored messages on this node (optionally filtered). */
export function listMessages(filter?: { session?: string; status?: MessageStatus }): SessionMessage[] {
  return store.list(filter);
}

/** Status + ack history for one message. Undefined if not on this node. */
export function getStatus(id: string): SessionMessage | undefined {
  return store.get(id);
}

/** Receiver reports it has seen the message. */
export function markRead(id: string, detail?: string): SessionMessage | undefined {
  return store.transition(id, 'read', detail || 'receiver acked read');
}

/** Receiver reports it acted on the message. */
export function markExecuted(id: string, detail?: string): SessionMessage | undefined {
  return store.transition(id, 'executed', detail || 'receiver acked executed');
}

/** Receiver (or the system) reports the message could not be acted on. */
export function markFailed(id: string, detail?: string): SessionMessage | undefined {
  return store.transition(id, 'failed', detail || 'failed');
}

/**
 * Retry injection for every still-pending message. Returns a per-message
 * outcome list. Called by the periodic sweeper and exposed for tests.
 */
export async function sweepPending(
  opts?: { drivers?: InjectionDriver[]; transport?: DriverTransport },
): Promise<Array<{ id: string; delivered: boolean; detail?: string }>> {
  const pending = store.listPending();
  const out: Array<{ id: string; delivered: boolean; detail?: string }> = [];
  for (const msg of pending) {
    const wrapped = wrapForInjection(msg);
    const result = await injectViaChain(msg.toSession, wrapped, opts?.drivers, opts?.transport);
    if (result.delivered) {
      store.transition(msg.id, 'received', result.detail, result.driver);
      out.push({ id: msg.id, delivered: true, detail: result.detail });
    } else {
      // stay pending; record the latest attempt detail without spamming acks
      out.push({ id: msg.id, delivered: false, detail: result.detail });
    }
  }
  return out;
}

let sweeperTimer: NodeJS.Timeout | null = null;

/** Start the periodic pending-message sweeper (idempotent). */
export function startSweeper(intervalMs = 30_000): void {
  if (sweeperTimer) return;
  sweeperTimer = setInterval(() => {
    void sweepPending().catch(() => { /* swallow — best-effort retry */ });
  }, intervalMs);
  // Do not keep the process alive solely for the sweeper.
  if (typeof sweeperTimer.unref === 'function') sweeperTimer.unref();
}

/** Stop the periodic sweeper. */
export function stopSweeper(): void {
  if (sweeperTimer) {
    clearInterval(sweeperTimer);
    sweeperTimer = null;
  }
}

export type { SessionMessage, SendMessageArgs, MessageStatus, MessageCategory } from './types';
