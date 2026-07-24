/**
 * Uplink gate for bidirectional voice — the buffer between the mic and the relay.
 *
 * The mic opens at CLICK time (see useClaudeVoice's `start`), but the Core relay only reports
 * `{ready}` once headless Chrome has launched, primed, navigated and cleared Cloudflare. Opus
 * frames therefore exist before there is anywhere to send them. This gate holds them.
 *
 * Bounded in both directions on purpose:
 *  - keeping frames means the user's opening words survive the relay coming up, instead of being
 *    silently dropped by a `readyState === OPEN` guard;
 *  - capping them means a long — or never-completing — wait can never flush a huge stale burst
 *    into claude.ai's server-side VAD, which segments speech on what it actually receives.
 *
 * Pure and transport-agnostic: `send` is injected, so this is unit-testable without a socket,
 * a browser, or a React renderer.
 */

/**
 * ~5 seconds of Opus: 20ms frames at ~50 fps, ~60 bytes each — roughly 15KB retained.
 * Sized to cover a warm relay start with room to spare, not a cold one.
 */
export const MAX_BUFFERED_FRAMES = 250;

export interface UplinkGate {
  /** One encoded Opus packet from the engine. Sent straight through once open, else buffered. */
  push(frame: Uint8Array): void;
  /** The relay reported `{ready}`: drain the ring oldest-first, then pass frames through. */
  open(): void;
  /** Back to buffering, ring emptied — for stop()/teardown, so a later session starts clean. */
  reset(): void;
  /** Frames currently held (diagnostics + tests). */
  readonly buffered: number;
  readonly isOpen: boolean;
}

/**
 * @param send    delivers one frame to the relay; may throw or drop (the caller owns the
 *                socket-state check), which must never break the gate.
 * @param maxFrames ring capacity; frames past it are dropped from the FRONT, because the most
 *                recent audio is what the user is saying now.
 */
export function createUplinkGate(send: (frame: Uint8Array) => void, maxFrames: number = MAX_BUFFERED_FRAMES): UplinkGate {
  let open = false;
  let ring: Uint8Array[] = [];

  const safeSend = (frame: Uint8Array): void => {
    try { send(frame); } catch { /* a dead socket must not kill capture */ }
  };

  return {
    push(frame: Uint8Array): void {
      if (open) { safeSend(frame); return; }
      ring.push(frame);
      if (ring.length > maxFrames) ring.splice(0, ring.length - maxFrames);
    },
    open(): void {
      if (open) return; // idempotent — a duplicate {ready} must not re-send anything
      open = true;
      const pending = ring;
      ring = []; // cleared BEFORE sending, so a throwing send can't leave frames queued twice
      for (const frame of pending) safeSend(frame);
    },
    reset(): void {
      open = false;
      ring = [];
    },
    get buffered(): number { return ring.length; },
    get isOpen(): boolean { return open; },
  };
}
