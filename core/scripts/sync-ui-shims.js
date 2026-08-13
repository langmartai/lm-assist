#!/usr/bin/env node
/**
 * Re-copy the canonical pane shim over every stale INSTALLED pane.
 *
 * The panes that run are served from the node's apps root (~/.lmui/apps by default), which a
 * Core build never touches — so `./core.sh build && ./core.sh restart` upgrades the SERVER half
 * of the pane contract and leaves the CLIENT half on whatever a human last copied. This is the
 * step that closes that gap. Run it as part of every deploy that changed the pane shim
 * (`ui-apps/<pane>/assets/lmui.js`).
 *
 * Usage:
 *   node core/scripts/sync-ui-shims.js            # copy the canonical shim over every stale pane
 *   node core/scripts/sync-ui-shims.js --check    # report only, change nothing (exit 1 if stale)
 *   node core/scripts/sync-ui-shims.js --json     # machine-readable report
 *
 * Exit codes: 0 = nothing to do / synced, 1 = drift found (--check) or a copy failed,
 *             2 = the canonical shim could not be resolved (Core needs a rebuild).
 *
 * Reads the compiled module, so `./core.sh build` must have run at least once.
 */
'use strict';
const path = require('node:path');
const fs = require('node:fs');

const args = new Set(process.argv.slice(2));
const CHECK_ONLY = args.has('--check') || args.has('-n') || args.has('--dry-run');
const JSON_OUT = args.has('--json');

const MOD = path.join(__dirname, '..', 'dist', 'ui-pages', 'shim-sync.js');
if (!fs.existsSync(MOD)) {
  console.error(`[sync-ui-shims] ${MOD} not found — build Core first (./core.sh build).`);
  process.exit(2);
}
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { checkShims, syncShims, formatDrift } = require(MOD);

function main() {
  if (CHECK_ONLY) {
    const r = checkShims();
    if (JSON_OUT) { console.log(JSON.stringify(r, null, 2)); return r.canonicalHash === null ? 2 : (r.stale.length ? 1 : 0); }
    if (r.canonicalHash === null) { for (const l of formatDrift(r)) console.error(l); return 2; }
    const lines = formatDrift(r);
    if (lines.length) { for (const l of lines) console.error(l); return 1; }
    console.log(`[sync-ui-shims] ${r.panes.filter((p) => p.state === 'match').length} pane(s) in sync`
      + `${r.bundled.length ? `; ${r.bundled.length} bundled (rebuild from source, a copy cannot reach them): ${r.bundled.map((p) => p.uiId).join(', ')}` : ''}`);
    return 0;
  }

  const res = syncShims();
  if (JSON_OUT) { console.log(JSON.stringify(res, null, 2)); return res.failed.length ? 1 : 0; }

  if (res.report.canonicalHash === null) {
    for (const l of formatDrift(res.report)) console.error(l);
    return 2;
  }
  if (!res.synced.length && !res.failed.length) {
    console.log(`[sync-ui-shims] nothing to do — ${res.report.panes.filter((p) => p.state === 'match').length} pane(s) already in sync`);
  } else {
    for (const id of res.synced) console.log(`[sync-ui-shims] synced ${id}`);
    if (res.synced.length) {
      console.log(`[sync-ui-shims] ${res.synced.length} pane(s) updated from ${res.report.canonicalPath}`);
      console.log('[sync-ui-shims] 🔴 Panes already open in a browser need ONE reload to pick up the new shim.');
    }
  }
  for (const f of res.failed) console.error(`[sync-ui-shims] FAILED ${f.uiId}: ${f.error}`);
  if (res.bundled.length) {
    console.error(`[sync-ui-shims] ⚠️  NOT reachable by a copy — ${res.bundled.length} pane(s) inline the shim into a bundled`);
    console.error(`[sync-ui-shims] ⚠️  app.js (${res.bundled.join(', ')}). Rebuild those from their own source.`);
  }
  return res.failed.length ? 1 : 0;
}

process.exit(main());
