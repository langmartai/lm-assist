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
 *   lm-assist version         Show version info
 *   lm-assist storage         Show storage usage
 *   lm-assist log             Show recent hook and MCP logs
 *   lm-assist setup --key KEY Connect to cloud with API key
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

// Loopback API token — the Core gates every endpoint except /health behind the
// x-api-key header. dev+prod share <dataDir>/api-token, so one token works for both.
function lmAuthHeader() {
  try {
    const dir = process.env.LM_ASSIST_DATA_DIR || path.join(os.homedir(), '.lm-assist');
    const t = fs.readFileSync(path.join(dir, 'api-token'), 'utf8').trim();
    if (t) return { 'x-api-key': t };
  } catch { /* no token file */ }
  return {};
}

// Coerce an API error (string, or a framework {code,message} envelope from an
// older core that predates these routes) into a readable line.
function errText(json) {
  const e = json && json.error;
  if (typeof e === 'string') return e;
  if (e && typeof e.message === 'string') return e.message;
  return e ? JSON.stringify(e) : 'unknown error';
}

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

/** True only when npm `latest` is numerically GREATER than `installed` (no downgrade prompts). */
function isNpmGreater(installed, latest) {
  if (!installed || !latest) return false;
  const a = String(installed).split('.').map((n) => parseInt(n, 10) || 0);
  const b = String(latest).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] || 0, y = b[i] || 0;
    if (y > x) return true;
    if (y < x) return false;
  }
  return false;
}

// Get command from argv
const command = process.argv[2] || 'help';
const args = process.argv.slice(3);

// Test hatch: require() with LM_ASSIST_NO_RUN=1 exports helpers and skips CLI execution.
if (process.env.LM_ASSIST_NO_RUN === '1') { module.exports = { isNpmGreater }; return; }

const validCommands = ['start', 'stop', 'restart', 'status', 'logs', 'upgrade', 'version', 'storage', 'log', 'setup', 'login', 'logout', 'doctor', 'help'];

if (command === 'help' || command === '--help' || command === '-h') {
  console.log(`
lm-assist - LM Assistant CLI

Usage: lm-assist <command> [options]

Commands:
  start              Start API and Web services (set LM_HTTPS=1 — env or .env —
                     to add the HTTPS terminator: mic/voice over LAN)
  stop               Stop all services
  restart            Restart services
  status             Show service status and component locations
  logs [core|web]    View service logs (last 100 lines, --dev for dev logs)
  log [context|mcp]  View hook and MCP logs (default: both)
  version            Show installed, latest, and plugin versions
  doctor             Check this host's environment (Node>=20.9, git/npm, chokidar pin)
  storage            Show storage usage (~/.lm-assist/)
  storage clean      Delete all lm-assist data and start fresh (-y to skip confirm)
  setup --key KEY    Connect to cloud with an API key
  login [<keypack>]  Enroll this node by redeeming a one-time keypack;
                     or 'login --new-node' on an authed node to mint one.
                     On enroll, registers the hub MCP in Claude Code so new
                     sessions get the worker-role tools (--no-mcp to skip).
  logout             Remove the hub key and disconnect this node
  upgrade [--from S]  Upgrade lm-assist (npm + plugin + restart).
                     --from S installs a specific build instead of npm latest:
                       a local .tgz, an unpacked dir, a bare version, or any
                       npm/git spec. Omit for the published latest.
  help               Show this help message

Examples:
  lm-assist setup --key sk-abc123
  lm-assist login --new-node          # on an authed node: print a keypack
  lm-assist login lmkp_...            # on a fresh node: enroll with the keypack
  lm-assist logout
  lm-assist start
  lm-assist stop
  lm-assist status
  lm-assist version
  lm-assist storage
  lm-assist log
  lm-assist log mcp
  lm-assist logs core
  lm-assist logs core --dev
  lm-assist upgrade
  lm-assist upgrade --from ./lm-assist-0.1.72.tgz
  lm-assist upgrade --from 0.1.72

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
    // Pass through upgrade args (e.g. `--from <tgz|dir|spec>`) so the user can
    // install a specific non-published build instead of npm latest.
    execFileSync(process.execPath, [tmpScript, ...args], {
      stdio: 'inherit',
      env: process.env,
      windowsHide: true,
    });
  } catch (err) {
    process.exit(err.status || 1);
  }
  process.exit(0);
}

// Handle doctor separately — just runs the preflight (no service-manager needed)
if (command === 'doctor') {
  // Use __filename-relative path (the repo containing bin/lm-assist.js),
  // matching the upgrade block's pattern — projectRoot may resolve to the
  // global npm package which lacks scripts/preflight.js.
  const preflight = path.join(path.dirname(path.dirname(__filename)), 'scripts', 'preflight.js');
  if (!fs.existsSync(preflight)) {
    console.error('Preflight script not found at:', preflight);
    console.error('(Run from a source checkout, or reinstall lm-assist.)');
    process.exit(1);
  }
  const { execFileSync } = require('child_process');
  try {
    execFileSync(process.execPath, [preflight, '--phase=post-clone', `--repo=${projectRoot}`, ...args], {
      stdio: 'inherit',
      env: process.env,
      windowsHide: true,
    });
  } catch (err) {
    process.exit(err.status || 1);
  }
  process.exit(0);
}

// ─── Helper: format bytes as human-readable ───
function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return (bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0) + ' ' + units[i];
}

// ─── Helper: recursively compute directory size ───
function dirSize(dirPath) {
  let total = 0;
  try {
    for (const entry of fs.readdirSync(dirPath)) {
      const full = path.join(dirPath, entry);
      try {
        const st = fs.statSync(full);
        total += st.isDirectory() ? dirSize(full) : st.size;
      } catch { /* skip */ }
    }
  } catch { /* skip */ }
  return total;
}

// ─── Helper: read last N lines of a file ───
function tailFile(filePath, limit) {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n').filter(l => l.length > 0);
    return lines.slice(-limit);
  } catch {
    return [];
  }
}

// ─── Handle `version` — no service-manager needed ───
if (command === 'version') {
  // Installed version from package.json
  const pkgJsonPath = path.join(path.dirname(path.dirname(__filename)), 'package.json');
  let installedVersion = null;
  try {
    installedVersion = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8')).version;
  } catch { /* not found */ }

  console.log('lm-assist Version Info\n');
  console.log(`  Installed:  ${installedVersion || 'unknown'}`);

  // Install source (best-effort)
  let src = null;
  try { src = require(path.join(projectRoot, 'core', 'dist', 'utils', 'install-source.js')).readInstallSource(); } catch { /* ignore */ }
  if (src) console.log(`  Source:     ${src.source} (${src.kind}${src.kind === 'custom' ? ' build' : ''})`);

  // Latest version from npm registry
  try {
    const { execFileSync } = require('child_process');
    const latest = execFileSync('npm', ['view', 'lm-assist', 'version'], {
      encoding: 'utf-8', timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    console.log(`  Latest:     ${latest}`);
    if (installedVersion && latest && isNpmGreater(installedVersion, latest)) {
      console.log(`  Update:     Run "lm-assist upgrade" to update to ${latest}`);
      if (src && src.kind === 'custom') {
        console.log(`              (you're on a CUSTOM build — "lm-assist upgrade" installs npm latest and REPLACES it;`);
        console.log(`               use "lm-assist upgrade --from <your tgz/github ref>" to stay on a custom build)`);
      }
    }
  } catch {
    console.log('  Latest:     (could not check)');
  }

  // Plugin version
  try {
    const pluginsFile = path.join(os.homedir(), '.claude', 'plugins', 'installed_plugins.json');
    const data = JSON.parse(fs.readFileSync(pluginsFile, 'utf-8'));
    const entries = data?.plugins?.['lm-assist@langmartai'];
    if (Array.isArray(entries) && entries.length > 0) {
      const entry = entries[entries.length - 1];
      console.log(`  Plugin:     ${entry.version || 'unknown'}`);
    } else {
      console.log('  Plugin:     (not installed)');
    }
  } catch {
    console.log('  Plugin:     (not installed)');
  }

  // Node.js version
  console.log(`  Node.js:    ${process.version}`);
  console.log(`  Platform:   ${process.platform} ${os.arch()}`);

  process.exit(0);
}

// ─── Handle `storage` — no service-manager needed ───
if (command === 'storage') {
  const dataDir = process.env.LM_ASSIST_DATA_DIR || path.join(os.homedir(), '.lm-assist');
  const subCommand = args[0]; // 'clean' or undefined

  // ─── storage clean: stop services and delete ~/.lm-assist ───
  if (subCommand === 'clean') {
    (async () => {
      const autoConfirm = args.includes('-y') || args.includes('--yes');

      if (!fs.existsSync(dataDir)) {
        console.log(`Data directory not found: ${dataDir}`);
        process.exit(0);
      }

      const totalSize = formatBytes(dirSize(dataDir));
      console.log(`\nlm-assist Storage Clean\n`);
      console.log(`  Data directory:  ${dataDir}`);
      console.log(`  Total size:      ${totalSize}\n`);
      console.log(`  WARNING: This will permanently delete all lm-assist data including:`);
      console.log(`    - Session cache (LMDB)`);
      console.log(`    - Knowledge documents and identifications`);
      console.log(`    - Vector store (LanceDB index)`);
      console.log(`    - Project settings and configuration`);
      console.log(`    - Logs\n`);

      if (!autoConfirm) {
        const readline = require('readline');
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        const ask = (q) => new Promise((resolve) => rl.question(q, resolve));

        const confirm1 = await ask(`Are you sure you want to delete ${dataDir}? Type 'yes' to confirm: `);
        if (confirm1.trim() !== 'yes') {
          console.log('Cancelled.');
          rl.close();
          process.exit(0);
        }

        const confirm2 = await ask(`Confirm again — type 'yes' to permanently delete all data: `);
        if (confirm2.trim() !== 'yes') {
          console.log('Cancelled.');
          rl.close();
          process.exit(0);
        }
        rl.close();
      } else {
        console.log(`Auto-confirming with -y flag`);
      }

      // Stop services on all known ports
      console.log(`\nStopping services...`);
      const { execFileSync } = require('child_process');
      for (const p of ['3100', '3848', '3200', '3948']) {
        try { execFileSync('fuser', ['-k', `${p}/tcp`], { stdio: 'ignore' }); } catch { /* ok */ }
      }

      // Brief wait for processes to exit
      await new Promise(r => setTimeout(r, 1000));

      console.log(`Deleting ${dataDir}...`);
      fs.rmSync(dataDir, { recursive: true, force: true });
      console.log(`Done. All lm-assist data deleted. Services will rebuild on next start.\n`);

      process.exit(0);
    })();
    return; // Prevent falling through to storage usage display
  }

  // ─── storage (no subcommand): show usage ───
  if (!fs.existsSync(dataDir)) {
    console.log(`lm-assist Storage\n`);
    console.log(`  Data directory not found: ${dataDir}`);
    process.exit(0);
  }

  console.log(`lm-assist Storage (${dataDir})\n`);

  let totalSize = 0;
  try {
    const entries = fs.readdirSync(dataDir).sort();
    for (const name of entries) {
      const fullPath = path.join(dataDir, name);
      try {
        const st = fs.statSync(fullPath);
        if (st.isDirectory()) {
          const size = dirSize(fullPath);
          totalSize += size;
          let fileCount = 0;
          try { fileCount = fs.readdirSync(fullPath).length; } catch {}
          console.log(`  ${name}/`.padEnd(30) + `${formatBytes(size).padStart(10)}  (${fileCount} items)`);
          // Show children one level deep (cap at 20 to avoid flooding)
          try {
            const children = fs.readdirSync(fullPath).sort();
            const maxShow = 20;
            const shown = children.slice(0, maxShow);
            for (const child of shown) {
              const childPath = path.join(fullPath, child);
              try {
                const cst = fs.statSync(childPath);
                const csize = cst.isDirectory() ? dirSize(childPath) : cst.size;
                const suffix = cst.isDirectory() ? '/' : '';
                console.log(`    ${child}${suffix}`.padEnd(28) + `${formatBytes(csize).padStart(10)}`);
              } catch { /* skip */ }
            }
            if (children.length > maxShow) {
              console.log(`    ... and ${children.length - maxShow} more`);
            }
          } catch { /* skip */ }
        } else {
          totalSize += st.size;
          console.log(`  ${name}`.padEnd(30) + `${formatBytes(st.size).padStart(10)}`);
        }
      } catch { /* skip */ }
    }
  } catch (e) {
    console.error(`  Error reading directory: ${e.message}`);
    process.exit(1);
  }

  console.log('  ' + '-'.repeat(38));
  console.log(`  Total`.padEnd(30) + `${formatBytes(totalSize).padStart(10)}`);

  process.exit(0);
}

// ─── Handle `log` — no service-manager needed ───
if (command === 'log') {
  const dataDir = process.env.LM_ASSIST_DATA_DIR || path.join(os.homedir(), '.lm-assist');
  const contextLogPath = path.join(dataDir, 'logs', 'context-inject-hook.log');
  const mcpLogPath = path.join(dataDir, 'logs', 'mcp-calls.jsonl');

  const filter = args.find(a => ['context', 'mcp'].includes(a));
  const limit = 50;

  const showContext = !filter || filter === 'context';
  const showMcp = !filter || filter === 'mcp';

  if (showContext) {
    console.log('=== Context Injection Log (last ' + limit + ' lines) ===\n');
    const lines = tailFile(contextLogPath, limit);
    if (lines.length === 0) {
      console.log('  (no log entries found)');
    } else {
      for (const line of lines) {
        console.log(line);
      }
    }
    if (showMcp) console.log('');
  }

  if (showMcp) {
    console.log('=== MCP Tool Calls (last ' + limit + ' entries) ===\n');
    const lines = tailFile(mcpLogPath, limit);
    if (lines.length === 0) {
      console.log('  (no log entries found)');
    } else {
      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          const ts = (entry.ts || entry.timestamp) ? new Date(entry.ts || entry.timestamp).toLocaleString() : '';
          const tool = entry.tool || entry.name || '?';
          const dur = entry.durationMs != null ? ` (${entry.durationMs}ms)` : '';
          const err = entry.error ? ` ERROR: ${entry.error}` : '';
          console.log(`  ${ts}  ${tool}${dur}${err}`);
        } catch {
          console.log(`  ${line}`);
        }
      }
    }
  }

  process.exit(0);
}

// ─── Constants ───
const DEFAULT_HUB_URL = 'wss://assist-api.langmart.ai';
const PROD_API_PORT = 3100;
const PROD_WEB_PORT = 3848;

// ─── Helper: read hub.json config ───
function readHubConfig() {
  const dataDir = process.env.LM_ASSIST_DATA_DIR || path.join(os.homedir(), '.lm-assist');
  const configFile = path.join(dataDir, 'hub.json');
  try {
    if (fs.existsSync(configFile)) {
      return JSON.parse(fs.readFileSync(configFile, 'utf-8'));
    }
  } catch { /* ignore */ }
  return {};
}

// ─── Helper: write hub.json config ───
function writeHubConfig(config) {
  const dataDir = process.env.LM_ASSIST_DATA_DIR || path.join(os.homedir(), '.lm-assist');
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  const configFile = path.join(dataDir, 'hub.json');
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2) + '\n');
}

// ─── Helper: check if API is healthy ───
async function isApiHealthy(port) {
  try {
    const res = await fetch(`http://localhost:${port}/health`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

// ─── Helper: validate API key against hub ───
async function validateApiKey(apiKey, hubUrl) {
  const httpUrl = (hubUrl || DEFAULT_HUB_URL).replace(/^ws:/, 'http:').replace(/^wss:/, 'https:');
  try {
    const res = await fetch(`${httpUrl}/auth/validate`, {
      headers: { 'Authorization': `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return { valid: false, error: `Server returned ${res.status}` };
    const json = await res.json();
    return {
      valid: !!json.valid,
      user: json.user || null,
      error: json.valid ? null : 'Invalid API key',
    };
  } catch (err) {
    return { valid: false, error: err.message || 'Network error' };
  }
}

// ─── Handle `setup` ───
if (command === 'setup') {
  const keyArg = args.find((a, i) => args[i - 1] === '--key') || (() => {
    const kv = args.find(a => a.startsWith('--key='));
    return kv ? kv.substring(kv.indexOf('=') + 1) : null;
  })();

  if (keyArg && keyArg.startsWith('--')) {
    console.error(`Error: --key requires a value. Got flag instead: ${keyArg}`);
    console.error('Usage: lm-assist setup --key YOUR_API_KEY');
    process.exit(1);
  }

  if (!keyArg) {
    console.log(`
lm-assist Cloud Setup

  Connect your local instance to LangMart Cloud for remote access.

  1. Generate an API key at:

     https://assist.langmart.ai/assist

  2. Run setup with your key:

     lm-assist setup --key YOUR_API_KEY
`);
    process.exit(0);
  }

  (async () => {
    try {
      const hubConfig = readHubConfig();
      const hubUrl = hubConfig.hubUrl || process.env.TIER_AGENT_HUB_URL || DEFAULT_HUB_URL;
      const oldKey = hubConfig.apiKey || process.env.TIER_AGENT_API_KEY || null;

      // Check if services are running
      const apiRunning = await isApiHealthy(PROD_API_PORT);

      if (apiRunning) {
        // ── Services running: use the API ──
        // Check current hub status
        try {
          const statusRes = await fetch(`http://localhost:${PROD_API_PORT}/hub/status`, {
            headers: lmAuthHeader(),
            signal: AbortSignal.timeout(5000),
          });
          const statusJson = await statusRes.json();
          const hubStatus = statusJson.data || statusJson;

          // If already connected with same key, report and exit
          // Best-effort check: compare first 12 chars (only for keys > 12 chars to avoid false positives)
          if (hubStatus.connected && hubStatus.authenticated && keyArg.length > 12) {
            const currentPrefix = hubStatus.apiKeyPrefix || '';
            const newPrefix = keyArg.substring(0, 12) + '...';
            if (currentPrefix === newPrefix) {
              console.log(`Already connected to cloud (gateway: ${hubStatus.gatewayId})`);
              process.exit(0);
            }
          }
        } catch { /* status check failed, proceed with setup */ }

        // Validate new key first
        process.stdout.write('Validating API key... ');
        const validation = await validateApiKey(keyArg, hubUrl);
        if (!validation.valid) {
          console.log('FAILED');
          console.error(`  Authentication failed: ${validation.error}`);
          console.log('  API key was not saved.');
          process.exit(1);
        }
        const userName = validation.user?.displayName || validation.user?.display_name || validation.user?.email || '';
        console.log(`OK${userName ? ` (${userName})` : ''}`);

        // Save key via API (server owns hub.json writes when running)
        process.stdout.write('Connecting to cloud... ');
        try {
          const configRes = await fetch(`http://localhost:${PROD_API_PORT}/hub/config`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', ...lmAuthHeader() },
            body: JSON.stringify({ apiKey: keyArg, hubUrl, reconnect: true }),
            signal: AbortSignal.timeout(15000),
          });
          const configJson = await configRes.json();

          if (configJson.success && configJson.data) {
            if (configJson.data.authenticated) {
              console.log(`OK (gateway: ${configJson.data.gatewayId || 'pending'})`);
            } else if (configJson.data.connected) {
              console.log('connected (authenticating...)');
            } else {
              // Connection failed after validation succeeded — try rollback
              console.log('FAILED');
              console.error(`  ${configJson.data.message || 'Connection failed'}`);
              if (oldKey && oldKey !== keyArg) {
                process.stdout.write('  Rolling back to previous key... ');
                try {
                  const rollbackRes = await fetch(`http://localhost:${PROD_API_PORT}/hub/config`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json', ...lmAuthHeader() },
                    body: JSON.stringify({ apiKey: oldKey, hubUrl, reconnect: false }),
                    signal: AbortSignal.timeout(5000),
                  });
                  console.log(rollbackRes.ok ? 'done' : 'FAILED (could not restore previous key)');
                } catch {
                  console.log('FAILED (could not restore previous key)');
                }
              }
              process.exit(1);
            }
          } else {
            console.log('FAILED');
            const errMsg = typeof configJson.error === 'string'
              ? configJson.error
              : configJson.error?.message || 'Unknown error';
            console.error(`  ${errMsg}`);
            process.exit(1);
          }
        } catch (err) {
          console.log('FAILED');
          console.error(`  ${err.message}`);
          process.exit(1);
        }

      } else {
        // ── Services NOT running: validate key directly, then start services ──

        // Validate new key
        process.stdout.write('Validating API key... ');
        const validation = await validateApiKey(keyArg, hubUrl);
        if (!validation.valid) {
          console.log('FAILED');
          console.error(`  Authentication failed: ${validation.error}`);
          console.log('  API key was not saved.');
          process.exit(1);
        }
        const userName = validation.user?.displayName || validation.user?.display_name || validation.user?.email || '';
        console.log(`OK${userName ? ` (${userName})` : ''}`);

        // Save key to hub.json (preserves existing fields like assistWebPort, apiPort)
        const newConfig = { ...hubConfig, apiKey: keyArg, hubUrl };
        writeHubConfig(newConfig);
        console.log('  API key saved');

        // Start services
        console.log('\nStarting services...');
        const svc = loadSm();
        const result = await svc.startAll();
        console.log(`  API: ${result.core.message}`);
        console.log(`  Web: ${result.web.message}`);

        if (!result.core.success || !result.web.success) {
          console.error('\n  Services failed to start. Run "lm-assist logs core" for details.');
          process.exit(1);
        }

        // Wait for hub to auto-connect (the server reads hub.json on startup)
        process.stdout.write('\nConnecting to cloud... ');
        let connected = false;
        for (let i = 0; i < 10; i++) {
          await new Promise(r => setTimeout(r, 1500));
          try {
            const statusRes = await fetch(`http://localhost:${PROD_API_PORT}/hub/status`, {
              headers: lmAuthHeader(),
              signal: AbortSignal.timeout(3000),
            });
            const statusJson = await statusRes.json();
            const hubStatus = statusJson.data || statusJson;
            if (hubStatus.authenticated) {
              console.log(`OK (gateway: ${hubStatus.gatewayId})`);
              connected = true;
              break;
            }
            if (hubStatus.connected) {
              console.log('connected (authenticating...)');
              connected = true;
              break;
            }
          } catch { /* retry */ }
        }
        if (!connected) {
          console.log('pending');
          console.log('  Hub connection is still establishing. Check with: lm-assist status');
        }
      }

      console.log('');
      console.log(`  Web UI: http://localhost:${PROD_WEB_PORT}`);
      process.exit(0);

    } catch (err) {
      console.error(`Error: ${err.message || err}`);
      process.exit(1);
    }
  })();

  // Prevent falling through to main()
  return;
}

if (command === 'login') {
  const newNode = args.includes('--new-node');
  const ttlIdx = args.indexOf('--ttl');
  const ttl = ttlIdx >= 0 ? parseInt(args[ttlIdx + 1], 10) : null;
  if (ttlIdx >= 0 && (!Number.isInteger(ttl) || ttl <= 0)) {
    console.error('--ttl requires a positive integer (minutes), e.g. --ttl 15');
    process.exit(1);
  }
  const code = args.find(a => a.startsWith('lmkp_'));
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  (async () => {
    try {
      const running = await isApiHealthy(PROD_API_PORT);
      if (newNode) {
        if (!running) { console.error('Services not running. Run `lm-assist start` first.'); process.exit(1); }
        const res = await fetch(`http://localhost:${PROD_API_PORT}/hub/enroll/create`, {
          method: 'POST', headers: { ...lmAuthHeader(), 'Content-Type': 'application/json' },
          body: JSON.stringify(ttl ? { ttlMinutes: ttl } : {}),
        });
        const json = await res.json();
        if (!json.success) { console.error(`Failed to mint enrollment key: ${errText(json)}`); process.exit(1); }
        console.log(`\nOne-time node enrollment key (expires ${json.data.expiresAt}):\n`);
        console.log(`  ${json.data.code}\n`);
        console.log('Run this on the NEW node:\n');
        console.log(`  lm-assist login ${json.data.code}\n`);
        process.exit(0);
      }
      if (!code) {
        console.error('Usage:');
        console.error('  lm-assist login <keypack>     # enroll this node');
        console.error('  lm-assist login --new-node    # mint a keypack on an authed node');
        process.exit(1);
      }
      if (!running) {
        console.log('Starting services...');
        const svc = loadSm();
        await svc.startAll();
        for (let i = 0; i < 10 && !(await isApiHealthy(PROD_API_PORT)); i++) await sleep(1500);
      }
      process.stdout.write('Enrolling node... ');
      const res = await fetch(`http://localhost:${PROD_API_PORT}/hub/login`, {
        method: 'POST', headers: { ...lmAuthHeader(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      });
      const json = await res.json();
      if (!json.success) { console.log('FAILED'); console.error(errText(json)); process.exit(1); }
      console.log(json.data.authenticated ? 'OK — authenticated.'
        : json.data.connected ? 'connected, authentication pending...' : 'connection pending...');
      // Register the hub MCP into Claude Code so this node's sessions get the
      // worker-role / orchestration tools (set_role, report_status, decide_gate,
      // ...) at startup — over the always-up hub /mcp endpoint, so there is no
      // local-Core startup-ordering problem. Opt out with --no-mcp.
      if (json.data.authenticated && !args.includes('--no-mcp')) {
        try {
          const { deriveHubMcpUrl, upsertHubMcpServer, HUB_MCP_SERVER_NAME } =
            require(path.join(projectRoot, 'core', 'dist', 'utils', 'claude-mcp-config'));
          const hub = readHubConfig();
          const mcpUrl = deriveHubMcpUrl(hub.hubUrl);
          if (mcpUrl && hub.apiKey) {
            const ccPath = path.join(os.homedir(), '.claude.json');
            let cc = {};
            try { cc = JSON.parse(fs.readFileSync(ccPath, 'utf8')); } catch { /* missing/non-JSON → start fresh */ }
            // This file now carries the sk-key in an Authorization header — write
            // it owner-only. `mode` only applies on create, so chmod afterward to
            // also tighten a pre-existing (possibly group/world-readable) file.
            const ccData = JSON.stringify(upsertHubMcpServer(cc, { url: mcpUrl, key: hub.apiKey }), null, 2);
            fs.writeFileSync(ccPath, ccData, { mode: 0o600 });
            try { fs.chmodSync(ccPath, 0o600); } catch { /* best-effort */ }
            console.log(`  ✓ Registered '${HUB_MCP_SERVER_NAME}' MCP for Claude Code — worker-role tools load in NEW sessions (${mcpUrl}).`);
          }
        } catch (e) {
          console.error(`  (note: hub MCP not registered for Claude Code: ${e.message})`);
        }
      }
      console.log(`\n  Web UI: http://localhost:${PROD_WEB_PORT}`);
      process.exit(0);
    } catch (err) {
      console.error(`Error: ${err.message || err}`);
      process.exit(1);
    }
  })();
  return;
}

if (command === 'logout') {
  (async () => {
    try {
      const running = await isApiHealthy(PROD_API_PORT);
      if (running) {
        const res = await fetch(`http://localhost:${PROD_API_PORT}/hub/logout`, {
          method: 'POST', headers: { ...lmAuthHeader() },
        });
        const json = await res.json();
        console.log(json.success ? 'Logged out. Hub key removed.' : `Failed: ${errText(json)}`);
        process.exit(json.success ? 0 : 1);
      } else {
        const cfg = readHubConfig();
        delete cfg.apiKey;
        writeHubConfig(cfg);
        const dataDir = process.env.LM_ASSIST_DATA_DIR || path.join(os.homedir(), '.lm-assist');
        try { fs.unlinkSync(path.join(dataDir, 'gateway-id')); } catch { /* none */ }
        console.log('Logged out (services were not running). Hub key removed.');
        process.exit(0);
      }
    } catch (err) {
      console.error(`Error: ${err.message || err}`);
      process.exit(1);
    }
  })();
  return;
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
      // A restart that reaped the tmux server killed every Claude Code pane on
      // this host. That must never again be reported as a clean restart.
      if (result.tmux && !result.tmux.ok) {
        console.error('');
        console.error(`    ${result.tmux.message}`);
        process.exitCode = 1;
      } else if (result.tmux && result.tmux.before !== null) {
        console.log(`    ${result.tmux.message}`);
      }
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
      // A Core that cannot drive still reports Running/Healthy — say so here, or
      // the degradation stays invisible for as long as the process lives.
      if (s.driveable === false) console.log(`    ⚠ NOT DRIVEABLE: ${s.driveWarning}`);
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
