/**
 * Cross-platform Service Manager for lm-assist
 *
 * Pure Node.js replacement for core.sh — works on Windows, macOS, and Linux
 * without requiring bash. Uses existing deps: tree-kill, find-process.
 */

import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as net from 'net';
import * as os from 'os';

// ─── Paths ──────────────────────────────────────────────────

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const CORE_DIR = path.join(REPO_ROOT, 'core');
const WEB_DIR = path.join(REPO_ROOT, 'web');
const CLI_JS = path.join(CORE_DIR, 'dist', 'cli.js');

const CORE_PID_FILE = path.join(CORE_DIR, 'server.pid');
const WEB_PID_FILE = path.join(WEB_DIR, 'web.pid');
const CORE_LOG = path.join(CORE_DIR, 'server.log');
const WEB_LOG = path.join(WEB_DIR, 'web.log');

// ─── Config ──────────────────────────────────────────────────

export interface ServiceConfig {
  apiPort?: number;
  webPort?: number;
  projectPath?: string;
}

function loadEnv(): Record<string, string> {
  const envFile = path.join(REPO_ROOT, '.env');
  const vars: Record<string, string> = {};
  try {
    const content = fs.readFileSync(envFile, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      let val = trimmed.slice(eqIdx + 1).trim();
      // Strip surrounding quotes
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      vars[key] = val;
    }
  } catch {
    // .env is optional
  }
  return vars;
}

function getConfig(cfg?: ServiceConfig) {
  const env = loadEnv();
  return {
    apiPort: cfg?.apiPort || parseInt(process.env.API_PORT || env.API_PORT || '3100', 10),
    webPort: cfg?.webPort || parseInt(process.env.WEB_PORT || env.WEB_PORT || '3848', 10),
    projectPath: cfg?.projectPath || process.env.LM_ASSIST_PROJECT || env.LM_ASSIST_PROJECT || os.homedir(),
  };
}

// ─── Port / Health Utilities ──────────────────────────────────────────────────

function checkPort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    sock.setTimeout(2000);
    sock.once('connect', () => {
      sock.destroy();
      resolve(true);
    });
    sock.once('error', () => {
      sock.destroy();
      resolve(false);
    });
    sock.once('timeout', () => {
      sock.destroy();
      resolve(false);
    });
    sock.connect(port, '127.0.0.1');
  });
}

async function checkHealth(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(3000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function waitForHealth(port: number, timeoutMs: number = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await checkHealth(port)) return true;
    await sleep(2000);
  }
  return false;
}

async function waitForPort(port: number, timeoutMs: number = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await checkPort(port)) return true;
    await sleep(2000);
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── PID Management ──────────────────────────────────────────────────

function readPid(pidFile: string): number | null {
  try {
    const pid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10);
    return isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

function writePid(pidFile: string, pid: number): void {
  fs.mkdirSync(path.dirname(pidFile), { recursive: true });
  fs.writeFileSync(pidFile, String(pid), 'utf-8');
}

function removePid(pidFile: string): void {
  try {
    fs.unlinkSync(pidFile);
  } catch {
    // ignore
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function killByPid(pid: number): Promise<void> {
  try {
    const treeKill = require('tree-kill') as (pid: number, signal?: string, callback?: (err?: Error) => void) => void;
    await new Promise<void>((resolve) => {
      treeKill(pid, 'SIGTERM', (err) => {
        if (err) {
          // Force kill
          treeKill(pid, 'SIGKILL', () => resolve());
        } else {
          resolve();
        }
      });
    });
  } catch {
    // tree-kill failed — try plain process.kill as last resort
    try { process.kill(pid, 'SIGTERM'); } catch { /* already dead */ }
  }
}

async function killByPort(port: number): Promise<void> {
  try {
    const findProcess = require('find-process') as (type: string, value: number) => Promise<Array<{ pid: number }>>;
    const list = await findProcess('port', port);
    const treeKill = require('tree-kill') as (pid: number, signal?: string, callback?: (err?: Error) => void) => void;
    for (const proc of list) {
      await new Promise<void>((resolve) => {
        treeKill(proc.pid, 'SIGTERM', () => resolve());
      });
    }
  } catch {
    // find-process may fail on some platforms; that's ok
  }
}

// ─── Spawn Helpers ──────────────────────────────────────────────────

function spawnDetached(
  command: string,
  args: string[],
  logFile: string,
  env?: Record<string, string>,
  cwd?: string,
): ChildProcess {
  const logFd = fs.openSync(logFile, 'a');
  const child = spawn(command, args, {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    windowsHide: true,
    env: { ...process.env, ...env },
    cwd: cwd || REPO_ROOT,
  });
  child.on('error', () => {}); // prevent unhandled rejection on spawn failure
  child.unref();
  // Close the fd in the parent so we don't hold the file open
  fs.closeSync(logFd);
  return child;
}

// ─── Start Functions ──────────────────────────────────────────────────

export async function startCore(config?: ServiceConfig): Promise<{ success: boolean; message: string }> {
  const { apiPort, projectPath } = getConfig(config);

  // Already running?
  if (await checkHealth(apiPort)) {
    return { success: true, message: `Core API already running on port ${apiPort}` };
  }

  // Check if cli.js exists
  if (!fs.existsSync(CLI_JS)) {
    return { success: false, message: `Core not built. Run: npm run build:core (cli.js not found at ${CLI_JS})` };
  }

  // Build environment variables to forward
  const forwardEnv: Record<string, string> = {};
  const dotenv = loadEnv();
  const envKeys = ['ANTHROPIC_API_KEY', 'TIER_AGENT_HUB_URL', 'TIER_AGENT_API_KEY', 'API_PORT', 'WEB_PORT'];
  for (const key of envKeys) {
    const val = process.env[key] || dotenv[key];
    if (val) forwardEnv[key] = val;
  }
  forwardEnv.API_PORT = String(apiPort);

  const child = spawnDetached(
    process.execPath,
    [CLI_JS, 'serve', '--port', String(apiPort), '--project', projectPath],
    CORE_LOG,
    forwardEnv,
    CORE_DIR,
  );

  if (child.pid) {
    writePid(CORE_PID_FILE, child.pid);
  }

  // Poll for health
  const healthy = await waitForHealth(apiPort, 30_000);
  if (healthy) {
    return { success: true, message: `Core API started on port ${apiPort}` };
  }
  return { success: false, message: `Core API did not become healthy within 30s. Check ${CORE_LOG}` };
}

export async function startWeb(config?: ServiceConfig): Promise<{ success: boolean; message: string }> {
  const { webPort } = getConfig(config);

  // Already running?
  if (await checkPort(webPort)) {
    return { success: true, message: `Web already running on port ${webPort}` };
  }

  // Try standalone server first (preferred for npm installs)
  const standaloneServer = path.join(WEB_DIR, '.next', 'standalone', 'web', 'server.js');
  const hasStandalone = fs.existsSync(standaloneServer);

  if (!hasStandalone && !fs.existsSync(path.join(WEB_DIR, '.next'))) {
    return { success: false, message: `Web not built. Run: npm run build:web (.next not found)` };
  }

  const dotenv = loadEnv();
  const webEnv: Record<string, string> = {
    PORT: String(webPort),
    HOSTNAME: '0.0.0.0',
  };
  // Forward relevant env vars
  for (const key of ['NEXT_PUBLIC_LOCAL_API_PORT', 'GATEWAY_TYPE1_URL']) {
    const val = process.env[key] || dotenv[key];
    if (val) webEnv[key] = val;
  }

  let child: ChildProcess;

  if (hasStandalone) {
    // Link static assets into standalone dir (standalone doesn't bundle them)
    const staticSrc = path.join(WEB_DIR, '.next', 'static');
    const staticDest = path.join(WEB_DIR, '.next', 'standalone', 'web', '.next', 'static');
    if (fs.existsSync(staticSrc) && !fs.existsSync(staticDest)) {
      try {
        fs.mkdirSync(path.dirname(staticDest), { recursive: true });
        // Use junction on Windows (no admin required), symlink elsewhere
        fs.symlinkSync(staticSrc, staticDest, process.platform === 'win32' ? 'junction' : 'dir');
      } catch {
        // May already exist or lack permissions — not fatal
      }
    }
    const publicSrc = path.join(WEB_DIR, 'public');
    const publicDest = path.join(WEB_DIR, '.next', 'standalone', 'web', 'public');
    if (fs.existsSync(publicSrc) && !fs.existsSync(publicDest)) {
      try {
        fs.symlinkSync(publicSrc, publicDest, process.platform === 'win32' ? 'junction' : 'dir');
      } catch {
        // ignore
      }
    }

    child = spawnDetached(process.execPath, [standaloneServer], WEB_LOG, webEnv, WEB_DIR);
  } else {
    // Fallback: npx next start
    const npxCmd = process.platform === 'win32' ? 'npx.cmd' : 'npx';
    child = spawnDetached(npxCmd, ['next', 'start', '-p', String(webPort)], WEB_LOG, webEnv, WEB_DIR);
  }

  if (child.pid) {
    writePid(WEB_PID_FILE, child.pid);
  }

  // Poll for port
  const ready = await waitForPort(webPort, 30_000);
  if (ready) {
    return { success: true, message: `Web started on port ${webPort}` };
  }
  return { success: false, message: `Web did not start within 30s. Check ${WEB_LOG}` };
}

export async function startAll(config?: ServiceConfig): Promise<{ core: { success: boolean; message: string }; web: { success: boolean; message: string } }> {
  const coreResult = await startCore(config);
  const webResult = await startWeb(config);
  return { core: coreResult, web: webResult };
}

// ─── Stop Functions ──────────────────────────────────────────────────

export async function stopCore(config?: ServiceConfig): Promise<{ success: boolean; message: string }> {
  const { apiPort } = getConfig(config);

  let stopped = false;

  // Kill by PID file
  const pid = readPid(CORE_PID_FILE);
  if (pid && isPidAlive(pid)) {
    await killByPid(pid);
    stopped = true;
    await sleep(1000);
  }

  // Kill anything still on the port
  if (await checkPort(apiPort)) {
    await killByPort(apiPort);
    stopped = true;
    await sleep(1000);
  }

  removePid(CORE_PID_FILE);

  if (stopped) {
    return { success: true, message: 'Core API stopped' };
  }
  return { success: true, message: 'Core API was not running' };
}

export async function stopWeb(config?: ServiceConfig): Promise<{ success: boolean; message: string }> {
  const { webPort } = getConfig(config);

  let stopped = false;

  // Kill by PID file
  const pid = readPid(WEB_PID_FILE);
  if (pid && isPidAlive(pid)) {
    await killByPid(pid);
    stopped = true;
    await sleep(1000);
  }

  // Kill anything still on the port
  if (await checkPort(webPort)) {
    await killByPort(webPort);
    stopped = true;
    await sleep(1000);
  }

  removePid(WEB_PID_FILE);

  if (stopped) {
    return { success: true, message: 'Web stopped' };
  }
  return { success: true, message: 'Web was not running' };
}

export async function stopAll(config?: ServiceConfig): Promise<{ core: { success: boolean; message: string }; web: { success: boolean; message: string } }> {
  const webResult = await stopWeb(config);
  const coreResult = await stopCore(config);
  return { core: coreResult, web: webResult };
}

// ─── Status ──────────────────────────────────────────────────

export interface ServiceStatus {
  core: { running: boolean; healthy: boolean; port: number; pid: number | null };
  web: { running: boolean; port: number; pid: number | null };
}

export async function status(config?: ServiceConfig): Promise<ServiceStatus> {
  const { apiPort, webPort } = getConfig(config);

  const coreRunning = await checkPort(apiPort);
  const coreHealthy = coreRunning ? await checkHealth(apiPort) : false;
  const corePid = readPid(CORE_PID_FILE);

  const webRunning = await checkPort(webPort);
  const webPid = readPid(WEB_PID_FILE);

  return {
    core: { running: coreRunning, healthy: coreHealthy, port: apiPort, pid: corePid },
    web: { running: webRunning, port: webPort, pid: webPid },
  };
}

// ─── Restart ──────────────────────────────────────────────────

export async function restartAll(config?: ServiceConfig): Promise<{ core: { success: boolean; message: string }; web: { success: boolean; message: string } }> {
  await stopAll(config);
  await sleep(2000);
  return startAll(config);
}

// ─── Log Helpers ──────────────────────────────────────────────────

export function getLogPath(service: 'core' | 'web'): string {
  return service === 'core' ? CORE_LOG : WEB_LOG;
}

export function readLog(service: 'core' | 'web', lines: number = 100): string {
  const logPath = getLogPath(service);
  try {
    const content = fs.readFileSync(logPath, 'utf-8');
    const allLines = content.split('\n');
    return allLines.slice(-lines).join('\n');
  } catch {
    return `No log found at ${logPath}`;
  }
}
