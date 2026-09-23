/**
 * Section 2 — `config`: allow-listed, sanitized, host-local config files (spec §2).
 *
 * Each source is an explicit provider with its own sanitizer and merge semantics:
 *
 *   scheduled-jobs    custom jobs in full + builtin {id,enabled,intervalMinutes,config} overrides,
 *                     run state stripped. Imported custom jobs ALWAYS land enabled:false (a shell
 *                     job is code execution); builtin overrides apply only under `replace`.
 *                     Written through the scheduler's own upsert API so the live scheduler adopts it.
 *   machine-access    profiles (key PATHS only — the store holds no key material); upsert via the
 *                     store; `key-missing` when an identityFile is absent on this host.
 *   project-settings  every key but the node-bound deny-list; absent keys are added, differing keys
 *                     are reported and applied only under `replace`; dataServiceEnabled, busEnabled
 *                     and dataSyncViaFabric are NEVER flipped by an import.
 *   mcp-access        add-missing (union of gated tools); `replace` overwrites.
 *   mcp-profile       applies only under `replace` (a node-global budget choice).
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
      if (canonicalEqual(jobContent(cur as ExportedJob), jobContent(patch))) { bump(plan, 'skipIdentical', j.id); continue; }
      if (policy !== 'replace') { bump(plan, 'skipExists', j.id); continue; }
      bump(plan, 'update', j.id);
      bump(plan, 'importedDisabled', j.id);
      // Delete + upsert so config keys absent from the bundle do not survive (upsert MERGES config).
      writes.push({ bucket: 'update', id: j.id, disabled: true, run: () => { const a = api(); a.deleteJob(j.id!); a.upsertJob(patch); } });
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
      const incoming = {
        enabled: typeof b.enabled === 'boolean' ? b.enabled : cur.enabled,
        intervalMinutes: typeof b.intervalMinutes === 'number' ? b.intervalMinutes : cur.intervalMinutes,
        config: isObj(b.config) ? { ...cur.config, ...b.config } : cur.config,
      };
      if (canonicalEqual({ enabled: cur.enabled, intervalMinutes: cur.intervalMinutes, config: cur.config }, incoming)) {
        bump(plan, 'skipIdentical', b.id);
        continue;
      }
      if (policy !== 'replace') { bump(plan, 'skipped', b.id); gated++; continue; }
      bump(plan, 'update', b.id);
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
      else if (canonicalEqual(machineContent(cur), machineContent(m))) { bump(plan, 'skipIdentical', m.id); continue; }
      else if (policy !== 'replace') { bump(plan, 'skipExists', m.id); continue; }
      else bucket = 'update';
      bump(plan, bucket, m.id);
      for (const a of m.access) {
        if (isSshAccess(a) && a.identityFile && !keyExists(a.identityFile)) {
          plan.warnings.push(`key-missing: ${m.id} uses ${a.identityFile}, which does not exist on this node`);
        }
      }
      const profile = machineContent(m) as MachineProfile;
      writes.push({ bucket, id: m.id, run: () => { upsertMachine(profile, file()); } });
    }
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
/** Keys an import never flips — the operator turns these on or off per node, deliberately. */
export const PROJECT_SETTINGS_NEVER_FLIP = new Set(['dataServiceEnabled', 'busEnabled', 'dataSyncViaFabric']);

/** Same path project-settings.ts uses (shared by dev and prod). */
export function projectSettingsPath(): string {
  return path.join(getDataDir(), 'project-settings.json');
}

export function createProjectSettingsProvider(opts: { file?: string } = {}): ConfigProvider {
  const file = () => opts.file ?? projectSettingsPath();
  const readLocal = (): Record<string, unknown> => {
    const raw = readJsonFile(file());
    return isObj(raw) ? raw : {};
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
      if (PROJECT_SETTINGS_NEVER_FLIP.has(k)) {
        const effective = k in local ? local[k] : (PROJECT_SETTINGS_DEFAULTS as unknown as Record<string, unknown>)[k];
        if (canonicalEqual(effective, v)) { bump(plan, 'skipIdentical', k); continue; }
        bump(plan, 'skipped', k);
        plan.warnings.push(`"${k}" is never flipped by an import (here ${JSON.stringify(effective)}, bundle ${JSON.stringify(v)}) — change it yourself if intended`);
        continue;
      }
      if (!(k in local)) { bump(plan, 'add', k); changes[k] = v; continue; }
      if (canonicalEqual(local[k], v)) { bump(plan, 'skipIdentical', k); continue; }
      if (policy !== 'replace') { bump(plan, 'skipDiffers', k); differs.push(k); continue; }
      bump(plan, 'update', k);
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
        writeJsonAtomic(file(), { ...readLocal(), ...changes });
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
    let next: string[];
    if (policy === 'replace') {
      for (const t of incoming) bump(plan, have.has(t) ? 'skipIdentical' : 'add', t);
      for (const t of have) if (!want.has(t)) bump(plan, 'update', `-${t}`); // un-gated by the overwrite
      next = [...want];
    } else {
      // add-missing BY KEY: every gated tool is a key; a gate only ever adds a confirmation step.
      for (const t of incoming) bump(plan, have.has(t) ? 'skipIdentical' : 'add', t);
      for (const t of have) if (!want.has(t)) bump(plan, 'skipExists', t);
      next = [...have, ...incoming.filter((t) => !have.has(t))];
    }
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
      writes.push({ bucket: 'update', id: name, run: () => { api().setActiveProfile(name, 'import'); } });
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
  mcpAccessFile?: string;
  profiles?: () => McpProfileApi;
}

/** The five config providers, in spec order. */
export function createConfigProviders(o: ConfigProvidersOptions = {}): ConfigProvider[] {
  return [
    createScheduledJobsProvider({ jobs: o.jobs }),
    createMachineAccessProvider({ file: o.machineAccessFile, keyExists: o.keyExists }),
    createProjectSettingsProvider({ file: o.projectSettingsFile }),
    createMcpAccessProvider({ file: o.mcpAccessFile }),
    createMcpProfileProvider({ profiles: o.profiles }),
  ];
}
