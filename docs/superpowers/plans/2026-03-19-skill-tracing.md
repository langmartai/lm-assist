# Skill Tracing & Analytics Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add skill-level tracing and cross-session analytics to lm-assist, with API endpoints and web UI.

**Architecture:** Enrich session-cache JSONL parsing with `CachedSkillInvocation[]` extraction, add a `SkillIndex` singleton for cross-session analytics backed by a JSON file, expose 8 REST endpoints, and build a Skills dashboard page + session Skills tab in the web UI.

**Tech Stack:** TypeScript, Node.js HTTP server (existing), Next.js 16 + React 19 + Tailwind v4 (existing web UI), LMDB (existing session cache)

**Spec:** `docs/superpowers/specs/2026-03-19-skill-tracing-design.md`

---

## Chunk 1: Session Cache — Skill Extraction

### Task 1: Add CachedSkillInvocation type and update SessionCacheData

**Files:**
- Modify: `core/src/session-cache.ts`

- [ ] **Step 1: Add the CachedSkillInvocation interface**

Add after the `CachedPlan` interface (around line 117):

```typescript
export interface CachedSkillInvocation {
  // Identity
  skillName: string;
  pluginName: string;
  shortName: string;
  args?: string;

  // Linkage
  toolUseId: string;
  turnIndex: number;
  lineIndex: number;

  // Loaded content
  instructionsLineIndex?: number;
  instructionsLength?: number;

  // Execution span
  spanStartLine: number;
  spanEndLine?: number;

  // Attribution within span
  toolsCalled: string[];
  toolUseCount: number;
  filesRead: string[];
  filesWritten: string[];

  // Subagent tracking
  subagentIds: string[];

  // Outcome
  success?: boolean;
  timestamp?: string;
}
```

- [ ] **Step 2: Add `skillInvocations` to SessionCacheData**

In the `SessionCacheData` interface, add after `plans: CachedPlan[];`:

```typescript
  // Skill invocations
  skillInvocations: CachedSkillInvocation[];
```

- [ ] **Step 3: Add `skillInvocations: []` to createInitialCache**

In the `getSessionData()` method where the empty cache structure is built (around line 1209), add after `plans: [],`:

```typescript
      skillInvocations: [],
```

- [ ] **Step 4: Add backward compat in mergeNewMessages**

In `mergeNewMessages()`, after the existing backward compat lines (around line 693), add:

```typescript
    if (!updated.skillInvocations) updated.skillInvocations = [];
```

- [ ] **Step 5: Bump CACHE_VERSION**

Change `const CACHE_VERSION = 9;` to `const CACHE_VERSION = 10;`

- [ ] **Step 6: Build and verify**

Run: `cd /home/ubuntu/lm-assist && ./core.sh build`
Expected: Compiles with no errors.

- [ ] **Step 7: Commit**

```bash
git add core/src/session-cache.ts
git commit -m "feat(skill-tracing): add CachedSkillInvocation type and bump cache version"
```

---

### Task 2: Extract skill invocations during JSONL parsing

**Files:**
- Modify: `core/src/session-cache.ts`

- [ ] **Step 1: Add helper function to parse skill names**

Add before the `SessionCache` class:

```typescript
/** Parse a skill name like "lm-unified-trade:fundamental-analysis" or "brainstorming" */
function parseSkillName(raw: string): { skillName: string; pluginName: string; shortName: string } {
  const colonIdx = raw.indexOf(':');
  if (colonIdx > 0) {
    return {
      skillName: raw,
      pluginName: raw.slice(0, colonIdx),
      shortName: raw.slice(colonIdx + 1),
    };
  }
  return { skillName: raw, pluginName: 'unknown', shortName: raw };
}
```

- [ ] **Step 2: Extract Skill tool_use in assistant message block loop**

In `mergeNewMessages()`, in the assistant message content block loop, after the `Agent`/`Task` extraction block (around line 1013), add:

```typescript
              // Extract Skill invocations
              if (block.name === 'Skill' && block.input?.skill) {
                // Close previous skill's span
                const prevSkill = updated.skillInvocations[updated.skillInvocations.length - 1];
                if (prevSkill && prevSkill.spanEndLine === undefined) {
                  prevSkill.spanEndLine = msg.lineIndex - 1;
                }

                const parsed = parseSkillName(block.input.skill);
                updated.skillInvocations.push({
                  ...parsed,
                  args: block.input.args || undefined,
                  toolUseId: block.id,
                  turnIndex,
                  lineIndex: msg.lineIndex,
                  spanStartLine: msg.lineIndex + 1, // Provisional, updated when isMeta arrives
                  toolsCalled: [],
                  toolUseCount: 0,
                  filesRead: [],
                  filesWritten: [],
                  subagentIds: [],
                  timestamp: msg.timestamp,
                });
              }
```

- [ ] **Step 3: Link isMeta instructions to skill invocation**

In the user message processing section (around line 756), after the `classifyUserPrompt` call, add:

```typescript
        // Link isMeta messages to pending skill invocations
        if (msg.isMeta && msg.sourceToolUseID) {
          const pendingSkill = updated.skillInvocations.find(
            s => s.toolUseId === msg.sourceToolUseID && s.instructionsLineIndex === undefined
          );
          if (pendingSkill) {
            pendingSkill.instructionsLineIndex = msg.lineIndex;
            pendingSkill.instructionsLength = text.length;
            pendingSkill.spanStartLine = msg.lineIndex + 1;
          }
        }
```

- [ ] **Step 4: Extract skill success from tool_result**

In the user message tool_result processing section (around line 770 where `tool_result` blocks are iterated), add inside the block loop:

```typescript
            // Check if this tool_result is for a pending Skill invocation
            if (block.tool_use_id) {
              const pendingSkill = updated.skillInvocations.find(
                s => s.toolUseId === block.tool_use_id && s.success === undefined
              );
              if (pendingSkill && msg.toolUseResult?.success !== undefined) {
                pendingSkill.success = msg.toolUseResult.success;
              }
            }
```

- [ ] **Step 5: Close skill spans on real user prompts**

In the user message processing section, after detecting a real user prompt, add:

```typescript
        // Close open skill span on real user prompt
        if (!prompt.promptType || prompt.promptType === 'user') {
          const lastSkill = updated.skillInvocations[updated.skillInvocations.length - 1];
          if (lastSkill && lastSkill.spanEndLine === undefined) {
            lastSkill.spanEndLine = msg.lineIndex - 1;
          }
        }
```

- [ ] **Step 6: Build and verify**

Run: `cd /home/ubuntu/lm-assist && ./core.sh build`
Expected: Compiles with no errors.

- [ ] **Step 7: Commit**

```bash
git add core/src/session-cache.ts
git commit -m "feat(skill-tracing): extract skill invocations from JSONL in mergeNewMessages"
```

---

### Task 3: Span attribution — second pass

**Files:**
- Modify: `core/src/session-cache.ts`

- [ ] **Step 1: Add span attribution function**

Add before the `SessionCache` class:

```typescript
/**
 * Second pass: attribute tool uses, files, and subagents to skill invocation spans.
 * Called after all messages are parsed.
 */
function attributeSkillSpans(data: SessionCacheData): void {
  for (const skill of data.skillInvocations) {
    const start = skill.spanStartLine;
    const end = skill.spanEndLine;

    // Degenerate span (back-to-back skills)
    if (end !== undefined && end < start) {
      skill.toolsCalled = [];
      skill.toolUseCount = 0;
      skill.filesRead = [];
      skill.filesWritten = [];
      skill.subagentIds = [];
      continue;
    }

    const toolNames = new Set<string>();
    let toolCount = 0;
    const reads = new Set<string>();
    const writes = new Set<string>();
    const agents: string[] = [];

    // Attribute tool uses within span
    for (const tu of data.toolUses) {
      if (tu.lineIndex >= start && (end === undefined || tu.lineIndex <= end)) {
        // Skip the Skill tool_use itself
        if (tu.name === 'Skill') continue;
        toolNames.add(tu.name);
        toolCount++;

        // Extract file paths
        const filePath = tu.input?.file_path || tu.input?.path;
        if (filePath && typeof filePath === 'string') {
          if (tu.name === 'Read' || tu.name === 'Glob' || tu.name === 'Grep') {
            reads.add(filePath);
          } else if (tu.name === 'Write' || tu.name === 'Edit') {
            writes.add(filePath);
          }
        }
      }
    }

    // Attribute subagents within span
    for (const sa of data.subagents) {
      if (sa.lineIndex >= start && (end === undefined || sa.lineIndex <= end)) {
        if (sa.agentId) {
          agents.push(sa.agentId);
        }
      }
    }

    skill.toolsCalled = Array.from(toolNames);
    skill.toolUseCount = toolCount;
    skill.filesRead = Array.from(reads);
    skill.filesWritten = Array.from(writes);
    skill.subagentIds = agents;
  }
}
```

- [ ] **Step 2: Call attributeSkillSpans after mergeNewMessages**

In the `getSessionData()` method, after the `return this.mergeNewMessages(cache, messages, stats);` call (around line 1259), change to:

```typescript
    const result = this.mergeNewMessages(cache, messages, stats);
    attributeSkillSpans(result);
    return result;
```

Also in the incremental parse path (where `mergeNewMessages` is called with existing cache), add `attributeSkillSpans(result)` after the merge.

- [ ] **Step 3: Build and verify**

Run: `cd /home/ubuntu/lm-assist && ./core.sh build`
Expected: Compiles with no errors.

- [ ] **Step 4: Verify with real session data**

```bash
./core.sh restart
# Test with a known skill-heavy session from lm-unified-trade
curl -s http://localhost:3200/sessions/<sessionId>?unlimited=true | jq '.data.skillInvocations'
```

Expected: Array of `CachedSkillInvocation` objects with populated `skillName`, `toolsCalled`, `filesRead`, etc.

- [ ] **Step 5: Commit**

```bash
git add core/src/session-cache.ts
git commit -m "feat(skill-tracing): add span attribution second pass for skill invocations"
```

---

## Chunk 2: Skill Index — Cross-Session Analytics

### Task 4: Create SkillIndex class with installed skill scanner

**Files:**
- Create: `core/src/skill-index.ts`

- [ ] **Step 1: Create the SkillIndex module**

Create `core/src/skill-index.ts` with the full implementation:

```typescript
/**
 * Skill Index — Cross-session skill analytics with lazy materialization.
 *
 * Tracks skill invocations across all sessions. Builds itself lazily as
 * sessions are loaded into cache via SessionCache.onSessionChange().
 * Persists to ~/.lm-assist/skills/index.json.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { getDataDir } from './utils/path-utils';
import type { SessionCacheData, CachedSkillInvocation } from './session-cache';

// ─── Types ──────────────────────────────────────────────────

export interface InstalledSkill {
  skillName: string;
  pluginName: string;
  shortName: string;
  description: string;
  pluginVersion: string;
  installPath: string;
  hasUsage: boolean;
}

export interface SkillIndexEntry {
  skillName: string;
  pluginName: string;
  shortName: string;
  totalInvocations: number;
  successCount: number;
  failCount: number;
  lastUsed: string;
  firstUsed: string;
  sessions: Array<{
    sessionId: string;
    project: string;
    timestamp: string;
    success?: boolean;
    toolUseCount: number;
    subagentCount: number;
    isSubagentSession: boolean;
  }>;
}

export interface SkillIndexData {
  version: number;
  lastUpdated: string;
  skills: Record<string, SkillIndexEntry>;
  indexedSessions: Record<string, number>;
}

export interface SkillTrace {
  invocation: CachedSkillInvocation;
  sessionId: string;
  project: string;
  totalToolUses: number;
  totalFilesRead: string[];
  totalFilesWritten: string[];
  totalSubagents: number;
  durationMs?: number;
  children: SkillTrace[];
}

// ─── Constants ──────────────────────────────────────────────

const INDEX_VERSION = 1;
const MAX_SESSIONS_PER_SKILL = 200;
const FLUSH_DEBOUNCE_MS = 1000;

// ─── SkillIndex Class ──────────────────────────────────────

export class SkillIndex {
  private indexPath: string;
  private data: SkillIndexData;
  private installedSkills: InstalledSkill[] = [];
  private dirty = false;
  private flushTimer: NodeJS.Timeout | null = null;
  private initialized = false;

  constructor() {
    const dir = path.join(getDataDir(), 'skills');
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    this.indexPath = path.join(dir, 'index.json');
    this.data = this.loadFromDisk();
    this.scanInstalledSkills();
    this.registerShutdownHooks();
    this.initialized = true;
  }

  // ─── Installed Skills ──────────────────────────────────────

  getInstalledSkills(): InstalledSkill[] {
    return this.installedSkills;
  }

  refreshInventory(): void {
    this.scanInstalledSkills();
  }

  /**
   * Resolve a non-namespaced skill name to its namespaced form.
   * Returns null if no unique match found.
   */
  resolveSkillName(shortName: string): { pluginName: string; skillName: string } | null {
    const matches = this.installedSkills.filter(s => s.shortName === shortName);
    if (matches.length === 1) {
      return { pluginName: matches[0].pluginName, skillName: matches[0].skillName };
    }
    return null;
  }

  // ─── Index Operations ──────────────────────────────────────

  getIndexData(): SkillIndexData {
    return this.data;
  }

  getSkillEntry(skillName: string): SkillIndexEntry | undefined {
    return this.data.skills[skillName];
  }

  getAllEntries(): SkillIndexEntry[] {
    return Object.values(this.data.skills);
  }

  /**
   * Called by SessionCache.onSessionChange() — indexes skill invocations from a session.
   */
  onSessionUpdate(sessionId: string, cacheData: SessionCacheData): void {
    // Skip if already indexed at this file size
    if (this.data.indexedSessions[sessionId] === cacheData.fileSize) return;
    if (!cacheData.skillInvocations || cacheData.skillInvocations.length === 0) {
      this.data.indexedSessions[sessionId] = cacheData.fileSize;
      this.scheduleDiskFlush();
      return;
    }

    const isSubagent = cacheData.filePath.includes('/subagents/');
    const project = cacheData.cwd || '';

    // Remove old entries for this session from all skills
    for (const entry of Object.values(this.data.skills)) {
      entry.sessions = entry.sessions.filter(s => s.sessionId !== sessionId);
    }

    // Add new entries
    for (const skill of cacheData.skillInvocations) {
      const key = skill.skillName;
      if (!this.data.skills[key]) {
        this.data.skills[key] = {
          skillName: skill.skillName,
          pluginName: skill.pluginName,
          shortName: skill.shortName,
          totalInvocations: 0,
          successCount: 0,
          failCount: 0,
          lastUsed: '',
          firstUsed: '',
          sessions: [],
        };
      }

      const entry = this.data.skills[key];
      entry.totalInvocations++;
      if (skill.success === true) entry.successCount++;
      if (skill.success === false) entry.failCount++;

      const ts = skill.timestamp || '';
      if (!entry.firstUsed || ts < entry.firstUsed) entry.firstUsed = ts;
      if (!entry.lastUsed || ts > entry.lastUsed) entry.lastUsed = ts;

      entry.sessions.push({
        sessionId,
        project,
        timestamp: ts,
        success: skill.success,
        toolUseCount: skill.toolUseCount,
        subagentCount: skill.subagentIds.length,
        isSubagentSession: isSubagent,
      });

      // Cap sessions
      if (entry.sessions.length > MAX_SESSIONS_PER_SKILL) {
        entry.sessions.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
        entry.sessions = entry.sessions.slice(0, MAX_SESSIONS_PER_SKILL);
      }
    }

    this.data.indexedSessions[sessionId] = cacheData.fileSize;
    this.data.lastUpdated = new Date().toISOString();
    this.scheduleDiskFlush();
  }

  /**
   * Force full reindex — clears and rebuilds from all cached sessions.
   */
  async reindex(getSessionData: (sessionPath: string) => SessionCacheData | null, sessionPaths: string[]): Promise<{ indexed: number; skills: number }> {
    // Reset
    this.data.skills = {};
    this.data.indexedSessions = {};

    let indexed = 0;
    for (const sp of sessionPaths) {
      const cacheData = getSessionData(sp);
      if (cacheData && cacheData.skillInvocations?.length > 0) {
        this.onSessionUpdate(cacheData.sessionId, cacheData);
        indexed++;
      }
    }

    this.flushToDisk();
    return { indexed, skills: Object.keys(this.data.skills).length };
  }

  // ─── Chain Detection ──────────────────────────────────────

  detectChains(): Array<{ sequence: string[]; occurrences: number; projects: string[] }> {
    const chainCounts = new Map<string, { count: number; projects: Set<string> }>();

    // Group skill invocations by session
    const sessionSkills = new Map<string, Array<{ shortName: string; project: string }>>();
    for (const entry of Object.values(this.data.skills)) {
      for (const sess of entry.sessions) {
        if (!sessionSkills.has(sess.sessionId)) {
          sessionSkills.set(sess.sessionId, []);
        }
        sessionSkills.get(sess.sessionId)!.push({
          shortName: entry.shortName,
          project: sess.project,
        });
      }
    }

    // For each session with 2+ skills, generate sliding windows
    for (const [_sessionId, skills] of sessionSkills) {
      if (skills.length < 2) continue;
      const names = skills.map(s => s.shortName);
      const project = skills[0]?.project || '';

      for (let windowLen = 2; windowLen <= Math.min(4, names.length); windowLen++) {
        for (let i = 0; i <= names.length - windowLen; i++) {
          const window = names.slice(i, i + windowLen);
          const key = window.join(' → ');
          if (!chainCounts.has(key)) {
            chainCounts.set(key, { count: 0, projects: new Set() });
          }
          const entry = chainCounts.get(key)!;
          entry.count++;
          entry.projects.add(project);
        }
      }
    }

    // Filter and sort
    return Array.from(chainCounts.entries())
      .filter(([_, v]) => v.count >= 2)
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 20)
      .map(([key, v]) => ({
        sequence: key.split(' → '),
        occurrences: v.count,
        projects: Array.from(v.projects),
      }));
  }

  // ─── Deep Trace Resolution ──────────────────────────────────

  async resolveTrace(
    sessionId: string,
    skill: CachedSkillInvocation,
    project: string,
    getSessionData: (sessionPath: string) => Promise<SessionCacheData | null>,
    findSubagentPath: (agentId: string) => string | null,
    depth = 0,
    maxDepth = 5
  ): Promise<SkillTrace> {
    const trace: SkillTrace = {
      invocation: skill,
      sessionId,
      project,
      totalToolUses: skill.toolUseCount,
      totalFilesRead: [...skill.filesRead],
      totalFilesWritten: [...skill.filesWritten],
      totalSubagents: skill.subagentIds.length,
      children: [],
    };

    if (depth >= maxDepth) return trace;

    // Resolve each subagent
    for (const agentId of skill.subagentIds) {
      const subPath = findSubagentPath(agentId);
      if (!subPath) continue;

      const subData = await getSessionData(subPath);
      if (!subData) continue;

      if (subData.skillInvocations?.length > 0) {
        for (const childSkill of subData.skillInvocations) {
          const childTrace = await this.resolveTrace(
            subData.sessionId,
            childSkill,
            project,
            getSessionData,
            findSubagentPath,
            depth + 1,
            maxDepth
          );
          trace.children.push(childTrace);
          trace.totalToolUses += childTrace.totalToolUses;
          trace.totalFilesRead.push(...childTrace.totalFilesRead);
          trace.totalFilesWritten.push(...childTrace.totalFilesWritten);
          trace.totalSubagents += childTrace.totalSubagents;
        }
      } else {
        // No skills in subagent — attribute all tool uses to parent
        trace.totalToolUses += subData.toolUses?.length || 0;
      }
    }

    // Deduplicate file lists
    trace.totalFilesRead = [...new Set(trace.totalFilesRead)];
    trace.totalFilesWritten = [...new Set(trace.totalFilesWritten)];

    return trace;
  }

  // ─── Private ──────────────────────────────────────────────

  private loadFromDisk(): SkillIndexData {
    try {
      if (fs.existsSync(this.indexPath)) {
        const raw = fs.readFileSync(this.indexPath, 'utf-8');
        const parsed = JSON.parse(raw) as SkillIndexData;
        if (parsed.version === INDEX_VERSION) return parsed;
      }
    } catch {
      // Corrupt file — start fresh
    }
    return {
      version: INDEX_VERSION,
      lastUpdated: new Date().toISOString(),
      skills: {},
      indexedSessions: {},
    };
  }

  private flushToDisk(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    try {
      fs.writeFileSync(this.indexPath, JSON.stringify(this.data, null, 2));
      this.dirty = false;
    } catch (err) {
      console.error('[SkillIndex] Failed to flush to disk:', err);
    }
  }

  private scheduleDiskFlush(): void {
    this.dirty = true;
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      if (this.dirty) this.flushToDisk();
    }, FLUSH_DEBOUNCE_MS);
  }

  private registerShutdownHooks(): void {
    const flush = () => {
      if (this.dirty) this.flushToDisk();
    };
    process.on('SIGTERM', flush);
    process.on('SIGINT', flush);
  }

  private scanInstalledSkills(): void {
    this.installedSkills = [];
    const pluginsFile = path.join(os.homedir(), '.claude', 'plugins', 'installed_plugins.json');

    try {
      if (!fs.existsSync(pluginsFile)) return;
      const raw = JSON.parse(fs.readFileSync(pluginsFile, 'utf-8'));
      const plugins = raw.plugins || {};

      for (const [key, entries] of Object.entries(plugins) as [string, any[]][]) {
        const pluginName = key.split('@')[0];
        if (!Array.isArray(entries) || entries.length === 0) continue;

        const entry = entries[0]; // Use first (typically only) entry
        const installPath = entry.installPath;
        const version = entry.version || '';

        if (!installPath || !fs.existsSync(installPath)) continue;

        const skillsDir = path.join(installPath, 'skills');
        if (!fs.existsSync(skillsDir)) continue;

        const skillDirs = fs.readdirSync(skillsDir, { withFileTypes: true })
          .filter(d => d.isDirectory())
          .map(d => d.name);

        for (const skillDir of skillDirs) {
          const skillPath = path.join(skillsDir, skillDir, 'SKILL.md');
          if (!fs.existsSync(skillPath)) continue;

          const { name, description } = this.parseFrontmatter(skillPath, skillDir);
          const shortName = name || skillDir;
          const fullName = `${pluginName}:${shortName}`;

          this.installedSkills.push({
            skillName: fullName,
            pluginName,
            shortName,
            description: description.slice(0, 200),
            pluginVersion: version,
            installPath: path.join(skillsDir, skillDir),
            hasUsage: !!this.data.skills[fullName],
          });
        }
      }
    } catch (err) {
      console.error('[SkillIndex] Failed to scan installed skills:', err);
    }
  }

  private parseFrontmatter(filePath: string, fallbackName: string): { name: string; description: string } {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
      if (!match) return { name: fallbackName, description: '' };

      const fm = match[1];
      const nameMatch = fm.match(/^name:\s*(.+)/m);
      const descMatch = fm.match(/^description:\s*["']?([\s\S]*?)["']?\s*$/m);

      return {
        name: nameMatch ? nameMatch[1].trim() : fallbackName,
        description: descMatch ? descMatch[1].trim() : '',
      };
    } catch {
      return { name: fallbackName, description: '' };
    }
  }
}

// ─── Singleton ──────────────────────────────────────────────

let _instance: SkillIndex | null = null;

export function getSkillIndex(): SkillIndex {
  if (!_instance) {
    _instance = new SkillIndex();

    // Wire up SessionCache callback (lazy import to avoid circular deps)
    try {
      const { getSessionCache } = require('./session-cache');
      const cache = getSessionCache();
      cache.onSessionChange((sessionId: string, cacheData: SessionCacheData) => {
        _instance!.onSessionUpdate(sessionId, cacheData);
      });
    } catch {
      // SessionCache not ready yet — index will populate on first access
    }
  }
  return _instance;
}
```

- [ ] **Step 2: Build and verify**

Run: `cd /home/ubuntu/lm-assist && ./core.sh build`
Expected: Compiles with no errors.

- [ ] **Step 3: Commit**

```bash
git add core/src/skill-index.ts
git commit -m "feat(skill-tracing): add SkillIndex with installed skill scanner, chain detection, and deep trace"
```

---

## Chunk 3: API Endpoints

### Task 5: Create skills routes

**Files:**
- Create: `core/src/routes/core/skills.routes.ts`
- Modify: `core/src/routes/core/index.ts`

- [ ] **Step 1: Create skills.routes.ts**

Create `core/src/routes/core/skills.routes.ts`:

```typescript
/**
 * Skills Routes
 *
 * REST API for skill inventory, analytics, per-session traces, and index management.
 *
 * Endpoints:
 *   GET    /skills                              # List installed skills with usage stats
 *   GET    /skills/analytics                    # Aggregated analytics
 *   GET    /skills/analytics/chains             # Common skill chain patterns
 *   GET    /skills/detail/:skillName            # Detail for one skill
 *   GET    /sessions/:id/skills                 # Skill invocations in a session
 *   GET    /sessions/:id/skills/:index/trace    # Deep trace for Nth skill
 *   POST   /skills/reindex                      # Force rebuild skill index
 *   POST   /skills/refresh-inventory            # Rescan plugin cache
 */

import type { RouteHandler, RouteContext } from '../index';
import { getSkillIndex } from '../../skill-index';
import { getSessionCache } from '../../session-cache';

export function createSkillRoutes(_ctx: RouteContext): RouteHandler[] {
  return [
    // GET /skills — List all installed skills with usage stats
    {
      method: 'GET',
      pattern: /^\/skills$/,
      handler: async () => {
        const start = Date.now();
        const index = getSkillIndex();
        const installed = index.getInstalledSkills();
        const entries = index.getAllEntries();

        const enriched = installed.map(skill => {
          const entry = entries.find(e => e.skillName === skill.skillName);
          const totalInvocations = entry?.totalInvocations || 0;
          const directInvocations = entry
            ? entry.sessions.filter(s => !s.isSubagentSession).length
            : 0;
          const successRate = totalInvocations > 0
            ? (entry!.successCount / totalInvocations)
            : 0;

          return {
            skillName: skill.skillName,
            pluginName: skill.pluginName,
            shortName: skill.shortName,
            description: skill.description,
            pluginVersion: skill.pluginVersion,
            totalInvocations,
            directInvocations,
            successRate: Math.round(successRate * 100) / 100,
            lastUsed: entry?.lastUsed || null,
          };
        });

        // Also include skills with usage but not installed (removed plugins)
        for (const entry of entries) {
          if (!installed.find(s => s.skillName === entry.skillName)) {
            enriched.push({
              skillName: entry.skillName,
              pluginName: entry.pluginName,
              shortName: entry.shortName,
              description: '',
              pluginVersion: '',
              totalInvocations: entry.totalInvocations,
              directInvocations: entry.sessions.filter(s => !s.isSubagentSession).length,
              successRate: entry.totalInvocations > 0
                ? Math.round((entry.successCount / entry.totalInvocations) * 100) / 100
                : 0,
              lastUsed: entry.lastUsed || null,
            });
          }
        }

        // Sort by totalInvocations descending
        enriched.sort((a, b) => b.totalInvocations - a.totalInvocations);

        return {
          success: true,
          data: {
            installed: enriched,
            totalSkills: enriched.length,
            totalInvocations: entries.reduce((sum, e) => sum + e.totalInvocations, 0),
          },
          meta: { durationMs: Date.now() - start },
        };
      },
    },

    // GET /skills/analytics — Aggregated analytics
    {
      method: 'GET',
      pattern: /^\/skills\/analytics$/,
      handler: async () => {
        const start = Date.now();
        const index = getSkillIndex();
        const entries = index.getAllEntries();

        const topSkills = [...entries]
          .sort((a, b) => b.totalInvocations - a.totalInvocations)
          .slice(0, 10)
          .map(e => ({
            skillName: e.skillName,
            totalInvocations: e.totalInvocations,
            directInvocations: e.sessions.filter(s => !s.isSubagentSession).length,
            successRate: e.totalInvocations > 0
              ? Math.round((e.successCount / e.totalInvocations) * 100) / 100
              : 0,
          }));

        // Group by plugin
        const byPlugin: Record<string, number> = {};
        for (const e of entries) {
          byPlugin[e.pluginName] = (byPlugin[e.pluginName] || 0) + e.totalInvocations;
        }

        const totalInvocations = entries.reduce((sum, e) => sum + e.totalInvocations, 0);
        const totalSuccess = entries.reduce((sum, e) => sum + e.successCount, 0);
        const totalFail = entries.reduce((sum, e) => sum + e.failCount, 0);

        return {
          success: true,
          data: {
            topSkills,
            byPlugin,
            totalInvocations,
            totalSuccess,
            totalFail,
            overallSuccessRate: totalInvocations > 0
              ? Math.round((totalSuccess / totalInvocations) * 100) / 100
              : 0,
          },
          meta: { durationMs: Date.now() - start },
        };
      },
    },

    // GET /skills/analytics/chains — Common skill chain patterns
    {
      method: 'GET',
      pattern: /^\/skills\/analytics\/chains$/,
      handler: async () => {
        const start = Date.now();
        const index = getSkillIndex();
        const chains = index.detectChains();

        return {
          success: true,
          data: { chains },
          meta: { durationMs: Date.now() - start },
        };
      },
    },

    // GET /skills/detail/:skillName — Detail for one skill
    {
      method: 'GET',
      pattern: /^\/skills\/detail\/(.+)$/,
      handler: async (req) => {
        const start = Date.now();
        const skillName = decodeURIComponent(req.params[0]);
        const index = getSkillIndex();
        const entry = index.getSkillEntry(skillName);
        const installed = index.getInstalledSkills().find(s => s.skillName === skillName);

        if (!entry && !installed) {
          return { success: false, error: { code: 'NOT_FOUND', message: `Skill not found: ${skillName}` } };
        }

        // Pagination
        const limit = parseInt(req.query?.limit || '50', 10);
        const offset = parseInt(req.query?.offset || '0', 10);
        const sessions = entry?.sessions
          .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
          .slice(offset, offset + limit) || [];

        return {
          success: true,
          data: {
            skillName,
            pluginName: installed?.pluginName || entry?.pluginName || 'unknown',
            shortName: installed?.shortName || entry?.shortName || skillName,
            description: installed?.description || '',
            pluginVersion: installed?.pluginVersion || '',
            totalInvocations: entry?.totalInvocations || 0,
            directInvocations: entry ? entry.sessions.filter(s => !s.isSubagentSession).length : 0,
            successCount: entry?.successCount || 0,
            failCount: entry?.failCount || 0,
            lastUsed: entry?.lastUsed || null,
            firstUsed: entry?.firstUsed || null,
            sessions,
            totalSessions: entry?.sessions.length || 0,
          },
          meta: { durationMs: Date.now() - start },
        };
      },
    },

    // GET /sessions/:id/skills — Skill invocations in a session
    {
      method: 'GET',
      pattern: /^\/sessions\/([^/]+)\/skills$/,
      handler: async (req) => {
        const start = Date.now();
        const sessionId = req.params[0];
        const cache = getSessionCache();
        const sessionData = await cache.getSessionDataById(sessionId);

        if (!sessionData) {
          return { success: false, error: { code: 'NOT_FOUND', message: `Session not found: ${sessionId}` } };
        }

        return {
          success: true,
          data: {
            sessionId,
            skillInvocations: sessionData.skillInvocations || [],
            totalSkills: sessionData.skillInvocations?.length || 0,
          },
          meta: { durationMs: Date.now() - start },
        };
      },
    },

    // GET /sessions/:id/skills/:index/trace — Deep trace for Nth skill
    {
      method: 'GET',
      pattern: /^\/sessions\/([^/]+)\/skills\/(\d+)\/trace$/,
      handler: async (req) => {
        const start = Date.now();
        const sessionId = req.params[0];
        const skillIdx = parseInt(req.params[1], 10);
        const maxDepth = parseInt(req.query?.maxDepth || '5', 10);

        const cache = getSessionCache();
        const sessionData = await cache.getSessionDataById(sessionId);

        if (!sessionData) {
          return { success: false, error: { code: 'NOT_FOUND', message: `Session not found: ${sessionId}` } };
        }

        const skills = sessionData.skillInvocations || [];
        if (skillIdx < 0 || skillIdx >= skills.length) {
          return { success: false, error: { code: 'NOT_FOUND', message: `Skill index ${skillIdx} out of range (0-${skills.length - 1})` } };
        }

        const index = getSkillIndex();
        const trace = await index.resolveTrace(
          sessionId,
          skills[skillIdx],
          sessionData.cwd || '',
          async (sp: string) => cache.getSessionDataById(sp),
          (agentId: string) => {
            // Find subagent session path from CachedSubagent
            const sub = sessionData.subagents?.find(s => s.agentId === agentId);
            return sub ? agentId : null; // getSessionDataById can resolve by agentId
          },
          0,
          maxDepth
        );

        return {
          success: true,
          data: trace,
          meta: { durationMs: Date.now() - start },
        };
      },
    },

    // POST /skills/reindex — Force rebuild
    {
      method: 'POST',
      pattern: /^\/skills\/reindex$/,
      handler: async () => {
        const start = Date.now();
        const index = getSkillIndex();
        const cache = getSessionCache();

        // Get all cached session paths
        const allSessions = cache.getAllCachedPaths ? cache.getAllCachedPaths() : [];
        const result = await index.reindex(
          (sp: string) => cache.getSessionDataFromMemory(sp),
          allSessions
        );

        return {
          success: true,
          data: result,
          meta: { durationMs: Date.now() - start },
        };
      },
    },

    // POST /skills/refresh-inventory — Rescan plugin cache
    {
      method: 'POST',
      pattern: /^\/skills\/refresh-inventory$/,
      handler: async () => {
        const start = Date.now();
        const index = getSkillIndex();
        index.refreshInventory();

        return {
          success: true,
          data: {
            installedSkills: index.getInstalledSkills().length,
          },
          meta: { durationMs: Date.now() - start },
        };
      },
    },
  ];
}
```

- [ ] **Step 2: Register routes in index.ts**

In `core/src/routes/core/index.ts`, add the import:

```typescript
import { createSkillRoutes } from './skills.routes';
```

And add to the `createCoreRoutes` array:

```typescript
    ...createSkillRoutes(ctx),
```

- [ ] **Step 3: Build and verify**

Run: `cd /home/ubuntu/lm-assist && ./core.sh build`
Expected: Compiles with no errors.

- [ ] **Step 4: Test endpoints**

```bash
./core.sh restart
# Test skill listing
curl -s http://localhost:3200/skills | jq '.data.totalSkills'
# Test analytics
curl -s http://localhost:3200/skills/analytics | jq '.data.topSkills'
# Test chains
curl -s http://localhost:3200/skills/analytics/chains | jq '.data.chains'
# Test refresh
curl -s -X POST http://localhost:3200/skills/refresh-inventory | jq
# Test reindex
curl -s -X POST http://localhost:3200/skills/reindex | jq
```

- [ ] **Step 5: Commit**

```bash
git add core/src/routes/core/skills.routes.ts core/src/routes/core/index.ts
git commit -m "feat(skill-tracing): add 8 REST endpoints for skill inventory, analytics, and traces"
```

---

## Chunk 4: Web UI — Skills Page

### Task 6: Create Skills dashboard page

**Files:**
- Create: `web/src/app/(dashboard)/skills/page.tsx`
- Create: `web/src/components/skills/SkillList.tsx`
- Create: `web/src/components/skills/SkillDetail.tsx`
- Create: `web/src/components/skills/SkillAnalytics.tsx`
- Modify: `web/src/components/layout/Sidebar.tsx`

- [ ] **Step 1: Add Skills to sidebar navigation**

In `web/src/components/layout/Sidebar.tsx`, in the `baseNavItems` array, add after the Knowledge entry:

```typescript
  { name: 'Skills', href: '/skills', icon: '⚡' },
```

Use whatever icon pattern the existing nav items use (check the file for the actual icon system — could be Heroicons, Lucide, or emoji).

- [ ] **Step 2: Create SkillList component**

Create `web/src/components/skills/SkillList.tsx`:

This is the left panel showing all installed skills grouped by plugin. It should:
- Fetch from `GET /skills`
- Group skills by `pluginName`
- Show collapsible sections per plugin
- Each skill row: `shortName`, invocation count badge, last used relative time
- Skills with zero usage get dimmed styling (`opacity-50`)
- Search/filter input at top
- `onClick` callback to select a skill
- Highlight selected skill

- [ ] **Step 3: Create SkillDetail component**

Create `web/src/components/skills/SkillDetail.tsx`:

This is the center panel showing detail for a selected skill. It should:
- Receive `skillName` as prop
- Fetch from `GET /skills/detail/:skillName`
- Show: description, totalInvocations, directInvocations, successRate, firstUsed, lastUsed
- Session list table: timestamp, project (basename only), success badge, tool count, subagent count
- Each session row clickable → navigates to `/sessions?id=<sessionId>`
- Pagination controls using `limit`/`offset` query params
- Empty state: "Select a skill from the list"

- [ ] **Step 4: Create SkillAnalytics component**

Create `web/src/components/skills/SkillAnalytics.tsx`:

This is the right panel showing analytics summary. It should:
- Fetch from `GET /skills/analytics` and `GET /skills/analytics/chains`
- Top 10 skills: name + bar chart (horizontal, proportional to invocation count)
- Chain patterns: show each chain as a flow of pills connected by arrows (`→`)
- Success/failure rate: simple percentage with green/red color
- By plugin breakdown: list with counts

- [ ] **Step 5: Create Skills page**

Create `web/src/app/(dashboard)/skills/page.tsx`:

```tsx
'use client';

import { SkillList } from '@/components/skills/SkillList';
import { SkillDetail } from '@/components/skills/SkillDetail';
import { SkillAnalytics } from '@/components/skills/SkillAnalytics';
import { useState } from 'react';

export default function SkillsPage() {
  const [selectedSkill, setSelectedSkill] = useState<string | null>(null);

  return (
    <div className="flex h-full gap-4 p-4">
      {/* Left panel — Skill inventory list */}
      <div className="w-64 shrink-0 overflow-y-auto">
        <SkillList
          selectedSkill={selectedSkill}
          onSelectSkill={setSelectedSkill}
        />
      </div>

      {/* Center panel — Skill detail */}
      <div className="flex-1 overflow-y-auto">
        <SkillDetail skillName={selectedSkill} />
      </div>

      {/* Right panel — Analytics summary */}
      <div className="w-80 shrink-0 overflow-y-auto">
        <SkillAnalytics />
      </div>
    </div>
  );
}
```

- [ ] **Step 6: Build web and verify**

```bash
cd /home/ubuntu/lm-assist/web && npx next build
```

Expected: Builds with no errors. Navigate to `http://<IP>:3948/skills` to verify the page renders.

- [ ] **Step 7: Commit**

```bash
git add web/src/app/\(dashboard\)/skills/ web/src/components/skills/ web/src/components/layout/Sidebar.tsx
git commit -m "feat(skill-tracing): add Skills dashboard page with inventory, detail, and analytics panels"
```

---

## Chunk 5: Web UI — Session Skills Tab

### Task 7: Add Skills tab to SessionDetail

**Files:**
- Create: `web/src/components/skills/SkillTimeline.tsx`
- Create: `web/src/components/skills/SkillChainFlow.tsx`
- Modify: `web/src/components/sessions/SessionDetail.tsx`

- [ ] **Step 1: Create SkillChainFlow component**

Create `web/src/components/skills/SkillChainFlow.tsx`:

A horizontal flow diagram showing the skill chain. Each skill is a pill/badge connected by arrows. Component should:
- Receive `skillInvocations: CachedSkillInvocation[]` as prop
- Render horizontal flex with skill name pills connected by `→` separators
- Color-code by success (green), failure (red), unknown (gray)
- Compact — fits in a single line, wraps if too many

- [ ] **Step 2: Create SkillTimeline component**

Create `web/src/components/skills/SkillTimeline.tsx`:

A vertical timeline of skill invocations within a session. Component should:
- Receive `sessionId: string` as prop
- Fetch from `GET /sessions/:id/skills`
- Show `SkillChainFlow` at the top if 2+ skills
- Vertical timeline: each node is a skill invocation card showing:
  - Skill name (bold) + args (dimmed)
  - Span: `lines ${spanStartLine}-${spanEndLine}`
  - Tool count badge, files read/written count badges
  - Expandable section (click to toggle): list of `toolsCalled`, `filesRead`, `filesWritten`
  - If `subagentIds.length > 0`: "Subagents: N" badge, clickable to trigger deep trace fetch
- Deep trace: when subagent badge clicked, fetch `GET /sessions/:id/skills/:index/trace` and show nested children inline

- [ ] **Step 3: Add Skills tab to SessionDetail**

In `web/src/components/sessions/SessionDetail.tsx`, add the Skills tab:
- Add `'skills'` to the `TabId` type
- Add the tab button in the tab bar
- Render `<SkillTimeline sessionId={sessionId} />` when the skills tab is active
- Only show the tab if the session has skill invocations (check `sessionData.skillInvocations?.length > 0`)

- [ ] **Step 4: Build web and verify**

```bash
cd /home/ubuntu/lm-assist/web && npx next build
```

Expected: Builds with no errors. Navigate to a session that used skills, verify the Skills tab appears and shows the timeline.

- [ ] **Step 5: Commit**

```bash
git add web/src/components/skills/SkillTimeline.tsx web/src/components/skills/SkillChainFlow.tsx web/src/components/sessions/SessionDetail.tsx
git commit -m "feat(skill-tracing): add Skills tab with timeline and chain flow to session detail"
```

---

## Chunk 6: Integration Testing & Polish

### Task 8: End-to-end verification

**Files:** None (testing only)

- [ ] **Step 1: Rebuild everything**

```bash
cd /home/ubuntu/lm-assist && ./core.sh build && ./core.sh restart
```

- [ ] **Step 2: Verify cache version bump reparsed sessions**

```bash
# Clear session cache to force reparse with new CACHE_VERSION
curl -s -X POST http://localhost:3200/session-cache/clear
# Warm cache to trigger skill extraction
curl -s -X POST http://localhost:3200/session-cache/warm
# Check that skill index populated
curl -s http://localhost:3200/skills | jq '.data.totalSkills, .data.totalInvocations'
```

Expected: Non-zero skill count and invocation count.

- [ ] **Step 3: Verify per-session skills for lm-unified-trade**

```bash
# Find a skill-heavy session
curl -s http://localhost:3200/skills/analytics | jq '.data.topSkills[0]'
# Get detail for the top skill
curl -s "http://localhost:3200/skills/detail/$(curl -s http://localhost:3200/skills | jq -r '.data.installed[0].skillName' | python3 -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.stdin.read().strip()))')" | jq '.data.totalInvocations, .data.sessions[0]'
```

- [ ] **Step 4: Verify deep trace**

```bash
# Pick a session with skills
SESSION_ID=$(curl -s http://localhost:3200/skills | jq -r '.data.installed[0].skillName' | xargs -I{} curl -s "http://localhost:3200/skills/detail/{}" | jq -r '.data.sessions[0].sessionId')
# Get skills for that session
curl -s "http://localhost:3200/sessions/$SESSION_ID/skills" | jq '.data.skillInvocations | length'
# Get deep trace for first skill
curl -s "http://localhost:3200/sessions/$SESSION_ID/skills/0/trace" | jq '.data.totalToolUses, .data.children | length'
```

- [ ] **Step 5: Verify chain detection**

```bash
curl -s http://localhost:3200/skills/analytics/chains | jq '.data.chains[:3]'
```

Expected: Array of chain objects with `sequence`, `occurrences`, `projects`.

- [ ] **Step 6: Verify web UI**

Build web: `cd /home/ubuntu/lm-assist/web && npx next build`
Navigate to `http://<IP>:3948/skills` — verify three-panel layout loads.
Navigate to a session detail — verify Skills tab appears for skill-using sessions.

- [ ] **Step 7: Final commit (if any fixes)**

```bash
git add -A
git commit -m "fix(skill-tracing): integration fixes from end-to-end testing"
```
