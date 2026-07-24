#!/usr/bin/env node
/**
 * Copies voice-v2 relay assets from src to dist after tsc.
 *
 * tsc only compiles .ts — it leaves plain .js assets under src/ alone. Without this
 * step, core/src/voice/assets/claude-ws-relay.js never reaches core/dist/voice/assets/,
 * so a dist-only prod install (core/src absent) throws `asset_missing` from
 * claude-chrome.ts's loadRelayAssetSource() the first time voice v2 tries to open a
 * relay page. Cross-platform (fs, no shell/cp) and resolves every path relative to
 * this script's own location, so it works from any cwd.
 *
 * Usage: node scripts/copy-voice-assets.js
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SRC_DIR = path.join(ROOT, 'src', 'voice', 'assets');
const DIST_DIR = path.join(ROOT, 'dist', 'voice', 'assets');

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  let copied = 0;
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) copied += copyDir(srcPath, destPath);
    else if (entry.isFile()) { fs.copyFileSync(srcPath, destPath); copied++; }
  }
  return copied;
}

if (!fs.existsSync(SRC_DIR)) {
  console.error(`[copy-voice-assets] no ${SRC_DIR} — nothing to copy`);
  process.exit(1);
}

const n = copyDir(SRC_DIR, DIST_DIR);
console.log(`[copy-voice-assets] copied ${n} file(s): ${path.relative(ROOT, SRC_DIR)} -> ${path.relative(ROOT, DIST_DIR)}`);
