# Skill Tracing & Analytics — Design Spec

## Overview

Add skill-level tracing and analytics to lm-assist. Users can see which skills are installed, how they're used across sessions, and trace the full causal chain of a skill execution — including subagent work.

**Two capabilities:**
- **A) Skill inventory + usage analytics** — Index installed skills from plugin cache, track invocation frequency, success rates, chain patterns across all sessions
- **B) Skill execution trace** — Full causal chain per invocation: what loaded, what tools Claude called, what files were touched, what subagents were spawned, recursive into subagent sessions (deep trace)

## Background: How Skills Appear in Session JSONL

When Claude invokes a skill, the session JSONL contains a 3-message sequence:

1. **Assistant `tool_use`**: `name: "Skill"`, `input.skill: "plugin:skillName"`, `input.args?: string`
2. **User `tool_result`**: `toolUseResult: { success: boolean, commandName: string }`
3. **User `isMeta: true`**: Full SKILL.md content, linked via `sourceToolUseID`

After step 3, Claude follows the skill instructions, producing tool calls, file operations, and potentially spawning subagents — all within the same session JSONL.

**Current state**: lm-assist's session cache extracts `CachedToolUse` with `name: "Skill"` and `input: {skill: "..."}`, but does not index skills separately or track their execution spans.

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
  skillName: string;          // Full qualified: "lm-unified-trade:fundamental-analysis"
  pluginName: string;         // Namespace: "lm-unified-trade"
  shortName: string;          // Skill only: "fundamental-analysis"
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

Extraction happens in the existing `parseMessages()` loop in `session-cache.ts`.

### During assistant message processing (line ~852 area)

When `block.name === 'Skill'`:
- Parse `block.input.skill` into `pluginName:shortName`
- Create a new `CachedSkillInvocation` and push to `updated.skillInvocations[]`
- Close the previous skill's span: set `spanEndLine = msg.lineIndex - 1`

### During user message processing (line ~756 area)

When `isMeta === true` and text starts with `"Base directory for this skill:"`:
- Match to the most recent open `CachedSkillInvocation` via `sourceToolUseID`
- Set `instructionsLineIndex` and `instructionsLength`
- Set `spanStartLine = msg.lineIndex + 1`

### During tool_result processing (line ~793 area)

When `toolUseResult.commandName` matches a pending skill:
- Set `success` from `toolUseResult.success`

### Span attribution — second pass after all messages parsed

For each skill invocation, scan `toolUses[]` and `subagents[]` within `[spanStartLine, spanEndLine]`:
- Populate `toolsCalled` (unique tool names), `toolUseCount`
- Populate `filesRead` from `Read`/`Glob` tool inputs, `filesWritten` from `Write`/`Edit` tool inputs
- Populate `subagentIds` from `CachedSubagent` entries whose `lineIndex` falls within span

### Span boundary rules

1. Skill span starts at `instructionsLineIndex + 1` (first action after loading)
2. Skill span ends at: next `Skill` tool_use line, OR next real user prompt line, OR end of session
3. Subagent tool_uses within span are attributed to the skill

### Incremental parsing

Works with existing incremental model — skills are appended like toolUses. On incremental parse, only new lines are scanned. The last skill's `spanEndLine` stays `undefined` until closed by a subsequent skill or user message.

### Cache version bump

`CACHE_VERSION` goes from 9 to 10 to trigger reparse of existing sessions with skill extraction.

---

## Section 3: Skill Index — Cross-Session Analytics

Lightweight persistent index that builds itself as sessions are loaded into cache.

### Storage

`~/.lm-assist/skills/index.json` — single JSON file. Skill analytics don't need LMDB-level performance since the dataset is small (hundreds of invocations, not millions of messages).

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

Installed skill definitions (name, description, trigger text) come from scanning plugin cache directories at `~/.claude/plugins/cache/*/`. Static read done once on server start and refreshed on demand.

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
3. Subagent sessions live at `~/.claude/projects/*/sessions/subagents/agent-{agentId}.jsonl`
4. Loading that subagent session through the same `SessionCache` gives its own `skillInvocations[]`, `toolUses[]`, etc.
5. Recursion: subagents can spawn their own subagents — follow the tree

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
  totalCostUsd?: number;
  durationMs?: number;

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

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/skills` | List all installed skills with usage stats |
| GET | `/skills/:skillName` | Detail for one skill — definition + all session usage |
| GET | `/skills/analytics` | Aggregated analytics: top skills, trends, success rates |
| GET | `/skills/analytics/chains` | Common skill chain patterns (A->B->C frequency) |

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

**Total: 8 new endpoints.** All follow existing `wrapResponse()` pattern with `ApiResponse<T>`.

Registered via `createSkillRoutes(ctx: RouteContext)` in `core/src/routes/core/index.ts`.

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
web/src/app/skills/              <- New page
  page.tsx                       <- Skills inventory + analytics
web/src/components/skills/       <- New components
  SkillList.tsx                  <- Left panel inventory
  SkillDetail.tsx                <- Center panel detail
  SkillAnalytics.tsx             <- Right panel analytics
  SkillTimeline.tsx              <- Session-view skills tab
  SkillChainFlow.tsx             <- Chain visualization
```

Styling follows existing patterns: Tailwind v4, same color palette, same card/panel layout as knowledge and sessions pages.

---

## File Plan

### New files

| File | Purpose |
|------|---------|
| `core/src/skill-index.ts` | SkillIndex class, InstalledSkill scanner, SkillTrace resolver |
| `core/src/routes/core/skills.routes.ts` | 8 API endpoints |
| `web/src/app/skills/page.tsx` | Skills page |
| `web/src/components/skills/SkillList.tsx` | Inventory list component |
| `web/src/components/skills/SkillDetail.tsx` | Skill detail component |
| `web/src/components/skills/SkillAnalytics.tsx` | Analytics summary component |
| `web/src/components/skills/SkillTimeline.tsx` | Session skill timeline component |
| `web/src/components/skills/SkillChainFlow.tsx` | Chain flow visualization |

### Modified files

| File | Change |
|------|--------|
| `core/src/session-cache.ts` | Add `CachedSkillInvocation` type, skill extraction in `parseMessages()`, bump CACHE_VERSION to 10 |
| `core/src/routes/core/index.ts` | Register `createSkillRoutes` |
| `web/src/app/layout.tsx` or sidebar component | Add Skills nav link |
| `web/src/app/session-dashboard/` | Add Skills tab |

### Data files (created at runtime)

| Path | Purpose |
|------|---------|
| `~/.lm-assist/skills/index.json` | Cross-session skill index |
