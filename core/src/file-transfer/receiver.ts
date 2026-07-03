/**
 * Receiver side of the file-transfer API.
 *
 * handleIncomingTransfer is given an already-open transport Channel (routed to
 * us by the integrator — see protocol.ts) and a safe root. It reads FT_META,
 * pre-creates directories, writes file bytes at their offsets, sets modes,
 * verifies sha256 per file on FT_END, then replies FT_OK or FT_ERR.
 *
 * It also answers FT_LIST requests (a channel that opens with FT_LIST instead
 * of FT_META is a listing probe, not a transfer).
 */

import * as os from 'os';
import * as path from 'path';
import * as fsp from 'fs/promises';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { Channel } from '../transport';
import { FrameReader, encodeControl } from './frame';
import type { FtDelay } from './types';
import { beginTransfer, updateTransfer, setTransferMeta, endTransfer } from './transfer-stats';
import { SUBSYSTEM_TAG } from './protocol';
import { safeJoin } from './safe-path';
import { listDirAbs, statAbs, listDrives, readFileAbs, markDirty } from './fs-inspect';
import {
  FIREHOSE_CHUNK,
  unpackFirehoseDatagram,
  encodeMissingRuns,
} from './firehose-wire';
import type {
  FileEntry,
  FtMeta,
  FtEnd,
  FtOk,
  FtErr,
  FtResumeState,
  FtCancel,
  FtList,
  FtListResult,
  FtListErr,
  FtFs,
  FtFsResult,
  FtFsErr,
  FtFhMeta,
  FtFhEnd,
  FtFhRepair,
  FtNack,
  DirEntry,
} from './types';

/** Don't re-NACK a missing seq within this window — give the repair time to land. */
const RENACK_MIN_MS = 400;
const RENACK_MAX_MS = 4000;

/** Default safe root for received files. */
export function receiveRoot(): string {
  return path.join(os.homedir(), '.lm-assist', 'received');
}

/**
 * Resolve the absolute write target for one entry. When the sender gave an
 * ABSOLUTE remotePath (m.root) the file lands there directly (own-node copy to
 * a chosen location): a single file goes to m.root itself, a directory's
 * entries append under m.root. A RELATIVE remotePath stays under the
 * receive-root via safeJoin (unchanged legacy behavior).
 */
function destFor(root: string, m: FtMeta, e: FileEntry): string {
  if (path.isAbsolute(m.root)) {
    const single = m.entries.length === 1 && !m.entries[0].isDir;
    return single ? m.root : safeJoin(m.root, e.relPath);
  }
  return safeJoin(path.join(root, m.root), e.relPath);
}

// ---------------------------------------------------------------------------
// Resume sidecar — a small JSON checkpoint file living next to a resumable
// transfer's partial output (`<dest>.lmpart`). Everything in this section is
// gated entirely behind `FtMeta.resumable`: a non-resumable transfer never
// reads, writes, or is otherwise aware of this file (see handleMeta/handleData/
// handleEnd below — each resume-specific block is conditioned on it).
// ---------------------------------------------------------------------------

interface Sidecar {
  transferId: string;
  size: number;
  sha256?: string;
  bytesDone: number;
  updatedAt: number;
}

function sidecarPath(dest: string): string {
  return dest + '.lmpart';
}

function writeSidecar(
  dest: string,
  data: { transferId: string; size: number; sha256?: string; bytesDone: number },
): void {
  try {
    const sc: Sidecar = { ...data, updatedAt: Date.now() };
    fs.writeFileSync(sidecarPath(dest), JSON.stringify(sc));
  } catch {
    /* best-effort checkpoint — a failed write just costs a coarser resume point later */
  }
}

function readSidecar(dest: string): Sidecar | null {
  try {
    const sc = JSON.parse(fs.readFileSync(sidecarPath(dest), 'utf8')) as Partial<Sidecar>;
    if (typeof sc.transferId !== 'string' || typeof sc.size !== 'number' || typeof sc.bytesDone !== 'number' || sc.bytesDone < 0) {
      return null; // torn/corrupt sidecar (incl. negative bytesDone) — treat like "no sidecar"
    }
    return sc as Sidecar;
  } catch {
    return null;
  }
}

function rmSidecar(dest: string): void {
  try {
    fs.unlinkSync(sidecarPath(dest));
  } catch {
    /* already gone */
  }
}

/** Per-transfer checkpoint bookkeeping for the single resumable entry (if any). */
interface ResumeCheckpoint {
  entryIndex: number;
  dest: string;
  size: number;
  lastCheckpoint: number;
}

/** Checkpoint cadence: persist the sidecar every N contiguous bytes written. */
const DEFAULT_CHECKPOINT_BYTES = 4 * 1024 * 1024;
let checkpointIntervalOverride: number | null = null;
/**
 * Test seam: override the checkpoint interval (bytes) so small fixtures can
 * exercise real checkpointing quickly. Pass null to restore the 4 MB default.
 * Production code never calls this — mirrors sender.ts's
 * _setChannelOpenerForTest pattern.
 */
export function _setCheckpointIntervalForTest(bytes: number | null): void {
  checkpointIntervalOverride = bytes;
}
function checkpointIntervalBytes(): number {
  return checkpointIntervalOverride ?? DEFAULT_CHECKPOINT_BYTES;
}

// ---------------------------------------------------------------------------
// Stale-partial sweep — covers a sender that vanished without ever sending
// FT_CANCEL (crash, network death, force-quit). Runs on an unref'd timer so it
// never keeps the process alive on its own, and sweepStalePartials is exported
// so callers (and tests) can also invoke it directly instead of waiting out
// the real interval/TTL.
// ---------------------------------------------------------------------------

const STALE_SWEEP_INTERVAL_MS = 30 * 60 * 1000;
const DEFAULT_PARTIAL_TTL_MS = 24 * 3600 * 1000;

async function findLmpartFiles(dir: string): Promise<string[]> {
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const ent of entries) {
    const abs = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      out.push(...(await findLmpartFiles(abs)));
    } else if (ent.isFile() && ent.name.endsWith('.lmpart')) {
      out.push(abs);
    }
  }
  return out;
}

/**
 * Delete stale `.lmpart` sidecars (and their partial file) under `rootDir`
 * whose `updatedAt` is older than `ttlMs`.
 */
export async function sweepStalePartials(
  rootDir: string = receiveRoot(),
  ttlMs: number = Number(process.env.LM_PARTIAL_TTL_MS) || DEFAULT_PARTIAL_TTL_MS,
): Promise<void> {
  const now = Date.now();
  const sidecars = await findLmpartFiles(rootDir);
  for (const sc of sidecars) {
    try {
      const data = JSON.parse(await fsp.readFile(sc, 'utf8')) as { updatedAt?: number };
      if (typeof data.updatedAt !== 'number' || now - data.updatedAt <= ttlMs) {
        continue;
      }
      const dest = sc.slice(0, -'.lmpart'.length);
      await fsp.unlink(sc).catch(() => {});
      await fsp.unlink(dest).catch(() => {});
    } catch {
      /* unreadable/torn sidecar — leave it for a future sweep rather than guess */
    }
  }
}

let staleSweepTimer: NodeJS.Timeout | null = null;
function startStalePartialSweeper(): void {
  if (staleSweepTimer) {
    return;
  }
  staleSweepTimer = setInterval(() => {
    void sweepStalePartials().catch(() => {});
  }, STALE_SWEEP_INTERVAL_MS);
  staleSweepTimer.unref?.();
}
startStalePartialSweeper();

export interface ReceiveOpts {
  /** Safe root under which everything is written. Defaults to receiveRoot(). */
  root?: string;
}

interface OpenFile {
  handle: fsp.FileHandle;
  absPath: string;
  mode: number;
}

/**
 * Take ownership of an inbound transport Channel and service whatever it
 * carries: a file/dir transfer (FT_META...) or a listing probe (FT_LIST).
 * Resolves when the channel's work is done (FT_OK/FT_ERR sent, or list answered).
 */
export function handleIncomingTransfer(
  channel: Channel,
  opts: ReceiveOpts,
): Promise<void> {
  const root = opts.root ?? receiveRoot();
  const reader = new FrameReader();

  return new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      channel.close();
      resolve();
    };

    // Per-transfer state.
    let meta: FtMeta | undefined;
    let transferId = '';
    const openFiles = new Map<number, OpenFile>(); // entryIndex -> handle
    const hashers = new Map<number, crypto.Hash>();
    const seenBytes = new Map<number, number>();
    // Set in handleMeta only for a resumable, single non-dir-entry transfer;
    // drives handleData's checkpoint cadence and handleEnd's sidecar cleanup.
    let resumeCheckpoint: ResumeCheckpoint | null = null;

    // Firehose-mode state (set when FT_FH_META is seen instead of FT_META).
    let fh: FirehoseRecvState | null = null;

    const replyErr = async (id: string, error: string) => {
      endTransfer(id, 'failed', error);
      const msg: FtErr = { type: 'FT_ERR', transferId: id, error };
      try {
        channel.sendControl(encodeControl(msg));
      } catch {
        /* channel may be gone */
      }
      await closeAll(openFiles).catch(() => {});
      finish();
    };

    const handleMeta = async (m: FtMeta) => {
      meta = m;
      transferId = m.transferId;
      beginTransfer({ id: m.transferId, peerGatewayId: channel.peerGatewayId, direction: 'recv', remotePath: m.root, totalBytes: m.totalBytes, kind: 'reliable',
        live: () => ({ mode: channel.mode, via: channel.via, rttMs: channel.rtt }) });
      // Resume only ever applies to a single whole-file transfer (a directory
      // transfer always starts every entry at 0) — mirrors sender.ts's identical
      // scoping note on resumeFrom. Falsy m.resumable short-circuits this to
      // false, so the block below never runs and behavior is unchanged.
      const isResumableSingle = !!m.resumable && m.entries.length === 1 && !m.entries[0].isDir;
      try {
        // Pre-create directories and prepare file handles.
        for (let i = 0; i < m.entries.length; i++) {
          const e = m.entries[i];
          const abs = destFor(root, m, e);
          if (e.isDir) {
            await fsp.mkdir(abs, { recursive: true });
            await fsp.chmod(abs, e.mode).catch(() => {});
            continue;
          }
          await fsp.mkdir(path.dirname(abs), { recursive: true });

          let resumeFrom = 0;
          if (isResumableSingle) {
            const sidecar = readSidecar(abs);
            if (sidecar && sidecar.transferId === m.transferId && sidecar.size === e.size) {
              let existingSize = 0;
              try {
                existingSize = (await fsp.stat(abs)).size;
              } catch {
                existingSize = 0;
              }
              resumeFrom = Math.min(sidecar.bytesDone, existingSize);
            } else if (sidecar) {
              // Sidecar belongs to a different transfer/size — stale, discard
              // it. (The 'w' open below naturally truncates any stale partial
              // bytes, so there is nothing else to clean up here.)
              rmSidecar(abs);
            }
          }

          // Resume opens 'r+' (keep existing bytes, positioned writes only);
          // fresh or non-resumable opens 'w' exactly as before.
          const handle = await fsp.open(abs, resumeFrom > 0 ? 'r+' : 'w');
          openFiles.set(i, { handle, absPath: abs, mode: e.mode });
          const hasher = crypto.createHash('sha256');
          if (resumeFrom > 0) {
            // crypto.Hash state can't be serialized — recompute it from the
            // bytes already on disk so the running sha covers the whole file.
            await rehashFromHandle(handle, resumeFrom, hasher);
          }
          hashers.set(i, hasher);
          seenBytes.set(i, resumeFrom);

          if (isResumableSingle) {
            resumeCheckpoint = { entryIndex: i, dest: abs, size: e.size, lastCheckpoint: resumeFrom };
            const rs: FtResumeState = { type: 'FT_RESUME_STATE', transferId: m.transferId, bytesDone: resumeFrom };
            channel.sendControl(encodeControl(rs));
          }
        }
      } catch (e) {
        await replyErr(m.transferId, 'meta setup failed: ' + (e as Error).message);
      }
    };

    const handleData = async (
      entryIndex: number,
      offset: number,
      bytes: Buffer,
    ) => {
      // Once the transfer has settled (FT_CANCEL/FT_END/drop), ignore any late
      // data. Over the relay, control (FT_CANCEL) rides a priority lane and can
      // overtake in-flight data — without this guard a straggling data frame's
      // checkpoint would re-create the sidecar that handleCancel just deleted.
      if (settled) return;
      const of = openFiles.get(entryIndex);
      if (!of) {
        await replyErr(transferId, 'data for unknown entry ' + entryIndex);
        return;
      }
      try {
        await of.handle.write(bytes, 0, bytes.length, offset);
        hashers.get(entryIndex)!.update(bytes);
        const seen = (seenBytes.get(entryIndex) ?? 0) + bytes.length;
        seenBytes.set(entryIndex, seen);
        // Resumable checkpoint: persist a coarse resume point every ~4MB (or
        // the test-overridden interval) so a later resume doesn't have to
        // restart from 0. Gated on resumeCheckpoint, which is only set for a
        // resumable single-entry transfer (handleMeta) — a no-op otherwise.
        if (
          resumeCheckpoint &&
          resumeCheckpoint.entryIndex === entryIndex &&
          seen - resumeCheckpoint.lastCheckpoint >= checkpointIntervalBytes()
        ) {
          writeSidecar(resumeCheckpoint.dest, {
            transferId,
            size: resumeCheckpoint.size,
            sha256: meta?.sha256,
            bytesDone: seen,
          });
          resumeCheckpoint.lastCheckpoint = seen;
        }
      } catch (e) {
        await replyErr(transferId, 'write failed: ' + (e as Error).message);
      }
    };

    const handleEnd = async (end: FtEnd) => {
      if (!meta) {
        await replyErr(end.transferId, 'FT_END before FT_META');
        return;
      }
      try {
        // Verify sha256 per file, then close + chmod.
        for (let i = 0; i < meta.entries.length; i++) {
          const e = meta.entries[i];
          if (e.isDir) {
            continue;
          }
          const of = openFiles.get(i)!;
          await of.handle.close();
          openFiles.delete(i);
          await fsp.chmod(of.absPath, of.mode).catch(() => {});
          markDirty(of.absPath);
          if (end.sha256PerEntry) {
            const expected = end.sha256PerEntry[i];
            const actual = hashers.get(i)!.digest('hex');
            if (expected && expected !== actual) {
              // Corrupt data: a resumable transfer must never resume from this
              // checkpoint. Drop both the sidecar and the partial file so the
              // next attempt restarts from 0 instead of re-verifying (and
              // re-failing on) the same corrupted on-disk prefix forever.
              if (resumeCheckpoint && resumeCheckpoint.entryIndex === i) {
                rmSidecar(of.absPath);
                await fsp.unlink(of.absPath).catch(() => {});
              }
              await replyErr(
                end.transferId,
                'sha256 mismatch for ' + e.relPath,
              );
              return;
            }
          }
          // Transfer verified complete — the resume sidecar (if any) has done
          // its job.
          if (resumeCheckpoint && resumeCheckpoint.entryIndex === i) {
            rmSidecar(of.absPath);
          }
        }
        const ok: FtOk = { type: 'FT_OK', transferId: end.transferId };
        channel.sendControl(encodeControl(ok));
        setTransferMeta(end.transferId, { mode: channel.mode, via: channel.via });
        endTransfer(end.transferId, 'done');
        finish();
      } catch (e) {
        await replyErr(end.transferId, 'finalize failed: ' + (e as Error).message);
      }
    };

    // Explicit cancellation (job manager gave up, or the user cancelled). Unlike
    // a plain channel drop (handled below in onClose, which KEEPS the partial
    // for a future resume), FT_CANCEL means clean up everything now.
    const handleCancel = async (c: FtCancel) => {
      for (const of of openFiles.values()) {
        await of.handle.close().catch(() => {});
        await fsp.unlink(of.absPath).catch(() => {});
        rmSidecar(of.absPath);
      }
      openFiles.clear();
      endTransfer(c.transferId || transferId, 'failed', 'cancelled' + (c.reason ? ': ' + c.reason : ''));
      finish();
    };

    // ----------------------------- FIREHOSE -------------------------------
    // FT_FH_META enters firehose mode: open the dest file (sparse), allocate a
    // received-bitmap (memory-bounded — 1 bit per chunk, NOT a data buffer),
    // register the unreliable (direct) data callback, and start the NACK timer.

    const handleFhMeta = async (m: FtFhMeta) => {
      transferId = m.transferId;
      beginTransfer({ id: m.transferId, peerGatewayId: channel.peerGatewayId, direction: 'recv', remotePath: m.name, totalBytes: m.size, kind: 'firehose',
        live: () => ({ mode: channel.mode, via: channel.via, rttMs: channel.rtt }) });
      try {
        const abs = path.isAbsolute(m.root)
          ? m.root
          : safeJoin(path.join(root, m.root), m.name);
        await fsp.mkdir(path.dirname(abs), { recursive: true });
        const handle = await fsp.open(abs, 'w');
        // Preallocate (sparse) so writes by offset land correctly even out of order.
        if (m.size > 0) await handle.truncate(m.size).catch(() => {});
        const bitmap = new Uint8Array(Math.ceil(m.totalChunks / 8));
        fh = {
          handle,
          absPath: abs,
          fileMode: m.fileMode,
          chunk: m.chunk || FIREHOSE_CHUNK,
          size: m.size,
          totalChunks: m.totalChunks,
          bitmap,
          received: 0,
          highWater: 0,
          nackedAt: new Float64Array(m.totalChunks),
          repairRtt: 0,
          baseOwd: Infinity,
          curMinOwd: Infinity,
          delayTimer: null,
          ended: false,
          expectedSha: '',
          nackTimer: null,
        };
        // Direct (unreliable) data plane: [seq][payload] → write at seq*chunk.
        channel.onUnreliable((buf) => {
          const u = unpackFirehoseDatagram(buf);
          if (!u || !fh) return;
          // Delay-based control input: queuing delay = one-way delay - its running
          // min (the constant clock offset cancels). FASP/LEDBAT style.
          const owd = Date.now() - u.sendTs;
          if (owd < fh.baseOwd) fh.baseOwd = owd;
          if (owd < fh.curMinOwd) fh.curMinOwd = owd;
          acceptFhChunk(u.seq, u.bytes);
        });
        startNackTimer();
        startDelayTimer();
      } catch (e) {
        await replyErr(m.transferId, 'firehose setup failed: ' + (e as Error).message);
      }
    };

    // Receiver write pipeline: socket-drain (recv) is DECOUPLED from disk I/O.
    // recv synchronously marks the bitmap + queues the payload (instant — the UDP
    // socket never backs up); a background drainer writes concurrently. This is
    // what lets the receiver keep up with a multi-MB/s firehose without dropping.
    const writeQueue: Array<{ seq: number; bytes: Buffer }> = [];
    let draining = false;
    let drainWaiters: Array<() => void> = [];
    const drainWrites = async (): Promise<void> => {
      if (draining) return;
      draining = true;
      try {
        while (writeQueue.length > 0 && fh && !settled) {
          const batch = writeQueue.splice(0, 256);
          await Promise.all(
            batch.map((w) =>
              fh!.handle.write(w.bytes, 0, w.bytes.length, w.seq * fh!.chunk).then(() => {}, () => {})),
          );
        }
      } finally {
        draining = false;
        const ws = drainWaiters; drainWaiters = []; ws.forEach((fn) => fn());
      }
    };
    const flushWrites = (): Promise<void> => {
      if (!draining && writeQueue.length === 0) return Promise.resolve();
      return new Promise<void>((res) => { drainWaiters.push(res); void drainWrites(); });
    };
    const acceptFhChunk = (seq: number, bytes: Buffer): void => {
      if (!fh || settled) return;
      if (seq < 0 || seq >= fh.totalChunks) return;
      if (seq + 1 > fh.highWater) fh.highWater = seq + 1;
      const byteIdx = seq >> 3;
      const mask = 1 << (seq & 7);
      if ((fh.bitmap[byteIdx] & mask) !== 0) return; // already have it
      if (fh.nackedAt[seq] > 0) { // a NACKed gap just got repaired — measure the round-trip
        const rtt = Date.now() - fh.nackedAt[seq];
        fh.repairRtt = fh.repairRtt > 0 ? 0.8 * fh.repairRtt + 0.2 * rtt : rtt;
      }
      fh.bitmap[byteIdx] |= mask;
      fh.received += 1;
      updateTransfer(transferId, Math.min(fh.size, fh.received * fh.chunk));
      writeQueue.push({ seq, bytes }); // dgram allocates a fresh buffer per datagram (no reuse) — no copy needed
      void drainWrites();
    };

    const handleFhRepair = async (r: FtFhRepair) => {
      if (!fh || r.transferId !== transferId) return;
      acceptFhChunk(r.seq, Buffer.from(r.data, 'base64'));
    };

    const handleFhEnd = async (e: FtFhEnd) => {
      if (!fh || e.transferId !== transferId) return;
      fh.ended = true;
      fh.expectedSha = e.sha256;
      await maybeComplete();
    };

    const missingSeqs = (limit: number): number[] => {
      const out: number[] = [];
      if (!fh) return out;
      // Until FT_FH_END, only NACK holes BELOW the high-water mark (real gaps
      // from loss) — never the not-yet-sent tail. 64-chunk margin tolerates UDP
      // reordering. After END the sender has fired everything, so scan all.
      const now = Date.now();
      // Re-NACK grace = ~2x the measured repair RTT, so we never re-NACK a gap
      // before its repair has had time to arrive (else high-RTT paths spam-NACK
      // and falsely escalate everything to relay). Clamped; 600ms until measured.
      const renack = fh.repairRtt > 0
        ? Math.min(RENACK_MAX_MS, Math.max(RENACK_MIN_MS, fh.repairRtt * 2))
        : 600;
      const scanEnd = fh.ended ? fh.totalChunks : Math.max(0, fh.highWater - 64);
      for (let seq = 0; seq < scanEnd && out.length < limit; seq++) {
        const byteIdx = seq >> 3;
        const mask = 1 << (seq & 7);
        if ((fh.bitmap[byteIdx] & mask) !== 0) continue;        // already have it
        if (now - fh.nackedAt[seq] < renack) continue;          // NACKed recently — let the repair arrive first
        fh.nackedAt[seq] = now;
        out.push(seq);
      }
      return out;
    };

    const sendNack = (): void => {
      if (!fh || settled) return;
      // Bound the scan/report so a 64K-chunk file stays cheap; the next interval
      // reports any overflow. We cap at totalChunks but stop early at the limit.
      const missing = missingSeqs(fh.totalChunks);
      if (missing.length === 0) { void maybeComplete(); return; }
      const runs = encodeMissingRuns(missing, 256);
      const msg: FtNack = { type: 'FT_NACK', transferId, missing: runs };
      try { channel.sendControl(encodeControl(msg)); } catch { /* channel gone */ }
    };

    const startNackTimer = (): void => {
      if (!fh || fh.nackTimer) return;
      fh.nackTimer = setInterval(() => { void Promise.resolve().then(sendNack); }, 75);
      fh.nackTimer.unref?.();
    };

    const startDelayTimer = (): void => {
      if (!fh || fh.delayTimer) return;
      fh.delayTimer = setInterval(() => {
        if (!fh || settled) return;
        if (fh.baseOwd === Infinity) return; // no samples yet at all
        const qd = fh.curMinOwd === Infinity ? 0 : Math.max(0, fh.curMinOwd - fh.baseOwd);
        fh.curMinOwd = Infinity; // reset the per-window min
        const msg: FtDelay = { type: 'FT_DELAY', transferId, qd };
        try { channel.sendControl(encodeControl(msg)); } catch { /* channel gone */ }
      }, 50);
      fh.delayTimer.unref?.();
    };

    const maybeComplete = async (): Promise<void> => {
      if (!fh || settled) return;
      if (!fh.ended) return;
      // Drain any in-flight writes before checking completeness.
      await flushWrites();
      if (!fh || settled) return;
      if (fh.received < fh.totalChunks) { sendNack(); return; }
      if (fh.nackTimer) { clearInterval(fh.nackTimer); fh.nackTimer = null; }
      if (fh.delayTimer) { clearInterval(fh.delayTimer); fh.delayTimer = null; }
      try {
        // fsync, close, chmod, verify whole-file sha256.
        await fh.handle.sync().catch(() => {});
        await fh.handle.close();
        await fsp.chmod(fh.absPath, fh.fileMode).catch(() => {});
        const actual = await sha256File(fh.absPath);
        markDirty(fh.absPath);
        if (fh.expectedSha && actual !== fh.expectedSha) {
          const msg: FtErr = { type: 'FT_ERR', transferId, error: 'sha256 mismatch (firehose)' };
          try { channel.sendControl(encodeControl(msg)); } catch { /* gone */ }
          fh = null;
          finish();
          return;
        }
        const ok: FtOk = { type: 'FT_OK', transferId };
        channel.sendControl(encodeControl(ok));
        setTransferMeta(transferId, { mode: channel.mode, via: channel.via });
        endTransfer(transferId, 'done');
        fh = null;
        finish();
      } catch (e) {
        await replyErr(transferId, 'firehose finalize failed: ' + (e as Error).message);
      }
    };

    const handleFs = async (req: FtFs) => {
      try {
        let data: unknown;
        if (req.op === 'drives') data = await listDrives({ refresh: req.refresh });
        else if (req.op === 'stat') data = await statAbs(req.path || '', { refresh: req.refresh });
        else if (req.op === 'read') data = await readFileAbs(req.path || '', { offset: req.offset, maxBytes: req.maxBytes });
        else data = await listDirAbs(req.path || '', { refresh: req.refresh, pattern: req.pattern, regex: req.regex });
        const res: FtFsResult = { type: 'FT_FS_RESULT', op: req.op, data };
        channel.sendControl(encodeControl(res));
      } catch (e) {
        const res: FtFsErr = { type: 'FT_FS_ERR', op: req.op, error: (e as Error).message };
        channel.sendControl(encodeControl(res));
      }
      finish();
    };

    const handleList = async (req: FtList) => {
      try {
        const entries = await listDir(root, req.path);
        const res: FtListResult = { type: 'FT_LIST_RESULT', entries };
        channel.sendControl(encodeControl(res));
      } catch (e) {
        const res: FtListErr = {
          type: 'FT_LIST_ERR',
          error: (e as Error).message,
        };
        channel.sendControl(encodeControl(res));
      }
      finish();
    };

    // A single serial queue across ALL onData calls. Without this, two
    // onData invocations (e.g. FT_META in one chunk, FT_DATA in the next)
    // would run their async handlers concurrently and FT_DATA could land
    // before handleMeta finished opening the file handles.
    let processChain: Promise<void> = Promise.resolve();

    channel.onData((data) => {
      let frames;
      try {
        frames = reader.push(data);
      } catch {
        void replyErr(transferId, 'frame decode error');
        return;
      }
      // Append this chunk's frames to the serial chain so writes stay ordered
      // relative to the manifest and to each other.
      processChain = processChain.then(async () => {
        for (const f of frames) {
          if (f.kind === 'data') {
            await handleData(f.entryIndex, f.offset, f.bytes);
            continue;
          }
          const msg = f.msg as
            | FtMeta
            | FtEnd
            | FtList
            | { type: string };
          switch (msg.type) {
            case SUBSYSTEM_TAG:
              // Opening handshake tag — already routed here, ignore.
              break;
            case 'FT_META':
              await handleMeta(msg as FtMeta);
              break;
            case 'FT_END':
              await handleEnd(msg as FtEnd);
              break;
            case 'FT_CANCEL':
              await handleCancel(msg as FtCancel);
              break;
            case 'FT_FH_META':
              await handleFhMeta(msg as FtFhMeta);
              break;
            case 'FT_FH_REPAIR':
              await handleFhRepair(msg as FtFhRepair);
              break;
            case 'FT_FH_END':
              await handleFhEnd(msg as FtFhEnd);
              break;
            case 'FT_LIST':
              await handleList(msg as FtList);
              break;
            case 'FT_FS':
              await handleFs(msg as FtFs);
              break;
            default:
              // ignore unknown control frames
              break;
          }
        }
      });
    });

    channel.onClose(() => {
      void closeAll(openFiles).catch(() => {});
      if (fh) {
        if (fh.nackTimer) { clearInterval(fh.nackTimer); fh.nackTimer = null; }
      if (fh.delayTimer) { clearInterval(fh.delayTimer); fh.delayTimer = null; }
        fh.handle.close().catch(() => {});
        fh = null;
      }
      finish();
    });
  });
}

/** Firehose-mode receive state (single file). */
interface FirehoseRecvState {
  handle: fsp.FileHandle;
  absPath: string;
  fileMode: number;
  chunk: number;
  size: number;
  totalChunks: number;
  /** Received-bitmap: 1 bit per chunk (memory-bounded, NOT a data buffer). */
  bitmap: Uint8Array;
  received: number;
  highWater: number;  // highest received seq + 1 (bounds first-pass NACK)
  nackedAt: Float64Array;  // per-seq last-NACK time (re-NACK grace)
  repairRtt: number;  // EWMA of NACK->repair-arrival latency (adapts re-NACK grace to RTT)
  baseOwd: number;    // running min one-way delay (ms) — the no-queue baseline
  curMinOwd: number;  // min one-way delay this report window
  delayTimer: NodeJS.Timeout | null;
  ended: boolean;
  expectedSha: string;
  nackTimer: NodeJS.Timeout | null;
}

/** Whole-file sha256 (streamed). */
function sha256File(absPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const rs = fs.createReadStream(absPath);
    rs.on('error', reject);
    rs.on('data', (d) => h.update(d));
    rs.on('end', () => resolve(h.digest('hex')));
  });
}

/**
 * Feed the first `n` bytes of an already-open file handle into `hasher`, in
 * bounded-size chunks. Used to resume a running sha256 across a process
 * restart / new channel — crypto.Hash state cannot be serialized, so a
 * resumed transfer recomputes the prefix hash from what's already on disk.
 */
async function rehashFromHandle(handle: fsp.FileHandle, n: number, hasher: crypto.Hash): Promise<void> {
  if (n <= 0) {
    return;
  }
  const CHUNK = 1024 * 1024;
  const buf = Buffer.allocUnsafe(Math.min(CHUNK, n));
  let pos = 0;
  while (pos < n) {
    const want = Math.min(buf.length, n - pos);
    const { bytesRead } = await handle.read(buf, 0, want, pos);
    if (bytesRead <= 0) {
      break; // partial file shorter than expected — hash what we could
    }
    hasher.update(buf.subarray(0, bytesRead));
    pos += bytesRead;
  }
}

async function closeAll(openFiles: Map<number, OpenFile>): Promise<void> {
  for (const of of openFiles.values()) {
    await of.handle.close().catch(() => {});
  }
  openFiles.clear();
}

/** List a directory under the safe root, returning relative entries. */
async function listDir(root: string, reqPath: string): Promise<DirEntry[]> {
  const base = safeJoin(root, reqPath === '' ? '.' : reqPath);
  const names = await fsp.readdir(base);
  const out: DirEntry[] = [];
  for (const name of names.sort()) {
    const abs = path.join(base, name);
    let st: fs.Stats;
    try {
      st = await fsp.lstat(abs);
    } catch {
      continue;
    }
    out.push({
      name,
      relPath: reqPath === '' || reqPath === '.' ? name : reqPath + '/' + name,
      size: st.size,
      mode: st.mode & 0o777,
      isDir: st.isDirectory(),
      mtimeMs: st.mtimeMs,
    });
  }
  return out;
}
