/**
 * sendPath abort (opts.signal) + resume (opts.resumeFrom) behavior.
 *
 * sendPath opens its transport channel via openBestChannel(), which reaches a
 * real peer over the hub/transport stack — there's no live two-node network in
 * a unit test. sender.ts exposes a test-only seam, _setChannelOpenerForTest,
 * that swaps in a stub Channel (see sender.ts; production never calls the
 * setter, so the real openBestChannel always ships). The stub decodes
 * whatever sendPath frames onto send()/sendControl() with the same FrameReader
 * the real receiver uses, so assertions here are against the real wire format,
 * not against the stub's own bookkeeping.
 *
 * Run (compiled): node --test dist-test/file-transfer/__tests__/sender-abort-resume.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs'; import * as os from 'os'; import * as path from 'path';
import * as crypto from 'crypto';
import type { Channel } from '../../transport';
import { sendPath, _setChannelOpenerForTest } from '../sender';
import { TransferError } from '../errors';
import { FrameReader, encodeControl } from '../frame';
import type { FtControl, FtMeta, FtEnd, FtOk } from '../types';

interface StubChannelHandle {
  channel: Channel;
  /** Captured FT_DATA frames, decoded off the real wire format (offset + bytes). */
  dataFrames: Array<{ offset: number; bytes: Buffer }>;
  /** Captured control messages (FT_META, FT_END, ...), decoded off the wire. */
  controlMsgs: FtControl[];
  /** Resolves with the FT_META message once sendPath announces the manifest. */
  metaSeen: Promise<FtMeta>;
}

/**
 * A minimal in-process stub standing in for a real transport peer. It never
 * writes files or verifies hashes (that's the receiver's job, out of scope
 * here) — it only captures frames and, when `autoReplyOk`, answers FT_END
 * with FT_OK so sendPath resolves like a real transfer completed.
 */
function makeStubChannel(opts: { autoReplyOk: boolean }): StubChannelHandle {
  const reader = new FrameReader();
  const dataFrames: Array<{ offset: number; bytes: Buffer }> = [];
  const controlMsgs: FtControl[] = [];
  let onDataCb: ((d: Buffer) => void) | null = null;
  let onCloseCb: ((r?: string) => void) | null = null;
  let closed = false;
  let resolveMeta!: (m: FtMeta) => void;
  const metaSeen = new Promise<FtMeta>((res) => { resolveMeta = res; });

  const ingest = (buf: Buffer): void => {
    let frames;
    try { frames = reader.push(buf); } catch { return; }
    for (const f of frames) {
      if (f.kind === 'data') {
        dataFrames.push({ offset: f.offset, bytes: Buffer.from(f.bytes) });
        continue;
      }
      controlMsgs.push(f.msg);
      if (f.msg.type === 'FT_META') {
        resolveMeta(f.msg as FtMeta);
      } else if (opts.autoReplyOk && f.msg.type === 'FT_END') {
        const end = f.msg as FtEnd;
        const ok: FtOk = { type: 'FT_OK', transferId: end.transferId };
        queueMicrotask(() => { if (!closed) onDataCb?.(encodeControl(ok)); });
      }
    }
  };

  const channel: Channel = {
    id: 'stub-channel',
    peerGatewayId: 'stub-peer',
    mode: 'bidi',
    via: 'host',
    rtt: null,
    send: (d: Buffer) => { ingest(d); },
    sendControl: (d: Buffer) => { ingest(d); },
    onData: (cb) => { onDataCb = cb; },
    onClose: (cb) => { onCloseCb = cb; },
    sendUnreliable: () => false,
    onUnreliable: () => {},
    directReady: () => false,
    close: () => {
      if (closed) return;
      closed = true;
      queueMicrotask(() => onCloseCb?.('closed by test stub'));
    },
  };

  return { channel, dataFrames, controlMsgs, metaSeen };
}

/**
 * sendPath's own timers (retry backoff, the total-transfer timeout) are all
 * .unref()'d — correct in production, where the channel's live socket/hub-ws
 * keeps the process alive regardless. Our in-process stub has no such handle,
 * so without a ref'd timer standing in for it, Node's event loop can drain
 * and abort the test mid-flight ("Promise resolution is still pending but the
 * event loop has already resolved"). Mirrors the same helper in
 * firehose.test.ts.
 */
function keepAlive(): { stop: () => void } {
  const t = setInterval(() => {}, 25);
  return { stop: () => clearInterval(t) };
}

test('sendPath: abort signal fired after META rejects fast with TransferError code ABORTED, no fallback re-attempt', { timeout: 5000 }, async () => {
  const ka = keepAlive();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sender-abort-'));
  const file = path.join(dir, 'payload.bin');
  // >= TINY (64KiB) so sendPath doesn't force relay itself — leaving the
  // direct/relay-fallback decision entirely up to abort handling, not sizing.
  fs.writeFileSync(file, crypto.randomBytes(200 * 1024));

  const { channel, metaSeen } = makeStubChannel({ autoReplyOk: false });
  let openCalls = 0;
  _setChannelOpenerForTest(async () => { openCalls += 1; return channel; });

  const ac = new AbortController();
  try {
    const p = sendPath('stub-peer', file, 'remote/payload.bin', {
      signal: ac.signal,
      maxRetries: 0,
      // Bounds how long a NOT-yet-abort-aware sendPath takes to give up on its
      // own, so a RED run fails in ~1.5s instead of the real ~120s default.
      timeoutMs: 1500,
    });

    await metaSeen;
    const abortStart = Date.now();
    ac.abort();

    let caught: unknown;
    try {
      await p;
    } catch (e) {
      caught = e;
    }
    const elapsed = Date.now() - abortStart;

    assert.ok(caught instanceof TransferError, `rejects with a TransferError (got ${String(caught)})`);
    assert.equal((caught as TransferError).code, 'ABORTED');
    assert.ok(elapsed < 500, `aborted within 500ms of the signal firing (took ${elapsed}ms)`);
    assert.equal(openCalls, 1, 'no relay-fallback re-attempt after an abort (channel opened exactly once)');
  } finally {
    _setChannelOpenerForTest(null);
    fs.rmSync(dir, { recursive: true, force: true });
    ka.stop();
  }
});

test('sendPath: resumeFrom streams only the tail starting at the given offset', { timeout: 5000 }, async () => {
  const ka = keepAlive();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sender-resume-'));
  const file = path.join(dir, 'payload.bin');
  const full = crypto.randomBytes(10000);
  fs.writeFileSync(file, full);

  const { channel, dataFrames, controlMsgs } = makeStubChannel({ autoReplyOk: true });
  _setChannelOpenerForTest(async () => channel);

  const progressSamples: Array<{ sent: number; total: number }> = [];
  try {
    const res = await sendPath('stub-peer', file, 'remote/payload.bin', {
      resumeFrom: 6000,
      onProgress: (sent, total) => progressSamples.push({ sent, total }),
    });

    assert.equal(res.bytes, 10000, 'SendResult.bytes reports the full logical file size');

    assert.ok(dataFrames.length > 0, 'at least one data frame was sent');
    assert.equal(dataFrames[0].offset, 6000, 'the first data frame starts at resumeFrom');
    for (const f of dataFrames) {
      assert.ok(f.offset >= 6000, `frame offset ${f.offset} is >= resumeFrom (6000)`);
    }
    const totalSent = dataFrames.reduce((a, f) => a + f.bytes.length, 0);
    assert.equal(totalSent, 4000, 'only the tail (10000 - 6000 = 4000 bytes) was streamed');

    const reconstructedTail = Buffer.concat(dataFrames.map((f) => f.bytes));
    assert.ok(reconstructedTail.equals(full.subarray(6000)), 'streamed bytes match the source tail exactly');

    assert.ok(progressSamples.length > 0, 'onProgress fired at least once');
    const last = progressSamples[progressSamples.length - 1];
    assert.equal(last.sent, 10000, 'progress ends at the full file size (resumeFrom + streamed tail)');
    assert.equal(last.total, 10000);

    const end = controlMsgs.find((m) => m.type === 'FT_END') as FtEnd | undefined;
    assert.ok(end, 'FT_END was sent');
    const expectedFullHash = crypto.createHash('sha256').update(full).digest('hex');
    assert.equal(end!.sha256PerEntry?.[0], expectedFullHash, 'FT_END carries the sha256 of the FULL local file');
  } finally {
    _setChannelOpenerForTest(null);
    fs.rmSync(dir, { recursive: true, force: true });
    ka.stop();
  }
});
