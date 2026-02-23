#!/usr/bin/env node

/**
 * Standalone upgrade script for lm-assist.
 *
 * Runs detached from the server process. All output is logged to
 * ~/.cache/lm-assist/upgrade.log so the frontend can display progress
 * after the server restarts.
 *
 * Steps:
 *   1. Plugin install (claude plugin install lm-assist@langmartai)
 *   2. Kill services by port (fuser -k 3100/tcp, 3848/tcp)
 *   3. npm install -g lm-assist@latest
 *   4. Wait briefly
 *   5. lm-assist start
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ── Log file ────────────────────────────────────────────────────────────────

const LOG_DIR = path.join(os.homedir(), '.cache', 'lm-assist');
const LOG_FILE = path.join(LOG_DIR, 'upgrade.log');

function ensureLogDir() {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
}

function log(msg) {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}\n`;
  fs.appendFileSync(LOG_FILE, line);
  // Also print to stdout so CLI users see it live
  process.stdout.write(line);
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function which(bin) {
  try {
    return execFileSync('which', [bin], {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return null;
  }
}

function run(cmd, args, label) {
  log(`[${label}] Running: ${cmd} ${args.join(' ')}`);
  try {
    const output = execFileSync(cmd, args, {
      encoding: 'utf-8',
      timeout: 120_000,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, CLAUDECODE: undefined },
    });
    if (output.trim()) {
      for (const line of output.trim().split('\n')) {
        log(`[${label}]   ${line}`);
      }
    }
    log(`[${label}] Done (exit 0)`);
    return true;
  } catch (err) {
    const stderr = err.stderr ? err.stderr.toString().trim() : '';
    const stdout = err.stdout ? err.stdout.toString().trim() : '';
    if (stdout) {
      for (const line of stdout.split('\n')) {
        log(`[${label}]   ${line}`);
      }
    }
    if (stderr) {
      for (const line of stderr.split('\n')) {
        log(`[${label}] ERR: ${line}`);
      }
    }
    log(`[${label}] Failed (exit ${err.status || 'unknown'})`);
    return false;
  }
}

function killByPort(port) {
  try {
    execFileSync('fuser', ['-k', `${port}/tcp`], {
      encoding: 'utf-8',
      timeout: 10_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    log(`Killed processes on port ${port}`);
  } catch {
    log(`No process found on port ${port} (or fuser not available)`);
  }
}

function cleanPidFiles(root) {
  const pidDir = path.join(root, 'core');
  try {
    const files = fs.readdirSync(pidDir);
    for (const f of files) {
      if (f.endsWith('.pid')) {
        const fp = path.join(pidDir, f);
        try { fs.unlinkSync(fp); log(`Removed PID file: ${fp}`); } catch {}
      }
    }
  } catch {}
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  ensureLogDir();

  // Truncate log for this run
  fs.writeFileSync(LOG_FILE, '');
  log('=== upgrade started ===');

  // Resolve binaries
  const claudeBin = which('claude');
  if (!claudeBin) {
    log('WARNING: claude binary not found in PATH, skipping plugin install');
  }

  // Read ports from env or defaults
  const apiPort = process.env.API_PORT || '3100';
  const webPort = process.env.WEB_PORT || '3848';

  // Step 1: Plugin install
  if (claudeBin) {
    log('--- Step 1: Plugin install ---');
    run(claudeBin, ['plugin', 'install', 'lm-assist@langmartai'], 'Plugin install');
  } else {
    log('--- Step 1: Plugin install (skipped) ---');
  }

  // Step 2: Kill services by port
  log('--- Step 2: Stopping services ---');
  killByPort(apiPort);
  killByPort(webPort);

  // Clean PID files from both npm root and dev repo
  const npmRoot = path.resolve(__dirname, '../..');
  cleanPidFiles(npmRoot);

  // Also try dev repo path from config
  try {
    const cfgPath = path.join(os.homedir(), '.claude-code-config.json');
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
    if (cfg.devRepoPath && cfg.devRepoPath !== npmRoot) {
      cleanPidFiles(cfg.devRepoPath);
    }
  } catch {}

  // Step 3: npm update
  log('--- Step 3: npm install -g lm-assist@latest ---');
  const npmOk = run('npm', ['install', '-g', 'lm-assist@latest'], 'npm update');

  if (!npmOk) {
    log('npm install failed — attempting to start services anyway');
  }

  // Step 4: Wait for things to settle
  log('--- Step 4: Waiting 2s ---');
  await sleep(2000);

  // Step 5: Start services
  log('--- Step 5: Starting services ---');
  const lmAssistBin = which('lm-assist');
  if (lmAssistBin) {
    run(process.execPath, [lmAssistBin, 'start'], 'Service start');
  } else {
    log('WARNING: lm-assist binary not found in PATH after install');
    // Try to start from npm root
    const fallbackBin = path.join(npmRoot, 'bin', 'lm-assist.js');
    if (fs.existsSync(fallbackBin)) {
      run(process.execPath, [fallbackBin, 'start'], 'Service start (fallback)');
    } else {
      log('ERROR: Cannot find lm-assist binary to start services');
    }
  }

  log('=== upgrade finished ===');
}

main().catch(err => {
  try { log(`FATAL: ${err.message}`); } catch {}
  process.exitCode = 1;
});
