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

## REVISION 2026-07-02 (post whole-subsystem review — READ FIRST)

A deep review re-scoped Phase A. The ROOT-CAUSE of slow LAN transfers is **not** the RTO — it is that **ACKs always ride the relay**: `hybrid.ts` `makeReliable` `sendDatagram` routes every `isControl` datagram over `relaySendDatagram` unconditionally (hybrid.ts:301-302), and `reliable.ts` `sendControl` marks every ACK/PING/FIN control (reliable.ts:298). So on a confirmed BIDI direct link the 64×1200B window still only advances at relay-RTT → bulk one-directional throughput ≈ 77 KB / relayRTT no matter how fast the direct data path is. **New Task A0 fixes this and is the single highest-leverage change.**

History gate (systematic-debugging): commit `cc369fb` (2026-06-08) already added RFC6298 RTT/RTO **plus cwnd/slow-start/IW=10/paced sends**, and was reverted 30 min later (`cddee1c`) with **no recorded reason**. Conclusion: the risky part is the congestion-control/pacing machinery. This plan deliberately implements ONLY the low-risk subset (adaptive RTO + fast-retransmit + coalesced ACK) and **NO cwnd / slow-start / send pacing**. Each change is independently fault-injection-tested on the in-process pair.

Revised Phase A order: **A0** (ACK-over-direct, hybrid.ts — the throughput fix) → **A1** RttEstimator (done) → **A2** adaptive RTO+Karn → **A3** fast-retransmit → **A4** event timer + coalesced ACK → **A5** bounded queues + FIN retransmit → **A6** interop + port-forward inbound backpressure (+ exposeLan health-probe bind fix) → **Acleanup** delete orphaned `relay.ts` → **A7** build + suites + live re-test.

### Task A0: Route ACK/control over the direct path when the direct leg is fresh (hybrid.ts)

**Files:** Modify `core/src/transport/hybrid.ts` (`makeReliable`'s `sendDatagram`, ~296-311); Test `core/src/transport/__tests__/hybrid-ack-routing.test.ts`

**Interfaces / behavior:** In `sendDatagram(buf, isControl)`: when `myDirectFresh() && peerUdp && socket` (the SAME freshness gate the DATA path uses), send the datagram over the **direct socket** — for control AND data. Only fall back to `relaySendDatagram` when the direct leg is not fresh. Rationale it's safe: cumulative ACKs are loss-tolerant (the next ACK/piggybacked-ack subsumes a lost one), and the sender's RTO retransmit + A3 fast-retransmit recover any straggler; worst case is exactly today's relay behavior. Keep the `priority=true` semantics for the relay-fallback control path (so control still jumps the relay backpressure queue when relay IS used). Do NOT change the datagram bytes (wire-compatible). This is what makes BIDI actually mean "acks ride direct" as hybrid.ts's own docblock already claims.

- [ ] **Step 1: failing test** — build a hybrid-like harness (or unit-test the extracted routing predicate): with `myDirectFresh()==true`, assert a control datagram is handed to the direct `socket.send` path, NOT `relaySendDatagram`; with `myDirectFresh()==false`, assert it goes to relay. If hybrid.ts's internals are hard to unit-test directly, EXTRACT the routing decision into a pure exported helper `chooseDatagramPath({isControl, directFresh, hasPeer, hasSocket}): 'direct'|'relay'` and test that; then use it in both the data and control branches.
- [ ] **Step 2: run → FAIL.**
- [ ] **Step 3: implement** — extract `chooseDatagramPath` (pure), route both branches through it (direct when fresh regardless of isControl; relay otherwise, control keeping priority). 
- [ ] **Step 4: run → PASS** + full existing `hybrid.test.js` green (the "relay goes quiet at BIDI" assertion should still hold and now be TRUER).
- [ ] **Step 5: commit** `fix(transport): route ACKs/control over the direct path when confirmed — unblocks LAN throughput`.

### Task A-race: Fix the answerer candidate race (index.ts §3.1)

**Files:** Modify `core/src/transport/index.ts` (`answerHybrid` + the two inbound listeners); Test `core/src/transport/__tests__/answer-race.test.ts`

**Verified bug:** `answerHybrid` claims `answeredChannels` on whichever of `transport_relay_open` (no STUN dep — arrives first, `peerUdp=undefined`) or `transport_offer` (STUN-gated, carries the real `udp` candidates) arrives first. The second is dropped. `peerCands` is only assigned `if (opts.initiator)` (hybrid.ts:600,611), so an answerer that claimed from `transport_relay_open` has `peerCands=[]` **forever** → never probes → its own outbound leg never goes direct. Cripples every fabric answerer-role link.

**Fix direction:** let a late `transport_offer` deliver candidates to an already-answered channel. Add a module-level `Map<channelId, (udp)=>void>` that a constructed answerer registers (a setter that updates its `peerCands` + kicks `startProbing`); `transport_offer`'s listener, if the channel is already answered, calls that setter instead of being ignored. (Alternatively: on `transport_relay_open` wait a short bounded window (~250ms) for `transport_offer` before answering — simpler but adds latency. Prefer the setter.) Requires exposing a `setPeerCandidates(udp)` hook from `openHybridChannel`'s answerer path. Unit-test: fire relay_open then a later offer → the answerer ends with non-empty peerCands and probes.

- [ ] Steps: failing test → run FAIL → implement the late-candidate setter path → PASS + hybrid suite green → commit `fix(transport): deliver late transport_offer candidates to the answerer (fixes permanent relay-only answerer legs)`.

### Task A-bind: Fix fixed-port EADDRINUSE silent hang (hybrid.ts §2)

**Files:** Modify `core/src/transport/hybrid.ts` (`setupDirect` socket bind ~567-572); Test `core/src/transport/__tests__/bind-error.test.ts`

**Verified bug:** the UDP socket is created with no `reuseAddr`; `s.on('error', …)` swallows the error; `await s.once('listening')` never resolves on a failed bind → `setupDirect` hangs forever → channel silently relay-only. On a node with `LM_ASSIST_TRANSPORT_PORT` set, the 2nd+ concurrent channel (fabric opens one per peer) hangs. Regression vs the (dead) `holepunch.ts:166` which rejected on bind error.

**Fix direction:** race the `'listening'` promise against `'error'` (and a bounded timeout, ~3s) — on error/timeout, log (under LM_TDEBUG), leave `socket=null`, and RETURN from setupDirect so the relay floor stands (direct simply unavailable for this channel) instead of hanging. Do NOT throw (relay must still work). Consider `dgram.createSocket({type:'udp4', reuseAddr:true})` so multiple channels CAN share a fixed port (SO_REUSEADDR/PORT) — but the primary fix is not-hanging. Test: bind twice to the same fixed port on an injected socket factory → the 2nd setupDirect resolves (relay-only) within the timeout, does not hang.

- [ ] Steps: failing test → FAIL → implement race+timeout (+ reuseAddr) → PASS → commit `fix(transport): don't hang setupDirect on a failed/contended UDP bind (fixed-port nodes)`.

### Task A-roam: Gate direct-datagram roaming to advertised candidates (hybrid.ts §4.2 hardening)

**Files:** Modify `core/src/transport/hybrid.ts` (`adoptPeerSource` / `onUdpMessage`); Test extends an existing transport test.

**Verified issue:** `adoptPeerSource` re-points `peerUdp` to whatever source last sent a probe/firehose/reliable datagram, with NO check that the source matches an advertised peer candidate — an on-LAN/off-path spoofer can redirect the victim's outbound sends or inject into the reliable stream. Full AEAD is the real fix (deferred to W2/encryption — see spec deferred list), but a cheap defense-in-depth now: **only roam to a source IP:port that appears in the peer's advertised candidate set** (`peerCands`) OR the STUN-observed srflx. Reject/ignore datagrams from unadvertised sources for the purpose of roaming (still may process a datagram whose source == current peerUdp). Document that this is hardening, not a substitute for AEAD.

- [ ] Steps: failing test (a datagram from an unadvertised source does NOT change peerUdp; one from an advertised candidate does) → FAIL → implement the candidate-membership gate in `adoptPeerSource` → PASS → commit `fix(transport): gate direct-path roaming to advertised candidates (anti-spoof hardening)`.

### Task Acleanup: Delete orphaned `relay.ts` AND `holepunch.ts`

**Files:** Delete `core/src/transport/relay.ts`; check `core/src/transport/index.ts` re-exports.

BOTH `relay.ts` (`openRelayChannel`) and `holepunch.ts` (`openHolePunchChannel`) have ZERO non-test callers (verified) — superseded by hybrid.ts's inline relay + ladder. relay.ts's 0xFD frame has no tag byte (wire-incompatible landmine); holepunch.ts is a stale pre-revision single-mode impl (its bind-error handling is the CORRECT behavior Task A-bind ports into hybrid.ts — port the good bit, then delete). 
- [ ] Grep-confirm zero callers (`grep -rn "openRelayChannel\|transport/relay" core/src --include=*.ts | grep -v relay.ts`); remove any re-export from `index.ts` (the `TRANSPORT_RELAY_MARKER`/`FIREHOSE_MARKER` re-exports come from hybrid.ts, NOT relay.ts — verify before deleting).
- [ ] `git rm core/src/transport/relay.ts core/src/transport/holepunch.ts` (+ any tests); build clean.
- [ ] **Commit** `chore(transport): remove orphaned relay.ts (superseded by hybrid.ts inline relay; wire-incompatible landmine)`.

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
- ALSO fix the exposeLan health-probe bind (port-forward-handler.ts `probeForward` ~504): it hardcodes `127.0.0.1`/`::1` but an `exposeLan` forward binds its server to the node LAN IP (port-forward.routes.ts:54), so the loopback probe never connects and `health` freezes. Probe against `l.bindHost` (fall back to `127.0.0.1` only when bindHost is `0.0.0.0`/unset).
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

---

## PHASE C — Performance + reliability characterization + perf-status reporting

> Goal (user ask): find both **error-resilience** (does it stay correct + recover under faults) and **best/worst-case performance** (quantified throughput/latency envelope), and make transport **performance status reportable**. Runs after Phase A's reliable-layer fixes land so the numbers reflect the improved behavior; the harnesses (C1/C2) are test-only (no prod risk).

### Task C1: Reliability / error-resilience test matrix (in-process pair)

**Files:** Create `core/src/transport/__tests__/reliability-matrix.test.ts` (extends `makeLossyPair`).

**What:** a parameterized sweep asserting **integrity** (every byte delivered, in order, sha256-verified) and **bounded resources** across a fault matrix:
- drop ∈ {0, 0.05, 0.2, 0.5, 0.8}, reorder ∈ {0, 0.3}, per-datagram delay ∈ {0, 15ms, 200ms}, payload ∈ {1KB, 100KB, 2MB}.
- Event faults: (a) mid-stream blackout — drop 100% for a 500ms window then resume → assert recovery + completion; (b) duplicate flood — replay every datagram 3× → assert dedup, no double-deliver; (c) out-of-order flood far ahead → assert `reorderBuf` size stays ≤ windowSize×2 (the A5 bound) and no OOM.
- Each cell RECORDS: completion time, retransmit count, fast-retransmit count, max in-flight, max reorderBuf; FAIL if data lost/corrupted, if it doesn't complete within a generous deadline, or if a bound is exceeded.
- [ ] failing test → FAIL → implement the matrix + a small per-cell metrics collector (expose the needed counters from ReliableConnection: `retransmits`, `fastRetransmits`, `maxInFlight`, `maxReorder` — add as diagnostics if absent) → PASS (all cells integrity-clean) → commit `test(transport): reliability/error-resilience matrix (drop/reorder/delay/blackout/dup/flood)`.

### Task C2: Performance benchmark — best/typical/worst envelope

**Files:** Create `core/src/transport/__tests__/perf-benchmark.test.ts`.

**What:** measure reliable-layer throughput + latency over the in-process pair (deterministic, no real sockets) across a labeled envelope and PRINT a table; assert a FLOOR per condition so regressions are caught:
- BEST (0% loss, ~1ms delay) · TYPICAL (5% loss, 15ms) · WORST (20% loss, 200ms) · EXTREME (50% loss, 200ms).
- Metrics: throughput MB/s (2MB payload), p50/p99 per-chunk delivery latency, retransmit ratio.
- Print a markdown table to stdout (the "performance report"). Assert e.g. BEST ≥ a floor, WORST completes < a ceiling. This quantifies the reliable-layer win from A2–A4 (adaptive RTO, fast-rt, coalesced ACK): capture the numbers on the pre-A2 baseline vs post to show the delta in the report.
- NOTE: A0 (direct-vs-relay socket routing) is hybrid-level, not visible to the in-process pair — its win is measured LIVE in C3.
- [ ] failing test → FAIL → implement benchmark + table print + floor asserts → PASS → commit `test(transport): best/typical/worst performance benchmark with regression floors`.

### Task C3: Live fleet perf harness (real 123⇄107) — the real A0/Phase-B proof

**Files:** Create `core/scripts/transport-perf.mjs` (a repeatable driver; not shipped in the tool surface).

**What:** run a matrix of `transfer_send_file` 123⇄107 (sizes 1MB/10MB/100MB, direct vs `forceMode:relay`), capture per-run `mode`/`via`/avg MB/s/rttMs from `transfer_stats`, emit a before/after markdown table. Run it (a) on the current fleet build = BASELINE, (b) after Phase A deploy, (c) after Phase B deploy. This is where A0's ACK-over-direct win and Phase B's warm-channel-reuse win actually show up (the in-process tests can't see them).
- [ ] implement the driver; capture the BASELINE now (pre-Phase-A) so the improvement is quantified; commit `test(transport): live fleet perf harness + captured baseline`.

### Task C4: Transport perf-status reporting (the "ensure status can be reported" ask)

**Files:** Modify `core/src/transport/reliable.ts` (+ `hybrid.ts`, `fabric/peer-link.ts`) to expose live perf counters; NEW `core/src/status` provider registration; Modify `core/src/routes/core/fabric.routes.ts` / a `transport` section; extend `transfer-stats.ts`.

**What:**
- Expose from `ReliableConnection` a `stats()` snapshot: `{bytesIn, bytesOut, retransmits, fastRetransmits, dupAcks, srttMs, rtoMs, windowInUse, windowSize, reorderDepth}`. From the hybrid `Channel`: `mode/via/rtt` (already) + the reliable `stats()`.
- Register a **`transport` StatusRegistry provider** (W1 pattern) so `node_status(section="transport")` reports, per online peer: mode/via/rttMs, throughput (bytesOut/elapsed), retransmit ratio, window utilization, + count of active transfers — with a health verdict (`warn` if retransmit ratio high, or a peer is relay-only while a direct leg was expected).
- Add a `perf` block per peer to `GET /fabric/status` (so the existing surface carries it) and a retransmit-ratio to `transfer_stats`.
- MUST add a `TOOL_SCOPES` entry if any NEW MCP tool is introduced (prefer extending `node_status`, which already has `read` scope — no new tool needed).
- [ ] failing tests (provider shape + reliable `stats()` counters increment under the C1 harness) → FAIL → implement counters + provider + route block → PASS → build → commit `feat(transport): live perf counters + transport status section (node_status/fabric status)`.

### Task C5: Phase-C build + full suites + live perf report
- [ ] Build clean; run all transport `__tests__` (incl. C1 matrix + C2 benchmark) on Node v20; capture the C2 table + the C3 live before/after into `docs/` or the final report.
- [ ] Deploy Phase A+C to 123/107 (+117); run C3 live; attach the perf report (best/worst envelope + the A0 direct-vs-relay delta).

---

## FOCUS (user directive 2026-07-02): Direct-TCP-for-LAN + Relay optimization

These two are now the active deliverables (the ~100 MB/s LAN fix + the 2.5→~15-40 MB/s relay fix). DEFERRED (not cut): the reliable-UDP tuning A4/A5 (A0-A3 already landed and help the UDP/srflx path), the A-race/A-bind/A-roam criticals (correctness, do after), Phase B channel-reuse (TCP-for-LAN supersedes much of its intent), srflx measurement (needs a cross-NAT node). Phase C perf/reliability tests stay — they validate D+E.

Measurement basis: LAN host-direct firehose = 9 MB/s (userspace-UDP ceiling); relay = 2.46 MB/s; **hub is only ~3.4ms away (measured) → relay is per-frame-overhead-bound, NOT geography-bound**; we send 3-4k tiny 1200B WS frames/sec where the TCP relay allows 16-64KB frames.

### PHASE D — Direct-TCP for LAN (native speed)

Design: a `TcpChannel` implementing the frozen `Channel` interface (`transport/index.ts`) over a real `net.Socket` with length-prefixed framing (reuse `file-transfer/frame.ts`'s `[4B len][payload]`). It does NOT wrap `ReliableConnection` — `send()` = frame + `socket.write` (honor backpressure via the write-return/`drain`), so the KERNEL's TCP does reliability at line rate. file-transfer's `sendPath` uses `channel.send`/`onData`/`onClose` unchanged → kernel-speed bulk.

- **D1 — `transport/tcp-channel.ts`:** `TcpChannel` over a net.Socket: framed `send`/`onData`, `onClose`, `close`, `mode='bidi'`/`via='host'`/`rtt`; write-backpressure (pause the FT producer via a `writable`/`drain` signal). Unit-test over a local TCP socket pair (integrity + backpressure). `sendUnreliable`→maps to `send` (TCP reliable).
- **D2 — TCP listener + auth:** each node binds a fabric TCP port (advertise host IP + port in the fabric HELLO / peer candidates). Inbound connections send a hello `{fromGatewayId, transferId, token}`; validate the token minted over the hub-authenticated relay control plane (or, under LAN-trust, the peerGatewayId+expected-transfer match). Loopback/LAN-bind only; reject unadvertised sources.
- **D3 — `openBestChannel(peerGatewayId)`:** if the peer has a reachable `host` candidate AND its TCP port is advertised → `TcpChannel` (connect + hello); on connect-fail/timeout or no host candidate → fall back to today's `openChannel` (UDP/relay). Peer must be fabric-capable (else legacy → hybrid).
- **D4 — file-transfer rides it + live measure:** `sender.ts` uses `openBestChannel`; verify 123→107 bulk now streams over TCP; measure MB/s (expect ~100). Port-forward migration = a follow-up.
- Fallback ladder stays intact: TCP (LAN) → UDP direct (srflx) → relay. Nothing regresses for WAN peers.

### PHASE E — Relay optimization (path-aware large frames)

Root cause (measured): relay pushes 3-4k tiny 1200B WS frames/sec; the relay is TCP (WebSocket) where the 1200B UDP-MTU limit is meaningless.

- **E1 — relay feature negotiation:** the fabric/transport HELLO advertises a `relay-batch/1` capability; only batch when BOTH peers support it (mixed-version safe — an old peer keeps getting per-datagram frames). Add to the existing HELLO feature list.
- **E2 — relay batch framing:** new `RELAY_TAG_BATCH = 0x03` carrying `[0x03][count][ (len16 || datagram) × count ]`. On the send side, coalesce reliable datagrams queued for relay in the same tick into ONE big WS frame (target 16-64KB); on receive, `onRelayData` splits a batch and feeds each datagram to `reliable.onDatagram` unchanged (ARQ untouched, seq/ack intact). Only used when the peer advertised `relay-batch/1`.
- **E3 — coalesced ACKs (A4, folded here):** ACK every 2nd in-order datagram or a 10ms timer, immediate on out-of-order — halves the reverse frame count over relay.
- **E4 — path-aware window:** over relay (TCP-backed → no UDP congestion risk) use a large window (e.g. 512 / BDP-scaled); over direct-UDP keep the conservative/adaptive window (A2). `windowSize` becomes path-aware.
- **E5 — (optional) compress the relay batch** (gzip; hub bandwidth is the scarce paid resource) — behind the same capability negotiation.
- **E6 — live measure relay before/after** 123→hub→107; expect 2.5 → ~15-40 MB/s.

### Phase D/E validation
Run Phase C's reliability matrix + benchmark against both new paths; live before/after into `docs/perf/`. Perf-status reporting (C4) surfaces TCP-vs-UDP-vs-relay per peer.
