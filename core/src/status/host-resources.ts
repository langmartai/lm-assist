/**
 * Host resource status providers — STORAGE (disk volumes) and NETWORK (the host's
 * own NICs/IPs). Registered into the status registry so `node_status` reports them
 * in one call and cross-node for free.
 *
 * Distinct from the `fabric` provider (which is the lm-assist MESH peer-links):
 * `network` here is the machine's real network interfaces, `storage` its disks.
 * Both are cross-platform with NO subprocess — fs.statfs + os.networkInterfaces().
 */

import * as os from 'os';
import * as fs from 'fs';
import type { StatusReport, StatusVerdict } from './status-registry';

// ─── storage ──────────────────────────────────────────────────────────────────

export interface VolumeInfo {
  mount: string;
  totalGb: number;
  usedGb: number;
  freeGb: number;
  usedPct: number;
}

/** Filesystem types that are pseudo/virtual — never real storage to report. */
const PSEUDO_FS = new Set([
  'proc', 'sysfs', 'cgroup', 'cgroup2', 'tmpfs', 'devtmpfs', 'devpts', 'mqueue', 'hugetlbfs',
  'debugfs', 'tracefs', 'securityfs', 'pstore', 'bpf', 'configfs', 'fusectl', 'autofs',
  'binfmt_misc', 'nsfs', 'rpc_pipefs', 'ramfs', 'squashfs', 'overlay', 'fuse.portal',
]);

/** Parse /proc/mounts into the real mount points worth reporting (pure/testable). */
export function parseProcMounts(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of text.split('\n')) {
    const [, mount, fstype] = line.split(/\s+/);
    if (!mount || !fstype) continue;
    if (PSEUDO_FS.has(fstype)) continue;
    if (/^\/(proc|sys|dev|run)(\/|$)/.test(mount)) continue; // pseudo mount trees
    if (/^\/(snap|var\/snap|var\/lib\/docker)(\/|$)/.test(mount)) continue; // snap/docker bind-mount noise (real fstype, not real storage)
    const m = mount.replace(/\\040/g, ' '); // /proc/mounts escapes spaces
    if (seen.has(m)) continue;
    seen.add(m);
    out.push(m);
  }
  return out;
}

/** Enumerate mounts/drives to stat (cross-platform, no subprocess). */
function listMounts(): string[] {
  if (process.platform === 'win32') {
    const out: string[] = [];
    for (let c = 'C'.charCodeAt(0); c <= 'Z'.charCodeAt(0); c++) {
      const d = `${String.fromCharCode(c)}:\\`;
      try { fs.accessSync(d); out.push(d); } catch { /* no such drive */ }
    }
    return out.length ? out : ['C:\\'];
  }
  try {
    const mounts = parseProcMounts(fs.readFileSync('/proc/mounts', 'utf-8'));
    return mounts.length ? mounts : ['/'];
  } catch {
    return ['/'];
  }
}

function statfsVolume(p: string): Promise<VolumeInfo | null> {
  return new Promise((resolve) => {
    fs.statfs(p, (err, s: fs.StatsFs) => {
      if (err || !s || !s.blocks || !s.bsize) return resolve(null);
      const total = Number(s.blocks) * Number(s.bsize);
      const free = Number(s.bfree) * Number(s.bsize);
      if (total <= 0) return resolve(null);
      const gb = (n: number) => Math.round((n / 1073741824) * 10) / 10;
      const used = total - free;
      resolve({ mount: p, totalGb: gb(total), usedGb: gb(used), freeGb: gb(free), usedPct: Math.round((used / total) * 1000) / 10 });
    });
  });
}

/** Build the storage StatusReport from measured volumes (pure/testable). */
export function formatStorage(vols: VolumeInfo[]): StatusReport {
  if (!vols.length) return { verdict: 'warn', summary: 'no volumes found' };
  const busiest = vols.reduce((a, v) => (v.usedPct > a.usedPct ? v : a), vols[0]);
  const verdict: StatusVerdict = busiest.usedPct >= 95 ? 'error' : busiest.usedPct >= 90 ? 'warn' : 'ok';
  const totT = Math.round(vols.reduce((a, v) => a + v.totalGb, 0));
  const totU = Math.round(vols.reduce((a, v) => a + v.usedGb, 0));
  const summary = `${vols.length} volume(s) — ${totU}/${totT} GB used; busiest ${busiest.mount} at ${busiest.usedPct}% (${busiest.freeGb} GB free)`;
  return { verdict, summary, detail: { volumes: vols } };
}

export async function storageReport(): Promise<StatusReport> {
  const vols = (await Promise.all(listMounts().map(statfsVolume))).filter((v): v is VolumeInfo => v !== null);
  return formatStorage(vols);
}

// ─── network (host NICs) ───────────────────────────────────────────────────────

export interface NicInfo {
  name: string;
  address: string;
  family: 'IPv4' | 'IPv6';
  mac: string;
}

/** Flatten os.networkInterfaces() to external (non-loopback) addresses (pure). */
export function collectNics(ifaces: NodeJS.Dict<os.NetworkInterfaceInfo[]>): NicInfo[] {
  const out: NicInfo[] = [];
  for (const [name, addrs] of Object.entries(ifaces)) {
    for (const a of addrs || []) {
      if (a.internal) continue; // skip loopback / internal
      out.push({ name, address: a.address, family: String(a.family).includes('4') ? 'IPv4' : 'IPv6', mac: a.mac });
    }
  }
  return out;
}

/** Build the network StatusReport from hostname + NICs (pure/testable). */
export function formatNetwork(hostname: string, nics: NicInfo[]): StatusReport {
  const v4 = nics.filter((n) => n.family === 'IPv4');
  const summary = `${hostname} — ${v4.length ? v4.map((n) => `${n.name} ${n.address}`).join(', ') : 'no external IPv4'}`;
  return { verdict: v4.length ? 'ok' : 'warn', summary, detail: { hostname, interfaces: nics } };
}

export function networkReport(): StatusReport {
  return formatNetwork(os.hostname(), collectNics(os.networkInterfaces()));
}
