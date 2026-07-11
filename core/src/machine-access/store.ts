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

export function isSshAccess(a: AccessMethod): a is SshAccess {
  return a.type === 'ssh';
}

function validateSsh(a: Record<string, unknown>, i: number): string | null {
  if (typeof a.host !== 'string' || !a.host.trim()) return `access[${i}]: ssh host is required`;
  if (typeof a.user !== 'string' || !a.user.trim()) return `access[${i}]: ssh user is required`;
  if (a.port !== undefined && (!Number.isInteger(a.port) || (a.port as number) < 1 || (a.port as number) > 65535)) {
    return `access[${i}]: port must be an integer 1-65535`;
  }
  if (a.identityFile !== undefined) {
    if (typeof a.identityFile !== 'string' || !a.identityFile.trim()) {
      return `access[${i}]: identityFile must be a non-empty path`;
    }
    if (/[\r\n]/.test(a.identityFile) || a.identityFile.includes('PRIVATE KEY')) {
      return `access[${i}]: identityFile must be a key PATH, never key material`;
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
  if (m.tags !== undefined && (!Array.isArray(m.tags) || m.tags.some((t) => typeof t !== 'string'))) {
    return 'tags must be an array of strings';
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
      const e = validateSsh(a, i);
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
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf-8');
  fs.renameSync(tmp, file); // atomic — no torn file if Core dies mid-write
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

/** Ready-to-run command for an ssh access method (derived, never stored). */
export function buildSshCommand(a: SshAccess): string {
  const parts = ['ssh'];
  if (a.identityFile) parts.push('-i', a.identityFile);
  if (a.port && a.port !== 22) parts.push('-p', String(a.port));
  parts.push(`${a.user}@${a.host}`);
  return parts.join(' ');
}

export interface ReportedMachine extends Omit<MachineProfile, 'access' | 'enabled'> {
  enabled: boolean;
  access: Array<AccessMethod & { supported: boolean; command?: string }>;
}

/** Reporting shape: derived ssh command + supported flag per access method. */
export function toReportedMachine(p: MachineProfile): ReportedMachine {
  return {
    ...p,
    enabled: p.enabled !== false,
    access: p.access.map((a) =>
      isSshAccess(a)
        ? { ...a, supported: true, command: buildSshCommand(a) }
        : { ...a, supported: false },
    ),
  };
}
