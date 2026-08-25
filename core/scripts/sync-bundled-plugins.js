#!/usr/bin/env node
/**
 * Install / report the first-party plugins that ship inside this package.
 *
 * Core already runs this on every boot (`rest-server.ts`), so this CLI is for the
 * cases a boot hook cannot cover: inspecting what the package carries, re-running a
 * seed after granting something by hand, and diagnosing a node whose plugin dir was
 * edited. It is deliberately the same code path — not a re-implementation.
 *
 * Usage:  node core/scripts/sync-bundled-plugins.js [check|sync]
 *           check   (default) report what WOULD happen; writes nothing
 *           sync    seed + grant + auto-enable
 */
const path = require('path');

const mode = (process.argv[2] || 'check').toLowerCase();
if (!['check', 'sync'].includes(mode)) {
  console.error(`usage: node ${path.basename(__filename)} [check|sync]`);
  process.exit(1);
}

let mod;
try {
  mod = require(path.join(__dirname, '..', 'dist', 'mcp-server', 'plugins', 'bundled.js'));
} catch (e) {
  console.error(`[bundled] core/dist is not built (${e.message}) — run ./core.sh build`);
  process.exit(1);
}

const { seedBundledPlugins, readBundledIndex, formatSeedResults, bundledSourceDir } = mod;
const { pluginsDir } = require(path.join(__dirname, '..', 'dist', 'mcp-server', 'plugins', 'paths.js'));

const index = readBundledIndex();
if (index.plugins.length === 0) {
  console.log('[bundled] this build ships no first-party plugins');
  console.log(`[bundled] looked in ${bundledSourceDir()}`);
  process.exit(0);
}

console.log(`[bundled] package: ${bundledSourceDir()}`);
console.log(`[bundled] node   : ${pluginsDir()}`);

const results = seedBundledPlugins({ dryRun: mode === 'check' });
if (results.length === 0) {
  console.log('[bundled] disabled by LM_BUNDLED_PLUGINS=0 or LM_MCP_PLUGINS=0 — nothing done');
  process.exit(0);
}
for (const line of formatSeedResults(results)) console.log(`[bundled] ${line}`);

if (mode === 'check') {
  const pending = results.filter((r) => r.outcome === 'seeded' || r.outcome === 'updated');
  console.log(pending.length
    ? `[bundled] ${pending.length} plugin(s) would change — run: ./core.sh plugins sync`
    : '[bundled] nothing to do');
}

// A changed tool surface only reaches claude.ai through the connector sync that
// enable/disable normally trigger; a CLI seed happens outside that path.
if (mode === 'sync' && results.some((r) => r.enabled)) {
  console.log('[bundled] tools changed — restart Core, or POST /mcp-plugins/sync-connector to propagate to claude.ai');
}
