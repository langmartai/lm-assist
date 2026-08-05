/**
 * VM management — deployment facts only (paths, defaults, limits, timeouts).
 *
 * ── What lives HERE vs in the backends ───────────────────────────────────────
 * This file owns DEPLOYMENT facts: where VM disks land, the config file, the
 * resource limits, the per-operation timeouts, how elevation is chosen. A
 * backend command (a PowerShell cmdlet, a virsh flag) must never appear here,
 * and a file path must never appear in a backend — same rule as
 * gmail/config.ts and desktop/config.ts.
 *
 * Effective config = defaults ← `~/.lm-assist/vm[-dev].json` ← env overrides.
 *
 * 🔴 The STORAGE ROOT is deliberately explicit and configurable. Every VM
 * lm-assist creates lives in `<storageRoot>/<vm-name>/`, and destructive disk
 * deletion REFUSES to touch any file outside the root. Default on Windows is
 * `C:\lm-vms` (the operator's chosen drive for host 107); on Linux
 * `/var/lib/lm-vms`. Override per node via config `storageRoot` or env
 * `LM_VM_STORAGE`, or per create call.
 */

import * as fs from 'fs';
import * as path from 'path';
import { getDataDir } from '../utils/path-utils';

// Mirror the connector dev/prod split (gmail/desktop pattern): a build running
// from the repo (not node_modules) uses the -dev config so dev and prod never
// collide on one host.
const IS_DEV_REPO = process.env.LM_ASSIST_PROD === 'true' ? false : !__dirname.includes('node_modules');
const DEV_SUFFIX = IS_DEV_REPO ? '-dev' : '';

export function vmConfigFile(): string {
  return path.join(getDataDir(), `vm${DEV_SUFFIX}.json`);
}

/** Marker prefixed to a created VM's notes/description. `managed` detection
 *  (and the delete/restore safety gate) key on it. */
export const MANAGED_TAG = '[lm-assist]';

/** Managed-name charset — embeddable in an elevated PowerShell/virsh command
 *  without quoting. This is a security boundary; see types.ts. */
export const VM_NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;

/** Network/switch names may carry spaces ("Default Switch") but never quote
 *  or expansion characters — they are embedded single-quoted in commands. */
export const NETWORK_NAME_RE = /^[A-Za-z0-9 ._()-]{1,64}$/;

export interface VmLimits {
  maxCpus: number;
  maxMemoryMB: number;
  maxDiskGB: number;
  /** Refuse creates once this many VMs exist on the host. */
  maxVms: number;
}

export const DEFAULT_LIMITS: VmLimits = {
  maxCpus: 16,
  maxMemoryMB: 65536,
  maxDiskGB: 1024,
  maxVms: 50,
};

export interface VmConfig {
  /** Absolute directory VM folders + disks live under. */
  storageRoot?: string;
  /** Default network/switch for new VMs (hyperv switch / libvirt network).
   *  null = create VMs with NO network unless the caller names one. */
  defaultNetwork?: string | null;
  /** How privileged hypervisor calls run: auto (direct, fall back to the
   *  elevated worker / sudo on access-denied), always, never. */
  elevation?: 'auto' | 'always' | 'never';
  /** libvirt connection URI (Linux). */
  libvirtUri?: string;
  limits?: Partial<VmLimits>;
}

/** Fields a caller may set via PUT /vm/config. */
export const CONFIG_FIELDS: ReadonlyArray<keyof VmConfig> = [
  'storageRoot',
  'defaultNetwork',
  'elevation',
  'libvirtUri',
  'limits',
];

export function readVmConfig(): VmConfig {
  try {
    return JSON.parse(fs.readFileSync(vmConfigFile(), 'utf-8')) as VmConfig;
  } catch {
    return {};
  }
}

/** Merge `patch` into the saved config and persist (0600). Returns the merged config. */
export function writeVmConfig(patch: Partial<VmConfig>): VmConfig {
  const next = { ...readVmConfig(), ...patch };
  fs.mkdirSync(path.dirname(vmConfigFile()), { recursive: true });
  fs.writeFileSync(vmConfigFile(), JSON.stringify(next, null, 2), { mode: 0o600 });
  return next;
}

export function defaultStorageRoot(): string {
  return process.platform === 'win32' ? 'C:\\lm-vms' : '/var/lib/lm-vms';
}

/** The effective storage root (env > config > platform default). Read on every
 *  call — like gmail's sendAsTtlMs — so it can change without a restart. */
export function storageRoot(cfg: VmConfig = readVmConfig()): string {
  const v = process.env.LM_VM_STORAGE || cfg.storageRoot || defaultStorageRoot();
  return path.resolve(String(v));
}

export function elevationMode(cfg: VmConfig = readVmConfig()): 'auto' | 'always' | 'never' {
  const raw = process.env.LM_VM_ELEVATION || cfg.elevation || 'auto';
  return raw === 'always' || raw === 'never' ? raw : 'auto';
}

export function libvirtUri(cfg: VmConfig = readVmConfig()): string {
  return process.env.LM_VM_LIBVIRT_URI || cfg.libvirtUri || 'qemu:///system';
}

export function effectiveLimits(cfg: VmConfig = readVmConfig()): VmLimits {
  return { ...DEFAULT_LIMITS, ...(cfg.limits || {}) };
}

/** Default network when the caller names none. undefined = platform default
 *  behavior (hyperv: NIC left disconnected; kvm: no interface). */
export function defaultNetwork(cfg: VmConfig = readVmConfig()): string | null {
  if (cfg.defaultNetwork === undefined) return null;
  return cfg.defaultNetwork;
}

// ─── create defaults ─────────────────────────────────────────────────────────

export const DEFAULT_CPUS = 1;
export const DEFAULT_MEMORY_MB = 1024;
export const DEFAULT_DISK_GB = 10;
export const DEFAULT_GENERATION = 2 as const;

/** Notes ceiling — notes are embedded (sanitized) in privileged commands. */
export const MAX_NOTES_CHARS = 500;

// ─── per-operation backend timeouts (ms) — every spawn is kill-on-expiry ─────
//
// All are held under the 120s loopback passthrough ceiling (workerPostRaw) so
// an MCP tool call never outlives its transport. Note the hub relay cuts
// connector calls at ~25-30s — long graceful stops should poll vm_status.

export const STATUS_TIMEOUT_MS = 20_000;
export const LIST_TIMEOUT_MS = 30_000;
export const GET_TIMEOUT_MS = 30_000;
export const CREATE_TIMEOUT_MS = 100_000;
export const START_TIMEOUT_MS = 90_000;
export const STOP_BASE_TIMEOUT_MS = 30_000; // + timeoutSec*1000, capped below
export const STOP_MAX_TIMEOUT_MS = 110_000;
export const DELETE_TIMEOUT_MS = 100_000;
export const SNAPSHOT_TIMEOUT_MS = 100_000;

/** Default graceful-stop wait before the caller should escalate to force. */
export const STOP_DEFAULT_TIMEOUT_SEC = 30;

/** Bounded wait for the write mutex before BUSY (desktop/service.ts pattern). */
export const MUTEX_WAIT_MS = 30_000;

/** Max VMs returned by list before an explicit truncation flag. */
export const MAX_VMS_LISTED = 100;
