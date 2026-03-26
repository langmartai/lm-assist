#!/usr/bin/env node
/**
 * Post-install script for lm-assist npm package.
 *
 * Runs after `npm install -g lm-assist`. Auto-starts services
 * and installs statusline if Claude Code is available.
 *
 * All steps are best-effort — failures are logged but don't block install.
 */

const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

function log(msg) { console.log(`${GREEN}[lm-assist]${RESET} ${msg}`); }
function warn(msg) { console.log(`${YELLOW}[lm-assist]${RESET} ${msg}`); }
function dim(msg) { console.log(`${DIM}[lm-assist] ${msg}${RESET}`); }

// Only run for global installs (not when building from source)
const isGlobal = __dirname.includes('node_modules');
if (!isGlobal) {
  dim('Source install detected — skipping postinstall auto-setup');
  process.exit(0);
}

log('Post-install setup...');

// 1. Start services (non-blocking, best effort)
try {
  const cliPath = path.join(__dirname, 'lm-assist.js');
  if (fs.existsSync(cliPath)) {
    execFileSync('node', [cliPath, 'start'], {
      stdio: 'pipe',
      timeout: 30000,
    });
    log('Services started (API :3100, Web :3848)');
  }
} catch {
  dim('Services may already be running or will start on next `lm-assist start`');
}

// 2. Install statusline (if API is running)
try {
  const http = require('http');
  const req = http.request(
    { hostname: '127.0.0.1', port: 3100, path: '/claude-code/statusline/install', method: 'POST', timeout: 5000 },
    (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const d = JSON.parse(data);
          if (d.success) log('Statusline installed');
          else dim('Statusline: ' + (d.error || 'skipped'));
        } catch {
          dim('Statusline: API not ready yet');
        }
      });
    }
  );
  req.on('error', () => dim('Statusline: API not running yet — install via /assist-setup'));
  req.on('timeout', () => { req.destroy(); });
  req.end();
} catch {
  dim('Statusline: will install on next /assist-setup');
}

// 3. Check if claude-one plugin is installed
try {
  const result = execFileSync('claude', ['plugin', 'list'], {
    encoding: 'utf-8',
    timeout: 10000,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (!result.includes('claude-one')) {
    log('Installing claude-one plugin (skills + commands)...');
    try {
      execFileSync('claude', ['plugin', 'marketplace', 'add', 'langmartai/lm-assist'], {
        stdio: 'pipe', timeout: 30000,
      });
    } catch { /* marketplace may already exist */ }
    try {
      execFileSync('claude', ['plugin', 'install', 'claude-one@langmartai'], {
        stdio: 'pipe', timeout: 60000,
      });
      log('claude-one plugin installed');
    } catch {
      warn('Could not auto-install claude-one. Run in Claude Code: /plugin install claude-one@langmartai');
    }
  } else {
    dim('claude-one plugin already installed');
  }
} catch {
  dim('Claude Code CLI not found — install claude-one plugin manually in Claude Code');
}

log('Setup complete. Open a new Claude Code session and try /sessions');
