/**
 * VM management — THE single import surface (desktop/service.ts pattern).
 *
 * Routes and MCP tools import from HERE and nowhere else. This module:
 *   - selects the platform backend (Hyper-V on win32, KVM/libvirt on linux),
 *   - VALIDATES every caller argument BEFORE it can reach a privileged
 *     command (names/snapshots against VM_NAME_RE, paths against the safe
 *     charset + absolute check, numbers against configured limits),
 *   - enforces the MANAGED-VM safety gate: delete / snapshot-restore /
 *     snapshot-delete refuse a VM lm-assist did not create unless force:true,
 *   - serializes VM WRITES behind a bounded single-flight mutex,
 *   - keeps reads (status/list/get/snapshot list) lock-free.
 *
 * A hypervisor command must never appear here; a model-facing string must
 * never appear in a backend.
 */

import * as path from 'path';
import {
  DEFAULT_CPUS,
  DEFAULT_DISK_GB,
  DEFAULT_GENERATION,
  DEFAULT_MEMORY_MB,
  MAX_NOTES_CHARS,
  MAX_VMS_LISTED,
  MUTEX_WAIT_MS,
  NETWORK_NAME_RE,
  STOP_DEFAULT_TIMEOUT_SEC,
  VM_NAME_RE,
  effectiveLimits,
  storageRoot,
} from './config';
import { HyperVBackend } from './hyperv-backend';
import { KvmBackend } from './kvm-backend';
import {
  VmBackend,
  VmBackendStatus,
  VmCreateSpec,
  VmDeleteResult,
  VmError,
  VmInfo,
  VmSnapshot,
} from './types';

// ─── backend selection (cached per process) ──────────────────────────────────

let cached: VmBackend | null = null;
export function vmBackend(): VmBackend {
  if (cached) return cached;
  if (process.platform === 'win32') cached = new HyperVBackend();
  else if (process.platform === 'linux') cached = new KvmBackend();
  else throw new VmError('VM_UNSUPPORTED', `no VM backend for platform "${process.platform}" (win32=Hyper-V, linux=KVM)`);
  return cached;
}

/** Test hook — lets the validation tests run without a real hypervisor. */
export function _setBackendForTests(b: VmBackend | null): void {
  cached = b;
}

// ─── bounded single-flight mutex for VM WRITES (desktop/service.ts pattern) ──

let writeChain: Promise<unknown> = Promise.resolve();
async function withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  const prior = writeChain;
  let release!: () => void;
  writeChain = new Promise<void>((r) => (release = r));
  const waited = await Promise.race([
    prior.then(() => true).catch(() => true),
    new Promise<false>((r) => setTimeout(() => r(false), MUTEX_WAIT_MS)),
  ]);
  if (!waited) {
    release();
    throw new VmError('BUSY', `another VM operation is in progress (waited ${MUTEX_WAIT_MS}ms). Retry shortly.`);
  }
  try {
    return await fn();
  } finally {
    release();
  }
}

// ─── validation (exported for tests) ─────────────────────────────────────────

export function validateVmName(name: unknown, label = 'name'): string {
  const n = String(name ?? '').trim();
  if (!VM_NAME_RE.test(n) || n === '.' || n === '..') {
    throw new VmError(
      'BAD_ARGS',
      `${label} must match ${String(VM_NAME_RE)} (letters, digits, dot, underscore, hyphen; max 64) — got "${String(name ?? '').slice(0, 80)}"`,
    );
  }
  return n;
}

function intInRange(v: unknown, def: number, lo: number, hi: number, label: string): number {
  if (v === undefined || v === null) return def;
  const n = Number(v);
  if (!Number.isInteger(n) || n < lo || n > hi) {
    throw new VmError('BAD_ARGS', `${label} must be an integer in [${lo}, ${hi}] — got ${String(v)}`);
  }
  return n;
}

/** Absolute path with the safe charset for embedding in privileged commands.
 *  (Quotes/backticks/$ excluded on Windows; quotes excluded on POSIX.) */
export function validatePathArg(p: unknown, label: string): string {
  const s = String(p ?? '').trim();
  const winOk = /^[A-Za-z]:[\\/][^'"`$\r\n]*$/.test(s);
  const posixOk = /^\/[^'"\r\n]*$/.test(s);
  if (!(process.platform === 'win32' ? winOk : posixOk)) {
    throw new VmError('UNSAFE_PATH', `${label} must be an absolute path without quote/expansion characters — got "${s.slice(0, 120)}"`);
  }
  // Reject explicit traversal in the INPUT — path.resolve would silently
  // normalize it away, and a caller writing ".." is a caller to refuse.
  if (s.split(/[\\/]/).some((seg) => seg === '..')) {
    throw new VmError('UNSAFE_PATH', `${label} must not contain ".." segments`);
  }
  return path.resolve(s);
}

function sanitizeNotes(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  // Notes are embedded single-quoted in privileged commands: fold newlines,
  // swap straight quotes for typographic ones, cap length.
  const s = String(v)
    .replace(/[\r\n]+/g, ' ')
    .replace(/'/g, '’')
    .replace(/"/g, '”')
    .replace(/[`$]/g, '')
    .trim()
    .slice(0, MAX_NOTES_CHARS);
  return s || undefined;
}

export interface VmCreateArgs {
  name: unknown;
  cpus?: unknown;
  memoryMB?: unknown;
  diskGB?: unknown;
  isoPath?: unknown;
  network?: unknown; // string | null (null = no network)
  generation?: unknown;
  storagePath?: unknown;
  notes?: unknown;
}

export function validateCreateArgs(args: VmCreateArgs): VmCreateSpec {
  const limits = effectiveLimits();
  const name = validateVmName(args.name);
  const cpus = intInRange(args.cpus, DEFAULT_CPUS, 1, limits.maxCpus, 'cpus');
  const memoryMB = intInRange(args.memoryMB, DEFAULT_MEMORY_MB, 32, limits.maxMemoryMB, 'memoryMB');
  const diskGB = intInRange(args.diskGB, DEFAULT_DISK_GB, 1, limits.maxDiskGB, 'diskGB');
  const generation = intInRange(args.generation, DEFAULT_GENERATION, 1, 2, 'generation') as 1 | 2;
  const root = args.storagePath !== undefined ? validatePathArg(args.storagePath, 'storagePath') : storageRoot();
  const isoPath = args.isoPath !== undefined && args.isoPath !== null ? validatePathArg(args.isoPath, 'isoPath') : undefined;
  let network: string | null | undefined;
  if (args.network === null) network = null;
  else if (args.network !== undefined) {
    const n = String(args.network).trim();
    if (!NETWORK_NAME_RE.test(n)) {
      throw new VmError('BAD_ARGS', `network must match ${String(NETWORK_NAME_RE)} — got "${n.slice(0, 80)}"`);
    }
    network = n;
  }
  return { name, cpus, memoryMB, diskGB, generation, storageRoot: root, isoPath, network, notes: sanitizeNotes(args.notes) };
}

// ─── reads ───────────────────────────────────────────────────────────────────

export async function vmStatus(
  name?: unknown,
): Promise<{ status: VmBackendStatus; vm?: VmInfo; vms?: VmInfo[]; total?: number; truncated?: boolean }> {
  const status = await vmBackend().status();
  if (name === undefined || name === null || name === '') {
    // No name → doctor + bounded inventory (the MCP surface's list view).
    if (!status.available) return { status };
    const list = await vmList().catch(() => null);
    return list ? { status, ...list } : { status };
  }
  const vm = await vmBackend().get(validateVmName(name));
  return { status, vm };
}

export async function vmList(): Promise<{ vms: VmInfo[]; total: number; truncated: boolean }> {
  const all = await vmBackend().list();
  const truncated = all.length > MAX_VMS_LISTED;
  return { vms: truncated ? all.slice(0, MAX_VMS_LISTED) : all, total: all.length, truncated };
}

export async function vmSnapshotList(name: unknown): Promise<{ name: string; snapshots: VmSnapshot[] }> {
  const n = validateVmName(name);
  return { name: n, snapshots: await vmBackend().snapshots(n) };
}

// ─── writes (mutex-guarded) ──────────────────────────────────────────────────

export async function vmCreate(args: VmCreateArgs): Promise<VmInfo> {
  const spec = validateCreateArgs(args);
  return withWriteLock(async () => {
    const b = vmBackend();
    const { total } = await vmList().catch(() => ({ total: 0 }));
    const limits = effectiveLimits();
    if (total >= limits.maxVms) {
      throw new VmError('BAD_ARGS', `host already has ${total} VMs (limit ${limits.maxVms}) — raise limits.maxVms in the vm config to create more`);
    }
    return b.create(spec);
  });
}

export async function vmStart(name: unknown): Promise<VmInfo> {
  const n = validateVmName(name);
  return withWriteLock(async () => {
    const b = vmBackend();
    const cur = await b.get(n);
    if (cur.state === 'running') return cur; // idempotent
    return b.start(n);
  });
}

export async function vmStop(
  name: unknown,
  opts: { force?: unknown; timeoutSec?: unknown } = {},
): Promise<VmInfo> {
  const n = validateVmName(name);
  const force = opts.force === true;
  const timeoutSec = intInRange(opts.timeoutSec, STOP_DEFAULT_TIMEOUT_SEC, 1, 600, 'timeoutSec');
  return withWriteLock(async () => {
    const b = vmBackend();
    const cur = await b.get(n);
    if (cur.state === 'off') return cur; // idempotent
    return b.stop(n, { force, timeoutSec });
  });
}

export async function vmDelete(
  name: unknown,
  opts: { deleteDisks?: unknown; force?: unknown } = {},
): Promise<VmDeleteResult> {
  const n = validateVmName(name);
  const deleteDisks = opts.deleteDisks !== false; // default true
  const force = opts.force === true;
  return withWriteLock(async () => {
    const b = vmBackend();
    const cur = await b.get(n); // VM_NOT_FOUND propagates before any damage
    if (!cur.managed && !force) {
      throw new VmError(
        'VM_NOT_MANAGED',
        `VM "${n}" was not created by lm-assist (no ${'managed tag'} in its notes). Pass force:true to delete it anyway.`,
      );
    }
    return b.remove(n, { deleteDisks });
  });
}

export type VmSnapshotAction = 'list' | 'create' | 'restore' | 'delete';

export async function vmSnapshot(
  action: unknown,
  name: unknown,
  snapshot?: unknown,
  opts: { force?: unknown } = {},
): Promise<unknown> {
  const act = String(action ?? '') as VmSnapshotAction;
  if (!['list', 'create', 'restore', 'delete'].includes(act)) {
    throw new VmError('BAD_ARGS', `snapshot action must be one of list|create|restore|delete — got "${String(action)}"`);
  }
  const n = validateVmName(name);
  if (act === 'list') return vmSnapshotList(n);
  const snap =
    act === 'create' && (snapshot === undefined || snapshot === null || snapshot === '')
      ? `lm-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`
      : validateVmName(snapshot, 'snapshot');
  return withWriteLock(async () => {
    const b = vmBackend();
    if (act === 'create') return b.snapshotCreate(n, snap);
    // restore/delete rewrite or destroy VM state — same managed gate as delete.
    const cur = await b.get(n);
    if (!cur.managed && opts.force !== true) {
      throw new VmError('VM_NOT_MANAGED', `VM "${n}" was not created by lm-assist. Pass force:true to ${act} its snapshot anyway.`);
    }
    if (act === 'restore') return b.snapshotRestore(n, snap);
    return b.snapshotDelete(n, snap);
  });
}
