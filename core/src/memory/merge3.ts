/**
 * Deterministic 3-way merge of memory-file text, via `git merge-file` (git is already a hard
 * dependency — no new npm dep, so this rides the core/dist-only fleet deploy; battle-tested merge).
 *
 * Returns { clean: true } when base/local/peer reconcile with no overlapping edit (non-overlapping
 * changes are combined automatically). Returns { clean: false } with conflict markers + a count when
 * local and peer edited the same region — the caller hands that to the LLM merge (llm-merge.ts).
 * Nothing is ever lost: on conflict, BOTH versions are preserved inside the markers.
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface MergeResult {
  clean: boolean;
  merged: string;   // clean → the merged text; conflict → text with <<<<<<< / ||||||| / >>>>>>> markers
  conflicts: number;
}

/** 3-way merge base/ours/theirs. Pure w.r.t. its inputs (uses a private tmp dir for git). */
export function merge3(base: string, ours: string, theirs: string): MergeResult {
  if (ours === theirs) return { clean: true, merged: ours, conflicts: 0 };
  if (ours === base) return { clean: true, merged: theirs, conflicts: 0 };  // only theirs changed
  if (theirs === base) return { clean: true, merged: ours, conflicts: 0 };  // only ours changed

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'merge3-'));
  try {
    const o = path.join(dir, 'ours');
    const b = path.join(dir, 'base');
    const t = path.join(dir, 'theirs');
    fs.writeFileSync(o, ours);
    fs.writeFileSync(b, base);
    fs.writeFileSync(t, theirs);
    // git merge-file -p: write result to stdout, don't touch `ours`. Exit 0 = clean, N>0 = conflict
    // count, <0 = error. --diff3 keeps the base section in markers (useful context for the LLM merge).
    try {
      const merged = execFileSync(
        'git',
        ['merge-file', '-p', '--diff3', '-L', 'local', '-L', 'base', '-L', 'peer', o, b, t],
        { encoding: 'utf-8', maxBuffer: 16 * 1024 * 1024 },
      );
      return { clean: true, merged, conflicts: 0 };
    } catch (e: any) {
      const status: number = typeof e?.status === 'number' ? e.status : 1;
      const merged: string = (e?.stdout ?? '').toString();
      if (status < 0 || !merged) {
        // genuine git error — treat as an unresolved conflict, keep ours (caller degrades to LLM/reconcile).
        return { clean: false, merged: ours, conflicts: 1 };
      }
      return { clean: false, merged, conflicts: status };
    }
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}
