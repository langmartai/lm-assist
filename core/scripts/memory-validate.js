#!/usr/bin/env node
/**
 * memory-validate.js -- Deep existing-memory validation tier (Opus).
 *
 * PLAN-DEFAULT: writes verdicts to ~/.lm-assist/memory-validate-plan.jsonl.
 * NEVER auto-edits, auto-deletes, or auto-merges memory files.
 * NEVER git-commits unless --apply AND MEMORY_VALIDATE_APPLY=on are BOTH set.
 *
 * For each selected record, spawns ONE Opus agent that:
 *   1. Reads the record title/brief/body.
 *   2. CODE-LEVEL verifies: reads the actual referenced files/code in the
 *      project path and checks if the fact still holds.
 *   3. SESSION-LEVEL verifies: if originSessionId is present, reads the
 *      session transcript (~/.claude/projects/<proj>/<sid>.jsonl) and checks
 *      that the work was developed+tested+validated.
 *   4. Re-categorizes based on real content+code (not just keyword matching).
 *   5. Consolidation/merge: given related neighbors, decides if this record
 *      should merge into / supersede / be superseded by another.
 *
 * Spec: docs/plans/2026-06-06-record-level-memory-map-and-sync.md sec 9, 12, 13.
 *
 *   node core/scripts/memory-validate.js
 *        [--project <slug>]   filter records by project slug substring
 *        [--record <id>]      validate a single record by full recordId
 *        [--stale]            select oldest lastValidatedMs with validity=current
 *        [--unvalidated]      select validationTier=unvalidated records only
 *        [--limit N]          max records to process (default 5)
 *        [--dry-run]          print selected records + assembled prompts; NO agent spawn
 *        [--apply]            gated: refuses unless MEMORY_VALIDATE_APPLY=on
 */
"use strict";
const fs             = require("fs");
const path           = require("path");
const os             = require("os");
const http           = require("http");
const { execFileSync } = require("child_process");

const PORT       = process.env.API_PORT || (__dirname.includes("node_modules") ? "3100" : "3200");
const MAP_SCRIPT = path.join(__dirname, "memory-map.js");
const PLAN_FILE  = path.join(os.homedir(), ".lm-assist", "memory-validate-plan.jsonl");

const wantRevalidate = process.argv.includes("--revalidate");
const wantCrossProject = process.argv.includes("--cross-project");
function planValidatedIds() {
  try {
    const lines = fs.readFileSync(PLAN_FILE, "utf8").trim().split(String.fromCharCode(10)).filter(Boolean);
    return new Set(lines.map(function(l){ try { return JSON.parse(l).recordId; } catch (e) { return null; } }).filter(Boolean));
  } catch (e) { return new Set(); }
}
const PROJECT_DIR = path.join(os.homedir(), ".claude", "projects");

const argv   = process.argv.slice(2);
const opt    = (k, d) => { const i = argv.indexOf("--" + k); return i >= 0 ? argv[i + 1] : d; };
const has    = (k) => argv.includes("--" + k);

const dryRun          = has("dry-run");
const applyMode       = has("apply");
const filterProject   = opt("project");
const filterRecord    = opt("record");
const wantStale       = has("stale");
const wantUnvalidated = has("unvalidated");
const limitN          = parseInt(opt("limit", "5"), 10);

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------
if (applyMode && process.env.MEMORY_VALIDATE_APPLY !== "on") {
  console.error("[validate] REFUSED: --apply requires env MEMORY_VALIDATE_APPLY=on.");
  console.error("[validate] Apply mode is an explicit gate -- set the env to confirm intent.");
  console.error("[validate] Default mode (no --apply) writes the plan only. Review it first.");
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

function spawnOpusAgent(prompt) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      prompt,
      cwd: "/home/ubuntu/lm-assist",
      model: "opus",
      background: false,
      permissionMode: "bypassPermissions",
      settingSources: ["project", "user"],
      outputConfig: { effort: "high" },
    });
    const req = http.request(
      {
        host: "localhost",
        port: PORT,
        path: "/agent/execute",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => {
          try { resolve(JSON.parse(d)); }
          catch { resolve({ raw: d }); }
        });
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

/**
 * parseVerdict -- extract the JSON verdict object from the Opus agent result.
 * Mirrors memory-harvest.js parseProposals: reads data.result first, then
 * uses balanced-bracket scanning so it never relies on fenced blocks alone.
 */
function parseVerdict(agentResult) {
  let text = "";
  if (typeof agentResult === "string") {
    text = agentResult;
  } else if (agentResult && typeof agentResult === "object") {
    // CRITICAL: the agent stores its text reply at data.result (debugged in harvester)
    if (agentResult.data && typeof agentResult.data === "object" && typeof agentResult.data.result === "string") {
      text = agentResult.data.result;
    } else if (agentResult.data && typeof agentResult.data === "string") {
      text = agentResult.data;
    } else if (agentResult.result && typeof agentResult.result === "string") {
      text = agentResult.result;
    } else {
      text = JSON.stringify(agentResult);
    }
  }

  // Try fenced JSON block first
  const fence = text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
  if (fence) {
    try { const v = JSON.parse(fence[1]); if (v && typeof v === "object") return v; } catch {}
  }

  // Balanced-bracket scan for the FIRST top-level { ... } object that has recordId
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "{") continue;
    let depth = 0;
    for (let j = i; j < text.length; j++) {
      if (text[j] === "{") depth++;
      else if (text[j] === "}") {
        if (--depth === 0) {
          const candidate = text.slice(i, j + 1);
          try {
            const v = JSON.parse(candidate);
            if (v && typeof v === "object" && v.recordId) return v;
          } catch {}
          break;
        }
      }
    }
  }

  console.error("[validate] Could not parse a JSON verdict object from agent response.");
  console.error("[validate] raw text (600 chars): " + text.slice(0, 600));
  return null;
}

function writePlan(item) {
  fs.mkdirSync(path.dirname(PLAN_FILE), { recursive: true });
  const ts = Date.now();
  const line = JSON.stringify(
    Object.assign(
      { _planWrittenAt: ts, _planWrittenAtIso: new Date(ts).toISOString(), _planStatus: "proposed" },
      item
    )
  );
  fs.appendFileSync(PLAN_FILE, line + "\n");
}

// ---------------------------------------------------------------------------
// Record selection
// ---------------------------------------------------------------------------
function selectRecords() {
  const allFlags = ["--level", "complete"];
  if (filterProject) allFlags.push("--projects", filterProject);

  let records;
  try {
    records = runMapJSON(allFlags) || [];
  } catch (e) {
    console.error("[validate] Failed to load records:", e.message);
    process.exit(1);
  }
  if (!Array.isArray(records)) records = [];

  // Only validate memory-kind records (index-entry and claude-section are structural, not facts)
  records = records.filter((r) => r.kind === "memory");

  if (wantCrossProject) {
    records = records.filter(function(r){
      const refs = r.referencedProjects || [];
      if (!refs.length) return false;
      const ss = (resolveProjectPath(r.project) || "").split("/").filter(Boolean).pop();
      return ss && refs.indexOf(ss) === -1;
    });
  }

  if (filterRecord) {
    records = records.filter((r) => r.recordId === filterRecord);
    if (records.length === 0) {
      console.error("[validate] No memory record found with recordId: " + filterRecord);
      process.exit(1);
    }
    return records.slice(0, 1);
  }

  if (wantUnvalidated) {
    records = records.filter((r) => r.validationTier === "unvalidated");
  }

  if (wantStale) {
    // Sort by lastValidatedMs ascending (oldest first), restrict to validity=current
    records = records.filter((r) => r.validity === "current");
    records.sort((a, b) => (a.lastValidatedMs || 0) - (b.lastValidatedMs || 0));
  } else if (!wantUnvalidated && !filterRecord) {
    // Default: mix of unvalidated + oldest validated
    const unval = records.filter((r) => r.validationTier === "unvalidated");
    const rest  = records.filter((r) => r.validationTier !== "unvalidated")
                         .sort((a, b) => (a.lastValidatedMs || 0) - (b.lastValidatedMs || 0));
    records = [...unval, ...rest];
  }

  if (!wantRevalidate) {
    const done = planValidatedIds();
    const before = records.length;
    records = records.filter(function(r){ return !done.has(r.recordId); });
    const skipped = before - records.length;
    if (skipped > 0) console.error('[validate] Resume: skipping ' + skipped + ' already-validated record(s) (use --revalidate to redo).');
  }
  return records.slice(0, limitN);
}

// ---------------------------------------------------------------------------
// Find related neighbor records for merge/supersede context
// ---------------------------------------------------------------------------
function findNeighbors(target, allRecords) {
  if (!allRecords || !Array.isArray(allRecords)) return [];
  const t = (target.title + " " + target.brief).toLowerCase();
  const targetWords = new Set(t.split(/\s+/).filter((w) => w.length > 4));
  const scored = allRecords
    .filter((r) => r.recordId !== target.recordId && r.kind === "memory" && r.project === target.project)
    .map((r) => {
      const rt = (r.title + " " + r.brief).toLowerCase();
      const words = rt.split(/\s+/).filter((w) => w.length > 4);
      const overlap = words.filter((w) => targetWords.has(w)).length;
      return { r, score: overlap };
    })
    .filter((x) => x.score >= 2)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map((x) => x.r);
  return scored;
}

// ---------------------------------------------------------------------------
// Resolve project path from project slug
// ---------------------------------------------------------------------------
function resolveProjectPath(projectSlug) {
  if (!projectSlug) return null;
  // projectSlug is the projectId, e.g. "-home-ubuntu-lm-unified-trade"
  // It is the absolute path with / replaced by - (with leading -)
  // Strategy: try converting - back to / with leading slash
  const attempt1 = "/" + projectSlug.replace(/^-/, "").split("-").join("/");
  if (attempt1 && fs.existsSync(attempt1)) return attempt1;

  // Try a smarter approach: split on - and find a valid prefix
  // "-home-ubuntu-lm-unified-trade" -> try /home/ubuntu/lm-unified-trade, /home/ubuntu/lm/unified/trade, etc.
  const parts = projectSlug.replace(/^-/, "").split("-");
  // Try progressively joined paths: join first N parts with / rest with -
  for (let split = parts.length - 1; split >= 1; split--) {
    const dirParts = parts.slice(0, split);
    const nameParts = parts.slice(split);
    // Try joining dirParts as dir + nameParts as hyphenated name
    const candidate = "/" + dirParts.join("/") + "/" + nameParts.join("-");
    if (fs.existsSync(candidate)) return candidate;
    // Also try all as dirs
    const candidate2 = "/" + parts.slice(0, split + 1).join("/");
    if (fs.existsSync(candidate2)) return candidate2;
  }

  // Known fallbacks
  const known = [
    "/home/ubuntu/lm-unified-trade",
    "/home/ubuntu/lm-assist",
    "/home/ubuntu",
  ];
  for (const k of known) {
    if (projectSlug.includes("lm-unified-trade") && k.includes("lm-unified-trade")) return k;
    if (projectSlug.includes("lm-assist") && k.includes("lm-assist")) return k;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Build the deep-verify Opus prompt
// ---------------------------------------------------------------------------
function buildPrompt(record, neighbors) {
  const neighborJson = neighbors.length > 0
    ? JSON.stringify(neighbors.map((r) => ({
        recordId: r.recordId,
        title: r.title,
        brief: r.brief,
        validationTier: r.validationTier,
        validity: r.validity,
        category: r.category,
      })), null, 2)
    : "[]";

  // Verify against the project(s) this record is ABOUT (referencedProjects),
  // not just where it is stored — a cross-project record gets checked against the right codebase.
  const refShorts = (record.referencedProjects && record.referencedProjects.length) ? record.referencedProjects : [];
  const verifyPaths = [];
  for (const s of refShorts) { if (s === "(home)" || s === "(user-global)") continue; const pp = "/home/ubuntu/" + s; try { if (fs.existsSync(pp)) verifyPaths.push(pp); } catch (e) {} }
  if (verifyPaths.length === 0) { const sp = resolveProjectPath(record.project); if (sp) verifyPaths.push(sp); }
  if (verifyPaths.length === 0) verifyPaths.push("/home/ubuntu/lm-unified-trade");
  const projectPath = verifyPaths.join(", ");

  const sessionPath = record.originSessionId
    ? path.join(PROJECT_DIR, record.project, record.originSessionId + ".jsonl")
    : null;

  return [
    "=== DEEP MEMORY VALIDATOR -- READ CAREFULLY BEFORE DOING ANYTHING ===",
    "",
    "You are a DEEP MEMORY VALIDATOR. Your role is to verify an EXISTING memory record",
    "against the actual codebase and its origin session. You are an ANALYST only.",
    "You MUST NOT write, edit, or delete any memory files.",
    "You MUST NOT run git add, git commit, git push, or any mutation.",
    "Your ONLY output is a single JSON verdict object (format specified below).",
    "",
    "=== THE RECORD TO VALIDATE ===",
    "",
    "recordId        : " + record.recordId,
    "title           : " + record.title,
    "brief           : " + record.brief,
    "file            : " + record.file,
    "project         : " + record.project,
    "currentTier     : " + (record.validationTier || "unvalidated"),
    "currentValidity : " + (record.validity || "current"),
    "currentCategory : " + (record.category || "knowledge"),
    "originSessionId : " + (record.originSessionId || "(none)"),
    "recordedAtMs    : " + (record.recordedAtMs || "unknown"),
    "",
    "--- RECORD BODY ---",
    record.complete || "(empty body)",
    "--- END BODY ---",
    "",
    "=== STEP 1 -- IDENTIFY REFERENCED FILES / FUNCTIONS / ENDPOINTS / FLAGS ===",
    "",
    "Read the record body above carefully. Extract a list of:",
    "  - File paths (e.g. scripts/broker/, core/src/api/memory-api.ts)",
    "  - Function/method names (e.g. createBroker, formatPrice)",
    "  - Endpoint paths (e.g. /agent/execute, /memory/map)",
    "  - Feature flags or env vars (e.g. MEMORY_VALIDATE_APPLY)",
    "  - Version numbers or timestamps (e.g. 2026-04-28)",
    "",
    "These are the CLAIMS you must verify.",
    "",
    "=== STEP 2 -- CODE-LEVEL VERIFICATION (REQUIRED) ===",
    "",
    "Project path(s) to verify against -- the project(s) this record is ABOUT (may differ from where it is stored): " + projectPath,
    "(This record is stored under: " + record.project + ". Verify claims against the path(s) above, reading each referenced project's actual code.)",
    "",
    "For EACH claim identified in Step 1, verify it against the actual code:",
    "",
    "  a) If the claim references a FILE: check that file exists with:",
    "       ls -la <file-path>",
    "     Then read the relevant section to verify the claim is still true:",
    "       cat <file-path>",
    "     (or head/grep for large files)",
    "",
    "  b) If the claim references a FUNCTION/METHOD: read the source file and",
    "     confirm the function exists and behaves as described.",
    "",
    "  c) If the claim references an ENDPOINT: grep the routes for it in:",
    "       /home/ubuntu/lm-assist/core/src/routes/",
    "",
    "  d) If the claim references a CONFIG/FLAG: check the relevant config file.",
    "",
    "For each claim, state: EXISTS + MATCHES / EXISTS + CONTRADICTS / DOES NOT EXIST.",
    "",
    "Based on code evidence, determine one of:",
    "  code-confirmed  : All key claims verified against current code -> fact still holds.",
    "  outdated        : The referenced thing exists but behavior/location has changed.",
    "  invalid         : The referenced thing does not exist OR code directly contradicts the claim.",
    "",
    "Record your evidence as \"file:line\" or \"file: <summary of what you found>\".",
    "",
    "=== STEP 3 -- SESSION-LEVEL VERIFICATION (if originSessionId present) ===",
    "",
    sessionPath
      ? [
          "originSessionId: " + record.originSessionId,
          "Session file   : " + sessionPath,
          "",
          "Read the session file (it is JSONL; each line is a JSON event):",
          "  cat \"" + sessionPath + "\"",
          "",
          "IMPORTANT: If the session file is very large (> 500 KB), use grep/head to sample:",
          "  wc -c \"" + sessionPath + "\"",
          "  grep -c . \"" + sessionPath + "\"",
          "  head -n 50 \"" + sessionPath + "\"",
          "  grep -n 'tool_result' \"" + sessionPath + "\" | tail -30",
          "",
          "Look for evidence that the work was:",
          "  1. DEVELOPED  : the code/feature was written or modified",
          "  2. TESTED     : tests were run (tool results showing test output)",
          "  3. VALIDATED  : a round-trip succeeded, user confirmed, or tests passed",
          "",
          "If the session shows all three -> supports session-confirmed.",
          "If the session only shows intent or partial work -> supports asserted at best.",
          "If the session file does not exist or is unreadable -> note this.",
        ].join("\n")
      : "No originSessionId -- session verification not applicable. Skip Step 3.",
    "",
    "=== STEP 4 -- RE-CATEGORIZE (from code+content evidence) ===",
    "",
    "Based on what you actually found in the code and body (not just keyword matching),",
    "assign the most accurate category:",
    "",
    "  architecture   : System design, data model, protocol, boundary, pipeline",
    "  deployment     : Install, build, restart, port, systemd, docker, cron",
    "  component      : A specific module, library, script, daemon, engine",
    "  endpoint       : HTTP route, REST API, curl example",
    "  feature        : A command, skill, workflow, or dashboard feature",
    "  config         : Credential, token, key, account, env var, settings file",
    "  lesson         : Gotcha, incident, bug, pitfall, do-not, never, always",
    "  knowledge      : General factual knowledge not fitting other categories",
    "",
    "Current category: " + (record.category || "knowledge"),
    "Is it correct? If not, what should it be and why?",
    "",
    "=== STEP 5 -- CONSOLIDATION / MERGE ANALYSIS ===",
    "",
    "Related neighbor records (same project, title-overlap):",
    neighborJson,
    "",
    "For each neighbor, decide based on CONTENT + CODE evidence (not just title overlap):",
    "  - Should this record MERGE INTO the neighbor (this is a subset / duplicate)?",
    "     -> mergeWith = neighbor.recordId",
    "  - Should this record SUPERSEDE the neighbor (neighbor is outdated/replaced)?",
    "     -> mergeWith = null (this record is canonical)",
    "  - Should this record be SUPERSEDED BY the neighbor?",
    "     -> supersededBy = neighbor.recordId",
    "  - Are they genuinely independent? -> mergeWith = null, supersededBy = null",
    "",
    "Only propose a merge/supersede if you have REAL evidence (code or session).",
    "When in doubt, leave both independent.",
    "",
    "=== STEP 6 -- OUTPUT ===",
    "",
    "Return ONLY a single JSON object. No prose before or after it.",
    "CRITICAL: your FINAL message must BE the JSON object itself, emitted VERBATIM as",
    "text -- running the tool is NOT enough; if your final reply is empty or a summary",
    "the verdict is lost.",
    "",
    "{",
    "  \"recordId\": \"" + record.recordId + "\",",
    "  \"validationTier\": \"code-confirmed | session-confirmed | asserted | unvalidated\",",
    "  \"validity\": \"current | outdated | superseded | invalid\",",
    "  \"suggestedCategory\": \"architecture | deployment | component | endpoint | feature | config | lesson | knowledge\",",
    "  \"lastValidatedMs\": <current epoch ms as integer>,",
    "  \"mergeWith\": \"<neighbor recordId> | null\",",
    "  \"supersededBy\": \"<neighbor recordId> | null\",",
    "  \"reason\": \"1-3 sentence summary of the verdict\",",
    "  \"evidence\": \"file:line_or_range or session:<ref> -- concrete code/session evidence\"",
    "}",
    "",
    "=== CRITICAL SAFETY CONSTRAINT -- ABSOLUTE, NO EXCEPTIONS ===",
    "",
    "You MUST NOT:",
    "  - Write or modify any file under ~/.claude/ or any memory/ directory",
    "  - Run git add, git commit, git push, or any git mutation",
    "  - Call any /memory/* write API endpoints",
    "  - Edit or delete the record being validated",
    "",
    "You are a READ-ONLY VALIDATOR. The CLI writes the plan to",
    "~/.lm-assist/memory-validate-plan.jsonl. A human reviews before anything changes.",
    "This constraint is absolute and non-negotiable.",
    "",
    "=== BEGIN ===",
    "",
    "Validate the record now. Return only the JSON verdict object.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
(async () => {
  console.log("[validate] Selecting records to validate...");

  const records = selectRecords();
  if (records.length === 0) {
    console.log("[validate] No records match the selection criteria.");
    console.log("[validate]   --project     : " + (filterProject || "(all)"));
    console.log("[validate]   --record      : " + (filterRecord || "(none)"));
    console.log("[validate]   --stale       : " + wantStale);
    console.log("[validate]   --unvalidated : " + wantUnvalidated);
    console.log("[validate]   --limit       : " + limitN);
    return;
  }

  console.log("[validate] Records selected : " + records.length);
  console.log("[validate] Plan file        : " + PLAN_FILE);
  console.log("[validate] Agent endpoint   : http://localhost:" + PORT + "/agent/execute");
  console.log("[validate] Model            : opus (deep code+session verifier -- spec sec 13)");
  if (dryRun) {
    console.log("[validate] DRY-RUN mode     : prompts printed, NO agents spawned, NO plan written.");
    console.log("");
  }

  // Load all records for neighbor analysis (only once, brief level)
  let allRecords = [];
  try {
    allRecords = runMapJSON(["--level", "brief"]) || [];
    if (!Array.isArray(allRecords)) allRecords = [];
  } catch { /* neighbors are a nice-to-have; don't fail if this errors */ }

  let totalWritten = 0;
  for (const record of records) {
    const neighbors = findNeighbors(record, allRecords);
    const prompt = buildPrompt(record, neighbors);

    if (dryRun) {
      console.log("=".repeat(72));
      console.log("RECORD TO VALIDATE");
      console.log("  recordId  : " + record.recordId);
      console.log("  title     : " + record.title);
      console.log("  tier      : " + record.validationTier);
      console.log("  validity  : " + record.validity);
      console.log("  neighbors : " + neighbors.length);
      console.log("  sessionId : " + (record.originSessionId || "(none)"));
      console.log("");
      console.log("ASSEMBLED OPUS DEEP-VERIFY PROMPT (" + prompt.length + " chars):");
      console.log("-".repeat(72));
      console.log(prompt);
      console.log("=".repeat(72));
      console.log("");
      continue;
    }

    console.log("[validate] Validating: " + record.title);
    console.log("[validate]   recordId : " + record.recordId);

    let agentResponse;
    try {
      agentResponse = await spawnOpusAgent(prompt);
    } catch (e) {
      console.error("[validate] Agent endpoint error for record " + record.recordId + ":", e.message);
      console.error("[validate] NOTE: live Opus validation requires the full prod agent stack.");
      continue;
    }

    const verdict = parseVerdict(agentResponse);
    if (!verdict) {
      console.error("[validate]   -> Could not extract verdict. Skipping plan write.");
      continue;
    }

    console.log("[validate]   -> tier=" + verdict.validationTier + " validity=" + verdict.validity);
    if (verdict.evidence) console.log("[validate]   -> evidence: " + verdict.evidence.slice(0, 100));

    const planItem = {
      planType: "deep-validate",
      recordId: verdict.recordId || record.recordId,
      validationTier: verdict.validationTier,
      validity: verdict.validity,
      suggestedCategory: verdict.suggestedCategory,
      lastValidatedMs: verdict.lastValidatedMs || Date.now(),
      mergeWith: verdict.mergeWith || null,
      supersededBy: verdict.supersededBy || null,
      reason: verdict.reason || "",
      evidence: verdict.evidence || "",
      _recordTitle: record.title,
      _recordFile: record.file,
      _recordProject: record.project,
    };

    writePlan(planItem);
    totalWritten++;
  }

  if (!dryRun) {
    console.log("");
    console.log("[validate] Done. " + totalWritten + " plan item(s) written to " + PLAN_FILE);
    console.log("[validate] IMPORTANT: No memory files were modified. Review the plan first.");
    if (applyMode) {
      console.log("[validate] NOTE: --apply automation is a future phase. Plan written; apply manually.");
    }
  }
})();
