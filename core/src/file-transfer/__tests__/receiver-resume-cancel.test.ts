/**
 * Receiver resume + cancel tests (Task 5 of the bulk-transfer-job-manager plan).
 *
 * Drives the real handleIncomingTransfer() over an in-process fake Channel
 * pair — the same shape as frame.test.ts's makeFakePair, which already
 * exercises handleIncomingTransfer's non-firehose (FT_META/DATA/END) path —
 * so assertions exercise the real wire format via FrameReader/encodeControl/
 * encodeData, not a shortcut. Covers:
 *
 *   (a) a resumable transfer dropped mid-stream leaves a `.lmpart` sidecar
 *       checkpoint and keeps the partial file (does NOT delete on a plain drop);
 *   (b) a NEW channel resuming that same transfer gets FT_RESUME_STATE back
 *       before any data, streams only the tail from the reported offset, and
 *       completes byte-perfect with the sidecar cleared (proves the prefix
 *       re-hash is correct — a wrong re-hash would sha-mismatch and FT_ERR);
 *   (c) FT_CANCEL deletes both the partial file and the sidecar (contrast
 *       with (a): an explicit cancel cleans up, a plain drop does not);
 *   (d) the stale-partial sweeper deletes an old sidecar+partial but leaves a
 *       fresh one alone.
 *
 * Checkpoint interval is overridden via the test-only seam
 * _setCheckpointIntervalForTest so small (sub-MB) fixtures still exercise
 * real checkpointing — production default (4MB) is untouched.
 *
 * Run (compiled): node --test dist-test/file-transfer/__tests__/receiver-resume-cancel.test.js
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as crypto from 'crypto';
import type { Channel } from '../../transport';
import { FrameReader, encodeControl, encodeData } from '../frame';
import type { FtMeta, FtControl, FtResumeState } from '../types';
import {
  handleIncomingTransfer,
  sweepStalePartials,
  _setCheckpointIntervalForTest,
} from '../receiver';

// ---- In-memory fake Channel pair (same shape as frame.test.ts's makeFakePair) ----

interface FakePair {
  a: Channel;
  b: Channel;
}

/**
 * Two linked channels, reliable + ordered (microtask delivery, never drops,
 * never reorders) — matches the Channel contract's send/sendControl docs. `a`
 * is the side the test drives as the "sender"; `b` is handed to
 * handleIncomingTransfer as the receiver.
 */
function makeFakePair(): FakePair {
  let aData: ((d: Buffer) => void) | null = null;
  let bData: ((d: Buffer) => void) | null = null;
  let aClose: ((r?: string) => void) | null = null;
  let bClose: ((r?: string) => void) | null = null;
  let closed = false;

  const deliver = (cb: () => void) => Promise.resolve().then(cb);
  const pump = (to: () => ((d: Buffer) => void) | null, data: Buffer) => {
    if (closed) {
      return;
    }
    void deliver(() => to()?.(data));
  };

  const a: Channel = {
    id: 'fake-a',
    peerGatewayId: 'peer-b',
    mode: 'relay',
    via: null,
    rtt: null,
    send: (d) => pump(() => bData, d),
    sendControl: (d) => pump(() => bData, d),
    onData: (cb) => { aData = cb; },
    onClose: (cb) => { aClose = cb; },
    sendUnreliable: () => false,
    onUnreliable: () => {},
    directReady: () => false,
    close: () => {
      if (closed) return;
      closed = true;
      void deliver(() => aClose?.());
      void deliver(() => bClose?.());
    },
  };
  const b: Channel = {
    id: 'fake-b',
    peerGatewayId: 'peer-a',
    mode: 'relay',
    via: null,
    rtt: null,
    send: (d) => pump(() => aData, d),
    sendControl: (d) => pump(() => aData, d),
    onData: (cb) => { bData = cb; },
    onClose: (cb) => { bClose = cb; },
    sendUnreliable: () => false,
    onUnreliable: () => {},
    directReady: () => false,
    close: () => {
      if (closed) return;
      closed = true;
      void deliver(() => aClose?.());
      void deliver(() => bClose?.());
    },
  };
  return { a, b };
}

/** Poll `pred` until it returns true, or throw after `timeoutMs`. */
async function waitFor(pred: () => boolean, timeoutMs = 3000, stepMs = 5): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('waitFor: condition not met within ' + timeoutMs + 'ms');
    }
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

function sha256(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/** Attach a listener on `a` that captures every decoded control message the receiver sends. */
function captureControl(a: Channel): FtControl[] {
  const reader = new FrameReader();
  const out: FtControl[] = [];
  a.onData((d) => {
    for (const f of reader.push(d)) {
      if (f.kind === 'control') out.push(f.msg);
    }
  });
  return out;
}

const relPath = 'bigfile.bin';

/**
 * Phase 1 of the resume story: open a fresh channel, send a resumable META
 * for `full`, stream only the first `firstN` bytes, wait for the checkpoint
 * to land on disk, then drop the channel (peer vanished) — leaving a
 * `.lmpart` sidecar + partial file behind. Returns the paths so the caller
 * can inspect them or continue into a resume.
 */
async function seedPartialViaDrop(
  root: string,
  transferId: string,
  full: Buffer,
  firstN: number,
): Promise<{ dest: string; sidecar: string }> {
  const { a, b } = makeFakePair();
  const recvDone = handleIncomingTransfer(b, { root });

  const meta: FtMeta = {
    type: 'FT_META',
    transferId,
    root: '.',
    entries: [{ relPath, size: full.length, mode: 0o644, isDir: false }],
    totalBytes: full.length,
    resumable: true,
  };
  a.send(encodeControl(meta));
  a.send(encodeData(transferId, 0, 0, full.subarray(0, firstN)));

  const dest = path.join(root, relPath);
  const sidecar = dest + '.lmpart';
  await waitFor(() => {
    if (!fs.existsSync(sidecar)) return false;
    try {
      const sc = JSON.parse(fs.readFileSync(sidecar, 'utf8'));
      return sc.bytesDone === firstN;
    } catch {
      return false;
    }
  });

  a.close(); // simulate the sender vanishing mid-stream (peer drop, NOT a cancel)
  await recvDone;
  return { dest, sidecar };
}

test('resumable transfer dropped mid-stream: sidecar checkpoint written, partial kept', { timeout: 5000 }, async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'ft-resume-'));
  try {
    const full = crypto.randomBytes(900_000);
    const FIRST = 500_000;
    _setCheckpointIntervalForTest(200_000);

    const { dest, sidecar } = await seedPartialViaDrop(root, 'resume-tx-1', full, FIRST);

    assert.ok(fs.existsSync(dest), 'partial file kept after a plain drop (not deleted)');
    assert.equal(fs.statSync(dest).size, FIRST, 'partial file has exactly the bytes sent so far');
    assert.ok(fs.existsSync(sidecar), '.lmpart sidecar exists');
    const sc = JSON.parse(fs.readFileSync(sidecar, 'utf8'));
    assert.equal(sc.transferId, 'resume-tx-1');
    assert.equal(sc.size, full.length);
    assert.equal(sc.bytesDone, FIRST, 'sidecar checkpoint records bytesDone at the last checkpoint boundary');
    assert.equal(typeof sc.updatedAt, 'number');
  } finally {
    _setCheckpointIntervalForTest(null);
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('resumable transfer: new channel resumes via FT_RESUME_STATE, completes byte-perfect, sidecar cleared', { timeout: 5000 }, async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'ft-resume-'));
  try {
    const full = crypto.randomBytes(900_000);
    const FIRST = 500_000;
    const transferId = 'resume-tx-2';
    _setCheckpointIntervalForTest(200_000);

    const { dest, sidecar } = await seedPartialViaDrop(root, transferId, full, FIRST);

    // Phase 2: a brand-new channel resumes the same transfer.
    const { a, b } = makeFakePair();
    const sent = captureControl(a);
    const recvDone = handleIncomingTransfer(b, { root });

    const meta: FtMeta = {
      type: 'FT_META',
      transferId,
      root: '.',
      entries: [{ relPath, size: full.length, mode: 0o644, isDir: false }],
      totalBytes: full.length,
      resumable: true,
    };
    a.send(encodeControl(meta));

    await waitFor(() => sent.some((m) => m.type === 'FT_RESUME_STATE'));
    const rs = sent.find((m): m is FtResumeState => m.type === 'FT_RESUME_STATE');
    assert.ok(rs, 'receiver replied FT_RESUME_STATE before any data');
    assert.equal(rs!.transferId, transferId);
    assert.equal(rs!.bytesDone, FIRST, 'receiver reports the checkpointed resume offset');

    // Stream only the tail, starting exactly at the reported resume offset.
    a.send(encodeData(transferId, 0, rs!.bytesDone, full.subarray(rs!.bytesDone)));
    a.send(encodeControl({ type: 'FT_END', transferId, sha256PerEntry: [sha256(full)] }));

    await recvDone;

    assert.ok(sent.some((m) => m.type === 'FT_OK'), 'receiver acknowledged FT_OK (sha matched)');
    assert.ok(!sent.some((m) => m.type === 'FT_ERR'), 'no FT_ERR — the re-hashed prefix + new tail produced the correct sha256');
    const written = await fsp.readFile(dest);
    assert.equal(written.length, full.length, 'final file is the full logical size');
    assert.ok(written.equals(full), 'final file byte-identical to the original (prefix preserved untouched, tail correct)');
    assert.equal(fs.existsSync(sidecar), false, 'sidecar removed after a verified-complete transfer');
  } finally {
    _setCheckpointIntervalForTest(null);
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('FT_CANCEL deletes the partial file and the sidecar', { timeout: 5000 }, async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'ft-cancel-'));
  try {
    const full = crypto.randomBytes(400_000);
    const transferId = 'cancel-tx-1';
    _setCheckpointIntervalForTest(50_000);

    const { a, b } = makeFakePair();
    const recvDone = handleIncomingTransfer(b, { root });

    const meta: FtMeta = {
      type: 'FT_META',
      transferId,
      root: '.',
      entries: [{ relPath, size: full.length, mode: 0o644, isDir: false }],
      totalBytes: full.length,
      resumable: true,
    };
    a.send(encodeControl(meta));
    a.send(encodeData(transferId, 0, 0, full.subarray(0, 200_000)));

    const dest = path.join(root, relPath);
    const sidecar = dest + '.lmpart';
    await waitFor(() => fs.existsSync(sidecar));
    assert.ok(fs.existsSync(dest), 'sanity: partial file exists before cancel');

    a.send(encodeControl({ type: 'FT_CANCEL', transferId, reason: 'test cancel' }));
    await recvDone;

    assert.equal(fs.existsSync(dest), false, 'partial file deleted on cancel');
    assert.equal(fs.existsSync(sidecar), false, 'sidecar deleted on cancel');
  } finally {
    _setCheckpointIntervalForTest(null);
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('sweepStalePartials deletes an old sidecar + partial but leaves a fresh one alone', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'ft-sweep-'));
  try {
    const oldDest = path.join(root, 'old.bin');
    const oldSidecar = oldDest + '.lmpart';
    await fsp.writeFile(oldDest, Buffer.from('stale partial bytes'));
    await fsp.writeFile(oldSidecar, JSON.stringify({
      transferId: 'old-tx', size: 999, bytesDone: 20, updatedAt: Date.now() - 25 * 3600 * 1000,
    }));

    const freshDest = path.join(root, 'fresh.bin');
    const freshSidecar = freshDest + '.lmpart';
    await fsp.writeFile(freshDest, Buffer.from('fresh partial bytes'));
    await fsp.writeFile(freshSidecar, JSON.stringify({
      transferId: 'fresh-tx', size: 999, bytesDone: 20, updatedAt: Date.now(),
    }));

    await sweepStalePartials(root, 24 * 3600 * 1000);

    assert.equal(fs.existsSync(oldDest), false, 'stale partial deleted');
    assert.equal(fs.existsSync(oldSidecar), false, 'stale sidecar deleted');
    assert.equal(fs.existsSync(freshDest), true, 'fresh partial untouched');
    assert.equal(fs.existsSync(freshSidecar), true, 'fresh sidecar untouched');
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});
