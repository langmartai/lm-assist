/**
 * Cross-node session-to-session messaging — domain types.
 *
 * Any lm-assist-managed Claude Code session can send a message to any OTHER
 * managed session, on this node or another. The message is delivered by being
 * INJECTED into the target session's terminal (Claude Code prompt). Three
 * categories change how the receiving session is asked to treat the body:
 *
 *   - reference  — background knowledge/context, NOT an instruction.
 *   - guided     — instructions, but SUPERVISED: the receiver reviews and
 *                  decides whether to execute.
 *   - overwrite  — privileged: execute directly, overriding the target's own
 *                  current instructions (a.k.a. supercharge).
 *
 * The wrapped injection always carries an explicit category preamble so the
 * receiving session treats it correctly (see preamble.ts).
 *
 * Routing: the SEND tool is node-routed (the existing MCP `node` selector —
 * the hub relays the call to the target node). By the time `sendMessage` runs
 * it is already ON the target node, so it stores + injects + acks locally.
 */

/** The three delivery categories. */
export type MessageCategory = 'reference' | 'guided' | 'overwrite';

/** Lifecycle state of a stored inbound message. */
export type MessageStatus =
  | 'pending'     // stored, no driver reached the session — provably NOT delivered
  | 'unverified'  // TYPED INTO the session but the submit could not be confirmed —
                  // it MAY have been delivered. Never auto-retried: re-injecting
                  // would double-deliver. Retry only with the SAME messageId.
  | 'received'    // injected into the target session (or stored awaiting pickup)
  | 'read'        // the receiving session reported it has seen the message
  | 'executed'    // the receiving session reported it acted on the message
  | 'failed';     // injection failed terminally or the receiver reported failure

/**
 * Typed outcome codes returned to the SENDER. The distinction that matters is
 * whether a retry is safe, mirroring ORIGIN_UNREACHABLE vs ORIGIN_TIMEOUT on
 * the backlog write path:
 *
 *   TARGET_UNREACHABLE  — nothing was ever typed into the session. Retry freely.
 *   DELIVERY_UNVERIFIED — the body reached the composer; the submit is
 *                         unconfirmed and it MAY already have been delivered.
 *                         Retry ONLY with the same messageId (idempotent).
 *   INVALID_INPUT       — refused before any delivery attempt; echoes the value.
 */
export type SendFailureCode = 'TARGET_UNREACHABLE' | 'DELIVERY_UNVERIFIED' | 'INVALID_INPUT';

/** One status-transition record (audit trail of a message's life). */
export interface MessageAck {
  state: MessageStatus;
  /** ISO timestamp of the transition. */
  at: string;
  /** Free-form detail — driver name, error text, receiver note, etc. */
  detail?: string;
}

/** A stored inbound message on the node where the target session lives. */
export interface SessionMessage {
  /** Stable message id (also the ack handle returned to the sender). */
  id: string;
  /** hostId/hostname of the node that sent the message (best-effort). */
  fromNode: string;
  /** Identifier of the sending session (free-form; best-effort). */
  fromSession: string;
  /** hostId/hostname of the node this message was delivered to (this node). */
  toNode: string;
  /** Target session identifier — a tmux/CC session name on toNode. */
  toSession: string;
  category: MessageCategory;
  /** The raw message body (un-wrapped; the preamble is added at injection). */
  body: string;
  /** ISO timestamp the message was created/stored. */
  createdAt: string;
  status: MessageStatus;
  /** Which injection driver delivered it (set once injected). */
  driver?: InjectionDriverName;
  /** Ordered status transitions, newest last. */
  acks: MessageAck[];
}

/** The injection drivers, in fallback order. */
export type InjectionDriverName = 'remote-control' | 'cc-session' | 'tmux-send-keys' | 'none';

/** What one driver did on one pass of the chain. */
export interface InjectionAttempt {
  driver: InjectionDriverName;
  /** unavailable = never reached the session; error = definite failure;
   *  unverified = body was typed in, submit unconfirmed (may have landed). */
  outcome: 'unavailable' | 'error' | 'unverified';
  /** Typed code from the driver route, when it carried one. */
  code?: string;
  detail?: string;
}

/** Result of one injection attempt by a driver. */
export interface InjectionResult {
  driver: InjectionDriverName;
  /** True only if the body was actually delivered into the session. */
  delivered: boolean;
  /** True when SOME driver typed the body in but could not confirm the submit.
   *  The message may already be in the target — retrying risks a duplicate. */
  ambiguous?: boolean;
  /** Per-driver breakdown, so the caller sees WHERE it failed. */
  attempts?: InjectionAttempt[];
  /** Why a driver was skipped or why it failed (for diagnostics + acks). */
  detail?: string;
}

/** Arguments to send a message (from the MCP tool, already on the target node). */
export interface SendMessageArgs {
  /** Target node (informational on the worker; routing already happened). */
  toNode?: string;
  /** Target session name on this node (required). */
  toSession: string;
  category: MessageCategory;
  body: string;
  /** Best-effort sender identity for provenance. */
  fromNode?: string;
  fromSession?: string;
  /**
   * Client-supplied IDEMPOTENCY KEY, and the message's id. Re-sending with the
   * SAME messageId resolves to the message already stored instead of injecting
   * a second copy — so a retry after an ambiguous/lost ack cannot double
   * deliver. Omit and the server mints one (retry is then NOT safe).
   */
  messageId?: string;
}
