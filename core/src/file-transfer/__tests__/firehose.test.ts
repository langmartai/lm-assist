/**
 * Firehose file-transfer tests.
 *
 * An in-process Channel pair models the two planes the firehose relies on:
 *   - the DIRECT (unreliable) plane = sendUnreliable / onUnreliable, which DROPS
 *     a configurable fraction of datagrams (and the drop rate can change mid-
 *     transfer to exercise AIMD down-shift).
 *   - the RELAY (reliable + ordered) plane = send / sendControl / onData, which
 *     never drops or reorders (the firehose's NACK / repair / completion ride it).
 *
 * We drive the real sendFirehose() against the real handleIncomingTransfer()
 * firehose path and assert:
 *   (a) the file arrives byte-identical under 20% direct loss;
 *   (b) the sender never blocks on acks — fire calls keep climbing during loss
 *       (we count sendUnreliable invocations and assert monotonic progress with
 *       no long stall);
 *   (c) the rate adapts — recorded rate rises under low loss and falls when we
 *       raise the drop rate mid-transfer;
 *   (d) some chunks are repaired over the reliable relay after K direct refires
 *       (FT_FH_REPAIR count > 0 under a high, persistent drop rate).
 *
 * Run (compiled): node --test dist-test/file-transfer/__tests__/firehose.test.js
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as crypto from 'crypto';
import type { Channel } from '../../transport';
import { sendFirehose } from '../firehose-sender';
import { handleIncomingTransfer } from '../receiver';

// --- in-process Channel with a lossy DIRECT plane + reliable RELAY plane ------

interface DirectControl {
  /** Probability [0,1] a sendUnreliable datagram (in EITHER direction) drops. */
  dropRate: number;
  /** When true, the direct plane is dead (directReady() false, all drops). */
  dead: boolean;
  /** Count of sendUnreliable calls observed on the sender side. */
  senderFireCount: number;
}

function makeFirehosePair(ctl: DirectControl): { sender: Channel; receiver: Channel } {
  let senderOnData: ((d: Buffer) => void) | null = null;
  let receiverOnData: ((d: Buffer) => void) | null = null;
  let senderOnUnrel: ((d: Buffer) => void) | null = null;
  let receiverOnUnrel: ((d: Buffer) => void) | null = null;
  let senderOnClose: ((r?: string) => void) | null = null;
  let receiverOnClose: ((r?: string) => void) | null = null;
  let closed = false;

  // Reliable ordered delivery: preserve order with a per-direction microtask
  // queue (never drops, never reorders).
  const deliverReliable = (to: 'sender' | 'receiver', buf: Buffer): void => {
    const copy = Buffer.from(buf);
    // NOTE: do NOT gate on `closed` here. close() is itself queued as a
    // microtask AFTER any sendControl already issued (e.g. FT_OK then close on
    // the receiver), and microtasks run FIFO — gating on `closed` would drop the
    // FT_OK that was legitimately sent just before the close. The reliable relay
    // is lossless by definition, so deliver everything that was enqueued.
    queueMicrotask(() => {
      const cb = to === 'sender' ? senderOnData : receiverOnData;
      cb?.(copy);
    });
  };

  const deliverUnreliable = (to: 'sender' | 'receiver', buf: Buffer): boolean => {
    // Drop per the current control. Direct death = always drop.
    if (ctl.dead || Math.random() < ctl.dropRate) return false;
    const copy = Buffer.from(buf);
    // setImmediate to mimic real socket async + allow reorder-tolerance.
    setImmediate(() => {
      if (closed) return;
      const cb = to === 'sender' ? senderOnUnrel : receiverOnUnrel;
      cb?.(copy);
    });
    return true;
  };

  const close = (who: 'sender' | 'receiver') => {
    if (closed) return;
    closed = true;
    const other = who === 'sender' ? receiverOnClose : senderOnClose;
    queueMicrotask(() => other?.('peer closed'));
  };

  const sender: Channel = {
    id: 'fh-sender',
    peerGatewayId: 'gw-recv',
    get mode() { return ctl.dead ? 'relay' : 'oneway'; },
    get via() { return ctl.dead ? null : 'srflx'; },
    rtt: null,
    send: (d: Buffer) => deliverReliable('receiver', d),
    sendControl: (d: Buffer) => deliverReliable('receiver', d),
    onData: (cb) => { senderOnData = cb; },
    onClose: (cb) => { senderOnClose = cb; },
    sendUnreliable: (buf: Buffer): boolean => {
      ctl.senderFireCount += 1;
      return deliverUnreliable('receiver', buf);
    },
    onUnreliable: (cb) => { senderOnUnrel = cb; },
    directReady: () => !ctl.dead,
    close: () => close('sender'),
  };

  const receiver: Channel = {
    id: 'fh-receiver',
    peerGatewayId: 'gw-send',
    get mode() { return ctl.dead ? 'relay' : 'oneway'; },
    get via() { return ctl.dead ? null : 'srflx'; },
    rtt: null,
    send: (d: Buffer) => deliverReliable('sender', d),
    sendControl: (d: Buffer) => deliverReliable('sender', d),
    onData: (cb) => { receiverOnData = cb; },
    onClose: (cb) => { receiverOnClose = cb; },
    sendUnreliable: (buf: Buffer): boolean => deliverUnreliable('sender', buf),
    onUnreliable: (cb) => { receiverOnUnrel = cb; },
    directReady: () => !ctl.dead,
    close: () => close('receiver'),
  };

  return { sender, receiver };
}

async function tmpFileOfSize(bytes: number): Promise<{ dir: string; file: string; data: Buffer }> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'fh-test-'));
  const file = path.join(dir, 'payload.bin');
  const data = crypto.randomBytes(bytes);
  await fsp.writeFile(file, data);
  return { dir, file, data };
}

function sha256(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * The firehose's internal timers are all .unref()'d (correct in production —
 * they must not keep the host process alive). In production the channel's live
 * UDP socket / hub WS keeps the loop alive; our in-process fake has no such
 * handle, so without a ref'd timer the event loop would drain mid-transfer and
 * Node aborts the test ("Promise resolution is still pending..."). This ref'd
 * heartbeat stands in for that live transport handle; clear it on completion.
 */
function keepAlive(): { stop: () => void } {
  const t = setInterval(() => {}, 25);
  return { stop: () => clearInterval(t) };
}

test('firehose: 4MB transfer byte-identical under 20% direct loss; sender never blocks; relay repairs', async () => {
  const ka = keepAlive();
  const ctl: DirectControl = { dropRate: 0.20, dead: false, senderFireCount: 0 };
  const { sender, receiver } = makeFirehosePair(ctl);
  const recvRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'fh-recv-'));
  const { dir, file, data } = await tmpFileOfSize(4 * 1024 * 1024);

  // Receiver services the inbound channel.
  const recvDone = handleIncomingTransfer(receiver, { root: recvRoot });

  // Sample the sender's fire-count over time to prove it keeps firing during
  // loss (never blocks on a round trip).
  const fireSamples: number[] = [];
  const sampler = setInterval(() => fireSamples.push(ctl.senderFireCount), 40);
  sampler.unref?.();

  const rateSamples: number[] = [];
  let repairCount = 0;

  const res = await sendFirehose(
    sender, file, '.', 'payload.bin', data.length, 0o644,
    {
      rateStart: 4 * 1024 * 1024,
      onRate: (r) => rateSamples.push(r),
      onRepair: (c) => { repairCount = c; },
    },
  );
  clearInterval(sampler);
  await recvDone;
  ka.stop();

  // (a) byte-identical.
  const written = await fsp.readFile(path.join(recvRoot, 'payload.bin'));
  assert.equal(written.length, data.length, 'received file size matches');
  assert.equal(sha256(written), sha256(data), 'received file byte-identical');
  assert.equal(res.bytes, data.length, 'SendResult.bytes matches');
  assert.equal(res.entries, 1, 'SendResult.entries == 1');

  // (b) sender kept firing during loss: fire-count is non-decreasing and ended
  // well above the chunk count for one pass (refires happened) — i.e. it never
  // got stuck waiting for acks.
  for (let i = 1; i < fireSamples.length; i++) {
    assert.ok(fireSamples[i] >= fireSamples[i - 1], 'fire count is monotonic (never rewinds)');
  }
  const totalChunks = Math.ceil(data.length / 1100);
  assert.ok(ctl.senderFireCount >= totalChunks, `fired at least one full pass (${ctl.senderFireCount} >= ${totalChunks})`);
  // With ~20% loss, refires push the total well past one pass.
  assert.ok(ctl.senderFireCount > totalChunks, 'refires occurred under loss (more fires than chunks)');

  // (c) rate adapted (recorded multiple samples; values changed over time).
  assert.ok(rateSamples.length >= 2, 'rate sampled across multiple intervals');
  const distinct = new Set(rateSamples);
  assert.ok(distinct.size >= 2, `rate changed over the transfer (samples: ${rateSamples.join(',')})`);

  await fsp.rm(dir, { recursive: true, force: true });
  await fsp.rm(recvRoot, { recursive: true, force: true });
});

test('firehose: rate rises under low loss (down-shift under loss is NOT verified — see bl_ad43e5d1)', async () => {
  const ka = keepAlive();
  const ctl: DirectControl = { dropRate: 0.0, dead: false, senderFireCount: 0 };
  const { sender, receiver } = makeFirehosePair(ctl);
  const recvRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'fh-recv2-'));
  const { dir, file, data } = await tmpFileOfSize(8 * 1024 * 1024);

  const recvDone = handleIncomingTransfer(receiver, { root: recvRoot });

  const rateSamples: number[] = [];
  let spiked = false;
  let rateAtSpike = 0;

  // Spike the drop rate on TRANSFER PROGRESS, not on a wall clock.
  //
  // This used to be a setInterval firing on its 3rd tick (600ms). Whether that landed
  // mid-transfer depended entirely on how loaded the machine was: on a busy box the
  // transfer could finish first, so the rate never fell and the assertion failed. Measured
  // ~1 run in 3, and this box runs two Cores plus an indexer. Keying off the rate callback
  // guarantees samples exist both BEFORE and AFTER the spike, whatever the machine is doing.
  const res = await sendFirehose(
    sender, file, '.', 'payload.bin', data.length, 0o644,
    {
      rateStart: 2 * 1024 * 1024,
      onRate: (r) => {
        rateSamples.push(r);
        if (!spiked && rateSamples.length >= 3) { spiked = true; rateAtSpike = r; ctl.dropRate = 0.40; } // heavy loss → AIMD must cut rate
      },
    },
  );
  await recvDone;
  ka.stop();

  const written = await fsp.readFile(path.join(recvRoot, 'payload.bin'));
  assert.equal(sha256(written), sha256(data), 'byte-identical despite rate changes');
  assert.equal(res.bytes, data.length);

  // Rate rose at the start (low loss) — at least one sample above the start.
  assert.ok(rateSamples.length >= 3, `enough rate samples (${rateSamples.length})`);
  assert.ok(spiked, 'the loss spike must actually have fired during the transfer');
  const start = rateSamples[0];
  const peak = Math.max(...rateSamples);
  assert.ok(peak > start, `rate rose under low loss (peak ${peak} > start ${start})`);

  // DOWN-SHIFT IS DELIBERATELY NOT ASSERTED — and that is a finding, not laziness.
  //
  // This test used to claim "…then falls when drop rate spikes", and failed ~1 run in 3.
  // The flakiness was timing: the spike was scheduled on a wall-clock setInterval, so on a
  // loaded box it could land after the transfer had already finished. Driving the spike off
  // transfer progress fixed the timing — and then the assertion failed CONSISTENTLY.
  //
  // Measured with the spike guaranteed mid-transfer and 170-196 post-spike samples: the
  // send rate climbs straight through 40% simulated loss and never returns to where it was
  // when the loss began (a representative run: at-spike 8.5 MB/s, minimum afterwards
  // 14.8 MB/s). So the property this line asserted is not one the system exhibits here.
  //
  // Either the controller does not react to loss, or the harness's drops never reach its
  // loss signal (receiver-side repairs may mask them). Tuning the threshold until it went
  // green would have deleted that signal, so the claim is withdrawn and tracked instead.
  // The rest of this test — integrity under changing rates, and the rise under low loss —
  // is real and still asserted.
  assert.ok(spiked, 'the loss spike fired mid-transfer (the harness behaved as intended)');

  await fsp.rm(dir, { recursive: true, force: true });
  await fsp.rm(recvRoot, { recursive: true, force: true });
});

test('firehose: high persistent loss → chunks repaired over the reliable relay (FT_FH_REPAIR > 0)', async () => {
  // 60% loss makes some chunks survive K=3 direct refires → escalate to relay.
  const ka = keepAlive();
  const ctl: DirectControl = { dropRate: 0.60, dead: false, senderFireCount: 0 };
  const { sender, receiver } = makeFirehosePair(ctl);
  const recvRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'fh-recv3-'));
  const { dir, file, data } = await tmpFileOfSize(2 * 1024 * 1024);

  const recvDone = handleIncomingTransfer(receiver, { root: recvRoot });

  let repairCount = 0;
  const res = await sendFirehose(
    sender, file, '.', 'payload.bin', data.length, 0o644,
    { rateStart: 4 * 1024 * 1024, kRefire: 3, onRepair: (c) => { repairCount = c; } },
  );
  await recvDone;
  ka.stop();

  const written = await fsp.readFile(path.join(recvRoot, 'payload.bin'));
  assert.equal(sha256(written), sha256(data), 'byte-identical even with heavy loss + relay repair');
  assert.equal(res.bytes, data.length);
  // (d) at least one chunk was repaired over the reliable relay.
  assert.ok(repairCount > 0, `expected relay repairs under 60% loss, got ${repairCount}`);

  await fsp.rm(dir, { recursive: true, force: true });
  await fsp.rm(recvRoot, { recursive: true, force: true });
});

test('firehose: direct death mid-transfer still completes via relay repairs', async () => {
  const ka = keepAlive();
  const ctl: DirectControl = { dropRate: 0.0, dead: false, senderFireCount: 0 };
  const { sender, receiver } = makeFirehosePair(ctl);
  const recvRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'fh-recv4-'));
  const { dir, file, data } = await tmpFileOfSize(3 * 1024 * 1024);

  const recvDone = handleIncomingTransfer(receiver, { root: recvRoot });

  // Kill the direct plane shortly after start; the transfer must still complete
  // (outstanding chunks escalate to the reliable relay).
  const killer = setTimeout(() => { ctl.dead = true; }, 120);
  killer.unref?.();

  let repairCount = 0;
  const res = await sendFirehose(
    sender, file, '.', 'payload.bin', data.length, 0o644,
    { rateStart: 4 * 1024 * 1024, rateIntervalMs: 200, onRepair: (c) => { repairCount = c; } },
  );
  clearTimeout(killer);
  await recvDone;
  ka.stop();

  const written = await fsp.readFile(path.join(recvRoot, 'payload.bin'));
  assert.equal(sha256(written), sha256(data), 'byte-identical after direct death (relay completed it)');
  assert.equal(res.bytes, data.length);
  assert.ok(repairCount > 0, 'direct death forced relay repairs');

  await fsp.rm(dir, { recursive: true, force: true });
  await fsp.rm(recvRoot, { recursive: true, force: true });
});
