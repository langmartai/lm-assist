#!/usr/bin/env node

/**
 * LM Assist CLI
 *
 * Usage:
 *   lm-assist start        Start API and Web services
 *   lm-assist stop         Stop all services
 *   lm-assist restart      Restart services
 *   lm-assist status       Show service status
 *   lm-assist logs [core|web]  View service logs
 */

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const projectRoot = path.dirname(path.dirname(__filename));
const coreShPath = path.join(projectRoot, 'core.sh');

// Get command from argv
const command = process.argv[2] || 'help';
const args = process.argv.slice(3);

// Ensure core.sh exists
if (!fs.existsSync(coreShPath)) {
  console.error(`Error: core.sh not found at ${coreShPath}`);
  process.exit(1);
}

// Make core.sh executable
fs.chmodSync(coreShPath, 0o755);

// Valid commands
const validCommands = ['start', 'stop', 'restart', 'status', 'logs', 'build', 'clean', 'test', 'hub'];

if (command === 'help' || command === '--help' || command === '-h') {
  console.log(`
lm-assist - LM Assistant CLI

Usage: lm-assist <command> [options]

Commands:
  start              Start API (port 3100) and Web (port 3848) services
  stop               Stop all services
  restart            Restart services
  status             Show service status and health check
  logs [core|web]    View service logs
  build              Build TypeScript (core) and Next.js (web)
  clean              Clean and rebuild everything
  test               Run API endpoint tests
  hub                Hub client commands (start, stop, status, logs)
  help               Show this help message

Examples:
  lm-assist start
  lm-assist restart
  lm-assist logs core
  lm-assist status

More info: https://github.com/langmartai/lm-assist
`);
  process.exit(0);
}

if (!validCommands.includes(command)) {
  console.error(`Unknown command: ${command}`);
  console.error('Run "lm-assist help" for usage information');
  process.exit(1);
}

// Execute core.sh with the command
const coreProcess = spawn('bash', [coreShPath, command, ...args], {
  cwd: projectRoot,
  stdio: 'inherit',
  shell: true
});

coreProcess.on('exit', (code) => {
  process.exit(code);
});

coreProcess.on('error', (err) => {
  console.error(`Error executing core.sh: ${err.message}`);
  process.exit(1);
});
