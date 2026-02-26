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

/** Always returns the npm package path (prod). Dev mode no longer switches this. */
function getProjectRoot() {
  const fromFilename = path.dirname(path.dirname(__filename));
  if (fromFilename.includes('node_modules')) {
    return fromFilename;
  }
  return findNpmPackage() || fromFilename;
}

/** Read devModeEnabled + devRepoPath from ~/.claude-code-config.json */
function getDevConfig() {
  try {
    const cfgPath = path.join(os.homedir(), '.claude-code-config.json');
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
    return {
      enabled: !!cfg.devModeEnabled,
      repoPath: cfg.devRepoPath || null,
    };
  } catch {
    return { enabled: false, repoPath: null };
  }
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
  logs [core|web]    View service logs (last 100 lines, --dev for dev logs)
  upgrade            Upgrade to latest version (npm + plugin + restart)
  help               Show this help message

Examples:
  lm-assist start
  lm-assist stop
  lm-assist status
  lm-assist logs core
  lm-assist logs core --dev

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
  const devCfg = getDevConfig();

  switch (command) {
    case 'start': {
      console.log('Starting lm-assist services...\n');
      // Always start prod
      const result = await svc.startAll();
      console.log('  Prod:');
      console.log(`    API: ${result.core.message}`);
      console.log(`    Web: ${result.web.message}`);
      // If dev mode enabled, also start dev
      if (devCfg.enabled && devCfg.repoPath) {
        console.log('');
        const devResult = await svc.startDevAll(devCfg.repoPath);
        console.log('  Dev:');
        console.log(`    API: ${devResult.core.message}`);
        console.log(`    Web: ${devResult.web.message}`);
        if (!devResult.core.success || !devResult.web.success) {
          process.exitCode = 1;
        }
      }
      if (result.core.success && result.web.success) {
        printComponents(svc);
      } else {
        process.exitCode = 1;
      }
      break;
    }

    case 'stop': {
      console.log('Stopping lm-assist services...\n');
      // Stop dev first if enabled
      if (devCfg.enabled) {
        const devResult = await svc.stopDevAll();
        console.log('  Dev:');
        console.log(`    API: ${devResult.core.message}`);
        console.log(`    Web: ${devResult.web.message}`);
        console.log('');
      }
      // Then stop prod
      const result = await svc.stopAll();
      console.log('  Prod:');
      console.log(`    API: ${result.core.message}`);
      console.log(`    Web: ${result.web.message}`);
      break;
    }

    case 'restart': {
      console.log('Restarting lm-assist services...\n');
      // Stop dev first if enabled
      if (devCfg.enabled) {
        await svc.stopDevAll();
      }
      // Stop + start prod
      const result = await svc.restartAll();
      console.log('  Prod:');
      console.log(`    API: ${result.core.message}`);
      console.log(`    Web: ${result.web.message}`);
      // Restart dev if enabled
      if (devCfg.enabled && devCfg.repoPath) {
        console.log('');
        const devResult = await svc.startDevAll(devCfg.repoPath);
        console.log('  Dev:');
        console.log(`    API: ${devResult.core.message}`);
        console.log(`    Web: ${devResult.web.message}`);
        if (!devResult.core.success || !devResult.web.success) {
          process.exitCode = 1;
        }
      }
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
      console.log('  Prod:');
      console.log(`    API (port ${s.core.port}):  ${apiStatus}${s.core.pid ? ` (PID ${s.core.pid})` : ''}`);
      console.log(`    Web (port ${s.web.port}):  ${webStatus}${s.web.pid ? ` (PID ${s.web.pid})` : ''}`);
      // Show dev status if enabled
      if (devCfg.enabled && typeof svc.devStatus === 'function') {
        const ds = await svc.devStatus();
        const devApiStatus = ds.core.healthy ? 'Running' : ds.core.running ? 'Unhealthy' : 'Stopped';
        const devWebStatus = ds.web.running ? 'Running' : 'Stopped';
        console.log('  Dev:');
        console.log(`    API (port ${ds.core.port}):  ${devApiStatus}${ds.core.pid ? ` (PID ${ds.core.pid})` : ''}`);
        console.log(`    Web (port ${ds.web.port}):  ${devWebStatus}${ds.web.pid ? ` (PID ${ds.web.pid})` : ''}`);
      }
      printComponents(svc);
      break;
    }

    case 'logs': {
      const isDev = args.includes('--dev');
      const service = args.find(a => ['core', 'web'].includes(a));
      if (!service) {
        console.error('Usage: lm-assist logs [core|web] [--dev]');
        process.exitCode = 1;
        break;
      }
      if (isDev && typeof svc.readDevLog === 'function') {
        const log = svc.readDevLog(service, 100);
        console.log(log);
      } else {
        const log = svc.readLog(service, 100);
        console.log(log);
      }
      break;
    }

  }
}

main().catch((err) => {
  console.error('Error:', err.message || err);
  process.exit(1);
});
