/**
 * In-process log rotation for the Core's stdout/stderr log.
 *
 * The service manager launches the Core with its stdout+stderr redirected to a
 * file in append mode (`core-prod.log` / `core-dev.log`). Nothing ever truncated
 * that file, so on a long-lived hub-connected node the per-request relay logging
 * grew it without bound (observed: 2.6 GB). This caps it: a periodic timer keeps
 * the file under a size ceiling, preserving the most recent tail.
 *
 * The tricky part is that the process is still writing to the file via its own
 * O_APPEND descriptor (fd 1). We can't rename/replace the file — the held fd
 * would keep writing to the now-unlinked inode. Instead we truncate the SAME
 * descriptor (fd 1) and write the retained tail back through it; O_APPEND means
 * the process's ongoing `console.log` output lands after the tail. We only touch
 * fd 1 when it verifiably points at the log file (so a systemd/journald or TTY
 * stdout is never disturbed); otherwise nothing to do — journald rotates itself.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const MAX_BYTES = 64 * 1024 * 1024; // rotate once the log passes 64 MB
const KEEP_BYTES = 8 * 1024 * 1024; // retain the most recent 8 MB
const CHECK_INTERVAL_MS = 5 * 60 * 1000; // every 5 minutes

let started = false;

/** Resolve the Core log path the way the service manager names it. */
function logFilePath(): string {
  const dir = path.join(os.homedir(), '.cache', 'lm-assist');
  const isProd = __dirname.includes('node_modules');
  return path.join(dir, isProd ? 'core-prod.log' : 'core-dev.log');
}

/** True when descriptor `fd` is the very file at `file` (same inode+device). */
function fdIsFile(fd: number, file: string): boolean {
  try {
    const a = fs.fstatSync(fd);
    const b = fs.statSync(file);
    // ino 0 ⇒ not a regular file (pipe/tty on some platforms) — never truncate it.
    return a.ino !== 0 && a.ino === b.ino && a.dev === b.dev;
  } catch {
    return false;
  }
}

/** Read the last `keep` bytes of `file`, trimmed to start at a line boundary. */
function readTail(file: string, size: number, keep: number): Buffer {
  const fd = fs.openSync(file, 'r');
  try {
    const start = Math.max(0, size - keep);
    const len = size - start;
    const buf = Buffer.allocUnsafe(len);
    fs.readSync(fd, buf, 0, len, start);
    if (start > 0) {
      const nl = buf.indexOf(0x0a); // drop the partial first line
      if (nl >= 0 && nl + 1 < buf.length) return buf.subarray(nl + 1);
    }
    return buf;
  } finally {
    fs.closeSync(fd);
  }
}

/** One rotation pass. Best-effort: any failure leaves the log untouched.
 *  Thresholds are injectable for testing; production uses the module defaults. */
export function rotateNow(file = logFilePath(), maxBytes = MAX_BYTES, keepBytes = KEEP_BYTES): void {
  let size: number;
  try {
    size = fs.statSync(file).size;
  } catch {
    return; // no log file (e.g. systemd → journald) — nothing to rotate
  }
  if (size <= maxBytes) return;

  const tail = readTail(file, size, keepBytes);
  const banner = Buffer.from(
    `--- lm-assist log rotated ${new Date().toISOString()}: was ${size} bytes, kept last ${tail.length} ---\n`,
  );
  const out = Buffer.concat([banner, tail]);

  if (fdIsFile(1, file)) {
    // Truncate + rewrite through our own stdout descriptor: O_APPEND makes later
    // console.log output continue after the tail, and operating on our own fd
    // sidesteps the file-sharing conflict a second writer would hit on Windows.
    try {
      fs.ftruncateSync(1, 0);
      fs.writeSync(1, out);
      return;
    } catch {
      /* fall through to the path-based attempt */
    }
  }
  // fd 1 isn't this file (dev/TTY) or the truncate failed — rewrite by path.
  try {
    fs.writeFileSync(file, out);
  } catch {
    /* give up — never let log rotation take the process down */
  }
}

/** Start the periodic rotation timer (idempotent). Runs one pass immediately so
 *  a log that already grew huge before this restart is capped right away. */
export function startLogRotation(): void {
  if (started) return;
  started = true;
  rotateNow();
  const timer = setInterval(() => rotateNow(), CHECK_INTERVAL_MS);
  if (timer.unref) timer.unref(); // never keep the process alive for this
}
