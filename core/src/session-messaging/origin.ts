/**
 * Who is speaking on an injected turn.
 *
 * The same injection path carries two very different things:
 *   - the OPERATOR's own control plane — a mission brief handed to the worker it
 *     created, mission-control's `/model opus` mitigation, a cluster notice. No
 *     sending session exists; lm-assist is a host wrapping input on the
 *     operator's behalf, so the turn is `human`.
 *   - a genuine SESSION-TO-SESSION relay — one Claude session messaging another.
 *     That really is peer traffic: it keeps the peer framing, but named, so the
 *     receiver sees who sent it instead of `from:"unknown"`.
 *
 * Getting this backwards in either direction is a security bug, not a cosmetic
 * one: stamping `human` on peer traffic would launder a peer's request into
 * apparent user intent, and stamping `peer` on the operator's own command tells
 * the receiver to discount it.
 */

import type { SessionMessage, TurnOrigin } from './types';

/** Decide the provenance stamp for one message's injected turn. */
export function originForInjection(msg: Pick<SessionMessage, 'fromSession' | 'fromNode'>): TurnOrigin {
  const from = String(msg.fromSession || '').trim();
  return from ? { kind: 'peer', from } : { kind: 'human' };
}

/**
 * Validate a provenance stamp arriving off the wire on a relay route.
 *
 * Anything unrecognised is DROPPED rather than forwarded. Two reasons:
 * a malformed `origin` on the ingress is worse than an absent one, and a peer
 * stamp with no sender name reproduces exactly the `from:"unknown"` state this
 * whole fix exists to remove. Only the two shapes lm-assist itself produces are
 * accepted, and only their known fields are copied — a caller cannot smuggle
 * extra keys (`senderTaskId`, `inbound_origin`, `hopChain`) onto the event.
 */
export function parseOrigin(raw: unknown): TurnOrigin | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as { kind?: unknown; from?: unknown };
  if (o.kind === 'human') return { kind: 'human' };
  if (o.kind === 'peer') {
    const from = typeof o.from === 'string' ? o.from.trim() : '';
    return from ? { kind: 'peer', from } : undefined;
  }
  return undefined;
}
