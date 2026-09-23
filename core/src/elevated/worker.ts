/**
 * Elevated worker — WINDOWS-ONLY resident, standalone (out-of-Core) process.
 *
 * Launched as `node dist/elevated/worker.js` by the `LmAssistElevatedWorker`
 * Scheduled Task (RunLevel=Highest), so this process itself runs ELEVATED
 * (high integrity). Any child process it spawns inherits that elevation — which
 * is the whole point: the non-elevated Core POSTs a command here and it runs
 * elevated WITHOUT a per-command UAC prompt.
 *
 * Independent lifecycle: it is NOT a Core child. Restarting Core is one of its
 * jobs, so it must outlive Core. It auto-starts at logon (the task's AtLogon
 * trigger) and is startable on demand (`schtasks /run`).
 *
 * Command channel security:
 *   - loopback ONLY (127.0.0.1) — never 0.0.0.0.
 *   - every request except GET /health must carry `x-api-token` (or `x-api-key`)
 *     equal to the CURRENT content of the api-token file (re-read per request so
 *     token rotation is honored). 401 otherwise. The token is NEVER logged.
 *   - single instance: bind the port; if already bound, log + exit 0.
 *   - full audit of every request+result to <dataDir>/elevated/audit.jsonl.
 *
 * This file intentionally imports ONLY pure helpers (path/token file location)
 * so booting the worker never starts Core services.
 */
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { spawn, execSync, type ChildProcess } from 'child_process';
import { timingSafeEqual } from 'crypto';
import { apiTokenFilePath } from '../auth/api-token';
import { coreRuntimeFiles } from '../utils/core-runtime-files';
import {
  ELEVATED_HOST,
  elevatedPort,
  elevatedDir,
  auditFilePath,
  workerLogPath,
  pidFilePath,
  DEFAULT_EXEC_TIMEOUT_MS,
  MAX_EXEC_TIMEOUT_MS,
  buildShellCommandLine,
  shellSpawn,
} from './common';
import {
  CORE_LAUNCH_TASK,
  coreRestartCommand,
  decideWatchdog,
  pidFileFacts,
  probePort,
  watchdogDisabled,
  type WatchdogAction,
  type WatchdogState,
} from './watchdog';

const SINCE = new Date().toISOString();

// ─── logging ─────────────────────────────────────────────────────────────
function ensureDir(): void {
  try {
    fs.mkdirSync(elevatedDir(), { recursive: true });
  } catch {
    /* best effort */
  }
}

function log(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try {
    fs.appendFileSync(workerLogPath(), line);
  } catch {
    /* best effort */
  }
  // Also to stdout (captured by the scheduled task if a console exists).
  process.stdout.write(line);
}

/** Append one structured audit record. The token is NEVER included. */
function audit(rec: Record<string, unknown>): void {
  try {
    fs.appendFileSync(auditFilePath(), JSON.stringify({ ts: new Date().toISOString(), ...rec }) + '\n');
  } catch {
    /* best effort */
  }
}

// ─── elevation self-check (best effort) ────────────────────────────────────
let cachedIntegrity: string | null = null;
function detectIntegrity(): string {
  if (cachedIntegrity) return cachedIntegrity;
  // whoami /groups lists the mandatory-level SID. High = S-1-16-12288.
  try {
    const out = execSync('whoami /groups', { encoding: 'utf8', windowsHide: true });
    if (out.includes('S-1-16-16384')) cachedIntegrity = 'System';
    else if (out.includes('S-1-16-12288')) cachedIntegrity = 'High';
    else if (out.includes('S-1-16-8192')) cachedIntegrity = 'Medium';
    else cachedIntegrity = 'Unknown';
  } catch {
    cachedIntegrity = 'Unknown';
  }
  return cachedIntegrity;
}

function isElevated(): boolean {
  const integrity = detectIntegrity();
  if (integrity === 'High' || integrity === 'System') return true;
  // Fallback: `net session` succeeds only for admins.
  try {
    execSync('net session', { stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

// ─── auth ──────────────────────────────────────────────────────────────────
function currentToken(): string | null {
  try {
    const c = fs.readFileSync(apiTokenFilePath(), 'utf8').trim();
    return c || null;
  } catch {
    return null;
  }
}

/** Constant-time compare of the presented token against the current file token. */
function tokenValid(presented: string | undefined): boolean {
  if (!presented) return false;
  const want = currentToken();
  if (!want) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(want);
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

function presentedToken(req: http.IncomingMessage): string | undefined {
  const h = (name: string): string | undefined => {
    const v = req.headers[name];
    return Array.isArray(v) ? v[0] : v;
  };
  return h('x-api-token') || h('x-api-key');
}

// ─── request body ────────────────────────────────────────────────────────
function readBody(req: http.IncomingMessage, limit = 1_048_576): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      data += chunk.toString('utf8');
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(payload);
}

// ─── /exec ───────────────────────────────────────────────────────────────
interface ExecReq {
  cmd?: string;
  args?: string[];
  cwd?: string;
  timeoutMs?: number;
  shell?: 'cmd' | 'powershell';
}

interface ExecResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  elapsedMs: number;
  timedOut?: boolean;
}

function killTree(pid: number): void {
  try {
    execSync(`taskkill /F /T /PID ${pid}`, { stdio: 'ignore', windowsHide: true });
  } catch {
    try {
      process.kill(pid);
    } catch {
      /* already dead */
    }
  }
}

function runExec(body: ExecReq): Promise<ExecResult> {
  return new Promise((resolve) => {
    const cmd = String(body.cmd || '').trim();
    const args = Array.isArray(body.args) ? body.args.map(String) : [];
    const cwd = body.cwd ? String(body.cwd) : undefined;
    const shell = body.shell === 'powershell' ? 'powershell' : 'cmd';
    let timeoutMs = Number(body.timeoutMs);
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) timeoutMs = DEFAULT_EXEC_TIMEOUT_MS;
    timeoutMs = Math.min(timeoutMs, MAX_EXEC_TIMEOUT_MS);

    // cmd verbatim (it IS the shell line: pipes/redirects/pre-quoted `bash -c`
    // work), args quoted PER-ARG for the shell (spaces and | > & inside an arg
    // are data). See buildShellCommandLine.
    const fullCmd = buildShellCommandLine(cmd, args, shell);

    const how = shellSpawn(fullCmd, shell);
    const child: ChildProcess = spawn(how.file, how.args, {
      cwd,
      windowsHide: true,
      windowsVerbatimArguments: how.windowsVerbatimArguments,
    });

    const start = Date.now();
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const OUT_CAP = 8 * 1024 * 1024;

    child.stdout?.on('data', (d: Buffer) => {
      if (stdout.length < OUT_CAP) stdout += d.toString('utf8');
    });
    child.stderr?.on('data', (d: Buffer) => {
      if (stderr.length < OUT_CAP) stderr += d.toString('utf8');
    });

    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid) killTree(child.pid);
    }, timeoutMs);
    timer.unref?.();

    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({
        exitCode: null,
        stdout,
        stderr: (stderr + '\n' + (e instanceof Error ? e.message : String(e))).trim(),
        elapsedMs: Date.now() - start,
        timedOut,
      });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        exitCode: code,
        stdout,
        stderr: timedOut ? (stderr + `\n[killed: exceeded timeoutMs=${timeoutMs}]`).trim() : stderr,
        elapsedMs: Date.now() - start,
        timedOut,
      });
    });
  });
}

// ─── Core watchdog ─────────────────────────────────────────────────────────
// Restarts the PROD Core when it dies with its pidfile still in place (see ./watchdog.ts for why
// the pidfile, not a health check, is the signal). Windows-only by construction: this process
// only exists on Windows.
const WATCHDOG_PORT = ((): number => {
  const v = Number(process.env.LM_CORE_WATCHDOG_PORT);
  return Number.isInteger(v) && v > 0 && v < 65536 ? v : 3100;
})();
const WATCHDOG_INTERVAL_MS = Math.max(5_000, Number(process.env.LM_CORE_WATCHDOG_INTERVAL_MS) || 30_000);
const WATCHDOG_PIDFILE = coreRuntimeFiles('prod').pid;
const WATCHDOG_OFF_FLAG = path.join(elevatedDir(), 'watchdog.off');

let wdState: WatchdogState = { failures: 0, lastStartAt: null };
let wdLast: { action: WatchdogAction; at: string } | null = null;
let wdLastStart: { at: string; exitCode: number | null; elapsedMs: number; timedOut: boolean; tail: string } | null = null;
let wdBusy = false;

/** Is the interactive-launch task registered? Asked only when a restart is due (rare). */
function launchTaskRegistered(): boolean {
  try {
    execSync(`schtasks /query /tn ${CORE_LAUNCH_TASK}`, { stdio: 'ignore', windowsHide: true, timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}

async function watchdogTick(): Promise<void> {
  if (wdBusy) return; // a restart is still in flight
  wdBusy = true;
  try {
    const disabled = watchdogDisabled(WATCHDOG_OFF_FLAG);
    const portOpen = disabled ? false : await probePort(WATCHDOG_PORT);
    const pf = pidFileFacts(WATCHDOG_PIDFILE);
    const { action, next } = decideWatchdog(wdState, {
      disabled, portOpen, pidFilePresent: pf.present, pidAlive: pf.alive, now: Date.now(),
    });
    wdState = next;
    if (action !== wdLast?.action) {
      log(`watchdog: ${action} (core :${WATCHDOG_PORT}, pidfile ${pf.present ? `pid ${pf.pid ?? '?'}` : 'absent'})`);
    }
    wdLast = { action, at: new Date().toISOString() };
    if (action !== 'start') return;

    const plan = coreRestartCommand(launchTaskRegistered());
    if (!plan) {
      const why = `no "${CORE_LAUNCH_TASK}" scheduled task is registered, and a start from this ELEVATED worker `
        + 'would run Core elevated — register that task to let the watchdog restart Core';
      wdLastStart = { at: new Date().toISOString(), exitCode: null, elapsedMs: 0, timedOut: false, tail: `not restarted: ${why}` };
      audit({ kind: 'watchdog', skipped: 'no-launch-task', caller: 'watchdog', deadPid: pf.pid });
      log(`watchdog: Core :${WATCHDOG_PORT} is gone (pid ${pf.pid ?? '?'} dead) but NOT restarting: ${why}`);
      return;
    }
    const line = `${plan.cmd} ${plan.args.join(' ')}`;
    log(`watchdog: Core :${WATCHDOG_PORT} is gone but its pidfile survived (pid ${pf.pid ?? '?'} dead) — running \`${line}\``);
    const r = await runExec({ cmd: plan.cmd, args: plan.args, timeoutMs: 60_000 });
    const tail = `${r.stdout}\n${r.stderr}`.trim().split(/\r?\n/).slice(-6).join(' | ').slice(-1500);
    wdLastStart = { at: new Date().toISOString(), exitCode: r.exitCode, elapsedMs: r.elapsedMs, timedOut: !!r.timedOut, tail };
    audit({
      kind: 'watchdog', cmd: plan.cmd, args: plan.args, cwd: null, shell: 'cmd',
      exitCode: r.exitCode, elapsedMs: r.elapsedMs, timedOut: !!r.timedOut, caller: 'watchdog', deadPid: pf.pid,
    });
    log(`watchdog: ${line} → exit ${r.exitCode} in ${r.elapsedMs}ms: ${tail}`);
  } catch (e) {
    log(`watchdog: tick failed: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    wdBusy = false;
  }
}

function watchdogReport(): Record<string, unknown> {
  return {
    enabled: !watchdogDisabled(WATCHDOG_OFF_FLAG),
    port: WATCHDOG_PORT,
    intervalMs: WATCHDOG_INTERVAL_MS,
    pidFile: WATCHDOG_PIDFILE,
    offFlag: WATCHDOG_OFF_FLAG,
    last: wdLast,
    failures: wdState.failures,
    lastStart: wdLastStart,
  };
}

// ─── HTTP server ───────────────────────────────────────────────────────────
/** Port resolution: env LM_ELEVATED_PORT wins, else a `--port N` argv, else default. */
function resolvePort(): number {
  const fromEnv = Number(process.env.LM_ELEVATED_PORT);
  if (Number.isInteger(fromEnv) && fromEnv > 0 && fromEnv < 65536) return fromEnv;
  const idx = process.argv.indexOf('--port');
  if (idx >= 0) {
    const p = Number(process.argv[idx + 1]);
    if (Number.isInteger(p) && p > 0 && p < 65536) return p;
  }
  return elevatedPort();
}
const PORT = resolvePort();

const server = http.createServer(async (req, res) => {
  const url = req.url || '';
  const method = (req.method || 'GET').toUpperCase();
  const routePath = url.split('?')[0];

  // GET /health — tokenless (liveness + elevation report).
  if (method === 'GET' && routePath === '/health') {
    sendJson(res, 200, {
      ok: true,
      elevated: isElevated(),
      integrity: detectIntegrity(),
      pid: process.pid,
      since: SINCE,
      port: PORT,
      watchdog: watchdogReport(),
    });
    return;
  }

  // Everything else requires a valid token.
  if (!tokenValid(presentedToken(req))) {
    sendJson(res, 401, { ok: false, error: { code: 'UNAUTHORIZED', message: 'missing or invalid api token' } });
    return;
  }

  // POST /exec — run a command elevated.
  if (method === 'POST' && routePath === '/exec') {
    let body: ExecReq;
    try {
      const raw = await readBody(req);
      body = raw ? (JSON.parse(raw) as ExecReq) : {};
    } catch (e) {
      sendJson(res, 400, { ok: false, error: { code: 'BAD_REQUEST', message: e instanceof Error ? e.message : String(e) } });
      return;
    }
    const cmd = String(body.cmd || '').trim();
    if (!cmd) {
      sendJson(res, 400, { ok: false, error: { code: 'BAD_REQUEST', message: '`cmd` is required' } });
      return;
    }
    const result = await runExec(body);
    audit({
      cmd,
      args: Array.isArray(body.args) ? body.args : [],
      cwd: body.cwd || null,
      shell: body.shell || 'cmd',
      exitCode: result.exitCode,
      elapsedMs: result.elapsedMs,
      timedOut: result.timedOut || false,
      caller: (req.socket.remoteAddress || 'unknown'),
    });
    sendJson(res, 200, { ok: true, ...result });
    return;
  }

  sendJson(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: `no route ${method} ${routePath}` } });
});

// Single-instance: bind, or exit 0 if the port is already held (another worker).
server.on('error', (e: NodeJS.ErrnoException) => {
  if (e.code === 'EADDRINUSE') {
    log(`port ${PORT} already in use — another elevated worker is running; exiting 0`);
    process.exit(0);
  }
  log(`server error: ${e.message}`);
  process.exit(1);
});

function writePidFile(): void {
  try {
    fs.writeFileSync(pidFilePath(), String(process.pid));
  } catch {
    /* best effort */
  }
}
function removePidFile(): void {
  try {
    fs.unlinkSync(pidFilePath());
  } catch {
    /* best effort */
  }
}

function shutdown(signal: string): void {
  log(`received ${signal} — shutting down`);
  removePidFile();
  try {
    server.close();
  } catch {
    /* ignore */
  }
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

ensureDir();
server.listen(PORT, ELEVATED_HOST, () => {
  writePidFile();
  log(`elevated worker listening on ${ELEVATED_HOST}:${PORT} pid=${process.pid} integrity=${detectIntegrity()}`);
  // Started only once the port is ours: the worker is single-instance by that bind, so exactly
  // one watchdog runs per machine.
  setInterval(() => { void watchdogTick(); }, WATCHDOG_INTERVAL_MS);
  log(`watchdog: watching Core :${WATCHDOG_PORT} every ${WATCHDOG_INTERVAL_MS / 1000}s via ${WATCHDOG_PIDFILE} `
    + `(off: LM_CORE_WATCHDOG=0 or create ${WATCHDOG_OFF_FLAG})`);
});
