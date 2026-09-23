// core/src/lifecycle.ts
// Graceful self-exit / self-restart of the Core (and Web) so a node can be cycled
// WITHOUT a force-kill (taskkill / fuser -k / Stop-Process). A graceful exit only
// works on a HEALTHY process; a kernel-wedged process still needs a manual kill/reboot.

import { spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { coreKind, coreRuntimeFiles } from './utils/core-runtime-files';

export type LifecycleTarget = 'core' | 'web' | 'both';
export type LifecycleAction = 'exit' | 'restart';

/** Coerce arbitrary input to a valid target (default 'core'). Pure. */
export function normalizeTarget(t: unknown): LifecycleTarget {
  return t === 'web' || t === 'both' ? t : 'core';
}

/** Resolve the core's own serve invocation from argv (preserves --port/--project/--extra-ca). Pure. */
export function coreServeInvocation(
  argv: string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env,
): { cliPath: string; serveArgs: string[]; port: number } {
  const cliPath = argv[1] || '';
  const serveArgs = argv.slice(2);
  const pIdx = serveArgs.findIndex((a) => a === '--port' || a === '-p');
  const fromArg = pIdx >= 0 ? parseInt(serveArgs[pIdx + 1], 10) : NaN;
  const port = Number.isFinite(fromArg) ? fromArg : (parseInt(env.API_PORT || '3100', 10) || 3100);
  return { cliPath, serveArgs, port };
}

/** Argv for the standalone relaunch-helper (config passed as ARGS, not interpolated code):
 *  `node relaunch-helper.js <port> <execPath> <cliPath> [...serveArgs]`. Pure. */
export function relauncherArgs(helperPath: string, port: number, execPath: string, cliPath: string, serveArgs: string[]): string[] {
  return [helperPath, String(port), execPath, cliPath, ...serveArgs];
}

/** Spawn the detached relauncher (a committed helper script — no eval/code-gen) that waits
 *  for the core port to free, then re-spawns the core. Inherits env (so a --extra-ca node
 *  restarts with NODE_EXTRA_CA_CERTS still set). Best-effort. */
/** True when this core is running as a systemd unit (its detached children share the unit's
 *  cgroup and get killed on stop unless they escape it). Pure-ish (reads env + /run). */
export function isSystemdManaged(env: NodeJS.ProcessEnv = process.env): boolean {
  return !!env.INVOCATION_ID && fs.existsSync('/run/systemd/system');
}

export function spawnCoreRelauncher(): void {
  const { cliPath, serveArgs, port } = coreServeInvocation();
  const helperPath = path.join(__dirname, 'relaunch-helper.js'); // sibling of lifecycle.js in core/dist
  const args = relauncherArgs(helperPath, port, process.execPath, cliPath, serveArgs);
  spawn(process.execPath, args, { detached: true, stdio: 'ignore' }).unref();
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

/**
 * An intentional exit releases the Core pidfile — the same thing `lm-assist stop` does — so a
 * supervisor that reads "pidfile present, Core gone" as a crash (the Windows elevated worker's
 * watchdog) leaves an exited Core down instead of resurrecting it. Only a pidfile naming THIS
 * process or a dead one is removed: never another live Core's. A restart keeps it — the
 * relauncher rewrites it with the new Core's pid.
 */
export function releaseCorePidFile(
  pidFile: string = coreRuntimeFiles(coreKind(__dirname)).pid,
  selfPid: number = process.pid,
  isAlive: (pid: number) => boolean = pidAlive,
): boolean {
  let pid: number;
  try { pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10); } catch { return false; }
  if (Number.isFinite(pid) && pid !== selfPid && isAlive(pid)) return false;
  try { fs.unlinkSync(pidFile); return true; } catch { return false; }
}

/** Disconnect the hub, optionally spawn the relauncher, then process.exit — after a short
 *  delay so the HTTP response (and its relay hop) flushes to the caller first. */
export function scheduleCoreExit(relaunch: boolean, delayMs = 500): void {
  setTimeout(() => {
    try { const { getHubClient } = require('./hub-client'); getHubClient().disconnect().catch(() => {}); } catch { /* ignore */ }
    if (relaunch && isSystemdManaged()) {
      // systemd owns this unit; a self-spawned child would be killed with the unit's cgroup on
      // stop. Exit NON-ZERO so Restart=on-failure/always relaunches us cleanly. (If the unit is
      // Restart=no this degrades to a plain shutdown — use `systemctl restart` on such nodes.)
      setTimeout(() => process.exit(1), 200);
      return;
    }
    if (relaunch) {
      try { spawnCoreRelauncher(); }
      catch (e) { console.error('[lifecycle] relauncher spawn failed — core will exit WITHOUT self-respawn (supervisor must restart it):', (e as Error)?.message); }
    } else {
      releaseCorePidFile();
    }
    setTimeout(() => process.exit(0), 200);
  }, delayMs);
}

/** Apply exit/restart to the target. Web is handled synchronously via the service-manager;
 *  core is SCHEDULED so the caller receives a response before the process exits. */
export async function applyLifecycle(action: LifecycleAction, target: LifecycleTarget): Promise<{ web?: string; core?: string }> {
  const out: { web?: string; core?: string } = {};
  if (target === 'web' || target === 'both') {
    try {
      const sm = require('./service-manager') as typeof import('./service-manager');
      const stop = await sm.stopWeb();
      out.web = action === 'restart' ? `${stop.message}; ${(await sm.startWeb()).message}` : stop.message;
    } catch (e) {
      out.web = `error: ${(e as Error).message}`;
    }
  }
  if (target === 'core' || target === 'both') {
    scheduleCoreExit(action === 'restart', 500);
    out.core = action === 'restart' ? 'restarting in ~0.5s (self-respawn)' : 'exiting in ~0.5s';
  }
  return out;
}
