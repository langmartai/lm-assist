/**
 * Developer Mode Routes
 *
 * Endpoints for managing developer mode (running lm-assist from a cloned git repo
 * instead of the npm package) and npm package version management.
 *
 * Endpoints:
 *   GET  /dev-mode/status              Get comprehensive dev mode status
 *   POST /dev-mode/clone               Clone the lm-assist repo
 *   POST /dev-mode/build               Build the cloned repo (npm install + build:core + build:web)
 *   POST /dev-mode/pull                Pull latest + rebuild
 *   POST /dev-mode/npm-update          Run npm update -g lm-assist
 *   GET  /dev-mode/npm-version         Get installed npm package version
 *   GET  /dev-mode/operation/:id       Get operation log/status by id
 *   GET  /dev-mode/check-update        Check for newer npm version
 *   POST /dev-mode/upgrade             Spawn detached upgrade script
 *   GET  /dev-mode/upgrade-log         Read upgrade log file
 */

import type { RouteHandler, RouteContext } from '../index';
import { spawn, execFileSync } from '../../utils/exec';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as crypto from 'crypto';

const CLAUDE_SETTINGS_FILE = path.join(os.homedir(), '.claude', 'settings.json');
const INSTALLED_PLUGINS_FILE = path.join(os.homedir(), '.claude', 'plugins', 'installed_plugins.json');
const PLUGIN_NAME = 'lm-assist@langmartai';

// ============================================================================
// Config
// ============================================================================

const CLAUDE_CODE_CONFIG_FILE = path.join(os.homedir(), '.claude-code-config.json');

function loadConfig(): Record<string, any> {
  try {
    return JSON.parse(fs.readFileSync(CLAUDE_CODE_CONFIG_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

function getDevRepoPath(): string {
  const config = loadConfig();
  return config.devRepoPath || path.join(os.homedir(), 'lm-assist');
}

// ============================================================================
// Active Operation Tracking
// ============================================================================

let activeOperation: {
  id: string;
  type: string;
  process: import('child_process').ChildProcess | null;
} | null = null;

// ============================================================================
// Operation Log Storage
// ============================================================================

interface OperationLog {
  type: string;
  lines: string[];
  complete: boolean;
  success: boolean | null;
  startedAt: number;
}

const operationLogs = new Map<string, OperationLog>();

/**
 * Clean up operation logs older than 10 minutes
 */
function cleanupOldLogs(): void {
  const tenMinutesAgo = Date.now() - 10 * 60 * 1000;
  for (const [id, log] of operationLogs) {
    if (log.startedAt < tenMinutesAgo) {
      operationLogs.delete(id);
    }
  }
}

// ============================================================================
// Operation Runner
// ============================================================================

function runOperation(
  id: string,
  type: string,
  command: string,
  args: string[],
  options?: { cwd?: string },
): void {
  const log: OperationLog = {
    type,
    lines: [],
    complete: false,
    success: null,
    startedAt: Date.now(),
  };
  operationLogs.set(id, log);

  const proc = spawn(command, args, {
    cwd: options?.cwd,
    env: process.env,
  });

  activeOperation = { id, type, process: proc };

  const handleData = (data: Buffer) => {
    const text = data.toString();
    for (const line of text.split('\n')) {
      if (line.trim()) {
        log.lines.push(line);
      }
    }
  };

  proc.stdout?.on('data', handleData);
  proc.stderr?.on('data', handleData);

  proc.on('close', (code) => {
    log.complete = true;
    log.success = code === 0;
    if (activeOperation?.id === id) {
      activeOperation = null;
    }
  });

  proc.on('error', (err) => {
    log.lines.push(`Error: ${err.message}`);
    log.complete = true;
    log.success = false;
    if (activeOperation?.id === id) {
      activeOperation = null;
    }
  });
}

// ============================================================================
// npm Version Cache
// ============================================================================

let npmVersionCache: { version: string | null; fetchedAt: number } | null = null;
let updateCheckCache: { currentVersion: string | null; latestVersion: string | null; updateAvailable: boolean; fetchedAt: number } | null = null;

const UPGRADE_LOG_FILE = path.join(os.homedir(), '.cache', 'lm-assist', 'upgrade.log');

function getNpmVersion(): string | null {
  const now = Date.now();
  if (npmVersionCache && now - npmVersionCache.fetchedAt < 60_000) {
    return npmVersionCache.version;
  }

  try {
    const output = execFileSync('npm', ['list', '-g', 'lm-assist', '--json'], {
      encoding: 'utf-8',
      timeout: 15_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const parsed = JSON.parse(output);
    const version = parsed?.dependencies?.['lm-assist']?.version ?? null;
    npmVersionCache = { version, fetchedAt: now };
    return version;
  } catch {
    npmVersionCache = { version: null, fetchedAt: now };
    return null;
  }
}

// ============================================================================
// Git Helpers
// ============================================================================

function gitExec(args: string[], cwd: string): string | null {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf-8',
      timeout: 10_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return null;
  }
}

// ============================================================================
// Component Location Helpers
// ============================================================================

function readClaudeSettings(): Record<string, any> {
  try {
    return JSON.parse(fs.readFileSync(CLAUDE_SETTINGS_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

function classifySource(filePath: string, devRepoPath: string): 'dev-repo' | 'npm' | 'plugin' | 'unknown' {
  if (filePath.includes(devRepoPath)) return 'dev-repo';
  if (filePath.includes('node_modules/lm-assist') || filePath.includes('node_modules\\lm-assist')) return 'npm';
  if (filePath.includes('CLAUDE_PLUGIN_ROOT') || filePath.includes('.claude/plugins')) return 'plugin';
  return 'unknown';
}

interface ComponentInfo {
  path: string;
  source: 'dev-repo' | 'npm' | 'plugin' | 'unknown';
  installed?: boolean;
}

function resolveComponents(serverRoot: string, runningFrom: string, repoPath: string): Record<string, ComponentInfo> {
  const settings = readClaudeSettings();
  const pluginInfo = detectPlugin();

  // --- core ---
  const corePath = path.join(serverRoot, 'core', 'dist', 'cli.js');
  const core: ComponentInfo = { path: corePath, source: runningFrom as any };

  // --- web ---
  const webPath = path.join(serverRoot, 'web');
  const web: ComponentInfo = { path: webPath, source: runningFrom as any };

  // --- statusline ---
  const statusLineCmd = settings?.statusLine?.command;
  let statusline: ComponentInfo;
  if (statusLineCmd && typeof statusLineCmd === 'string' &&
      (statusLineCmd.includes('statusline-worktree.sh') || statusLineCmd.includes('statusline-worktree.js'))) {
    statusline = { path: statusLineCmd, source: classifySource(statusLineCmd, repoPath), installed: true };
  } else {
    statusline = { path: '', source: 'unknown', installed: false };
  }

  // --- hook ---
  // Check settings.json manual hook first (this is what actually runs),
  // then fall back to plugin hook detection
  let hook: ComponentInfo = { path: '', source: 'unknown', installed: false };

  const settingsHooks = settings?.hooks || {};
  const settingsUserPromptHooks: any[] = settingsHooks.UserPromptSubmit || [];
  for (const entry of settingsUserPromptHooks) {
    for (const h of (entry.hooks || [])) {
      if (typeof h.command === 'string' &&
          (h.command.includes('context-inject-hook.sh') || h.command.includes('context-inject-hook.js'))) {
        hook = { path: h.command, source: classifySource(h.command, repoPath), installed: true };
        break;
      }
    }
    if (hook.installed) break;
  }

  // Fallback: check plugin hook
  if (!hook.installed && pluginInfo) {
    const hooksJsonPath = path.join(pluginInfo.installPath, 'hooks', 'hooks.json');
    try {
      const data = JSON.parse(fs.readFileSync(hooksJsonPath, 'utf-8'));
      const pluginHooks: any[] = data?.hooks?.UserPromptSubmit || [];
      const hasHook = pluginHooks.some((entry: any) =>
        (entry.hooks || []).some((h: any) =>
          typeof h.command === 'string' && h.command.includes('context-inject-hook.js')
        )
      );
      if (hasHook) {
        hook = { path: `node "\${CLAUDE_PLUGIN_ROOT}/core/hooks/context-inject-hook.js"`, source: 'plugin', installed: true };
      }
    } catch {}
  }

  // --- mcp ---
  // Check plugin .mcp.json first (actual path), then manual `claude mcp get`
  let mcp: ComponentInfo = { path: '', source: 'unknown', installed: false };

  if (pluginInfo) {
    try {
      const mcpJsonPath = path.join(pluginInfo.installPath, '.mcp.json');
      const data = JSON.parse(fs.readFileSync(mcpJsonPath, 'utf-8'));
      const server = data?.mcpServers?.['lm-assist'];
      if (server) {
        const args = Array.isArray(server.args) ? server.args.join(' ') : (server.args || '');
        const mcpPath = args || server.command || '';
        mcp = { path: mcpPath, source: classifySource(mcpPath, repoPath), installed: true };
      }
    } catch {}
  }

  if (!mcp.installed) {
    const env = { ...process.env, CLAUDECODE: undefined };
    for (const name of ['lm-assist', 'lm-assist-context']) {
      try {
        const output = execFileSync('claude', ['mcp', 'get', name], {
          encoding: 'utf-8', timeout: 10000, env, stdio: ['pipe', 'pipe', 'pipe'],
        }).trim();
        if (!output) continue;
        const argsMatch = output.match(/args:\s*(.+)/i);
        const mcpPath = argsMatch?.[1]?.trim() || '';
        mcp = { path: mcpPath, source: classifySource(mcpPath, repoPath), installed: true };
        break;
      } catch {}
    }
  }

  return { core, web, mcp, hook, statusline };
}

function detectPlugin(): { installPath: string; version: string } | null {
  try {
    const raw = fs.readFileSync(INSTALLED_PLUGINS_FILE, 'utf-8');
    const data = JSON.parse(raw);
    const entries = data?.plugins?.[PLUGIN_NAME];
    if (!Array.isArray(entries) || entries.length === 0) return null;
    const entry = entries[entries.length - 1];
    if (!entry?.installPath) return null;
    const settings = readClaudeSettings();
    if (settings?.enabledPlugins?.[PLUGIN_NAME] !== true) return null;
    return { installPath: entry.installPath, version: entry.version || 'unknown' };
  } catch {
    return null;
  }
}

// ============================================================================
// Routes
// ============================================================================

export function createDevModeRoutes(_ctx: RouteContext): RouteHandler[] {
  return [
    // GET /dev-mode/status - Get comprehensive dev mode status
    {
      method: 'GET',
      pattern: /^\/dev-mode\/status$/,
      handler: async () => {
        const config = loadConfig();
        const repoPath = config.devRepoPath || path.join(os.homedir(), 'lm-assist');
        const repoExists = fs.existsSync(repoPath);

        let repoBranch: string | null = null;
        let repoCommit: string | null = null;
        let repoDirty = false;

        if (repoExists) {
          repoBranch = gitExec(['rev-parse', '--abbrev-ref', 'HEAD'], repoPath);
          repoCommit = gitExec(['rev-parse', '--short', 'HEAD'], repoPath);
          const porcelain = gitExec(['status', '--porcelain'], repoPath);
          repoDirty = !!porcelain && porcelain.length > 0;
        }

        const coreBuilt = repoExists && fs.existsSync(path.join(repoPath, 'core', 'dist', 'cli.js'));
        const webBuilt = repoExists && fs.existsSync(path.join(repoPath, 'web', '.next'));

        // Determine if the running server is from a dev repo or npm
        const serverRoot = path.resolve(__dirname, '../../../..');
        const runningFrom = fs.existsSync(path.join(serverRoot, '.git')) ? 'dev-repo' : 'npm';

        // If running from a dev repo, dev mode is implicitly enabled
        const enabled = runningFrom === 'dev-repo' || !!config.devModeEnabled;

        const npmVersion = getNpmVersion();

        let repoVersion: string | null = null;
        if (repoExists) {
          try {
            const pkgJson = JSON.parse(
              fs.readFileSync(path.join(repoPath, 'package.json'), 'utf-8'),
            );
            repoVersion = pkgJson.version ?? null;
          } catch {
            repoVersion = null;
          }
        }

        // Resolve component locations
        const components = resolveComponents(serverRoot, runningFrom, repoPath);

        return {
          success: true,
          data: {
            enabled,
            repoPath,
            repoExists,
            repoBranch,
            repoCommit,
            repoDirty,
            coreBuilt,
            webBuilt,
            runningFrom,
            npmVersion,
            repoVersion,
            activeOperation: activeOperation
              ? { id: activeOperation.id, type: activeOperation.type }
              : null,
            components,
          },
        };
      },
    },

    // POST /dev-mode/clone - Clone the lm-assist repo
    {
      method: 'POST',
      pattern: /^\/dev-mode\/clone$/,
      handler: async () => {
        if (activeOperation) {
          return {
            success: false,
            error: {
              code: 'OPERATION_IN_PROGRESS',
              message: `Another operation is already running: ${activeOperation.type} (${activeOperation.id})`,
            },
          };
        }

        const repoPath = getDevRepoPath();

        if (fs.existsSync(repoPath)) {
          return {
            success: false,
            error: {
              code: 'PATH_EXISTS',
              message: `Target path already exists: ${repoPath}`,
            },
          };
        }

        const operationId = crypto.randomUUID();

        runOperation(
          operationId,
          'clone',
          'git',
          ['clone', 'https://github.com/langmartai/lm-assist.git', repoPath],
        );

        return {
          success: true,
          data: { operationId },
        };
      },
    },

    // POST /dev-mode/build - Build the cloned repo
    {
      method: 'POST',
      pattern: /^\/dev-mode\/build$/,
      handler: async () => {
        if (activeOperation) {
          return {
            success: false,
            error: {
              code: 'OPERATION_IN_PROGRESS',
              message: `Another operation is already running: ${activeOperation.type} (${activeOperation.id})`,
            },
          };
        }

        const repoPath = getDevRepoPath();

        if (!fs.existsSync(repoPath)) {
          return {
            success: false,
            error: {
              code: 'REPO_NOT_FOUND',
              message: `Dev repo not found at: ${repoPath}`,
            },
          };
        }

        const operationId = crypto.randomUUID();

        runOperation(
          operationId,
          'build',
          'bash',
          ['-c', 'npm install && npm run build:core && npm run build:web'],
          { cwd: repoPath },
        );

        return {
          success: true,
          data: { operationId },
        };
      },
    },

    // POST /dev-mode/pull - Pull latest and rebuild
    {
      method: 'POST',
      pattern: /^\/dev-mode\/pull$/,
      handler: async () => {
        if (activeOperation) {
          return {
            success: false,
            error: {
              code: 'OPERATION_IN_PROGRESS',
              message: `Another operation is already running: ${activeOperation.type} (${activeOperation.id})`,
            },
          };
        }

        const repoPath = getDevRepoPath();

        if (!fs.existsSync(repoPath)) {
          return {
            success: false,
            error: {
              code: 'REPO_NOT_FOUND',
              message: `Dev repo not found at: ${repoPath}`,
            },
          };
        }

        const operationId = crypto.randomUUID();

        runOperation(
          operationId,
          'pull',
          'bash',
          ['-c', 'git pull origin main && npm install && npm run build:core && npm run build:web'],
          { cwd: repoPath },
        );

        return {
          success: true,
          data: { operationId },
        };
      },
    },

    // POST /dev-mode/npm-update - Install latest npm package version
    {
      method: 'POST',
      pattern: /^\/dev-mode\/npm-update$/,
      handler: async () => {
        if (activeOperation) {
          return {
            success: false,
            error: {
              code: 'OPERATION_IN_PROGRESS',
              message: `Another operation is already running: ${activeOperation.type} (${activeOperation.id})`,
            },
          };
        }

        const operationId = crypto.randomUUID();

        // Invalidate npm version cache so next status check picks up new version
        npmVersionCache = null;

        runOperation(
          operationId,
          'npm-update',
          'npm',
          ['install', '-g', 'lm-assist@latest'],
        );

        return {
          success: true,
          data: { operationId },
        };
      },
    },

    // GET /dev-mode/npm-version - Get installed npm package version
    {
      method: 'GET',
      pattern: /^\/dev-mode\/npm-version$/,
      handler: async () => {
        const version = getNpmVersion();

        return {
          success: true,
          data: { version },
        };
      },
    },

    // GET /dev-mode/operation/:id - Get operation log/status
    {
      method: 'GET',
      pattern: /^\/dev-mode\/operation\/(?<operationId>[^/]+)$/,
      handler: async (req) => {
        cleanupOldLogs();

        const operationId = req.params.operationId;
        if (!operationId) {
          return {
            success: false,
            error: {
              code: 'MISSING_PARAM',
              message: 'Operation ID is required',
            },
          };
        }

        const log = operationLogs.get(operationId);
        if (!log) {
          return {
            success: false,
            error: {
              code: 'NOT_FOUND',
              message: `Operation not found: ${operationId}`,
            },
          };
        }

        return {
          success: true,
          data: {
            operationId,
            type: log.type,
            lines: log.lines,
            complete: log.complete,
            success: log.success,
          },
        };
      },
    },

    // GET /dev-mode/check-update - Check for newer npm version
    {
      method: 'GET',
      pattern: /^\/dev-mode\/check-update$/,
      handler: async () => {
        const now = Date.now();
        // Cache for 5 minutes
        if (updateCheckCache && now - updateCheckCache.fetchedAt < 5 * 60 * 1000) {
          const { currentVersion, latestVersion, updateAvailable } = updateCheckCache;
          return { success: true, data: { currentVersion, latestVersion, updateAvailable } };
        }

        const currentVersion = getNpmVersion();
        let latestVersion: string | null = null;

        try {
          const output = execFileSync('npm', ['view', 'lm-assist', 'version'], {
            encoding: 'utf-8',
            timeout: 15_000,
            stdio: ['pipe', 'pipe', 'pipe'],
          }).trim();
          if (output) latestVersion = output;
        } catch {}

        let updateAvailable = false;
        if (currentVersion && latestVersion && currentVersion !== latestVersion) {
          // Simple semver comparison: split on dots and compare numerically
          const cur = currentVersion.split('.').map(Number);
          const lat = latestVersion.split('.').map(Number);
          for (let i = 0; i < Math.max(cur.length, lat.length); i++) {
            const c = cur[i] || 0;
            const l = lat[i] || 0;
            if (l > c) { updateAvailable = true; break; }
            if (l < c) break;
          }
        }

        const result = { currentVersion, latestVersion, updateAvailable, fetchedAt: now };
        updateCheckCache = result;

        return { success: true, data: { currentVersion, latestVersion, updateAvailable } };
      },
    },

    // POST /dev-mode/upgrade - Spawn detached upgrade script
    {
      method: 'POST',
      pattern: /^\/dev-mode\/upgrade$/,
      handler: async () => {
        if (activeOperation) {
          return {
            success: false,
            error: {
              code: 'OPERATION_IN_PROGRESS',
              message: `Another operation is already running: ${activeOperation.type} (${activeOperation.id})`,
            },
          };
        }

        const upgradeScript = path.resolve(__dirname, '../../../scripts/upgrade.js');
        if (!fs.existsSync(upgradeScript)) {
          return {
            success: false,
            error: {
              code: 'SCRIPT_NOT_FOUND',
              message: `Upgrade script not found at: ${upgradeScript}`,
            },
          };
        }

        // Copy upgrade script to temp so it doesn't hold a file lock on the npm
        // package directory (Windows EBUSY when npm tries to rename core/).
        const tmpScript = path.join(os.tmpdir(), `lm-assist-upgrade-${Date.now()}.js`);
        fs.copyFileSync(upgradeScript, tmpScript);

        // Spawn detached — the script will kill this server process
        const child = spawn(process.execPath, [tmpScript], {
          detached: true,
          stdio: 'ignore',
          env: process.env,
        });
        child.unref();

        // Invalidate caches
        npmVersionCache = null;
        updateCheckCache = null;

        return {
          success: true,
          data: { message: 'Upgrade started', pid: child.pid },
        };
      },
    },

    // GET /dev-mode/upgrade-log - Read upgrade log
    {
      method: 'GET',
      pattern: /^\/dev-mode\/upgrade-log$/,
      handler: async () => {
        let lines: string[] = [];
        let complete = false;

        try {
          const content = fs.readFileSync(UPGRADE_LOG_FILE, 'utf-8');
          lines = content.split('\n').filter((l: string) => l.trim());
          complete = content.includes('upgrade finished');
        } catch {
          // File doesn't exist or can't be read
        }

        return {
          success: true,
          data: { lines, complete },
        };
      },
    },
  ];
}
