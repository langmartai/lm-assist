#!/usr/bin/env node

/**
 * Standalone upgrade script for lm-assist.
 *
 * Runs detached from the server process. All output is logged to
 * ~/.cache/lm-assist/upgrade.log so the frontend can display progress
 * after the server restarts.
 *
 * Usage:
 *   node upgrade.js                       # install lm-assist@latest (default)
 *   node upgrade.js --from <tgz|dir|spec> # install a specific build, e.g. a
 *                                         # local lm-assist-0.1.72.tgz, an
 *                                         # unpacked dir, a bare version, or any
 *                                         # npm/git spec. See resolveSource().
 *
 * Steps:
 *   1. Plugin install (claude plugin install lm-assist@langmartai)
 *      - Skipped for a custom --from build (plugin always tracks published latest)
 *   2. Kill all lm-assist processes (services + MCP servers)
 *   3. npm install -g <source>   (default lm-assist@latest)
 *      - Windows EBUSY: tarball + robocopy fallback (uses a local .tgz directly)
 *   4. Start services
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const isWindows = process.platform === 'win32';
const isMac = process.platform === 'darwin';

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
  process.stdout.write(line);
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Cross-platform binary lookup. Uses `where` on Windows, `which` on Unix.
 * On Windows, prefers .cmd/.exe over extensionless bash scripts.
 */
function which(bin) {
  try {
    const cmd = isWindows ? 'where' : 'which';
    const result = execFileSync(cmd, [bin], {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    }).trim();
    const lines = result.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    if (isWindows && lines.length > 1) {
      const preferred = lines.find(l => /\.(cmd|exe|ps1)$/i.test(l));
      if (preferred) return preferred;
    }
    return lines[0];
  } catch {
    return null;
  }
}

/**
 * Derive npm global root from process.execPath (no spawn needed).
 */
function getNpmGlobalRoot() {
  const nodeDir = path.dirname(process.execPath);
  const candidates = [
    path.join(nodeDir, 'node_modules'),                    // Windows
    path.join(nodeDir, '..', 'lib', 'node_modules'),       // Linux/macOS
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Run a command with full logging.
 */
function run(cmd, args, label) {
  log(`[${label}] Running: ${cmd} ${args.join(' ')}`);
  try {
    const opts = {
      encoding: 'utf-8',
      timeout: 120_000,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, CLAUDECODE: undefined },
      windowsHide: true,
    };
    if (isWindows && /\.(cmd|bat)$/i.test(cmd)) {
      opts.shell = true;
    }
    const output = execFileSync(cmd, args, opts);
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
      for (const line of stdout.split('\n')) log(`[${label}]   ${line}`);
    }
    if (stderr) {
      for (const line of stderr.split('\n')) log(`[${label}] ERR: ${line}`);
    }
    log(`[${label}] Failed (exit ${err.status || 'unknown'})`);
    return false;
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Resolve the install source from `--from <x>` / `--source <x>` argv (or default
 * to the published `lm-assist@latest`). This is what lets the upgrade install a
 * specific NON-published build instead of npm latest.
 *
 * Accepted source forms:
 *   - a local tarball  : /abs/lm-assist-0.1.72.tgz  (or relative; .tgz/.tar.gz)
 *   - a local pkg dir  : /abs/lm-assist            (an unpacked package directory)
 *   - a bare version   : 0.1.72                     → lm-assist@0.1.72
 *   - any npm/git spec : lm-assist@next, github:org/repo#sha, https://…/x.tgz
 *   - latest (default) : (omit, or --from latest)   → lm-assist@latest
 *
 * Returns { spec, tgz, label, isCustom }:
 *   spec     — passed to `npm install -g <spec>` on every platform
 *   tgz      — absolute path when the source IS a local .tgz (lets the Windows
 *              tarball fallback skip `npm pack`); null otherwise
 *   isCustom — false only for the default published @latest
 */
function resolveSource(argv) {
  let raw = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--from' || a === '--source') { raw = argv[i + 1]; break; }
    if (a.startsWith('--from=')) { raw = a.slice('--from='.length); break; }
    if (a.startsWith('--source=')) { raw = a.slice('--source='.length); break; }
  }
  raw = (raw || '').trim();
  if (!raw || raw === 'latest' || raw === 'lm-assist@latest') {
    return { spec: 'lm-assist@latest', tgz: null, label: 'lm-assist@latest', isCustom: false };
  }
  // A filesystem path (local build: a .tgz tarball or an unpacked package dir)?
  const resolved = path.isAbsolute(raw) ? raw : path.resolve(process.cwd(), raw);
  if (fs.existsSync(resolved)) {
    const isTgz = /\.(tgz|tar\.gz)$/i.test(resolved);
    // npm install -g accepts both a tarball path and a directory path directly.
    return { spec: resolved, tgz: isTgz ? resolved : null, label: resolved, isCustom: true };
  }
  // Otherwise treat as an npm/git spec; a bare version → lm-assist@<version>.
  const spec = /^[0-9]/.test(raw) ? `lm-assist@${raw}` : raw;
  return { spec, tgz: null, label: spec, isCustom: true };
}

// ── Process killing ─────────────────────────────────────────────────────────

/**
 * Kill a process by PID using Node's process.kill() (no spawn needed).
 * On Windows this sends SIGTERM which maps to TerminateProcess.
 */
function killPid(pid) {
  try {
    process.kill(parseInt(pid, 10), 'SIGTERM');
    return true;
  } catch {
    return false;
  }
}

/**
 * Kill processes listening on a specific port.
 */
function killByPort(port) {
  if (isWindows) {
    try {
      const output = execFileSync('netstat', ['-ano'], {
        encoding: 'utf-8', timeout: 10_000, windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const pids = new Set();
      const portRegex = new RegExp(`:${port}\\s`, 'i');
      for (const line of output.split(/\r?\n/)) {
        if (portRegex.test(line) && /LISTENING/i.test(line)) {
          const parts = line.trim().split(/\s+/);
          const pid = parts[parts.length - 1];
          if (pid && pid !== '0') pids.add(pid);
        }
      }
      for (const pid of pids) {
        if (killPid(pid)) {
          log(`Killed PID ${pid} on port ${port}`);
        }
      }
      if (pids.size === 0) log(`No process found on port ${port}`);
    } catch {
      log(`Failed to check port ${port}`);
    }
  } else if (isMac) {
    try {
      const output = execFileSync('lsof', ['-ti', `:${port}`], {
        encoding: 'utf-8', timeout: 10_000, stdio: ['pipe', 'pipe', 'pipe'],
      });
      const pids = output.trim().split(/\r?\n/).filter(Boolean);
      for (const pid of pids) {
        killPid(pid);
      }
      log(pids.length > 0 ? `Killed ${pids.length} process(es) on port ${port}` : `No process found on port ${port}`);
    } catch {
      log(`No process found on port ${port}`);
    }
  } else {
    try {
      execFileSync('fuser', ['-k', `${port}/tcp`], {
        encoding: 'utf-8', timeout: 10_000, stdio: ['pipe', 'pipe', 'pipe'],
      });
      log(`Killed processes on port ${port}`);
    } catch {
      log(`No process found on port ${port} (or fuser not available)`);
    }
  }
}

/**
 * Kill ALL node processes with 'lm-assist' in their command line.
 * Uses PowerShell on Windows (more reliable than wmic which can hang).
 * Catches MCP servers, hooks, and any other lm-assist processes.
 */
function killAllLmAssistProcesses() {
  if (!isWindows) return;
  const myPid = process.pid;
  try {
    // PowerShell one-liner: find node.exe processes with lm-assist in cmdline, kill them
    const psCmd = [
      `Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue`,
      `| Where-Object { $_.CommandLine -like '*lm-assist*' -and $_.ProcessId -ne ${myPid} }`,
      `| ForEach-Object {`,
      `    try { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } catch {}`,
      `    $_.ProcessId`,
      `}`,
    ].join(' ');
    const output = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', psCmd], {
      encoding: 'utf-8', windowsHide: true, timeout: 20_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    const killed = output.split(/\r?\n/).filter(Boolean);
    if (killed.length > 0) {
      log(`Killed ${killed.length} lm-assist process(es): PIDs ${killed.join(', ')}`);
    } else {
      log('No additional lm-assist processes found');
    }
  } catch (e) {
    log(`PowerShell process scan failed: ${e.message || e}`);
    // Fallback to wmic (may hang on stressed systems, but try anyway)
    try {
      const output = execFileSync('wmic', [
        'process', 'where', "Name='node.exe'",
        'get', 'CommandLine,ProcessId', '/FORMAT:LIST',
      ], { encoding: 'utf-8', windowsHide: true, timeout: 10_000, stdio: ['pipe', 'pipe', 'pipe'] });
      let cmdLine = '';
      for (const line of output.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed.startsWith('CommandLine=')) {
          cmdLine = trimmed.slice('CommandLine='.length);
        } else if (trimmed.startsWith('ProcessId=')) {
          const pid = trimmed.slice('ProcessId='.length).trim();
          if (cmdLine.includes('lm-assist') && pid !== String(myPid) && /^\d+$/.test(pid)) {
            killPid(pid);
            log(`Killed lm-assist process PID ${pid}`);
          }
          cmdLine = '';
        }
      }
    } catch {
      log('wmic fallback also failed');
    }
  }
}

function cleanPidFiles(dir) {
  try {
    for (const f of fs.readdirSync(dir)) {
      if (f.endsWith('.pid')) {
        try { fs.unlinkSync(path.join(dir, f)); log(`Removed PID file: ${path.join(dir, f)}`); } catch {}
      }
    }
  } catch {}
}

/**
 * Run npm install -g <spec>. `spec` defaults to lm-assist@latest but may be a
 * local .tgz path, an unpacked dir, a bare version, or any npm/git spec — see
 * resolveSource(). Returns true on success, false on failure.
 */
function runNpmInstall(spec) {
  spec = spec || 'lm-assist@latest';
  if (isWindows) {
    const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
    if (fs.existsSync(npmCli)) {
      return run(process.execPath, [npmCli, 'install', '-g', spec], 'npm install');
    }
    const npmBin = which('npm.cmd') || which('npm');
    if (npmBin) {
      return run(npmBin, ['install', '-g', spec], 'npm install');
    }
    log('[npm install] Cannot find npm binary');
    return false;
  }
  return run('npm', ['install', '-g', spec], 'npm install');
}

/**
 * Get the npm-cli.js path or npm binary for running npm commands.
 * Returns { cmd, args_prefix } where cmd is the executable and args_prefix
 * is prepended to all npm arguments.
 */
function getNpmCmd() {
  if (isWindows) {
    const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
    if (fs.existsSync(npmCli)) {
      return { cmd: process.execPath, prefix: [npmCli] };
    }
    const npmBin = which('npm.cmd') || which('npm');
    if (npmBin) return { cmd: npmBin, prefix: [] };
    return null;
  }
  return { cmd: 'npm', prefix: [] };
}

/**
 * Windows EBUSY fallback: download tarball and overwrite files in place using robocopy.
 *
 * This avoids npm's rename-based update entirely. Instead:
 *   1. npm pack lm-assist@latest → downloads tarball
 *   2. tar -xzf → extracts to temp dir (package/)
 *   3. robocopy /E → copies files over existing package dir (overwrites in place)
 *   4. npm install --omit=dev → installs/updates dependencies inside the package dir
 *
 * robocopy overwrites individual files (not directory renames), so it works
 * even when Windows Defender/Indexer holds a handle on the directory.
 *
 * `source` (from resolveSource) selects WHAT to lay down: a local .tgz is used
 * directly (no npm pack / no download); anything else is fetched via npm pack of
 * its spec.
 */
function upgradeViaTarball(pkgDir, source) {
  source = source || { spec: 'lm-assist@latest', tgz: null, label: 'lm-assist@latest' };
  const npm = getNpmCmd();
  if (!npm) {
    log('[tarball] Cannot find npm binary');
    return false;
  }

  const tmpDir = path.join(os.tmpdir(), `lm-assist-tarball-${Date.now()}`);
  let tarball;
  try {
    fs.mkdirSync(tmpDir, { recursive: true });

    if (source.tgz && fs.existsSync(source.tgz)) {
      // 1a. Local build tarball — use it directly, no fetch needed.
      tarball = source.tgz;
      log(`[tarball] Using local build tarball: ${tarball}`);
    } else {
      // 1b. Fetch the tarball for the requested spec
      log(`[tarball] Downloading ${source.label} tarball...`);
      try {
        const packOutput = execFileSync(npm.cmd, [...npm.prefix, 'pack', source.spec, '--pack-destination', tmpDir], {
          encoding: 'utf-8', timeout: 60_000, windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env, CLAUDECODE: undefined },
        }).trim();
        // npm pack outputs the tarball filename
        const tgzName = packOutput.split(/\r?\n/).pop().trim();
        log(`[tarball] Downloaded: ${tgzName}`);
      } catch (e) {
        log(`[tarball] npm pack failed: ${e.stderr || e.message}`);
        return false;
      }

      // Find the tarball
      const tarballs = fs.readdirSync(tmpDir).filter(f => f.endsWith('.tgz'));
      if (tarballs.length === 0) {
        log('[tarball] No tarball found after npm pack');
        return false;
      }
      tarball = path.join(tmpDir, tarballs[0]);
    }

    // 2. Extract tarball
    // On Windows, use C:\Windows\System32\tar.exe explicitly — Git's tar
    // interprets "C:" in paths as a remote host and fails.
    log('[tarball] Extracting tarball...');
    const extractDir = path.join(tmpDir, 'extracted');
    fs.mkdirSync(extractDir, { recursive: true });
    try {
      const tarBin = isWindows
        ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
        : 'tar';
      execFileSync(tarBin, ['-xzf', tarball, '-C', extractDir], {
        timeout: 60_000, windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      log(`[tarball] tar extraction failed: ${e.message}`);
      return false;
    }

    // npm pack extracts to extractDir/package/
    const srcDir = path.join(extractDir, 'package');
    if (!fs.existsSync(srcDir)) {
      log('[tarball] Extracted directory structure unexpected (no package/ dir)');
      return false;
    }

    // 3. Robocopy files over existing package (overwrite in place, no rename)
    log('[tarball] Copying files with robocopy (overwrite in place)...');
    try {
      // robocopy exit codes: 0=no files copied, 1=files copied, 2=extra files in dest,
      // 4=mismatches, 8+=errors. Codes 0-7 are success.
      const result = execFileSync('robocopy', [
        srcDir, pkgDir,
        '/E',         // Copy subdirectories including empty ones
        '/R:3',       // Retry 3 times on failed copies
        '/W:2',       // Wait 2 seconds between retries
        '/NFL',       // No file listing (less noise)
        '/NDL',       // No directory listing
        '/NJH',       // No job header
        '/NJS',       // No job summary
        '/XD', 'node_modules',  // Exclude node_modules (managed by npm separately)
      ], {
        encoding: 'utf-8', timeout: 120_000, windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      log('[tarball] robocopy completed');
    } catch (e) {
      // robocopy returns non-zero for "files were copied" (exit code 1)
      // Only codes 8+ are actual errors
      const code = e.status || 0;
      if (code >= 8) {
        log(`[tarball] robocopy failed with exit code ${code}: ${e.stderr || e.message}`);
        return false;
      }
      log(`[tarball] robocopy completed (exit code ${code} — files copied)`);
    }

    // 4. Install/update dependencies
    log('[tarball] Installing dependencies...');
    try {
      execFileSync(npm.cmd, [...npm.prefix, 'install', '--omit=dev', '--ignore-scripts'], {
        encoding: 'utf-8', timeout: 120_000, windowsHide: true,
        cwd: pkgDir,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, CLAUDECODE: undefined },
      });
      log('[tarball] Dependencies installed');
    } catch (e) {
      // Non-fatal: existing node_modules may still work
      log(`[tarball] Warning: npm install failed: ${(e.stderr || e.message || '').slice(0, 200)}`);
    }

    log('[tarball] Upgrade via tarball completed successfully');
    return true;
  } catch (e) {
    log(`[tarball] Unexpected error: ${e.message}`);
    return false;
  } finally {
    // Cleanup temp dir
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  ensureLogDir();
  fs.writeFileSync(LOG_FILE, '');
  log('=== upgrade started ===');

  const source = resolveSource(process.argv.slice(2));
  log(`Install source: ${source.label}${source.isCustom ? ' (custom build)' : ' (published latest)'}`);

  const claudeBin = which('claude');
  const apiPort = process.env.API_PORT || '3100';
  const webPort = process.env.WEB_PORT || '3848';
  const npmGlobalRoot = getNpmGlobalRoot();

  // ── Step 1: Plugin install ──────────────────────────────────────────────
  // The marketplace plugin always tracks the published release, so for a custom
  // build we skip it — installing the public plugin would not match the build
  // being laid down and could overwrite a deliberately-pinned version.
  log('--- Step 1: Plugin install ---');
  if (source.isCustom) {
    log('Custom build source — skipping marketplace plugin install (use --from latest to refresh it).');
  } else if (claudeBin) {
    run(claudeBin, ['plugin', 'install', 'lm-assist@langmartai'], 'Plugin install');
  } else {
    log('claude binary not found in PATH, skipping plugin install');
  }

  // ── Step 2: Kill everything ─────────────────────────────────────────────
  log('--- Step 2: Stopping all lm-assist processes ---');

  // 2a: Kill services by port (prod + dev)
  killByPort(apiPort);
  killByPort(webPort);
  killByPort('3200');  // dev API
  killByPort('3948');  // dev Web

  // 2b: Clean PID files
  cleanPidFiles(LOG_DIR);
  if (npmGlobalRoot) cleanPidFiles(path.join(npmGlobalRoot, 'lm-assist', 'core'));
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude-code-config.json'), 'utf-8'));
    if (cfg.devRepoPath) cleanPidFiles(path.join(cfg.devRepoPath, 'core'));
  } catch {}

  // 2c: Kill ALL lm-assist node processes (MCP server, hooks, etc.)
  killAllLmAssistProcesses();

  // 2d: Wait for OS to release file handles
  const waitSec = isWindows ? 8 : 2;
  log(`Waiting ${waitSec}s for file handles to release...`);
  await sleep(waitSec * 1000);

  // ── Step 3: npm install ─────────────────────────────────────────────────
  log(`--- Step 3: npm install -g ${source.spec} ---`);

  // Clean npm staging directories from any previous failed installs
  if (isWindows && npmGlobalRoot) {
    try {
      for (const entry of fs.readdirSync(npmGlobalRoot)) {
        if (entry.startsWith('.lm-assist-')) {
          try {
            fs.rmSync(path.join(npmGlobalRoot, entry), { recursive: true, force: true });
            log(`Cleaned staging dir: ${entry}`);
          } catch {}
        }
      }
    } catch {}
  }

  // Attempt 1: Try npm install directly (works when file handles are released)
  let npmOk = runNpmInstall(source.spec);

  // Attempt 2 (Windows only): If npm failed with EBUSY, use tarball + robocopy fallback.
  // This overwrites files in place (no directory rename), bypassing the EBUSY issue
  // caused by Windows Defender/Indexer holding handles on the package directory.
  if (!npmOk && isWindows && npmGlobalRoot) {
    const pkgDir = path.join(npmGlobalRoot, 'lm-assist');
    log('npm install failed (likely EBUSY), trying tarball + robocopy fallback...');
    npmOk = upgradeViaTarball(pkgDir, source);
  }

  if (!npmOk) {
    log(`ERROR: All upgrade methods failed. Run manually: npm install -g ${source.spec}`);
  }

  // ── Step 4: Start services ──────────────────────────────────────────────
  log('--- Step 4: Starting services ---');
  await sleep(1000);

  // Re-derive npm root (may have changed after fresh install)
  const freshNpmRoot = getNpmGlobalRoot();
  let lmBin = null;
  if (freshNpmRoot) {
    const candidate = path.join(freshNpmRoot, 'lm-assist', 'bin', 'lm-assist.js');
    if (fs.existsSync(candidate)) lmBin = candidate;
  }
  if (!lmBin) {
    const fromScript = path.resolve(__dirname, '..', '..', 'bin', 'lm-assist.js');
    if (fs.existsSync(fromScript)) lmBin = fromScript;
  }

  if (lmBin) {
    // Use `restart`, not `start`. Something (the web start hook / a self-heal)
    // can respawn the core DURING `npm install` — before the package files are
    // moved into place — so it loads the OLD code. A plain `start` then no-ops
    // ("already running") and leaves that stale process serving. `restart`
    // stops whatever is up and launches fresh from the just-installed build.
    run(process.execPath, [lmBin, 'restart'], 'Service restart');
  } else {
    log('ERROR: Cannot find lm-assist binary to start services');
  }

  log('=== upgrade finished ===');
}

main().catch(err => {
  try { log(`FATAL: ${err.message}`); } catch {}
  process.exitCode = 1;
});
