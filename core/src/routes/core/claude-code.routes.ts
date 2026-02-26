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
 *   GET  /claude-code/ide-mcp/vscode             Check VS Code MCP integration status
 *   POST /claude-code/ide-mcp/vscode/activate    Add lm-assist to VS Code mcp.json
 *   POST /claude-code/ide-mcp/vscode/deactivate  Remove lm-assist from VS Code mcp.json
 *   GET  /claude-code/ide-mcp/codex              Check Codex MCP integration status
 *   POST /claude-code/ide-mcp/codex/activate     Add lm-assist to Codex config.toml
 *   POST /claude-code/ide-mcp/codex/deactivate   Remove lm-assist from Codex config.toml
 *   GET  /claude-code/ide-mcp/antigravity        Check Antigravity MCP integration status
 *   POST /claude-code/ide-mcp/antigravity/activate    Add lm-assist to Antigravity mcp_config.json
 *   POST /claude-code/ide-mcp/antigravity/deactivate  Remove lm-assist from Antigravity mcp_config.json
 *   GET  /claude-code/ide-mcp/gemini-cli          Check Gemini CLI MCP integration status
 *   POST /claude-code/ide-mcp/gemini-cli/activate     Add lm-assist to Gemini CLI settings.json
 *   POST /claude-code/ide-mcp/gemini-cli/deactivate   Remove lm-assist from Gemini CLI settings.json
 *   GET  /claude-code/ide-mcp/cursor               Check Cursor MCP integration status
 *   POST /claude-code/ide-mcp/cursor/activate       Add lm-assist to Cursor mcp.json
 *   POST /claude-code/ide-mcp/cursor/deactivate     Remove lm-assist from Cursor mcp.json
 *   GET  /claude-code/ide-mcp/windsurf              Check Windsurf MCP integration status
 *   POST /claude-code/ide-mcp/windsurf/activate     Add lm-assist to Windsurf mcp_config.json
 *   POST /claude-code/ide-mcp/windsurf/deactivate   Remove lm-assist from Windsurf mcp_config.json
 *   GET  /claude-code/context-hook              Check context-inject hook installation
 *   POST /claude-code/context-hook/install      Install context-inject hook into ~/.claude/settings.json
 *   POST /claude-code/context-hook/uninstall    Remove context-inject hook from ~/.claude/settings.json
 *   GET  /claude-code/settings                  Read Claude settings (~/.claude/settings.json)
 *   PUT  /claude-code/settings                  Update Claude settings (cleanupPeriodDays)
 */

import type { RouteHandler, RouteContext } from '../index';
import { execFileSync } from '../../utils/exec';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

const IS_WINDOWS = process.platform === 'win32';
const CLAUDE_CODE_CONFIG_FILE = path.join(os.homedir(), '.claude-code-config.json');
const CLAUDE_SETTINGS_FILE = path.join(os.homedir(), '.claude', 'settings.json');
const INSTALLED_PLUGINS_FILE = path.join(os.homedir(), '.claude', 'plugins', 'installed_plugins.json');
// Resolve npm global root without spawning npm (which fails on Windows with execFileSync)
function getNpmGlobalRoot(): string | null {
  const nodeDir = path.dirname(process.execPath);
  const candidates = [
    path.join(nodeDir, 'node_modules', 'lm-assist'),              // Windows (nvm4w, standard)
    path.join(nodeDir, '..', 'lib', 'node_modules', 'lm-assist'), // Linux/macOS
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

// Resolve hook scripts: prefer npm global install, fall back to local repo
function findNpmHookPath(hookName: string): string | null {
  const npmPkg = getNpmGlobalRoot();
  if (npmPkg) {
    const npmPath = path.join(npmPkg, 'core', 'hooks', hookName);
    if (fs.existsSync(npmPath)) return npmPath;
  }
  return null;
}

function getHookPath(hookName: string): string {
  const config = loadConfig();
  // Dev mode ON → use repo
  if (config.devModeEnabled && config.devRepoPath) {
    const devPath = path.join(config.devRepoPath, 'core', 'hooks', hookName);
    if (fs.existsSync(devPath)) return devPath;
  }
  // Dev mode OFF → prefer npm global
  const npmPath = findNpmHookPath(hookName);
  if (npmPath) return npmPath;
  // Fallback: local relative
  return path.resolve(__dirname, '../../../hooks/', hookName);
}

function getStatuslineCommand(): string {
  return `node "${getHookPath('statusline-worktree.js')}"`;
}

function getContextInjectScriptJs(): string {
  return getHookPath('context-inject-hook.js');
}

function getContextInjectCommand(): string {
  return `node "${getContextInjectScriptJs()}"`;
}

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
  const config = loadConfig();
  // Dev mode ON → use repo
  if (config.devModeEnabled && config.devRepoPath) {
    const devMcpPath = path.join(config.devRepoPath, 'core', 'dist', 'mcp-server', 'index.js');
    if (fs.existsSync(devMcpPath)) return devMcpPath;
  }
  // Dev mode OFF → prefer npm global package
  const npmPkg = getNpmGlobalRoot();
  if (npmPkg) {
    const npmMcpPath = path.join(npmPkg, 'core', 'dist', 'mcp-server', 'index.js');
    if (fs.existsSync(npmMcpPath)) return npmMcpPath;
  }
  // Fallback: local build output
  return path.resolve(__dirname, '../../dist/mcp-server/index.js');
}

/**
 * Get the VS Code mcp.json path (cross-platform).
 */
function getVsCodeMcpJsonPath(): string {
  if (IS_WINDOWS) {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Code', 'User', 'mcp.json');
  } else if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Code', 'User', 'mcp.json');
  }
  return path.join(os.homedir(), '.config', 'Code', 'User', 'mcp.json');
}

/**
 * Get the Codex config.toml path.
 */
function getCodexConfigPath(): string {
  return path.join(os.homedir(), '.codex', 'config.toml');
}

/**
 * Get the Google Antigravity MCP config path.
 */
function getAntigravityMcpConfigPath(): string {
  return path.join(os.homedir(), '.gemini', 'antigravity', 'mcp_config.json');
}

/**
 * Get the Gemini CLI settings.json path.
 */
function getGeminiCliSettingsPath(): string {
  return path.join(os.homedir(), '.gemini', 'settings.json');
}

/**
 * Get the Cursor mcp.json path.
 */
function getCursorMcpJsonPath(): string {
  return path.join(os.homedir(), '.cursor', 'mcp.json');
}

/**
 * Get the Windsurf mcp_config.json path.
 */
function getWindsurfMcpConfigPath(): string {
  return path.join(os.homedir(), '.codeium', 'windsurf', 'mcp_config.json');
}

/**
 * Remove a TOML section by name (e.g. 'mcp_servers.lm-assist').
 * Handles sections at any position (start, middle, end) and cleans up blank lines.
 * Works correctly even when the last line has no trailing newline.
 */
function removeTomlSection(content: string, sectionName: string): string {
  // Ensure trailing newline for consistent regex matching
  const hasTrailingNewline = content.endsWith('\n');
  let text = hasTrailingNewline ? content : content + '\n';
  const escaped = sectionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Match the section header + all content lines until next section header or EOF
  const re = new RegExp(`\\n*\\[${escaped}\\][ \\t]*\\n(?:[^\\[\\n].*\\n|[ \\t]*\\n)*`, 'g');
  text = text.replace(re, '\n\n');
  // Also handle case where section is at very start of file (no leading newline)
  const reStart = new RegExp(`^\\[${escaped}\\][ \\t]*\\n(?:[^\\[\\n].*\\n|[ \\t]*\\n)*`, 'g');
  text = text.replace(reStart, '');
  // Clean up: collapse 3+ consecutive newlines to 2, trim leading blank lines,
  // and normalize trailing whitespace to a single newline (or none if original had none)
  text = text.replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '').replace(/\n+$/, '\n');
  if (!hasTrailingNewline) text = text.replace(/\n$/, '');
  // If everything was removed, return empty
  if (text.trim().length === 0) text = '';
  return text;
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
  devModeEnabled: boolean;
  devRepoPath: string;
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
  devModeEnabled: false,
  devRepoPath: path.join(os.homedir(), 'lm-assist'),
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
      devModeEnabled: typeof parsed.devModeEnabled === 'boolean' ? parsed.devModeEnabled : DEFAULT_CONFIG.devModeEnabled,
      devRepoPath: typeof parsed.devRepoPath === 'string' && parsed.devRepoPath.trim() ? parsed.devRepoPath : DEFAULT_CONFIG.devRepoPath,
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

/**
 * When devModeEnabled or devRepoPath changes, re-point any already-installed
 * components (statusline, context-inject hook, MCP server) to the new paths.
 * Only touches components that are currently installed; skips plugin-managed ones.
 */
function reapplyInstalledPaths(): { updated: string[] } {
  const updated: string[] = [];
  const settings = readClaudeSettings();

  // 1. Statusline — if installed, update the command path
  const sl = settings.statusLine;
  if (sl && typeof sl.command === 'string' &&
      (sl.command.includes('statusline-worktree.sh') || sl.command.includes('statusline-worktree.js'))) {
    const newCommand = getStatuslineCommand();
    if (sl.command !== newCommand) {
      settings.statusLine = { ...sl, command: newCommand };
      updated.push('statusline');
    }
  }

  // 2. Context-inject hook — update manual hooks in settings.json
  // Always update manual hooks regardless of plugin status, since both can coexist
  const plugin = detectPluginInstallation();
  {
    const hooks: any[] = settings.hooks?.UserPromptSubmit || [];
    let hookUpdated = false;
    const newCommand = getContextInjectCommand();
    const updatedHooks = hooks.map((entry: any) => ({
      ...entry,
      hooks: (entry.hooks || []).map((h: any) => {
        if (typeof h.command === 'string' &&
            (h.command.includes('context-inject-hook.sh') || h.command.includes('context-inject-hook.js'))) {
          if (h.command !== newCommand) {
            hookUpdated = true;
            return { ...h, command: newCommand };
          }
        }
        return h;
      }),
    }));
    if (hookUpdated) {
      if (!settings.hooks) settings.hooks = {};
      settings.hooks.UserPromptSubmit = updatedHooks;
      updated.push('context-hook');
    }
  }

  // Write settings if anything changed
  if (updated.length > 0) {
    writeClaudeSettings(settings);
  }

  // 3. MCP server — update path in plugin .mcp.json or manual registration
  const newMcpServerPath = findMcpServerPath();
  const pluginMcp = plugin ? detectPluginMcp(plugin.installPath) : null;
  if (pluginMcp) {
    // Plugin-managed MCP — update the .mcp.json args to point to the correct path
    const currentPath = (pluginMcp.args || '').trim();
    if (currentPath !== newMcpServerPath) {
      try {
        const mcpJsonPath = path.join(plugin!.installPath, '.mcp.json');
        const mcpJson = {
          mcpServers: {
            'lm-assist': {
              command: 'node',
              args: [newMcpServerPath],
            },
          },
        };
        fs.writeFileSync(mcpJsonPath, JSON.stringify(mcpJson, null, 2) + '\n');
        updated.push('mcp');
      } catch { /* non-fatal */ }
    }
  } else {
    const env = { ...process.env, CLAUDECODE: undefined };
    try {
      const output = execFileSync('claude', ['mcp', 'get', 'lm-assist'], {
        encoding: 'utf-8', timeout: 10000, env,
      }).trim();
      if (output) {
        // MCP is manually installed — re-register with new path
        try {
          execFileSync('claude', ['mcp', 'remove', 'lm-assist', '-s', 'user'], {
            encoding: 'utf-8', timeout: 10000, env,
          });
        } catch { /* may not exist */ }
        execFileSync('claude', [
          'mcp', 'add', '-s', 'user', 'lm-assist', '--',
          'node', newMcpServerPath,
        ], {
          encoding: 'utf-8', timeout: 15000, env,
        });
        updated.push('mcp');
      }
    } catch {
      // MCP not installed manually, skip
    }
  }

  return { updated };
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
        let devModeChanged = false;
        if (typeof body.devModeEnabled === 'boolean' && body.devModeEnabled !== current.devModeEnabled) {
          current.devModeEnabled = body.devModeEnabled;
          changed = true;
          devModeChanged = true;
        }
        if (typeof body.devRepoPath === 'string' && body.devRepoPath.trim() && body.devRepoPath !== current.devRepoPath) {
          current.devRepoPath = body.devRepoPath;
          changed = true;
          devModeChanged = true;
        }

        if (changed) {
          saveConfig(current);
        }

        // When dev mode settings change, re-point installed components to new paths
        let pathsUpdated: string[] = [];
        let devActionScheduled = false;
        if (devModeChanged) {
          try {
            const result = reapplyInstalledPaths();
            pathsUpdated = result.updated;
          } catch {
            // Non-fatal: paths will be updated on next manual install
          }

          // Start or stop the dev instance (prod stays running).
          // Import service-manager and call startDevAll/stopDevAll directly.
          try {
            const svcMgr = require('../../service-manager');
            if (current.devModeEnabled && current.devRepoPath) {
              // Dev toggled ON → start dev instance in background
              svcMgr.startDevAll(current.devRepoPath).catch(() => {});
              devActionScheduled = true;
            } else {
              // Dev toggled OFF → stop dev instance in background
              svcMgr.stopDevAll().catch(() => {});
              devActionScheduled = true;
            }
          } catch { /* service-manager not available */ }
        }

        return { success: true, data: current, ...(pathsUpdated.length > 0 ? { pathsUpdated } : {}), ...(devActionScheduled ? { devActionScheduled } : {}) };
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

        const scriptPath = installed ? statusLine.command : getStatuslineCommand();

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
          command: getStatuslineCommand(),
          padding: 2,
        };

        writeClaudeSettings(settings);

        return {
          success: true,
          data: {
            installed: true,
            scriptPath: getStatuslineCommand(),
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
          const correctMcpPath = findMcpServerPath();

          if (pluginMcp) {
            // Update path if it's stale (e.g. devMode changed)
            const currentPath = (pluginMcp.args || '').trim();
            if (currentPath !== correctMcpPath) {
              try {
                const mcpJsonPath = path.join(plugin.installPath, '.mcp.json');
                const mcpJson = {
                  mcpServers: {
                    'lm-assist': { command: 'node', args: [correctMcpPath] },
                  },
                };
                fs.writeFileSync(mcpJsonPath, JSON.stringify(mcpJson, null, 2) + '\n');
              } catch { /* non-fatal */ }
            }
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

          // Plugin installed but .mcp.json missing — create it
          try {
            const mcpServerPath = correctMcpPath;
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

    // ─── IDE MCP Integration (VS Code, Codex) ───

    // GET /claude-code/ide-mcp/vscode - Check VS Code MCP integration status
    {
      method: 'GET',
      pattern: /^\/claude-code\/ide-mcp\/vscode$/,
      handler: async () => {
        const configPath = getVsCodeMcpJsonPath();
        const configExists = fs.existsSync(configPath);
        if (!configExists) {
          return { success: true, data: { installed: false, configPath, configExists: false } };
        }
        try {
          const raw = fs.readFileSync(configPath, 'utf-8');
          const data = JSON.parse(raw);
          const server = data?.servers?.['lm-assist'];
          if (server) {
            return {
              success: true,
              data: {
                installed: true,
                configPath,
                configExists: true,
                command: server.command || 'node',
                args: Array.isArray(server.args) ? server.args : [],
              },
            };
          }
          return { success: true, data: { installed: false, configPath, configExists: true } };
        } catch {
          return { success: true, data: { installed: false, configPath, configExists: true } };
        }
      },
    },

    // POST /claude-code/ide-mcp/vscode/activate - Add lm-assist to VS Code mcp.json
    {
      method: 'POST',
      pattern: /^\/claude-code\/ide-mcp\/vscode\/activate$/,
      handler: async () => {
        try {
          const configPath = getVsCodeMcpJsonPath();
          const mcpServerPath = findMcpServerPath().replace(/\\/g, '/');
          let data: any = { servers: {} };
          try {
            if (fs.existsSync(configPath)) {
              data = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
              if (!data.servers) data.servers = {};
            }
          } catch {
            data = { servers: {} };
          }
          data.servers['lm-assist'] = {
            command: 'node',
            args: [mcpServerPath],
          };
          const dir = path.dirname(configPath);
          if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(configPath, JSON.stringify(data, null, 2), 'utf-8');
          return {
            success: true,
            data: { installed: true, configPath, configExists: true, command: 'node', args: [mcpServerPath] },
          };
        } catch (err: any) {
          return { success: false, error: err.message || 'Failed to activate VS Code MCP' };
        }
      },
    },

    // POST /claude-code/ide-mcp/vscode/deactivate - Remove lm-assist from VS Code mcp.json
    {
      method: 'POST',
      pattern: /^\/claude-code\/ide-mcp\/vscode\/deactivate$/,
      handler: async () => {
        const configPath = getVsCodeMcpJsonPath();
        if (!fs.existsSync(configPath)) {
          return { success: true, data: { installed: false, configPath, configExists: false } };
        }
        try {
          const data = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
          if (data?.servers?.['lm-assist']) {
            delete data.servers['lm-assist'];
            fs.writeFileSync(configPath, JSON.stringify(data, null, 2), 'utf-8');
          }
          return { success: true, data: { installed: false, configPath, configExists: true } };
        } catch (err: any) {
          return { success: false, error: err.message || 'Failed to update VS Code mcp.json' };
        }
      },
    },

    // GET /claude-code/ide-mcp/codex - Check Codex MCP integration status
    {
      method: 'GET',
      pattern: /^\/claude-code\/ide-mcp\/codex$/,
      handler: async () => {
        const configPath = getCodexConfigPath();
        const configExists = fs.existsSync(configPath);
        if (!configExists) {
          return { success: true, data: { installed: false, configPath, configExists: false } };
        }
        try {
          const raw = fs.readFileSync(configPath, 'utf-8');
          const sectionMatch = raw.match(/\[mcp_servers\.lm-assist\][^\n]*\n([\s\S]*?)(?=\n\[|$)/);
          if (sectionMatch) {
            const section = sectionMatch[1];
            const cmdMatch = section.match(/command\s*=\s*"([^"]*)"/);
            const argsMatch = section.match(/args\s*=\s*\[([^\]]*)\]/);
            const command = cmdMatch ? cmdMatch[1] : 'node';
            const args = argsMatch
              ? argsMatch[1].split(',').map((a: string) => a.trim().replace(/^"|"$/g, '')).filter(Boolean)
              : [];
            return {
              success: true,
              data: { installed: true, configPath, configExists: true, command, args },
            };
          }
          return { success: true, data: { installed: false, configPath, configExists: true } };
        } catch {
          return { success: true, data: { installed: false, configPath, configExists: true } };
        }
      },
    },

    // POST /claude-code/ide-mcp/codex/activate - Add lm-assist to Codex config.toml
    {
      method: 'POST',
      pattern: /^\/claude-code\/ide-mcp\/codex\/activate$/,
      handler: async () => {
        try {
          const configPath = getCodexConfigPath();
          const mcpServerPath = findMcpServerPath().replace(/\\/g, '/');
          const section = `[mcp_servers.lm-assist]\ncommand = "node"\nargs = ["${mcpServerPath}"]\n`;
          let content = '';
          try {
            if (fs.existsSync(configPath)) {
              content = fs.readFileSync(configPath, 'utf-8');
              // Remove existing section if present (including surrounding blank lines)
              content = removeTomlSection(content, 'mcp_servers.lm-assist');
            }
          } catch {
            content = '';
          }
          // Ensure exactly one trailing newline before appending
          content = content.trimEnd() + (content.trim().length > 0 ? '\n\n' : '');
          content += section;
          const dir = path.dirname(configPath);
          if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(configPath, content, 'utf-8');
          return {
            success: true,
            data: { installed: true, configPath, configExists: true, command: 'node', args: [mcpServerPath] },
          };
        } catch (err: any) {
          return { success: false, error: err.message || 'Failed to activate Codex MCP' };
        }
      },
    },

    // POST /claude-code/ide-mcp/codex/deactivate - Remove lm-assist from Codex config.toml
    {
      method: 'POST',
      pattern: /^\/claude-code\/ide-mcp\/codex\/deactivate$/,
      handler: async () => {
        const configPath = getCodexConfigPath();
        if (!fs.existsSync(configPath)) {
          return { success: true, data: { installed: false, configPath, configExists: false } };
        }
        try {
          let content = fs.readFileSync(configPath, 'utf-8');
          content = removeTomlSection(content, 'mcp_servers.lm-assist');
          fs.writeFileSync(configPath, content, 'utf-8');
          return { success: true, data: { installed: false, configPath, configExists: true } };
        } catch (err: any) {
          return { success: false, error: err.message || 'Failed to update Codex config.toml' };
        }
      },
    },

    // GET /claude-code/ide-mcp/antigravity - Check Google Antigravity MCP integration status
    {
      method: 'GET',
      pattern: /^\/claude-code\/ide-mcp\/antigravity$/,
      handler: async () => {
        const configPath = getAntigravityMcpConfigPath();
        const configExists = fs.existsSync(configPath);
        if (!configExists) {
          return { success: true, data: { installed: false, configPath, configExists: false } };
        }
        try {
          const raw = fs.readFileSync(configPath, 'utf-8');
          const data = JSON.parse(raw);
          const server = data?.mcpServers?.['lm-assist'];
          if (server) {
            return {
              success: true,
              data: {
                installed: true, configPath, configExists: true,
                command: server.command || 'node',
                args: Array.isArray(server.args) ? server.args : [],
              },
            };
          }
          return { success: true, data: { installed: false, configPath, configExists: true } };
        } catch {
          return { success: true, data: { installed: false, configPath, configExists: true } };
        }
      },
    },

    // POST /claude-code/ide-mcp/antigravity/activate - Add lm-assist to Antigravity mcp_config.json
    {
      method: 'POST',
      pattern: /^\/claude-code\/ide-mcp\/antigravity\/activate$/,
      handler: async () => {
        try {
          const configPath = getAntigravityMcpConfigPath();
          const mcpServerPath = findMcpServerPath().replace(/\\/g, '/');
          let data: any = { mcpServers: {} };
          try {
            if (fs.existsSync(configPath)) {
              data = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
              if (!data.mcpServers) data.mcpServers = {};
            }
          } catch {
            data = { mcpServers: {} };
          }
          data.mcpServers['lm-assist'] = { command: 'node', args: [mcpServerPath] };
          const dir = path.dirname(configPath);
          if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(configPath, JSON.stringify(data, null, 2), 'utf-8');
          return {
            success: true,
            data: { installed: true, configPath, configExists: true, command: 'node', args: [mcpServerPath] },
          };
        } catch (err: any) {
          return { success: false, error: err.message || 'Failed to activate Antigravity MCP' };
        }
      },
    },

    // POST /claude-code/ide-mcp/antigravity/deactivate - Remove lm-assist from Antigravity mcp_config.json
    {
      method: 'POST',
      pattern: /^\/claude-code\/ide-mcp\/antigravity\/deactivate$/,
      handler: async () => {
        const configPath = getAntigravityMcpConfigPath();
        if (!fs.existsSync(configPath)) {
          return { success: true, data: { installed: false, configPath, configExists: false } };
        }
        try {
          const data = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
          if (data?.mcpServers?.['lm-assist']) {
            delete data.mcpServers['lm-assist'];
            fs.writeFileSync(configPath, JSON.stringify(data, null, 2), 'utf-8');
          }
          return { success: true, data: { installed: false, configPath, configExists: true } };
        } catch (err: any) {
          return { success: false, error: err.message || 'Failed to update Antigravity mcp_config.json' };
        }
      },
    },

    // GET /claude-code/ide-mcp/gemini-cli - Check Gemini CLI MCP integration status
    {
      method: 'GET',
      pattern: /^\/claude-code\/ide-mcp\/gemini-cli$/,
      handler: async () => {
        const configPath = getGeminiCliSettingsPath();
        const configExists = fs.existsSync(configPath);
        if (!configExists) {
          return { success: true, data: { installed: false, configPath, configExists: false } };
        }
        try {
          const raw = fs.readFileSync(configPath, 'utf-8');
          const data = JSON.parse(raw);
          const server = data?.mcpServers?.['lm-assist'];
          if (server) {
            return {
              success: true,
              data: {
                installed: true, configPath, configExists: true,
                command: server.command || 'node',
                args: Array.isArray(server.args) ? server.args : [],
              },
            };
          }
          return { success: true, data: { installed: false, configPath, configExists: true } };
        } catch {
          return { success: true, data: { installed: false, configPath, configExists: true } };
        }
      },
    },

    // POST /claude-code/ide-mcp/gemini-cli/activate - Add lm-assist to Gemini CLI settings.json
    {
      method: 'POST',
      pattern: /^\/claude-code\/ide-mcp\/gemini-cli\/activate$/,
      handler: async () => {
        try {
          const configPath = getGeminiCliSettingsPath();
          const mcpServerPath = findMcpServerPath().replace(/\\/g, '/');
          let data: any = {};
          try {
            if (fs.existsSync(configPath)) {
              data = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
            }
          } catch {
            data = {};
          }
          if (!data.mcpServers) data.mcpServers = {};
          data.mcpServers['lm-assist'] = { command: 'node', args: [mcpServerPath] };
          const dir = path.dirname(configPath);
          if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(configPath, JSON.stringify(data, null, 2), 'utf-8');
          return {
            success: true,
            data: { installed: true, configPath, configExists: true, command: 'node', args: [mcpServerPath] },
          };
        } catch (err: any) {
          return { success: false, error: err.message || 'Failed to activate Gemini CLI MCP' };
        }
      },
    },

    // POST /claude-code/ide-mcp/gemini-cli/deactivate - Remove lm-assist from Gemini CLI settings.json
    {
      method: 'POST',
      pattern: /^\/claude-code\/ide-mcp\/gemini-cli\/deactivate$/,
      handler: async () => {
        const configPath = getGeminiCliSettingsPath();
        if (!fs.existsSync(configPath)) {
          return { success: true, data: { installed: false, configPath, configExists: false } };
        }
        try {
          const data = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
          if (data?.mcpServers?.['lm-assist']) {
            delete data.mcpServers['lm-assist'];
            fs.writeFileSync(configPath, JSON.stringify(data, null, 2), 'utf-8');
          }
          return { success: true, data: { installed: false, configPath, configExists: true } };
        } catch (err: any) {
          return { success: false, error: err.message || 'Failed to update Gemini CLI settings.json' };
        }
      },
    },

    // GET /claude-code/ide-mcp/cursor - Check Cursor MCP integration status
    {
      method: 'GET',
      pattern: /^\/claude-code\/ide-mcp\/cursor$/,
      handler: async () => {
        const configPath = getCursorMcpJsonPath();
        const configExists = fs.existsSync(configPath);
        if (!configExists) {
          return { success: true, data: { installed: false, configPath, configExists: false } };
        }
        try {
          const data = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
          const server = data?.mcpServers?.['lm-assist'];
          if (server) {
            return {
              success: true,
              data: {
                installed: true, configPath, configExists: true,
                command: server.command || 'node',
                args: Array.isArray(server.args) ? server.args : [],
              },
            };
          }
          return { success: true, data: { installed: false, configPath, configExists: true } };
        } catch {
          return { success: true, data: { installed: false, configPath, configExists: true } };
        }
      },
    },

    // POST /claude-code/ide-mcp/cursor/activate - Add lm-assist to Cursor mcp.json
    {
      method: 'POST',
      pattern: /^\/claude-code\/ide-mcp\/cursor\/activate$/,
      handler: async () => {
        try {
          const configPath = getCursorMcpJsonPath();
          const mcpServerPath = findMcpServerPath().replace(/\\/g, '/');
          let data: any = { mcpServers: {} };
          try {
            if (fs.existsSync(configPath)) {
              data = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
              if (!data.mcpServers) data.mcpServers = {};
            }
          } catch {
            data = { mcpServers: {} };
          }
          data.mcpServers['lm-assist'] = { command: 'node', args: [mcpServerPath] };
          const dir = path.dirname(configPath);
          if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(configPath, JSON.stringify(data, null, 2), 'utf-8');
          return {
            success: true,
            data: { installed: true, configPath, configExists: true, command: 'node', args: [mcpServerPath] },
          };
        } catch (err: any) {
          return { success: false, error: err.message || 'Failed to activate Cursor MCP' };
        }
      },
    },

    // POST /claude-code/ide-mcp/cursor/deactivate - Remove lm-assist from Cursor mcp.json
    {
      method: 'POST',
      pattern: /^\/claude-code\/ide-mcp\/cursor\/deactivate$/,
      handler: async () => {
        const configPath = getCursorMcpJsonPath();
        if (!fs.existsSync(configPath)) {
          return { success: true, data: { installed: false, configPath, configExists: false } };
        }
        try {
          const data = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
          if (data?.mcpServers?.['lm-assist']) {
            delete data.mcpServers['lm-assist'];
            fs.writeFileSync(configPath, JSON.stringify(data, null, 2), 'utf-8');
          }
          return { success: true, data: { installed: false, configPath, configExists: true } };
        } catch (err: any) {
          return { success: false, error: err.message || 'Failed to update Cursor mcp.json' };
        }
      },
    },

    // GET /claude-code/ide-mcp/windsurf - Check Windsurf MCP integration status
    {
      method: 'GET',
      pattern: /^\/claude-code\/ide-mcp\/windsurf$/,
      handler: async () => {
        const configPath = getWindsurfMcpConfigPath();
        const configExists = fs.existsSync(configPath);
        if (!configExists) {
          return { success: true, data: { installed: false, configPath, configExists: false } };
        }
        try {
          const data = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
          const server = data?.mcpServers?.['lm-assist'];
          if (server) {
            return {
              success: true,
              data: {
                installed: true, configPath, configExists: true,
                command: server.command || 'node',
                args: Array.isArray(server.args) ? server.args : [],
              },
            };
          }
          return { success: true, data: { installed: false, configPath, configExists: true } };
        } catch {
          return { success: true, data: { installed: false, configPath, configExists: true } };
        }
      },
    },

    // POST /claude-code/ide-mcp/windsurf/activate - Add lm-assist to Windsurf mcp_config.json
    {
      method: 'POST',
      pattern: /^\/claude-code\/ide-mcp\/windsurf\/activate$/,
      handler: async () => {
        try {
          const configPath = getWindsurfMcpConfigPath();
          const mcpServerPath = findMcpServerPath().replace(/\\/g, '/');
          let data: any = { mcpServers: {} };
          try {
            if (fs.existsSync(configPath)) {
              data = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
              if (!data.mcpServers) data.mcpServers = {};
            }
          } catch {
            data = { mcpServers: {} };
          }
          data.mcpServers['lm-assist'] = { command: 'node', args: [mcpServerPath] };
          const dir = path.dirname(configPath);
          if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(configPath, JSON.stringify(data, null, 2), 'utf-8');
          return {
            success: true,
            data: { installed: true, configPath, configExists: true, command: 'node', args: [mcpServerPath] },
          };
        } catch (err: any) {
          return { success: false, error: err.message || 'Failed to activate Windsurf MCP' };
        }
      },
    },

    // POST /claude-code/ide-mcp/windsurf/deactivate - Remove lm-assist from Windsurf mcp_config.json
    {
      method: 'POST',
      pattern: /^\/claude-code\/ide-mcp\/windsurf\/deactivate$/,
      handler: async () => {
        const configPath = getWindsurfMcpConfigPath();
        if (!fs.existsSync(configPath)) {
          return { success: true, data: { installed: false, configPath, configExists: false } };
        }
        try {
          const data = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
          if (data?.mcpServers?.['lm-assist']) {
            delete data.mcpServers['lm-assist'];
            fs.writeFileSync(configPath, JSON.stringify(data, null, 2), 'utf-8');
          }
          return { success: true, data: { installed: false, configPath, configExists: true } };
        } catch (err: any) {
          return { success: false, error: err.message || 'Failed to update Windsurf mcp_config.json' };
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
            scriptPath: getContextInjectScriptJs(),
            command: getContextInjectCommand(),
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
            hooks: [{ type: 'command', command: getContextInjectCommand(), timeout: 10 }],
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
                  return { ...h, command: getContextInjectCommand() };
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
          data: { installed: true, source: 'manual', scriptPath: getContextInjectScriptJs(), command: getContextInjectCommand() },
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
