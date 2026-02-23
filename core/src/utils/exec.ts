/**
 * Cross-platform exec utilities.
 *
 * Wraps child_process functions with `windowsHide: true` to prevent
 * CMD window flashes on Windows when the backend spawns processes
 * (e.g. `where claude`, `claude --version`, `npm root -g`).
 */
import {
  execFileSync as _execFileSync,
  execFile as _execFile,
  spawn as _spawn,
  type ExecFileSyncOptions,
  type SpawnOptions,
} from 'child_process';

export function execFileSync(file: string, args: readonly string[], options: ExecFileSyncOptions & { encoding: BufferEncoding }): string;
export function execFileSync(file: string, args: readonly string[], options?: ExecFileSyncOptions): string | Buffer;
export function execFileSync(file: string, args: readonly string[], options?: ExecFileSyncOptions): string | Buffer {
  return _execFileSync(file, args, { windowsHide: true, ...options });
}

export const execFile: typeof _execFile = ((...args: any[]) => {
  // Inject windowsHide into the options argument
  // execFile(file, args?, options?, callback?)
  const [file, fileArgs, opts, cb] = args;
  if (typeof opts === 'object' && opts !== null) {
    return _execFile(file, fileArgs, { windowsHide: true, ...opts }, cb);
  }
  if (typeof opts === 'function') {
    return _execFile(file, fileArgs, { windowsHide: true }, opts);
  }
  return _execFile(file, fileArgs, { windowsHide: true }, cb);
}) as typeof _execFile;

export function spawn(command: string, args: readonly string[], options?: SpawnOptions) {
  return _spawn(command, args, { windowsHide: true, ...options });
}
