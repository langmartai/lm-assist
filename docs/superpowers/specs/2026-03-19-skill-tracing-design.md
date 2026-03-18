# Skill Tracing & Analytics — Design Spec

## Overview

Add skill-level tracing and analytics to lm-assist. Users can see which skills are installed, how they're used across sessions, and trace the full causal chain of a skill execution — including subagent work.

**Two capabilities:**
- **A) Skill inventory + usage analytics** — Index installed skills from plugin cache, track invocation frequency, success rates, chain patterns across all sessions
- **B) Skill execution trace** — Full causal chain per invocation: what loaded, what tools Claude called, what files were touched, what subagents were spawned, recursive into subagent sessions (deep trace)

## Background: How Skills Appear in Session JSONL

When Claude invokes a skill, the session JSONL contains a 3-message sequence:

1. **Assistant `tool_use`**: `name: "Skill"`, `input.skill: "plugin:skillName"` or just `"skillName"`, `input.args?: string`
2. **User `tool_result`**: Contains both a `tool_result` content block AND a top-level `toolUseResult` object with `{ success: boolean, commandName: string, allowedTools?: string[] }`. Note: this `toolUseResult` shape differs from the standard `tool_result` content block — it is a Skill-specific message-level field.
3. **User `isMeta: true`**: Full SKILL.md content, linked via `sourceToolUseID` (note casing: capital `ID`)

After step 3, Claude follows the skill instructions, producing tool calls, file operations, and potentially spawning subagents — all within the same session JSONL.

**Skill name formats**: Skills may appear namespaced (`lm-unified-trade:fundamental-analysis`, `superpowers:brainstorming`) or non-namespaced (`brainstorming`, `simplify`). Both forms must be handled.

**Current state**: lm-assist's session cache extracts `CachedToolUse` with `name: "Skill"` and `input: {skill: "..."}`, but does not index skills separately or track their execution spans. The raw JSONL parser types (`RawSessionRecord` in `jsonl-parser.ts`) do not include `sourceToolUseID` or the Skill-specific `toolUseResult` shape — these fields are accessed dynamically from the raw parsed JSON in `mergeNewMessages()`.

## Architecture: Hybrid with Lazy Materialization

- **Session cache enrichment**: Extract `CachedSkillInvocation[]` during JSONL parsing (per-session skill traces)
- **Cross-session skill index**: Lightweight JSON file that populates lazily as sessions are loaded into cache
- **Deep trace resolution**: On-demand recursive walk into subagent sessions
- **Skill inventory**: Static scan of plugin cache directories for installed skill definitions

No new file watchers or background processes. Piggybacks on existing session-cache lifecycle.

---

## Section 1: Data Model

### CachedSkillInvocation

New interface extracted during JSONL parsing, alongside existing `CachedToolUse`, `CachedSubagent`, etc.

```typescript
export interface CachedSkillInvocation {
  // Identity
  skillName: string;          // As invoked: "lm-unified-trade:fundamental-analysis" or "brainstorming"
  pluginName: string;         // Namespace: "lm-unified-trade", or "unknown" if non-namespaced
  shortName: string;          // Skill only: "fundamental-analysis" or "brainstorming"
  args?: string;              // Optional args passed to Skill tool

  // Linkage (to existing session data)
  toolUseId: string;          // The Skill tool_use ID (links to CachedToolUse)
  turnIndex: number;          // Turn where skill was invoked
  lineIndex: number;          // JSONL line of invocation

  // Loaded content
  instructionsLineIndex?: number;  // Line of the isMeta message with skill content
  instructionsLength?: number;     // Character count of loaded instructions

  // Execution span
  spanStartLine: number;      // First line after instructions loaded
  spanEndLine?: number;       // Last line before next skill/user message (undefined = ongoing)

  // Attribution within span
  toolsCalled: string[];      // Unique tool names used during this skill's span
  toolUseCount: number;       // Total tool_use calls in span
  filesRead: string[];        // Files read during span
  filesWritten: string[];     // Files created/modified during span

  // Subagent tracking (deep trace)
  subagentIds: string[];      // Subagents spawned during this skill's span

  // Outcome
  success?: boolean;          // From toolUseResult.success
  timestamp?: string;         // When invoked
}
```

Added to `SessionCacheData`:

```typescript
export interface SessionCacheData {
  // ... existing fields ...

  // Skill invocations (new)
  skillInvocations: CachedSkillInvocation[];
}
```

**Design choices:**
- `spanStartLine`/`spanEndLine` defines the causal boundary — everything between skill load and the next skill invocation or user message
- `subagentIds` links to existing `CachedSubagent[]` entries for deep tracing
- `toolsCalled`/`filesRead`/`filesWritten` computed by scanning tool_use blocks within the span
- Minimal storage — indices and summaries only, no duplicated content

---

## Section 2: Session Cache Parsing — Skill Extraction

Extraction happens in the existing `mergeNewMessages()` loop in `session-cache.ts`. The `mergeNewMessages()` function reads raw JSON objects from JSONL lines — fields like `isMeta`, `sourceToolUseID`, and the Skill-specific `toolUseResult` are accessed dynamically from the raw parsed JSON (not from typed parser interfaces).

### During assistant message content block loop

When `block.name === 'Skill'`:
- Parse `block.input.skill` by splitting on `:`. If colon present: `pluginName = parts[0]`, `shortName = parts[1]`. If no colon: `pluginName = "unknown"`, `shortName = block.input.skill`. Attempt to resolve `pluginName` later via installed skill inventory (best-effort).
- Create a new `CachedSkillInvocation` and push to `updated.skillInvocations[]`
- Close the previous skill's span: set `spanEndLine = msg.lineIndex - 1`

### During user message processing

When `msg.isMeta === true` and `msg.sourceToolUseID` is present:
- Find the pending `CachedSkillInvocation` whose `toolUseId` matches `msg.sourceToolUseID`
- If found, set `instructionsLineIndex = msg.lineIndex` and `instructionsLength = text.length`
- Set `spanStartLine = msg.lineIndex + 1`

### During tool_result content block processing

When a user message contains a `tool_result` block AND the raw message has a top-level `toolUseResult` object with `success` and `commandName` fields (Skill-specific shape):
- Find the pending `CachedSkillInvocation` whose `toolUseId` matches `block.tool_use_id`
- Set `success` from `msg.toolUseResult.success`

### Span attribution — second pass after all messages parsed

For each skill invocation, scan `toolUses[]` and `subagents[]` within `[spanStartLine, spanEndLine]`:
- Populate `toolsCalled` (unique tool names), `toolUseCount`
- Populate `filesRead` from `Read`/`Glob` tool inputs (extract file path from `input.file_path` or `input.path`), `filesWritten` from `Write`/`Edit` tool inputs (extract from `input.file_path`)
- Populate `subagentIds` from `CachedSubagent` entries whose `lineIndex` falls within span

### Span boundary rules

1. Skill span starts at `instructionsLineIndex + 1` (first action after instructions loaded)
2. Skill span ends at: next `Skill` tool_use line, OR next real user prompt line (where `isRealUserPrompt()` returns true), OR end of session
3. Subagent tool_uses within span are attributed to the skill

### Incremental parsing

Works with existing incremental model — skills are appended like toolUses. On incremental parse, only new lines are scanned.

**Open span closure on incremental parse**: Before processing new lines, check if the last `CachedSkillInvocation` from the prior parse has `spanEndLine === undefined`. If the first new message is a closing event (another Skill tool_use or a real user prompt), close the prior skill's span with `spanEndLine = firstNewLine.lineIndex - 1` and re-run span attribution for that skill.

### Cache version bump

`CACHE_VERSION` increments by 1 (currently 9, becomes 10) to trigger full reparse of existing sessions with skill extraction.

---

## Section 3: Skill Index — Cross-Session Analytics

Lightweight persistent index that builds itself as sessions are loaded into cache.

### Storage

`~/.lm-assist/skills/index.json` — single JSON file. Skill analytics don't need LMDB-level performance since the dataset is small (hundreds of invocations, not millions of messages).

**Crash safety**: Register a shutdown hook (`process.on('beforeExit')`) that flushes any pending debounced writes. Acceptable to lose at most 1 second of index updates on hard crash — the index self-heals on next session load since `indexedSessions` fileSize won't match.

**Pruning**: `indexedSessions` is pruned on each full reindex — entries for sessions whose JSONL files no longer exist are removed. This prevents unbounded growth over months of usage.

### Data structures

```typescript
export interface SkillIndexEntry {
  skillName: string;          // "lm-unified-trade:fundamental-analysis"
  pluginName: string;         // "lm-unified-trade"
  shortName: string;          // "fundamental-analysis"

  // Aggregated stats
  totalInvocations: number;
  successCount: number;
  failCount: number;
  lastUsed: string;           // ISO timestamp
  firstUsed: string;

  // Per-session records (compact)
  sessions: Array<{
    sessionId: string;
    project: string;          // Project path
    timestamp: string;
    success?: boolean;
    toolUseCount: number;
    subagentCount: number;
  }>;
}

export interface SkillIndex {
  version: number;
  lastUpdated: string;
  // Keyed by full skillName
  skills: Record<string, SkillIndexEntry>;
  // Track which sessions have been indexed (sessionId -> fileSize at index time)
  indexedSessions: Record<string, number>;
}
```

### Population mechanism

Hooks into existing `SessionCache.onSessionChange()` callback:

1. When a session is loaded/updated, check if `indexedSessions[sessionId]` matches current fileSize
2. If not, read `skillInvocations[]` from the cached session data
3. Upsert into `skills[skillName].sessions[]` and update aggregates
4. Write index to disk (debounced, max once per second)

### Warm-up

The existing `POST /session-cache/warm` endpoint already loads sessions into cache. After warm-up, the skill index is fully populated as a side effect. No separate warm-up needed.

### Installed skill inventory

Installed skill definitions (name, description, trigger text) come from scanning plugin cache directories. The directory structure is:

```
~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/skills/<skillName>/SKILL.md
```

Example: `~/.claude/plugins/cache/claude-plugins-official/superpowers/5.0.2/skills/brainstorming/SKILL.md`

The scanner uses `~/.claude/plugins/installed_plugins.json` to find installed plugins, their `installPath`, and version. For each plugin, it reads `<installPath>/skills/*/SKILL.md` and parses the YAML frontmatter for name and description. This avoids blind directory traversal — only installed plugins are scanned.

The `pluginVersion` for each `InstalledSkill` comes from the `version` field in `installed_plugins.json`.

Static read done once on server start and refreshed on demand via `POST /skills/refresh-inventory`.

```typescript
export interface InstalledSkill {
  skillName: string;          // "lm-unified-trade:fundamental-analysis"
  pluginName: string;
  shortName: string;
  description: string;        // From SKILL.md frontmatter
  pluginVersion: string;
  installPath: string;        // Path to skill directory
  hasUsage: boolean;          // Cross-referenced with SkillIndex
}
```

Two views:
- **Inventory**: "What skills are installed?" (from plugin cache)
- **Analytics**: "How are they used?" (from skill index)

---

## Section 4: Deep Trace Resolution

When a skill spawns subagents (like `trade-analyze` spawning parallel `fundamental-analysis` + `technical-analysis` agents), follow into those subagent sessions and attribute their work back to the parent skill.

### Resolution is on-demand, not at parse time

The session cache stores `subagentIds[]` per skill invocation. Deep trace is resolved when the API consumer requests it.

### Mechanism

1. `CachedSkillInvocation.subagentIds` contains agent IDs found within the skill's span
2. Each agent ID maps to a `CachedSubagent` which has `agentId` — the subagent's session identifier
3. Subagent sessions live at `~/.claude/projects/<encodedProject>/<parentSessionId>/subagents/agent-<agentId>.jsonl` (note: no `sessions/` directory in path — it's project dir -> parent session UUID dir -> `subagents/` -> agent file)
4. The session cache already knows how to discover and load these files (see `session-cache.ts` line ~457 where it scans `subagentsDir`)
5. Loading that subagent session through the same `SessionCache` gives its own `skillInvocations[]`, `toolUses[]`, etc.
6. Recursion: subagents can spawn their own subagents — follow the tree

### SkillTrace data structure

```typescript
export interface SkillTrace {
  // Root invocation (from parent session)
  invocation: CachedSkillInvocation;
  sessionId: string;
  project: string;

  // Aggregated across entire tree
  totalToolUses: number;
  totalFilesRead: string[];
  totalFilesWritten: string[];
  totalSubagents: number;

  // Timing (derived from timestamps of first/last messages in span)
  durationMs?: number;        // lastTimestamp - firstTimestamp within span boundaries

  // Child skill traces (recursive)
  children: SkillTrace[];
}
```

### Resolution algorithm

```
resolveSkillTrace(sessionId, skillInvocation, sessionCache, depth=0, maxDepth=5):
  1. Start with the invocation's direct data (tools, files, subagentIds)
  2. For each subagentId:
     a. Find the subagent session file
     b. Load it through SessionCache (gets skillInvocations for free)
     c. For each skillInvocation in the subagent session:
        - Recurse: resolveSkillTrace(subagentSessionId, childInvocation, ...)
     d. If no skill invocations in subagent, attribute all tool uses to parent
  3. Aggregate totals up the tree
  4. Return SkillTrace
```

**Max depth = 5** prevents runaway recursion. In practice lm-unified-trade goes 2 levels deep (trade-analyze -> agent -> fundamental-analysis).

**Reuses existing infrastructure:**
- `SessionCache.getSessionData()` for loading subagent sessions
- `CachedSubagent.agentId` for finding subagent session files
- `session-dag.ts` can optionally provide the tree structure via `buildSessionDag()`

---

## Section 5: API Endpoints

New route file: `core/src/routes/core/skills.routes.ts`

### Inventory & Analytics (4 endpoints)

| Method | Endpoint | Regex Pattern | Description |
|--------|----------|---------------|-------------|
| GET | `/skills` | `/^\/skills$/` | List all installed skills with usage stats |
| GET | `/skills/analytics` | `/^\/skills\/analytics$/` | Aggregated analytics: top skills, trends, success rates |
| GET | `/skills/analytics/chains` | `/^\/skills\/analytics\/chains$/` | Common skill chain patterns |
| GET | `/skills/detail/:skillName` | `/^\/skills\/detail\/(.+)$/` | Detail for one skill — definition + all session usage |

**Route ordering**: Register `/skills/analytics` and `/skills/analytics/chains` before `/skills/detail/:skillName` to avoid collision. The `:skillName` parameter is URL-encoded (e.g., `lm-unified-trade:fundamental-analysis` becomes `lm-unified-trade%3Afundamental-analysis`).

`GET /skills` response shape:
```json
{
  "installed": [
    {
      "skillName": "lm-unified-trade:fundamental-analysis",
      "pluginName": "lm-unified-trade",
      "description": "Supply/demand decomposition with influence weights",
      "pluginVersion": "0.1.0",
      "totalInvocations": 34,
      "successRate": 0.97,
      "lastUsed": "2026-03-19T01:20:00Z"
    }
  ],
  "totalSkills": 42,
  "totalInvocations": 242
}
```

`GET /skills/analytics/chains` response shape:
```json
{
  "chains": [
    {
      "sequence": ["fundamental-analysis", "technical-analysis", "regime-analysis", "point-in-time-analysis"],
      "occurrences": 12,
      "avgDurationMs": 340000,
      "projects": ["lm-unified-trade"]
    }
  ]
}
```

### Per-Session Skill View (2 endpoints)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/sessions/:id/skills` | All skill invocations in a session |
| GET | `/sessions/:id/skills/:index/trace` | Deep trace for the Nth skill invocation |

`GET /sessions/:id/skills` returns `CachedSkillInvocation[]` from session cache.

`GET /sessions/:id/skills/:index/trace` resolves the full `SkillTrace` tree (deep trace with subagent recursion). Query param `?maxDepth=N` to control recursion depth (default 5).

### Index Management (2 endpoints)

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/skills/reindex` | Force rebuild of skill index from all cached sessions |
| POST | `/skills/refresh-inventory` | Rescan plugin cache for installed skills |

**Total: 8 new endpoints.** Follow the bare-object response pattern used by the majority of routes (e.g., `sessions.routes.ts`, `knowledge.routes.ts`): return `{ success: true, data: ... }` objects directly from handlers.

Registered via `createSkillRoutes(ctx: RouteContext)` in `core/src/routes/core/index.ts`.

### Chain detection algorithm

`GET /skills/analytics/chains` detects chains by scanning consecutive `CachedSkillInvocation` entries within the same session. Two skills are considered chained if they appear sequentially (the second skill's `lineIndex` follows the first skill's `spanEndLine`). The algorithm:

1. For each session with `skillInvocations.length >= 2`, extract the ordered sequence of `shortName` values
2. Find all contiguous subsequences of length 2+
3. Count occurrences of each unique subsequence across all sessions
4. Return sorted by occurrence count, deduplicated

---

## Section 6: Web UI

### New page: Skills (`/skills`)

Top-level page in the sidebar, between Knowledge and Tasks.

**Three-panel layout:**

**Left panel — Skill inventory list:**
- All installed skills grouped by plugin (collapsible sections)
- Each skill shows: name, invocation count, last used, success rate sparkline
- Search/filter bar at top
- Skills with zero usage shown dimmed
- Click a skill to show detail in center panel

**Center panel — Skill detail:**
- Selected skill's description (from SKILL.md frontmatter)
- Usage timeline (invocations over time, bar chart)
- Session list — every session that used this skill, sorted by recency
- Each session row: timestamp, project, success/fail, tool count, subagent count
- Click a session to navigate to session view with skill highlighted

**Right panel — Analytics summary:**
- Top 10 most-used skills
- Most common chains (top 5 sequences)
- Success/failure rates
- Skills by plugin breakdown

### Session view enhancement: Skills tab

Within the existing session detail page (`/session-dashboard`), add a Skills tab alongside existing tabs.

**Skills timeline:** Vertical timeline showing skill invocations in order within the session. Each skill node shows:
- Skill name + args
- Span: line range, tool count, file count
- Expandable: list of tools called, files read/written
- If subagents spawned: nested tree showing child skill traces (deep trace)
- Click any node to scroll the conversation view to that skill's invocation point

**Skill chain visualization:** If multiple skills were invoked, show the chain as a horizontal flow diagram at the top of the tab.

### Component structure

```
web/src/app/(dashboard)/skills/  <- New page (inside dashboard route group for sidebar layout)
  page.tsx                       <- Skills inventory + analytics
web/src/components/skills/       <- New components
  SkillList.tsx                  <- Left panel inventory
  SkillDetail.tsx                <- Center panel detail
  SkillAnalytics.tsx             <- Right panel analytics
  SkillTimeline.tsx              <- Session-view skills tab
  SkillChainFlow.tsx             <- Chain visualization
```

Styling follows existing patterns: Tailwind v4, same color palette, same card/panel layout as knowledge and sessions pages.

**Sidebar nav link**: Add to the navigation items array in the dashboard layout component (check `web/src/app/(dashboard)/layout.tsx` or the sidebar component it renders). Place between Knowledge and Tasks links.

---

## File Plan

### New files

| File | Purpose |
|------|---------|
| `core/src/skill-index.ts` | SkillIndex class, InstalledSkill scanner, SkillTrace resolver, chain detection |
| `core/src/routes/core/skills.routes.ts` | 8 API endpoints |
| `web/src/app/(dashboard)/skills/page.tsx` | Skills page |
| `web/src/components/skills/SkillList.tsx` | Inventory list component |
| `web/src/components/skills/SkillDetail.tsx` | Skill detail component |
| `web/src/components/skills/SkillAnalytics.tsx` | Analytics summary component |
| `web/src/components/skills/SkillTimeline.tsx` | Session skill timeline component |
| `web/src/components/skills/SkillChainFlow.tsx` | Chain flow visualization |

### Modified files

| File | Change |
|------|--------|
| `core/src/session-cache.ts` | Add `CachedSkillInvocation` type, skill extraction in `mergeNewMessages()`, bump CACHE_VERSION |
| `core/src/routes/core/index.ts` | Register `createSkillRoutes` |
| `web/src/app/(dashboard)/layout.tsx` or sidebar component | Add Skills nav link between Knowledge and Tasks |
| `web/src/app/session-dashboard/` | Add Skills tab |

### Data files (created at runtime)

| Path | Purpose |
|------|---------|
| `~/.lm-assist/skills/index.json` | Cross-session skill index |
