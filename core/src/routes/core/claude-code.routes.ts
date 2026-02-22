/**
 * Claude Code Routes
 *
 * Endpoints for checking Claude Code installation status, managing configuration,
 * and managing the statusline script.
 *
 * Endpoints:
 *   GET  /claude-code/status                    Check Claude Code installation and binary info
 *   GET  /claude-code/config                    Read Claude Code config (~/.claude-code-config.json)
 *   PUT  /claude-code/config                    Update Claude Code config (partial merge)
 *   GET  /claude-code/statusline                Check statusline script installation
 *   POST /claude-code/statusline/install        Install statusline into ~/.claude/settings.json
 *   POST /claude-code/statusline/uninstall      Remove statusline from ~/.claude/settings.json
 *   GET  /claude-code/mcp                       Check MCP server installation status
 *   POST /claude-code/mcp/install               Install MCP server via claude mcp add
 *   POST /claude-code/mcp/uninstall             Remove MCP server via claude mcp remove
 *   GET  /claude-code/context-hook              Check context-inject hook installation
 *   POST /claude-code/context-hook/install      Install context-inject hook into ~/.claude/settings.json
 *   POST /claude-code/context-hook/uninstall    Remove context-inject hook from ~/.claude/settings.json
 *   GET  /claude-code/settings                  Read Claude settings (~/.claude/settings.json)
 *   PUT  /claude-code/settings                  Update Claude settings (cleanupPeriodDays)
 */

import type { RouteHandler, RouteContext } from '../index';
import { execFileSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

const IS_WINDOWS = process.platform === 'win32';
const CLAUDE_CODE_CONFIG_FILE = path.join(os.homedir(), '.claude-code-config.json');
const CLAUDE_SETTINGS_FILE = path.join(os.homedir(), '.claude', 'settings.json');
const INSTALLED_PLUGINS_FILE = path.join(os.homedir(), '.claude', 'plugins', 'installed_plugins.json');
// Resolve hook scripts: prefer npm global install, fall back to local repo
function findNpmHookPath(hookName: string): string | null {
  try {
    const npmRoot = execFileSync('npm', ['root', '-g'], { encoding: 'utf-8', timeout: 5000 }).trim();
    const npmPath = path.join(npmRoot, 'lm-assist', 'core', 'hooks', hookName);
    if (fs.existsSync(npmPath)) return npmPath;
  } catch {}
  return null;
}

const STATUSLINE_SCRIPT = path.resolve(__dirname, '../../../hooks/statusline-worktree.sh');
// Cross-platform statusline: Node.js script (works on Windows, macOS, Linux)
const STATUSLINE_SCRIPT_JS = findNpmHookPath('statusline-worktree.js') || path.resolve(__dirname, '../../../hooks/statusline-worktree.js');
const STATUSLINE_COMMAND = `node "${STATUSLINE_SCRIPT_JS}"`;
// Cross-platform hook: Node.js script (works on Windows, macOS, Linux)
const CONTEXT_INJECT_SCRIPT_JS = findNpmHookPath('context-inject-hook.js') || path.resolve(__dirname, '../../../hooks/context-inject-hook.js');
// The install command uses `node <script>` for cross-platform support
const CONTEXT_INJECT_COMMAND = `node "${CONTEXT_INJECT_SCRIPT_JS}"`;

// Plugin name as registered in Claude Code plugin system
const PLUGIN_NAME = 'lm-assist@langmartai';

/**
 * Detect whether lm-assist is installed as a Claude Code plugin.
 * Checks both installed_plugins.json and settings.json enabledPlugins.
 * Returns the plugin install path if found and enabled, null otherwise.
 */
function detectPluginInstallation(): { installPath: string; version: string } | null {
  try {
    // Check installed_plugins.json
    const raw = fs.readFileSync(INSTALLED_PLUGINS_FILE, 'utf-8');
    const data = JSON.parse(raw);
    const entries = data?.plugins?.[PLUGIN_NAME];
    if (!Array.isArray(entries) || entries.length === 0) return null;

    // Get the most recent installation entry
    const entry = entries[entries.length - 1];
    if (!entry?.installPath) return null;

    // Check if the plugin is enabled in settings.json
    const settings = readClaudeSettings();
    const enabled = settings?.enabledPlugins?.[PLUGIN_NAME];
    if (enabled !== true) return null;

    return { installPath: entry.installPath, version: entry.version || 'unknown' };
  } catch {
    return null;
  }
}

/**
 * Check if the plugin has an MCP server registered for lm-assist.
 * Returns the MCP server config (command + args) if found, null otherwise.
 */
function detectPluginMcp(pluginPath: string): { command: string; args: string } | null {
  try {
    const mcpJsonPath = path.join(pluginPath, '.mcp.json');
    const raw = fs.readFileSync(mcpJsonPath, 'utf-8');
    const data = JSON.parse(raw);
    const server = data?.mcpServers?.['lm-assist'];
    if (!server) return null;
    const command = server.command || 'node';
    const args = Array.isArray(server.args) ? server.args.join(' ') : (server.args || '');
    return { command, args };
  } catch {
    return null;
  }
}

/**
 * Find the npm-installed lm-assist MCP server path.
 * Looks for the globally-installed npm package first, then falls back to local repo.
 */
function findMcpServerPath(): string {
  // 1. Try npm global: resolve lm-assist package → core/dist/mcp-server/index.js
  try {
    const npmRoot = require('child_process').execFileSync('npm', ['root', '-g'], {
      encoding: 'utf-8', timeout: 5000,
    }).trim();
    const npmMcpPath = path.join(npmRoot, 'lm-assist', 'core', 'dist', 'mcp-server', 'index.js');
    if (fs.existsSync(npmMcpPath)) return npmMcpPath;
  } catch {}
  // 2. Fallback: local repo build output
  return path.resolve(__dirname, '../../dist/mcp-server/index.js');
}

/**
 * Check if the plugin has a context-inject hook registered.
 */
function detectPluginHook(pluginPath: string): boolean {
  try {
    const hooksJsonPath = path.join(pluginPath, 'hooks', 'hooks.json');
    const raw = fs.readFileSync(hooksJsonPath, 'utf-8');
    const data = JSON.parse(raw);
    const userPromptHooks: any[] = data?.hooks?.UserPromptSubmit || [];
    return userPromptHooks.some((entry: any) =>
      (entry.hooks || []).some((h: any) =>
        typeof h.command === 'string' && h.command.includes('context-inject-hook.js')
      )
    );
  } catch {
    return false;
  }
}

/**
 * Cross-platform: find an executable binary path.
 * Uses 'where' on Windows, 'which' on macOS/Linux.
 */
function findBinaryPath(name: string): string | null {
  try {
    const cmd = IS_WINDOWS ? 'where' : 'which';
    const output = execFileSync(cmd, [name], { encoding: 'utf-8', timeout: 5000 }).trim();
    // 'where' on Windows may return multiple lines; take the first
    return output.split(/\r?\n/)[0].trim() || null;
  } catch {
    return null;
  }
}

/**
 * Cross-platform: determine if a binary path points to claude-native.
 */
function detectBinaryType(binaryPath: string): 'claude' | 'claude-native' {
  // On Windows, just check the filename
  if (IS_WINDOWS) {
    const basename = path.basename(binaryPath).toLowerCase();
    return basename.includes('claude-native') ? 'claude-native' : 'claude';
  }
  // On Unix, resolve symlinks
  try {
    const resolved = fs.realpathSync(binaryPath);
    return resolved.includes('claude-native') ? 'claude-native' : 'claude';
  } catch {
    return 'claude';
  }
}

interface ClaudeCodeConfig {
  skipDangerPermission: boolean;
  enableChrome: boolean;
  contextInjectDisplay: boolean;
  contextInjectMode: 'mcp' | 'suggest' | 'both' | 'off';
  contextInjectKnowledge: boolean;
  contextInjectMilestones: boolean;
  contextInjectKnowledgeCount: number;
  contextInjectMilestoneCount: number;
  searchIncludeKnowledge: boolean;
  searchIncludeMilestones: boolean;
  statuslinePromptCount: number;
  statuslineShowPrompts: boolean;
  statuslineShowWorktree: boolean;
  statuslineShowContext: boolean;
  statuslineShowRam: boolean;
  statuslineShowProcess: boolean;
  statuslineShowModel: boolean;
}

const DEFAULT_CONFIG: ClaudeCodeConfig = {
  skipDangerPermission: false,
  enableChrome: true,
  contextInjectDisplay: true,
  contextInjectMode: 'mcp',
  contextInjectKnowledge: true,
  contextInjectMilestones: false,
  contextInjectKnowledgeCount: 3,
  contextInjectMilestoneCount: 2,
  searchIncludeKnowledge: true,
  searchIncludeMilestones: false,
  statuslinePromptCount: 4,
  statuslineShowPrompts: true,
  statuslineShowWorktree: true,
  statuslineShowContext: true,
  statuslineShowRam: true,
  statuslineShowProcess: true,
  statuslineShowModel: true,
};

function loadConfig(): ClaudeCodeConfig {
  try {
    const raw = fs.readFileSync(CLAUDE_CODE_CONFIG_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    const validModes = ['mcp', 'suggest', 'both', 'off'];
    return {
      skipDangerPermission: typeof parsed.skipDangerPermission === 'boolean' ? parsed.skipDangerPermission : DEFAULT_CONFIG.skipDangerPermission,
      enableChrome: typeof parsed.enableChrome === 'boolean' ? parsed.enableChrome : DEFAULT_CONFIG.enableChrome,
      contextInjectDisplay: typeof parsed.contextInjectDisplay === 'boolean' ? parsed.contextInjectDisplay : DEFAULT_CONFIG.contextInjectDisplay,
      contextInjectMode: validModes.includes(parsed.contextInjectMode) ? parsed.contextInjectMode : DEFAULT_CONFIG.contextInjectMode,
      contextInjectKnowledge: typeof parsed.contextInjectKnowledge === 'boolean' ? parsed.contextInjectKnowledge : DEFAULT_CONFIG.contextInjectKnowledge,
      contextInjectMilestones: typeof parsed.contextInjectMilestones === 'boolean' ? parsed.contextInjectMilestones : DEFAULT_CONFIG.contextInjectMilestones,
      contextInjectKnowledgeCount: typeof parsed.contextInjectKnowledgeCount === 'number' && parsed.contextInjectKnowledgeCount >= 0 ? parsed.contextInjectKnowledgeCount : DEFAULT_CONFIG.contextInjectKnowledgeCount,
      contextInjectMilestoneCount: typeof parsed.contextInjectMilestoneCount === 'number' && parsed.contextInjectMilestoneCount >= 0 ? parsed.contextInjectMilestoneCount : DEFAULT_CONFIG.contextInjectMilestoneCount,
      searchIncludeKnowledge: typeof parsed.searchIncludeKnowledge === 'boolean' ? parsed.searchIncludeKnowledge : DEFAULT_CONFIG.searchIncludeKnowledge,
      searchIncludeMilestones: typeof parsed.searchIncludeMilestones === 'boolean' ? parsed.searchIncludeMilestones : DEFAULT_CONFIG.searchIncludeMilestones,
      statuslinePromptCount: typeof parsed.statuslinePromptCount === 'number' && parsed.statuslinePromptCount >= 0 && parsed.statuslinePromptCount <= 10 ? parsed.statuslinePromptCount : DEFAULT_CONFIG.statuslinePromptCount,
      statuslineShowPrompts: typeof parsed.statuslineShowPrompts === 'boolean' ? parsed.statuslineShowPrompts : DEFAULT_CONFIG.statuslineShowPrompts,
      statuslineShowWorktree: typeof parsed.statuslineShowWorktree === 'boolean' ? parsed.statuslineShowWorktree : DEFAULT_CONFIG.statuslineShowWorktree,
      statuslineShowContext: typeof parsed.statuslineShowContext === 'boolean' ? parsed.statuslineShowContext : DEFAULT_CONFIG.statuslineShowContext,
      statuslineShowRam: typeof parsed.statuslineShowRam === 'boolean' ? parsed.statuslineShowRam : DEFAULT_CONFIG.statuslineShowRam,
      statuslineShowProcess: typeof parsed.statuslineShowProcess === 'boolean' ? parsed.statuslineShowProcess : DEFAULT_CONFIG.statuslineShowProcess,
      statuslineShowModel: typeof parsed.statuslineShowModel === 'boolean' ? parsed.statuslineShowModel : DEFAULT_CONFIG.statuslineShowModel,
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

function saveConfig(config: ClaudeCodeConfig): void {
  fs.writeFileSync(CLAUDE_CODE_CONFIG_FILE, JSON.stringify(config, null, 2) + '\n');
}

function readClaudeSettings(): Record<string, any> {
  try {
    const raw = fs.readFileSync(CLAUDE_SETTINGS_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function writeClaudeSettings(settings: Record<string, any>): void {
  const dir = path.dirname(CLAUDE_SETTINGS_FILE);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(CLAUDE_SETTINGS_FILE, JSON.stringify(settings, null, 2) + '\n');
}

export function createClaudeCodeRoutes(_ctx: RouteContext): RouteHandler[] {
  return [
    // GET /claude-code/status - Detect Claude Code installation (cross-platform)
    {
      method: 'GET',
      pattern: /^\/claude-code\/status$/,
      handler: async () => {
        let installed = false;
        let binaryPath: string | null = null;
        let binaryType: 'claude' | 'claude-native' | null = null;
        let version: string | null = null;

        // Cross-platform binary detection
        binaryPath = findBinaryPath('claude');
        const claudeNativePath = findBinaryPath('claude-native');

        if (binaryPath) {
          installed = true;
          binaryType = detectBinaryType(binaryPath);

          try {
            version = execFileSync(binaryPath, ['--version'], { encoding: 'utf-8', timeout: 10000 }).trim();
          } catch {
            // version check failed
          }
        } else if (claudeNativePath) {
          installed = true;
          binaryPath = claudeNativePath;
          binaryType = 'claude-native';

          try {
            version = execFileSync(claudeNativePath, ['--version'], { encoding: 'utf-8', timeout: 10000 }).trim();
          } catch {
            // version check failed
          }
        }

        return {
          success: true,
          data: { installed, binaryPath, binaryType, version },
        };
      },
    },

    // GET /claude-code/config - Read Claude Code config
    {
      method: 'GET',
      pattern: /^\/claude-code\/config$/,
      handler: async () => {
        const config = loadConfig();
        return { success: true, data: config };
      },
    },

    // PUT /claude-code/config - Update Claude Code config (partial merge)
    {
      method: 'PUT',
      pattern: /^\/claude-code\/config$/,
      handler: async (req) => {
        const body = req.body || {};
        const current = loadConfig();
        let changed = false;

        if (typeof body.skipDangerPermission === 'boolean' && body.skipDangerPermission !== current.skipDangerPermission) {
          current.skipDangerPermission = body.skipDangerPermission;
          changed = true;
        }
        if (typeof body.enableChrome === 'boolean' && body.enableChrome !== current.enableChrome) {
          current.enableChrome = body.enableChrome;
          changed = true;
        }
        if (typeof body.contextInjectDisplay === 'boolean' && body.contextInjectDisplay !== current.contextInjectDisplay) {
          current.contextInjectDisplay = body.contextInjectDisplay;
          changed = true;
        }
        const validModes = ['mcp', 'suggest', 'both', 'off'];
        if (typeof body.contextInjectMode === 'string' && validModes.includes(body.contextInjectMode) && body.contextInjectMode !== current.contextInjectMode) {
          current.contextInjectMode = body.contextInjectMode;
          changed = true;
        }
        if (typeof body.contextInjectKnowledge === 'boolean' && body.contextInjectKnowledge !== current.contextInjectKnowledge) {
          current.contextInjectKnowledge = body.contextInjectKnowledge;
          changed = true;
        }
        if (typeof body.contextInjectMilestones === 'boolean' && body.contextInjectMilestones !== current.contextInjectMilestones) {
          current.contextInjectMilestones = body.contextInjectMilestones;
          changed = true;
        }
        if (typeof body.contextInjectKnowledgeCount === 'number' && body.contextInjectKnowledgeCount >= 0 && body.contextInjectKnowledgeCount !== current.contextInjectKnowledgeCount) {
          current.contextInjectKnowledgeCount = body.contextInjectKnowledgeCount;
          changed = true;
        }
        if (typeof body.contextInjectMilestoneCount === 'number' && body.contextInjectMilestoneCount >= 0 && body.contextInjectMilestoneCount !== current.contextInjectMilestoneCount) {
          current.contextInjectMilestoneCount = body.contextInjectMilestoneCount;
          changed = true;
        }
        if (typeof body.searchIncludeKnowledge === 'boolean' && body.searchIncludeKnowledge !== current.searchIncludeKnowledge) {
          current.searchIncludeKnowledge = body.searchIncludeKnowledge;
          changed = true;
        }
        if (typeof body.searchIncludeMilestones === 'boolean' && body.searchIncludeMilestones !== current.searchIncludeMilestones) {
          current.searchIncludeMilestones = body.searchIncludeMilestones;
          changed = true;
        }
        if (typeof body.statuslinePromptCount === 'number' && body.statuslinePromptCount >= 0 && body.statuslinePromptCount <= 10 && body.statuslinePromptCount !== current.statuslinePromptCount) {
          current.statuslinePromptCount = body.statuslinePromptCount;
          changed = true;
        }
        const slBooleans: (keyof ClaudeCodeConfig)[] = ['statuslineShowPrompts', 'statuslineShowWorktree', 'statuslineShowContext', 'statuslineShowRam', 'statuslineShowProcess', 'statuslineShowModel'];
        for (const key of slBooleans) {
          if (typeof body[key] === 'boolean' && body[key] !== current[key]) {
            (current as any)[key] = body[key];
            changed = true;
          }
        }

        if (changed) {
          saveConfig(current);
        }

        return { success: true, data: current };
      },
    },

    // GET /claude-code/statusline - Check statusline script installation
    {
      method: 'GET',
      pattern: /^\/claude-code\/statusline$/,
      handler: async () => {
        const settings = readClaudeSettings();
        const statusLine = settings.statusLine;
        const installed = !!(
          statusLine &&
          typeof statusLine.command === 'string' &&
          (statusLine.command.includes('statusline-worktree.sh') ||
           statusLine.command.includes('statusline-worktree.js'))
        );

        const scriptPath = installed ? statusLine.command : STATUSLINE_COMMAND;

        const features = [
          'Last 4 prompts',
          'Project dir',
          'Worktree detection',
          'Context %',
          'Session RAM',
          'Free RAM',
          'PID',
          'TTY',
          'Uptime',
          'Model name',
        ];

        return {
          success: true,
          data: { installed, scriptPath, features },
        };
      },
    },

    // POST /claude-code/statusline/install - Install statusline into settings.json
    {
      method: 'POST',
      pattern: /^\/claude-code\/statusline\/install$/,
      handler: async () => {
        const settings = readClaudeSettings();

        // Deep merge: preserve other keys, set statusLine (cross-platform JS version)
        settings.statusLine = {
          type: 'command',
          command: STATUSLINE_COMMAND,
          padding: 2,
        };

        writeClaudeSettings(settings);

        return {
          success: true,
          data: {
            installed: true,
            scriptPath: STATUSLINE_COMMAND,
            features: [
              'Last 4 prompts', 'Project dir', 'Worktree detection',
              'Context %', 'Session RAM', 'Free RAM', 'PID', 'TTY', 'Uptime', 'Model name',
            ],
          },
        };
      },
    },

    // POST /claude-code/statusline/uninstall - Remove statusline from settings.json
    {
      method: 'POST',
      pattern: /^\/claude-code\/statusline\/uninstall$/,
      handler: async () => {
        const settings = readClaudeSettings();

        delete settings.statusLine;

        writeClaudeSettings(settings);

        return {
          success: true,
          data: {
            installed: false,
            scriptPath: null,
            features: [],
          },
        };
      },
    },

    // GET /claude-code/mcp - Check MCP server installation status
    // Detects both plugin-installed and manually-installed MCP servers
    {
      method: 'GET',
      pattern: /^\/claude-code\/mcp$/,
      handler: async () => {
        // 1. Check plugin-based installation first (cross-platform, no CLI needed)
        const plugin = detectPluginInstallation();
        const pluginMcp = plugin ? detectPluginMcp(plugin.installPath) : null;
        if (pluginMcp) {
          return {
            success: true,
            data: {
              installed: true,
              source: 'plugin',
              scope: 'plugin',
              status: 'active',
              command: pluginMcp.command,
              args: pluginMcp.args,
              tools: ['search', 'detail', 'feedback'],
            },
          };
        }

        // 2. Fallback: check manual installation via `claude mcp get`
        // Try current name first, then legacy name for migration detection
        const env = { ...process.env, CLAUDECODE: undefined };
        for (const name of ['lm-assist', 'lm-assist-context']) {
          try {
            const output = execFileSync('claude', ['mcp', 'get', name], {
              encoding: 'utf-8',
              timeout: 10000,
              env,
            }).trim();

            if (!output) continue;

            // Parse the key: value lines from `claude mcp get` output
            const scopeMatch = output.match(/scope:\s*(.+)/i);
            const statusMatch = output.match(/status:\s*(.+)/i);
            const commandMatch = output.match(/command:\s*(.+)/i);
            const argsMatch = output.match(/args:\s*(.+)/i);

            // Determine connected status from the status line (e.g. "✓ Connected")
            const statusRaw = statusMatch?.[1]?.trim() || '';
            const isConnected = statusRaw.includes('Connected') || statusRaw.includes('✓');

            return {
              success: true,
              data: {
                installed: true,
                source: 'manual',
                registeredName: name,
                needsRename: name !== 'lm-assist',
                scope: scopeMatch?.[1]?.trim() || 'user',
                status: isConnected ? 'connected' : statusRaw,
                command: commandMatch?.[1]?.trim() || null,
                args: argsMatch?.[1]?.trim() || null,
                tools: ['search', 'detail', 'feedback'],
              },
            };
          } catch {
            // Not found under this name, try next
          }
        }

        return {
          success: true,
          data: { installed: false, source: null },
        };
      },
    },

    // POST /claude-code/mcp/install - Install MCP server (plugin .mcp.json or manual claude mcp add)
    {
      method: 'POST',
      pattern: /^\/claude-code\/mcp\/install$/,
      handler: async () => {
        const plugin = detectPluginInstallation();

        // If plugin is installed, ensure .mcp.json exists with correct MCP server path
        if (plugin) {
          const pluginMcp = detectPluginMcp(plugin.installPath);
          if (pluginMcp) {
            return {
              success: true,
              data: {
                installed: true,
                source: 'plugin',
                status: 'active',
                tools: ['search', 'detail', 'feedback'],
              },
            };
          }

          // Plugin installed but .mcp.json missing — create it with npm package path
          try {
            const mcpServerPath = findMcpServerPath();
            const mcpJson = {
              mcpServers: {
                'lm-assist': {
                  command: 'node',
                  args: [mcpServerPath],
                },
              },
            };
            const mcpJsonPath = path.join(plugin.installPath, '.mcp.json');
            fs.writeFileSync(mcpJsonPath, JSON.stringify(mcpJson, null, 2) + '\n');

            return {
              success: true,
              data: {
                installed: true,
                source: 'plugin',
                status: 'active',
                command: 'node',
                args: mcpServerPath,
                tools: ['search', 'detail', 'feedback'],
              },
            };
          } catch (err: any) {
            return {
              success: false,
              error: `Failed to create plugin .mcp.json: ${err.message || err}`,
            };
          }
        }

        // No plugin — fall back to manual `claude mcp add`
        const env = { ...process.env, CLAUDECODE: undefined };
        const mcpServerPath = findMcpServerPath();

        try {
          // Remove legacy names if present (renamed: tier-agent-context → lm-assist-context → lm-assist)
          for (const legacyName of ['tier-agent-context', 'lm-assist-context']) {
            try {
              execFileSync('claude', ['mcp', 'remove', legacyName, '-s', 'user'], {
                encoding: 'utf-8',
                timeout: 10000,
                env,
              });
            } catch {
              // Ignore — old name may not exist
            }
          }

          execFileSync('claude', [
            'mcp', 'add', '-s', 'user', 'lm-assist', '--',
            'node', mcpServerPath,
          ], {
            encoding: 'utf-8',
            timeout: 15000,
            env,
          });

          return {
            success: true,
            data: {
              installed: true,
              source: 'manual',
              status: 'connected',
              tools: ['search', 'detail', 'feedback'],
            },
          };
        } catch (err: any) {
          return {
            success: false,
            error: err.message || 'Failed to install MCP server',
          };
        }
      },
    },

    // POST /claude-code/mcp/uninstall - Remove MCP server (manual installs only)
    {
      method: 'POST',
      pattern: /^\/claude-code\/mcp\/uninstall$/,
      handler: async () => {
        // Refuse to uninstall plugin-managed MCP
        const plugin = detectPluginInstallation();
        if (plugin && detectPluginMcp(plugin.installPath)) {
          return {
            success: false,
            error: 'MCP server is managed by the lm-assist plugin. Use "claude plugin uninstall lm-assist" to remove it.',
          };
        }

        const env = { ...process.env, CLAUDECODE: undefined };
        try {
          execFileSync('claude', ['mcp', 'remove', 'lm-assist', '-s', 'user'], {
            encoding: 'utf-8',
            timeout: 10000,
            env,
          });

          return {
            success: true,
            data: { installed: false, source: null },
          };
        } catch (err: any) {
          return {
            success: false,
            error: err.message || 'Failed to remove MCP server',
          };
        }
      },
    },

    // GET /claude-code/context-hook - Check context-inject hook installation
    // Detects both plugin-installed and manually-installed hooks
    {
      method: 'GET',
      pattern: /^\/claude-code\/context-hook$/,
      handler: async () => {
        // 1. Check plugin-based installation first (cross-platform, no CLI needed)
        const plugin = detectPluginInstallation();
        if (plugin && detectPluginHook(plugin.installPath)) {
          return {
            success: true,
            data: {
              installed: true,
              source: 'plugin',
              scriptPath: path.join(plugin.installPath, 'core', 'hooks', 'context-inject-hook.js'),
              command: `node "\${CLAUDE_PLUGIN_ROOT}/core/hooks/context-inject-hook.js"`,
            },
          };
        }

        // 2. Fallback: check manual installation in settings.json
        const settings = readClaudeSettings();
        const hooks = settings.hooks || {};
        const userPromptHooks: any[] = hooks.UserPromptSubmit || [];
        // Detect both legacy .sh and cross-platform .js versions
        const installed = userPromptHooks.some((entry: any) =>
          (entry.hooks || []).some((h: any) =>
            typeof h.command === 'string' && (
              h.command.includes('context-inject-hook.sh') ||
              h.command.includes('context-inject-hook.js')
            )
          )
        );
        return {
          success: true,
          data: {
            installed,
            source: installed ? 'manual' : null,
            scriptPath: CONTEXT_INJECT_SCRIPT_JS,
            command: CONTEXT_INJECT_COMMAND,
          },
        };
      },
    },

    // POST /claude-code/context-hook/install - Install context-inject hook (manual, skipped if plugin-managed)
    {
      method: 'POST',
      pattern: /^\/claude-code\/context-hook\/install$/,
      handler: async () => {
        // Skip if already installed via plugin
        const plugin = detectPluginInstallation();
        if (plugin && detectPluginHook(plugin.installPath)) {
          return {
            success: true,
            data: {
              installed: true,
              source: 'plugin',
              scriptPath: path.join(plugin.installPath, 'core', 'hooks', 'context-inject-hook.js'),
              command: `node "\${CLAUDE_PLUGIN_ROOT}/core/hooks/context-inject-hook.js"`,
            },
          };
        }

        const settings = readClaudeSettings();
        if (!settings.hooks) settings.hooks = {};
        let existingHooks: any[] = settings.hooks.UserPromptSubmit || [];

        // Check if already installed (either .sh or .js version) to avoid duplicates
        const alreadyInstalled = existingHooks.some((entry: any) =>
          (entry.hooks || []).some((h: any) =>
            typeof h.command === 'string' && (
              h.command.includes('context-inject-hook.sh') ||
              h.command.includes('context-inject-hook.js')
            )
          )
        );

        if (!alreadyInstalled) {
          // Install cross-platform Node.js hook
          existingHooks.push({
            hooks: [{ type: 'command', command: CONTEXT_INJECT_COMMAND, timeout: 10 }],
          });
          settings.hooks.UserPromptSubmit = existingHooks;
          writeClaudeSettings(settings);
        } else {
          // Upgrade legacy .sh to cross-platform .js if needed
          const hasLegacySh = existingHooks.some((entry: any) =>
            (entry.hooks || []).some((h: any) =>
              typeof h.command === 'string' &&
              h.command.includes('context-inject-hook.sh') &&
              !h.command.includes('context-inject-hook.js')
            )
          );
          if (hasLegacySh) {
            existingHooks = existingHooks.map((entry: any) => ({
              ...entry,
              hooks: (entry.hooks || []).map((h: any) => {
                if (typeof h.command === 'string' && h.command.includes('context-inject-hook.sh')) {
                  return { ...h, command: CONTEXT_INJECT_COMMAND };
                }
                return h;
              }),
            }));
            settings.hooks.UserPromptSubmit = existingHooks;
            writeClaudeSettings(settings);
          }
        }

        return {
          success: true,
          data: { installed: true, source: 'manual', scriptPath: CONTEXT_INJECT_SCRIPT_JS, command: CONTEXT_INJECT_COMMAND },
        };
      },
    },

    // POST /claude-code/context-hook/uninstall - Remove context-inject hook from settings.json (manual installs only)
    {
      method: 'POST',
      pattern: /^\/claude-code\/context-hook\/uninstall$/,
      handler: async () => {
        // Refuse to uninstall plugin-managed hook
        const plugin = detectPluginInstallation();
        if (plugin && detectPluginHook(plugin.installPath)) {
          return {
            success: false,
            error: 'Context hook is managed by the lm-assist plugin. Use "claude plugin uninstall lm-assist" to remove it.',
          };
        }

        const settings = readClaudeSettings();
        if (!settings.hooks?.UserPromptSubmit) {
          return { success: true, data: { installed: false, source: null, scriptPath: null } };
        }

        // Remove both legacy .sh and cross-platform .js versions
        settings.hooks.UserPromptSubmit = (settings.hooks.UserPromptSubmit as any[]).map((entry: any) => ({
          ...entry,
          hooks: (entry.hooks || []).filter((h: any) =>
            !(typeof h.command === 'string' && (
              h.command.includes('context-inject-hook.sh') ||
              h.command.includes('context-inject-hook.js')
            ))
          ),
        })).filter((entry: any) => (entry.hooks || []).length > 0);

        if (settings.hooks.UserPromptSubmit.length === 0) {
          delete settings.hooks.UserPromptSubmit;
        }
        if (Object.keys(settings.hooks).length === 0) {
          delete settings.hooks;
        }

        writeClaudeSettings(settings);
        return {
          success: true,
          data: { installed: false, source: null, scriptPath: null },
        };
      },
    },

    // GET /claude-code/settings - Read Claude settings
    {
      method: 'GET',
      pattern: /^\/claude-code\/settings$/,
      handler: async () => {
        const settings = readClaudeSettings();
        const env = settings.env || {};
        return {
          success: true,
          data: {
            cleanupPeriodDays: typeof settings.cleanupPeriodDays === 'number' ? settings.cleanupPeriodDays : 30,
            env: {
              CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS === '1',
            },
          },
        };
      },
    },

    // PUT /claude-code/settings - Update Claude settings
    {
      method: 'PUT',
      pattern: /^\/claude-code\/settings$/,
      handler: async (req) => {
        const body = req.body || {};
        const settings = readClaudeSettings();
        let changed = false;

        if (body.cleanupPeriodDays !== undefined) {
          const val = body.cleanupPeriodDays;
          if (typeof val !== 'number' || !Number.isInteger(val) || val < 1) {
            return {
              success: false,
              error: { code: 'INVALID_VALUE', message: 'cleanupPeriodDays must be a positive integer' },
            };
          }
          settings.cleanupPeriodDays = val;
          changed = true;
        }

        if (body.env && typeof body.env === 'object') {
          if (!settings.env) settings.env = {};
          if (typeof body.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS === 'boolean') {
            if (body.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS) {
              settings.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = '1';
            } else {
              delete settings.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS;
            }
            changed = true;
          }
        }

        if (changed) {
          writeClaudeSettings(settings);
        }

        const env = settings.env || {};
        return {
          success: true,
          data: {
            cleanupPeriodDays: typeof settings.cleanupPeriodDays === 'number' ? settings.cleanupPeriodDays : 30,
            env: {
              CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS === '1',
            },
          },
        };
      },
    },
  ];
}
