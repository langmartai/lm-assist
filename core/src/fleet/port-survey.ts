import type { PortHold } from './footprint-types';
import type { RunCmd } from './run-cmd';

const TIMEOUT = 2000;

export function parseSs(stdout: string): PortHold[] {
  const out: PortHold[] = [];
  for (const line of stdout.split('\n')) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 4) continue;
    const local = cols[3]; // State Recv-Q Send-Q Local …
    const portStr = local.slice(local.lastIndexOf(':') + 1);
    const port = parseInt(portStr, 10);
    if (!Number.isFinite(port)) continue;
    const procMatch = line.match(/users:\(\("([^"]+)",pid=(\d+)/);
    out.push({ port, proto: 'tcp', pid: procMatch ? parseInt(procMatch[2], 10) : null, proc: procMatch ? procMatch[1] : null });
  }
  return out;
}

/**
 * Parse `netstat -ano` (Windows) → listening TCP ports + owning PID.
 * We use netstat, not PowerShell `Get-NetTCPConnection`, because it is a plain
 * cmd built-in that stays fast even on boxes whose PowerShell subsystem is
 * degraded (where a 2 s-timeout PS call returns nothing → empty ports). netstat
 * gives the PID but not the process name, so `proc` is null on Windows.
 * Lines look like:  `  TCP    0.0.0.0:3100   0.0.0.0:0   LISTENING   178680`
 * (IPv6 local addresses appear as `[::]:3100`; UDP rows have no LISTENING state).
 */
export function parseNetstat(stdout: string): PortHold[] {
  const out: PortHold[] = [];
  for (const line of stdout.split('\n')) {
    const cols = line.trim().split(/\s+/); // Proto Local Foreign State PID
    if (cols.length < 5) continue;
    if (!/^TCP/i.test(cols[0])) continue;
    if (cols[3] !== 'LISTENING') continue;
    const local = cols[1];
    const port = parseInt(local.slice(local.lastIndexOf(':') + 1), 10);
    if (!Number.isFinite(port)) continue;
    const pid = parseInt(cols[4], 10);
    out.push({ port, proto: 'tcp', pid: Number.isFinite(pid) ? pid : null, proc: null });
  }
  return out;
}

/**
 * Collapse duplicate listeners on the same (proto, port) — `ss`/`netstat` emit a separate
 * row for the IPv4 (`0.0.0.0:p`) and IPv6 (`[::]:p`) socket of the same service, which would
 * otherwise list every port twice (and ~double the footprint payload). Keep one per (proto,
 * port), preferring the row that carries a pid/proc (one family may show the owner while the
 * other doesn't, e.g. `ss` without sudo).
 */
export function dedupePorts(ports: PortHold[]): PortHold[] {
  const byKey = new Map<string, PortHold>();
  for (const p of ports) {
    const k = `${p.proto}:${p.port}`;
    const cur = byKey.get(k);
    if (!cur) { byKey.set(k, p); continue; }
    if (cur.pid == null && p.pid != null) byKey.set(k, p); // upgrade to the entry with owner info
  }
  return Array.from(byKey.values());
}

export async function collectPorts(run: RunCmd, platform: NodeJS.Platform): Promise<PortHold[]> {
  try {
    if (platform === 'win32') {
      const r = await run('netstat', ['-ano'], { timeoutMs: TIMEOUT });
      return r.code === 0 ? dedupePorts(parseNetstat(r.stdout)) : [];
    }
    const r = await run('ss', ['-H', '-tlnp'], { timeoutMs: TIMEOUT });
    return r.code === 0 ? dedupePorts(parseSs(r.stdout)) : [];
  } catch {
    return [];
  }
}
