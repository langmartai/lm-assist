#!/usr/bin/env node
'use strict';
/**
 * scripts/preflight.js — lm-assist environment preflight / doctor (single source of truth).
 *
 * Dependency-free CommonJS; only Node built-ins; must parse + run on ANY Node (incl. a
 * too-old one) so it can diagnose itself. Pure logic here; the CLI + IO probes are in Task 2.
 *
 * CLI (Task 2): node scripts/preflight.js [--json] [--phase=pre-clone|post-clone] [--repo=<dir>]
 * Exit 0 iff every HARD check passes.
 */

var MIN_NODE = { major: 20, minor: 9 }; // Next 16 web build floor

/** Parse "v20.9.0" / "20.9.0" → {major,minor,patch} | null. */
function parseNodeVersion(v) {
  var m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(v == null ? '' : v).trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

/** True if parsed >= min (default MIN_NODE). */
function nodeMeetsMinimum(parsed, min) {
  min = min || MIN_NODE;
  if (!parsed) return false;
  if (parsed.major !== min.major) return parsed.major > min.major;
  return parsed.minor >= min.minor;
}

/** The exact upgrade command to print when Node is too old (never executed). */
function nodeUpgradeGuidance(platform, managers) {
  managers = managers || {};
  var target = '20';
  var targetFull = '20.19.6';
  if (platform === 'win32') {
    if (managers.nvmWindows) return 'nvm install ' + targetFull + ' ; nvm use ' + targetFull;
    if (managers.fnm) return 'fnm install ' + target + ' ; fnm use ' + target;
    return 'Download Node.js LTS (>= 20.9) from https://nodejs.org/ and re-run the installer.';
  }
  if (managers.nvm) return 'nvm install ' + target + ' && nvm use ' + target;
  if (managers.fnm) return 'fnm install ' + target + ' && fnm use ' + target;
  return 'Install Node.js LTS (>= 20.9) from https://nodejs.org/ (or your package manager) and re-run.';
}

/** Build the full evaluation from injected inputs (no IO). */
function evaluate(input) {
  input = input || {};
  var checks = [];
  var parsed = parseNodeVersion(input.nodeVersion);
  var nodeOk = nodeMeetsMinimum(parsed, MIN_NODE);
  checks.push({
    name: 'node', ok: nodeOk, hard: true,
    detail: nodeOk
      ? input.nodeVersion + ' (>= ' + MIN_NODE.major + '.' + MIN_NODE.minor + ')'
      : (input.nodeVersion || 'not found') + ' — need >= ' + MIN_NODE.major + '.' + MIN_NODE.minor,
  });
  checks.push({ name: 'git', ok: !!input.hasGit, hard: true, detail: input.hasGit ? 'present' : 'not found' });
  checks.push({ name: 'npm', ok: !!input.hasNpm, hard: true, detail: input.hasNpm ? 'present' : 'not found' });

  var chokidarBad = false;
  if (input.phase === 'post-clone' && input.chokidar !== undefined) {
    var ck = input.chokidar || {};
    var ckOk = !!ck.resolved && /^3\.6\./.test(ck.version || '');
    chokidarBad = !ckOk;
    checks.push({
      name: 'chokidar', ok: ckOk, hard: true,
      detail: ckOk
        ? ck.version + ' (CommonJS pin)'
        : (ck.error || ('resolves to ' + (ck.version || '?') + ' — must be 3.6.x (4/5 are ESM-only → ERR_REQUIRE_ESM)')),
    });
  }

  if (input.phase === 'post-clone' && input.workspace !== undefined) {
    var ws = input.workspace || {};
    var wsOk = ws.rootWorkspaces === true && ws.strayChokidar !== true;
    var wsDetail;
    if (wsOk) {
      wsDetail = 'workspaces root OK';
    } else {
      var problems = [];
      if (!ws.rootWorkspaces) problems.push('no "workspaces" in root package.json');
      if (ws.strayChokidar) problems.push('stray core/node_modules/chokidar shadows the hoisted pin');
      wsDetail = problems.join('; ');
    }
    checks.push({ name: 'workspace', ok: wsOk, hard: false, detail: wsDetail });
  }

  var hardFail = checks.some(function (c) { return c.hard && !c.ok; });
  var guidance = null;
  if (!nodeOk) guidance = nodeUpgradeGuidance(input.platform, input.managers);
  else if (chokidarBad) guidance = 'Fix the chokidar pin:  npm install chokidar@^3.6.0 --ignore-scripts  (and remove any nested core/node_modules/chokidar).';
  else if (!input.hasGit || !input.hasNpm) guidance = 'Install the missing prerequisite(s) and re-run.';

  return {
    ok: !hardFail,
    platform: input.platform || null,
    arch: input.arch || null,
    nodeVersion: input.nodeVersion || null,
    checks: checks,
    guidance: guidance,
  };
}

// ── IO probes (used only by the CLI) ──
var cp = require('child_process');
var fs = require('fs');
var os = require('os');
var path = require('path');

function cmdPresent(cmd) {
  try {
    if (process.platform === 'win32') {
      cp.execSync('where ' + cmd, { stdio: 'ignore' });
    } else {
      cp.execSync('command -v ' + cmd, { stdio: 'ignore', shell: '/bin/sh' });
    }
    return true;
  } catch (e) { return false; }
}

function detectManagers() {
  var home = os.homedir();
  return {
    nvm: !!process.env.NVM_DIR || fs.existsSync(path.join(home, '.nvm', 'nvm.sh')),
    fnm: !!process.env.FNM_DIR || cmdPresent('fnm'),
    nvmWindows: process.platform === 'win32' && (!!process.env.NVM_HOME || cmdPresent('nvm')),
  };
}

function probeChokidar(repo) {
  try {
    var fromDist = path.join(repo, 'core', 'dist');
    var pkgPath = require.resolve('chokidar/package.json', { paths: [fromDist] });
    var pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    require.resolve('chokidar', { paths: [fromDist] }); // confirm the entry resolves too
    return { resolved: true, version: pkg.version };
  } catch (e) {
    return { resolved: false, error: 'chokidar did not resolve from core/dist: ' + (e && e.message) };
  }
}

function probeWorkspace(repo) {
  var rootWorkspaces = false;
  try {
    var rootPkg = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'));
    var ws = rootPkg.workspaces;
    rootWorkspaces = Array.isArray(ws) || !!(ws && Array.isArray(ws.packages));
  } catch (e) { rootWorkspaces = false; }
  return {
    rootWorkspaces: rootWorkspaces,
    strayChokidar: fs.existsSync(path.join(repo, 'core', 'node_modules', 'chokidar')),
  };
}

function printReport(r) {
  var sym = function (c) { return c.ok ? '✓' : (c.hard ? '✗' : '•'); };
  var out = [];
  out.push('lm-assist preflight — ' + r.platform + '/' + r.arch + ', node ' + r.nodeVersion);
  for (var i = 0; i < r.checks.length; i++) {
    var c = r.checks[i];
    out.push('  ' + sym(c) + ' ' + c.name + ': ' + c.detail);
  }
  if (!r.ok && r.guidance) { out.push(''); out.push('Guidance:'); out.push('  ' + r.guidance); }
  out.push('');
  out.push(r.ok ? 'Preflight OK.' : 'Preflight FAILED — resolve the above and re-run.');
  process.stdout.write(out.join('\n') + '\n');
}

function main(argv) {
  var opts = { json: false, phase: 'pre-clone', repo: process.cwd() };
  for (var i = 0; i < argv.length; i++) {
    var a = argv[i];
    if (a === '--json') opts.json = true;
    else if (a.indexOf('--phase=') === 0) opts.phase = a.slice('--phase='.length);
    else if (a.indexOf('--repo=') === 0) opts.repo = a.slice('--repo='.length);
  }
  var result = evaluate({
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    hasGit: cmdPresent('git'),
    hasNpm: cmdPresent('npm'),
    managers: detectManagers(),
    phase: opts.phase,
    chokidar: opts.phase === 'post-clone' ? probeChokidar(opts.repo) : undefined,
    workspace: opts.phase === 'post-clone' ? probeWorkspace(opts.repo) : undefined,
  });
  if (opts.json) process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  else printReport(result);
  process.exit(result.ok ? 0 : 1);
}

module.exports = { MIN_NODE: MIN_NODE, parseNodeVersion: parseNodeVersion, nodeMeetsMinimum: nodeMeetsMinimum, nodeUpgradeGuidance: nodeUpgradeGuidance, evaluate: evaluate, probeWorkspace: probeWorkspace };

if (require.main === module) main(process.argv.slice(2));
