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
  if (input.phase === 'post-clone') {
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

module.exports = { MIN_NODE: MIN_NODE, parseNodeVersion: parseNodeVersion, nodeMeetsMinimum: nodeMeetsMinimum, nodeUpgradeGuidance: nodeUpgradeGuidance, evaluate: evaluate };
