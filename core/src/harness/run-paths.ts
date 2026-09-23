/**
 * Where harness run records and run dirs live.
 *
 * Every path is a FUNCTION over getDataDir()/isDevRepo(), never a module-level
 * constant. detached-runner.ts computes its ~/.lm-assist paths at import time, so
 * LM_ASSIST_DATA_DIR cannot redirect it and dev/prod share one file — the two
 * properties this module exists to keep.
 *
 * Dev and prod Cores share ~/.lm-assist, so each gets its own index and run root
 * (`-dev` suffix, as getCacheDir does). The legacy `<data>/harness-runs` root was
 * written by the qwen harness before it knew about modes; in prod it IS the run
 * root, in dev it is read only by the one-shot backfill.
 */

import * as fs from 'fs';
import * as path from 'path';
import { getCacheDir, getDataDir, isDevRepo } from '../utils/path-utils';

/** Root of this Core's per-run dirs: `<data>/harness-runs-dev` (dev) or `<data>/harness-runs` (prod). */
export function harnessRunsRoot(): string {
  return getCacheDir('harness-runs');
}

/** The pre-recorder qwen root, shared by both modes. Equal to harnessRunsRoot() in prod. */
export function legacyRunsRoot(): string {
  return path.join(getDataDir(), 'harness-runs');
}

/** The event-sourced JSONL index of this Core's runs. */
export function runIndexFile(): string {
  return path.join(getDataDir(), `harness-runs-index${isDevRepo() ? '-dev' : ''}.jsonl`);
}

/** The OTHER mode's index (prod's from a dev Core, and vice versa). Only ever read, never written. */
export function otherModeRunIndexFile(): string {
  return path.join(getDataDir(), `harness-runs-index${isDevRepo() ? '' : '-dev'}.jsonl`);
}

/** Same sanitising rule qwenRunHome always used, so an id maps to the dir it always did. */
export function sanitizeRunId(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]+/g, '_');
}

export function harnessRunDir(id: string): string {
  return path.join(harnessRunsRoot(), sanitizeRunId(id));
}

/**
 * The record's `runDir` locator for a run of this Core — relative to the data
 * dir and always '/'-separated, so a record stays valid if the data dir moves.
 */
export function relativeRunDir(id: string): string {
  return `${path.basename(harnessRunsRoot())}/${sanitizeRunId(id)}`;
}

/**
 * Resolve a record's relative `runDir` to an absolute path, or null.
 *
 * The index is a file on disk and its locators are therefore input, not truth:
 * a hand-edited or corrupted `runDir` of `../../.ssh` must not become a path a
 * reader opens or retention deletes. So the result must be a DIRECT child of one
 * of the two roots, and a real directory rather than a symlink planted there.
 */
export function resolveRecordRunDir(rec: { runDir: string | null | undefined }): string | null {
  const rel = rec.runDir;
  if (typeof rel !== 'string' || !rel || rel.includes('\0') || path.isAbsolute(rel)) return null;
  const abs = path.resolve(getDataDir(), ...rel.split('/'));
  const parent = path.dirname(abs);
  if (parent !== path.resolve(harnessRunsRoot()) && parent !== path.resolve(legacyRunsRoot())) return null;
  try {
    const st = fs.lstatSync(abs);
    if (st.isSymbolicLink() || !st.isDirectory()) return null;
  } catch {
    return null;
  }
  return abs;
}
