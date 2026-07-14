/**
 * Machine access profiles — how to reach OTHER machines FROM this node.
 *
 * Node-local file (~/.lm-assist/machine-access[-dev].json), cluster.json
 * precedent: NOT a synced dataset. Profiles describe reachability that only
 * exists from this host (keys on disk, LAN routes), so they never leave the
 * node except when reported on demand (GET /machine-access, MCP machine_access).
 *
 * v1 implements `type:'ssh'`. Unknown access types round-trip verbatim
 * (forward compat for e.g. windows-account / elevated-worker) and are
 * reported with supported:false.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const IS_DEV_REPO = !__dirname.includes('node_modules');
const FILE = `machine-access${IS_DEV_REPO ? '-dev' : ''}.json`;

export interface SshAccess {
  type: 'ssh';
  host: string;
  user: string;
  port?: number;
  /** Path to the private key on THIS node — never key material. */
  identityFile?: string;
  notes?: string;
}

/** Result of an on-node reachability probe; recorded on the profile, not an edit. */
export interface LastCheck {
  status: 'ok' | 'auth-failed' | 'host-key-unverified' | 'unreachable' | 'error';
  detail?: string;
  at: string; // ISO
}

export interface UnknownAccess {
  type: string;
  [key: string]: unknown;
}

export type AccessMethod = SshAccess | UnknownAccess;

export interface MachineProfile {
  id: string;
  name: string;
  description?: string;
  os?: string;
  tags?: string[];
  enabled?: boolean;
  notes?: string;
  access: AccessMethod[];
  createdAt?: string;
  updatedAt?: string;
  lastCheck?: LastCheck;
}

export interface MachineAccessFile {
  version: 1;
  machines: MachineProfile[];
  [key: string]: unknown; // unknown top-level keys are preserved on save
}

export const MACHINE_ACCESS_USAGE =
  'These profiles are NODE-LOCAL: each machine is reachable only FROM this lm-assist node ' +
  '(keys/routes exist only here). Run the reported command ON this node — a local shell, ' +
  'agent_execute, or terminal tools targeted at this node — not from elsewhere. ' +
  'identityFile values are key PATHS on this node; key material is never stored or reported. ' +
  'Manage profiles on the node itself: PUT/DELETE /machine-access/machines/<id> (loopback-only) ' +
  'or edit ~/.lm-assist/machine-access.json.';

export function machineAccessPath(): string {
  if (process.env.LM_MACHINE_ACCESS_FILE) return process.env.LM_MACHINE_ACCESS_FILE;
  return path.join(os.homedir(), '.lm-assist', FILE);
}

const ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
// Injection guards: a leading `-` would be read by ssh as an option; whitespace
// and shell metacharacters would corrupt the derived copy-paste command / probe argv.
const HOST_RE = /^[A-Za-z0-9._:-]+$/; // DNS names, IPv4, bracketless IPv6, no metachars
const USER_RE = /^[A-Za-z0-9._-]+$/;  // portable username set
const TAG_RE = /^[A-Za-z0-9._/-]+$/;

export function isSshAccess(a: AccessMethod): a is SshAccess {
  return a.type === 'ssh';
}

/** Validate one ssh access entry. Exported so the report can flag (not run) a bad entry. */
export function validateSshAccess(a: Record<string, unknown>, i = 0): string | null {
  if (typeof a.host !== 'string' || !a.host.trim()) return `access[${i}]: ssh host is required`;
  if (a.host.startsWith('-') || !HOST_RE.test(a.host)) {
    return `access[${i}]: host must match ${HOST_RE} and not start with '-'`;
  }
  if (typeof a.user !== 'string' || !a.user.trim()) return `access[${i}]: ssh user is required`;
  if (a.user.startsWith('-') || !USER_RE.test(a.user)) {
    return `access[${i}]: user must match ${USER_RE} and not start with '-'`;
  }
  if (a.port !== undefined && (!Number.isInteger(a.port) || (a.port as number) < 1 || (a.port as number) > 65535)) {
    return `access[${i}]: port must be an integer 1-65535`;
  }
  if (a.identityFile !== undefined) {
    if (typeof a.identityFile !== 'string' || !a.identityFile.trim()) {
      return `access[${i}]: identityFile must be a non-empty path`;
    }
    if (a.identityFile.startsWith('-') || /[\r\n]/.test(a.identityFile) || a.identityFile.includes('PRIVATE KEY')) {
      return `access[${i}]: identityFile must be a key PATH (no leading '-', no newlines, never key material)`;
    }
  }
  return null;
}

/** First validation error message, or null when the profile is valid. */
export function validateProfile(p: unknown): string | null {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return 'profile must be an object';
  const m = p as Record<string, unknown>;
  if (typeof m.id !== 'string' || !ID_RE.test(m.id)) {
    return 'id must be a slug: [a-z0-9][a-z0-9._-]*, max 64 chars';
  }
  if (typeof m.name !== 'string' || !m.name.trim()) return 'name is required';
  if (m.tags !== undefined) {
    if (!Array.isArray(m.tags) || m.tags.some((t) => typeof t !== 'string')) {
      return 'tags must be an array of strings';
    }
    const badTag = (m.tags as string[]).find((t) => !TAG_RE.test(t));
    if (badTag !== undefined) return `tag "${badTag}" must match ${TAG_RE}`;
  }
  if (!Array.isArray(m.access) || m.access.length === 0) {
    return 'access must be a non-empty array of access methods';
  }
  for (let i = 0; i < m.access.length; i++) {
    const a = m.access[i] as Record<string, unknown>;
    if (!a || typeof a !== 'object' || typeof a.type !== 'string' || !a.type.trim()) {
      return `access[${i}]: type is required`;
    }
    if (a.type === 'ssh') {
      const e = validateSshAccess(a, i);
      if (e) return e;
    }
    // Unknown types: accepted verbatim (forward compat); reported supported:false.
  }
  return null;
}

export function loadMachineAccess(file: string = machineAccessPath()): MachineAccessFile {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (!raw || typeof raw !== 'object' || !Array.isArray((raw as { machines?: unknown }).machines)) {
      return { version: 1, machines: [] };
    }
    return { ...(raw as Record<string, unknown>), version: 1, machines: (raw as { machines: MachineProfile[] }).machines };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn(`[machine-access] unreadable ${file}: ${e instanceof Error ? e.message : String(e)}`);
    }
    return { version: 1, machines: [] };
  }
}

function saveMachineAccess(data: MachineAccessFile, file: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // One-deep backup of the previous version before overwrite (best-effort).
  try {
    if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak`);
  } catch { /* backup is best-effort — never block the write */ }
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { encoding: 'utf-8', mode: 0o600 });
  fs.renameSync(tmp, file); // atomic — no torn file if Core dies mid-write
  try { fs.chmodSync(file, 0o600); } catch { /* enforce 0600 even if pre-existing looser */ }
}

export function listMachines(file: string = machineAccessPath()): MachineProfile[] {
  return loadMachineAccess(file).machines;
}

export function getMachine(id: string, file: string = machineAccessPath()): MachineProfile | undefined {
  return listMachines(file).find((m) => m.id === id);
}

/** Validated upsert. Throws Error(message) on invalid input; stamps timestamps. */
export function upsertMachine(profile: MachineProfile, file: string = machineAccessPath()): MachineProfile {
  const error = validateProfile(profile);
  if (error) throw new Error(error);
  const data = loadMachineAccess(file);
  const now = new Date().toISOString();
  const existing = data.machines.find((m) => m.id === profile.id);
  const merged: MachineProfile = {
    ...profile,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  data.machines = [...data.machines.filter((m) => m.id !== profile.id), merged];
  saveMachineAccess(data, file);
  return merged;
}

export function removeMachine(id: string, file: string = machineAccessPath()): boolean {
  const data = loadMachineAccess(file);
  const next = data.machines.filter((m) => m.id !== id);
  if (next.length === data.machines.length) return false;
  data.machines = next;
  saveMachineAccess(data, file);
  return true;
}

/** Record a reachability-probe result on a machine WITHOUT bumping updatedAt
 *  (a probe is not an edit). Returns false if the id is unknown. */
export function setLastCheck(id: string, result: LastCheck, file: string = machineAccessPath()): boolean {
  const data = loadMachineAccess(file);
  const machine = data.machines.find((m) => m.id === id);
  if (!machine) return false;
  machine.lastCheck = result;
  saveMachineAccess(data, file);
  return true;
}

/** Ready-to-run command for an ssh access method (derived, never stored). */
export function buildSshCommand(a: SshAccess): string {
  const parts = ['ssh'];
  if (a.identityFile) parts.push('-i', a.identityFile);
  if (a.port && a.port !== 22) parts.push('-p', String(a.port));
  parts.push(`${a.user}@${a.host}`);
  return parts.join(' ');
}

export interface ReportedAccess {
  type: string;
  supported: boolean;
  command?: string;
  invalid?: string;
  [key: string]: unknown;
}

export interface ReportedMachine extends Omit<MachineProfile, 'access' | 'enabled'> {
  enabled: boolean;
  access: ReportedAccess[];
  /** Present only when the stored profile is malformed (e.g. hand-edited) — the
   *  machine is still reported so one bad entry never breaks the whole list. */
  reportError?: string;
}

/**
 * Reporting shape: derived ssh command + supported flag per access method.
 * NEVER throws — a hand-edited/malformed profile is flagged (`reportError` /
 * per-entry `invalid`) rather than crashing the whole `GET /machine-access`.
 */
export function toReportedMachine(p: MachineProfile): ReportedMachine {
  const { access, enabled, ...rest } = p;
  let reportError: string | undefined;
  const reported: ReportedAccess[] = [];
  if (!Array.isArray(access)) {
    reportError = 'access missing or malformed (expected a non-empty array)';
  } else {
    for (const a of access) {
      if (!a || typeof a !== 'object' || typeof (a as { type?: unknown }).type !== 'string') {
        reportError = 'one or more access entries are malformed and were skipped';
        continue;
      }
      if ((a as AccessMethod).type === 'ssh') {
        const err = validateSshAccess(a as unknown as Record<string, unknown>);
        reported.push(err
          ? { ...(a as object), type: 'ssh', supported: false, invalid: err }
          : { ...(a as object), type: 'ssh', supported: true, command: buildSshCommand(a as SshAccess) });
      } else {
        reported.push({ ...(a as object), type: (a as AccessMethod).type, supported: false });
      }
    }
  }
  return { ...rest, enabled: enabled !== false, access: reported, ...(reportError ? { reportError } : {}) };
}
