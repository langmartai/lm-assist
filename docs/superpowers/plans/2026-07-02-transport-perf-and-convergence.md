# Transport Performance + Fabric Convergence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make the node-to-node transport correct under backpressure and fast on the LAN (adaptive RTO, fast-retransmit, bounded buffers), then converge file-transfer and port-forward onto the fabric's already-warm confirmed-direct channel instead of each opening a cold per-use channel.

**Architecture:** Two phases. Phase A is localized to `core/src/transport/reliable.ts` + `core/src/hub-client/port-forward-handler.ts` and is **wire-format-compatible** (sender/receiver-local policy only — no new datagram types, no header changes), so it deploys without version-skew concerns and is verifiable on the in-process reliable test pair. Phase B adds stream multiplexing over one `ReliableConnection` and points file-transfer + port-forward at the fabric's `PeerManager` channel (Tier 3 — genuinely the start of W2 transmission), with the hub relay kept as the legacy/fallback path.

**Tech Stack:** TypeScript (CommonJS), `node:test` + `assert/strict`, the existing in-process datagram-pair test harness in `core/src/transport/__tests__/`.

## Global Constraints

- Branch: `feat/transport-perf-and-convergence`.
- Node ≥ 20.9; run npm from repo ROOT or `core/`. No new dependencies. chokidar stays `^3.6.0`.
- Build: `cd /home/ubuntu/lm-assist && ./core.sh build`. Focused test: `cd core && npm run build:test && node --test --test-reporter=spec dist-test/transport/__tests__/<file>.test.js` (use the Node v20 binary: `~/.nvm/versions/node/v20.19.6/bin/node` if the default is v18).
- **Phase A changes MUST NOT change the wire format** — same `DATAGRAM_TYPE` set, same 11-byte header. Verify: an OLD-policy peer and a NEW-policy peer must still interoperate on the in-process pair (mixed-version test in Task A6).
- The `ReliableConnection` is transport-agnostic (injected `sendDatagram`/`onDeliver`) — keep it so; never import a socket into it.
- Deployed live on the fleet (0.1.134 on 117/123/107). Every phase ends with a live 123⇄107 file-transfer re-test.
- EVERY new MCP tool (if any) needs a `TOOL_SCOPES` entry. Commit after each task; messages end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

## File Structure

```
core/src/transport/reliable.ts         MOD  adaptive RTO, fast-retransmit, event-timer, ACK coalescing, bounded queues, FIN retransmit
core/src/transport/rtt.ts              NEW  pure RttEstimator (SRTT/RTTVAR/RTO per RFC 6298, LAN floor)
core/src/hub-client/port-forward-handler.ts MOD  inbound (WS→socket) backpressure
core/src/transport/mux.ts              NEW  (Phase B) stream multiplexing framing over one ReliableConnection
core/src/transport/channel-pool.ts     NEW  (Phase B) get-or-open one shared fabric channel per peer
core/src/file-transfer/sender.ts       MOD  (Phase B) ride the pooled fabric channel
core/src/hub-client/port-forward-handler.ts MOD  (Phase B) ride the fabric channel; relay fallback
core/src/transport/__tests__/*.test.ts NEW/MOD  rtt, fast-retransmit, backpressure, mux, mixed-version
```

---

## PHASE A — Correctness + LAN throughput (wire-compatible)

### Task A1: Pure RTT estimator (`rtt.ts`)

**Files:** Create `core/src/transport/rtt.ts`; Test `core/src/transport/__tests__/rtt.test.ts`

**Interfaces:**
- Produces: `class RttEstimator` — `constructor(opts?: { minRtoMs?: number; maxRtoMs?: number })` (defaults minRtoMs=40, maxRtoMs=4000); `sample(rttMs: number): void` (RFC 6298: first sample SRTT=R, RTTVAR=R/2; subsequent RTTVAR=(1-1/4)·RTTVAR+1/4·|SRTT−R|, SRTT=(1-1/8)·SRTT+1/8·R); `rto(): number` = clamp(SRTT + max(1, 4·RTTVAR), min, max); `srtt(): number | null`; before any sample `rto()` returns a `initialRtoMs` default of 300.

- [ ] **Step 1: failing test**
```ts
// core/src/transport/__tests__/rtt.test.ts
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { RttEstimator } from '../../transport/rtt';

test('no sample yet → initial 300ms rto', () => {
  assert.equal(new RttEstimator().rto(), 300);
});
test('first sample sets SRTT=R, RTTVAR=R/2 → rto = R + 4*(R/2) = 3R, clamped', () => {
  const e = new RttEstimator({ minRtoMs: 40, maxRtoMs: 4000 });
  e.sample(100);
  assert.equal(e.srtt(), 100);
  assert.equal(e.rto(), 300);           // 100 + 4*50
});
test('steady low-RTT LAN converges to a low rto, floored at min', () => {
  const e = new RttEstimator({ minRtoMs: 40 });
  for (let i = 0; i < 50; i++) e.sample(2);
  assert.ok(e.rto() <= 60, `rto ${e.rto()} should approach the 40ms floor`);
  assert.ok(e.rto() >= 40);
});
test('rto never exceeds maxRtoMs', () => {
  const e = new RttEstimator({ maxRtoMs: 4000 });
  e.sample(100000);
  assert.equal(e.rto(), 4000);
});
```
- [ ] **Step 2: run → FAIL** (module not found). `cd core && npm run build:test && node --test --test-reporter=spec dist-test/transport/__tests__/rtt.test.js`
- [ ] **Step 3: implement** `rtt.ts` per the interface (pure; no timers, no Date).
```ts
// core/src/transport/rtt.ts
/** RFC 6298 RTT/RTO estimator with a LAN-appropriate low floor. Pure. */
export class RttEstimator {
  private srttMs: number | null = null;
  private rttvarMs = 0;
  private readonly minRtoMs: number;
  private readonly maxRtoMs: number;
  private readonly initialRtoMs = 300;
  constructor(opts: { minRtoMs?: number; maxRtoMs?: number } = {}) {
    this.minRtoMs = opts.minRtoMs ?? 40;
    this.maxRtoMs = opts.maxRtoMs ?? 4000;
  }
  sample(rttMs: number): void {
    const r = Math.max(0, rttMs);
    if (this.srttMs === null) { this.srttMs = r; this.rttvarMs = r / 2; }
    else {
      this.rttvarMs = 0.75 * this.rttvarMs + 0.25 * Math.abs(this.srttMs - r);
      this.srttMs = 0.875 * this.srttMs + 0.125 * r;
    }
  }
  srtt(): number | null { return this.srttMs; }
  rto(): number {
    if (this.srttMs === null) return this.initialRtoMs;
    const raw = this.srttMs + Math.max(1, 4 * this.rttvarMs);
    return Math.min(this.maxRtoMs, Math.max(this.minRtoMs, Math.round(raw)));
  }
}
```
- [ ] **Step 4: run → PASS** (4 tests).
- [ ] **Step 5: commit** `feat(transport): pure RTT/RTO estimator (RFC 6298, LAN floor)`.

### Task A2: Wire the estimator into ReliableConnection (adaptive RTO + Karn)

**Files:** Modify `core/src/transport/reliable.ts`; Test `core/src/transport/__tests__/reliable-rto.test.ts`

**Interfaces:**
- Consumes: `RttEstimator` (A1). Reuses the existing in-process pair helper from `reliable.test.ts` (a `sendDatagram` that hands the buffer to the peer's `onDatagram`, with injectable drop/delay).
- Behavior: on a cumulative ACK that advances `sendBase`, for the newly-acked segment sample `now − sentAt` into the estimator **only if `retries === 0`** (Karn's algorithm — never sample a retransmitted segment). New pending datagrams take `rto = estimator.rto()`. The per-datagram exponential backoff on actual timeout is preserved (double up to `rtoMaxMs`). Keep `rtoMs` option as the estimator's initial/override.

- [ ] **Step 1: failing test** — drive the pair with a fixed ~5ms simulated RTT (delayed delivery via the test's timer hook), send 20 segments, assert that after warmup the connection's exposed `currentRto()` (add a diagnostics getter) is well under the old fixed 300 (e.g. ≤ 80). Also: a lost+retransmitted segment must NOT lower the estimate (Karn) — inject one drop, assert `currentRto()` didn't sample the inflated RTT.
- [ ] **Step 2: run → FAIL.**
- [ ] **Step 3: implement:** add `private rtt = new RttEstimator({minRtoMs, maxRtoMs})`; in `processAck`, before deleting acked pendings, for each seq being acked with `retries===0` call `this.rtt.sample(now - pending.sentAt)`; in `pumpWindow` set `rto: this.rtt.rto()`. Add `currentRto()` diagnostics. Keep everything else.
- [ ] **Step 4: run → PASS.**
- [ ] **Step 5: commit** `feat(transport): adaptive RTT-based RTO with Karn's algorithm`.

### Task A3: Fast-retransmit on 3 duplicate ACKs

**Files:** Modify `core/src/transport/reliable.ts`; Test `core/src/transport/__tests__/reliable-fastrt.test.ts`

**Interfaces:**
- Behavior: track `lastAckSeen` + `dupAckCount`. In `processAck`, if the incoming `ack === lastAckSeen` and there is in-flight data, increment `dupAckCount`; on the **3rd** duplicate immediately retransmit the segment at `sendBase` (the gap) once, reset `dupAckCount` to 0 (avoid retransmit storms), and do NOT alter its RTO/backoff. If `ack` advances, set `lastAckSeen=ack`, `dupAckCount=0`.

- [ ] **Step 1: failing test** — send 10 segments through the pair; drop only seq=3 on first delivery; let 4..9 arrive (each triggers a dup-ACK for ack=3). Assert seq=3 is retransmitted after the 3rd dup-ACK **before** any RTO would fire (measure: retransmit happens within a few ms, not ~current RTO), and the stream delivers all 10 in order.
- [ ] **Step 2: run → FAIL.**
- [ ] **Step 3: implement** the dup-ACK counter + fast-retransmit in `processAck`.
- [ ] **Step 4: run → PASS.**
- [ ] **Step 5: commit** `feat(transport): fast-retransmit on 3 duplicate ACKs`.

### Task A4: Event-driven RTO timer + coalesced ACKs

**Files:** Modify `core/src/transport/reliable.ts`; Test `core/src/transport/__tests__/reliable-timer-ack.test.ts`

**Interfaces:**
- Behavior 1 (timer): replace the `setInterval(rtoMs/2 poll)` with a single `setTimeout` armed for the **earliest** pending `sentAt+rto` deadline; re-arm on every send/ack/retransmit; clear when `inFlight` empties. Unref'd.
- Behavior 2 (ACK coalescing): stop ACKing every in-order DATA. Instead: ACK **immediately** on any out-of-order arrival or gap-fill (so the sender's fast-retransmit signal stays crisp); for a run of in-order deliveries, ACK on every **2nd** segment OR after a **10ms** delayed-ACK timer, whichever first (flush a pending delayed ACK on close/FIN). This roughly halves ACK traffic without stalling the window.

- [ ] **Step 1: failing test** — (a) timer: with one in-flight lost segment and a known RTO, assert exactly one retransmit fires near the deadline (± a small margin), not on a 150ms poll grid. (b) ACK coalescing: send 10 in-order segments; assert the receiver emitted ≤ 6 ACK datagrams (count via a wire tap on the pair), and every segment was still delivered; and an out-of-order arrival produced an immediate ACK.
- [ ] **Step 2: run → FAIL.**
- [ ] **Step 3: implement** the event timer (`armRtoTimer()` computing the min deadline) and the delayed-ACK state (`ackPending`, `inOrderSinceAck`, a 10ms timer, immediate-flush conditions).
- [ ] **Step 4: run → PASS.** Also re-run the full existing `reliable.test.js` — no regressions.
- [ ] **Step 5: commit** `feat(transport): event-driven RTO timer + coalesced ACKs`.

### Task A5: Bounded queues + FIN retransmit

**Files:** Modify `core/src/transport/reliable.ts`; Test `core/src/transport/__tests__/reliable-bounds.test.ts`

**Interfaces:**
- Behavior 1 (waitQueue cap): add `maxQueueBytes` option (default 8 MiB). `send()` returns `boolean` — `false` when the queue is at/over the cap (caller should stop and await `onDrain`). Add an `onDrain?: () => void` callback fired when the queue drops below half the cap after having been over it. (Callers that ignore the return value still work — the queue just applies soft pressure; a HARD cap of 2× still refuses to grow past 16 MiB, dropping the connection with `teardown('send queue overflow')` to protect memory.)
- Behavior 2 (reorderBuf cap): cap at `windowSize × 2` entries; a DATA seq that would exceed it AND is not the next-expected is dropped (not buffered) — the sender retransmits it later in order. Prevents an out-of-order flood from growing memory.
- Behavior 3 (FIN retransmit): `close()` puts the FIN into a retransmit path (send up to 3× on RTO backoff) and defers `onClose`/`teardown` until the FIN is ACKed OR a bounded `finTimeoutMs` (default 2×current RTO, cap 2s) elapses — so a single lost FIN no longer waits out the 30s idle timeout on the peer. (Keep the existing sync-onClose ordering contract that PeerLink depends on: onClose still fires synchronously from teardown; only teardown's *timing* moves.)

- [ ] **Step 1: failing tests** — (a) push > maxQueueBytes without draining → `send()` returns false, `onDrain` fires after acks free space; pushing past the hard cap tears down. (b) flood 500 out-of-order seqs far ahead → reorderBuf size stays ≤ windowSize×2. (c) FIN: drop the first FIN on the pair; assert it is retransmitted and the peer closes well before 30s (within finTimeout), and onClose still fired synchronously on teardown.
- [ ] **Step 2: run → FAIL.**
- [ ] **Step 3: implement** the three bounds. Track queue bytes incrementally.
- [ ] **Step 4: run → PASS** + full reliable suite green.
- [ ] **Step 5: commit** `fix(transport): bound send/reorder queues + retransmit FIN`.

### Task A6: Mixed-version interop guard + port-forward inbound backpressure

**Files:** Modify `core/src/hub-client/port-forward-handler.ts`; Test `core/src/transport/__tests__/reliable-interop.test.ts` + `core/src/hub-client/__tests__/inbound-backpressure.test.ts`

**Interfaces:**
- Interop test (no code change to reliable — this PROVES A2–A5 stayed wire-compatible): wire an in-process pair where one endpoint has the NEW policy and the other simulates OLD policy (ACK-every-packet, fixed RTO) — assert a bidirectional stream completes intact. (Simulate OLD by constructing a ReliableConnection with options that disable coalescing/fast-rt via a test-only flag, OR by hand-driving raw datagrams.)
- Port-forward fix: in `handleForwardData` (port-forward-handler.ts:524), check `socket.write(payload)` return. On `false`, buffer subsequent inbound payloads for that stream in a bounded per-stream queue and stop writing until the socket emits `'drain'`; resume draining then. If the per-stream buffer exceeds a hard cap (e.g. 4 MiB), tear the stream down (`notifyPeer:true`) — the local consumer can't keep up. (There is no per-stream WS pause since the WS is shared/multiplexed, so a bounded buffer + drain is the correct local mechanism; document that the sender side already pauses via `wireSocket`'s `bufferedAmount` check, so this closes the *other* direction.)

- [ ] **Step 1: failing tests** — interop stream completes; and a port-forward stream whose fake local socket returns `write()===false` buffers then drains on `'drain'` (assert no data lost, ordering preserved), and exceeding the hard cap tears down.
- [ ] **Step 2: run → FAIL.**
- [ ] **Step 3: implement** the `handleForwardData` bounded-buffer/drain; add a `pendingDown: Buffer[]` + `pendingDownBytes` + `draining` to the stream record; wire `socket.once('drain', ...)`.
- [ ] **Step 4: run → PASS.**
- [ ] **Step 5: commit** `fix(port-forward): inbound WS→socket backpressure via bounded buffer + drain`.

### Task A7: Build, full transport+PF suites, live 123⇄107 re-test

- [ ] Build clean (`./core.sh build`); run ALL of `dist-test/transport/__tests__/` + `dist-test/hub-client/__tests__/` + `dist-test/__tests__/file-transfer/` on Node v20 — record counts (known-flaky firehose "rate rises…spike" allowed).
- [ ] Deploy Phase-A dist to 123 + 107 (dist-sync + restart; 107 via elevated worker per [[deployment_build_gotchas]]) — OR defer deploy to end of Phase B (note which).
- [ ] Live: 2 MB + 50 MB `transfer_send_file` 123⇄107; record `mode`/`via`/avg MB/s vs the pre-change baseline (today's 2 MB ran `mode:relay`). Phase A alone won't change `mode` (that's Phase B) but SHOULD improve relay throughput materially via adaptive RTO/fast-rt.
- [ ] Commit any fixes; push the branch.

---

## PHASE B — Fabric-channel convergence (Tier 3; begins W2)

> Flesh these tasks to full bite-sized detail AFTER Phase A lands and its reality is known. Outline + interfaces below so the shape is committed.

### Task B1: Stream multiplexing framing (`mux.ts`)
- `class StreamMux` over one `ReliableConnection`: frame = `[1B kind: open|data|eof|close][4B streamId][2B len][payload]`; `openStream()→id`, `write(id, buf)`, `end(id)`, events `onStream/onData/onEof/onClose`. Pure over an injected `send(buf)`/`feed(buf)`. Fully unit-tested on an in-process pair. Back-references the file-transfer 0x00/0x01 framing lesson (message boundaries via length prefix).

### Task B2: Per-peer channel pool (`channel-pool.ts`)
- `getOrOpenChannel(peerGatewayId): Promise<Channel>` — reuse the fabric `PeerManager`'s live channel to a peer when one exists (expose it from `peer-manager`/`peer-link`), else `openChannel`. One `StreamMux` per channel. Ref-count; don't close a channel other streams use. Legacy peer (no fabric/HELLO) → `null` → caller uses today's path.

### Task B3: file-transfer + port-forward ride the pool
- file-transfer `sender.ts`: replace per-transfer `openChannel` with `getOrOpenChannel` + a mux stream; fall back to the current cold-channel path when the pool returns null (legacy peer). Verifies short transfers now report `mode:bidi/via:host` when a warm direct link exists.
- port-forward: each TCP stream becomes a mux stream over the pooled fabric channel (LAN-direct when available); keep the hub-relay byte path as the fallback for legacy peers / no-direct. Backpressure now rides `ReliableConnection`'s window (retire the polling pause on the direct path).
- Live re-test: short 2 MB transfer 123⇄107 now `via:host`; a port-forward between 123⇄107 goes direct (measure latency vs hub-relay).

### Task B4: Final whole-branch review (fable) + consolidated fix wave + live acceptance + deploy

---

## Self-Review (Phase A)
- Wire compatibility: A2–A5 add no datagram types and don't change the header — the A6 interop test is the guard. ✓ (mandated in Global Constraints)
- Every throughput change is independently testable on the in-process pair with fault injection (drop/delay/reorder). ✓
- The sync-onClose contract PeerLink depends on is preserved in A5 (only teardown timing moves, not its synchronicity). ✓
- Memory-safety: waitQueue soft+hard cap, reorderBuf cap, port-forward inbound bounded buffer — all three unbounded paths the audit flagged are closed. ✓
