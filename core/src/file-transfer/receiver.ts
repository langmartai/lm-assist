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
import { SUBSYSTEM_TAG } from './protocol';
import { safeJoin } from './safe-path';
import type {
  FileEntry,
  FtMeta,
  FtEnd,
  FtOk,
  FtErr,
  FtList,
  FtListResult,
  FtListErr,
  DirEntry,
} from './types';

/** Default safe root for received files. */
export function receiveRoot(): string {
  return path.join(os.homedir(), '.lm-assist', 'received');
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

    const replyErr = async (id: string, error: string) => {
      const msg: FtErr = { type: 'FT_ERR', transferId: id, error };
      try {
        channel.send(encodeControl(msg));
      } catch {
        /* channel may be gone */
      }
      await closeAll(openFiles).catch(() => {});
      finish();
    };

    const handleMeta = async (m: FtMeta) => {
      meta = m;
      transferId = m.transferId;
      try {
        // Pre-create directories and prepare file handles.
        for (let i = 0; i < m.entries.length; i++) {
          const e = m.entries[i];
          const abs = safeJoin(path.join(root, m.root), e.relPath);
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
        channel.send(encodeControl(ok));
        finish();
      } catch (e) {
        await replyErr(end.transferId, 'finalize failed: ' + (e as Error).message);
      }
    };

    const handleList = async (req: FtList) => {
      try {
        const entries = await listDir(root, req.path);
        const res: FtListResult = { type: 'FT_LIST_RESULT', entries };
        channel.send(encodeControl(res));
      } catch (e) {
        const res: FtListErr = {
          type: 'FT_LIST_ERR',
          error: (e as Error).message,
        };
        channel.send(encodeControl(res));
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
            case 'FT_LIST':
              await handleList(msg as FtList);
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
      finish();
    });
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
