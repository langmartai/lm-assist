// core/src/lifecycle.ts
// Graceful self-exit / self-restart of the Core (and Web) so a node can be cycled
// WITHOUT a force-kill (taskkill / fuser -k / Stop-Process). A graceful exit only
// works on a HEALTHY process; a kernel-wedged process still needs a manual kill/reboot.

import { spawn } from 'child_process';
import * as path from 'path';

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
export function spawnCoreRelauncher(): void {
  const { cliPath, serveArgs, port } = coreServeInvocation();
  const helperPath = path.join(__dirname, 'relaunch-helper.js'); // sibling of lifecycle.js in core/dist
  const args = relauncherArgs(helperPath, port, process.execPath, cliPath, serveArgs);
  spawn(process.execPath, args, { detached: true, stdio: 'ignore' }).unref();
}

/** Disconnect the hub, optionally spawn the relauncher, then process.exit — after a short
 *  delay so the HTTP response (and its relay hop) flushes to the caller first. */
export function scheduleCoreExit(relaunch: boolean, delayMs = 500): void {
  setTimeout(() => {
    try { const { getHubClient } = require('./hub-client'); getHubClient().disconnect().catch(() => {}); } catch { /* ignore */ }
    if (relaunch) {
      try { spawnCoreRelauncher(); }
      catch (e) { console.error('[lifecycle] relauncher spawn failed — core will exit WITHOUT self-respawn (supervisor must restart it):', (e as Error)?.message); }
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
