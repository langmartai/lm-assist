#!/usr/bin/env node
/**
 * Maintain `core/data/mcp-plugins/` — the MIRRORS of plugins whose source lives in
 * another repository — and regenerate `bundled.json`.
 *
 * ── The rule this script enforces ─────────────────────────────────────────────────
 * A mirrored payload is NOT editable here. Its upstream repo is the source of truth;
 * lm-assist only carries a copy so the plugin can travel in the package. To change a
 * mirrored plugin you edit it UPSTREAM, then re-vendor:
 *
 *     node core/scripts/gen-bundled-plugins.js --from <upstream>/mcp-plugins
 *
 * Each mirror records the upstream payload checksum it was vendored from. A plain run
 * compares the files here against that record, so an edit made to the copy FAILS loudly
 * instead of silently forking a repo we do not own.
 *
 * Usage:
 *   node core/scripts/gen-bundled-plugins.js                  verify + reindex
 *   node core/scripts/gen-bundled-plugins.js --from <dir>     re-vendor from upstream, then reindex
 *   node core/scripts/gen-bundled-plugins.js --check          exit 1 on any drift, write nothing
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'data', 'mcp-plugins');
const INDEX = path.join(ROOT, 'bundled.json');
const argv = process.argv.slice(2);
const CHECK = argv.includes('--check');
const FROM = (() => {
  const i = argv.indexOf('--from');
  return i >= 0 && argv[i + 1] ? path.resolve(argv[i + 1]) : null;
})();

// Use the loader's own implementation — a second copy of the hashing rule is exactly
// how a pin silently stops matching.
let payloadChecksum, manifestDigest;
try {
  ({ payloadChecksum, manifestDigest } = require(path.join(__dirname, '..', 'dist', 'mcp-server', 'plugins', 'checksum.js')));
} catch {
  console.error('[bundled] core/dist is not built — run ./core.sh build first (this script reuses the loader\'s checksum).');
  process.exit(1);
}

function fail(msg) { console.error(`[bundled] ${msg}`); process.exitCode = 1; }
function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }

const prev = fs.existsSync(INDEX) ? readJson(INDEX) : { plugins: [] };
const prevByName = new Map((prev.plugins || []).map((p) => [p.name, p]));

// --- re-vendor from upstream ------------------------------------------------------

function copyTree(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, e.name), to = path.join(dst, e.name);
    if (e.isSymbolicLink()) throw new Error(`symlink in upstream payload: ${from}`);
    if (e.isDirectory()) { copyTree(from, to); continue; }
    if (!e.isFile()) throw new Error(`unsupported file type in upstream payload: ${from}`);
    fs.copyFileSync(from, to);
  }
}

/** Drop anything the upstream no longer ships, so the mirror is exactly upstream. */
function prune(src, dst) {
  for (const e of fs.readdirSync(dst, { withFileTypes: true })) {
    const inDst = path.join(dst, e.name), inSrc = path.join(src, e.name);
    if (!fs.existsSync(inSrc)) { fs.rmSync(inDst, { recursive: true, force: true }); continue; }
    if (e.isDirectory()) prune(inSrc, inDst);
  }
}

const vendoredNow = new Map();   // name -> upstream record, for plugins re-vendored this run

if (FROM) {
  if (CHECK) { console.error('[bundled] --from and --check are mutually exclusive'); process.exit(1); }
  if (!fs.existsSync(FROM)) { console.error(`[bundled] upstream not found: ${FROM}`); process.exit(1); }

  for (const e of fs.readdirSync(FROM, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const upDir = path.join(FROM, e.name);
    if (!fs.existsSync(path.join(upDir, 'mcp-plugin.json'))) continue;   // tools/, test/, …

    const upManifest = readJson(path.join(upDir, 'mcp-plugin.json'));
    const upChecksum = payloadChecksum(upDir);
    // The upstream must have run ITS gen-manifest.js first; vendoring an unstamped
    // payload would mirror a manifest whose pin was never true.
    if (upManifest.checksum !== upChecksum) {
      fail(`${e.name}: upstream payload is ${upChecksum} but its manifest pins ${upManifest.checksum} — ` +
           `run the upstream repo's gen-manifest.js before vendoring`);
      continue;
    }
    const dst = path.join(ROOT, e.name);
    copyTree(upDir, dst);
    if (fs.existsSync(dst)) prune(upDir, dst);
    // 🔴 CHECKSUM ONLY. bundled.json is published to a public repo and to npm, and an
    // upstream may be PRIVATE — recording its URL, name, or local path would disclose the
    // repository to everyone who installs lm-assist. The hash is all the mirror rule needs.
    vendoredNow.set(e.name, { checksum: upChecksum });
    console.log(`[bundled] vendored ${e.name}@${upManifest.version} from upstream`);
  }
  if (process.exitCode === 1) { console.error('[bundled] refusing to index a bad upstream'); process.exit(1); }
}

// --- verify + index ---------------------------------------------------------------

const entries = [];
const dirs = fs.existsSync(ROOT)
  ? fs.readdirSync(ROOT, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort()
  : [];

for (const name of dirs) {
  const dir = path.join(ROOT, name);
  const manifestPath = path.join(dir, 'mcp-plugin.json');
  if (!fs.existsSync(manifestPath)) { fail(`${name}: no mcp-plugin.json — not a plugin payload`); continue; }

  let manifest;
  try { manifest = readJson(manifestPath); }
  catch (e) { fail(`${name}: manifest is not valid JSON: ${e.message}`); continue; }

  if (manifest.name !== name) { fail(`${name}: manifest name is "${manifest.name}" — it must equal the directory name`); continue; }

  const checksum = payloadChecksum(dir);
  if (manifest.checksum !== checksum) {
    fail(`${name}: payload is ${checksum} but its manifest pins ${manifest.checksum} — ` +
         `re-run the upstream repo's gen-manifest.js, then re-vendor with --from`);
    continue;
  }

  const upstream = vendoredNow.get(name) ?? prevByName.get(name)?.upstream;
  // THE MIRROR RULE. A mirrored payload that no longer matches what it was vendored
  // from means somebody edited lm-assist's copy of a repo lm-assist does not own.
  if (upstream && upstream.checksum !== checksum) {
    fail(`${name}: this is a MIRROR and it has been edited here.\n` +
         `           vendored from : ${upstream.checksum}\n` +
         `           on disk now   : ${checksum}\n` +
         `           Fix it in the repo this payload is maintained in, then re-vendor:\n` +
         `             node core/scripts/gen-bundled-plugins.js --from <upstream>/mcp-plugins\n` +
         `           Do NOT hand-edit core/data/mcp-plugins/${name}/.`);
    continue;
  }

  const entry = { name, version: manifest.version, checksum, manifestDigest: manifestDigest(manifest) };
  if (upstream) entry.upstream = upstream;
  entries.push(entry);
}

if (process.exitCode === 1) {
  console.error('[bundled] refusing to write an index over a broken or hand-edited payload');
  process.exit(1);
}

const next = JSON.stringify({ plugins: entries }, null, 2) + '\n';
const before = fs.existsSync(INDEX) ? fs.readFileSync(INDEX, 'utf8') : '';
const drift = before !== next;

if (CHECK) {
  if (drift) {
    console.error('[bundled] bundled.json is STALE — run: node core/scripts/gen-bundled-plugins.js');
    process.exit(1);
  }
  console.log(`[bundled] bundled.json is current (${entries.length} plugin${entries.length === 1 ? '' : 's'})`);
  process.exit(0);
}

if (drift) {
  fs.mkdirSync(ROOT, { recursive: true });
  fs.writeFileSync(INDEX, next);
}
for (const e of entries) {
  console.log(`[bundled] ${e.name}@${e.version} payload=${e.checksum} manifest=${e.manifestDigest}` +
              (e.upstream ? ' (mirror)' : ' (lm-assist\'s own)'));
}
console.log(`[bundled] ${drift ? 'wrote' : 'unchanged'} ${path.relative(process.cwd(), INDEX)}`);
