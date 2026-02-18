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
 */

import type { RouteHandler, RouteContext } from '../index';
import { execFileSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

const CLAUDE_CODE_CONFIG_FILE = path.join(os.homedir(), '.claude-code-config.json');
const CLAUDE_SETTINGS_FILE = path.join(os.homedir(), '.claude', 'settings.json');
const STATUSLINE_SCRIPT = path.resolve(__dirname, '../../../hooks/statusline-worktree.sh');
const CONTEXT_INJECT_SCRIPT = path.resolve(__dirname, '../../../hooks/context-inject-hook.sh');

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
    // GET /claude-code/status - Detect Claude Code installation
    {
      method: 'GET',
      pattern: /^\/claude-code\/status$/,
      handler: async () => {
        let installed = false;
        let binaryPath: string | null = null;
        let binaryType: 'claude' | 'claude-native' | null = null;
        let version: string | null = null;

        // Check for claude binary
        try {
          binaryPath = execFileSync('which', ['claude'], { encoding: 'utf-8', timeout: 5000 }).trim();
        } catch {
          // not found
        }

        // Check for claude-native binary
        let claudeNativePath: string | null = null;
        try {
          claudeNativePath = execFileSync('which', ['claude-native'], { encoding: 'utf-8', timeout: 5000 }).trim();
        } catch {
          // not found
        }

        if (binaryPath) {
          installed = true;

          // Determine binary type by resolving symlinks
          try {
            const resolved = execFileSync('readlink', ['-f', binaryPath], { encoding: 'utf-8', timeout: 5000 }).trim();
            if (resolved.includes('claude-native')) {
              binaryType = 'claude-native';
            } else {
              binaryType = 'claude';
            }
          } catch {
            binaryType = 'claude';
          }

          // Get version
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
          statusLine.command.includes('statusline-worktree.sh')
        );

        const scriptPath = installed ? statusLine.command : STATUSLINE_SCRIPT;

        const features = [
          'Context %',
          'Session RAM',
          'Free RAM',
          'PID',
          'PTS',
          'Process time',
          'Project dir',
          'Last prompts',
          'Worktree detection',
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

        // Deep merge: preserve other keys, set statusLine
        settings.statusLine = {
          type: 'command',
          command: STATUSLINE_SCRIPT,
          padding: 2,
        };

        writeClaudeSettings(settings);

        return {
          success: true,
          data: {
            installed: true,
            scriptPath: STATUSLINE_SCRIPT,
            features: [
              'Context %', 'Session RAM', 'Free RAM', 'PID', 'PTS',
              'Process time', 'Project dir', 'Last prompts', 'Worktree detection',
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
    {
      method: 'GET',
      pattern: /^\/claude-code\/mcp$/,
      handler: async () => {
        const env = { ...process.env, CLAUDECODE: undefined };
        try {
          const output = execFileSync('claude', ['mcp', 'get', 'tier-agent-context'], {
            encoding: 'utf-8',
            timeout: 10000,
            env,
          }).trim();

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
              scope: scopeMatch?.[1]?.trim() || 'user',
              status: isConnected ? 'connected' : statusRaw,
              command: commandMatch?.[1]?.trim() || null,
              args: argsMatch?.[1]?.trim() || null,
              tools: ['search', 'detail', 'feedback'],
            },
          };
        } catch {
          return {
            success: true,
            data: { installed: false },
          };
        }
      },
    },

    // POST /claude-code/mcp/install - Install MCP server
    {
      method: 'POST',
      pattern: /^\/claude-code\/mcp\/install$/,
      handler: async () => {
        const env = { ...process.env, CLAUDECODE: undefined };
        const mcpServerPath = path.resolve(__dirname, '../../dist/mcp-server/index.js');

        try {
          execFileSync('claude', [
            'mcp', 'add', '-s', 'user', 'tier-agent-context', '--',
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

    // POST /claude-code/mcp/uninstall - Remove MCP server
    {
      method: 'POST',
      pattern: /^\/claude-code\/mcp\/uninstall$/,
      handler: async () => {
        const env = { ...process.env, CLAUDECODE: undefined };
        try {
          execFileSync('claude', ['mcp', 'remove', 'tier-agent-context', '-s', 'user'], {
            encoding: 'utf-8',
            timeout: 10000,
            env,
          });

          return {
            success: true,
            data: { installed: false },
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
    {
      method: 'GET',
      pattern: /^\/claude-code\/context-hook$/,
      handler: async () => {
        const settings = readClaudeSettings();
        const hooks = settings.hooks || {};
        const userPromptHooks: any[] = hooks.UserPromptSubmit || [];
        const installed = userPromptHooks.some((entry: any) =>
          (entry.hooks || []).some((h: any) =>
            typeof h.command === 'string' && h.command.includes('context-inject-hook.sh')
          )
        );
        return {
          success: true,
          data: { installed, scriptPath: CONTEXT_INJECT_SCRIPT },
        };
      },
    },

    // POST /claude-code/context-hook/install - Install context-inject hook into settings.json
    {
      method: 'POST',
      pattern: /^\/claude-code\/context-hook\/install$/,
      handler: async () => {
        const settings = readClaudeSettings();
        if (!settings.hooks) settings.hooks = {};
        const existingHooks: any[] = settings.hooks.UserPromptSubmit || [];

        // Check if already installed to avoid duplicates
        const alreadyInstalled = existingHooks.some((entry: any) =>
          (entry.hooks || []).some((h: any) =>
            typeof h.command === 'string' && h.command.includes('context-inject-hook.sh')
          )
        );

        if (!alreadyInstalled) {
          existingHooks.push({
            hooks: [{ type: 'command', command: CONTEXT_INJECT_SCRIPT, timeout: 10 }],
          });
          settings.hooks.UserPromptSubmit = existingHooks;
          writeClaudeSettings(settings);
        }

        return {
          success: true,
          data: { installed: true, scriptPath: CONTEXT_INJECT_SCRIPT },
        };
      },
    },

    // POST /claude-code/context-hook/uninstall - Remove context-inject hook from settings.json
    {
      method: 'POST',
      pattern: /^\/claude-code\/context-hook\/uninstall$/,
      handler: async () => {
        const settings = readClaudeSettings();
        if (!settings.hooks?.UserPromptSubmit) {
          return { success: true, data: { installed: false, scriptPath: null } };
        }

        settings.hooks.UserPromptSubmit = (settings.hooks.UserPromptSubmit as any[]).map((entry: any) => ({
          ...entry,
          hooks: (entry.hooks || []).filter((h: any) =>
            !(typeof h.command === 'string' && h.command.includes('context-inject-hook.sh'))
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
          data: { installed: false, scriptPath: null },
        };
      },
    },
  ];
}
