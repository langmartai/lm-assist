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
import { openChannel, Channel } from '../transport';
import { FrameReader, encodeControl, encodeData } from './frame';
import { TransferError, classifyError, isRetriable } from './errors';
import { SUBSYSTEM_TAG } from './protocol';
import { sendFirehose } from './firehose-sender';
import type {
  FileEntry,
  FtMeta,
  FtEnd,
  FtOk,
  FtErr,
  DirEntry,
  FtList,
  FtListResult,
  FtListErr,
  SendOpts,
  SendResult,
} from './types';

const DEFAULT_CHUNK = 32 * 1024;

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
  const transferId = randomUUID();

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
  const channel = await openChannel(peerGatewayId, forceMode ? { forceMode } : undefined);
  currentChannel = channel;
  lastMode = channel.mode;
  try {
    // FIREHOSE FAST PATH: single large file (> LARGE) + a confirmed direct path.
    // Wait briefly for the direct leg to confirm; if it does, run the rate-paced
    // firehose. If direct never confirms within the window, fall through to the
    // existing reliable path on THIS channel (unchanged behavior).
    const firehoseEligible =
      process.env.LM_FIREHOSE === '1' && // opt-in: needs real-systems tuning (receiver drain + UDP buffers + AIMD) before default-on
      forceMode !== 'relay' &&
      entries.length === 1 && !entries[0].isDir && totalBytes > LARGE;
    if (firehoseEligible && (await waitForDirect(channel, 3000))) {
      const e0 = entries[0];
      const res = await sendFirehose(
        channel, e0.absPath, remotePath, e0.relPath, totalBytes, e0.mode,
        { onProgress: opts?.onProgress },
      );
      lastMode = channel.mode;
      return res;
    }

    const reader = new FrameReader();
    const done = waitForReply(channel, reader, transferId);

    // Announce ourselves as a file-transfer channel, then the manifest.
    channel.sendControl(encodeControl({ type: SUBSYSTEM_TAG } as never));

    const meta: FtMeta = {
      type: 'FT_META',
      transferId,
      root: remotePath,
      entries: entries.map(({ absPath: _abs, ...e }) => e),
      totalBytes,
    };
    channel.sendControl(encodeControl(meta));

    // Stream file bytes.
    const sha256PerEntry: string[] = [];
    let sent = 0;
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      if (e.isDir) {
        sha256PerEntry.push('');
        continue;
      }
      await streamFile(channel, transferId, i, e.absPath, chunkSize, (n) => {
        sent += n;
        opts?.onProgress?.(sent, totalBytes);
      });
      sha256PerEntry.push(await sha256File(e.absPath));
    }

    const end: FtEnd = { type: 'FT_END', transferId, sha256PerEntry };
    channel.sendControl(encodeControl(end));

    await done;
    lastMode = channel.mode;
    return { bytes: totalBytes, entries: entries.length, mode: lastMode, via: channel.via };
  } finally {
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
      if (force === 'relay' || lastMode === 'relay') throw e;
      return await attempt('relay');
    }
  };

  // Retry loop with exponential backoff. The backoff also gives a dropped hub
  // WebSocket time to auto-reconnect before the next attempt (reconnect-aware).
  let lastErr: unknown;
  for (let i = 0; i <= maxRetries; i++) {
    try {
      return await withTimeout(
        oneRun(i === 0 ? initialForce : 'relay'),
        timeoutMs,
        () => { try { currentChannel?.close(); } catch { /* ignore */ } },
      );
    } catch (e) {
      lastErr = e;
      const code = e instanceof TransferError ? e.code : classifyError(e);
      if (!isRetriable(code) || i === maxRetries) {
        throw e instanceof TransferError ? e : new TransferError(code, errMsg(e), e);
      }
      await sleep(Math.min(9000, 1000 * Math.pow(3, i))); // 1s, 3s, 9s
    }
  }
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
): Promise<void> {
  const fh = await fsp.open(absPath, 'r');
  try {
    const buf = Buffer.allocUnsafe(chunkSize);
    let offset = 0;
    for (;;) {
      const { bytesRead } = await fh.read(buf, 0, chunkSize, offset);
      if (bytesRead <= 0) {
        break;
      }
      const slice = buf.subarray(0, bytesRead);
      channel.send(encodeData(transferId, entryIndex, offset, slice));
      offset += bytesRead;
      onChunk(bytesRead);
    }
  } finally {
    await fh.close();
  }
}

function waitForReply(
  channel: Channel,
  reader: FrameReader,
  transferId: string,
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
        const msg = f.msg as FtOk | FtErr;
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
