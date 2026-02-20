/**
 * tmux Routes
 *
 * Endpoints for checking tmux installation status and managing tmux auto-start configuration.
 *
 * Endpoints:
 *   GET  /tmux/status     Check tmux installation and configuration status
 *   POST /tmux/install    Install tmux auto-start configuration
 *   POST /tmux/uninstall  Remove tmux auto-start configuration
 *   PUT  /tmux/config     Update tmux settings (status bar, destroy-unattached)
 */

import type { RouteHandler, RouteContext } from '../index';
import { execFile, execFileSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { IS_WINDOWS } from '../../utils/process-utils';

const BASHRC = path.join(os.homedir(), '.bashrc');
const TMUX_CONF = path.join(os.homedir(), '.tmux.conf');
const TMUX_CONFIG_FILE = path.join(os.homedir(), '.tmux-managed-config.json');
const MARKER = '# Auto-start tmux (hidden status bar';

interface TmuxConfig {
  /** Show tmux status bar (default: false — hidden) */
  statusBar: boolean;
  /** Destroy session when terminal closes / client detaches (default: false — sessions persist) */
  destroyUnattached: boolean;
}

const DEFAULT_CONFIG: TmuxConfig = {
  statusBar: false,
  destroyUnattached: false,
};

function loadConfig(): TmuxConfig {
  try {
    const raw = fs.readFileSync(TMUX_CONFIG_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    return {
      statusBar: typeof parsed.statusBar === 'boolean' ? parsed.statusBar : DEFAULT_CONFIG.statusBar,
      destroyUnattached: typeof parsed.destroyUnattached === 'boolean' ? parsed.destroyUnattached : DEFAULT_CONFIG.destroyUnattached,
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

function saveConfig(config: TmuxConfig): void {
  fs.writeFileSync(TMUX_CONFIG_FILE, JSON.stringify(config, null, 2) + '\n');
}

interface TmuxStatus {
  /** Whether the tmux binary is installed */
  installed: boolean;
  /** tmux version string (e.g. "tmux 3.3a") */
  version: string | null;
  /** Whether ~/.tmux.conf has our managed config */
  tmuxConfConfigured: boolean;
  /** Whether ~/.bashrc has the auto-start block */
  bashrcConfigured: boolean;
  /** Whether currently inside a tmux session */
  inTmuxSession: boolean;
  /** Overall: fully configured */
  fullyConfigured: boolean;
  /** Features list when configured */
  features: string[];
  /** Current config settings */
  config: TmuxConfig;
}

function getTmuxStatus(): TmuxStatus {
  // Check if tmux is installed
  let installed = false;
  let version: string | null = null;
  try {
    const out = execFileSync('tmux', ['-V'], { encoding: 'utf-8', timeout: 5000 }).trim();
    installed = true;
    version = out;
  } catch {
    installed = false;
  }

  const config = loadConfig();

  // Check ~/.tmux.conf
  let tmuxConfConfigured = false;
  const features: string[] = [];
  try {
    const content = fs.readFileSync(TMUX_CONF, 'utf-8');
    // Detect managed config by checking for our key entries
    if (content.includes('set -g status ')) {
      tmuxConfConfigured = true;
      if (content.includes('set -g status off')) {
        features.push('Hidden status bar');
      } else {
        features.push('Visible status bar');
      }
    }
    if (content.includes('set -g mouse on')) {
      features.push('Mouse support');
    }
    if (content.includes('WheelUpPane')) {
      features.push('Scroll enters copy mode');
    }
    if (content.includes('tmux-typing-exits-copy')) {
      features.push('Typing exits copy mode');
    }
    if (content.includes('unbind -n MouseDown3Pane')) {
      features.push('Right-click passthrough');
    }
    if (content.includes('history-limit')) {
      const match = content.match(/history-limit\s+(\d+)/);
      if (match) {
        const limit = parseInt(match[1]);
        features.push(`${(limit / 1000000).toFixed(0)}M scrollback`);
      }
    }
    if (content.includes('destroy-unattached on')) {
      features.push('Auto-close sessions');
    }
  } catch {
    // File doesn't exist or not readable
  }

  // Check ~/.bashrc
  let bashrcConfigured = false;
  try {
    const content = fs.readFileSync(BASHRC, 'utf-8');
    bashrcConfigured = content.includes(MARKER);
  } catch {
    // File doesn't exist or not readable
  }

  const inTmuxSession = !!process.env.TMUX;

  return {
    installed,
    version,
    tmuxConfConfigured,
    bashrcConfigured,
    inTmuxSession,
    fullyConfigured: installed && tmuxConfConfigured && bashrcConfigured,
    features,
    config,
  };
}

/**
 * Build the ~/.tmux.conf content based on current config settings.
 */
function buildTmuxConfContent(config: TmuxConfig): string {
  const lines: string[] = [];

  // Status bar
  lines.push(config.statusBar ? '# Show the status bar' : '# Hide the status bar');
  lines.push(`set -g status ${config.statusBar ? 'on' : 'off'}`);
  lines.push('');

  // Mouse support
  lines.push('# Enable mouse support');
  lines.push('set -g mouse on');
  lines.push('');

  // Terminal features
  lines.push('# Pre-declare terminal features so tmux does not probe with DA queries');
  lines.push('# (Prevents xterm.js DA2 responses like [>0;276;0c leaking into pane input)');
  lines.push('set -s terminal-features[0] "xterm*:256:clipboard:ccolour:cstyle:focus:mouse:overline:rectfill:RGB:strikethrough:title:usstyle"');
  lines.push('set -s terminal-features[1] "screen*:title"');
  lines.push('');

  // Escape time
  lines.push('# Low escape-time to reduce the window for DA response leaking (default 500 is far too high)');
  lines.push('set -sg escape-time 25');
  lines.push('');

  // Scroll
  lines.push('# Scroll up enters copy mode with -e (auto-exits when you scroll back to bottom)');
  lines.push(`bind -n WheelUpPane if-shell -Ft= '#{mouse_any_flag}' 'send-keys -M' 'if -Ft= "#{pane_in_mode}" "send-keys -M" "copy-mode -e; send-keys -M"'`);
  lines.push('');

  // Typing exits copy mode
  lines.push('# Any typing key exits copy mode and passes through to the app');
  lines.push('run-shell "bash ~/.tmux-typing-exits-copy.sh"');
  lines.push('');

  // Right-click passthrough
  lines.push('# Disable tmux right-click menu — let terminal handle copy/paste natively');
  lines.push('unbind -n MouseDown3Pane');
  lines.push('unbind -n M-MouseDown3Pane');
  lines.push('unbind -n MouseDown3Status');
  lines.push('unbind -n MouseDown3StatusLeft');
  lines.push('unbind -n MouseDown3StatusRight');
  lines.push('');

  // Scrollback
  lines.push('# Increase scrollback buffer');
  lines.push('set -g history-limit 1000000');

  // Destroy unattached sessions
  if (config.destroyUnattached) {
    lines.push('');
    lines.push('# Auto-close session when terminal disconnects (client detaches)');
    lines.push('set -g destroy-unattached on');
  }

  return lines.join('\n');
}

/**
 * Write ~/.tmux.conf from config and reload if inside tmux.
 */
function applyTmuxConf(config: TmuxConfig): void {
  const content = buildTmuxConfContent(config);
  fs.writeFileSync(TMUX_CONF, content + '\n');

  // Reload live tmux server if running
  try {
    execFileSync('tmux', ['source-file', TMUX_CONF], { timeout: 5000, stdio: 'ignore' });
  } catch {
    // tmux server may not be running — that's fine
  }
}

function runTmuxScript(action: 'install' | 'uninstall'): Promise<{ success: boolean; output: string }> {
  return new Promise((resolve) => {
    // Find the script relative to this file's location in the project
    // Script is at tier-agent-core/scripts/tmux-autostart.sh
    const scriptPath = path.resolve(__dirname, '../../../scripts/tmux-autostart.sh');

    if (!fs.existsSync(scriptPath)) {
      resolve({ success: false, output: `Script not found at ${scriptPath}` });
      return;
    }

    execFile('bash', [scriptPath, action], {
      timeout: 15000,
      env: { ...process.env, HOME: os.homedir() },
    }, (error, stdout, stderr) => {
      if (error) {
        resolve({ success: false, output: stderr || error.message });
      } else {
        resolve({ success: true, output: stdout.trim() });
      }
    });
  });
}

export function createTmuxRoutes(_ctx: RouteContext): RouteHandler[] {
  // Platform guard: on Windows, return stub routes that report unsupported
  if (IS_WINDOWS) {
    const unsupportedStatus = {
      installed: false,
      version: null,
      tmuxConfConfigured: false,
      bashrcConfigured: false,
      inTmuxSession: false,
      fullyConfigured: false,
      features: [],
      config: { ...DEFAULT_CONFIG },
      platformSupported: false,
    };
    return [
      {
        method: 'GET',
        pattern: /^\/tmux\/status$/,
        handler: async () => ({ success: true, data: unsupportedStatus }),
      },
      {
        method: 'POST',
        pattern: /^\/tmux\/install$/,
        handler: async () => ({ success: false, error: 'tmux is not supported on Windows', data: unsupportedStatus }),
      },
      {
        method: 'POST',
        pattern: /^\/tmux\/uninstall$/,
        handler: async () => ({ success: false, error: 'tmux is not supported on Windows', data: unsupportedStatus }),
      },
      {
        method: 'PUT',
        pattern: /^\/tmux\/config$/,
        handler: async () => ({ success: false, error: 'tmux is not supported on Windows', data: unsupportedStatus }),
      },
    ];
  }

  return [
    // GET /tmux/status - Check tmux installation and configuration status
    {
      method: 'GET',
      pattern: /^\/tmux\/status$/,
      handler: async () => {
        const status = getTmuxStatus();
        return { success: true, data: status };
      },
    },

    // POST /tmux/install - Install tmux auto-start configuration
    {
      method: 'POST',
      pattern: /^\/tmux\/install$/,
      handler: async () => {
        const result = await runTmuxScript('install');
        // After install, apply our managed config on top (so config settings are respected)
        const config = loadConfig();
        applyTmuxConf(config);
        const status = getTmuxStatus();
        return {
          success: result.success,
          data: { ...status, output: result.output },
        };
      },
    },

    // POST /tmux/uninstall - Remove tmux auto-start configuration
    {
      method: 'POST',
      pattern: /^\/tmux\/uninstall$/,
      handler: async () => {
        const result = await runTmuxScript('uninstall');
        // Re-check status after uninstall
        const status = getTmuxStatus();
        return {
          success: result.success,
          data: { ...status, output: result.output },
        };
      },
    },

    // PUT /tmux/config - Update tmux settings
    {
      method: 'PUT',
      pattern: /^\/tmux\/config$/,
      handler: async (req) => {
        const body = req.body || {};
        const current = loadConfig();
        let changed = false;

        if (typeof body.statusBar === 'boolean' && body.statusBar !== current.statusBar) {
          current.statusBar = body.statusBar;
          changed = true;
        }
        if (typeof body.destroyUnattached === 'boolean' && body.destroyUnattached !== current.destroyUnattached) {
          current.destroyUnattached = body.destroyUnattached;
          changed = true;
        }

        if (changed) {
          saveConfig(current);
          // Rewrite ~/.tmux.conf and reload
          applyTmuxConf(current);
        }

        const status = getTmuxStatus();
        return { success: true, data: status };
      },
    },
  ];
}
