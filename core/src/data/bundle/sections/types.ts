/**
 * Section provider contracts shared by the export/import service, plus the plan/apply
 * result shape every section reports in (datasets, config, files).
 *
 * A PLAN is a dry run: per-bucket counts, up to SAMPLE_CAP sample ids per bucket, warnings,
 * and an optional whole-section refusal. An APPLY returns the same shape plus `applied`,
 * the counts that were actually written — so a UI renders both with one table.
 */

import type { BundleFile, FilesSectionId } from '../format';

import { IMPORT_POLICIES, type ImportPolicy } from '../../types';
import { SECRET_KEY_RE } from '../../redaction';
export { IMPORT_POLICIES, SECRET_KEY_RE };
export type { ImportPolicy };

export function isImportPolicy(x: unknown): x is ImportPolicy {
  return typeof x === 'string' && (IMPORT_POLICIES as readonly string[]).includes(x);
}

/**
 * Outcome buckets. The first seven are the spec's plan output; the rest are the config/files
 * sections' own outcomes:
 *   skipDiffers      — present locally with a different value; applied only under `replace`
 *   skipped          — not importable here (unknown project, unsafe path, binary, policy-gated…);
 *                      the reason is in `warnings`
 *   importedDisabled — scheduled jobs written with enabled:false (a subset of add/update)
 */
export interface PlanCounts {
  add: number;
  update: number;
  skipOlder: number;
  skipIdentical: number;
  skipExists: number;
  tooLarge: number;
  neutralized: number;
  skipDiffers: number;
  skipped: number;
  importedDisabled: number;
}
export type PlanBucket = keyof PlanCounts;

export const PLAN_BUCKETS: readonly PlanBucket[] = [
  'add', 'update', 'skipOlder', 'skipIdentical', 'skipExists', 'tooLarge', 'neutralized',
  'skipDiffers', 'skipped', 'importedDisabled',
];

/** Sample ids kept per bucket. */
export const SAMPLE_CAP = 10;

export function emptyCounts(): PlanCounts {
  return {
    add: 0, update: 0, skipOlder: 0, skipIdentical: 0, skipExists: 0, tooLarge: 0, neutralized: 0,
    skipDiffers: 0, skipped: 0, importedDisabled: 0,
  };
}

export interface SectionRefusal {
  code: string;
  reason: string;
}

/** One section's plan (dry run) or apply result. */
export interface SectionPlan {
  kind: 'dataset' | 'config' | 'files';
  id: string;
  title?: string;
  counts: PlanCounts;
  /** Up to SAMPLE_CAP ids per non-empty bucket. */
  samples: Partial<Record<PlanBucket, string[]>>;
  warnings: string[];
  /** Set when the whole section is refused (e.g. REPLICA_READ_ONLY, OWNER_ONLINE). */
  refused?: SectionRefusal;
  /** Apply only: what was actually written (add/update/importedDisabled/neutralized). */
  applied?: PlanCounts;
  /** Apply only: per-item write failures (the rest of the section still applied). */
  errors?: string[];
}

export type PlanResult = SectionPlan;
export type ApplyResult = SectionPlan & { applied: PlanCounts };

export function newSectionPlan(kind: SectionPlan['kind'], id: string, title?: string): SectionPlan {
  const p: SectionPlan = { kind, id, counts: emptyCounts(), samples: {}, warnings: [] };
  if (title !== undefined) p.title = title;
  return p;
}

/** Count one item into a bucket, keeping at most SAMPLE_CAP sample ids. */
export function bump(plan: SectionPlan, bucket: PlanBucket, sampleId?: string): void {
  plan.counts[bucket] += 1;
  if (sampleId === undefined) return;
  const list = (plan.samples[bucket] ??= []);
  if (list.length < SAMPLE_CAP) list.push(sampleId);
}

/** Mark an apply result: `applied` starts at zero and is bumped per successful write. */
export function asApplied(plan: SectionPlan): ApplyResult {
  return Object.assign(plan, { applied: plan.applied ?? emptyCounts(), errors: plan.errors ?? [] });
}

// ─── canonical compare ──────────────────────────────────────────────────────

export { canonicalJson, canonicalEqual } from '../../canonical';

// ─── secret-named keys ──────────────────────────────────────────────────────

// SECRET_KEY_RE (re-exported above) is the data service's own redaction list: a key the data
// service treats as secret is dropped from config sections too (spec §2), and one widening
// there widens both.

/** A key that NAMES a secret's location (`tokenFile`, `keyPath`, `secretsDir`) holds a path, not
 *  the secret — dropping it would lose e.g. a machine-access profile's token-file reference on
 *  restore while protecting nothing. */
export const PATH_VALUED_KEY_RE = /(file|path|dir)$/i;

/**
 * Deep-copy `value` without secret-named keys. Returns the dotted paths of every dropped key
 * (array elements appear as their index), so the loss is visible and never silent.
 */
export function stripSecretKeys<T>(value: T, prefix = ''): { value: T; redactedKeys: string[] } {
  const redactedKeys: string[] = [];
  const walk = (v: unknown, at: string): unknown => {
    if (Array.isArray(v)) return v.map((x, i) => walk(x, at ? `${at}.${i}` : String(i)));
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        const p = at ? `${at}.${k}` : k;
        if (SECRET_KEY_RE.test(k) && !PATH_VALUED_KEY_RE.test(k)) { redactedKeys.push(p); continue; }
        out[k] = walk(x, p);
      }
      return out;
    }
    return v;
  };
  return { value: walk(value, prefix) as T, redactedKeys };
}

// ─── providers ──────────────────────────────────────────────────────────────

export type ConfigSectionId = 'scheduled-jobs' | 'machine-access' | 'project-settings' | 'mcp-access' | 'mcp-profile';

export interface ConfigCollectResult {
  /** Sanitized section data — goes into the bundle's `config` line as `data`. */
  data: unknown;
  /** Dotted paths of secret-named keys dropped by the sanitizer. */
  redactedKeys: string[];
  warnings: string[];
}

/**
 * One allow-listed host-local config source. `plan` never writes; `apply` writes through the
 * owning module's own API/path and returns the plan shape plus `applied`.
 */
export interface ConfigProvider {
  id: ConfigSectionId;
  title: string;
  collect(): Promise<ConfigCollectResult>;
  plan(data: unknown, policy: ImportPolicy): Promise<PlanResult>;
  apply(data: unknown, policy: ImportPolicy): Promise<ApplyResult>;
}

export interface FilesCollectResult {
  files: BundleFile[];
  /** Skipped files (over the size cap, binary, not UTF-8, unreadable) — one line each. */
  warnings: string[];
}

/** One opt-in files section (knowledge, claude-memory, claude-rules). */
export interface FilesProvider {
  id: FilesSectionId;
  title: string;
  /** The absolute directory the section's relative paths resolve under. */
  root(): string;
  collect(): Promise<FilesCollectResult>;
  plan(files: BundleFile[], policy: ImportPolicy): Promise<PlanResult>;
  apply(files: BundleFile[], policy: ImportPolicy): Promise<ApplyResult>;
}
