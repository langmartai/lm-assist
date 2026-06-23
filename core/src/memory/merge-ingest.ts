/**
 * Convergent merge-on-ingest: fold a peer's version of each project memory file into THIS node's LIVE
 * memory, base-aware, so same-remote peers converge. Per file: adopt (if absent), no-op (if equal),
 * deterministic 3-way merge (merge3) when both changed non-overlappingly, or LLM merge (llm-merge) on
 * an overlapping conflict. The last-converged content is the base (under `<liveDir>/.sync-base/`), the
 * common ancestor for the next 3-way. Convergence is idempotent (re-ingesting the converged content is
 * a no-op). On an unresolved conflict the LOCAL file is left untouched (no data loss) and a
 * memory-reconcile plan item is recorded.
 *
 * Excluded: managed (MEMORY.md/_hosts.md/_cross-project.md), credential-pattern, non-.md, path names.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { merge3 } from './merge3';
import { llmMerge, MergeRunner } from './llm-merge';

const CREDENTIAL_PATTERNS: RegExp[] = [/token/i, /\bkey\b/i, /cookie/i, /password/i, /secret/i, /credential/i];
const MANAGED = new Set(['MEMORY.md', '_hosts.md', '_cross-project.md']);
const BASE_DIR = '.sync-base';

export interface MergeIngestRecord { file: string; content: string; contentHash?: string }
export interface MergeIngestResult {
  adopted: number; merged: number; llmResolved: number; conflictsDeferred: number; unchanged: number; skipped: number;
}

function safeName(file: string): string | null {
  if (file.includes('/') || file.includes('\\') || file !== path.basename(file)) return null;
  if (!file.endsWith('.md') || file.startsWith('.')) return null;
  if (MANAGED.has(file)) return null;
  if (CREDENTIAL_PATTERNS.some((re) => re.test(file))) return null;
  return file;
}

function readOrNull(p: string): string | null {
  try { return fs.readFileSync(p, 'utf-8'); } catch { return null; }
}

function recordReconcile(project: string, host: string, file: string, reason: string): void {
  try {
    const f = path.join(os.homedir(), '.lm-assist', 'memory-reconcile-plan.jsonl');
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.appendFileSync(f, JSON.stringify({ at: new Date().toISOString(), project, host, file, reason, source: 'convergent-sync' }) + '\n');
  } catch { /* best-effort */ }
}

/**
 * Merge `records` (a peer's files) into the live memory dir, converging. `sourceHost`/`project` are
 * for the reconcile-plan record only. `opts.llm` injects the conflict resolver (tests).
 */
export async function mergeIngestRecords(
  liveMemDir: string,
  sourceHost: string,
  project: string,
  records: MergeIngestRecord[],
  opts: { llm?: MergeRunner } = {},
): Promise<MergeIngestResult> {
  const res: MergeIngestResult = { adopted: 0, merged: 0, llmResolved: 0, conflictsDeferred: 0, unchanged: 0, skipped: 0 };
  fs.mkdirSync(liveMemDir, { recursive: true });
  const baseDir = path.join(liveMemDir, BASE_DIR);
  const writeBase = (name: string, content: string) => { fs.mkdirSync(baseDir, { recursive: true }); fs.writeFileSync(path.join(baseDir, name), content); };

  for (const r of records) {
    const name = safeName(r.file);
    if (!name) { res.skipped++; continue; }
    const liveFile = path.join(liveMemDir, name);
    const baseFile = path.join(baseDir, name);
    const local = readOrNull(liveFile);
    const peer = r.content;

    if (local === null) { // not present locally → adopt
      fs.writeFileSync(liveFile, peer); writeBase(name, peer); res.adopted++; continue;
    }
    if (peer === local) { // already converged → keep base current
      if (readOrNull(baseFile) !== peer) writeBase(name, peer);
      res.unchanged++; continue;
    }

    const base = readOrNull(baseFile) ?? '';
    const m = merge3(base, local, peer);
    let merged: string | null;
    if (m.clean) {
      merged = m.merged;
    } else {
      merged = await llmMerge({ filename: name, base, local, peer }, opts.llm);
    }
    if (merged === null) {
      recordReconcile(project, sourceHost, name, 'merge-conflict-unresolved'); // local kept untouched
      res.conflictsDeferred++;
      continue;
    }
    fs.writeFileSync(liveFile, merged); writeBase(name, merged);
    if (m.clean) res.merged++; else res.llmResolved++;
  }
  return res;
}
