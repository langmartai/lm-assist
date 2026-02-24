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

const DEFAULT_REPO_ROOT = path.resolve(__dirname, '..', '..');

function findNpmPackage(): string | null {
  const nodeDir = path.dirname(process.execPath);
  const candidates = [
    path.join(nodeDir, 'node_modules', 'lm-assist'),
    path.join(nodeDir, '..', 'lib', 'node_modules', 'lm-assist'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, 'core', 'dist', 'cli.js'))) {
      return candidate;
    }
  }
  return null;
}

function getRepoRoot(): string {
  try {
    const cfgPath = path.join(os.homedir(), '.claude-code-config.json');
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));

    // Dev mode ON → use repo
    if (cfg.devModeEnabled && cfg.devRepoPath) {
      const devCli = path.join(cfg.devRepoPath, 'core', 'dist', 'cli.js');
      if (fs.existsSync(devCli)) return cfg.devRepoPath;
    }

    // Dev mode OFF → always prefer npm global package
    if (DEFAULT_REPO_ROOT.includes('node_modules')) {
      return DEFAULT_REPO_ROOT; // Already running from npm global
    }
    return findNpmPackage() || DEFAULT_REPO_ROOT;
  } catch {}
  return DEFAULT_REPO_ROOT;
}

/** Centralized runtime dir for PID files and logs — consistent regardless of npm vs repo */
function getRuntimeDir(): string {
  const dir = path.join(os.homedir(), '.cache', 'lm-assist');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function getCoreDir(): string { return path.join(getRepoRoot(), 'core'); }
function getWebDir(): string { return path.join(getRepoRoot(), 'web'); }
function getCliJs(): string { return path.join(getCoreDir(), 'dist', 'cli.js'); }
function getCorePidFile(): string { return path.join(getRuntimeDir(), 'core.pid'); }
function getWebPidFile(): string { return path.join(getRuntimeDir(), 'web.pid'); }
function getCoreLog(): string { return path.join(getRuntimeDir(), 'core.log'); }
function getWebLog(): string { return path.join(getRuntimeDir(), 'web.log'); }

// ─── Config ──────────────────────────────────────────────────

export interface ServiceConfig {
  apiPort?: number;
  webPort?: number;
  projectPath?: string;
}

function loadEnv(): Record<string, string> {
  const envFile = path.join(getRepoRoot(), '.env');
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
          treeKill(pid, 'SIGKILL', () => resolve());
        } else {
          resolve();
        }
      });
    });
  } catch {
    // tree-kill failed — use process.kill directly (works on Windows unlike taskkill from Git Bash)
    try { process.kill(pid, 'SIGTERM'); } catch { /* already dead */ }
  }
  // Verify the process is actually dead
  if (isPidAlive(pid)) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already dead */ }
  }
}

async function killByPort(port: number): Promise<void> {
  try {
    const fpModule = require('find-process');
    const findProcess = (fpModule.default || fpModule) as (type: string, value: number) => Promise<Array<{ pid: number }>>;
    const list = await findProcess('port', port);
    for (const proc of list) {
      await killByPid(proc.pid);
    }
  } catch {
    // find-process failed — use process.kill with netstat-parsed PIDs on Windows
    if (process.platform === 'win32') {
      killByPortNetstat(port);
    }
  }
}

/** Windows fallback: find PIDs by port using netstat, kill with process.kill */
function killByPortNetstat(port: number): void {
  const { execSync } = require('child_process');
  try {
    const output = execSync(`netstat -ano`, { encoding: 'utf-8', timeout: 5000 });
    const pids = new Set<number>();
    for (const line of output.split('\n')) {
      if (line.includes(`:${port}`) && line.includes('LISTENING')) {
        const parts = line.trim().split(/\s+/);
        const pid = parseInt(parts[parts.length - 1], 10);
        if (pid > 0) pids.add(pid);
      }
    }
    for (const pid of pids) {
      try { process.kill(pid, 'SIGTERM'); } catch { /* ignore */ }
    }
  } catch { /* netstat failed */ }
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
    cwd: cwd || getRepoRoot(),
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
  if (!fs.existsSync(getCliJs())) {
    return { success: false, message: `Core not built. Run: npm run build:core (cli.js not found at ${getCliJs()})` };
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
    [getCliJs(), 'serve', '--port', String(apiPort), '--project', projectPath],
    getCoreLog(),
    forwardEnv,
    getCoreDir(),
  );

  if (child.pid) {
    writePid(getCorePidFile(), child.pid);
  }

  // Poll for health
  const healthy = await waitForHealth(apiPort, 30_000);
  if (healthy) {
    return { success: true, message: `Core API started on port ${apiPort}` };
  }
  return { success: false, message: `Core API did not become healthy within 30s. Check ${getCoreLog()}` };
}

export async function startWeb(config?: ServiceConfig): Promise<{ success: boolean; message: string }> {
  const { webPort } = getConfig(config);

  // Already running?
  if (await checkPort(webPort)) {
    return { success: true, message: `Web already running on port ${webPort}` };
  }

  // Try standalone server first (preferred for npm installs)
  const standaloneServer = path.join(getWebDir(), '.next', 'standalone', 'web', 'server.js');
  const hasStandalone = fs.existsSync(standaloneServer);

  if (!hasStandalone && !fs.existsSync(path.join(getWebDir(), '.next'))) {
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
    const staticSrc = path.join(getWebDir(), '.next', 'static');
    const staticDest = path.join(getWebDir(), '.next', 'standalone', 'web', '.next', 'static');
    if (fs.existsSync(staticSrc) && !fs.existsSync(staticDest)) {
      try {
        fs.mkdirSync(path.dirname(staticDest), { recursive: true });
        // Use junction on Windows (no admin required), symlink elsewhere
        fs.symlinkSync(staticSrc, staticDest, process.platform === 'win32' ? 'junction' : 'dir');
      } catch {
        // May already exist or lack permissions — not fatal
      }
    }
    const publicSrc = path.join(getWebDir(), 'public');
    const publicDest = path.join(getWebDir(), '.next', 'standalone', 'web', 'public');
    if (fs.existsSync(publicSrc) && !fs.existsSync(publicDest)) {
      try {
        fs.symlinkSync(publicSrc, publicDest, process.platform === 'win32' ? 'junction' : 'dir');
      } catch {
        // ignore
      }
    }

    child = spawnDetached(process.execPath, [standaloneServer], getWebLog(), webEnv, getWebDir());
  } else {
    // Fallback: npx next start
    const npxCmd = process.platform === 'win32' ? 'npx.cmd' : 'npx';
    child = spawnDetached(npxCmd, ['next', 'start', '-p', String(webPort)], getWebLog(), webEnv, getWebDir());
  }

  if (child.pid) {
    writePid(getWebPidFile(), child.pid);
  }

  // Poll for port
  const ready = await waitForPort(webPort, 30_000);
  if (ready) {
    return { success: true, message: `Web started on port ${webPort}` };
  }
  return { success: false, message: `Web did not start within 30s. Check ${getWebLog()}` };
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
  const pid = readPid(getCorePidFile());
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

  // Final verification: if port is still open, use taskkill fallback (Windows)
  if (stopped && await checkPort(apiPort) && process.platform === 'win32') {
    killByPortNetstat(apiPort);
    await sleep(1000);
  }

  removePid(getCorePidFile());

  if (stopped) {
    const stillRunning = await checkPort(apiPort);
    if (stillRunning) {
      return { success: false, message: `Core API stop attempted but port ${apiPort} is still in use` };
    }
    return { success: true, message: 'Core API stopped' };
  }
  return { success: true, message: 'Core API was not running' };
}

export async function stopWeb(config?: ServiceConfig): Promise<{ success: boolean; message: string }> {
  const { webPort } = getConfig(config);

  let stopped = false;

  // Kill by PID file
  const pid = readPid(getWebPidFile());
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

  // Final verification: if port is still open, use taskkill fallback (Windows)
  if (stopped && await checkPort(webPort) && process.platform === 'win32') {
    killByPortNetstat(webPort);
    await sleep(1000);
  }

  removePid(getWebPidFile());

  if (stopped) {
    const stillRunning = await checkPort(webPort);
    if (stillRunning) {
      return { success: false, message: `Web stop attempted but port ${webPort} is still in use` };
    }
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
  const corePid = readPid(getCorePidFile());

  const webRunning = await checkPort(webPort);
  const webPid = readPid(getWebPidFile());

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
  return service === 'core' ? getCoreLog() : getWebLog();
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

// ─── Component Info ──────────────────────────────────────────────────

export interface ComponentInfo {
  api: { port: number; url: string; source: string; path: string };
  web: { port: number; url: string; source: string; path: string };
  mcp: { installed: boolean; source: string | null; location: string | null };
  hook: { installed: boolean; source: string | null; location: string | null };
  statusline: { installed: boolean; source: string | null; location: string | null };
}

export function getComponentInfo(config?: ServiceConfig): ComponentInfo {
  const { apiPort, webPort } = getConfig(config);
  const repoRoot = getRepoRoot();
  const settingsFile = path.join(os.homedir(), '.claude', 'settings.json');
  const pluginsFile = path.join(os.homedir(), '.claude', 'plugins', 'installed_plugins.json');

  // Determine source label: "dev-repo" if running from a git repo, "npm" if from node_modules
  const isDevRepo = !repoRoot.includes('node_modules');
  const sourceLabel = isDevRepo ? 'dev-repo' : 'npm';

  // Find plugin install path
  let pluginInstallPath: string | null = null;
  try {
    const pluginsData = JSON.parse(fs.readFileSync(pluginsFile, 'utf-8'));
    const entries = pluginsData?.plugins?.['lm-assist@langmartai'];
    if (Array.isArray(entries) && entries.length > 0) {
      pluginInstallPath = entries[0].installPath || null;
    }
  } catch {}

  // MCP: check plugin .mcp.json, then settings.json
  let mcp: ComponentInfo['mcp'] = { installed: false, source: null, location: null };
  if (pluginInstallPath) {
    try {
      const mcpJson = JSON.parse(fs.readFileSync(path.join(pluginInstallPath, '.mcp.json'), 'utf-8'));
      const srv = mcpJson?.mcpServers?.['lm-assist'];
      if (srv) {
        const args = srv.args || [];
        const mcpPath = args.find((a: string) => a.includes('mcp-server')) || `${srv.command} ${args.join(' ')}`;
        mcp = { installed: true, source: 'plugin', location: mcpPath };
      }
    } catch {}
  }
  if (!mcp.installed) {
    try {
      const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf-8'));
      const mcpEntry = settings?.mcpServers?.['lm-assist'] || settings?.mcpServers?.['lm-assist-context'];
      if (mcpEntry) {
        const args = mcpEntry.args || [];
        const mcpPath = args.find((a: string) => a.includes('mcp-server')) || args.join(' ');
        mcp = { installed: true, source: 'settings', location: mcpPath };
      }
    } catch {}
  }

  // Hook: check plugin hooks/hooks.json, then settings.json
  let hook: ComponentInfo['hook'] = { installed: false, source: null, location: null };
  if (pluginInstallPath) {
    try {
      const hooksJson = JSON.parse(fs.readFileSync(path.join(pluginInstallPath, 'hooks', 'hooks.json'), 'utf-8'));
      const uph = hooksJson?.hooks?.UserPromptSubmit || [];
      for (const entry of uph) {
        const hookCmd = (entry.hooks || []).find((h: any) =>
          typeof h.command === 'string' && h.command.includes('context-inject')
        );
        if (hookCmd) {
          // Resolve ${CLAUDE_PLUGIN_ROOT} to actual path
          const cmd = hookCmd.command.replace('${CLAUDE_PLUGIN_ROOT}', pluginInstallPath);
          hook = { installed: true, source: 'plugin', location: cmd };
          break;
        }
      }
    } catch {}
  }
  if (!hook.installed) {
    try {
      const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf-8'));
      const uph = settings?.hooks?.UserPromptSubmit || [];
      for (const entry of uph) {
        const hookCmd = (entry.hooks || []).find((h: any) =>
          typeof h.command === 'string' && h.command.includes('context-inject')
        );
        if (hookCmd) {
          hook = { installed: true, source: 'settings', location: hookCmd.command };
          break;
        }
      }
    } catch {}
  }

  // Statusline: check settings.json statusLine field
  let statusline: ComponentInfo['statusline'] = { installed: false, source: null, location: null };
  try {
    const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf-8'));
    const sl = settings?.statusLine;
    if (sl && typeof sl.command === 'string' && sl.command.includes('statusline')) {
      // Determine source by checking if path points to dev repo or npm
      const slSource = sl.command.includes('node_modules') ? 'npm' : 'dev-repo';
      statusline = { installed: true, source: slSource, location: sl.command };
    }
  } catch {}

  // Determine source labels for MCP and Hook based on resolved paths
  if (mcp.installed && mcp.location) {
    mcp.source = mcp.location.includes('node_modules') ? 'npm' : 'dev-repo';
  }
  if (hook.installed && hook.location) {
    hook.source = hook.location.includes('node_modules') ? 'npm' : 'dev-repo';
  }

  return {
    api: { port: apiPort, url: `http://localhost:${apiPort}`, source: sourceLabel, path: path.join(repoRoot, 'core', 'dist', 'cli.js') },
    web: { port: webPort, url: `http://localhost:${webPort}`, source: sourceLabel, path: path.join(repoRoot, 'web') },
    mcp,
    hook,
    statusline,
  };
}
