// core/src/relaunch-helper.ts
// Standalone, detached relauncher for `lifecycle.spawnCoreRelauncher`. It waits for the old
// core's port to free, then re-spawns the core, then exits. ALL config arrives as ARGV — there
// is no eval/code-generation:  node relaunch-helper.js <port> <execPath> <cliPath> [...serveArgs]
// Inherits env (so a --extra-ca node restarts with NODE_EXTRA_CA_CERTS still set).

import * as net from 'net';
import { spawn } from 'child_process';

function run(): void {
  const port = parseInt(process.argv[2] || '', 10);
  const exec = process.argv[3] || process.execPath;
  const coreArgs = process.argv.slice(4); // [cliPath, ...serveArgs]
  if (!Number.isFinite(port) || coreArgs.length === 0) { process.exit(1); return; }

  let tries = 0;
  const relaunch = (): void => {
    try { spawn(exec, coreArgs, { detached: true, stdio: 'ignore' }).unref(); } catch { /* ignore */ }
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
