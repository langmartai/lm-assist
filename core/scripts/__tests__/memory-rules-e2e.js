#!/usr/bin/env node
/**
 * memory-rules-e2e.js -- End-to-end assertion suite for the memory + rules map system.
 *
 * Tests real use cases with real content assertions (not exit-code checks).
 * Each test prints PASS/FAIL: <name>. Exits non-zero if any fail.
 * All file mutations are reverted in finally blocks -- repeatable, self-cleaning.
 *
 * Spec: docs/plans/2026-06-06-record-level-memory-map-and-sync.md
 *
 * Usage: node core/scripts/__tests__/memory-rules-e2e.js [--port 3200]
 */
"use strict";

const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const http = require("http");

// ── Config ───────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const PORT = argv.indexOf("--port") >= 0 ? argv[argv.indexOf("--port") + 1] : "3200";
const REPO = path.join(__dirname, "..", "..", "..");                        // /home/ubuntu/lm-assist
const MAP_SCRIPT = path.join(REPO, "core", "scripts", "memory-map.js");
const RULE_SCRIPT = path.join(REPO, "core", "scripts", "rule-map.js");
const RECONCILE_SCRIPT = path.join(REPO, "core", "scripts", "memory-reconcile.js");

// ── Helpers ───────────────────────────────────────────────────────────────────
function runScript(script, flags, timeoutMs) {
  flags = flags || [];
  timeoutMs = timeoutMs || 90000;
  return execFileSync(
    "node",
    [script].concat(flags).concat(["--port", PORT, "--format", "json"]),
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs }
  );
}

function runScriptRaw(script, flags, timeoutMs) {
  flags = flags || [];
  timeoutMs = timeoutMs || 90000;
  return execFileSync(
    "node",
    [script].concat(flags).concat(["--port", PORT]),
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs }
  );
}

function httpGet(urlPath) {
  return new Promise(function (resolve, reject) {
    http
      .get("http://localhost:" + PORT + urlPath, function (res) {
        var d = "";
        res.on("data", function (c) { d += c; });
        res.on("end", function () {
          try { resolve(JSON.parse(d)); }
          catch (e) { reject(new Error("non-JSON from " + urlPath + ": " + d.slice(0, 200))); }
        });
      })
      .on("error", reject);
  });
}

function httpMcp(method, params) {
  params = params || {};
  return new Promise(function (resolve, reject) {
    var body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: method, params: params });
    var req = http.request(
      {
        host: "localhost",
        port: parseInt(PORT, 10),
        path: "/mcp",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json, text/event-stream",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      function (res) {
        var d = "";
        res.on("data", function (c) { d += c; });
        res.on("end", function () {
          // SSE format: "event: message\ndata: {...}\n\n"
          var m = d.match(/^event: message\ndata: (.+)$/m);
          if (m) {
            try { resolve(JSON.parse(m[1])); return; } catch (e) {}
          }
          try { resolve(JSON.parse(d)); }
          catch (e) { reject(new Error("non-JSON MCP: " + d.slice(0, 200))); }
        });
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ── Test runner ───────────────────────────────────────────────────────────────
var passed = 0, failed = 0;
var failures = [];

async function test(name, fn) {
  try {
    await fn();
    console.log("PASS: " + name);
    passed++;
  } catch (e) {
    console.log("FAIL: " + name);
    console.log("      " + (e.message || String(e)).split("\n")[0]);
    failed++;
    failures.push({ name: name, error: e.message || String(e) });
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error("Assertion failed: " + msg);
}

function assertEq(a, b, msg) {
  if (a !== b)
    throw new Error(
      (msg || "equals") + ": expected " + JSON.stringify(b) + " got " + JSON.stringify(a)
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST CASES
// ─────────────────────────────────────────────────────────────────────────────

(async function main() {

// TC-1: Topic search — real records for "broker"
await test("TC-1: Topic search returns broker memory and claude-section", async function () {
  var out = JSON.parse(runScript(MAP_SCRIPT, ["--q", "broker", "--level", "brief"]));
  assert(
    Array.isArray(out) && out.length >= 2,
    "should return >=2 records for broker query, got " + out.length
  );

  // One must be the broker memory file (type != index, type != claude)
  var brokerMem = out.find(function (r) {
    return r.file && r.file.includes("broker") && r.type !== "index" && r.type !== "claude";
  });
  assert(brokerMem, "should include a memory-type record for broker (e.g. project_broker_boundary.md)");
  assert(
    brokerMem.title && brokerMem.title.toLowerCase().includes("broker"),
    "broker memory title should mention broker, got: " + brokerMem.title
  );

  // One must be a CLAUDE.md section about broker boundary
  var claudeSection = out.find(function (r) {
    return r.type === "claude" && r.title && r.title.toLowerCase().includes("broker");
  });
  assert(claudeSection, "should include a claude-section with broker in title (from CLAUDE.md)");

  // Brief level must NOT include 'complete' body field
  var sample10 = out.slice(0, 10);
  for (var i = 0; i < sample10.length; i++) {
    var r = sample10[i];
    assert(
      !Object.prototype.hasOwnProperty.call(r, "complete"),
      "brief level must not include 'complete' field, id=" + r.recordId
    );
  }
});

// TC-2: Two-level depth — brief vs complete shapes differ
await test("TC-2: Brief has no 'complete'; complete has non-empty 'complete'", async function () {
  var briefOut = JSON.parse(runScript(MAP_SCRIPT, ["--level", "brief", "--limit", "5"]));
  var completeOut = JSON.parse(runScript(MAP_SCRIPT, ["--level", "complete", "--limit", "5"]));

  assert(briefOut.length > 0, "brief: should return records");
  assert(completeOut.length > 0, "complete: should return records");

  for (var i = 0; i < briefOut.length; i++) {
    var r = briefOut[i];
    assert(
      !Object.prototype.hasOwnProperty.call(r, "complete"),
      "brief record must not have 'complete' key, id=" + r.recordId
    );
    assert(r.title, "brief record must have title");
    assert(r.brief !== undefined, "brief record must have brief field");
  }

  for (var j = 0; j < completeOut.length; j++) {
    var rc = completeOut[j];
    assert(
      Object.prototype.hasOwnProperty.call(rc, "complete"),
      "complete record must have 'complete' key, id=" + rc.recordId
    );
    assert(
      typeof rc.complete === "string" && rc.complete.length > 0,
      "complete field must be non-empty string, id=" + rc.recordId
    );
    assert(
      Object.prototype.hasOwnProperty.call(rc, "contentHash"),
      "complete record must have contentHash, id=" + rc.recordId
    );
    assert(
      Object.prototype.hasOwnProperty.call(rc, "kind"),
      "complete record must have kind, id=" + rc.recordId
    );
  }
});

// TC-3: Record fetch by ID
await test("TC-3: --record <id> returns complete body for a specific record", async function () {
  var searchOut = JSON.parse(runScript(MAP_SCRIPT, ["--q", "broker", "--level", "brief"]));
  var brokerRec = searchOut.find(function (r) {
    return r.type !== "index" && r.type !== "claude" && r.file && r.file.includes("broker");
  });
  assert(brokerRec, "need a broker record to fetch");

  var fetchOut = JSON.parse(runScript(MAP_SCRIPT, ["--record", brokerRec.recordId]));

  assert(
    fetchOut && typeof fetchOut === "object" && !Array.isArray(fetchOut),
    "--record should return a single object, got: " + typeof fetchOut
  );
  assertEq(fetchOut.recordId, brokerRec.recordId, "returned recordId should match");
  assert(
    typeof fetchOut.complete === "string" && fetchOut.complete.length > 100,
    "complete body must be non-empty (>100 chars), got length: " + (fetchOut.complete || "").length
  );
  assert(fetchOut.title, "returned record must have title");
});

// TC-4: Category filter — only deployment records
await test("TC-4: --category deployment returns only deployment records (>0)", async function () {
  var out = JSON.parse(runScript(MAP_SCRIPT, ["--category", "deployment"]));
  assert(
    Array.isArray(out) && out.length > 0,
    "should return >0 deployment records, got " + out.length
  );
  for (var i = 0; i < out.length; i++) {
    assertEq(
      out[i].category,
      "deployment",
      "all records should have category=deployment, id=" + out[i].recordId
    );
  }
});

// TC-5: Node filter — windows-desk vs linux-117 both non-empty and exclusive
await test("TC-5: Node filter returns only records from requested node", async function () {
  var wdOut = JSON.parse(runScript(MAP_SCRIPT, ["--nodes", "windows-desk"]));
  var linuxOut = JSON.parse(runScript(MAP_SCRIPT, ["--nodes", "linux-117"]));

  assert(wdOut.length > 0, "windows-desk node should have records, got 0");
  assert(linuxOut.length > 0, "linux-117 node should have records, got 0");

  for (var i = 0; i < wdOut.length; i++) {
    assertEq(
      wdOut[i].node,
      "windows-desk",
      "windows-desk filter: found unexpected node " + wdOut[i].node + " in " + wdOut[i].recordId
    );
  }
  for (var j = 0; j < linuxOut.length; j++) {
    assertEq(
      linuxOut[j].node,
      "linux-117",
      "linux-117 filter: found unexpected node " + linuxOut[j].node + " in " + linuxOut[j].recordId
    );
  }
});

// TC-6: Type filter — reference vs claude
await test("TC-6: --types reference returns only reference; --types claude returns only claude", async function () {
  var refOut = JSON.parse(runScript(MAP_SCRIPT, ["--types", "reference"]));
  var claudeOut = JSON.parse(runScript(MAP_SCRIPT, ["--types", "claude"]));

  assert(refOut.length > 0, "should have reference records, got 0");
  assert(claudeOut.length > 0, "should have claude records, got 0");

  for (var i = 0; i < refOut.length; i++) {
    assertEq(
      refOut[i].type,
      "reference",
      "types=reference: all records should be reference type, got " + refOut[i].type
    );
  }
  for (var j = 0; j < claudeOut.length; j++) {
    assertEq(
      claudeOut[j].type,
      "claude",
      "types=claude: all records should be claude type, got " + claudeOut[j].type
    );
  }
});

// TC-7: recordId uniqueness — zero collisions
await test("TC-7: All recordIds are globally unique (0 collisions)", async function () {
  var out = JSON.parse(runScript(MAP_SCRIPT, ["--level", "complete"], 120000));
  var ids = out.map(function (r) { return r.recordId; });
  var uniqueSet = {};
  for (var i = 0; i < ids.length; i++) { uniqueSet[ids[i]] = true; }
  var uniqueCount = Object.keys(uniqueSet).length;
  var collisions = ids.length - uniqueCount;
  assertEq(
    collisions,
    0,
    "recordId collision count should be 0, got " + collisions + " (total=" + ids.length + ")"
  );
  assert(ids.length >= 700, "should have >=700 total records, got " + ids.length);
});

// TC-8: CLAUDE.md coverage — user-global, project-root, no cross-project leak
await test(
  "TC-8: CLAUDE.md coverage: user-global present, project sections present, no cross-project leak",
  async function () {
    var allClaude = JSON.parse(runScript(MAP_SCRIPT, ["--types", "claude"]));

    // user-global CLAUDE.md must be indexed
    var userGlobal = allClaude.find(function (r) { return r.project === "(user-global)"; });
    assert(userGlobal, "should have at least one record from (user-global) project (~/.claude/CLAUDE.md)");

    // lm-unified-trade must have claude-sections
    var unifiedClaude = allClaude.filter(function (r) {
      return r.project === "-home-ubuntu-lm-unified-trade" && r.type === "claude";
    });
    assert(unifiedClaude.length > 0, "lm-unified-trade should have claude-sections indexed");

    // No lm-assist path should appear under lm-unified-trade
    var crossLeak = allClaude.filter(function (r) {
      return r.project === "-home-ubuntu-lm-unified-trade" &&
        r.file && r.file.includes("lm-assist");
    });
    assertEq(
      crossLeak.length,
      0,
      "lm-assist CLAUDE.md path must not appear under lm-unified-trade project"
    );

    // user-global records must not include project-specific paths
    var userGlobalRecs = allClaude.filter(function (r) { return r.project === "(user-global)"; });
    for (var i = 0; i < userGlobalRecs.length; i++) {
      var r = userGlobalRecs[i];
      assert(
        !r.file.includes("lm-unified-trade") && !r.file.includes("lm-assist"),
        "user-global should not include project-specific CLAUDE.md paths, found: " + r.file
      );
    }
  }
);

// TC-9: Change detection — snapshot, modify, assert changes, revert, assert 0
await test(
  "TC-9: Change detection detects modification and 0 after revert",
  async function () {
    var projectId = "-home-ubuntu-lm-unified-trade";
    var liveDir = path.join(os.homedir(), ".claude", "projects", projectId, "memory");
    var testFile = path.join(liveDir, "project_broker_boundary.md");

    assert(fs.existsSync(testFile), "test file must exist: " + testFile);

    var originalContent = fs.readFileSync(testFile, "utf8");
    var marker = "\n<!-- e2e-test-marker-" + Date.now() + " -->";
    var snapJson = path.join(os.homedir(), ".lm-assist", "memory-map-e2e-snap1.json");

    // Take a fresh snapshot
    runScript(MAP_SCRIPT, ["--snapshot", "--snapshot-file", snapJson]);

    var testPassed = true;
    var testError = null;
    try {
      fs.appendFileSync(testFile, marker);

      var changesJson = runScript(MAP_SCRIPT, ["--changes", "--snapshot-file", snapJson]);
      var changes = JSON.parse(changesJson);

      if (changes.modified < 1) {
        testPassed = false;
        testError =
          "should report >=1 modified records after appending marker, got " + changes.modified;
      } else {
        var expectedId =
          "live:linux-117:" + projectId + ":project_broker_boundary.md#";
        var modifiedIds = changes.modifiedRecords.map(function (r) {
          return r.id || r.recordId;
        });
        var found =
          modifiedIds.indexOf(expectedId) >= 0 ||
          modifiedIds.some(function (id) {
            return id.indexOf("project_broker_boundary") >= 0;
          });
        if (!found) {
          testPassed = false;
          testError =
            "modifiedRecords should include broker_boundary record, got: " +
            JSON.stringify(modifiedIds.slice(0, 5));
        }
      }
    } finally {
      // ALWAYS revert the file even on assertion failure
      fs.writeFileSync(testFile, originalContent);
      try { fs.unlinkSync(snapJson); } catch (e) {}
    }

    if (!testPassed) throw new Error(testError);

    // Verify 0 changes after revert
    var snapJson2 = path.join(os.homedir(), ".lm-assist", "memory-map-e2e-snap2.json");
    runScript(MAP_SCRIPT, ["--snapshot", "--snapshot-file", snapJson2]);
    try {
      var afterJson = runScript(MAP_SCRIPT, ["--changes", "--snapshot-file", snapJson2]);
      var after = JSON.parse(afterJson);
      assertEq(after.modified, 0, "should report 0 modified after revert");
      assertEq(after.added, 0, "should report 0 added after revert");
    } finally {
      try { fs.unlinkSync(snapJson2); } catch (e) {}
    }
  }
);

// TC-10: Reconcile candidates
await test(
  "TC-10: Reconcile --dry-run reports divergent mirrors, dep edges, and outdated candidates",
  async function () {
    var raw = runScriptRaw(RECONCILE_SCRIPT, ["--dry-run"], 120000);

    var divergentMatch = raw.match(/Divergent mirrors\s*:\s*(\d+)/);
    var edgesMatch = raw.match(/Dependency edges found\s*:\s*(\d+)/);
    var outdatedMatch = raw.match(/Outdated candidates\s*:\s*(\d+)/);

    assert(divergentMatch, "dry-run output should report 'Divergent mirrors' count");
    assert(edgesMatch, "dry-run output should report 'Dependency edges found' count");
    assert(outdatedMatch, "dry-run output should report 'Outdated candidates' count");

    var divergentCount = parseInt(divergentMatch[1], 10);
    var edgesCount = parseInt(edgesMatch[1], 10);
    var outdatedCount = parseInt(outdatedMatch[1], 10);

    assert(divergentCount >= 1, "should have >=1 divergent mirrors, got " + divergentCount);
    assert(edgesCount > 0, "should have >0 dependency edges, got " + edgesCount);
    assert(outdatedCount > 0, "should have >0 outdated candidates, got " + outdatedCount);

    // dead-path outdated must be a subset of total outdated
    var deadPathMatch = raw.match(/dead-path[^:]*:\s*(\d+)/);
    if (deadPathMatch) {
      var deadCount = parseInt(deadPathMatch[1], 10);
      assert(
        deadCount <= outdatedCount,
        "dead-path outdated must be subset of total: " + deadCount + " <= " + outdatedCount
      );
    }
  }
);

// TC-11: HTTP parity — /memory/map/stats total matches CLI --stats total
await test("TC-11: HTTP /memory/map/stats total matches CLI --stats total", async function () {
  var cliStats = JSON.parse(runScript(MAP_SCRIPT, ["--stats"]));
  var httpResp = await httpGet("/memory/map/stats");

  assert(httpResp.success, "HTTP response should have success=true");
  assert(httpResp.data, "HTTP response should have data");
  assertEq(httpResp.data.total, cliStats.total, "HTTP total should equal CLI total");
  assert(typeof httpResp.data.byProject === "object", "should have byProject");
  assert(typeof httpResp.data.byNode === "object", "should have byNode");
  assert(typeof httpResp.data.byType === "object", "should have byType");
});

// TC-12: HTTP record fetch — /memory/record/:id matches CLI --record <id>
await test("TC-12: GET /memory/record/:id matches CLI --record <id>", async function () {
  var searchOut = JSON.parse(
    runScript(MAP_SCRIPT, ["--q", "broker", "--level", "brief", "--limit", "5"])
  );
  var brokerRec = searchOut.find(function (r) {
    return r.type !== "index" && r.type !== "claude" && r.file && r.file.includes("broker");
  });
  assert(brokerRec, "need a broker record for HTTP fetch test");

  var cliRec = JSON.parse(runScript(MAP_SCRIPT, ["--record", brokerRec.recordId]));
  var httpResp = await httpGet(
    "/memory/record/" + encodeURIComponent(brokerRec.recordId)
  );

  assert(httpResp.success, "HTTP /memory/record/:id should succeed");
  assert(httpResp.data, "HTTP response should have data");
  assertEq(httpResp.data.recordId, cliRec.recordId, "HTTP and CLI recordId should match");
  assertEq(httpResp.data.title, cliRec.title, "HTTP and CLI title should match");
  assert(
    typeof httpResp.data.complete === "string" && httpResp.data.complete.length > 0,
    "HTTP response should have non-empty complete field"
  );
});

// TC-13: MCP dispatch memory_map stats — agrees with HTTP total
await test(
  "TC-13: MCP tools/call memory_map {stats:true} returns correct total",
  async function () {
    var httpStats = (await httpGet("/memory/map/stats")).data;
    var mcpResp = await httpMcp("tools/call", {
      name: "memory_map",
      arguments: { stats: true },
    });

    assert(
      mcpResp.result,
      "MCP response should have result, got keys: " + JSON.stringify(Object.keys(mcpResp))
    );
    var content = mcpResp.result.content;
    assert(
      Array.isArray(content) && content.length > 0,
      "MCP result should have content array"
    );
    assertEq(content[0].type, "text", "MCP content should be text");

    var mcpData = JSON.parse(content[0].text);
    assertEq(
      mcpData.total,
      httpStats.total,
      "MCP memory_map stats total should match HTTP stats total"
    );
    assert(typeof mcpData.byProject === "object", "MCP stats should have byProject");
    assert(typeof mcpData.byNode === "object", "MCP stats should have byNode");
  }
);

// TC-14: MCP dispatch rule_map stats
await test("TC-14: MCP tools/call rule_map {stats:true} returns rule total", async function () {
  var httpRuleStats = (await httpGet("/rules/map/stats")).data;
  var mcpResp = await httpMcp("tools/call", {
    name: "rule_map",
    arguments: { stats: true },
  });

  assert(mcpResp.result, "MCP rule_map response should have result");
  var content = mcpResp.result.content;
  assert(
    Array.isArray(content) && content.length > 0,
    "MCP rule_map result should have content"
  );
  assertEq(content[0].type, "text", "MCP rule_map content should be text");

  var mcpData = JSON.parse(content[0].text);
  assertEq(
    mcpData.total,
    httpRuleStats.total,
    "MCP rule_map total should match HTTP rules/map/stats total"
  );
  assert(mcpData.total >= 1, "should have >=1 rule (sample.md exists), got " + mcpData.total);
  assert(typeof mcpData.byScope === "object", "MCP rule stats should have byScope");
  assert(
    typeof mcpData.byLoadCondition === "object",
    "MCP rule stats should have byLoadCondition"
  );
});

// TC-15: Rules path-scoped vs always-on
await test(
  "TC-15: sample.md is path-scoped; temp always-on rule shows loadCondition=always",
  async function () {
    // Verify existing sample.md is path-scoped
    var allRules = JSON.parse(runScript(RULE_SCRIPT, []));
    var sample = allRules.find(function (r) { return r.file === "sample.md"; });
    assert(sample, "sample.md rule should exist");
    assertEq(sample.loadCondition, "path-scoped", "sample.md should be path-scoped");
    assert(
      Array.isArray(sample.paths) && sample.paths.length > 0,
      "path-scoped rule must have non-empty paths array, got: " + JSON.stringify(sample.paths)
    );

    // Create a temp always-on rule (no paths: frontmatter)
    var tempRulePath = path.join(os.homedir(), ".claude", "rules", "e2e-test-always-on.md");
    var tempContent =
      "---\nname: E2E Test Always-On Rule\ndescription: Temporary rule for e2e tests\n---\n\nThis rule is always loaded.\n";

    var testPassed = true;
    var testError = null;
    try {
      fs.writeFileSync(tempRulePath, tempContent);
      // Small delay for file system
      await new Promise(function (r) { setTimeout(r, 200); });

      var rulesAfter = JSON.parse(runScript(RULE_SCRIPT, []));
      var tempRule = rulesAfter.find(function (r) {
        return r.file === "e2e-test-always-on.md";
      });
      if (!tempRule) {
        testPassed = false;
        testError = "temp always-on rule should be found but was not in rule list";
      } else if (tempRule.loadCondition !== "always") {
        testPassed = false;
        testError =
          "temp rule without paths should have loadCondition=always, got: " +
          tempRule.loadCondition;
      } else if (!Array.isArray(tempRule.paths) || tempRule.paths.length !== 0) {
        testPassed = false;
        testError =
          "always-on rule should have empty paths array, got: " +
          JSON.stringify(tempRule.paths);
      }
    } finally {
      // ALWAYS remove temp rule even on failure
      try { fs.unlinkSync(tempRulePath); } catch (e) {}
    }

    if (!testPassed) throw new Error(testError);
  }
);

// TC-16: Rule scope filters -- user vs project
await test(
  "TC-16: --scope user vs --scope project partition rules correctly",
  async function () {
    var userRules = JSON.parse(runScript(RULE_SCRIPT, ["--scope", "user"]));
    var projectRules = JSON.parse(runScript(RULE_SCRIPT, ["--scope", "project"]));

    assert(
      userRules.length > 0,
      "should have >=1 user-scope rules (sample.md), got 0"
    );

    for (var i = 0; i < userRules.length; i++) {
      assertEq(
        userRules[i].scope,
        "user",
        "user-scope filter: all rules must have scope=user, got " + userRules[i].scope
      );
    }

    for (var j = 0; j < projectRules.length; j++) {
      assertEq(
        projectRules[j].scope,
        "project",
        "project-scope filter: all rules must have scope=project, got " + projectRules[j].scope
      );
    }

    var allRules = JSON.parse(runScript(RULE_SCRIPT, []));
    // The total of both partitions should not wildly exceed total (they may overlap
    // via cross-node repo mirrors but that is within reason)
    assert(
      userRules.length + projectRules.length <= allRules.length + 2,
      "user+project counts should be plausible, got " +
        (userRules.length + projectRules.length) +
        " vs total " +
        allRules.length
    );
  }
);

// TC-17: Autosync observe mode
await test(
  "TC-17: Autosync observe mode: mode=observe, running, log has started, no commit/push",
  async function () {
    var statusResp = await httpGet("/memory/autosync/status");
    assert(statusResp.success, "autosync/status should succeed");
    assertEq(statusResp.data.mode, "observe", "daemon should be in observe mode");
    assert(statusResp.data.running, "daemon should be running");
    assert(statusResp.data.logFile, "autosync status should report a logFile path");

    var logFile = statusResp.data.logFile;
    if (fs.existsSync(logFile)) {
      var logContent = fs.readFileSync(logFile, "utf8");
      assert(logContent.length > 0, "autosync log should not be empty");
      assert(
        logContent.indexOf('"decision":"started"') >= 0,
        "autosync log should contain started decision"
      );
      // Observe mode must NEVER log committed or pushed decisions
      assert(
        logContent.indexOf('"decision":"committed"') < 0,
        "observe mode must never log committed decision -- real git write detected"
      );
      assert(
        logContent.indexOf('"decision":"pushed"') < 0,
        "observe mode must never log pushed decision -- real git push detected"
      );
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// Summary
// ─────────────────────────────────────────────────────────────────────────────
console.log("\n──────────────────────────────────────────────");
console.log(
  "Results: " + passed + " passed, " + failed + " failed (total: " + (passed + failed) + ")"
);
if (failures.length > 0) {
  console.log("\nFailed tests:");
  for (var fi = 0; fi < failures.length; fi++) {
    console.log("  FAIL: " + failures[fi].name);
    console.log("        " + failures[fi].error.split("\n")[0]);
  }
}
console.log("──────────────────────────────────────────────");
if (failed > 0) process.exit(1);

})();
