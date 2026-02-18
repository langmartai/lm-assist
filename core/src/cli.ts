#!/usr/bin/env node
/**
 * lm-assist CLI
 *
 * Usage:
 *   lm-assist serve [options]    Start REST API server
 *
 * Options:
 *   --port, -p       Server port (default: 3100)
 *   --host, -h       Server host (default: 0.0.0.0)
 *   --project, -d    Project directory (default: cwd)
 *   --api-key        API key for authentication
 */

import { startServer } from './index';
import { getHubClient, isHubConfigured } from './hub-client';
import { getStartupProfiler } from './startup-profiler';

// Parse arguments
const args = process.argv.slice(2);
const command = args[0];

function getArg(names: string[], defaultValue?: string): string | undefined {
  for (let i = 0; i < args.length; i++) {
    for (const name of names) {
      if (args[i] === name && args[i + 1]) {
        return args[i + 1];
      }
      if (args[i].startsWith(`${name}=`)) {
        return args[i].split('=')[1];
      }
    }
  }
  return defaultValue;
}

const projectPath = getArg(['--project', '-d'], process.cwd())!;
const port = parseInt(getArg(['--port', '-p'], '3100')!);
const host = getArg(['--host', '-h'], '0.0.0.0')!;

async function main() {
  switch (command) {
    case 'serve':
    case 'server':
    case undefined:
      await runServer();
      break;

    case 'help':
    case '--help':
    case '-h':
      showHelp();
      break;

    default:
      console.error(`Unknown command: ${command}`);
      console.error('Run "lm-assist help" for usage');
      process.exit(1);
  }
}

async function runServer() {
  const profiler = getStartupProfiler();
  profiler.start('total', 'Total Startup');

  const hubConfigured = isHubConfigured();
  const hubUrl = process.env.TIER_AGENT_HUB_URL || '';

  console.log(`
╔══════════════════════════════════════════════════════════════╗
║                      LM-ASSIST API SERVER                    ║
╠══════════════════════════════════════════════════════════════╣
║  Project:  ${projectPath.padEnd(48)}║
║  Server:   http://${host}:${port}${' '.repeat(Math.max(0, 40 - host.length - String(port).length))}║
${hubConfigured ? `║  Hub:      ${hubUrl.substring(0, 47).padEnd(47)}║` : '║  Hub:      Not configured                                    ║'}
╚══════════════════════════════════════════════════════════════╝
  `);

  try {
    profiler.start('startServer', 'Server Init + Listen');
    const server = await startServer(projectPath, port);
    profiler.end('startServer');

    // Start hub client connection if configured
    let hubClient = null;
    if (hubConfigured) {
      console.log('Connecting to Hub...');
      const assistWebPort = process.env.ASSIST_WEB_PORT ? parseInt(process.env.ASSIST_WEB_PORT, 10) : 3848;
      hubClient = getHubClient({ localApiPort: port, assistWebPort });

      hubClient.on('connected', () => {
        console.log('Hub: WebSocket connected');
      });

      hubClient.on('authenticated', (data) => {
        console.log(`Hub: Authenticated as worker ${data.gatewayId}`);
      });

      hubClient.on('disconnected', (reason) => {
        console.log(`Hub: Disconnected - ${reason}`);
      });

      hubClient.on('error', (err) => {
        console.error('Hub: Error -', err.message);
      });

      profiler.start('hubConnect', 'Hub Connect (async)');
      hubClient.connect().then(() => {
        profiler.end('hubConnect');
      }).catch(err => {
        profiler.end('hubConnect');
        console.error('Hub: Initial connection failed -', err.message);
        console.log('Hub: Will retry connection...');
      });
    }

    profiler.end('total');
    profiler.summary();

    console.log('Press Ctrl+C to stop');

    // Handle shutdown
    process.on('SIGINT', async () => {
      console.log('\nShutting down...');
      if (hubClient) {
        await hubClient.disconnect();
      }
      await server.stop();
      process.exit(0);
    });

    process.on('SIGTERM', async () => {
      if (hubClient) {
        await hubClient.disconnect();
      }
      await server.stop();
      process.exit(0);
    });

  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

function showHelp() {
  console.log(`
lm-assist CLI

Usage:
  lm-assist <command> [options]

Commands:
  serve             Start REST API server (default)
  help              Show this help

Options:
  --port, -p        Server port (default: 3100)
  --host, -h        Server host (default: 0.0.0.0)
  --project, -d     Project directory (default: current)

Examples:
  lm-assist serve --port 8080
  lm-assist serve
  `);
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
