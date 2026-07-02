/**
 * Sender side of the file-transfer API.
 *
 * sendPath stats the local path, walks it if it is a directory, opens a
 * transport Channel to the peer, announces the manifest (FT_META), streams
 * each file's bytes in chunks (FT_DATA binary frames), then sends FT_END with
 * a per-entry sha256. It waits for the receiver's FT_OK before resolving.
 */

import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import { randomUUID } from 'crypto';
import { openChannel, Channel, OpenChannelOpts } from '../transport';
import { openBestChannel } from '../transport/open-best';
import { TcpChannel } from '../transport/tcp-channel';
import { FrameReader, encodeControl, encodeData } from './frame';
import { TransferError, classifyError, isRetriable } from './errors';
import { beginTransfer, updateTransfer, setTransferMeta, endTransfer } from './transfer-stats';
import { SUBSYSTEM_TAG } from './protocol';
import { sendFirehose } from './firehose-sender';
import type {
  FileEntry,
  FtMeta,
  FtEnd,
  FtOk,
  FtErr,
  FtResumeState,
  FtCancel,
  DirEntry,
  FtList,
  FtListResult,
  FtListErr,
  FtFs,
  FtFsResult,
  FtFsErr,
  SendOpts,
  SendResult,
} from './types';

const DEFAULT_CHUNK = 32 * 1024;

// sendPath opens its transport channel via openBestChannel(), which reaches
// out to a real peer over the hub/transport stack — there is no way to unit
// test abort/resume behavior against that without a live two-node network.
// Route the open through a swappable indirection so tests can substitute a
// stub Channel; production never calls the setter, so the default (the real
// openBestChannel) is always what ships.
type ChannelOpener = (peer: string, opts?: OpenChannelOpts) => Promise<Channel>;
let channelOpener: ChannelOpener = openBestChannel;
/** Test seam: override (pass null to restore) the channel opener sendPath uses. */
export function _setChannelOpenerForTest(fn: ChannelOpener | null): void {
  channelOpener = fn ?? openBestChannel;
}

interface WalkedEntry extends FileEntry {
  /** Absolute path on the local filesystem (undefined for synthetic dirs). */
  absPath: string;
}

/** Walk a local path into a flat list of entries (dirs first, depth-first). */
async function walk(localPath: string): Promise<{ entries: WalkedEntry[]; baseName: string }> {
  const st = await fsp.lstat(localPath);
  if (st.isSymbolicLink()) {
    throw new Error('refusing to send symlink: ' + localPath);
  }
  if (st.isFile()) {
    return {
      baseName: path.basename(localPath),
      entries: [
        {
          relPath: path.basename(localPath),
          size: st.size,
          mode: st.mode & 0o777,
          isDir: false,
          absPath: localPath,
        },
      ],
    };
  }
  if (!st.isDirectory()) {
    throw new Error('unsupported file type: ' + localPath);
  }
  const baseName = path.basename(localPath);
  const entries: WalkedEntry[] = [];
  async function recurse(dirAbs: string, relPrefix: string): Promise<void> {
    const dirStat = await fsp.lstat(dirAbs);
    entries.push({
      relPath: relPrefix === '' ? '.' : relPrefix,
      size: 0,
      mode: dirStat.mode & 0o777,
      isDir: true,
      absPath: dirAbs,
    });
    const names = (await fsp.readdir(dirAbs)).sort();
    for (const name of names) {
      const childAbs = path.join(dirAbs, name);
      const childRel = relPrefix === '' ? name : relPrefix + '/' + name;
      const cs = await fsp.lstat(childAbs);
      if (cs.isSymbolicLink()) {
        // Skip symlinks for safety (no escaping the tree).
        continue;
      }
      if (cs.isDirectory()) {
        await recurse(childAbs, childRel);
      } else if (cs.isFile()) {
        entries.push({
          relPath: childRel,
          size: cs.size,
          mode: cs.mode & 0o777,
          isDir: false,
          absPath: childAbs,
        });
      }
      // other types (sockets, devices, fifos) are silently skipped
    }
  }
  await recurse(localPath, '');
  return { entries, baseName };
}

async function sha256File(absPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const rs = fs.createReadStream(absPath);
    rs.on('error', reject);
    rs.on('data', (d) => h.update(d));
    rs.on('end', () => resolve(h.digest('hex')));
  });
}

/**
 * Send a local file or directory to a peer node. Resolves once the receiver
 * has verified and acknowledged the whole transfer.
 */
export async function sendPath(
  peerGatewayId: string,
  localPath: string,
  remotePath: string,
  opts?: SendOpts,
): Promise<SendResult> {
  const { entries } = await walk(localPath);
  const totalBytes = entries.reduce((a, e) => a + (e.isDir ? 0 : e.size), 0);
  const transferId = opts?.transferId ?? randomUUID();
  beginTransfer({ id: transferId, peerGatewayId, direction: 'send', remotePath, totalBytes,
    live: () => (currentChannel ? { mode: currentChannel.mode, via: currentChannel.via, rttMs: currentChannel.rtt } : {}) });
  const onProg = (sent: number, total: number): void => { updateTransfer(transferId, sent); opts?.onProgress?.(sent, total); };

  // --- size-adaptive parameters (chosen up front from the manifest size) ---
  const TINY = 64 * 1024;          // below this: skip direct, relay one-shot
  const LARGE = 10 * 1024 * 1024;  // above this: larger fs reads
  const chunkSize = opts?.chunkSize ?? (totalBytes > LARGE ? 256 * 1024 : DEFAULT_CHUNK);
  // Tiny transfers complete in ~1 round trip on the relay floor before a direct
  // path could even confirm — skip the direct machinery (STUN + socket) entirely.
  const initialForce: 'direct' | 'relay' | undefined =
    opts?.forceMode ?? (totalBytes < TINY ? 'relay' : undefined);
  // Total-transfer backstop timeout, scaled by size. (The 30s reliable idle
  // timeout already catches true stalls; this only bounds a pathologically slow
  // but technically-progressing transfer.)
  const FLOOR_RATE = 100 * 1024; // assume at least 100 KiB/s
  const timeoutMs = opts?.timeoutMs ?? Math.max(120_000, Math.ceil(totalBytes / FLOOR_RATE) * 1000);
  const maxRetries = opts?.maxRetries ?? 2;

  let lastMode = '';
  let currentChannel: Channel | null = null;
  const attempt = async (forceMode?: 'direct' | 'relay'): Promise<SendResult> => {
  const channel = await channelOpener(peerGatewayId, forceMode ? { forceMode } : undefined);
  currentChannel = channel;
  lastMode = channel.mode;
  const isTcp = channel instanceof TcpChannel; // kernel-TCP LAN path — reliable send IS the fast path
  let onAbort: (() => void) | undefined;
  try {
    if (opts?.signal) {
      if (opts.signal.aborted) throw new TransferError('ABORTED', 'cancelled before start');
      onAbort = () => {
        // Tell the receiver this is an explicit CANCEL — delete the partial +
        // sidecar — as opposed to a mere connection drop, which KEEPS the partial
        // for resume. Best-effort (a relay may drop the queued frame on close;
        // the receiver's stale-partial sweeper is the backstop); the direct/LAN
        // path flushes it before teardown.
        try { channel.sendControl(encodeControl({ type: 'FT_CANCEL', transferId, reason: 'cancelled' } as FtCancel)); } catch { /* ignore */ }
        try { channel.close(); } catch { /* ignore */ }
      };
      opts.signal.addEventListener('abort', onAbort, { once: true });
    }

    // FIREHOSE FAST PATH: single large file (> LARGE) + a confirmed direct path.
    // Wait briefly for the direct leg to confirm; if it does, run the rate-paced
    // firehose. If direct never confirms within the window, fall through to the
    // existing reliable path on THIS channel (unchanged behavior).
    const firehoseEligible =
      process.env.LM_FIREHOSE !== '0' && // default-on for large (>10MB) single-file direct transfers; set LM_FIREHOSE=0 to disable
      !isTcp && // over kernel TCP the plain reliable send() IS line-rate; firehose (UDP blast) is pointless
      forceMode !== 'relay' &&
      entries.length === 1 && !entries[0].isDir && totalBytes > LARGE;
    if (firehoseEligible && (await waitForDirect(channel, 3000))) {
      const e0 = entries[0];
      setTransferMeta(transferId, { kind: 'firehose' });
      const res = await sendFirehose(
        channel, e0.absPath, remotePath, e0.relPath, totalBytes, e0.mode,
        { onProgress: onProg },
      );
      lastMode = channel.mode;
      return res;
    }

    const reader = new FrameReader();
    // Resume handshake: a resumable single-file transfer waits for the receiver's
    // FT_RESUME_STATE (how much it durably holds) and streams from THAT offset —
    // the receiver's checkpointed sidecar is authoritative. resumeStateP resolves
    // when waitForReply sees the frame.
    let resolveResume: ((n: number) => void) | null = null;
    const resumeStateP = new Promise<number>((r) => { resolveResume = r; });
    const done = waitForReply(channel, reader, transferId, (bytesDone) => {
      resolveResume?.(bytesDone); resolveResume = null;
    });
    // Attach a handler NOW so a channel-close that rejects `done` before we
    // reach `await done` below (e.g. the peer resets mid-stream) is not an
    // unhandled rejection (which crashes the process). The real error is still
    // surfaced by `await done` in the try/catch — a promise may carry many
    // handlers.
    done.catch(() => { /* real handling is at `await done` */ });

    // Announce ourselves as a file-transfer channel, then the manifest.
    channel.sendControl(encodeControl({ type: SUBSYSTEM_TAG } as never));

    const singleFile = entries.length === 1 && !entries[0].isDir;
    const wantResume = !!opts?.resumable && singleFile;
    const meta: FtMeta = {
      type: 'FT_META',
      transferId,
      root: remotePath,
      entries: entries.map(({ absPath: _abs, ...e }) => e),
      totalBytes,
      ...(wantResume ? { resumable: true } : {}),
    };
    channel.sendControl(encodeControl(meta));

    // For a resumable transfer, learn the receiver's durable offset before
    // streaming. It always answers (0 for a fresh transfer); the timeout only
    // guards a receiver that doesn't speak resume, falling back to the
    // caller-supplied resumeFrom (or 0).
    let resumeOffset = 0;
    if (wantResume) {
      resumeOffset = await Promise.race([
        resumeStateP,
        new Promise<number>((r) => { const t = setTimeout(() => r(opts?.resumeFrom ?? 0), 5000); t.unref?.(); }),
      ]);
    }

    // Stream file bytes.
    const sha256PerEntry: string[] = [];
    let sent = 0;
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      if (e.isDir) {
        sha256PerEntry.push('');
        continue;
      }
      // resumeFrom only ever applies to single-entry (whole-file) transfers —
      // a multi-entry (directory) transfer always starts each entry at 0. This
      // is intentional (resume is scoped to "resend this one file"), not an
      // oversight, so don't be tempted to thread it across entries. For a
      // resumable transfer the offset is the receiver's authoritative
      // FT_RESUME_STATE (resumeOffset); otherwise fall back to opts.resumeFrom.
      const startOffset = wantResume ? resumeOffset
        : (singleFile && opts?.resumeFrom ? opts.resumeFrom : 0);
      if (startOffset) sent = startOffset;
      await streamFile(channel, transferId, i, e.absPath, chunkSize, (n) => {
        sent += n;
        onProg(sent, totalBytes);
      }, startOffset, opts?.signal);
      sha256PerEntry.push(await sha256File(e.absPath));
    }

    const end: FtEnd = { type: 'FT_END', transferId, sha256PerEntry };
    channel.sendControl(encodeControl(end));

    await done;
    lastMode = channel.mode;
    return { bytes: totalBytes, entries: entries.length, mode: lastMode, via: channel.via, resumedFrom: wantResume ? resumeOffset : 0 };
  } finally {
    if (opts?.signal && onAbort) opts.signal.removeEventListener('abort', onAbort);
    if (currentChannel === channel) currentChannel = null;
    channel.close();
  }
  };

  // One logical run: try the chosen path, then fall back to the relay floor if a
  // direct/hybrid channel established but stalled (hostile reverse-path NAT).
  const oneRun = async (force?: 'direct' | 'relay'): Promise<SendResult> => {
    try {
      return await attempt(force);
    } catch (e) {
      // An abort must propagate immediately — never mask it behind a fresh
      // relay attempt (that would silently retry past a cancellation and could
      // take far longer than the caller's "reject fast" expectation).
      if (opts?.signal?.aborted || force === 'relay' || lastMode === 'relay') throw e;
      return await attempt('relay');
    }
  };

  // Retry loop with exponential backoff. The backoff also gives a dropped hub
  // WebSocket time to auto-reconnect before the next attempt (reconnect-aware).
  let lastErr: unknown;
  for (let i = 0; i <= maxRetries; i++) {
    try {
      const res = await withTimeout(
        oneRun(i === 0 ? initialForce : 'relay'),
        timeoutMs,
        () => { try { currentChannel?.close(); } catch { /* ignore */ } },
      );
      setTransferMeta(transferId, { mode: res.mode, via: res.via });
      endTransfer(transferId, 'done');
      return res;
    } catch (e) {
      lastErr = e;
      let code = e instanceof TransferError ? e.code : classifyError(e);
      // A channel close mid-`await done` (triggered by the abort listener)
      // surfaces as a generic "channel closed" rejection classified TIMEOUT;
      // when the caller's signal is what caused it, report it as ABORTED.
      if (opts?.signal?.aborted) code = 'ABORTED';
      if (!isRetriable(code) || i === maxRetries) {
        const err = e instanceof TransferError ? e : new TransferError(code, errMsg(e), e);
        endTransfer(transferId, 'failed', err.message);
        throw err;
      }
      await sleep(Math.min(9000, 1000 * Math.pow(3, i))); // 1s, 3s, 9s
    }
  }
  endTransfer(transferId, 'failed', 'max retries');
  throw new TransferError('MAX_RETRIES', `transfer failed after ${maxRetries + 1} attempts`, lastErr);
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => {
    const t = setTimeout(r, ms);
    if ((t as { unref?: () => void }).unref) (t as { unref: () => void }).unref();
  });
}

/** Resolve true once the channel's direct leg is confirmed, or false after ms. */
async function waitForDirect(channel: Channel, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (channel.directReady()) return true;
    await sleep(50);
  }
  return channel.directReady();
}

/** Reject with a TIMEOUT TransferError if `p` does not settle within `ms`. */
function withTimeout<T>(p: Promise<T>, ms: number, onTimeout?: () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => {
      onTimeout?.();
      reject(new TransferError('TIMEOUT', `transfer exceeded ${ms}ms`));
    }, ms);
    if ((t as { unref?: () => void }).unref) (t as { unref: () => void }).unref();
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

async function streamFile(
  channel: Channel,
  transferId: string,
  entryIndex: number,
  absPath: string,
  chunkSize: number,
  onChunk: (n: number) => void,
  startOffset = 0,
  signal?: AbortSignal,
): Promise<void> {
  const fh = await fsp.open(absPath, 'r');
  try {
    const buf = Buffer.allocUnsafe(chunkSize);
    let offset = startOffset;
    for (;;) {
      // Checked once per chunk (not just before the loop) so abort latency is
      // bounded by chunkSize, not by how much of the file remains — otherwise
      // a closed channel's send() silently no-ops (reliable.ts / tcp-channel.ts)
      // and this loop would happily read+drop every remaining chunk to EOF
      // before the outer await ever sees the rejection.
      if (signal?.aborted) throw new TransferError('ABORTED', 'aborted mid-stream');
      const { bytesRead } = await fh.read(buf, 0, chunkSize, offset);
      if (bytesRead <= 0) {
        break;
      }
      const slice = buf.subarray(0, bytesRead);
      channel.send(encodeData(transferId, entryIndex, offset, slice));
      offset += bytesRead;
      onChunk(bytesRead);
      // Over a kernel-TCP channel, honor socket backpressure: the loop can read
      // + frame far faster than the peer drains, so without this it would flood
      // the channel's internal queue. The UDP channel paces via its own send
      // window, so this only applies to TcpChannel.
      if (channel instanceof TcpChannel && !channel.isWritable()) {
        await channel.whenWritable();
      }
    }
  } finally {
    await fh.close();
  }
}

function waitForReply(
  channel: Channel,
  reader: FrameReader,
  transferId: string,
  onResumeState?: (bytesDone: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (err?: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    };
    channel.onData((data) => {
      let frames;
      try {
        frames = reader.push(data);
      } catch (e) {
        finish(e as Error);
        return;
      }
      for (const f of frames) {
        if (f.kind !== 'control') {
          continue;
        }
        const msg = f.msg as FtOk | FtErr | FtResumeState;
        if (msg.type === 'FT_RESUME_STATE' && msg.transferId === transferId) {
          // Receiver reports how much it durably holds — it is authoritative for
          // the resume offset (its checkpointed sidecar), so honor it over any
          // caller-supplied resumeFrom. Not terminal; keep waiting for FT_OK/ERR.
          onResumeState?.(msg.bytesDone);
          continue;
        }
        if (msg.type === 'FT_OK' && msg.transferId === transferId) {
          finish();
          return;
        }
        if (msg.type === 'FT_ERR' && msg.transferId === transferId) {
          finish(new Error('receiver rejected transfer: ' + msg.error));
          return;
        }
      }
    });
    channel.onClose((reason) => {
      finish(new Error('channel closed before FT_OK' + (reason ? ': ' + reason : '')));
    });
  });
}

/**
 * Ask a peer for a directory listing. Opens a short-lived channel, sends
 * FT_LIST, and resolves with the returned entries.
 */
export function listRemote(
  peerGatewayId: string,
  remotePath: string,
): Promise<DirEntry[]> {
  return new Promise(async (resolve, reject) => {
    let channel: Channel | undefined;
    try {
      channel = await openChannel(peerGatewayId);
    } catch (e) {
      reject(e);
      return;
    }
    const ch = channel;
    const reader = new FrameReader();
    let settled = false;
    const finish = (err: Error | null, entries?: DirEntry[]) => {
      if (settled) {
        return;
      }
      settled = true;
      ch.close();
      if (err) {
        reject(err);
      } else {
        resolve(entries!);
      }
    };
    ch.onData((data) => {
      let frames;
      try {
        frames = reader.push(data);
      } catch (e) {
        finish(e as Error);
        return;
      }
      for (const f of frames) {
        if (f.kind !== 'control') {
          continue;
        }
        const msg = f.msg as FtListResult | FtListErr;
        if (msg.type === 'FT_LIST_RESULT') {
          finish(null, msg.entries);
          return;
        }
        if (msg.type === 'FT_LIST_ERR') {
          finish(new Error('listRemote failed: ' + msg.error));
          return;
        }
      }
    });
    ch.onClose((reason) => {
      finish(new Error('channel closed before listing' + (reason ? ': ' + reason : '')));
    });
    ch.sendControl(encodeControl({ type: SUBSYSTEM_TAG } as never));
    const req: FtList = { type: 'FT_LIST', path: remotePath };
    ch.sendControl(encodeControl(req));
  });
}


/**
 * Ask a peer to run a filesystem inspect (drives / list / stat) over the
 * transport and resolve with the result. Mirrors listRemote: open a short-lived
 * channel, send FT_FS, await FT_FS_RESULT, close.
 */
export function requestFs(
  peerGatewayId: string,
  req: { op: 'drives' | 'list' | 'stat' | 'read'; path?: string; refresh?: boolean; pattern?: string; regex?: boolean; offset?: number; maxBytes?: number },
): Promise<unknown> {
  return new Promise(async (resolve, reject) => {
    let channel: Channel | undefined;
    try {
      channel = await openChannel(peerGatewayId);
    } catch (e) {
      reject(e);
      return;
    }
    const ch = channel;
    const reader = new FrameReader();
    let settled = false;
    const finish = (err: Error | null, data?: unknown) => {
      if (settled) return;
      settled = true;
      ch.close();
      if (err) reject(err);
      else resolve(data);
    };
    ch.onData((data) => {
      let frames;
      try {
        frames = reader.push(data);
      } catch (e) {
        finish(e as Error);
        return;
      }
      for (const f of frames) {
        if (f.kind !== 'control') continue;
        const msg = f.msg as FtFsResult | FtFsErr;
        if (msg.type === 'FT_FS_RESULT') {
          finish(null, msg.data);
          return;
        }
        if (msg.type === 'FT_FS_ERR') {
          finish(new Error('fs request failed: ' + msg.error));
          return;
        }
      }
    });
    ch.onClose((reason) => {
      finish(new Error('channel closed before fs reply' + (reason ? ': ' + reason : '')));
    });
    ch.sendControl(encodeControl({ type: SUBSYSTEM_TAG } as never));
    const r: FtFs = { type: 'FT_FS', op: req.op, path: req.path, refresh: req.refresh, pattern: req.pattern, regex: req.regex, offset: req.offset, maxBytes: req.maxBytes };
    ch.sendControl(encodeControl(r));
  });
}
