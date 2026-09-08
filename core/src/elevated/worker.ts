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
} from './common';

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

    let child: ChildProcess;
    if (shell === 'powershell') {
      child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', fullCmd], {
        cwd,
        windowsHide: true,
      });
    } else {
      child = spawn('cmd.exe', ['/c', fullCmd], { cwd, windowsHide: true });
    }

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
});
