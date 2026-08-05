/**
 * Hyper-V backend (Windows) — implements the VmBackend contract in types.ts.
 *
 * ── Execution model ──────────────────────────────────────────────────────────
 * Every hypervisor operation is ONE self-contained PowerShell script shipped as
 * `-EncodedCommand` (base64 of UTF-16LE). That survives BOTH transports with
 * zero quoting:
 *   - direct:  spawn powershell.exe -NoProfile -NonInteractive -EncodedCommand …
 *   - worker:  the lm-assist ELEVATED WORKER (loopback :3110) — the worker
 *              composes `cmd.exe /c powershell … -EncodedCommand <b64>`, and
 *              base64 is cmd-safe as a single token. (The worker's
 *              shell:"powershell" mode naively joins args into a -Command
 *              string, so we deliberately do NOT use it.)
 *
 * Hyper-V cmdlets need admin (or Hyper-V Administrators membership). Prod Core
 * runs NON-elevated, so `elevation` mode (config.ts) decides the path:
 *   auto   — try direct; on an access-denied signature retry via the worker
 *   always — worker only (the honest prod posture on a non-elevated Core)
 *   never  — direct only (Core already elevated / group membership)
 *
 * ── Injection stance ─────────────────────────────────────────────────────────
 * Everything interpolated into a script is pre-validated upstream (service.ts):
 * names/snapshots match VM_NAME_RE, paths pass the safe-charset check, notes
 * are sanitized (quotes replaced), numbers are coerced ints. Values are still
 * embedded single-quoted; the single quote itself is excluded by every
 * validator, so `'x'` cannot be escaped from. These scripts run ELEVATED —
 * treat any new interpolation point as a security decision.
 */

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { elevatedExec, ElevatedError } from '../elevated/client';
import {
  CREATE_TIMEOUT_MS,
  DELETE_TIMEOUT_MS,
  GET_TIMEOUT_MS,
  LIST_TIMEOUT_MS,
  MANAGED_TAG,
  SNAPSHOT_TIMEOUT_MS,
  START_TIMEOUT_MS,
  STATUS_TIMEOUT_MS,
  STOP_BASE_TIMEOUT_MS,
  STOP_MAX_TIMEOUT_MS,
  defaultNetwork,
  elevationMode,
  storageRoot,
} from './config';
import {
  VmBackend,
  VmBackendStatus,
  VmCreateSpec,
  VmDeleteResult,
  VmError,
  VmInfo,
  VmSnapshot,
  VmState,
} from './types';

// ─── ps exec (direct + elevated worker) ──────────────────────────────────────

interface PsRun {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  via: 'direct' | 'worker';
}

function psEncode(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

const DENIED_RE = /(required permission|access (is )?denied|not authorized|unauthorized|elevat)/i;

function runDirect(script: string, timeoutMs: number): Promise<PsRun> {
  return new Promise((resolve) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', psEncode(script)], {
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let done = false;
    const CAP = 4 * 1024 * 1024;
    child.stdout.on('data', (d: Buffer) => {
      if (stdout.length < CAP) stdout += d.toString('utf8');
    });
    child.stderr.on('data', (d: Buffer) => {
      if (stderr.length < CAP) stderr += d.toString('utf8');
    });
    const timer = setTimeout(() => {
      if (done) return;
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      done = true;
      resolve({ exitCode: null, stdout, stderr: `${stderr}\n[killed after ${timeoutMs}ms]`, via: 'direct' });
    }, timeoutMs);
    timer.unref?.();
    child.on('error', (e) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ exitCode: null, stdout, stderr: `${stderr}\n${e.message}`, via: 'direct' });
    });
    child.on('close', (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ exitCode: code, stdout, stderr, via: 'direct' });
    });
  });
}

async function runWorker(script: string, timeoutMs: number): Promise<PsRun> {
  try {
    const r = await elevatedExec({
      cmd: 'powershell',
      args: ['-NoProfile', '-NonInteractive', '-EncodedCommand', psEncode(script)],
      timeoutMs,
    });
    return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr, via: 'worker' };
  } catch (e) {
    if (e instanceof ElevatedError) {
      throw new VmError('ELEVATION_REQUIRED', `elevated worker path failed (${e.code}): ${e.message}`);
    }
    throw new VmError('ELEVATION_REQUIRED', e instanceof Error ? e.message : String(e));
  }
}

/** Run a script honoring the configured elevation mode, with the auto
 *  direct→worker fallback on an access-denied signature. */
async function runPs(script: string, timeoutMs: number): Promise<PsRun> {
  const mode = elevationMode();
  if (mode === 'always') return runWorker(script, timeoutMs);
  const direct = await runDirect(script, timeoutMs);
  if (mode === 'never') return direct;
  const failedText = `${direct.stderr}\n${direct.stdout}`;
  if (direct.exitCode !== 0 && DENIED_RE.test(failedText)) {
    try {
      return await runWorker(script, timeoutMs);
    } catch {
      return direct; // surface the original denial, not the worker's absence
    }
  }
  return direct;
}

/** Parse the single JSON document a script prints. Throws VM_OP_FAILED with
 *  the script's stderr when it did not exit 0 / print JSON. */
function parseJson<T>(r: PsRun, op: string): T {
  if (r.exitCode !== 0) {
    const msg = (r.stderr || r.stdout || '').trim().split('\n').slice(0, 4).join(' ').slice(0, 500);
    if (r.exitCode === null) throw new VmError('VM_TIMEOUT', `${op} timed out: ${msg}`);
    if (DENIED_RE.test(msg)) {
      throw new VmError(
        'ELEVATION_REQUIRED',
        `${op} was denied by Hyper-V (${msg}). Core lacks Hyper-V rights and no elevated path succeeded — grant the elevated worker (elevated_grant) or add the Core user to Hyper-V Administrators.`,
      );
    }
    throw new VmError('VM_OP_FAILED', `${op} failed (exit ${r.exitCode}): ${msg}`);
  }
  const text = r.stdout;
  const start = text.search(/[[{]/);
  if (start < 0) throw new VmError('VM_OP_FAILED', `${op} produced no JSON output: ${text.trim().slice(0, 300)}`);
  try {
    return JSON.parse(text.slice(start)) as T;
  } catch (e) {
    throw new VmError('VM_OP_FAILED', `${op} produced unparsable output: ${e instanceof Error ? e.message : e}`);
  }
}

/** Standard try/catch wrapper: errors land on stderr + exit 1. */
function wrap(body: string): string {
  return `$ErrorActionPreference='Stop'\ntry {\n${body}\n} catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }`;
}

// ─── shared row → VmInfo mapping ─────────────────────────────────────────────

const STATE_MAP: Record<string, VmState> = {
  running: 'running',
  off: 'off',
  paused: 'paused',
  saved: 'saved',
  starting: 'starting',
  stopping: 'stopping',
};

function mapState(raw: string): { state: VmState; stateRaw?: string } {
  const s = STATE_MAP[String(raw || '').toLowerCase()];
  return s ? { state: s } : { state: 'unknown', stateRaw: String(raw) };
}

function splitNotes(notes: string | null | undefined): { managed: boolean; notes: string | null } {
  const n = String(notes || '').trim();
  if (!n) return { managed: false, notes: null };
  if (n.startsWith(MANAGED_TAG)) {
    const rest = n.slice(MANAGED_TAG.length).trim();
    return { managed: true, notes: rest || null };
  }
  return { managed: false, notes: n };
}

interface PsVmRow {
  name: string;
  id: string;
  state: string;
  cpus: number;
  memoryMB: number;
  uptimeSec: number;
  notes: string;
  generation: number;
  disks?: string[];
  ips?: string[];
  snapshots?: number;
  notFound?: boolean;
}

function rowToInfo(row: PsVmRow): VmInfo {
  const { state, stateRaw } = mapState(row.state);
  const { managed, notes } = splitNotes(row.notes);
  return {
    name: row.name,
    id: row.id || null,
    state,
    ...(stateRaw ? { stateRaw } : {}),
    hypervisor: 'hyperv',
    cpus: Number.isFinite(row.cpus) ? row.cpus : null,
    memoryMB: Number.isFinite(row.memoryMB) ? row.memoryMB : null,
    disks: Array.isArray(row.disks) ? row.disks.map(String) : [],
    ipAddresses: Array.isArray(row.ips) ? row.ips.map(String).filter(Boolean) : [],
    uptimeSec: Number.isFinite(row.uptimeSec) ? row.uptimeSec : null,
    snapshotCount: Number.isFinite(row.snapshots as number) ? (row.snapshots as number) : null,
    generation: Number.isFinite(row.generation) ? row.generation : null,
    managed,
    notes,
  };
}

/** The one Get-VM → row projection, shared by get/create/start/stop. `$v` must
 *  be in scope. Enum-valued props are [string]-cast: PS 5.1 ConvertTo-Json
 *  serializes enums as bare numbers otherwise. */
const ROW_PS = `
$disks = @(Get-VMHardDiskDrive -VMName $v.Name | ForEach-Object { [string]$_.Path })
$ips = @(Get-VMNetworkAdapter -VMName $v.Name | ForEach-Object { $_.IPAddresses } | Where-Object { $_ } | ForEach-Object { [string]$_ })
$snaps = @(Get-VMSnapshot -VMName $v.Name -ErrorAction SilentlyContinue).Count
$row = @{ name=[string]$v.Name; id=[string]$v.Id; state=[string]$v.State; cpus=[int]$v.ProcessorCount;
  memoryMB=[int]($v.MemoryStartup/1MB); uptimeSec=[int]$v.Uptime.TotalSeconds; notes=[string]$v.Notes;
  generation=[int]$v.Generation; disks=$disks; ips=$ips; snapshots=$snaps }
ConvertTo-Json -InputObject $row -Compress -Depth 4`;

// ─── backend ─────────────────────────────────────────────────────────────────

export class HyperVBackend implements VmBackend {
  readonly hypervisor = 'hyperv' as const;

  async status(): Promise<VmBackendStatus> {
    const root = storageRoot();
    const base: VmBackendStatus = {
      hypervisor: 'hyperv',
      platform: process.platform,
      available: false,
      version: null,
      privilege: 'unavailable',
      storageRoot: root,
      storageFreeGB: null,
      defaultNetwork: defaultNetwork(),
      vmCount: null,
    };
    // Doctor: never throw. Probe module + service + an actual Get-VM (the
    // permission truth), reporting which privilege path answered.
    const drive = /^[A-Za-z]:/.test(root) ? root.slice(0, 1) : 'C';
    const script = `$ErrorActionPreference='Stop'
$out = @{ module=$null; vmms=$null; vmCount=$null; switches=@(); freeGB=$null; error=$null }
$m = Get-Module -ListAvailable Hyper-V | Sort-Object Version -Descending | Select-Object -First 1
if ($m) { $out.module = [string]$m.Version }
$svc = Get-Service -Name vmms -ErrorAction SilentlyContinue
if ($svc) { $out.vmms = [string]$svc.Status }
try { $out.freeGB = [math]::Round((Get-PSDrive -Name '${drive}').Free/1GB,1) } catch {}
try {
  $vms = @(Get-VM)
  $out.vmCount = $vms.Count
  $out.switches = @(Get-VMSwitch -ErrorAction SilentlyContinue | ForEach-Object { [string]$_.Name })
} catch { $out.error = [string]$_.Exception.Message }
ConvertTo-Json -InputObject $out -Compress -Depth 4`;

    interface StatusOut {
      module: string | null;
      vmms: string | null;
      vmCount: number | null;
      switches: string[];
      freeGB: number | null;
      error: string | null;
    }
    let r: PsRun;
    try {
      r = await runPs(script, STATUS_TIMEOUT_MS);
    } catch (e) {
      // elevation 'always' with no worker — report, don't throw (doctor).
      return { ...base, reason: e instanceof Error ? e.message : String(e) };
    }
    let out: StatusOut;
    try {
      out = parseJson<StatusOut>(r, 'vm status probe');
    } catch (e) {
      return { ...base, reason: e instanceof Error ? e.message : String(e) };
    }
    base.version = out.module;
    base.storageFreeGB = out.freeGB;
    if (!out.module) return { ...base, reason: 'the Hyper-V PowerShell module is not installed (Enable-WindowsOptionalFeature Microsoft-Hyper-V-All)' };
    if (out.vmms !== 'Running') return { ...base, reason: `Hyper-V management service (vmms) is ${out.vmms || 'absent'}` };
    if (out.error !== null || out.vmCount === null) {
      // Module + service fine but Get-VM failed on the path that answered.
      const denied = DENIED_RE.test(out.error || '');
      return {
        ...base,
        reason: denied
          ? `Hyper-V denied access on the ${r.via} path: ${out.error}. Grant the elevated worker (elevated_grant) or add the Core user to Hyper-V Administrators.`
          : `Get-VM failed: ${out.error}`,
      };
    }
    return {
      ...base,
      available: true,
      privilege: r.via === 'worker' ? 'worker' : 'direct',
      vmCount: out.vmCount,
    };
  }

  async list(): Promise<VmInfo[]> {
    const script = wrap(`
$rows = @(Get-VM | ForEach-Object { @{ name=[string]$_.Name; id=[string]$_.Id; state=[string]$_.State;
  cpus=[int]$_.ProcessorCount; memoryMB=[int]($_.MemoryStartup/1MB); uptimeSec=[int]$_.Uptime.TotalSeconds;
  notes=[string]$_.Notes; generation=[int]$_.Generation } })
ConvertTo-Json -InputObject $rows -Compress -Depth 4`);
    const rows = parseJson<PsVmRow[]>(await runPs(script, LIST_TIMEOUT_MS), 'vm list');
    return (Array.isArray(rows) ? rows : []).map(rowToInfo);
  }

  async get(name: string): Promise<VmInfo> {
    const script = wrap(`
$v = Get-VM -Name '${name}' -ErrorAction SilentlyContinue
if (-not $v) { Write-Output '{"notFound":true}'; exit 0 }
if ($v -is [array]) { $v = $v[0] }
${ROW_PS}`);
    const row = parseJson<PsVmRow>(await runPs(script, GET_TIMEOUT_MS), `vm get ${name}`);
    if (row.notFound) throw new VmError('VM_NOT_FOUND', `no VM named "${name}" on this host`);
    return rowToInfo(row);
  }

  async create(spec: VmCreateSpec): Promise<VmInfo> {
    const dir = path.join(spec.storageRoot, spec.name);
    const vhd = path.join(dir, `${spec.name}.vhdx`);
    const memBytes = spec.memoryMB * 1024 * 1024;
    const diskBytes = spec.diskGB * 1024 * 1024 * 1024;
    const network = spec.network === undefined ? defaultNetwork() : spec.network;
    const notes = `${MANAGED_TAG}${spec.notes ? ` ${spec.notes}` : ''}`;
    const script = wrap(`
if (Get-VM -Name '${spec.name}' -ErrorAction SilentlyContinue) { [Console]::Error.WriteLine('a VM with this name already exists'); exit 3 }
$null = New-Item -ItemType Directory -Force -Path '${dir}'
$null = New-VM -Name '${spec.name}' -MemoryStartupBytes ${memBytes} -Generation ${spec.generation} -NewVHDPath '${vhd}' -NewVHDSizeBytes ${diskBytes}${network ? ` -SwitchName '${network}'` : ''}
$null = Set-VM -Name '${spec.name}' -ProcessorCount ${spec.cpus} -StaticMemory -AutomaticCheckpointsEnabled $false -CheckpointType Standard -Notes '${notes}'
${spec.isoPath ? `$null = Add-VMDvdDrive -VMName '${spec.name}' -Path '${spec.isoPath}'` : ''}
$v = Get-VM -Name '${spec.name}'
${ROW_PS}`);
    const r = await runPs(script, CREATE_TIMEOUT_MS);
    if (r.exitCode === 3) throw new VmError('VM_EXISTS', `a VM named "${spec.name}" already exists on this host`);
    const row = parseJson<PsVmRow>(r, `vm create ${spec.name}`);
    return rowToInfo(row);
  }

  async start(name: string): Promise<VmInfo> {
    const script = wrap(`
$null = Start-VM -Name '${name}'
$v = Get-VM -Name '${name}'
${ROW_PS}`);
    const row = parseJson<PsVmRow>(await runPs(script, START_TIMEOUT_MS), `vm start ${name}`);
    return rowToInfo(row);
  }

  async stop(name: string, opts: { force: boolean; timeoutSec: number }): Promise<VmInfo> {
    // force = hard power-off; graceful = guest shutdown via integration
    // services (guests without them error fast — the caller retries force).
    const stopCmd = opts.force ? `Stop-VM -Name '${name}' -TurnOff -Force` : `Stop-VM -Name '${name}' -Force`;
    const script = wrap(`
$null = ${stopCmd}
$v = Get-VM -Name '${name}'
${ROW_PS}`);
    const timeout = Math.min(STOP_BASE_TIMEOUT_MS + opts.timeoutSec * 1000, STOP_MAX_TIMEOUT_MS);
    const row = parseJson<PsVmRow>(await runPs(script, timeout), `vm stop ${name}`);
    return rowToInfo(row);
  }

  async remove(name: string, opts: { deleteDisks: boolean }): Promise<VmDeleteResult> {
    const root = storageRoot();
    // Phase 1 (privileged): capture disk paths, power off, remove the VM.
    const script = wrap(`
$v = Get-VM -Name '${name}' -ErrorAction SilentlyContinue
if (-not $v) { Write-Output '{"notFound":true}'; exit 0 }
$disks = @(Get-VMHardDiskDrive -VMName '${name}' | ForEach-Object { [string]$_.Path })
if ([string]$v.State -ne 'Off') { $null = Stop-VM -Name '${name}' -TurnOff -Force }
$null = Remove-VM -Name '${name}' -Force
ConvertTo-Json -InputObject @{ removed=$true; disks=$disks } -Compress`);
    const out = parseJson<{ removed?: boolean; disks?: string[]; notFound?: boolean }>(
      await runPs(script, DELETE_TIMEOUT_MS),
      `vm delete ${name}`,
    );
    if (out.notFound) throw new VmError('VM_NOT_FOUND', `no VM named "${name}" on this host`);

    const disks = Array.isArray(out.disks) ? out.disks.map(String) : [];
    const removedDisks: string[] = [];
    const keptDisks: string[] = [];
    if (!opts.deleteDisks) {
      keptDisks.push(...disks);
      return { name, deleted: true, removedDisks, keptDisks };
    }
    // Phase 2: delete ONLY disks contained in the storage root, plus the VM's
    // own folder. Containment is decided HERE (not in the script) and each
    // path must also pass the safe charset before being embedded.
    const deletable = disks.filter((p) => isUnderRoot(root, p) && SAFE_WIN_PATH_RE.test(p));
    keptDisks.push(...disks.filter((p) => !deletable.includes(p)));
    const vmDir = path.join(root, name);
    if (deletable.length > 0 || isUnderRoot(root, vmDir)) {
      const lines = deletable.map((p) => `Remove-Item -LiteralPath '${p}' -Force -ErrorAction SilentlyContinue`);
      lines.push(`if (Test-Path -LiteralPath '${vmDir}') { Remove-Item -LiteralPath '${vmDir}' -Recurse -Force -ErrorAction SilentlyContinue }`);
      lines.push(`ConvertTo-Json -InputObject @{ ok=$true } -Compress`);
      parseJson(await runPs(wrap(lines.join('\n')), DELETE_TIMEOUT_MS), `vm delete ${name} (disks)`);
      removedDisks.push(...deletable);
    }
    return { name, deleted: true, removedDisks, keptDisks };
  }

  async snapshots(name: string): Promise<VmSnapshot[]> {
    const script = wrap(`
$v = Get-VM -Name '${name}' -ErrorAction SilentlyContinue
if (-not $v) { Write-Output '{"notFound":true}'; exit 0 }
$cur = [string]$v.ParentSnapshotName
$rows = @(Get-VMSnapshot -VMName '${name}' -ErrorAction SilentlyContinue | ForEach-Object {
  @{ name=[string]$_.Name; created=$_.CreationTime.ToString('o'); parent=[string]$_.ParentSnapshotName; current=([string]$_.Name -eq $cur) } })
ConvertTo-Json -InputObject @{ snapshots=$rows } -Compress -Depth 4`);
    const out = parseJson<{ notFound?: boolean; snapshots?: Array<{ name: string; created: string; parent: string; current: boolean }> }>(
      await runPs(script, SNAPSHOT_TIMEOUT_MS),
      `vm snapshots ${name}`,
    );
    if (out.notFound) throw new VmError('VM_NOT_FOUND', `no VM named "${name}" on this host`);
    return (out.snapshots || []).map((s) => ({
      name: s.name,
      created: s.created || null,
      parent: s.parent || null,
      current: !!s.current,
    }));
  }

  async snapshotCreate(name: string, snapName: string): Promise<VmSnapshot> {
    const script = wrap(`
$null = Checkpoint-VM -Name '${name}' -SnapshotName '${snapName}'
$s = Get-VMSnapshot -VMName '${name}' -Name '${snapName}'
if ($s -is [array]) { $s = $s[0] }
ConvertTo-Json -InputObject @{ name=[string]$s.Name; created=$s.CreationTime.ToString('o'); parent=[string]$s.ParentSnapshotName } -Compress`);
    const out = parseJson<{ name: string; created: string; parent: string }>(
      await runPs(script, SNAPSHOT_TIMEOUT_MS),
      `vm snapshot create ${name}/${snapName}`,
    );
    return { name: out.name, created: out.created || null, parent: out.parent || null, current: true };
  }

  async snapshotRestore(name: string, snapName: string): Promise<VmInfo> {
    const script = wrap(`
$null = Restore-VMSnapshot -VMName '${name}' -Name '${snapName}' -Confirm:$false
$v = Get-VM -Name '${name}'
${ROW_PS}`);
    const row = parseJson<PsVmRow>(await runPs(script, SNAPSHOT_TIMEOUT_MS), `vm snapshot restore ${name}/${snapName}`);
    return rowToInfo(row);
  }

  async snapshotDelete(name: string, snapName: string): Promise<{ name: string; snapshot: string; deleted: boolean }> {
    const script = wrap(`
$null = Remove-VMSnapshot -VMName '${name}' -Name '${snapName}' -Confirm:$false
ConvertTo-Json -InputObject @{ ok=$true } -Compress`);
    parseJson(await runPs(script, SNAPSHOT_TIMEOUT_MS), `vm snapshot delete ${name}/${snapName}`);
    return { name, snapshot: snapName, deleted: true };
  }
}

// ─── path containment (Windows: case-insensitive) ────────────────────────────

/** Charset a path must pass before being embedded single-quoted in a script.
 *  Excludes quotes, backticks, `$`, and newlines — nothing can escape `'…'`. */
export const SAFE_WIN_PATH_RE = /^[A-Za-z]:[\\/][^'"`$\r\n]*$/;

export function isUnderRoot(root: string, p: string): boolean {
  const rel = path.relative(path.resolve(root).toLowerCase(), path.resolve(p).toLowerCase());
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** Test hook: verify a storage dir is actually writable by this process. */
export function storageWritable(root: string): boolean {
  try {
    fs.mkdirSync(root, { recursive: true });
    const probe = path.join(root, `.lm-probe-${process.pid}`);
    fs.writeFileSync(probe, 'x');
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}
