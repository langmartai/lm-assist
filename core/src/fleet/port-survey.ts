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

export function parseWinPorts(stdout: string): PortHold[] {
  const out: PortHold[] = [];
  for (const line of stdout.split('\n')) {
    const m = line.match(/"?(\d+)"?\s*,\s*"?(\d+)"?/);
    if (!m) continue; // skips the header row
    out.push({ port: parseInt(m[1], 10), proto: 'tcp', pid: parseInt(m[2], 10), proc: null });
  }
  return out;
}

export async function collectPorts(run: RunCmd, platform: NodeJS.Platform): Promise<PortHold[]> {
  try {
    if (platform === 'win32') {
      const r = await run('powershell', ['-NoProfile', '-Command',
        'Get-NetTCPConnection -State Listen | Select-Object LocalPort,OwningProcess | ConvertTo-Csv -NoTypeInformation'],
        { timeoutMs: TIMEOUT });
      return r.code === 0 ? parseWinPorts(r.stdout) : [];
    }
    const r = await run('ss', ['-H', '-tlnp'], { timeoutMs: TIMEOUT });
    return r.code === 0 ? parseSs(r.stdout) : [];
  } catch {
    return [];
  }
}
