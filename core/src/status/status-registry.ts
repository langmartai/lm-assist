/**
 * General node status: each subsystem registers a provider; one snapshot
 * aggregates them (spec N4). Consumers: GET /status/full + MCP node_status.
 * Narrow tools (data_sync_status, stall_status, …) keep working; new
 * subsystems join by registering — never by inventing another status surface.
 */
export type StatusVerdict = 'ok' | 'warn' | 'error';

export interface StatusReport {
  verdict: StatusVerdict;
  summary: string;
  detail?: unknown;
}

type Provider = () => StatusReport | Promise<StatusReport>;

const providers = new Map<string, Provider>();
const PROVIDER_TIMEOUT_MS = 2000;

export function registerStatusProvider(name: string, p: Provider): void {
  providers.set(name, p);
}

export async function getStatusSnapshot(section?: string): Promise<Record<string, StatusReport>> {
  const names = section ? [section].filter((n) => providers.has(n)) : [...providers.keys()];
  const out: Record<string, StatusReport> = {};
  await Promise.all(names.map(async (name) => {
    out[name] = await runOne(providers.get(name) as Provider);
  }));
  return out;
}

async function runOne(p: Provider): Promise<StatusReport> {
  let timeoutId: ReturnType<typeof setTimeout>;
  try {
    const timed = new Promise<StatusReport>((_, rej) => {
      timeoutId = setTimeout(() => rej(new Error('provider timeout')), PROVIDER_TIMEOUT_MS);
      timeoutId.unref?.();
    });
    return await Promise.race([Promise.resolve(p()), timed]);
  } catch (e) {
    return { verdict: 'error', summary: (e as Error).message };
  } finally {
    if (timeoutId!) clearTimeout(timeoutId);
  }
}

let coreRegistered = false;

/** Idempotent registration of the W1 core providers: services, hub, fabric. */
export function registerCoreStatusProviders(): void {
  if (coreRegistered) return;
  coreRegistered = true;

  registerStatusProvider('services', () => ({
    verdict: 'ok',
    summary: `core up ${Math.round(process.uptime())}s (pid ${process.pid}, node ${process.version})`,
  }));

  registerStatusProvider('hub', () => {
    // Lazy require: avoid a hub-client import cycle at module load.
    const { getHubClient, isHubConfigured } = require('../hub-client') as typeof import('../hub-client');
    if (!isHubConfigured()) return { verdict: 'warn', summary: 'hub not configured' };
    const s = getHubClient().getStatus() as { connected?: boolean; authenticated?: boolean; hubUrl?: string };
    const okay = !!s.connected && !!s.authenticated;
    return { verdict: okay ? 'ok' : 'warn', summary: okay ? `connected+authenticated to ${s.hubUrl ?? 'hub'}` : 'hub not connected/authenticated', detail: s };
  });

  registerStatusProvider('fabric', () => {
    const { getFabricStatus } = require('../fabric') as typeof import('../fabric');
    const f = getFabricStatus();
    if (!f.enabled) return { verdict: 'ok', summary: 'fabric disabled' };
    const by = (s: string) => f.peers.filter((p) => p.state === s).length;
    const direct = f.peers.filter((p) => p.pathInUse === 'direct').length;
    const relay = f.peers.filter((p) => p.pathInUse === 'relay-floor').length;
    const verdict: StatusVerdict = by('failed') > 0 ? 'warn' : 'ok';
    return {
      verdict,
      summary: `${f.peers.length} peers — ${direct} direct · ${relay} relay · ${by('legacy')} legacy · ${by('failed')} failed`,
      detail: f,
    };
  });

  registerStatusProvider('bus', () => {
    const { getBus } = require('../bus') as typeof import('../bus');
    return getBus().statusReport();
  });

  // Host resources — the machine's own disks + NICs (distinct from `fabric`, the
  // lm-assist mesh). Cross-platform, no subprocess.
  const { storageReport, networkReport } = require('./host-resources') as typeof import('./host-resources');
  registerStatusProvider('storage', () => storageReport());
  registerStatusProvider('network', () => networkReport());
}
