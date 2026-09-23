/**
 * Core watchdog, hosted by the Windows elevated worker.
 *
 * Nothing restarted a Windows Core that died: the `LmAssistCoreInteractive` task fires only at
 * logon. 107's Core died of host commit exhaustion (2026-09-19) and stayed down 3.5 days. The
 * elevated worker is the natural supervisor — resident, in the interactive session, elevated,
 * and outliving Core by design (restarting Core is its reason to exist).
 *
 * The signal is the service manager's own pidfile, NOT a health check:
 *   - `lm-assist stop`, the upgrader and `node_lifecycle exit` all DELETE core-prod.pid
 *     → no pidfile = stopped on purpose → never restart;
 *   - a crash / OOM leaves it behind → pidfile + closed port + dead pid = died → restart.
 * A closed port with a LIVE pid (booting, or stuck before listen) is left alone: a start there
 * spawns a duplicate. An open port counts as alive even when slow — a Core with a blocked event
 * loop still accepts TCP, and restarting it would be worse than waiting.
 *
 * HOW it restarts matters as much as when: this worker runs ELEVATED, so a Core it spawned directly
 * would be elevated too — and so would every session, terminal and helper that Core starts. The
 * restart therefore goes ONLY through the `LmAssistCoreInteractive` task, whose principal (chosen by
 * the operator) decides both the integrity level and the Windows session. Without that task the
 * watchdog reports that it cannot restart instead of silently promoting Core.
 *
 * Pure decision + tiny fs/net probes only: the worker must never pull in Core services.
 */
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';

export interface WatchdogFacts {
  disabled: boolean;
  portOpen: boolean;
  pidFilePresent: boolean;
  pidAlive: boolean;
  now: number;
}

export interface WatchdogState {
  /** Consecutive probes that saw a dead Core. */
  failures: number;
  /** Last restart attempt, ms epoch. */
  lastStartAt: number | null;
}

export type WatchdogAction =
  | 'disabled' | 'healthy' | 'stopped-on-purpose' | 'pid-alive' | 'confirming' | 'cooldown' | 'start';

export interface WatchdogOptions {
  /** Dead probes in a row before acting (x interval = how long Core must stay down). */
  threshold: number;
  /** Minimum gap between restart attempts, so a Core that dies on boot is not hammered. */
  cooldownMs: number;
}

export const WATCHDOG_DEFAULTS: WatchdogOptions = { threshold: 3, cooldownMs: 10 * 60_000 };

export function decideWatchdog(
  s: WatchdogState, f: WatchdogFacts, o: WatchdogOptions = WATCHDOG_DEFAULTS,
): { action: WatchdogAction; next: WatchdogState } {
  const clear = { ...s, failures: 0 };
  if (f.disabled) return { action: 'disabled', next: clear };
  if (f.portOpen) return { action: 'healthy', next: clear };
  if (!f.pidFilePresent) return { action: 'stopped-on-purpose', next: clear };
  if (f.pidAlive) return { action: 'pid-alive', next: clear };
  const failures = s.failures + 1;
  if (failures < o.threshold) return { action: 'confirming', next: { ...s, failures } };
  if (s.lastStartAt !== null && f.now - s.lastStartAt < o.cooldownMs) return { action: 'cooldown', next: { ...s, failures } };
  return { action: 'start', next: { failures: 0, lastStartAt: f.now } };
}

/** The interactive-launch task (same name as windows-session-guard's INTERACTIVE_TASK — a test pins
 *  them together; duplicated so the worker does not load the Core-side module). */
export const CORE_LAUNCH_TASK = 'LmAssistCoreInteractive';

/** The command the watchdog runs to bring Core back, or null when it must not (see header): only the
 *  operator's interactive task, never a direct `lm-assist start` from this elevated process. */
export function coreRestartCommand(taskRegistered: boolean): { cmd: string; args: string[] } | null {
  return taskRegistered ? { cmd: 'schtasks', args: ['/run', '/tn', CORE_LAUNCH_TASK] } : null;
}

export function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

/**
 * Pidfile facts. A pidfile written before the last boot names a process from a previous boot —
 * that pid may now belong to anything — so it is present but never alive.
 */
export function pidFileFacts(
  pidFile: string,
  isAlive: (pid: number) => boolean = pidAlive,
  bootTimeMs: number = Date.now() - os.uptime() * 1000,
): { present: boolean; alive: boolean; pid: number | null } {
  let mtimeMs: number;
  try { mtimeMs = fs.statSync(pidFile).mtimeMs; } catch { return { present: false, alive: false, pid: null }; }
  let pid: number | null = null;
  try {
    const n = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
    pid = Number.isFinite(n) && n > 0 ? n : null;
  } catch { /* unreadable — treated as a dead pid */ }
  return { present: true, alive: pid !== null && mtimeMs >= bootTimeMs && isAlive(pid), pid };
}

/** Does anything accept TCP on 127.0.0.1:port? Liveness, not health (see header): a connect
 *  that neither succeeds nor fails in time counts as alive — waiting beats a wrong restart. */
export function probePort(port: number, timeoutMs = 3000): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1');
    let settled = false;
    const done = (open: boolean): void => {
      if (settled) return;
      settled = true;
      try { s.destroy(); } catch { /* ignore */ }
      resolve(open);
    };
    s.setTimeout(timeoutMs);
    s.on('connect', () => done(true));
    s.on('timeout', () => done(true));
    s.on('error', () => done(false));
  });
}

/** Operator opt-out: `LM_CORE_WATCHDOG=0|off|false|no`, or the flag file (checked every tick,
 *  so it takes effect without restarting the worker). */
export function watchdogDisabled(flagFile: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (['0', 'off', 'false', 'no'].includes(String(env.LM_CORE_WATCHDOG ?? '').trim().toLowerCase())) return true;
  try { return fs.existsSync(flagFile); } catch { return false; }
}
