#!/usr/bin/env node
/**
 * Bakes the canonical pane shim into core/dist after tsc.
 *
 *   ui-apps/assist-backlog/assets/lmui.js  ->  core/dist/ui-pages/shim/lmui.js
 *
 * WHY Core needs its own copy of a file that already exists in the repo:
 * the panes that actually RUN are served from ~/.lmui/apps, which no build touches. Two
 * surfaces need the canonical BYTES to notice that — the boot-time drift check
 * (core/src/ui-pages/shim-sync.ts) and `node core/scripts/sync-ui-shims.js` — and
 * `ui-apps/` is NOT in the npm package `files` list, so a prod install has no repo to
 * read them from. Baking the shim into dist at build time is the only way both surfaces
 * work in prod as well as from source.
 *
 * tsc only compiles .ts, so this runs as a build step next to copy-voice-assets.js.
 * Cross-platform (fs, no shell/cp) and resolves every path from this script's own
 * location, so it works from any cwd.
 *
 * Usage: node scripts/copy-ui-shim.js
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const CORE = path.resolve(__dirname, '..');
const REPO = path.resolve(CORE, '..');
const CANONICAL_PANE = 'assist-backlog';
const UI_APPS = path.join(REPO, 'ui-apps');
const SRC = path.join(UI_APPS, CANONICAL_PANE, 'assets', 'lmui.js');
const DEST_DIR = path.join(CORE, 'dist', 'ui-pages', 'shim');
const DEST = path.join(DEST_DIR, 'lmui.js');

// No ui-apps/ at all = not a source checkout (nothing to copy, and nothing is wrong).
// Warn rather than fail: the drift check degrades to "canonical unknown" and SAYS so.
if (!fs.existsSync(UI_APPS)) {
  console.warn(`[copy-ui-shim] no ${UI_APPS} — skipping (drift check will report the canonical shim as unknown)`);
  process.exit(0);
}

// ui-apps/ exists but the canonical pane's shim does not: someone renamed or deleted the
// pane this whole mechanism is anchored on. Fail LOUDLY — a silent skip here would leave
// the drift check permanently blind, which is the exact failure class it exists to catch.
if (!fs.existsSync(SRC)) {
  console.error(
    `[copy-ui-shim] MISSING CANONICAL SHIM: ${SRC}\n`
    + `[copy-ui-shim] ui-apps/${CANONICAL_PANE}/assets/lmui.js is the canonical copy every pane is synced from.\n`
    + `[copy-ui-shim] If the canonical pane was renamed, update CANONICAL_PANE in BOTH this script and\n`
    + `[copy-ui-shim] core/src/ui-pages/shim-sync.ts (core/src/__tests__/ui-shim-sync.test.ts asserts they agree).`,
  );
  process.exit(1);
}

fs.mkdirSync(DEST_DIR, { recursive: true });
fs.copyFileSync(SRC, DEST);
const bytes = fs.statSync(DEST).size;
console.log(`[copy-ui-shim] ${path.relative(REPO, SRC)} -> ${path.relative(REPO, DEST)} (${bytes} bytes)`);
