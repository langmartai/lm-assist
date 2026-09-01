/**
 * Removing something from the backup, for real.
 *
 * THE GIT QUESTION, ANSWERED BY MEASUREMENT: removal never touches git history
 * and never affects the remote. The store's `.gitignore` excludes every payload
 * directory, and the GitHub tree confirms it — the private backup remote holds
 * 6 files, 41 KB, all scripts and status. The payload was never committed, so
 * there is nothing to rewrite. Only `STATUS.md`/`status.json` are versioned, and
 * they commit forward normally.
 *
 * What removal DOES have to defeat is subtler and easy to ship wrong:
 *
 *   1. THE MIRROR RE-CREATES IT. `windows-desk` mirrors the live `.claude`, so a
 *      plain delete is undone by the next run — a removal that reports success
 *      and silently reverts. `exclude` (default on) records the path so capture
 *      refuses it from then on.
 *   2. A TARBALL MEMBER CANNOT BE DELETED IN PLACE. The archive is repacked
 *      without it, pass-through byte-for-byte for everything retained, verified,
 *      then swapped atomically. Nothing is destroyed until the replacement has
 *      been proven readable.
 *
 * Every removal appends to `removals.jsonl`. A backup that can lose things
 * without a record is not a backup.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import type { BackupConfig } from './config';
import { targetDir } from './config';
import { BackupIndex, type StoreArea } from './search-index';
import { filterTar, readTarGz } from './tar-reader';
import { addExclude, appendHistory, appendRemoval, stamp } from './store';

export interface RemoveOutcome {
  removed: boolean;
  id: string;
  kind: string;
  source: string;
  store: StoreArea;
  path: string;
  container?: string;
  /** Whether the path was added to the persistent exclusion list. */
  excluded: boolean;
  /** Set when a snapshot had to be rewritten. */
  repack?: { entriesBefore: number; entriesAfter: number; bytesBefore: number; bytesAfter: number };
  note: string;
}

/**
 * Absolute location of a stored item.
 *
 * For a snapshot member this is the ARCHIVE, not the member — the member has no
 * standalone path, which is precisely why removing one costs a repack.
 */
export function physicalPath(cfg: BackupConfig, item: {
  store: StoreArea; source: string; path: string; container: string;
}): string {
  switch (item.store) {
    case 'mirror':
      return path.join(targetDir(cfg, 'windows-desk'), '.claude', item.path);
    case 'claudeai':
      return path.join(targetDir(cfg, 'claudeai'), item.path);
    case 'memory-rules':
      return path.join(targetDir(cfg, 'memory-rules'), item.source, item.path);
    case 'snapshot':
      return path.join(cfg.root, item.source, item.container);
  }
}

/**
 * Rewrite `file` without `member`, verify the result, then swap it in.
 *
 * The original is replaced only after the replacement has been walked
 * end-to-end and found to contain exactly the expected entries. A crash at any
 * point leaves the original intact — the temp file is the only casualty.
 */
export async function repackWithout(
  file: string, member: string,
): Promise<{ entriesBefore: number; entriesAfter: number; bytesBefore: number; bytesAfter: number }> {
  const tmp = `${file}.repack.tmp`;
  const bytesBefore = fs.statSync(file).size;

  let entriesBefore = 0;
  for await (const _ of readTarGz(file)) entriesBefore++;

  const out = fs.createWriteStream(tmp);
  const gzip = zlib.createGzip();
  gzip.pipe(out);
  // The error listener is attached ONCE. Attaching it per write would add a
  // listener for every 1 MiB chunk — tens of thousands on a 2 GB archive — which
  // leaks memory and trips MaxListenersExceededWarning long before it finishes.
  let streamError: Error | null = null;
  gzip.on('error', (e) => { streamError = e; });
  out.on('error', (e) => { streamError = e; });
  const write = (b: Buffer): Promise<void> =>
    new Promise((resolve, reject) => {
      if (streamError) { reject(streamError); return; }
      if (gzip.write(b)) resolve();
      else gzip.once('drain', resolve);
    });

  const src = fs.createReadStream(file).pipe(zlib.createGunzip());
  const { dropped } = await filterTar(
    src as unknown as AsyncIterable<Buffer>,
    (e) => e.name === member,
    write,
  );
  await new Promise<void>((resolve, reject) => {
    out.once('finish', () => (streamError ? reject(streamError) : resolve()));
    out.once('error', reject);
    gzip.end();
  });

  if (dropped === 0) {
    fs.rmSync(tmp, { force: true });
    throw new Error(`member not found in archive: ${member}`);
  }

  // Verify before destroying anything.
  let entriesAfter = 0;
  let stillThere = false;
  for await (const { entry } of readTarGz(tmp)) {
    entriesAfter++;
    if (entry.name === member) stillThere = true;
  }
  if (stillThere || entriesAfter !== entriesBefore - dropped) {
    fs.rmSync(tmp, { force: true });
    throw new Error(
      `repack verification failed (before ${entriesBefore}, after ${entriesAfter}, dropped ${dropped}` +
      `${stillThere ? ', member still present' : ''}) — original left untouched`,
    );
  }

  const bytesAfter = fs.statSync(tmp).size;
  fs.renameSync(tmp, file);
  return { entriesBefore, entriesAfter, bytesBefore, bytesAfter };
}

export interface RemoveOptions {
  id: string;
  reason: string;
  exclude: boolean;
  scope: 'item' | 'snapshot';
}

export async function removeItem(
  cfg: BackupConfig, index: BackupIndex, opts: RemoveOptions,
): Promise<RemoveOutcome> {
  const item = index.get(opts.id);
  if (!item) throw new Error(`no backed-up item with id "${opts.id}" — run backup_search to get a current id`);

  const target = physicalPath(cfg, item);
  const base: Omit<RemoveOutcome, 'removed' | 'note'> = {
    id: item.id, kind: item.kind, source: item.source, store: item.store,
    path: item.path, container: item.container || undefined, excluded: false,
  };

  // Whole snapshot: the one case where a delete is just a delete.
  if (opts.scope === 'snapshot') {
    if (item.store !== 'snapshot') {
      throw new Error(`scope:"snapshot" only applies to items inside a .tar.gz; this item is in the ${item.store} tree`);
    }
    fs.rmSync(target, { force: true });
    const dropped = index.dropContainer(item.container);
    appendRemoval(cfg, {
      at: stamp(), id: item.id, kind: 'snapshot', source: item.source,
      path: item.container, reason: opts.reason, excluded: false,
    });
    appendHistory(cfg, `removed snapshot ${item.container} (${dropped} indexed items) — ${opts.reason}`);
    return { ...base, removed: true, note: `snapshot ${item.container} deleted; ${dropped} index rows dropped` };
  }

  let repack: RemoveOutcome['repack'];
  if (item.store === 'snapshot') {
    repack = await repackWithout(target, item.member);
  } else {
    if (!fs.existsSync(target)) {
      // The index row outlived the file. Clean the row rather than fail — the
      // caller asked for the item to be gone, and it is.
      index.deleteItem(item.id);
      return { ...base, removed: true, note: 'file was already absent; stale index row removed' };
    }
    fs.rmSync(target, { force: true });
  }

  index.deleteItem(item.id);

  let excluded = false;
  if (opts.exclude && item.store !== 'snapshot') {
    addExclude(cfg, item.path);
    excluded = true;
  }

  appendRemoval(cfg, {
    at: stamp(), id: item.id, kind: item.kind, source: item.source, path: item.path,
    container: item.container || undefined, reason: opts.reason, excluded,
    repacked: !!repack,
  });
  appendHistory(cfg,
    `removed ${item.kind} ${item.source}:${item.path}${repack ? ` (repacked ${item.container})` : ''} — ${opts.reason}`);

  const notes: string[] = [];
  if (repack) {
    notes.push(
      `repacked ${item.container}: ${repack.entriesBefore} → ${repack.entriesAfter} entries, ` +
      `${(repack.bytesBefore / 1048576).toFixed(1)} → ${(repack.bytesAfter / 1048576).toFixed(1)} MB`,
    );
    notes.push(
      'a snapshot is a point-in-time copy, so this member may also exist in OTHER snapshots — ' +
      'search again to check before considering it gone',
    );
  }
  if (excluded) notes.push(`added to excludes.json — future runs will not re-capture ${item.path}`);
  else if (item.store === 'mirror') {
    notes.push('NOT excluded: the next backup will copy this file back from the live .claude');
  }

  return { ...base, removed: true, excluded, repack, note: notes.join('; ') };
}

/**
 * Items in the store that the CURRENT policy would refuse to capture.
 *
 * These are the PowerShell era's leftovers — the store predates capture-time
 * filtering, so it holds files the engine would now never write. Reported by
 * `backup_status` and removable with `backup_remove`; never deleted implicitly,
 * because silently destroying user data during a backup is exactly the
 * behaviour a backup exists to prevent.
 */
export function findLegacySecrets(cfg: BackupConfig): { path: string; reason: string; bytes: number }[] {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { excludeReason } = require('./secrets') as typeof import('./secrets');
  const found: { path: string; reason: string; bytes: number }[] = [];
  const mirror = path.join(targetDir(cfg, 'windows-desk'), '.claude');

  const walk = (rel: string): void => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(path.join(mirror, rel), { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      const reason = excludeReason(r, path.join(mirror, r));
      if (reason) {
        let bytes = 0;
        try { bytes = e.isDirectory() ? dirSize(path.join(mirror, r)) : fs.statSync(path.join(mirror, r)).size; }
        catch { /* ignore */ }
        found.push({ path: `windows-desk/.claude/${r}`, reason, bytes });
        continue;
      }
      if (e.isDirectory()) walk(r);
    }
  };
  walk('');
  return found;
}

function dirSize(dir: string): number {
  let total = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    try { total += e.isDirectory() ? dirSize(p) : fs.statSync(p).size; } catch { /* ignore */ }
  }
  return total;
}
