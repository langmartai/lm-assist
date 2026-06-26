/**
 * Per-node build/upgrade tracking.
 *
 * Records the running lm-assist version on each Core start into
 * ~/.lm-assist/build-history.json (atomic, 0600). Upgrades are detected
 * as version changes between starts. Never throws — all operations are
 * best-effort.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { getDataDir } from '../utils/path-utils';

export interface BuildEvent {
  version: string;
  at: string;
  previousVersion: string | null;
}

export interface BuildHistory {
  node: string;
  current: string;
  upgradedAt: string | null;
  previousVersion: string | null;
  nodeVersion: string;
  platform: string;
  localIp?: string;
  history: BuildEvent[];
}

const MAX_EVENTS = 20;

function historyFile(): string {
  return path.join(getDataDir(), 'build-history.json');
}

/**
 * PURE decision function: given the prior record (or null) plus the now-running
 * version, return the next record and whether it actually changed.
 */
export function applyBuild(
  prev: BuildHistory | null,
  current: string,
  ctx: { node: string; nodeVersion: string; platform: string; localIp?: string; now: string },
): { next: BuildHistory; changed: boolean } {
  const changed = !prev || prev.current !== current;

  if (changed) {
    const previousVersion = prev ? prev.current : null;
    const history = prev ? prev.history.slice(0, MAX_EVENTS - 1) : [];
    const ev: BuildEvent = { version: current, at: ctx.now, previousVersion };
    return {
      next: {
        node: ctx.node,
        current,
        upgradedAt: ctx.now,
        previousVersion,
        nodeVersion: ctx.nodeVersion,
        platform: ctx.platform,
        localIp: ctx.localIp,
        history: [ev, ...history],
      },
      changed: true,
    };
  }

  // Unchanged: keep current/upgradedAt/history, refresh node/platform/ip metadata.
  return {
    next: {
      ...prev!,
      node: ctx.node,
      nodeVersion: ctx.nodeVersion,
      platform: ctx.platform,
      localIp: ctx.localIp,
    },
    changed: false,
  };
}

export function loadBuildHistory(): BuildHistory | null {
  try {
    const raw = JSON.parse(fs.readFileSync(historyFile(), 'utf8'));
    if (raw && typeof raw === 'object' && typeof raw.current === 'string') {
      return raw as BuildHistory;
    }
    return null;
  } catch {
    return null;
  }
}

function saveBuildHistory(h: BuildHistory): void {
  const f = historyFile();
  try {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const tmp = f + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(h, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, f);
    try { fs.chmodSync(f, 0o600); } catch { /* best effort */ }
  } catch {
    /* best effort — losing the file only loses upgrade timestamps */
  }
}

/** Best-effort local IPv4 address (first non-loopback). */
function getLocalIp(): string | undefined {
  try {
    const interfaces = os.networkInterfaces();
    for (const iface of Object.values(interfaces)) {
      if (!iface) continue;
      for (const a of iface) {
        if (a.family === 'IPv4' && !a.internal) return a.address;
      }
    }
  } catch { /* best effort */ }
  return undefined;
}

/** Read the running lm-assist version from package.json (mirrors hub-config.ts#getVersion). */
function readVersion(): string {
  for (const rel of ['../../../package.json', '../../package.json']) {
    try {
      const p = path.join(__dirname, rel);
      if (fs.existsSync(p)) {
        const pkg = JSON.parse(fs.readFileSync(p, 'utf8')) as { version?: string };
        if (pkg.version) return pkg.version;
      }
    } catch { /* try next */ }
  }
  return '0.0.0';
}

/** Resolve the preferred node identifier (gatewayId > machineId > hostname). */
function getNodeId(): string {
  try {
    const { getHubConfig } = require('../hub-client/hub-config') as typeof import('../hub-client/hub-config');
    const cfg = getHubConfig();
    return cfg.gatewayId || cfg.machineId || cfg.hostname || os.hostname();
  } catch {
    return os.hostname();
  }
}

/**
 * Record the running build version. Idempotent — only writes when the version
 * changed vs. the stored record. NEVER throws.
 */
export function recordBuild(): BuildHistory {
  try {
    const version = readVersion();
    const node = getNodeId();
    const ctx = {
      node,
      nodeVersion: process.version,
      platform: os.platform(),
      localIp: getLocalIp(),
      now: new Date().toISOString(),
    };
    const prev = loadBuildHistory();
    const { next, changed } = applyBuild(prev, version, ctx);
    if (changed) saveBuildHistory(next);
    return next;
  } catch {
    // Absolute last resort — return a minimal record so callers never crash.
    return {
      node: os.hostname(),
      current: '0.0.0',
      upgradedAt: null,
      previousVersion: null,
      nodeVersion: process.version,
      platform: os.platform(),
      history: [],
    };
  }
}
