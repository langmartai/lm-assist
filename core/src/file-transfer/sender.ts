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
import { SUBSYSTEM_TAG } from './protocol';
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
  const chunkSize = opts?.chunkSize ?? DEFAULT_CHUNK;
  const { entries } = await walk(localPath);
  const totalBytes = entries.reduce((a, e) => a + (e.isDir ? 0 : e.size), 0);
  const transferId = randomUUID();

  let lastMode = '';
  const attempt = async (forceMode?: 'direct' | 'relay'): Promise<SendResult> => {
  const channel = await openChannel(peerGatewayId, forceMode ? { forceMode } : undefined);
  lastMode = channel.mode;
  try {
    const reader = new FrameReader();
    const done = waitForReply(channel, reader, transferId);

    // Announce ourselves as a file-transfer channel, then the manifest.
    channel.send(encodeControl({ type: SUBSYSTEM_TAG } as never));

    const meta: FtMeta = {
      type: 'FT_META',
      transferId,
      root: remotePath,
      entries: entries.map(({ absPath: _abs, ...e }) => e),
      totalBytes,
    };
    channel.send(encodeControl(meta));

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
    channel.send(encodeControl(end));

    await done;
    return { bytes: totalBytes, entries: entries.length };
  } finally {
    channel.close();
  }
  };
  try {
    return await attempt();
  } catch (e) {
    // A direct channel can establish (punch ok) yet have a hostile reverse path
    // (symmetric/CGNAT): the transfer stalls and idle-times-out. Fall back to the
    // hub relay (reliable, rides the WS). No double-retry if already on relay.
    if (lastMode === 'relay') throw e;
    return await attempt('relay');
  }
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
    ch.send(encodeControl({ type: SUBSYSTEM_TAG } as never));
    const req: FtList = { type: 'FT_LIST', path: remotePath };
    ch.send(encodeControl(req));
  });
}
