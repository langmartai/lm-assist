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
  timestamp?: string;         // From the assistant message's msg.timestamp field
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
- Parse `block.input.skill` by splitting on `:`. If colon present: `pluginName = parts[0]`, `shortName = parts[1]`. If no colon: `pluginName = "unknown"`, `shortName = block.input.skill`.
- Create a new `CachedSkillInvocation` and push to `updated.skillInvocations[]`
- Close the previous skill's span: set `spanEndLine = msg.lineIndex - 1`

### During user message processing

When `msg.isMeta === true` and `msg.sourceToolUseID` is present:
- Find the pending `CachedSkillInvocation` whose `toolUseId` matches `msg.sourceToolUseID`
- If found, set `instructionsLineIndex = msg.lineIndex` and `instructionsLength = text.length`
- Set `spanStartLine = msg.lineIndex + 1`

### During tool_result content block processing

For each `tool_result` block in a user message:
1. First check if a pending `CachedSkillInvocation` exists with `toolUseId === block.tool_use_id`
2. If matched, read `msg.toolUseResult.success` (the Skill-specific message-level field) and set it on the matched invocation
3. Do NOT apply `msg.toolUseResult` to other `tool_result` blocks on the same message — the Skill-specific `toolUseResult` applies only to the block whose `tool_use_id` matches the skill's `toolUseId`

This ordering (match by block ID first, then read message-level field) prevents misattribution when a message contains both a Skill `tool_result` and other tool results.

### Non-namespaced skill resolution — during span attribution

During the second pass, for each skill with `pluginName === "unknown"`, scan the `InstalledSkill[]` inventory (from `getSkillIndex()`) for a matching `shortName`. If exactly one match is found, update `pluginName` and `skillName` to the namespaced form (e.g., `"brainstorming"` → `"superpowers:brainstorming"`). If multiple matches or zero matches exist, keep `pluginName = "unknown"`. This ensures non-namespaced invocations are unified with their namespaced counterparts in the index.

### Span attribution — second pass after all messages parsed

For each skill invocation, scan `toolUses[]` and `subagents[]` within `[spanStartLine, spanEndLine]`:
- Populate `toolsCalled` (unique tool names), `toolUseCount`
- Populate `filesRead` from `Read`/`Glob` tool inputs (extract file path from `input.file_path` or `input.path`), `filesWritten` from `Write`/`Edit` tool inputs (extract from `input.file_path`)
- Populate `subagentIds` from `CachedSubagent` entries whose `lineIndex` falls within span

### Span boundary rules

1. Skill span starts at `instructionsLineIndex + 1` (first action after instructions loaded)
2. Skill span ends at: next `Skill` tool_use line, OR next real user prompt line (where `isRealUserPrompt()` returns true), OR end of session
3. Subagent tool_uses within span are attributed to the skill
4. **Degenerate span**: If `spanEndLine < spanStartLine`, the skill was loaded but immediately superseded by the next skill (common in back-to-back invocations like `fundamental-analysis` → `technical-analysis` fired consecutively). Set `spanEndLine = spanStartLine - 1` (empty span). All attribution arrays (`toolsCalled`, `filesRead`, `filesWritten`, `subagentIds`) will be empty. `toolUseCount = 0`. This is expected — the skill's real work happens in the subagent, not the parent session.

**Real-world example** (from lm-unified-trade subagent sessions):
```
line 7:  assistant → Skill "fundamental-analysis"
line 8:  user → tool_result (success)
line 9:  user → isMeta (SKILL.md content)       ← spanStartLine = 10
line 10: assistant → Skill "technical-analysis"  ← closes span: spanEndLine = 9
```
Result: fundamental-analysis gets `spanStartLine=10, spanEndLine=9` → degenerate span, empty attribution.

### Incremental parsing

Works with existing incremental model — skills are appended like toolUses. On incremental parse, only new lines are scanned.

**Open span closure on incremental parse**: Before processing new lines, check if the last `CachedSkillInvocation` from the prior parse has `spanEndLine === undefined`. If the first new message is a closing event (another Skill tool_use or a real user prompt), close the prior skill's span with `spanEndLine = firstNewLine.lineIndex - 1` and re-run span attribution for that skill.

### Cache version bump

`CACHE_VERSION` increments by 1 (currently 9, becomes 10) to trigger full reparse of existing sessions with skill extraction.

---

## Section 3: Skill Index — Cross-Session Analytics

Lightweight persistent index that builds itself as sessions are loaded into cache.

### Initialization and wiring

`core/src/skill-index.ts` exports a `getSkillIndex(): SkillIndex` singleton factory, following the same pattern as `getSessionCache()` in `session-cache.ts`. On first access:

1. Load `~/.lm-assist/skills/index.json` from disk (or create empty if not exists)
2. Scan installed plugins to build `InstalledSkill[]` inventory
3. Register `SessionCache.onSessionChange()` callback for lazy index population
4. Register `process.on('SIGTERM')` and `process.on('SIGINT')` handlers to flush pending writes

`skills.routes.ts` imports `getSkillIndex` directly (same pattern as `sessions.routes.ts` importing `getSessionCache`). No changes needed to `RouteContext`.

The `createInitialCache()` method in `session-cache.ts` (which builds the empty `SessionCacheData` object) must include `skillInvocations: []` in the initial structure.

### Storage

`~/.lm-assist/skills/index.json` — single JSON file. Skill analytics don't need LMDB-level performance since the dataset is small (hundreds of invocations, not millions of messages).

**Crash safety**: Register `process.on('SIGTERM')` and `process.on('SIGINT')` handlers that flush any pending debounced writes (note: `beforeExit` does not fire on SIGTERM/SIGKILL, and `./core.sh stop` sends SIGTERM via `fuser -k`). Acceptable to lose at most 1 second of index updates on hard crash — the index self-heals on next session load since `indexedSessions` fileSize won't match.

**Pruning**: On each full reindex (`POST /skills/reindex`):
- `indexedSessions` entries for sessions whose JSONL files no longer exist are removed
- `SkillIndexEntry.sessions[]` entries referencing deleted sessions are also removed
- `SkillIndexEntry.sessions[]` is capped at the 200 most recent entries per skill (older entries are dropped, aggregated counts remain accurate). The `GET /skills/detail/:skillName` endpoint supports `?limit=N&offset=M` pagination for the session list.

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

  // Per-session records (compact, capped at 200 most recent)
  sessions: Array<{
    sessionId: string;
    project: string;          // Project path
    timestamp: string;
    success?: boolean;
    toolUseCount: number;
    subagentCount: number;
    isSubagentSession: boolean;  // true if this session is itself a subagent
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
3. Determine if the session is a subagent session (session file path contains `/subagents/`)
4. Upsert into `skills[skillName].sessions[]` with `isSubagentSession` flag, and update aggregates
5. Write index to disk (debounced, max once per second)

**Subagent counting**: Both direct and subagent invocations are indexed (both appear in `sessions[]`). The `isSubagentSession` flag allows analytics endpoints to distinguish between them. `GET /skills` and `GET /skills/analytics` report `totalInvocations` as the total count, and `directInvocations` as the count excluding subagent sessions. The deep trace view provides the tree-structured attribution.

### Warm-up

The existing `POST /session-cache/warm` endpoint already loads sessions into cache. After warm-up, the skill index is fully populated as a side effect. No separate warm-up needed.

### Installed skill inventory

Installed skill definitions (name, description, trigger text) come from scanning plugin cache directories. The directory structure is:

```
~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/skills/<skillName>/SKILL.md
```

Example: `~/.claude/plugins/cache/claude-plugins-official/superpowers/5.0.2/skills/brainstorming/SKILL.md`

The scanner uses `~/.claude/plugins/installed_plugins.json` to find installed plugins, their `installPath`, and version. Plugin keys in this file are formatted as `pluginName@marketplace` (e.g., `"superpowers@claude-plugins-official"`, `"lm-assist@langmartai"`). Extract `pluginName` by splitting the key on `@` and taking the first segment.

For each plugin entry, read `<installPath>/skills/*/SKILL.md` and parse the YAML frontmatter for `name` and `description`. Use a simple regex-based frontmatter parser (match between `---` delimiters, extract `name:` and `description:` lines) to avoid adding a YAML dependency. If a SKILL.md has no frontmatter, fall back to the directory name as `shortName` and empty string as `description`. Truncate `description` at 200 characters for the index.

The `pluginVersion` for each `InstalledSkill` comes from the `version` field in `installed_plugins.json`.

Static read done once on server start (inside `getSkillIndex()` initialization) and refreshed on demand via `POST /skills/refresh-inventory`.

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

| Method | Endpoint | Regex Pattern | Description |
|--------|----------|---------------|-------------|
| GET | `/sessions/:id/skills` | `/^\/sessions\/([^/]+)\/skills$/` | All skill invocations in a session |
| GET | `/sessions/:id/skills/:index/trace` | `/^\/sessions\/([^/]+)\/skills\/(\d+)\/trace$/` | Deep trace for the Nth skill invocation |

`GET /sessions/:id/skills` returns `CachedSkillInvocation[]` from session cache.

`GET /sessions/:id/skills/:index/trace` resolves the full `SkillTrace` tree (deep trace with subagent recursion). Query param `?maxDepth=N` to control recursion depth (default 5).

### Index Management (2 endpoints)

| Method | Endpoint | Regex Pattern | Description |
|--------|----------|---------------|-------------|
| POST | `/skills/reindex` | `/^\/skills\/reindex$/` | Force rebuild of skill index from all cached sessions |
| POST | `/skills/refresh-inventory` | `/^\/skills\/refresh-inventory$/` | Rescan plugin cache for installed skills |

**Total: 8 new endpoints.** Follow the bare-object response pattern used by the majority of routes (e.g., `sessions.routes.ts`, `knowledge.routes.ts`): return `{ success: true, data: ... }` objects directly from handlers.

Registered via `createSkillRoutes(ctx: RouteContext)` in `core/src/routes/core/index.ts`.

### Chain detection algorithm

`GET /skills/analytics/chains` detects recurring skill sequences across sessions:

1. For each session with `skillInvocations.length >= 2`, extract the full ordered sequence of `shortName` values (e.g., `["fundamental-analysis", "technical-analysis", "regime-analysis"]`)
2. Generate sliding windows of length 2, 3, and 4 from each sequence (capped at 4 to avoid combinatorial explosion). For `[A, B, C, D]` this produces: `[A,B]`, `[B,C]`, `[C,D]`, `[A,B,C]`, `[B,C,D]`, `[A,B,C,D]`
3. Count occurrences of each unique window across all sessions
4. Return top 20 chains sorted by occurrence count, filtered to `occurrences >= 2`

This is O(n) per session (max 3 windows per skill position) and bounded by the sliding window cap.

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

Add a Skills panel to the session view. The current `/session-dashboard` page is a multi-session terminal dashboard (`TerminalsPage`). The Skills tab should be added to the per-session detail component (the panel that shows a single session's conversation, tools, and metadata). If no tab system exists in the per-session component, add one with tabs: Conversation | Skills | (future tabs).

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

**Sidebar nav link**: Add to the navigation items array in `web/src/components/layout/Sidebar.tsx` (the `navItems` array). Current order is: Terminal Dashboard, Sessions, Process Dashboard, Search, Tasks, Projects, Knowledge, Assist Resources, Machines. Place Skills after Knowledge (before Assist Resources).

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
