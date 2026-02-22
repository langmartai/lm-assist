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

const projectRoot = path.dirname(path.dirname(__filename));
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

const validCommands = ['start', 'stop', 'restart', 'status', 'logs', 'help'];

if (command === 'help' || command === '--help' || command === '-h') {
  console.log(`
lm-assist - LM Assistant CLI

Usage: lm-assist <command> [options]

Commands:
  start              Start API (port 3100) and Web (port 3848) services
  stop               Stop all services
  restart            Restart services
  status             Show service status and health check
  logs [core|web]    View service logs (last 100 lines)
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

async function main() {
  const svc = loadSm();

  switch (command) {
    case 'start': {
      console.log('Starting lm-assist services...\n');
      const result = await svc.startAll();
      console.log(`  Core API: ${result.core.message}`);
      console.log(`  Web:      ${result.web.message}`);
      if (result.core.success && result.web.success) {
        console.log('\nAll services started.');
      } else {
        process.exitCode = 1;
      }
      break;
    }

    case 'stop': {
      console.log('Stopping lm-assist services...\n');
      const result = await svc.stopAll();
      console.log(`  Core API: ${result.core.message}`);
      console.log(`  Web:      ${result.web.message}`);
      break;
    }

    case 'restart': {
      console.log('Restarting lm-assist services...\n');
      const result = await svc.restartAll();
      console.log(`  Core API: ${result.core.message}`);
      console.log(`  Web:      ${result.web.message}`);
      if (!result.core.success || !result.web.success) {
        process.exitCode = 1;
      }
      break;
    }

    case 'status': {
      const s = await svc.status();
      console.log('lm-assist Service Status\n');
      const coreStatus = s.core.healthy ? 'Running & Healthy' : s.core.running ? 'Running (Unhealthy)' : 'Not Running';
      const webStatus = s.web.running ? 'Running' : 'Not Running';
      console.log(`  Core API (port ${s.core.port}):  ${coreStatus}${s.core.pid ? ` (PID ${s.core.pid})` : ''}`);
      console.log(`  Web      (port ${s.web.port}):  ${webStatus}${s.web.pid ? ` (PID ${s.web.pid})` : ''}`);

      if (s.core.running || s.web.running) {
        console.log('\nURLs:');
        if (s.core.running) console.log(`  Core API:  http://localhost:${s.core.port}`);
        if (s.web.running) console.log(`  Web:       http://localhost:${s.web.port}`);
      }
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
