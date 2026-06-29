import { execFile } from 'child_process';

export type RunCmd = (
  cmd: string,
  args: string[],
  opts: { cwd?: string; timeoutMs: number; env?: Record<string, string> },
) => Promise<{ stdout: string; code: number }>;

/** Promisified execFile that never rejects on a non-zero exit — returns { stdout, code }.
 *  killSignal+timeout bound a hung command; maxBuffer caps runaway output. */
export const runCmd: RunCmd = (cmd, args, opts) =>
  new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { cwd: opts.cwd, timeout: opts.timeoutMs, env: { ...process.env, ...(opts.env || {}) }, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
      (err, stdout) => {
        const code = err && typeof (err as NodeJS.ErrnoException).code === 'number' ? (err as any).code : err ? 1 : 0;
        resolve({ stdout: stdout?.toString() ?? '', code });
      },
    );
  });
