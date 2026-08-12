/**
 * KVM/libvirt backend (Linux) — implements the VmBackend contract in types.ts.
 *
 * ── Execution model ──────────────────────────────────────────────────────────
 * Every operation is a `virsh` / `qemu-img` invocation with an ARGV ARRAY
 * (never a shell), so nothing is ever re-parsed — injection-proof by
 * construction. The libvirt URI is always explicit (`qemu:///system` by
 * default): a bare non-root `virsh` silently talks to qemu:///session, a
 * DIFFERENT hypervisor with a different VM set, which is exactly the class of
 * split-brain this fleet does not need.
 *
 * Privilege: root → run as-is; else direct (libvirt group membership) is
 * probed first; else `sudo -n` (passwordless) prefixes every call, honoring
 * the same elevation modes as the Hyper-V backend (auto | always | never;
 * 'always' forces the sudo prefix, 'never' forbids it).
 *
 * Created domains: qcow2 disk under `<storageRoot>/<name>/`, virtio devices,
 * BIOS firmware (generation is recorded but v1 does not do UEFI/OVMF — the
 * firmware paths vary per distro), managed tag in <description>.
 *
 * E2e-verified 2026-08-12 on node 117 (Ubuntu 22.04, libvirt 8.0.0, nested
 * KVM): full create/start/status/snapshot/stop/delete lifecycle through the
 * MCP tools, privilege 'direct' with the sudo filesystem fallback below.
 */

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
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
  libvirtUri,
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

// ─── exec (argv arrays; optional sudo -n prefix) ─────────────────────────────

interface Run {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

function runArgv(argv: string[], timeoutMs: number): Promise<Run> {
  return new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] });
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
      done = true;
      try {
        child.kill('SIGKILL');
      } catch {
        /* gone */
      }
      resolve({ exitCode: null, stdout, stderr: `${stderr}\n[killed after ${timeoutMs}ms]` });
    }, timeoutMs);
    timer.unref?.();
    child.on('error', (e) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ exitCode: null, stdout, stderr: `${stderr}\n${e.message}` });
    });
    child.on('close', (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ exitCode: code, stdout, stderr });
    });
  });
}

type Prefix = 'root' | 'direct' | 'sudo' | 'unavailable';
let cachedPrefix: Prefix | null = null;

/** Decide how virsh runs on this host (cached per process; status() re-probes). */
async function probePrefix(): Promise<Prefix> {
  const uri = libvirtUri();
  const mode = elevationMode();
  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  if (isRoot) return 'root';
  if (mode !== 'always') {
    const direct = await runArgv(['virsh', '-c', uri, 'version'], 10_000);
    if (direct.exitCode === 0) return 'direct';
    if (mode === 'never') return 'unavailable';
  }
  const sudo = await runArgv(['sudo', '-n', 'virsh', '-c', uri, 'version'], 10_000);
  if (sudo.exitCode === 0) return 'sudo';
  return 'unavailable';
}

async function prefix(): Promise<Prefix> {
  if (cachedPrefix === null) cachedPrefix = await probePrefix();
  return cachedPrefix;
}

/** Build the argv for a virsh call under the active privilege prefix. */
async function virshArgv(args: string[]): Promise<string[]> {
  const p = await prefix();
  if (p === 'unavailable') {
    throw new VmError(
      'ELEVATION_REQUIRED',
      'no working libvirt path: not root, direct virsh failed (libvirt group?), and passwordless sudo is unavailable',
    );
  }
  const base = ['virsh', '-c', libvirtUri(), ...args];
  return p === 'sudo' ? ['sudo', '-n', ...base] : base;
}

async function virsh(args: string[], timeoutMs: number, op: string): Promise<string> {
  const r = await runArgv(await virshArgv(args), timeoutMs);
  if (r.exitCode !== 0) {
    const msg = (r.stderr || r.stdout).trim().split('\n').slice(0, 3).join(' ').slice(0, 400);
    if (r.exitCode === null) throw new VmError('VM_TIMEOUT', `${op} timed out: ${msg}`);
    if (/failed to get domain|no domain with matching name/i.test(msg)) {
      throw new VmError('VM_NOT_FOUND', msg);
    }
    throw new VmError('VM_OP_FAILED', `${op} failed: ${msg}`);
  }
  return r.stdout;
}

const FS_DENIED_RE = /permission denied|operation not permitted/i;

/** Run a non-virsh helper (qemu-img, mkdir, rm) under the same prefix.
 *
 *  A 'direct' privilege only proves VIRSH access (libvirt group) — it says
 *  nothing about filesystem rights on the root-owned storage tree, so a
 *  denied helper falls back to `sudo -n` (unless elevation is 'never').
 *  Found live on the first KVM e2e: direct virsh + mkdir /var/lib/lm-vms
 *  → EACCES. */
async function helper(argv: string[], timeoutMs: number, op: string): Promise<string> {
  const p = await prefix();
  const full = p === 'sudo' ? ['sudo', '-n', ...argv] : argv;
  let r = await runArgv(full, timeoutMs);
  if (
    r.exitCode !== 0 &&
    r.exitCode !== null &&
    (p === 'direct' || p === 'root') &&
    elevationMode() !== 'never' &&
    FS_DENIED_RE.test(`${r.stderr}\n${r.stdout}`)
  ) {
    r = await runArgv(['sudo', '-n', ...argv], timeoutMs);
  }
  if (r.exitCode !== 0) {
    const msg = (r.stderr || r.stdout).trim().slice(0, 400);
    if (r.exitCode === null) throw new VmError('VM_TIMEOUT', `${op} timed out: ${msg}`);
    throw new VmError('VM_OP_FAILED', `${op} failed: ${msg}`);
  }
  return r.stdout;
}

// ─── parsing helpers ─────────────────────────────────────────────────────────

const STATE_MAP: Record<string, VmState> = {
  running: 'running',
  'shut off': 'off',
  paused: 'paused',
  pmsuspended: 'saved',
  'in shutdown': 'stopping',
};

function mapState(raw: string): { state: VmState; stateRaw?: string } {
  const s = STATE_MAP[String(raw || '').trim().toLowerCase()];
  return s ? { state: s } : { state: 'unknown', stateRaw: String(raw).trim() };
}

/** Parse `Key: value` blocks (dominfo). */
function kvParse(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const i = line.indexOf(':');
    if (i > 0) out[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return out;
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function splitDesc(desc: string): { managed: boolean; notes: string | null } {
  const n = String(desc || '').trim();
  if (!n) return { managed: false, notes: null };
  if (n.startsWith(MANAGED_TAG)) {
    const rest = n.slice(MANAGED_TAG.length).trim();
    return { managed: true, notes: rest || null };
  }
  return { managed: false, notes: n };
}

// ─── backend ─────────────────────────────────────────────────────────────────

export class KvmBackend implements VmBackend {
  readonly hypervisor = 'kvm' as const;

  async status(): Promise<VmBackendStatus> {
    cachedPrefix = null; // status re-probes so a fixed sudoers/group shows up
    const root = storageRoot();
    const base: VmBackendStatus = {
      hypervisor: 'kvm',
      platform: process.platform,
      available: false,
      version: null,
      privilege: 'unavailable',
      storageRoot: root,
      storageFreeGB: null,
      defaultNetwork: defaultNetwork(),
      vmCount: null,
    };
    try {
      const df = await runArgv(['df', '-kP', path.dirname(root)], 10_000);
      const line = df.stdout.trim().split('\n').pop() || '';
      const avail = Number(line.split(/\s+/)[3]);
      if (Number.isFinite(avail)) base.storageFreeGB = Math.round((avail / 1024 / 1024) * 10) / 10;
    } catch {
      /* informational */
    }
    const p = await prefix();
    base.privilege = p === 'unavailable' ? 'unavailable' : p;
    if (p === 'unavailable') {
      return {
        ...base,
        reason:
          'virsh is unusable: install libvirt-clients and either add the Core user to the libvirt group or grant passwordless sudo for virsh',
      };
    }
    try {
      const ver = await virsh(['version'], STATUS_TIMEOUT_MS, 'virsh version');
      const m = ver.match(/library:\s*libvirt\s+([\d.]+)/i) || ver.match(/libvirt\s+([\d.]+)/i);
      base.version = m ? m[1] : ver.trim().split('\n')[0] || null;
      const names = await virsh(['list', '--all', '--name'], STATUS_TIMEOUT_MS, 'virsh list');
      base.vmCount = names.split('\n').filter((l) => l.trim()).length;
      return { ...base, available: true };
    } catch (e) {
      return { ...base, reason: e instanceof Error ? e.message : String(e) };
    }
  }

  async list(): Promise<VmInfo[]> {
    const names = (await virsh(['list', '--all', '--name'], LIST_TIMEOUT_MS, 'vm list'))
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    const out: VmInfo[] = [];
    // Light list: state + managed flag per domain. Full detail (disks, IPs,
    // snapshots) comes from get(); a 2-calls-per-VM list stays tractable.
    for (const name of names.slice(0, 200)) {
      let stateRaw = '';
      let desc = '';
      try {
        stateRaw = (await virsh(['domstate', name], GET_TIMEOUT_MS, `domstate ${name}`)).trim();
      } catch {
        stateRaw = '';
      }
      try {
        desc = (await virsh(['desc', name], GET_TIMEOUT_MS, `desc ${name}`)).trim();
        if (/^no description/i.test(desc)) desc = '';
      } catch {
        desc = '';
      }
      const { state, stateRaw: rawKept } = mapState(stateRaw);
      const { managed, notes } = splitDesc(desc);
      out.push({
        name,
        id: null,
        state,
        ...(rawKept ? { stateRaw: rawKept } : {}),
        hypervisor: 'kvm',
        cpus: null,
        memoryMB: null,
        disks: [],
        ipAddresses: [],
        uptimeSec: null,
        snapshotCount: null,
        generation: null,
        managed,
        notes,
      });
    }
    return out;
  }

  async get(name: string): Promise<VmInfo> {
    const info = kvParse(await virsh(['dominfo', name], GET_TIMEOUT_MS, `vm get ${name}`));
    const { state, stateRaw } = mapState(info['state'] || '');
    let desc = '';
    try {
      desc = (await virsh(['desc', name], GET_TIMEOUT_MS, `desc ${name}`)).trim();
      if (/^no description/i.test(desc)) desc = '';
    } catch {
      desc = '';
    }
    const disks: string[] = [];
    try {
      const blk = await virsh(['domblklist', name, '--details'], GET_TIMEOUT_MS, `domblklist ${name}`);
      for (const line of blk.split('\n').slice(2)) {
        const cols = line.trim().split(/\s+/);
        // Type Device Target Source — keep file-backed disks only.
        if (cols.length >= 4 && cols[1] === 'disk' && cols[0] === 'file') disks.push(cols.slice(3).join(' '));
      }
    } catch {
      /* disks stay empty */
    }
    const ips: string[] = [];
    if (state === 'running') {
      try {
        const ifs = await virsh(['domifaddr', name], GET_TIMEOUT_MS, `domifaddr ${name}`);
        for (const line of ifs.split('\n').slice(2)) {
          const m = line.match(/(\d+\.\d+\.\d+\.\d+|[0-9a-f:]+)\/\d+/i);
          if (m) ips.push(m[1]);
        }
      } catch {
        /* ips stay empty */
      }
    }
    let snapshotCount: number | null = null;
    try {
      const snaps = await virsh(['snapshot-list', name, '--name'], GET_TIMEOUT_MS, `snapshot-list ${name}`);
      snapshotCount = snaps.split('\n').filter((l) => l.trim()).length;
    } catch {
      snapshotCount = null;
    }
    const { managed, notes } = splitDesc(desc);
    const memKB = Number((info['max memory'] || '').split(/\s+/)[0]);
    return {
      name,
      id: info['uuid'] || null,
      state,
      ...(stateRaw ? { stateRaw } : {}),
      hypervisor: 'kvm',
      cpus: Number.isFinite(Number(info['cpu(s)'])) ? Number(info['cpu(s)']) : null,
      memoryMB: Number.isFinite(memKB) ? Math.round(memKB / 1024) : null,
      disks,
      ipAddresses: ips,
      uptimeSec: null, // libvirt does not report uptime directly
      snapshotCount,
      generation: null,
      managed,
      notes,
    };
  }

  async create(spec: VmCreateSpec): Promise<VmInfo> {
    // Refuse duplicates first (virsh define would silently redefine).
    let exists = true;
    try {
      await virsh(['dominfo', spec.name], GET_TIMEOUT_MS, 'pre-check');
    } catch (e) {
      if (e instanceof VmError && e.code === 'VM_NOT_FOUND') exists = false;
      else throw e;
    }
    if (exists) throw new VmError('VM_EXISTS', `a domain named "${spec.name}" already exists on this host`);

    const dir = path.join(spec.storageRoot, spec.name);
    const disk = path.join(dir, `${spec.name}.qcow2`);
    await helper(['mkdir', '-p', dir], 15_000, `mkdir ${dir}`);
    await helper(['qemu-img', 'create', '-f', 'qcow2', disk, `${spec.diskGB}G`], CREATE_TIMEOUT_MS, 'qemu-img create');

    const network = spec.network === undefined ? defaultNetwork() : spec.network;
    const desc = `${MANAGED_TAG}${spec.notes ? ` ${spec.notes}` : ''}`;
    const xml = `<domain type='kvm'>
  <name>${xmlEscape(spec.name)}</name>
  <description>${xmlEscape(desc)}</description>
  <memory unit='MiB'>${spec.memoryMB}</memory>
  <vcpu>${spec.cpus}</vcpu>
  <os>
    <type arch='x86_64'>hvm</type>
    <boot dev='hd'/>${spec.isoPath ? `\n    <boot dev='cdrom'/>` : ''}
  </os>
  <features><acpi/><apic/></features>
  <devices>
    <disk type='file' device='disk'>
      <driver name='qemu' type='qcow2'/>
      <source file='${xmlEscape(disk)}'/>
      <target dev='vda' bus='virtio'/>
    </disk>${
      spec.isoPath
        ? `\n    <disk type='file' device='cdrom'>\n      <driver name='qemu' type='raw'/>\n      <source file='${xmlEscape(spec.isoPath)}'/>\n      <target dev='sda' bus='sata'/>\n      <readonly/>\n    </disk>`
        : ''
    }${
      network
        ? `\n    <interface type='network'>\n      <source network='${xmlEscape(network)}'/>\n      <model type='virtio'/>\n    </interface>`
        : ''
    }
    <graphics type='vnc' port='-1' autoport='yes' listen='127.0.0.1'/>
    <console type='pty'/>
  </devices>
</domain>
`;
    const tmp = path.join(os.tmpdir(), `lm-vm-${spec.name}-${process.pid}.xml`);
    fs.writeFileSync(tmp, xml, { mode: 0o600 });
    try {
      await virsh(['define', tmp], CREATE_TIMEOUT_MS, `vm create ${spec.name}`);
    } finally {
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* best effort */
      }
    }
    return this.get(spec.name);
  }

  async start(name: string): Promise<VmInfo> {
    await virsh(['start', name], START_TIMEOUT_MS, `vm start ${name}`);
    return this.get(name);
  }

  async stop(name: string, opts: { force: boolean; timeoutSec: number }): Promise<VmInfo> {
    if (opts.force) {
      await virsh(['destroy', name], STOP_BASE_TIMEOUT_MS, `vm stop ${name}`);
      return this.get(name);
    }
    await virsh(['shutdown', name], STOP_BASE_TIMEOUT_MS, `vm stop ${name}`);
    // Graceful shutdown is a REQUEST — poll for off within the caller's window.
    const deadline = Date.now() + Math.min(opts.timeoutSec * 1000, STOP_MAX_TIMEOUT_MS - STOP_BASE_TIMEOUT_MS);
    for (;;) {
      const stateRaw = (await virsh(['domstate', name], GET_TIMEOUT_MS, `domstate ${name}`)).trim();
      if (mapState(stateRaw).state === 'off') break;
      if (Date.now() > deadline) {
        throw new VmError(
          'VM_TIMEOUT',
          `guest did not shut down within ${opts.timeoutSec}s (no ACPI handler in the guest?) — retry with force:true for a hard power-off`,
        );
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
    return this.get(name);
  }

  async remove(name: string, opts: { deleteDisks: boolean }): Promise<VmDeleteResult> {
    const root = storageRoot();
    const info = await this.get(name); // VM_NOT_FOUND propagates
    if (info.state !== 'off') {
      try {
        await virsh(['destroy', name], STOP_BASE_TIMEOUT_MS, `vm destroy ${name}`);
      } catch {
        /* may have raced to off */
      }
    }
    await virsh(['undefine', name, '--managed-save', '--snapshots-metadata'], DELETE_TIMEOUT_MS, `vm delete ${name}`);
    const removedDisks: string[] = [];
    const keptDisks: string[] = [];
    for (const p of info.disks) {
      if (opts.deleteDisks && isUnderRootPosix(root, p)) {
        try {
          await helper(['rm', '-f', p], 30_000, `rm ${p}`);
          removedDisks.push(p);
        } catch {
          keptDisks.push(p);
        }
      } else {
        keptDisks.push(p);
      }
    }
    if (opts.deleteDisks) {
      const dir = path.join(root, name);
      if (isUnderRootPosix(root, dir)) {
        try {
          await helper(['rmdir', dir], 15_000, `rmdir ${dir}`);
        } catch {
          /* non-empty or absent — leave it */
        }
      }
    }
    return { name, deleted: true, removedDisks, keptDisks };
  }

  async snapshots(name: string): Promise<VmSnapshot[]> {
    await this.get(name); // existence gate → VM_NOT_FOUND
    let current: string | null = null;
    try {
      current = (await virsh(['snapshot-current', name, '--name'], GET_TIMEOUT_MS, 'snapshot-current')).trim() || null;
    } catch {
      current = null;
    }
    let names: string[] = [];
    try {
      names = (await virsh(['snapshot-list', name, '--name'], SNAPSHOT_TIMEOUT_MS, `vm snapshots ${name}`))
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
    } catch {
      names = [];
    }
    return names.map((n) => ({ name: n, created: null, parent: null, current: n === current }));
  }

  async snapshotCreate(name: string, snapName: string): Promise<VmSnapshot> {
    await virsh(['snapshot-create-as', name, snapName], SNAPSHOT_TIMEOUT_MS, `vm snapshot create ${name}/${snapName}`);
    return { name: snapName, created: new Date().toISOString(), parent: null, current: true };
  }

  async snapshotRestore(name: string, snapName: string): Promise<VmInfo> {
    await virsh(['snapshot-revert', name, snapName], SNAPSHOT_TIMEOUT_MS, `vm snapshot restore ${name}/${snapName}`);
    return this.get(name);
  }

  async snapshotDelete(name: string, snapName: string): Promise<{ name: string; snapshot: string; deleted: boolean }> {
    await virsh(['snapshot-delete', name, snapName], SNAPSHOT_TIMEOUT_MS, `vm snapshot delete ${name}/${snapName}`);
    return { name, snapshot: snapName, deleted: true };
  }
}

export function isUnderRootPosix(root: string, p: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(p));
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}
