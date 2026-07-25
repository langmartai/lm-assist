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
  SendFailureCode,
  InjectionResult,
} from './types';

function genId(): string {
  return 'msg-' + crypto.randomBytes(9).toString('hex');
}

function isCategory(v: unknown): v is SessionMessage['category'] {
  return v === 'reference' || v === 'guided' || v === 'overwrite';
}

/** A coded refusal the route layer can translate into wrapError(code, message). */
export class SendMessageError extends Error {
  readonly code: SendFailureCode;
  constructor(code: SendFailureCode, message: string) {
    super(message);
    this.name = 'SendMessageError';
    this.code = code;
  }
}

const MESSAGE_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

/** Pure: validate a client-supplied idempotency key, ECHOING what was sent so a
 *  caller never retries the same rejected value blindly. */
export function validateMessageId(v: unknown): { ok: true } | { ok: false; message: string } {
  if (typeof v !== 'string' || !MESSAGE_ID_RE.test(v)) {
    return {
      ok: false,
      message:
        `messageId ${JSON.stringify(v)} is not valid — use 1-128 chars of letters, digits, dot, underscore, colon or hyphen`,
    };
  }
  return { ok: true };
}

/**
 * Serialize sends that share an idempotency key.
 *
 * Double-INJECTION is already prevented by `store.insert` landing before the
 * first await, so a concurrent twin observes the record. What the lock actually
 * buys — measured, not assumed — is that the twin waits for the in-flight send
 * to SETTLE and so reports the real outcome. Without it a concurrent retry
 * reads the transient 'pending' written at insert time and is told the message
 * was not delivered while it is being delivered — the same wrong-outcome
 * report this whole path exists to eliminate.
 *
 * Keyed on the identity, not the store file (same shape as the backlog
 * create-lock); in-process only, which is where the retry storms happen.
 */
const sendLocks = new Map<string, Promise<unknown>>();
function withSendLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = sendLocks.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn); // run regardless of how the predecessor settled
  const tail = run.catch(() => undefined);
  sendLocks.set(key, tail);
  void tail.finally(() => { if (sendLocks.get(key) === tail) sendLocks.delete(key); });
  return run;
}

export interface SendResult {
  id: string;
  status: MessageStatus;
  driver?: string;
  detail?: string;
  /** Set when this send resolved to an ALREADY-STORED message (same messageId)
   *  instead of injecting a second copy. */
  idempotent?: boolean;
  /** Typed outcome when the message was not confirmed delivered. */
  code?: SendFailureCode;
  /** Per-driver breakdown — WHERE it failed. */
  attempts?: InjectionResult['attempts'];
  /** True when the body reached the composer but the submit is unconfirmed. */
  ambiguous?: boolean;
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
  if (!toSession) throw new SendMessageError('INVALID_INPUT', 'toSession is required');
  if (!isCategory(args.category)) {
    throw new SendMessageError(
      'INVALID_INPUT',
      `category ${JSON.stringify(args.category)} is not valid — must be one of: reference, guided, overwrite`,
    );
  }
  const body = String(args.body ?? '');
  if (!body.trim()) throw new SendMessageError('INVALID_INPUT', 'body is required');

  let clientId: string | undefined;
  if (args.messageId !== undefined) {
    const v = validateMessageId(args.messageId);
    if (!v.ok) throw new SendMessageError('INVALID_INPUT', v.message);
    clientId = String(args.messageId);
  }

  // No idempotency key ⇒ nothing to dedupe against; keep the original path.
  if (!clientId) return await deliverNew(genId(), toSession, body, args, opts);

  // Same key ⇒ one delivery. The lock closes the window where two concurrent
  // retries both miss the lookup and both inject.
  return await withSendLock(clientId, async () => {
    const existing = store.get(clientId!);
    if (existing) {
      // Already stored under this key — return it verbatim rather than
      // injecting a second copy. A lost/slow ack is now safe to retry.
      return {
        id: existing.id,
        status: existing.status,
        driver: existing.driver,
        idempotent: true,
        detail: `messageId ${existing.id} was already sent (status ${existing.status}) — not re-delivered`,
      };
    }
    return await deliverNew(clientId!, toSession, body, args, opts);
  });
}

/** Store + inject one NEW message and classify the outcome. */
async function deliverNew(
  id: string,
  toSession: string,
  body: string,
  args: SendMessageArgs,
  opts?: { drivers?: InjectionDriver[]; transport?: DriverTransport; localNode?: string },
): Promise<SendResult> {
  const now = new Date().toISOString();
  const msg: SessionMessage = {
    id,
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
    return { id: msg.id, status: 'received', driver: result.driver, detail: result.detail, attempts: result.attempts };
  }
  if (result.ambiguous) {
    // The body reached the composer; only the submit is unconfirmed. Re-sending
    // could double-deliver, so this is NOT swept and NOT reported as a clean
    // failure — the caller must retry with the same messageId or verify first.
    store.transition(msg.id, 'unverified', result.detail, result.driver);
    return {
      id: msg.id,
      status: 'unverified',
      code: 'DELIVERY_UNVERIFIED',
      ambiguous: true,
      detail: result.detail,
      attempts: result.attempts,
    };
  }
  // Nothing reached the session. Safe to retry freely.
  store.transition(msg.id, 'pending', result.detail, result.driver);
  return {
    id: msg.id,
    status: 'pending',
    code: 'TARGET_UNREACHABLE',
    detail: result.detail,
    attempts: result.attempts,
  };
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
