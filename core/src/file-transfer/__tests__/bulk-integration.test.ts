/**
 * End-to-end integration: the REAL job-manager executor (sendPath) driven through
 * an in-memory bidirectional loopback into the REAL receiver
 * (handleIncomingTransfer), proving resume-after-interrupt and cancel work across
 * the whole stack. These exercise the sender↔receiver glue (meta.resumable +
 * FT_RESUME_STATE + FT_CANCEL) that the per-task unit tests could not — each of
 * those tested only one half, which is exactly how the wiring gaps hid.
 *
 * Run (compiled): node --test dist-test/file-transfer/__tests__/bulk-integration.test.js
 */
import { test, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import type { Channel } from '../../transport';
import { _setChannelOpenerForTest } from '../sender';
import { handleIncomingTransfer, _setCheckpointIntervalForTest } from '../receiver';
import { enqueueJob, getJob, cancelJob, _setStoreForTest } from '../job-manager';
import { JobStore } from '../job-store';

function md5(p: string): string {
  return crypto.createHash('md5').update(fs.readFileSync(p)).digest('hex');
}

/** Wait for a job to reach a terminal state, polling with a REF'd timer. The
 *  job-manager's own timers (backoff, sweeper, waitForJob poll) are all
 *  .unref()'d — correct for production, but it means during a retry backoff the
 *  event loop would otherwise drain and abandon the test. This ref'd poll keeps
 *  the loop alive so those unref'd timers actually fire. */
const TERMINAL = new Set(['done', 'failed', 'cancelled', 'expired']);
async function awaitJobTerminal(jobId: string, timeoutMs: number): Promise<NonNullable<ReturnType<typeof getJob>>> {
  await waitUntil(() => TERMINAL.has(getJob(jobId)?.state ?? ''), timeoutMs);
  const j = getJob(jobId);
  if (!j) throw new Error('job record vanished before terminal');
  return j;
}

async function waitUntil(pred: () => boolean, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  /* eslint-disable no-await-in-loop */
  while (Date.now() < deadline) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  /* eslint-enable no-await-in-loop */
  if (!pred()) throw new Error('waitUntil: condition not met before timeout');
}

interface Pair { chanS: Channel; chanR: Channel; }

/**
 * A bidirectional in-memory Channel pair. `chanS` is handed to sendPath (via the
 * opener seam); `chanR` to handleIncomingTransfer. Bytes crossed over: chanS
 * send/sendControl → chanR.onData and vice-versa. DATA (`send`) can be paced to
 * keep a transfer "active" long enough to cancel; CONTROL (`sendControl`,
 * incl. FT_CANCEL) is always delivered fast (priority), so a cancel frame beats
 * the subsequent close(). `onSData` observes cumulative sender DATA bytes so a
 * test can close the pair mid-stream to simulate an interrupt.
 */
function makeLoopback(hooks: { paceMs?: number; onSData?: (total: number, close: () => void) => void } = {}): Pair {
  let sData: ((d: Buffer) => void) | null = null, sClose: ((r?: string) => void) | null = null;
  let rData: ((d: Buffer) => void) | null = null, rClose: ((r?: string) => void) | null = null;
  let closed = false;
  let sBytes = 0;
  const deliver = (cb: ((d: Buffer) => void) | null, buf: Buffer, fast: boolean): void => {
    if (closed) return; // a write issued AFTER close is rejected.
    const c = Buffer.from(buf);
    // CONTROL / unpaced (microtask): a frame issued BEFORE close must still flush
    // (real channels buffer it) — gate only at call time, so a close() racing a
    // just-queued FT_OK/FT_CANCEL can't swallow it.
    if (fast || !hooks.paceMs) { queueMicrotask(() => cb?.(c)); return; }
    // PACED data (setTimeout): a closed channel stops delivering data in flight, so
    // late DATA can't land after a cancel and rewrite a just-deleted checkpoint.
    const t = setTimeout(() => { if (!closed) cb?.(c); }, hooks.paceMs);
    if (t.unref) t.unref();
  };
  const close = (): void => {
    if (closed) return;
    closed = true;
    queueMicrotask(() => { sClose?.('loopback closed'); rClose?.('loopback closed'); });
  };
  const mk = (isS: boolean): Channel => ({
    id: isS ? 'S' : 'R',
    peerGatewayId: isS ? 'peerR' : 'peerS',
    mode: 'relay',
    via: null,
    rtt: null,
    send: (d: Buffer) => {
      if (isS) { sBytes += d.length; hooks.onSData?.(sBytes, close); }
      deliver(isS ? rData : sData, d, /*fast*/ false);
    },
    sendControl: (d: Buffer) => { deliver(isS ? rData : sData, d, /*fast*/ true); },
    onData: (cb) => { if (isS) sData = cb; else rData = cb; },
    onClose: (cb) => { if (isS) sClose = cb; else rClose = cb; },
    sendUnreliable: () => false,
    onUnreliable: () => {},
    directReady: () => false,
    close,
  });
  return { chanS: mk(true), chanR: mk(false) };
}

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bulk-e2e-'));
  _setStoreForTest(new JobStore(path.join(tmp, 'jobs.jsonl'))); // hermetic — no real ~/.cache log
});
afterEach(() => {
  _setChannelOpenerForTest(null);
  _setCheckpointIntervalForTest(null);
});

test('resume: a >8MB transfer interrupted mid-stream resumes from the receiver checkpoint, byte-perfect', { timeout: 30000 }, async () => {
  _setCheckpointIntervalForTest(512 * 1024); // checkpoint the sidecar every 512KB
  const src = path.join(tmp, 'src.bin');
  const dst = path.join(tmp, 'dst.bin');
  const data = crypto.randomBytes(9 * 1024 * 1024); // > 8MB threshold, < 10MB (avoids the firehose path)
  fs.writeFileSync(src, data);

  let attempt = 0;
  _setChannelOpenerForTest(async () => {
    attempt += 1;
    const first = attempt === 1;
    const { chanS, chanR } = makeLoopback(first
      ? { onSData: (total, close) => { if (total >= 4 * 1024 * 1024) close(); } } // interrupt the FIRST attempt at ~4MB
      : {}); // later attempts run to completion
    handleIncomingTransfer(chanR, { root: tmp }).catch(() => {});
    return chanS;
  });

  const jobId = enqueueJob({ peer: 'peerR', source: { kind: 'file', path: src }, sink: { kind: 'file', path: dst }, size: data.length });
  const v = await awaitJobTerminal(jobId, 25000);

  assert.equal(v.state, 'done', `job should complete (was ${v.state}${v.error ? ': ' + v.error : ''})`);
  assert.ok(attempt >= 2, `should have taken ≥2 channel attempts (interrupt then resume), took ${attempt}`);
  assert.equal(md5(dst), md5(src), 'resumed file must be byte-perfect');
  const rc = getJob(jobId)?.resumeCount ?? 0;
  assert.ok(rc > 0, `resumeCount must be >0 (proves it RESUMED from the checkpoint, not restarted), was ${rc}`);
  assert.ok(!fs.existsSync(dst + '.lmpart'), 'sidecar removed after successful completion');
});

test('restart: a <8MB transfer interrupted restarts from 0 and completes byte-perfect', { timeout: 20000 }, async () => {
  const src = path.join(tmp, 'src.bin');
  const dst = path.join(tmp, 'dst.bin');
  const data = crypto.randomBytes(500 * 1024); // < 8MB ⇒ not resumable
  fs.writeFileSync(src, data);

  let attempt = 0;
  _setChannelOpenerForTest(async () => {
    attempt += 1;
    const first = attempt === 1;
    const { chanS, chanR } = makeLoopback(first ? { onSData: (total, close) => { if (total >= 200 * 1024) close(); } } : {});
    handleIncomingTransfer(chanR, { root: tmp }).catch(() => {});
    return chanS;
  });

  const jobId = enqueueJob({ peer: 'peerR', source: { kind: 'file', path: src }, sink: { kind: 'file', path: dst }, size: data.length });
  const v = await awaitJobTerminal(jobId, 15000);

  assert.equal(v.state, 'done', `job should complete (was ${v.state}${v.error ? ': ' + v.error : ''})`);
  assert.equal(md5(dst), md5(src), 'byte-perfect after restart');
  assert.equal(getJob(jobId)?.resumeCount ?? 0, 0, 'a sub-threshold file restarts, it does not resume (resumeCount 0)');
});

test('cancel: cancelling an active transfer ends "cancelled" and cleans the receiver partial + sidecar', { timeout: 20000 }, async () => {
  _setCheckpointIntervalForTest(256 * 1024);
  const src = path.join(tmp, 'src.bin');
  const dst = path.join(tmp, 'dst.bin');
  const data = crypto.randomBytes(9 * 1024 * 1024); // resumable ⇒ receiver keeps a sidecar we assert gets deleted
  fs.writeFileSync(src, data);
  const sidecar = dst + '.lmpart';

  _setChannelOpenerForTest(async () => {
    const { chanS, chanR } = makeLoopback({ paceMs: 3 }); // pace so it stays active long enough to cancel
    handleIncomingTransfer(chanR, { root: tmp }).catch(() => {});
    return chanS;
  });

  const jobId = enqueueJob({ peer: 'peerR', source: { kind: 'file', path: src }, sink: { kind: 'file', path: dst }, size: data.length });
  // Wait until it's genuinely active with a partial + sidecar on disk, then cancel.
  await waitUntil(() => getJob(jobId)?.state === 'active' && fs.existsSync(sidecar));
  assert.ok(fs.existsSync(dst), 'partial dest exists mid-transfer');
  cancelJob(jobId);
  const v = await awaitJobTerminal(jobId, 15000);

  assert.equal(v.state, 'cancelled', `cancelled job state (was ${v.state})`);
  await new Promise((r) => setTimeout(r, 200)); // let the FT_CANCEL reach + be processed by the receiver
  assert.ok(!fs.existsSync(sidecar), 'sidecar deleted on explicit cancel');
  assert.ok(!fs.existsSync(dst), 'partial dest deleted on explicit cancel (contrast: a drop keeps it)');
});
