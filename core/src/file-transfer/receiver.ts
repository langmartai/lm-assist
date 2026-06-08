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
import { listDirAbs, statAbs, listDrives, markDirty } from './fs-inspect';
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
      try {
        // Pre-create directories and prepare file handles.
        for (let i = 0; i < m.entries.length; i++) {
          const e = m.entries[i];
          const abs = destFor(root, m, e);
          if (e.isDir) {
            await fsp.mkdir(abs, { recursive: true });
            await fsp.chmod(abs, e.mode).catch(() => {});
          } else {
            await fsp.mkdir(path.dirname(abs), { recursive: true });
            const handle = await fsp.open(abs, 'w');
            openFiles.set(i, { handle, absPath: abs, mode: e.mode });
            hashers.set(i, crypto.createHash('sha256'));
            seenBytes.set(i, 0);
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
      const of = openFiles.get(entryIndex);
      if (!of) {
        await replyErr(transferId, 'data for unknown entry ' + entryIndex);
        return;
      }
      try {
        await of.handle.write(bytes, 0, bytes.length, offset);
        hashers.get(entryIndex)!.update(bytes);
        seenBytes.set(entryIndex, (seenBytes.get(entryIndex) ?? 0) + bytes.length);
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
              await replyErr(
                end.transferId,
                'sha256 mismatch for ' + e.relPath,
              );
              return;
            }
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
