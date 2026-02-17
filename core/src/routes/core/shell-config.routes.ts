/**
 * Shell Configuration Routes
 *
 * Endpoints for managing shell configuration for plain shell terminals.
 *
 * Endpoints:
 *   GET  /shell/config   Get shell configuration
 *   PUT  /shell/config   Update shell configuration
 */

import type { RouteHandler, RouteContext } from '../index';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const SHELL_CONFIG_PATH = path.join(os.homedir(), '.langmart', 'shell-config.json');

interface ShellConfig {
  shell: string;
}

export function readShellConfig(): ShellConfig {
  try {
    const data = fs.readFileSync(SHELL_CONFIG_PATH, 'utf-8');
    const parsed = JSON.parse(data);
    if (parsed.shell && typeof parsed.shell === 'string') {
      return { shell: parsed.shell };
    }
  } catch {
    // File doesn't exist or is invalid
  }
  // Fallback: use SHELL env var or /bin/bash
  return { shell: process.env.SHELL || '/bin/bash' };
}

function writeShellConfig(config: ShellConfig): void {
  const dir = path.dirname(SHELL_CONFIG_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(SHELL_CONFIG_PATH, JSON.stringify(config, null, 2));
}

export function createShellConfigRoutes(ctx: RouteContext): RouteHandler[] {
  return [
    // GET /shell/config
    {
      method: 'GET',
      pattern: /^\/shell\/config$/,
      handler: async (req, api) => {
        const config = readShellConfig();
        return {
          success: true,
          data: config,
        };
      },
    },

    // PUT /shell/config
    {
      method: 'PUT',
      pattern: /^\/shell\/config$/,
      handler: async (req, api) => {
        const { shell } = req.body || {};

        if (!shell || typeof shell !== 'string') {
          return {
            success: false,
            error: 'shell path is required (string)',
          };
        }

        // Validate the shell path exists
        if (!fs.existsSync(shell)) {
          return {
            success: false,
            error: `Shell path does not exist: ${shell}`,
          };
        }

        writeShellConfig({ shell });

        return {
          success: true,
          data: { shell },
        };
      },
    },
  ];
}
