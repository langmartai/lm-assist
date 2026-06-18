#!/usr/bin/env node
/**
 * memory-apply-plan.js -- Apply validated metadata from memory-validate-plan.jsonl
 * back to memory file frontmatter.
 *
 * SAFETY: Defaults to PREVIEW mode (prints before/after diffs, writes nothing).
 * WRITE mode requires BOTH --write flag AND env MEMORY_VALIDATE_APPLY=on.
 * Even then: backs up every file before writing, kind=memory only,
 * owned-source only (live | repo:linux-117), no body changes.
 *
 * Usage:
 *   node core/scripts/memory-apply-plan.js [--preview]   (default)
 *   node core/scripts/memory-apply-plan.js --write        (gated: also needs MEMORY_VALIDATE_APPLY=on)
 *   node core/scripts/memory-apply-plan.js --project <slug>
 *   node core/scripts/memory-apply-plan.js --record <recordId>
 *   node core/scripts/memory-apply-plan.js --limit <N>
 *
 * Ownership scope (linux-117 host):
 *   source=live         -> ~/.claude/projects/<project>/memory/<file>
 *   source=repo:linux-117 -> <projectPath>/memory/linux-117/<file>
 *   source=repo:<other> -> SKIP (not owned by this host)
 */
"use strict";
const fs   = require("fs");
const path = require("path");
const os   = require("os");
const http = require("http");
const { loopbackAuthHeader } = require("./lib/loopback-auth");
const { execFileSync } = require("child_process");

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const PLAN_FILE   = path.join(os.homedir(), ".lm-assist", "memory-validate-plan.jsonl");
const BACKUP_ROOT = path.join(os.homedir(), ".lm-assist", "apply-backups");
const MAP_SCRIPT  = path.join(__dirname, "memory-map.js");
const PORT = process.env.API_PORT || (__dirname.includes("node_modules") ? "3100" : "3200");

const argv    = process.argv.slice(2);
const opt     = (k, d) => { const i = argv.indexOf("--" + k); return i >= 0 ? argv[i + 1] : d; };
const has     = (k) => argv.includes("--" + k);

const writeMode    = has("write");
const filterProj   = opt("project");
const filterRecord = opt("record");
const limitN       = parseInt(opt("limit", "0"), 10) || 0;

// ---------------------------------------------------------------------------
// Safety gate
// ---------------------------------------------------------------------------
if (writeMode && process.env.MEMORY_VALIDATE_APPLY !== "on") {
  console.error("[apply] REFUSED: --write requires env MEMORY_VALIDATE_APPLY=on.");
  console.error("[apply] Default mode is --preview (prints diffs, writes nothing).");
  console.error("[apply] Set MEMORY_VALIDATE_APPLY=on to enable writes.");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function runMapJSON(flags) {
  const fullFlags = [...flags, "--port", PORT, "--format", "json"];
  try {
    const out = execFileSync("node", [MAP_SCRIPT, ...fullFlags], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      timeout: 60000,
    });
    return JSON.parse(out || "null");
  } catch (e) {
    throw new Error("memory-map.js failed: " + (e.message || e));
  }
}

function fetchProjects() {
  return new Promise(function(resolve) {
    http.get("http://localhost:" + PORT + "/memory/projects", { headers: loopbackAuthHeader() }, function(res) {
      let d = "";
      res.on("data", function(c) { d += c; });
      res.on("end", function() {
        try { resolve(JSON.parse(d).data || []); } catch { resolve([]); }
      });
    }).on("error", function() { resolve([]); });
  });
}

/** Load all plan verdicts, keep only the LATEST per recordId. */
function loadLatestPlan() {
  const latest = {};
  if (!fs.existsSync(PLAN_FILE)) return latest;
  const lines = fs.readFileSync(PLAN_FILE, "utf8").trim().split(String.fromCharCode(10)).filter(Boolean);
  for (const line of lines) {
    let item;
    try { item = JSON.parse(line); } catch { continue; }
    const rid = item.recordId;
    if (!rid) continue;
    if (!latest[rid] || item._planWrittenAt > latest[rid]._planWrittenAt) {
      latest[rid] = item;
    }
  }
  return latest;
}

/** Parse frontmatter block out of a file. Returns { fm: Record<string,string>, body: string, rawBlock: string }. */
function parseFmRaw(content) {
  const normalized = content.replace(/\r\n/g, String.fromCharCode(10));
  const BOM = String.fromCharCode(0xFEFF);
  const stripped = normalized.startsWith(BOM) ? normalized.slice(1) : normalized;
  const NL = String.fromCharCode(10);
  if (!stripped.startsWith("---" + NL)) {
    return { fm: {}, body: stripped, rawBlock: null, hasFrontmatter: false };
  }
  const lines = stripped.split(NL);
  let endIndex = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === "---" || lines[i] === "---\r") { endIndex = i; break; }
  }
  if (endIndex === -1) {
    return { fm: {}, body: stripped, rawBlock: null, hasFrontmatter: false };
  }
  const fmLines = lines.slice(1, endIndex);
  const bodyLines = lines.slice(endIndex + 1);
  const fm = {};
  for (const rawLine of fmLines) {
    const line = rawLine.replace(/\r$/, "");
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/);
    if (!m) continue;
    let val = m[2].trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))
      val = val.slice(1, -1);
    fm[m[1]] = val;
  }
  const rawBlock = ["---", ...fmLines, "---"].join(NL);
  const body = bodyLines.join(NL).replace(new RegExp("^" + NL + "+"), "");
  return { fm, body, rawBlock, hasFrontmatter: true };
}

/** Serialize fm object + body back to a complete file string. */
function serializeFm(fm, body) {
  const NL = String.fromCharCode(10);
  const ORDERED_KEYS = ["name", "description", "type", "originSessionId",
    "category", "validity", "validationTier", "lastValidatedMs", "supersededBy"];
  const lines = ["---"];
  for (const k of ORDERED_KEYS) {
    if (fm[k] !== undefined && fm[k] !== null && fm[k] !== "") lines.push(k + ": " + fm[k]);
  }
  // Extra keys not in ORDERED_KEYS
  for (const k of Object.keys(fm)) {
    if (!ORDERED_KEYS.includes(k) && fm[k] !== undefined && fm[k] !== null && fm[k] !== "")
      lines.push(k + ": " + fm[k]);
  }
  lines.push("---");
  const bodyStr = (body || "").trimStart();
  return lines.join(NL) + NL + (bodyStr ? NL + bodyStr : "");
}

/** Compute the delta: which keys change. Returns null if no change needed. */
function computeDelta(fm, verdict) {
  const VALID_CATEGORIES = ["index","endpoint","deployment","architecture","component","feature","lesson","config","knowledge"];
  const VALID_VALIDITY   = ["current","stale","outdated","superseded"];
  const VALID_TIERS      = ["code-confirmed","session-confirmed","asserted","unvalidated"];

  const changes = {};
  if (verdict.suggestedCategory && VALID_CATEGORIES.includes(verdict.suggestedCategory)) {
    if (fm.category !== verdict.suggestedCategory) changes.category = verdict.suggestedCategory;
  }
  if (verdict.validity && VALID_VALIDITY.includes(verdict.validity)) {
    if (fm.validity !== verdict.validity) changes.validity = verdict.validity;
  }
  if (verdict.validationTier && VALID_TIERS.includes(verdict.validationTier)) {
    if (fm.validationTier !== verdict.validationTier) changes.validationTier = verdict.validationTier;
  }
  if (verdict.lastValidatedMs && typeof verdict.lastValidatedMs === "number") {
    const current = fm.lastValidatedMs ? parseInt(fm.lastValidatedMs, 10) : 0;
    if (current !== verdict.lastValidatedMs) changes.lastValidatedMs = String(verdict.lastValidatedMs);
  }
  if (verdict.supersededBy && typeof verdict.supersededBy === "string") {
    if (fm.supersededBy !== verdict.supersededBy) changes.supersededBy = verdict.supersededBy;
  }
  return Object.keys(changes).length > 0 ? changes : null;
}

/** Print a unified-ish diff of just the changed keys. */
function printDiff(recordId, filePath, fm, changes) {
  const NL = String.fromCharCode(10);
  const lines = [
    "",
    "--- " + recordId,
    "    file: " + filePath,
  ];
  for (const [k, newVal] of Object.entries(changes)) {
    const oldVal = fm[k] || "(not set)";
    lines.push("  - " + k + ": " + oldVal);
    lines.push("  + " + k + ": " + newVal);
  }
  console.log(lines.join(NL));
}

/** Sanitize a file path for use as a backup file name. */
function sanitizePath(p) {
  return p.replace(/[\/\\:]/g, "_").replace(/^_+/, "");
}

/** Back up a file, then rewrite it with updated frontmatter. */
function applyWrite(filePath, fm, changes, body) {
  // Back up
  const ts = Date.now();
  const backupDir = path.join(BACKUP_ROOT, String(ts));
  fs.mkdirSync(backupDir, { recursive: true });
  const backupFile = path.join(backupDir, sanitizePath(filePath));
  fs.copyFileSync(filePath, backupFile);

  // Merge changes into fm
  const newFm = Object.assign({}, fm, changes);
  const newContent = serializeFm(newFm, body);
  fs.writeFileSync(filePath, newContent, "utf8");
  return backupFile;
}

/** Resolve live dir path for a project slug. */
function liveDir(projectSlug) {
  return path.join(os.homedir(), ".claude", "projects", projectSlug, "memory");
}

/** Resolve projectPath from projects list. */
function resolveProjectPath(projectSlug, projects) {
  const p = projects.find(function(x) { return x.projectId === projectSlug; });
  return p ? p.projectPath : null;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
(async function main() {
  console.log("[apply] mode: " + (writeMode ? "WRITE" : "PREVIEW (default)"));
  if (writeMode) console.log("[apply] WRITE ENABLED (MEMORY_VALIDATE_APPLY=on)");
  console.log("[apply] plan file: " + PLAN_FILE);
  console.log("");

  // Load plan
  const plan = loadLatestPlan();
  const planCount = Object.keys(plan).length;
  if (planCount === 0) {
    console.log("[apply] No verdicts found in plan file.");
    return;
  }
  console.log("[apply] Plan loaded: " + planCount + " unique records");

  // Load all memory records (kind=memory only, complete level)
  let records;
  try {
    const allFlags = ["--level", "complete"];
    if (filterProj) allFlags.push("--projects", filterProj);
    records = runMapJSON(allFlags) || [];
  } catch (e) {
    console.error("[apply] Failed to load records: " + e.message);
    process.exit(1);
  }
  records = records.filter(function(r) { return r.kind === "memory"; });

  // Load projects for path resolution
  let projects = [];
  try { projects = await fetchProjects(); } catch {}

  // Index records by recordId
  const recIndex = {};
  for (const r of records) recIndex[r.recordId] = r;

  // Counters
  let wouldChange = 0, noChange = 0, notOwned = 0, notFound = 0;
  let repoLinux117Files = []; // tracked for git commit

  // Filter plan entries
  let entries = Object.values(plan);
  if (filterRecord) entries = entries.filter(function(e) { return e.recordId === filterRecord; });
  if (filterProj)   entries = entries.filter(function(e) { return e._recordProject && e._recordProject.includes(filterProj); });
  if (limitN > 0)   entries = entries.slice(0, limitN);

  for (const verdict of entries) {
    const rid = verdict.recordId;
    const rec = recIndex[rid];

    if (!rec) {
      console.log("[apply] NOT FOUND: " + rid);
      notFound++;
      continue;
    }

    if (rec.kind !== "memory") continue; // belt-and-suspenders

    // Ownership scope check
    const sourceField = rec.source; // "live" or "repo:linux-117" or "repo:windows-desk" etc.
    let filePath = null;

    if (sourceField === "live") {
      filePath = path.join(liveDir(rec.project), rec.file);
    } else if (sourceField === "repo:linux-117") {
      const projPath = resolveProjectPath(rec.project, projects);
      if (!projPath) {
        console.log("[apply] SKIP (no project path): " + rid);
        notOwned++;
        continue;
      }
      filePath = path.join(projPath, "memory", "linux-117", rec.file);
    } else {
      // Not owned by this host
      console.log("[apply] SKIP (not owned -- source=" + sourceField + "): " + rid);
      notOwned++;
      continue;
    }

    if (!fs.existsSync(filePath)) {
      console.log("[apply] SKIP (file not found on disk): " + filePath);
      notFound++;
      continue;
    }

    // Parse frontmatter
    const fileContent = fs.readFileSync(filePath, "utf8");
    const { fm, body, hasFrontmatter } = parseFmRaw(fileContent);

    // Compute delta
    const delta = computeDelta(fm, verdict);
    if (!delta) {
      noChange++;
      continue;
    }

    wouldChange++;
    printDiff(rid, filePath, fm, delta);

    if (writeMode) {
      const backupFile = applyWrite(filePath, fm, delta, body);
      console.log("  [write] backup: " + backupFile);
      console.log("  [write] updated: " + filePath);
      if (sourceField === "repo:linux-117") {
        repoLinux117Files.push(filePath);
      }
    }
  }

  // Summary
  console.log("");
  console.log("[apply] Summary:");
  console.log("  would-change / wrote : " + wouldChange);
  console.log("  no-change (already up to date) : " + noChange);
  console.log("  skipped-not-owned : " + notOwned);
  console.log("  not-found : " + notFound);
  console.log("  total processed : " + entries.length);

  // Git commit for repo:linux-117 changes
  if (writeMode && repoLinux117Files.length > 0) {
    console.log("");
    console.log("[apply] Staging " + repoLinux117Files.length + " repo:linux-117 file(s) for git commit...");
    const repoRoot = path.dirname(path.dirname(path.dirname(repoLinux117Files[0].split("memory/linux-117")[0].trimEnd("/"))));
    // Find the git root: walk up from first file
    let gitRoot = repoLinux117Files[0];
    for (let i = 0; i < 10; i++) {
      gitRoot = path.dirname(gitRoot);
      if (fs.existsSync(path.join(gitRoot, ".git"))) break;
    }
    try {
      execFileSync("git", ["-C", gitRoot, "add", "--"].concat(repoLinux117Files), { encoding: "utf8" });
      const msg = "apply: write validated metadata to memory frontmatter" + String.fromCharCode(10) + String.fromCharCode(10) + "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>";
      execFileSync("git", ["-C", gitRoot, "commit", "-m", msg], { encoding: "utf8" });
      console.log("[apply] git commit done");
    } catch (e) {
      console.error("[apply] git commit failed: " + (e.message || e));
    }
  }

  if (!writeMode) {
    console.log("");
    console.log("[apply] PREVIEW only -- no files written.");
    console.log("[apply] To apply: set MEMORY_VALIDATE_APPLY=on and run with --write.");
  }
})();