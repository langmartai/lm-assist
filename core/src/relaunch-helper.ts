// core/src/relaunch-helper.ts
// Standalone, detached relauncher for `lifecycle.spawnCoreRelauncher`. It waits for the old
// core's port to free, then re-spawns the core, then exits. ALL config arrives as ARGV — there
// is no eval/code-generation:  node relaunch-helper.js <port> <execPath> <cliPath> [...serveArgs]
// Inherits env (so a --extra-ca node restarts with NODE_EXTRA_CA_CERTS still set).

import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';
import { spawn, type StdioOptions } from 'child_process';
import { coreKind, coreRuntimeFiles } from './utils/core-runtime-files';
import { rotateNow } from './utils/log-rotate';

/**
 * stdio for the relaunched Core: stdout+stderr APPENDED to the same log the service manager
 * uses (capped first — nothing holds it once the old Core is gone). This used to be 'ignore':
 * a lifecycle-restarted Core logged NOTHING for its whole life, so the log tail kept showing the
 * previous Core's clean shutdown and a later crash left no trace (107, 2026-09: 12 days unlogged,
 * then a silent death). Best-effort: any failure falls back to 'ignore', never blocks the relaunch.
 */
export function relaunchStdio(logFile: string): { stdio: StdioOptions; fd: number | null } {
  try {
    try { rotateNow(logFile); } catch { /* never block the relaunch on rotation */ }
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    const fd = fs.openSync(logFile, 'a');
    return { stdio: ['ignore', fd, fd], fd };
  } catch {
    return { stdio: 'ignore', fd: null };
  }
}

function run(): void {
  const port = parseInt(process.argv[2] || '', 10);
  const exec = process.argv[3] || process.execPath;
  const coreArgs = process.argv.slice(4); // [cliPath, ...serveArgs]
  if (!Number.isFinite(port) || coreArgs.length === 0) { process.exit(1); return; }
  const files = coreRuntimeFiles(coreKind(__dirname));

  let tries = 0;
  const relaunch = (): void => {
    const { stdio, fd } = relaunchStdio(files.log);
    try {
      const child = spawn(exec, coreArgs, { detached: true, stdio, windowsHide: true });
      child.on('error', () => { /* spawn failure must not throw in a detached helper */ });
      // Record the NEW Core. Left alone the pidfile names the Core that just exited: `lm-assist
      // stop` would kill-by-pid a number the OS may have reused, and the Windows watchdog (which
      // treats a surviving pidfile as "should be running") would be judging a dead pid.
      if (child.pid) { try { fs.writeFileSync(files.pid, String(child.pid)); } catch { /* best effort */ } }
      child.unref();
    } catch { /* ignore */ }
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* ignore */ } }
    process.exit(0);
  };
  const poll = (): void => {
    const s = net.connect(port, '127.0.0.1');
    s.setTimeout(1000);
    s.on('connect', () => { s.destroy(); (tries++ < 40) ? setTimeout(poll, 500) : relaunch(); });
    s.on('timeout', () => { try { s.destroy(); } catch { /* ignore */ } relaunch(); });
    s.on('error', () => relaunch()); // port free → start the fresh core
  };
  poll();
}

// Only run when executed directly (so a stray import never polls/exits a host process).
if (require.main === module) run();
