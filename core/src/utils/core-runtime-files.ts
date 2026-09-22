/**
 * The Core's runtime files — its stdout log and its pidfile — named exactly as the service
 * manager names them: `~/.cache/lm-assist/core-{prod|dev}.{log|pid}`.
 *
 * One definition shared by everything that must agree on those names without importing the
 * service manager: the in-process log rotator, the lifecycle relauncher (a standalone script)
 * and the Windows elevated worker's Core watchdog (which must not pull in Core services).
 */
import * as os from 'os';
import * as path from 'path';

export type CoreKind = 'prod' | 'dev';

/** `prod` when the code runs from an npm install (its path is under node_modules), else `dev` —
 *  the rule the service manager, hub config and log rotator already use. */
export function coreKind(dir: string = __dirname): CoreKind {
  return dir.includes('node_modules') ? 'prod' : 'dev';
}

export function coreRuntimeFiles(kind: CoreKind, home: string = os.homedir()): { dir: string; log: string; pid: string } {
  const dir = path.join(home, '.cache', 'lm-assist');
  return { dir, log: path.join(dir, `core-${kind}.log`), pid: path.join(dir, `core-${kind}.pid`) };
}
