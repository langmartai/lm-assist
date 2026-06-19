/**
 * Machine-global, per-hub singleton lock for the HubClient.
 *
 * Problem it prevents: a SECOND lm-assist core on the same machine dialing the
 * SAME hub registers as a DUPLICATE node (different gatewayId, because the
 * gatewayId is persisted per config-dir and a core run from another directory
 * gets a fresh one). If that duplicate can't serve /mcp it returns 502s, and a
 * WS reshuffle can even make it the "most recently connected" default — a hard
 * MCP outage (root-caused 2026-06-20: an orphan `core/dist/cli.js serve` left
 * running from a temp dir).
 *
 * The lock lives in os.tmpdir() (NOT the config dir) so it is shared by every
 * core on the machine regardless of which data/project dir each was launched
 * with — that's what lets it catch an orphan started from elsewhere. It is
 * keyed by a hash of the hub URL, so the legitimate dev (xeenhub) + prod
 * (langmart) cores, which target DIFFERENT hubs, each get their own lock and
 * coexist. Stale locks (owner pid dead) are reclaimed automatically.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';

export interface LockResult {
  acquired: boolean;
  heldByPid?: number;
  lockFile: string;
}

function lockPathFor(hubUrl: string, dir: string): string {
  const h = crypto.createHash('sha256').update(hubUrl).digest('hex').slice(0, 12);
  return path.join(dir, `lm-assist-hub-${h}.lock`);
}

/** True if `pid` is a live process. EPERM means it exists but isn't ours → alive. */
function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

/**
 * Acquire the singleton lock for `hubUrl`. Returns `{acquired:false, heldByPid}`
 * when a DIFFERENT live process already owns it (a duplicate core). Reclaims a
 * stale lock whose owner pid is dead. Fails OPEN on any fs error so a weird
 * filesystem never blocks a legitimate core.
 */
export function acquireHubSingletonLock(hubUrl: string, dir: string = os.tmpdir()): LockResult {
  const lockFile = lockPathFor(hubUrl, dir);
  try {
    if (fs.existsSync(lockFile)) {
      const owner = parseInt(fs.readFileSync(lockFile, 'utf-8').trim(), 10);
      if (owner !== process.pid && isPidAlive(owner)) {
        return { acquired: false, heldByPid: owner, lockFile };
      }
    }
    fs.writeFileSync(lockFile, String(process.pid));
    return { acquired: true, lockFile };
  } catch {
    return { acquired: true, lockFile };
  }
}

/** Release the lock for `hubUrl`, but only if THIS process owns it. */
export function releaseHubSingletonLock(hubUrl: string, dir: string = os.tmpdir()): void {
  const lockFile = lockPathFor(hubUrl, dir);
  try {
    if (fs.existsSync(lockFile)) {
      const owner = parseInt(fs.readFileSync(lockFile, 'utf-8').trim(), 10);
      if (owner === process.pid) fs.unlinkSync(lockFile);
    }
  } catch {
    /* ignore */
  }
}
