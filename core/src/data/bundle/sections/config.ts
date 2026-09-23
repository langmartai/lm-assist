/**
 * Section 2 — `config`: allow-listed, sanitized, host-local config files (spec §2).
 *
 * Each source is an explicit provider with its own sanitizer and merge semantics:
 *
 *   scheduled-jobs    custom jobs in full + builtin {id,enabled,intervalMinutes,config} overrides,
 *                     run state stripped. Imported custom jobs ALWAYS land enabled:false (a shell
 *                     job is code execution); builtin overrides apply only under `replace`, only
 *                     for config keys the builtin already has (never runIf/cwd/command/env/ids/
 *                     roots …), and NEVER arm a job (enabled on, dryRun off stay a human's call).
 *                     Written through the scheduler's own upsert API so the live scheduler adopts it.
 *   machine-access    profiles (key PATHS only — the store holds no key material); upsert via the
 *                     store; `key-missing` when an identityFile is absent on this host.
 *   project-settings  every known key but the node-bound deny-list, compared with the EFFECTIVE
 *                     value (a missing key is its default); differing keys apply only under
 *                     `replace`; the data-service/bus/fabric toggles are NEVER flipped and
 *                     bundleRetention is never lowered. Written through project-settings.ts with
 *                     the same live side effects PUT /project-settings runs.
 *   mcp-access        add-missing (union of gated tools) under every policy — never un-gates.
 *   mcp-profile       applies only under `replace` (a node-global budget choice); bumps tools-rev.
 *
 * Compares mask secret-named keys on BOTH sides and a replace carries this node's redacted
 * values over, so restoring an unchanged job/profile never deletes its credentials.
 *
 * Secret-named keys are dropped on collect and their dotted paths reported in `redactedKeys`.
 * Every provider takes injectable paths/APIs so a test never touches the real files; the
 * defaults resolve through each owning module's own path helper (dev/prod respected).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { getDataDir, isDevRepo } from '../../../utils/path-utils';
import type { ScheduledJob } from '../../../scheduler/scheduled-jobs';
import {
  loadMachineAccess, machineAccessPath, upsertMachine, validateProfile, isSshAccess,
  type MachineProfile,
} from '../../../machine-access/store';
import { DEFAULTS as PROJECT_SETTINGS_DEFAULTS } from '../../../project-settings';
import {
  asApplied, bump, canonicalEqual, newSectionPlan, stripSecretKeys, SECRET_KEY_RE,
  type ApplyResult, type ConfigCollectResult, type ConfigProvider, type ImportPolicy, type PlanResult,
  type SectionPlan,
} from './types';

// ─── shared helpers ─────────────────────────────────────────────────────────

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function readJsonFile(file: string): unknown {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { return undefined; }
}

function writeJsonAtomic(file: string, value: unknown, mode?: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-import-${crypto.randomBytes(4).toString('hex')}`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), mode === undefined ? 'utf-8' : { encoding: 'utf-8', mode });
  fs.renameSync(tmp, file);
}

/** A section plan refused because its bundle data is not the shape this build writes. */
function badShape(plan: SectionPlan, what: string): SectionPlan {
  plan.refused = { code: 'BAD_SECTION_DATA', reason: `config section data is not ${what}` };
  return plan;
}

/**
 * Run plan logic, then (when applying) perform the collected writes, counting each success
 * into `applied` and each failure into `errors` — one bad item never aborts the rest.
 */
type Write = { bucket: 'add' | 'update'; id: string; disabled?: boolean; run: () => void | Promise<void> };

async function applyWrites(plan: SectionPlan, writes: Write[]): Promise<ApplyResult> {
  const res = asApplied(plan);
  if (res.refused) return res;
  for (const w of writes) {
    try {
      await w.run();
      res.applied.add += w.bucket === 'add' ? 1 : 0;
      res.applied.update += w.bucket === 'update' ? 1 : 0;
      if (w.disabled) res.applied.importedDisabled += 1;
    } catch (e) {
      res.errors!.push(`${w.id}: ${(e as Error)?.message || e}`);
    }
  }
  return res;
}

/**
 * Carry THIS node's secret-named values into an incoming copy that had them redacted on
 * export: for every secret-named key present locally and absent from `incoming` at the same
 * object path, the local value is kept. Without this, a replace of an unchanged job/profile
 * would silently delete its credentials (the bundle side never has them).
 */
export function reinjectLocalSecrets<T>(local: unknown, incoming: T): T {
  const walk = (l: unknown, i: unknown): unknown => {
    if (Array.isArray(l) && Array.isArray(i)) return i.map((x, idx) => walk(l[idx], x));
    if (isObj(l) && isObj(i)) {
      const out: Record<string, unknown> = { ...i };
      for (const [k, v] of Object.entries(l)) {
        if (SECRET_KEY_RE.test(k)) { if (!(k in i)) out[k] = v; continue; }
        if (k in i) out[k] = walk(v, i[k]);
      }
      return out;
    }
    return i;
  };
  return walk(local, incoming) as T;
}

/** Best-effort value scan of shell-ish strings: inline credentials (`PASSWORD=…`, a bearer
 *  token, an Authorization header, user:pass@ in a URL) are replaced with `<redacted>`.
 *  Key-name stripping cannot see these — `command` is not a secret-named key. */
const INLINE_SECRET_RE = /(authorization:\s*(?:bearer|basic|token)?\s*\S+|bearer\s+[A-Za-z0-9._~+/=-]{16,}|\b[A-Z0-9_]*(?:PASSWORD|PASSWD|TOKEN|SECRET|API_?KEY)=\S+|:\/\/[^/\s:@]+:[^/\s@]+@)/gi;

export function redactInlineSecrets(v: string): { value: string; hit: boolean } {
  let hit = false;
  const value = v.replace(INLINE_SECRET_RE, () => { hit = true; return '<redacted>'; });
  return { value, hit };
}

// ─── scheduled-jobs ─────────────────────────────────────────────────────────

/** The subset of ScheduledJobs this provider needs — injectable for tests. */
export interface ScheduledJobsApi {
  listJobs(): ScheduledJob[];
  upsertJob(patch: Partial<ScheduledJob> & { id: string }): unknown;
  deleteJob(id: string): boolean;
}

/** Run state + view-only fields never exported. */
const JOB_RUN_STATE = ['lastRunAt', 'lastResult', 'lastStatus', 'lastRun', 'runLog', 'runCount', 'nextRunAt', 'isRunning', 'disabledByEnv'];

export interface ExportedJob {
  id: string;
  name?: string;
  description?: string;
  type: string;
  enabled: boolean;
  intervalMinutes: number;
  config: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
}
export interface BuiltinOverride { id: string; enabled: boolean; intervalMinutes: number; config: Record<string, unknown> }
export interface ScheduledJobsData { custom: ExportedJob[]; builtins: BuiltinOverride[] }

/** The comparable content of a custom job — `enabled` is excluded (import always disables). */
const jobContent = (j: Partial<ExportedJob>) => ({
  name: j.name, description: j.description, type: j.type, intervalMinutes: j.intervalMinutes, config: j.config ?? {},
});

/** Builtin config keys an import NEVER sets: a shell guard (`runIf` is cp.exec'd on every
 *  tick), process shaping, and the target lists of the destructive builtins. A builtin
 *  override is otherwise a side door around "imported code lands disabled". */
export const BUILTIN_CONFIG_NEVER_IMPORTED: ReadonlySet<string> = new Set(['runIf', 'cwd', 'timeoutMs', 'command', 'argv', 'args', 'env', 'ids', 'roots']);

/** String fields of a custom job's config scanned for inline credentials on export. */
const JOB_SHELL_FIELDS = ['command', 'runIf', 'args', 'argv'];

export function createScheduledJobsProvider(opts: { jobs?: () => ScheduledJobsApi } = {}): ConfigProvider {
  const api = (): ScheduledJobsApi => opts.jobs?.() ?? require('../../../scheduler/scheduled-jobs').getScheduledJobs();

  async function planOrApply(data: unknown, policy: ImportPolicy, apply: boolean): Promise<PlanResult> {
    const plan = newSectionPlan('config', 'scheduled-jobs', 'Scheduled jobs');
    if (!isObj(data) || !Array.isArray(data.custom) || !Array.isArray(data.builtins)) {
      return apply ? applyWrites(badShape(plan, '{custom[], builtins[]}'), []) : badShape(plan, '{custom[], builtins[]}');
    }
    const local = new Map(api().listJobs().map((j) => [j.id, j]));
    const writes: Write[] = [];

    for (const raw of data.custom as unknown[]) {
      const j = raw as Partial<ExportedJob>;
      if (!isObj(j) || typeof j.id !== 'string' || !j.id || typeof j.type !== 'string' || !j.type) {
        bump(plan, 'skipped');
        plan.warnings.push(`invalid custom job skipped: ${JSON.stringify((j as { id?: unknown })?.id ?? null)}`);
        continue;
      }
      const cur = local.get(j.id);
      const patch = {
        id: j.id,
        name: typeof j.name === 'string' ? j.name : undefined,
        description: typeof j.description === 'string' ? j.description : undefined,
        type: j.type,
        intervalMinutes: typeof j.intervalMinutes === 'number' ? j.intervalMinutes : 1440,
        config: isObj(j.config) ? j.config : {},
        enabled: false, // ALWAYS: an imported job is code execution — a human arms it
      };
      if (cur?.builtin) {
        bump(plan, 'skipped', j.id);
        plan.warnings.push(`custom job "${j.id}" collides with a builtin id — skipped`);
        continue;
      }
      if (!cur) {
        bump(plan, 'add', j.id);
        bump(plan, 'importedDisabled', j.id);
        writes.push({ bucket: 'add', id: j.id, disabled: true, run: () => { api().upsertJob(patch); } });
        continue;
      }
      // Compare with secrets masked on BOTH sides: the bundle copy had them redacted on
      // export, so an unchanged job must still read as identical (and never be disarmed).
      const curMasked = stripSecretKeys(cur as unknown as ExportedJob).value;
      if (canonicalEqual(jobContent(curMasked), jobContent(stripSecretKeys(patch).value))) { bump(plan, 'skipIdentical', j.id); continue; }
      if (policy !== 'replace') { bump(plan, 'skipExists', j.id); continue; }
      bump(plan, 'update', j.id);
      bump(plan, 'importedDisabled', j.id);
      // This node's redacted values are carried over, and the job is updated IN PLACE (run
      // count/log/createdAt kept). Keys absent from the bundle are cleared explicitly:
      // upsertJob MERGES config, and undefined drops out when it persists.
      const config = reinjectLocalSecrets(cur.config ?? {}, patch.config);
      const cleared = Object.fromEntries(Object.keys(cur.config ?? {}).filter((k) => !(k in config)).map((k) => [k, undefined]));
      const full = { ...patch, config: { ...cleared, ...config } };
      writes.push({ bucket: 'update', id: j.id, disabled: true, run: () => { api().upsertJob(full); } });
    }

    let gated = 0;
    for (const raw of data.builtins as unknown[]) {
      const b = raw as Partial<BuiltinOverride>;
      if (!isObj(b) || typeof b.id !== 'string') { bump(plan, 'skipped'); continue; }
      const cur = local.get(b.id);
      if (!cur?.builtin) {
        bump(plan, 'skipped', b.id);
        plan.warnings.push(`builtin override "${b.id}" is not a builtin job on this node — skipped`);
        continue;
      }
      // Only config keys this builtin already has, minus the never-imported ones.
      const curConfig: Record<string, unknown> = isObj(cur.config) ? cur.config : {};
      const cfgPatch: Record<string, unknown> = {};
      const refused: string[] = [];
      for (const [k, v] of Object.entries(isObj(b.config) ? b.config : {})) {
        if (BUILTIN_CONFIG_NEVER_IMPORTED.has(k) || !(k in curConfig) || SECRET_KEY_RE.test(k)) {
          if (!canonicalEqual(curConfig[k], v)) refused.push(k);
          continue;
        }
        cfgPatch[k] = v;
      }
      const incoming = {
        enabled: typeof b.enabled === 'boolean' ? b.enabled : cur.enabled,
        intervalMinutes: typeof b.intervalMinutes === 'number' ? b.intervalMinutes : cur.intervalMinutes,
        config: { ...curConfig, ...cfgPatch },
      };
      // An import never ARMS a builtin: turning a job on, or turning its dryRun off, is a
      // human's call after a dry-run review on THIS node (the destructive builtins — reapers,
      // gc, conversation cleanup — "never self-arm").
      const notArmed: string[] = [];
      if (cur.enabled === false && incoming.enabled === true) { incoming.enabled = false; notArmed.push('enabled'); }
      if (curConfig.dryRun !== false && incoming.config.dryRun === false) { incoming.config.dryRun = curConfig.dryRun; notArmed.push('config.dryRun'); }
      if (policy === 'replace') {
        for (const k of refused) plan.warnings.push(`builtin "${b.id}": config key "${k}" is never imported`);
        if (notArmed.length) plan.warnings.push(`builtin "${b.id}" not armed by import (${notArmed.join(', ')} kept as here) — enable/arm it yourself after a dry-run`);
      }
      if (canonicalEqual({ enabled: cur.enabled, intervalMinutes: cur.intervalMinutes, config: curConfig }, incoming)) {
        bump(plan, (refused.length || notArmed.length) ? 'skipped' : 'skipIdentical', b.id);
        continue;
      }
      if (policy !== 'replace') { bump(plan, 'skipped', b.id); gated++; continue; }
      bump(plan, 'update', b.id);
      const changed: string[] = [];
      if (cur.enabled !== incoming.enabled) changed.push(`enabled ${cur.enabled}→${incoming.enabled}`);
      if (cur.intervalMinutes !== incoming.intervalMinutes) changed.push(`intervalMinutes ${cur.intervalMinutes}→${incoming.intervalMinutes}`);
      for (const [k, v] of Object.entries(cfgPatch)) if (!canonicalEqual(curConfig[k], v)) changed.push(`config.${k}: ${JSON.stringify(curConfig[k])}→${JSON.stringify(v)}`);
      plan.warnings.push(`builtin "${b.id}" override: ${changed.join(', ')}`);
      writes.push({ bucket: 'update', id: b.id, run: () => { api().upsertJob({ id: b.id!, ...incoming }); } });
    }
    if (gated) plan.warnings.push(`${gated} builtin job override(s) not applied — builtin overrides apply only with policy "replace"`);
    if (plan.counts.importedDisabled) {
      plan.warnings.push(`${plan.counts.importedDisabled} imported custom job(s) land DISABLED — review and enable them yourself`);
    }
    return apply ? applyWrites(plan, writes) : plan;
  }

  return {
    id: 'scheduled-jobs',
    title: 'Scheduled jobs',
    async collect(): Promise<ConfigCollectResult> {
      const custom: ExportedJob[] = [];
      const builtins: BuiltinOverride[] = [];
      const redactedKeys: string[] = [];
      for (const j of api().listJobs()) {
        const config = isObj(j.config) ? j.config : {};
        if (j.builtin) {
          const { value, redactedKeys: rk } = stripSecretKeys(config, `builtins.${j.id}.config`);
          redactedKeys.push(...rk);
          builtins.push({ id: j.id, enabled: !!j.enabled, intervalMinutes: j.intervalMinutes, config: value });
          continue;
        }
        const out: Record<string, unknown> = { ...j, config };
        for (const k of JOB_RUN_STATE) delete out[k];
        delete out.builtin;
        const { value, redactedKeys: rk } = stripSecretKeys(out, `custom.${j.id}`);
        redactedKeys.push(...rk);
        // Inline credentials in shell strings (best effort — the key names say nothing).
        const vcfg = isObj((value as Record<string, unknown>).config) ? { ...((value as Record<string, unknown>).config as Record<string, unknown>) } : {};
        for (const f of JOB_SHELL_FIELDS) {
          const x = vcfg[f];
          if (typeof x === 'string') {
            const r = redactInlineSecrets(x);
            if (r.hit) { vcfg[f] = r.value; redactedKeys.push(`custom.${j.id}.config.${f} (value)`); }
          } else if (Array.isArray(x)) {
            let hit = false;
            vcfg[f] = x.map((e) => { if (typeof e !== 'string') return e; const r = redactInlineSecrets(e); hit ||= r.hit; return r.value; });
            if (hit) redactedKeys.push(`custom.${j.id}.config.${f} (value)`);
          }
        }
        (value as Record<string, unknown>).config = vcfg;
        custom.push(value as unknown as ExportedJob);
      }
      return { data: { custom, builtins } satisfies ScheduledJobsData, redactedKeys, warnings: [] };
    },
    plan: (data, policy) => planOrApply(data, policy, false),
    apply: (data, policy) => planOrApply(data, policy, true) as Promise<ApplyResult>,
  };
}

// ─── machine-access ─────────────────────────────────────────────────────────

const expandHome = (p: string): string => (p === '~' || p.startsWith('~/') ? path.join(os.homedir(), p.slice(1)) : p);

/** Comparable content of a profile — timestamps and the probe result are node-local. */
const machineContent = (m: Partial<MachineProfile>) => {
  const { createdAt: _c, updatedAt: _u, lastCheck: _l, ...rest } = m;
  return rest;
};

export function createMachineAccessProvider(opts: { file?: string; keyExists?: (p: string) => boolean } = {}): ConfigProvider {
  const file = () => opts.file ?? machineAccessPath();
  const keyExists = opts.keyExists ?? ((p: string) => fs.existsSync(expandHome(p)));

  async function planOrApply(data: unknown, policy: ImportPolicy, apply: boolean): Promise<PlanResult> {
    const plan = newSectionPlan('config', 'machine-access', 'Machine access profiles');
    if (!isObj(data) || !Array.isArray(data.machines)) {
      return apply ? applyWrites(badShape(plan, '{machines[]}'), []) : badShape(plan, '{machines[]}');
    }
    const local = new Map(loadMachineAccess(file()).machines.map((m) => [m.id, m]));
    const writes: Write[] = [];
    for (const raw of data.machines as unknown[]) {
      const m = raw as MachineProfile;
      const err = validateProfile(m);
      if (err) {
        bump(plan, 'skipped', isObj(m) && typeof m.id === 'string' ? m.id : undefined);
        plan.warnings.push(`invalid profile ${JSON.stringify(isObj(m) ? m.id : null)} skipped: ${err}`);
        continue;
      }
      const cur = local.get(m.id);
      let bucket: 'add' | 'update';
      if (!cur) bucket = 'add';
      // Secret-named fields are masked on both sides (the bundle copy never carries them).
      else if (canonicalEqual(stripSecretKeys(machineContent(cur)).value, stripSecretKeys(machineContent(m)).value)) { bump(plan, 'skipIdentical', m.id); continue; }
      else if (policy !== 'replace') { bump(plan, 'skipExists', m.id); continue; }
      else bucket = 'update';
      bump(plan, bucket, m.id);
      for (const a of m.access) {
        if (isSshAccess(a) && a.identityFile && !keyExists(a.identityFile)) {
          plan.warnings.push(`key-missing: ${m.id} uses ${a.identityFile}, which does not exist on this node`);
        }
      }
      // Carry this node's secret-named fields over, so a replace never deletes them.
      const profile = (cur ? reinjectLocalSecrets(machineContent(cur), machineContent(m)) : machineContent(m)) as MachineProfile;
      writes.push({ bucket, id: m.id, run: () => { snapshotOnce(); upsertMachine(profile, file()); } });
    }
    // The store keeps a ONE-deep .bak per write, so a multi-profile import would leave a .bak
    // that already holds earlier imported writes. Snapshot the pre-import file once instead.
    let snapped = false;
    const snapshotOnce = () => {
      if (snapped) return;
      snapped = true;
      try {
        if (!fs.existsSync(file())) return;
        const bak = `${file()}.bak-import-${new Date().toISOString().replace(/[:.]/g, '-')}`;
        fs.copyFileSync(file(), bak);
        fs.chmodSync(bak, 0o600);
      } catch { /* best effort */ }
    };
    return apply ? applyWrites(plan, writes) : plan;
  }

  return {
    id: 'machine-access',
    title: 'Machine access profiles',
    async collect() {
      const machines = loadMachineAccess(file()).machines.map((m) => {
        const { lastCheck: _l, ...rest } = m; // a probe result from THIS host means nothing elsewhere
        return rest;
      });
      const { value, redactedKeys } = stripSecretKeys({ machines });
      return { data: value, redactedKeys, warnings: [] };
    },
    plan: (data, policy) => planOrApply(data, policy, false),
    apply: (data, policy) => planOrApply(data, policy, true) as Promise<ApplyResult>,
  };
}

// ─── project-settings ───────────────────────────────────────────────────────

/** Keys bound to THIS node — never exported, never imported. */
export const PROJECT_SETTINGS_NODE_BOUND = new Set(['devModeEnabled']);
/** Keys an import never flips — the operator turns these on or off per node, deliberately.
 *  The fabric toggles are here because fabricRpcEnabled opens full peer RPC (no route
 *  allow-list) — the most security-sensitive switch in the file. */
export const PROJECT_SETTINGS_NEVER_FLIP = new Set([
  'dataServiceEnabled', 'busEnabled', 'dataSyncViaFabric',
  'fabricEnabled', 'fabricRpcEnabled', 'missionRelayedSpawnEnabled',
]);
/** Keys an import may raise but never LOWER: fewer restore points is never restored. */
export const PROJECT_SETTINGS_NEVER_LOWER = new Set(['bundleRetention']);

/** Same path project-settings.ts uses (shared by dev and prod). */
export function projectSettingsPath(): string {
  return path.join(getDataDir(), 'project-settings.json');
}

export interface ProjectSettingsProviderOptions {
  /** Test seam: read/write this raw file instead of going through project-settings.ts. */
  file?: string;
  /** Called after a write with the effective settings before and after (test seam; the
   *  default applies the PUT /project-settings live side effects). */
  onApplied?: (prev: Record<string, unknown>, next: Record<string, unknown>) => void;
}

export function createProjectSettingsProvider(opts: ProjectSettingsProviderOptions = {}): ConfigProvider {
  const file = () => opts.file ?? projectSettingsPath();
  const readLocal = (): Record<string, unknown> => {
    const raw = readJsonFile(file());
    return isObj(raw) ? raw : {};
  };
  const defaults = PROJECT_SETTINGS_DEFAULTS as unknown as Record<string, unknown>;
  /** The effective value — the file's, else the default a missing key resolves to. */
  const effective = (local: Record<string, unknown>, k: string) => (k in local ? local[k] : defaults[k]);
  /** Write through the owning module (typed coercion + its cache) and run the same live
   *  side effects PUT /project-settings runs, so daemons follow the new values without a
   *  restart. A test-injected file is written raw. */
  const write = (changes: Record<string, unknown>) => {
    if (opts.file) {
      const prev = { ...defaults, ...readLocal() };
      writeJsonAtomic(file(), { ...readLocal(), ...changes });
      opts.onApplied?.(prev, { ...defaults, ...readLocal() });
      return;
    }
    const ps = require('../../../project-settings') as typeof import('../../../project-settings');
    const prev = ps.getProjectSettings();
    const next = ps.saveProjectSettings(changes as Partial<import('../../../project-settings').ProjectSettings>);
    if (opts.onApplied) opts.onApplied(prev as unknown as Record<string, unknown>, next as unknown as Record<string, unknown>);
    else (require('../../../project-settings-live') as typeof import('../../../project-settings-live')).applyProjectSettingsSideEffects(prev, next);
  };

  async function planOrApply(data: unknown, policy: ImportPolicy, apply: boolean): Promise<PlanResult> {
    const plan = newSectionPlan('config', 'project-settings', 'Project settings');
    if (!isObj(data)) return apply ? applyWrites(badShape(plan, 'an object'), []) : badShape(plan, 'an object');
    const local = readLocal();
    const changes: Record<string, unknown> = {};
    const writes: Write[] = [];
    const differs: string[] = [];
    for (const [k, v] of Object.entries(data)) {
      if (PROJECT_SETTINGS_NODE_BOUND.has(k)) {
        bump(plan, 'skipped', k);
        plan.warnings.push(`node-bound key "${k}" is never imported`);
        continue;
      }
      if (SECRET_KEY_RE.test(k)) { bump(plan, 'skipped', k); plan.warnings.push(`secret-named key "${k}" is never imported`); continue; }
      if (!(k in defaults)) {
        // Not a setting this build knows: saveProjectSettings would drop it anyway.
        bump(plan, 'skipped', k);
        plan.warnings.push(`unknown setting "${k}" is not a project setting on this build — skipped`);
        continue;
      }
      const eff = effective(local, k);
      if (PROJECT_SETTINGS_NEVER_FLIP.has(k)) {
        if (canonicalEqual(eff, v)) { bump(plan, 'skipIdentical', k); continue; }
        bump(plan, 'skipped', k);
        plan.warnings.push(`"${k}" is never flipped by an import (here ${JSON.stringify(eff)}, bundle ${JSON.stringify(v)}) — change it yourself if intended`);
        continue;
      }
      // A key absent from the file is NOT "unset": it resolves to the default. Compare with
      // the effective value, so a fresh node's defaults are not silently overridden.
      if (canonicalEqual(eff, v)) { bump(plan, 'skipIdentical', k); continue; }
      if (PROJECT_SETTINGS_NEVER_LOWER.has(k) && typeof eff === 'number' && typeof v === 'number' && v < eff) {
        bump(plan, 'skipped', k);
        plan.warnings.push(`"${k}" is never lowered by an import (here ${eff}, bundle ${v}) — change it yourself if intended`);
        continue;
      }
      if (policy !== 'replace') { bump(plan, 'skipDiffers', k); differs.push(k); continue; }
      bump(plan, k in local ? 'update' : 'add', k);
      plan.warnings.push(`setting "${k}": ${JSON.stringify(eff)} → ${JSON.stringify(v)}`);
      changes[k] = v;
    }
    if (differs.length) {
      plan.warnings.push(`${differs.length} setting(s) differ and were not applied (use policy "replace"): ${differs.slice(0, 10).join(', ')}${differs.length > 10 ? ', …' : ''}`);
    }
    const keys = Object.keys(changes);
    if (keys.length) {
      // ONE write for the whole section; each key is still counted in `applied`.
      let done = false;
      const writeAll = () => {
        if (done) return;
        write(changes);
        done = true;
      };
      for (const k of keys) writes.push({ bucket: k in local ? 'update' : 'add', id: k, run: writeAll });
    }
    return apply ? applyWrites(plan, writes) : plan;
  }

  return {
    id: 'project-settings',
    title: 'Project settings',
    async collect() {
      const warnings: string[] = [];
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(readLocal())) {
        if (PROJECT_SETTINGS_NODE_BOUND.has(k)) { warnings.push(`node-bound key "${k}" not exported`); continue; }
        out[k] = v;
      }
      const { value, redactedKeys } = stripSecretKeys(out);
      return { data: value, redactedKeys, warnings };
    },
    plan: (data, policy) => planOrApply(data, policy, false),
    apply: (data, policy) => planOrApply(data, policy, true) as Promise<ApplyResult>,
  };
}

// ─── mcp-access ─────────────────────────────────────────────────────────────

/**
 * Mirrors mcp-server/access-control.ts ACCESS_FILE exactly: it hard-codes the home directory
 * (not LM_ASSIST_DATA_DIR) plus the dev suffix. Kept here rather than imported because that
 * module pulls the whole MCP tool catalogue in at load time.
 */
export function mcpAccessPath(): string {
  return path.join(os.homedir(), '.lm-assist', `mcp-access${isDevRepo() ? '-dev' : ''}.json`);
}

export function createMcpAccessProvider(opts: { file?: string } = {}): ConfigProvider {
  const file = () => opts.file ?? mcpAccessPath();
  const readLocal = (): Record<string, unknown> => {
    const raw = readJsonFile(file());
    return isObj(raw) ? raw : {};
  };
  const tools = (o: Record<string, unknown>): string[] =>
    Array.isArray(o.adminGatedTools) ? o.adminGatedTools.filter((t): t is string => typeof t === 'string') : [];

  async function planOrApply(data: unknown, policy: ImportPolicy, apply: boolean): Promise<PlanResult> {
    const plan = newSectionPlan('config', 'mcp-access', 'MCP admin gates');
    if (!isObj(data)) return apply ? applyWrites(badShape(plan, 'an object'), []) : badShape(plan, 'an object');
    const local = readLocal();
    const have = new Set(tools(local));
    const incoming = tools(data);
    const want = new Set(incoming);
    // add-missing BY KEY under every policy: each gated tool is a key, and a gate only ever
    // adds a confirmation step. An import never REMOVES a gate — not even under replace,
    // which is often chosen for the datasets and would otherwise quietly un-gate admin tools.
    for (const t of incoming) bump(plan, have.has(t) ? 'skipIdentical' : 'add', t);
    const kept = [...have].filter((t) => !want.has(t));
    for (const t of kept) bump(plan, 'skipExists', t);
    if (policy === 'replace' && kept.length) {
      plan.warnings.push(`${kept.length} admin gate(s) not in the bundle are kept — an import never removes a gate (un-gate them yourself): ${kept.slice(0, 10).join(', ')}${kept.length > 10 ? ', …' : ''}`);
    }
    const next = [...have, ...incoming.filter((t) => !have.has(t))];
    const writes: Write[] = [];
    if (plan.counts.add || plan.counts.update) {
      const cfg = { ...local, version: typeof local.version === 'number' ? local.version : (typeof data.version === 'number' ? data.version : 2), adminGatedTools: next };
      writes.push({ bucket: plan.counts.add ? 'add' : 'update', id: 'adminGatedTools', run: () => writeJsonAtomic(file(), cfg) });
    }
    return apply ? applyWrites(plan, writes) : plan;
  }

  return {
    id: 'mcp-access',
    title: 'MCP admin gates',
    async collect() {
      const { value, redactedKeys } = stripSecretKeys(readLocal());
      return { data: value, redactedKeys, warnings: [] };
    },
    plan: (data, policy) => planOrApply(data, policy, false),
    apply: (data, policy) => planOrApply(data, policy, true) as Promise<ApplyResult>,
  };
}

// ─── mcp-profile ────────────────────────────────────────────────────────────

/** The subset of registry/profiles.ts this provider needs — injectable for tests. */
export interface McpProfileApi {
  readProfileState(): { profile: string };
  setActiveProfile(name: string, setBy?: string): unknown;
  getProfile(name: string): unknown;
  /** Move the tools-list stamp so connected MCP clients re-fetch (default: tools-rev). */
  bumpToolsRev?(): void;
}

export function createMcpProfileProvider(opts: { profiles?: () => McpProfileApi } = {}): ConfigProvider {
  const api = (): McpProfileApi => opts.profiles?.() ?? require('../../../mcp-server/registry/profiles');

  async function planOrApply(data: unknown, policy: ImportPolicy, apply: boolean): Promise<PlanResult> {
    const plan = newSectionPlan('config', 'mcp-profile', 'MCP tool profile');
    if (!isObj(data) || typeof data.profile !== 'string') {
      return apply ? applyWrites(badShape(plan, '{profile}'), []) : badShape(plan, '{profile}');
    }
    const name = data.profile;
    const cur = api().readProfileState().profile;
    const writes: Write[] = [];
    if (cur === name) bump(plan, 'skipIdentical', name);
    else if (policy !== 'replace') {
      bump(plan, 'skipped', name);
      plan.warnings.push(`the MCP tool profile applies only with policy "replace" (here "${cur}", bundle "${name}")`);
    } else if (!api().getProfile(name)) {
      bump(plan, 'skipped', name);
      plan.warnings.push(`unknown MCP tool profile "${name}" on this build — not applied`);
    } else {
      bump(plan, 'update', name);
      plan.warnings.push(`MCP tool profile "${cur}" → "${name}": Claude Code picks it up within ~30s; a claude.ai connector needs refresh_connector_tools`);
      writes.push({
        bucket: 'update', id: name, run: () => {
          const a = api();
          a.setActiveProfile(name, 'import');
          // Like both other setters: without the bump, connected clients keep the old tool list.
          try {
            if (a.bumpToolsRev) a.bumpToolsRev();
            else (require('../../../mcp-server/registry/tools-rev') as typeof import('../../../mcp-server/registry/tools-rev')).bumpToolsRev();
          } catch { /* best effort */ }
        },
      });
    }
    return apply ? applyWrites(plan, writes) : plan;
  }

  return {
    id: 'mcp-profile',
    title: 'MCP tool profile',
    async collect() {
      return { data: { profile: api().readProfileState().profile }, redactedKeys: [], warnings: [] };
    },
    plan: (data, policy) => planOrApply(data, policy, false),
    apply: (data, policy) => planOrApply(data, policy, true) as Promise<ApplyResult>,
  };
}

// ─── all five ───────────────────────────────────────────────────────────────

export interface ConfigProvidersOptions {
  jobs?: () => ScheduledJobsApi;
  machineAccessFile?: string;
  keyExists?: (p: string) => boolean;
  projectSettingsFile?: string;
  projectSettingsApplied?: ProjectSettingsProviderOptions['onApplied'];
  mcpAccessFile?: string;
  profiles?: () => McpProfileApi;
}

/** The five config providers, in spec order. */
export function createConfigProviders(o: ConfigProvidersOptions = {}): ConfigProvider[] {
  return [
    createScheduledJobsProvider({ jobs: o.jobs }),
    createMachineAccessProvider({ file: o.machineAccessFile, keyExists: o.keyExists }),
    createProjectSettingsProvider({ file: o.projectSettingsFile, onApplied: o.projectSettingsApplied }),
    createMcpAccessProvider({ file: o.mcpAccessFile }),
    createMcpProfileProvider({ profiles: o.profiles }),
  ];
}
