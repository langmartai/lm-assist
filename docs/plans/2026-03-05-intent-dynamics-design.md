# Intent Dynamics System — Architecture Design

## Paper: "Large Language Models as Self-Reflective Intent Dynamics Systems"

Target venue: NeurIPS / ICLR

---

## 1. Core Thesis

LLMs can serve as fully language-driven intent inference engines. Instead of treating the LLM as just a response generator, we use it as a structured perception module that:

1. Generates goal hypotheses
2. Estimates posterior over goals
3. Produces intent vectors
4. Analyzes its own dynamics (self-reflective)

The LLM is **stateless per call**. An external system acts as a **dumb log** — storing structured outputs and feeding them back on each turn. The LLM performs all inference and dynamics reasoning.

---

## 2. Architecture

### 2.1 Two Components

```
LLM (Inference Engine)           External System (Storage Only)
- Goal hypothesis generation     - Append structured output to log
- Posterior estimation           - Feed history back to LLM
- Intent vectorization           - Execute actions LLM decides
- Dynamics analysis              - Persist goal store
- Evidence extraction
- Status inference
```

The LLM does perception AND control. The external system is just a JSON log + action router.

### 2.2 Five-Step Pipeline (Per Turn)

| Step | Input | Output | Who |
|------|-------|--------|-----|
| 1. Dialogue Summary | Full dialogue S_t | Compressed trajectory summary | LLM |
| 2. Goal Hypothesis | Summary + S_t + project context | Hierarchical goal set | LLM |
| 3. Posterior Estimation | Goals + S_t | P(G\|S) per goal | LLM |
| 4. Intent Vectorization | Summary + Goals + Posterior | Pseudo-latent intent vector | LLM |
| 5. Dynamics Analysis | Current output + history of prior outputs | Convergence, phase, action decision | LLM |

All five steps produce structured JSON output consumed by the storage layer.

---

## 3. Goal Model

### 3.1 Goals as Independent DAG Entities

Goals are NOT points on a trajectory. They are **independent entities with their own lifecycle**, forming a Directed Acyclic Graph (DAG) through dependencies.

```
Goal {
  id:           string          // Unique identifier
  description:  string          // What the goal is
  status:       GoalStatus      // Current lifecycle state
  confidence:   number (0-1)    // How sure we are about the status
  evidence:     Evidence[]      // All evidence supporting this goal
  depends_on:   GoalId[]        // Goals this one is blocked by
  blocks:       GoalId[]        // Goals waiting on this one
  parent:       GoalId | null   // Hierarchical parent (for rollup)
  children:     GoalId[]        // Hierarchical children
  project:      string          // Project scope
  sessions:     string[]        // Sessions this goal spans
  spawned_from: GoalId | null   // Lineage — what goal this split from
  validation:   Validation      // How to externally validate
}

GoalStatus = "pending" | "in_progress" | "resolved" | "cancelled"
           | "blocked" | "failed" | "uncertain"

Validation {
  method:   "conversation" | "external" | "none"
  command:  string | null       // e.g., "npm test -- --grep 'BM25'"
  result:   "pass" | "fail" | null
}
```

### 3.2 Context-Adaptive Goal Depth

Goal hierarchy depth is NOT hardcoded. The LLM self-calibrates based on project complexity:

- **Small project** (single file, few features): 1-2 levels of broad goals
- **Large project** (monorepo, many modules): Deep hierarchy mirroring project structure

The LLM receives project context (file tree, module list, codebase scale) and infers the right granularity. Leaf goals must be actionable. Parent goals summarize children.

Depth **emerges from dialogue richness**:
- Early conversation: only high-level goals (not enough info for specifics)
- Deep in task: full hierarchy populated

### 3.3 Multi-Lens Domain Categorization

Goals roll up through **domain-specific lenses** that the LLM discovers based on context. Not limited to software engineering.

Examples:
- Research lens: Theory / Experiment / Writing
- Engineering lens: Feature / Bug / Refactor
- PM lens: Critical Path / Parallel / Blocked
- Business lens: Strategy / Operations / Growth

The LLM observes the goal set and proposes relevant categorization frameworks from any applicable discipline. A single goal can appear in multiple categories across different lenses.

### 3.4 Self-Aggregation

Child goal posteriors aggregate into parent posteriors. When children shift, parents update. When new children emerge, parents re-evaluate. The tree **self-prunes** — irrelevant branches fade, the active branch deepens.

---

## 4. Evidence Model

### 4.1 Evidence as First-Class Entity

Every claim about a goal must be backed by traceable evidence. One goal has **many evidence entries**.

```
Evidence {
  // Precise location
  project:    string        // Project path
  session:    string        // Session ID
  turnIndex:  number        // Turn number in conversation
  lineIndex:  number        // Line number in session JSONL

  // What happened
  type:       EvidenceType
  actor:      "llm" | "user"
  summary:    string        // Brief description
  quote:      string        // Actual text from conversation
  confidence: number (0-1)  // Strength of this evidence
  timestamp:  string        // ISO timestamp
}
```

### 4.2 Evidence Types

**Creation:**
- `goal_created` — user or LLM introduces a goal
- `goal_split` — one goal broken into sub-goals
- `goal_merged` — multiple goals combined

**Progress:**
- `progress` — work happening toward goal
- `blocker_found` — something blocking progress
- `blocker_resolved` — blocker removed

**Resolution:**
- `claim_done` — LLM says it's done
- `user_confirm` — user explicitly confirms
- `user_silent` — user doesn't dispute (weak confirmation)
- `external_pass` — test/validation passes

**Negative:**
- `user_dispute` — user says it's not done
- `external_fail` — test/validation fails
- `user_cancel` — user abandons goal
- `context_shift` — conversation moved away

**Cross-reference:**
- `related_mention` — goal referenced in another context
- `dependency_link` — evidence of goal dependency

### 4.3 Status Inference From Evidence

Goal status is NOT set by a single event. It is inferred from the **full evidence chain**:

- `claim_done` + `user_silent` → resolved (confidence: 0.7)
- `claim_done` + `user_dispute` + `claim_done` + `user_silent` → resolved (confidence: 0.6, lower because of dispute history)
- `claim_done` + `user_confirm` → resolved (confidence: 0.95)
- `claim_done` + `external_pass` → resolved (confidence: 0.99)
- Cross-session confirmation strengthens confidence over time

The evidence trail is the **ground truth**. Goals and statuses are summaries derived from evidence. To re-evaluate any goal, replay its evidence chain.

---

## 5. Multi-Scale Dynamics

### 5.1 Three Scales

| Scale | Unit | Rate | Input | Output |
|-------|------|------|-------|--------|
| Intra-session | Per turn | Every message | Turns (user/assistant) | Turn-level goal updates + evidence |
| Cross-session | Per session | Every session | Session intent summaries | Project-level themes + trajectory |
| Cross-project | Per project | On demand | Project intents + relationships | Strategic direction + priorities |

### 5.2 Scale Interaction

Each scale's output feeds the next:

```
Turn evidence → aggregates to → Session goals
Session goals → aggregate to → Project themes
Project themes → aggregate to → Strategic intent
```

### 5.3 Cross-Session Goal Tracking

Goals persist across sessions. A goal created in Session A can accumulate evidence from Sessions B, C, D. The LLM sees all recent session summaries for a project and identifies recurring themes, persistent goals, and chronic issues.

### 5.4 Cross-Project Goal Tracking

Projects may share goals or have dependencies. The LLM sees project-level intents and known project relationships, identifying strategic-level goals that span the ecosystem.

---

## 6. LLM Structured Output Schema

### 6.1 Per-Turn Output

```json
{
  "summary": "User is working on search scoring, shifted focus from vector to BM25",

  "goals": {
    "hierarchy": [
      {
        "id": "G-001",
        "desc": "Fix BM25 scoring for short queries",
        "p": 0.72,
        "parent": null,
        "children": ["G-001a", "G-001b"]
      },
      {
        "id": "G-001a",
        "desc": "Fix tokenization edge case",
        "p": 0.45,
        "parent": "G-001"
      }
    ],
    "depth_rationale": "Large monorepo with dedicated search/ module, goals specific to component"
  },

  "evidence_entries": [
    {
      "goal_id": "G-001",
      "type": "progress",
      "summary": "LLM identified root cause in BM25 tokenizer",
      "quote": "The issue is in the tokenize() function...",
      "confidence": 0.8,
      "actor": "llm"
    }
  ],

  "goal_status_updates": [
    {
      "goal_id": "G-001a",
      "new_status": "resolved",
      "confidence": 0.7,
      "reasoning": "LLM fixed tokenization, user has not disputed"
    }
  ],

  "dynamics": {
    "convergence": "high — intent stable for 3 turns",
    "entropy_trend": "decreasing",
    "phase": "executing",
    "goal_switches": [],
    "action": "continue_current_goal"
  },

  "intent_vector": [0.23, -0.11, 0.87, 0.02, -0.45]
}
```

### 6.2 Per-Session Summary Output

```json
{
  "session_id": "abc-123",
  "project": "/home/ubuntu/lm-assist",
  "goals_touched": ["G-001", "G-001a", "G-002"],
  "goals_created": ["G-001a"],
  "goals_resolved": ["G-001a"],
  "goals_still_active": ["G-001", "G-002"],
  "session_theme": "Search scoring improvements",
  "evidence_count": 12
}
```

### 6.3 Domain Lens Output

```json
{
  "lenses": [
    {
      "domain": "Software Engineering",
      "framework": "Feature/Bug/Refactor",
      "categories": [
        {"name": "Bug Fix", "goals": ["G-001", "G-001a"], "status_summary": "1 resolved, 1 in-progress"},
        {"name": "Feature", "goals": ["G-002"], "status_summary": "1 pending"}
      ]
    },
    {
      "domain": "Project Management",
      "framework": "Priority/Risk",
      "categories": [
        {"name": "Critical", "goals": ["G-001"]},
        {"name": "Nice-to-have", "goals": ["G-002"]}
      ]
    }
  ],
  "lens_rationale": "Primary software project with active bug triage"
}
```

---

## 7. Theoretical Framework (Paper)

### 7.1 Intent as Posterior Over Goals

```
Intent_t := P(G | S_t)
```

Where S_t = dialogue state at turn t, G = latent goal space.

### 7.2 Hierarchical Goal Space

```
G = G_L0 x G_L1 x G_L2 x ... x G_Lk

where k = depth, determined by project complexity
```

### 7.3 Energy Landscape

```
E(G, S) = -log P(G | S)

Attractor basin = low energy region (high posterior goal)
Goal stabilization = posterior concentration
Ambiguity = flat landscape (high entropy)
```

### 7.4 Intent State Transition

```
Intent_t+1 = F_θ(Intent_t, S_t+1, GoalStore_t)

where F_θ = LLM (fully language-driven)
```

### 7.5 Multi-Scale Dynamics

```
Attractor timescale τ varies by goal depth:
  High-level goals: fast attractor (stabilize quickly)
  Leaf-level goals: dynamic (change per turn)

τ_L0 < τ_L1 < ... < τ_Lk
```

### 7.6 Self-Reflective Property

The LLM reads its own prior structured outputs (goals, posterior, intent vectors) and reasons about dynamics. This is genuine self-reflection — the system observes its own inference history and adjusts.

---

## 8. Data Sources (lm-assist Integration)

| Data | Source | Already Available |
|------|--------|-------------------|
| Session turns | `~/.claude/projects/*/sessions/*.jsonl` | Yes (session-cache.ts) |
| Turn/line index | `turnIndex`, `lineIndex` in CachedToolUse | Yes |
| Project structure | `GET /projects` | Yes |
| Cross-session DAG | session-dag.ts | Yes |
| Knowledge entries | Knowledge pipeline | Yes |
| File operations | CachedToolUse with tool names | Yes |

---

## 9. Paper Structure (Revised)

1. **Introduction** — LLM as inference engine, not just generator
2. **Related Work** — POMDP belief tracking, dialogue state tracking, Theory of Mind in LLMs
3. **Theoretical Framework** — Intent as posterior, energy landscape, hierarchical goal space, multi-scale dynamics
4. **Method** — Five-step pipeline, goal DAG model, evidence tracking, self-reflective dynamics
5. **System Design** — LLM-native architecture, structured output schema, domain-adaptive goal depth
6. **Experiments** — Posterior concentration over turns, attractor detection, goal lifecycle tracking, cross-session persistence
7. **Analysis** — Emergent Bayesian behavior, self-calibrating goal depth, multi-lens categorization
8. **Discussion** — LLM as cognitive state simulator, limitations (calibration, cost, no ground truth)
9. **Future Work** — Diffusion posterior, parametric intent dynamics, external validation integration

---

## 10. Key Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Where is dynamics logic? | In the LLM, not external system | Stronger paper story ("self-reflective"), simpler to build |
| Goal structure | Independent DAG with lifecycle | Goals are entities, not trajectory points; they have status and dependencies |
| Goal depth | LLM self-calibrates from project context | No hardcoded levels; depth = f(project complexity, dialogue specificity) |
| Domain categories | LLM discovers lenses from context | Not limited to software engineering; any domain applies |
| Evidence tracking | Precise pointers (project, session, turn, lineIndex) | Ground truth is evidence, not status; replay chain to re-evaluate |
| Status inference | From full evidence chain | Not single-event; accounts for disputes, silence, cross-session confirmation |
| External system role | Dumb log + action router | LLM does all reasoning; external system just stores and feeds back |
| Message extraction | Summary mode default, detail on demand | 68-73% token savings; LLM decides when full content needed |

---

## 11. Implementation: Three-Pass Pipeline

### 11.1 Pipeline Architecture

```
Pass 1: SESSION SCAN     — per session, chunked, parallel
Pass 2: PROJECT SYNTHESIS — per project, cross-session
Pass 3: LENS ANALYSIS    — per project, on demand
```

All passes use the SDK runner (`sdk-runner.ts`) with single-turn structured JSON output, no tool use, `bypassPermissions`.

### 11.2 Smart Message Extraction

Messages are extracted in two modes to manage token budget:

**Summary Mode (default, for messages > 500 tokens):**
- First 150 tokens (intent/context)
- Last 150 tokens (result/conclusion)
- Middle: split into chunks, first 50 tokens of each chunk
- Result: ~400-500 tokens instead of full content
- Savings: ~70-85% per message

**Detail Mode (on demand):**
- Full message content
- Triggered by LLM when summary is insufficient
- Typical triggers: user plans, significant LLM deliverables, status disputes

**Adaptive selection:** The LLM decides which turns need detail mode based on:
- Goal depth needed (high-level → summary sufficient; precise → detail needed)
- Message type (plans/specs → detail; code output/file listings → summary)
- Evidence precision (status disputes need exact wording)

### 11.3 Two-Phase Session Processing

**Phase A (Quick Scan):** All messages in summary mode. LLM extracts goals + evidence + detail_requests.

**Phase B (Targeted Detail):** Only requested turns in full content + ±2 surrounding turns in summary mode. LLM refines goals and evidence.

Max 2 phases per chunk. Combined with chunking for long sessions.

**Token budget example (200-turn session):**
- Full content: 300K tokens (won't fit)
- Summary mode: 80K tokens (fits in one pass)
- Summary + 10 detail turns: 95K tokens (fits in two passes)

### 11.4 Context Budget Per Pass

| Pass | System Prompt | Project Context | Goal Store | Conversation/Data | Total |
|------|--------------|-----------------|------------|-------------------|-------|
| Pass 1 (session) | ~2K | ~1.5K | ~5K | ~60-70K (summary mode) | ~80K |
| Pass 2 (project) | ~2K | ~3K | ~15-25K | ~5-10K (session summaries) | ~40K |
| Pass 3 (lenses) | ~2K | ~3K | ~10K | ~3K (cross-project) | ~20K |

### 11.5 Directory Structure

```
core/src/intent/
├── pipeline.ts          ← IntentPipeline orchestrator
├── types.ts             ← Goal, Evidence, IntentStore types
├── store.ts             ← GoalStore (LMDB-backed)
├── prompts.ts           ← System prompts for Pass 1/2/3
├── extractor.ts         ← Smart message extraction (summary/detail)
├── passes/
│   ├── session-scan.ts  ← Pass 1: per-session goal extraction
│   ├── project-synth.ts ← Pass 2: cross-session synthesis
│   └── lens-analysis.ts ← Pass 3: domain lens generation
└── helpers.ts           ← Chunking, context building, evidence formatting
```

### 11.6 Goal Store

Storage at `~/.lm-assist/intent/`, using `getDataDir()` from `core/src/utils/path-utils.ts` (resolves to `~/.lm-assist/` by default, overridable via `LM_ASSIST_DATA_DIR` env var).

Follows the existing `~/.lm-assist/` layout alongside `knowledge/`, `session-cache/`, `logs/`, etc.

```
~/.lm-assist/
├── assist-config.json       ← existing
├── knowledge/               ← existing
├── session-cache/           ← existing
├── logs/                    ← existing
├── intent/                  ← NEW
│   ├── config.json          ← intent pipeline settings
│   ├── goals/               ← goal documents (one JSON per goal)
│   │   ├── G-001.json
│   │   ├── G-002.json
│   │   └── ...
│   ├── evidence/            ← evidence entries (per session for fast lookup)
│   │   ├── {sessionId}.json ← all evidence from this session
│   │   └── ...
│   ├── scans/               ← scan tracking (which sessions processed)
│   │   └── scan-log.json
│   ├── lenses/              ← cached lens analysis (per project)
│   │   ├── {projectKey}.json
│   │   └── ...
│   └── index.json           ← goal index (quick lookup: id→file, project→goals)
```

**Intent config** (`~/.lm-assist/intent/config.json`):
```json
{
  "enabled": true,
  "model": "opus",
  "autoScan": true,
  "autoScanTrigger": "session_end",
  "maxDetailRequestsPerChunk": 5,
  "summaryModeThreshold": 500,
  "summaryHeadTokens": 150,
  "summaryTailTokens": 150,
  "summaryChunkPeekTokens": 50,
  "pass2Frequency": "daily",
  "pass3Trigger": "on_demand"
}
```

### 11.7 Batch Processing

1. Discover sessions needing scan (new or updated since last scan)
2. Pass 1: parallel session scans (concurrency: 3)
3. Pass 2: sequential project synthesis
4. Pass 3: lens analysis (on demand)
