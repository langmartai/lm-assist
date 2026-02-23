#!/usr/bin/env node

/**
 * LM Assist CLI — Cross-platform service manager
 *
 * Usage:
 *   lm-assist start           Start API and Web services
 *   lm-assist stop            Stop all services
 *   lm-assist restart         Restart services
 *   lm-assist status          Show service status
 *   lm-assist logs [core|web] View service logs
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

function getProjectRoot() {
  try {
    const cfgPath = path.join(os.homedir(), '.claude-code-config.json');
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));

    // Dev mode ON → use repo
    if (cfg.devModeEnabled && cfg.devRepoPath) {
      const devSm = path.join(cfg.devRepoPath, 'core', 'dist', 'service-manager.js');
      if (fs.existsSync(devSm)) return cfg.devRepoPath;
    }

    // Dev mode OFF → always use npm global package
    const fromFilename = path.dirname(path.dirname(__filename));
    if (fromFilename.includes('node_modules')) {
      return fromFilename; // Already running from npm global
    }
    // Running from repo but devMode is off → find npm global package
    return findNpmPackage() || fromFilename;
  } catch {}
  return path.dirname(path.dirname(__filename));
}

function findNpmPackage() {
  // Derive npm global root from node executable path (no process spawn needed)
  // e.g. C:\nvm4w\nodejs\node.exe → C:\nvm4w\nodejs\node_modules\lm-assist
  //      /usr/local/bin/node → /usr/local/lib/node_modules/lm-assist
  const nodeDir = path.dirname(process.execPath);
  const candidates = [
    path.join(nodeDir, 'node_modules', 'lm-assist'),            // Windows (nvm4w, standard)
    path.join(nodeDir, '..', 'lib', 'node_modules', 'lm-assist'), // Linux/macOS
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, 'core', 'dist', 'service-manager.js'))) {
      return candidate;
    }
  }
  return null;
}

const projectRoot = getProjectRoot();
const smPath = path.join(projectRoot, 'core', 'dist', 'service-manager');

// Lazy-load service-manager (compiled TypeScript)
let sm;
function loadSm() {
  if (sm) return sm;
  try {
    sm = require(smPath);
    return sm;
  } catch (err) {
    console.error('Error: Could not load service-manager. Is the core built?');
    console.error(`  Expected: ${smPath}.js`);
    console.error(`  Run: cd ${projectRoot} && npm run build:core`);
    process.exit(1);
  }
}

// Get command from argv
const command = process.argv[2] || 'help';
const args = process.argv.slice(3);

const validCommands = ['start', 'stop', 'restart', 'status', 'logs', 'upgrade', 'help'];

if (command === 'help' || command === '--help' || command === '-h') {
  console.log(`
lm-assist - LM Assistant CLI

Usage: lm-assist <command> [options]

Commands:
  start              Start API and Web services
  stop               Stop all services
  restart            Restart services
  status             Show service status and component locations
  logs [core|web]    View service logs (last 100 lines)
  upgrade            Upgrade to latest version (npm + plugin + restart)
  help               Show this help message

Examples:
  lm-assist start
  lm-assist stop
  lm-assist status
  lm-assist logs core

More info: https://github.com/langmartai/lm-assist
`);
  process.exit(0);
}

if (!validCommands.includes(command)) {
  console.error(`Unknown command: ${command}`);
  console.error('Run "lm-assist help" for usage information');
  process.exit(1);
}

// Handle upgrade separately — doesn't need service-manager
if (command === 'upgrade') {
  console.log('Upgrading lm-assist...\n');
  const upgradeScript = path.join(path.dirname(path.dirname(__filename)), 'core', 'scripts', 'upgrade.js');
  if (!fs.existsSync(upgradeScript)) {
    console.error('Upgrade script not found at:', upgradeScript);
    process.exit(1);
  }
  // Copy to temp so the script doesn't hold a file lock on the npm package
  // directory (Windows EBUSY when npm tries to rename core/).
  const tmpScript = path.join(os.tmpdir(), `lm-assist-upgrade-${Date.now()}.js`);
  fs.copyFileSync(upgradeScript, tmpScript);
  const { execFileSync } = require('child_process');
  try {
    execFileSync(process.execPath, [tmpScript], {
      stdio: 'inherit',
      env: process.env,
      windowsHide: true,
    });
  } catch (err) {
    process.exit(err.status || 1);
  }
  process.exit(0);
}

/**
 * Print component locations after start/restart/status
 */
function printComponents(svc) {
  if (typeof svc.getComponentInfo !== 'function') return;
  const info = svc.getComponentInfo();
  console.log('\nComponent Locations');
  console.log(`  Core API    ${info.api.path}`);
  console.log(`              ${info.api.source}`);
  console.log(`  Web UI      ${info.web.path}`);
  console.log(`              ${info.web.source}`);
  if (info.mcp.installed) {
    console.log(`  MCP Server  ${info.mcp.location}`);
    console.log(`              ${info.mcp.source}`);
  } else {
    console.log('  MCP Server  (not installed)');
  }
  if (info.hook.installed) {
    console.log(`  Hook        ${info.hook.location}`);
    console.log(`              ${info.hook.source}`);
  } else {
    console.log('  Hook        (not installed)');
  }
  if (info.statusline.installed) {
    console.log(`  Statusline  ${info.statusline.location}`);
    console.log(`              ${info.statusline.source}`);
  } else {
    console.log('  Statusline  (not installed)');
  }
}

async function main() {
  const svc = loadSm();

  switch (command) {
    case 'start': {
      console.log('Starting lm-assist services...\n');
      const result = await svc.startAll();
      console.log(`  API: ${result.core.message}`);
      console.log(`  Web: ${result.web.message}`);
      if (result.core.success && result.web.success) {
        printComponents(svc);
      } else {
        process.exitCode = 1;
      }
      break;
    }

    case 'stop': {
      console.log('Stopping lm-assist services...\n');
      const result = await svc.stopAll();
      console.log(`  API: ${result.core.message}`);
      console.log(`  Web: ${result.web.message}`);
      break;
    }

    case 'restart': {
      console.log('Restarting lm-assist services...\n');
      const result = await svc.restartAll();
      console.log(`  API: ${result.core.message}`);
      console.log(`  Web: ${result.web.message}`);
      if (result.core.success && result.web.success) {
        printComponents(svc);
      } else {
        process.exitCode = 1;
      }
      break;
    }

    case 'status': {
      const s = await svc.status();
      console.log('lm-assist Status\n');
      const apiStatus = s.core.healthy ? 'Running' : s.core.running ? 'Unhealthy' : 'Stopped';
      const webStatus = s.web.running ? 'Running' : 'Stopped';
      console.log(`  API (port ${s.core.port}):  ${apiStatus}${s.core.pid ? ` (PID ${s.core.pid})` : ''}`);
      console.log(`  Web (port ${s.web.port}):  ${webStatus}${s.web.pid ? ` (PID ${s.web.pid})` : ''}`);
      printComponents(svc);
      break;
    }

    case 'logs': {
      const service = args[0];
      if (!service || !['core', 'web'].includes(service)) {
        console.error('Usage: lm-assist logs [core|web]');
        process.exitCode = 1;
        break;
      }
      const log = svc.readLog(service, 100);
      console.log(log);
      break;
    }

  }
}

main().catch((err) => {
  console.error('Error:', err.message || err);
  process.exit(1);
});
