#!/usr/bin/env node
/**
 * lm-assist CLI
 *
 * Usage:
 *   lm-assist serve [options]    Start REST API server
 *
 * Options:
 *   --port, -p       Server port (default: 3100 prod / 3200 dev)
 *   --host, -h       Server host (default: 0.0.0.0)
 *   --project, -d    Project directory (default: cwd)
 *   --api-key        API key for authentication
 */

import * as os from 'os';
import { startServer } from './index';
import { getHubClient, isHubConfigured } from './hub-client';
import { saveHubConnectionConfig } from './hub-client/hub-config';
import { getStartupProfiler } from './startup-profiler';
import { startLogRotation } from './utils/log-rotate';

// Dev repo → 3200/3948, npm package → 3100/3848
// Override with LM_ASSIST_PROD=true to use prod ports/identity from dev repo
const IS_DEV_REPO = process.env.LM_ASSIST_PROD === 'true'
  ? false
  : !__dirname.includes('node_modules');
const DEFAULT_API_PORT = IS_DEV_REPO ? '3200' : '3100';
const DEFAULT_WEB_PORT = IS_DEV_REPO ? '3948' : '3848';

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

const projectPath = getArg(['--project', '-d'], os.homedir())!;
const port = parseInt(getArg(['--port', '-p'], process.env.API_PORT || DEFAULT_API_PORT)!);
const host = getArg(['--host', '-h'], '0.0.0.0')!;
// Extra CA bundle for outbound TLS from spawned helpers (e.g. CCR scripts behind an
// MITM proxy). Honors --extra-ca or the LM_ASSIST_EXTRA_CA env; exported so child
// processes inherit it as NODE_EXTRA_CA_CERTS when one isn't already set.
const extraCa = getArg(['--extra-ca'], process.env.LM_ASSIST_EXTRA_CA);
if (extraCa) process.env.LM_ASSIST_EXTRA_CA = extraCa;

// Opt-in HTTPS terminator (secure-context voice transport): `serve --https` is
// sugar for LM_HTTPS=1 (see rest-server.maybeStartHttps).
if (args.includes('--https')) process.env.LM_HTTPS = '1';

// The Core's OWN outbound fetch (the cloud-API calls in ccr-cloud.ts run IN this
// process, not a spawned helper) must also trust the extra CA — else behind an
// MITM proxy (lm-proxy) every fetch fails with "self-signed certificate in chain".
// NODE_EXTRA_CA_CERTS is read at Node startup, so if it isn't already set we re-exec
// this process ONCE with it set. Fail-safe: any error falls through to a normal start.
let _reExecedForCa = false;
if ((command === 'serve' || command === 'server') && extraCa && !process.env.NODE_EXTRA_CA_CERTS) {
  try {
    const fsmod = require('fs') as typeof import('fs');
    if (fsmod.existsSync(extraCa)) {
      const cp = require('child_process') as typeof import('child_process');
      const child = cp.spawn(process.execPath, process.argv.slice(1), {
        stdio: 'inherit',
        env: { ...process.env, NODE_EXTRA_CA_CERTS: extraCa },
      });
      _reExecedForCa = true;
      const fwd = (sig: NodeJS.Signals) => { try { child.kill(sig); } catch { /* child already gone */ } };
      process.on('SIGTERM', () => fwd('SIGTERM'));
      process.on('SIGINT', () => fwd('SIGINT'));
      child.on('exit', (code, signal) => process.exit(signal ? 1 : (code ?? 0)));
    }
  } catch { _reExecedForCa = false; }
}

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

  // Cap the redirected stdout/stderr log so a long-lived node can't grow it
  // without bound (per-request relay logging reached 2.6 GB). Runs one pass now
  // to shrink an already-huge log from a prior run, then every 5 minutes.
  startLogRotation();

  const hubConfigured = isHubConfigured();
  const hubUrl = process.env.TIER_AGENT_HUB_URL || '';

  console.log(`
╔══════════════════════════════════════════════════════════════╗
║                      LM-ASSIST API SERVER                    ║
╠══════════════════════════════════════════════════════════════╣
║  Project:  ${projectPath.padEnd(48)}║
║  Server:   http://${host}:${port}${' '.repeat(Math.max(0, 40 - host.length - String(port).length))}║
${hubConfigured ? `║  Hub:      ${hubUrl.substring(0, 47).padEnd(47)}║` : `║  Hub:      Not configured - http://localhost:${DEFAULT_WEB_PORT}/settings   ║`}
╚══════════════════════════════════════════════════════════════╝
  `);

  try {
    profiler.start('startServer', 'Server Init + Listen');
    const server = await startServer(projectPath, port, host);
    profiler.end('startServer');

    // Pre-warm the embedder + vector store in the background (async, non-blocking)
    // This eliminates the cold-start delay on the first search request
    // Skip if knowledge is disabled (kill switch) to save memory
    const { getProjectSettings } = require('./project-settings');
    const knowledgeEnabled = getProjectSettings().knowledgeEnabled;
    if (knowledgeEnabled) {
      try {
        const { getEmbedder } = require('./vector/embedder');
        const { getVectorStore } = require('./vector/vector-store');
        // Warm embedder model (~2-3s) and LanceDB connection in parallel
        Promise.all([
          getEmbedder().load().then(() => console.log('Embedder model pre-warmed')),
          getVectorStore().init().then(() => console.log('Vector store pre-warmed')),
        ]).catch(() => {
          // Silently ignore — will lazy-load on first use
        });
      } catch {
        // Not available (e.g., missing dependencies)
      }
    } else {
      console.log('Knowledge disabled — skipping embedder/vector pre-warm');
    }

    // Start hub client connection if configured
    let hubClient = null;
    if (hubConfigured) {
      console.log('Connecting to Hub...');
      const assistWebPort = process.env.ASSIST_WEB_PORT ? parseInt(process.env.ASSIST_WEB_PORT, 10) : parseInt(DEFAULT_WEB_PORT, 10);

      // Persist service ports to ~/.lm-assist/hub.json so reconnects
      // and tier-agent (when lm-assist is an npm package) can discover them
      saveHubConnectionConfig({ assistWebPort, apiPort: port });

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

    // Start knowledge scheduler (discovery, generation, remote sync)
    // Skip if knowledge is disabled (kill switch)
    let knowledgeScheduler: any = null;
    if (knowledgeEnabled) {
      try {
        const { getKnowledgeScheduler } = require('./knowledge/scheduler');
        knowledgeScheduler = getKnowledgeScheduler();
        knowledgeScheduler.start();
      } catch (err: any) {
        console.error('Scheduler start failed:', err.message);
      }
    } else {
      console.log('Knowledge disabled — skipping scheduler');
    }

    // Start the internal scheduled-jobs runner (lm-assist's own cron replacement).
    // Always starts — its only built-in job (test-conversation cleanup) ships
    // disabled + dryRun, so this is inert until the user arms a job.
    let scheduledJobs: any = null;
    try {
      const { getScheduledJobs } = require('./scheduler/scheduled-jobs');
      scheduledJobs = getScheduledJobs();
      scheduledJobs.start();
    } catch (err: any) {
      console.error('Scheduled jobs start failed:', err.message);
    }

    // Start data sync boot (flush timer, reconcile timer, dataset_updated subscription).
    // Guard: hub client is already initialized above; startDataSync() is dormant if
    // dataServiceEnabled=false, so this is always safe to call.
    try {
      const { startDataSync } = require('./data/sync-boot');
      startDataSync();
    } catch (e) { /* non-fatal — data sync is optional */ }

    // Recover the file-transfer job manager's durable job log: replays
    // ~/.cache/lm-assist/transfer-jobs-{dev,prod}.jsonl, re-queues any job that
    // wasn't in a terminal state when the process last exited, drops
    // terminal jobs past the retention window, and starts the TTL/retention
    // sweeper (recover() is the ONLY thing that starts it — must run
    // unconditionally, even with an empty/missing log, or TTL expiry and
    // terminal-job cleanup never run for this process's lifetime).
    try {
      const { recover } = require('./file-transfer/job-manager');
      recover();
    } catch (err: any) {
      console.error('Job manager recover() failed:', err.message);
    }

    profiler.end('total');
    profiler.summary();

    console.log('Press Ctrl+C to stop');

    // Handle shutdown
    process.on('SIGINT', async () => {
      console.log('\nShutting down...');
      try { if (knowledgeScheduler) knowledgeScheduler.stop(); } catch {}
      try { if (scheduledJobs) scheduledJobs.stop(); } catch {}
      if (hubClient) {
        await hubClient.disconnect();
      }
      await server.stop();
      process.exit(0);
    });

    process.on('SIGTERM', async () => {
      try { if (knowledgeScheduler) knowledgeScheduler.stop(); } catch {}
      try { if (scheduledJobs) scheduledJobs.stop(); } catch {}
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
  --port, -p        Server port (default: ${DEFAULT_API_PORT} — ${IS_DEV_REPO ? 'dev repo' : 'npm package'})
  --host, -h        Server host (default: 0.0.0.0)
  --project, -d     Project directory (default: current)
  --extra-ca        Extra CA cert path for outbound TLS from spawned helpers
                    (or set LM_ASSIST_EXTRA_CA); used behind an MITM proxy
  --https           Also serve an HTTPS terminator (or set LM_HTTPS=1) on
                    web-port+1 (LM_HTTPS_PORT overrides): secure-context page
                    + same-origin /_coreapi + wss voice — mic works over LAN

Examples:
  lm-assist serve --port 8080
  lm-assist serve
  `);
}

// Skip main() in the parent when we've re-exec'd a child with NODE_EXTRA_CA_CERTS;
// the child runs the real Core, and this process just forwards signals + its exit.
if (!_reExecedForCa) {
  main().catch(err => {
    console.error('Error:', err);
    process.exit(1);
  });
}
