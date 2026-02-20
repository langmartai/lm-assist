# Your Claude Sessions Are Gold: Stop Paying Twice for the Same Knowledge

## The Hidden Cost of Starting Fresh

Every time you open a new Claude Code session, the clock resets. Claude knows nothing about your codebase, your architecture decisions, or the bugs you fixed last week. So what happens? It explores. It reads files. It searches. It builds up context from scratch — consuming tens of thousands of tokens just to understand what it already figured out yesterday.

If you have been using Claude Code for any real project, you have probably noticed the pattern:

1. Start a new session
2. Ask Claude to fix a bug or add a feature
3. Watch it spend the first 50-100k tokens reading files, exploring the codebase, and re-discovering patterns it already mapped out in a previous session
4. Finally get to the actual work

This is not a flaw in Claude. It is the nature of stateless sessions. Each one starts with a blank slate. But the knowledge from those sessions — the research, the architectural understanding, the implementation patterns — that knowledge does not have to disappear.

Your session history is an asset. And it is sitting unused on your disk right now.

---

## Where the Knowledge Lives

Claude Code stores every session as a JSONL file under `~/.claude/projects/`. Each line is a message — your prompts, Claude's responses, tool calls, search results, file reads, everything. A single session with deep codebase exploration can easily contain 200k+ tokens of rich contextual information.

Now consider how many sessions you have run across your projects. Dozens? Hundreds? That is a massive corpus of project-specific intelligence:

- **Architecture maps** — Claude explored your codebase structure and documented how components connect
- **Implementation patterns** — How your team handles authentication, error handling, state management
- **Bug analysis** — Root cause investigations that uncovered non-obvious behavior
- **Decision rationale** — Why certain trade-offs were made and alternatives rejected
- **API contracts** — What endpoints exist, what they accept, what they return

All of that knowledge exists in your session history. The question is how to make it available to future sessions without manually curating documentation.

![Session detail view — a single session contains hundreds of messages, tool calls, thinking steps, and structured code changes. This is the raw material for knowledge extraction.](https://raw.githubusercontent.com/langmartai/lm-assist/main/docs/screenshots/session-detail-chat.png)

---

## The Subagent Revolution: Why Opus 4 Sessions Are Perfect for Knowledge Capture

Starting with Claude Opus 4.5 and continuing through Opus 4, Claude Code introduced a powerful capability: **subagent execution**. When you ask Claude to investigate something, it does not just read a few files and guess. It launches specialized subagents — Explore agents, Search agents, Plan agents — that conduct focused research and return structured results.

This matters enormously for knowledge reuse.

When Claude runs an Explore subagent, the result is not a casual response mixed into conversation. It is a **self-contained research document**: a structured analysis with clear headings, findings, and conclusions. These subagent results are the ideal unit of reusable knowledge because they are:

- **Focused** — Each explores a specific question or area
- **Complete** — Contains the full analysis, not just fragments
- **Structured** — Uses headings and sections that can be parsed and indexed
- **High quality** — Opus-level reasoning applied to codebase understanding

An Explore subagent that maps out your authentication flow produces a document that is just as useful six months from now as it was when first created. The codebase structure, the design patterns, the architectural decisions — these do not change with every commit.

This is what makes modern Claude Code sessions uniquely valuable as a knowledge source. The subagent architecture transforms ad-hoc exploration into structured, reusable research artifacts.

![Subagent tree — a single session spawns multiple Explore subagents, each conducting focused research. Notice the structured prompts, tool usage counts, and self-contained results. Each of these completed agents becomes a knowledge entry.](https://raw.githubusercontent.com/langmartai/lm-assist/main/docs/screenshots/agent-tree.png)

---

## The Real Cost: A Concrete Example

Let's walk through a realistic scenario to understand the token and time impact.

**Without knowledge reuse:**

You are working on a Next.js application with a TypeScript backend. You need to add a new API endpoint that follows your existing patterns.

| Step | Token Cost | Time |
|------|-----------|------|
| Claude explores project structure | ~15k tokens | 30s |
| Claude reads existing route files to understand patterns | ~25k tokens | 45s |
| Claude examines middleware, auth, error handling | ~20k tokens | 40s |
| Claude checks type definitions and shared utilities | ~15k tokens | 30s |
| Claude reviews test patterns | ~10k tokens | 20s |
| **Total exploration overhead** | **~85k tokens** | **~3 min** |

Now you ask the same question next week in a new session. Same 85k tokens. Same 3 minutes. And the week after that. And for every team member who asks a similar question.

Over a month of active development, redundant exploration can easily consume **500k-1M+ tokens** per developer. At current API pricing, that adds up.

**With knowledge reuse:**

The first session's exploration gets captured as knowledge. When the next session starts:

| Step | Token Cost | Time |
|------|-----------|------|
| Knowledge injection (architecture, patterns, types) | ~3k tokens | instant |
| Claude reads the injected context | ~0 extra (already in context) | 0s |
| Claude proceeds directly to implementation | 0 exploration overhead | 0s |
| **Total exploration overhead** | **~3k tokens** | **< 1s** |

That is a **95%+ reduction** in exploration tokens and near-zero startup time. The knowledge was already extracted, indexed, and delivered before Claude even begins thinking about your prompt.

---

## The Obvious Alternative: Put It in CLAUDE.md

Before looking at automated solutions, it is worth examining the approach most people try first: writing project knowledge directly into `CLAUDE.md` or `~/.claude/CLAUDE.md`.

Claude Code reads these files at the start of every session. You can document your architecture, patterns, conventions, and decisions there. It works, and it requires no extra tooling.

But there is a cost that is easy to underestimate.

### How CLAUDE.md Affects Token Usage

CLAUDE.md is injected as a system-level instruction on **every single prompt** in a session. Not once per session — every turn. If your CLAUDE.md is 2,000 tokens, and you send 40 prompts in a session, that is 80,000 tokens consumed just re-reading your project instructions. Every prompt pays the full cost.

This creates three problems:

**1. Direct token cost.** CLAUDE.md tokens are input tokens billed on every API call. A 3,000-token CLAUDE.md across 50 prompts per session, across 5 sessions per day, is 750,000 tokens/day — just for the instructions file. That adds up to real money at API pricing.

**2. Earlier context compaction.** Claude Code has a finite context window. The more of it CLAUDE.md consumes, the sooner the conversation history gets compacted. This means Claude loses earlier messages (your prompts, its research, tool results) faster, degrading response quality as sessions get longer.

**3. Scaling ceiling.** A useful CLAUDE.md for a non-trivial project quickly grows to thousands of tokens. But you cannot put everything in there — your auth patterns, your database conventions, your API contracts, your deployment setup, your test patterns. At some point you are choosing what to leave out, and the things you leave out are the things Claude will need to re-discover.

### The Static Knowledge Problem

CLAUDE.md is also manually maintained. When your codebase evolves — new patterns, refactored modules, deprecated approaches — someone has to update the file. In practice, CLAUDE.md drifts from reality. It describes patterns from three months ago. It references files that were renamed. It omits the new authentication flow because nobody remembered to document it.

There is no feedback mechanism. Claude cannot flag that a CLAUDE.md entry is wrong. It just follows outdated instructions and produces subtly incorrect results.

### Comparison: CLAUDE.md vs On-Demand Knowledge Injection

| Dimension | CLAUDE.md | Context Injection (lm-assist) |
|-----------|-----------|-------------------------------|
| **Token cost per prompt** | Full file on every prompt (thousands of tokens) | Only relevant entries per prompt (hundreds of tokens) |
| **Scaling** | Grows linearly; large files crowd out conversation context | Knowledge base grows indefinitely; only relevant subset injected |
| **Maintenance** | Manual — you write and update it | Automatic — extracted from sessions |
| **Relevance** | Everything injected regardless of prompt topic | Semantic search selects only what matches the current prompt |
| **Freshness** | Drifts unless manually updated | Feedback loop flags outdated entries |
| **Context compaction** | Accelerates compaction (large fixed overhead) | Minimal impact (small, targeted injection) |
| **Discovery** | Limited to what you thought to document | Captures knowledge you never planned to write down |
| **Setup effort** | None (built into Claude Code) | Install lm-assist, generate knowledge |

CLAUDE.md is the right choice for **small, stable instructions** — coding style preferences, a few key conventions, project-specific rules. Keep it lean.

For **project knowledge at scale** — architecture understanding, implementation patterns, debugging insights, API contracts — a different approach works better: extract knowledge automatically, search it semantically, and inject only what is relevant to the current prompt.

![Knowledge detail view — a generated knowledge entry in the lm-assist web UI showing structured parts (overview, plugin registration, hook comparison) extracted from a session exploration. This is what automatic extraction produces — no manual writing needed.](https://raw.githubusercontent.com/langmartai/lm-assist/main/docs/screenshots/knowledge-detail-view.png)

![Context injection in Claude Code — when the user types "hook configuration issue", the MCP tools automatically search the knowledge base, find matching entries (K006.11, K011.4, K011.2, K010.1), and inject relevant context before Claude responds. Only the knowledge that matches the prompt is loaded.](https://raw.githubusercontent.com/langmartai/lm-assist/main/docs/screenshots/context-injection-cli.png)

---

## How LM Assist Makes This Work

LM Assist is an open-source tool that turns your Claude Code session history into a live knowledge base — with zero manual curation effort. Here is how the pipeline works:

### Step 1: Automatic Knowledge Extraction

When you generate knowledge through LM Assist (via the web UI or API), it scans your session history for completed Explore-type subagent results. No LLM call is needed for extraction. The tool directly parses the structured output:

- Titles derived from the original exploration prompt
- Content split on `##` headings into discrete, searchable parts
- Classified by type: algorithm, contract, schema, wiring, invariant, or flow

A single exploration session might yield 3-5 knowledge entries, each with multiple parts. Over weeks of development, this builds into a comprehensive knowledge base that covers your entire project.

![Knowledge base — 584 knowledge entries extracted from session history, organized by type (wiring, algorithm, invariant, contract, flow). Each entry is broken into numbered parts with source file locations. Zero manual curation.](https://raw.githubusercontent.com/langmartai/lm-assist/main/docs/screenshots/knowledge-base.png)

### Step 2: Vector Indexing

Each knowledge part gets embedded into a 384-dimensional vector using a local embedding model (all-MiniLM-L6-v2, running entirely on your machine via ONNX). These vectors are stored in LanceDB, an embedded vector database.

The indexing supports hybrid search:
- **Vector similarity** — Find knowledge that is semantically related to a query
- **Full-text search** — Find knowledge by keyword matching
- **Reciprocal Rank Fusion** — Merge both result sets into a single ranked list

This means when you ask about "how authentication works," the system finds relevant knowledge whether it was titled "Auth Flow," "JWT Token Handling," or "User Session Management."

### Step 3: Context Injection via Hook

This is where the real value is delivered. LM Assist registers a **UserPromptSubmit hook** with Claude Code. Every time you type a prompt, before Claude even sees it, the hook fires and injects relevant context.

The hook instructs Claude to search the knowledge base using MCP (Model Context Protocol) tools:

```
Before responding, use MCP tools to retrieve relevant context:
1. search("your prompt preview") - find matching knowledge entries
2. For highly relevant results, use detail(id) for full content
3. Use this context to inform your response
4. If any context is outdated, use feedback(id, type, reason)
```

Claude then calls the `search` tool, gets back the most relevant knowledge entries ranked by semantic similarity, recency, and project affinity, and incorporates that context into its response.

The result: Claude starts every session already knowing what it learned in previous sessions.

![Context injection logs — every prompt triggers the hook, which injects matching knowledge entries (K020.2, K228.5, K228.6, etc.) with token counts. The "RELEVANT CONTEXT" block shows exactly what Claude receives before responding.](https://raw.githubusercontent.com/langmartai/lm-assist/main/docs/screenshots/context-hook-logs.png)

### Step 4: Progressive Disclosure

Not all knowledge needs to be loaded at once. The MCP tools use **progressive disclosure**:

- `search()` returns summaries with relevance scores
- `detail()` expands a specific entry to full content
- Claude decides what is relevant and drills down only where needed

This keeps token usage minimal while ensuring deep context is available on demand.

![MCP tool logs — real SEARCH and DETAIL calls made by Claude during a session. The search returns ranked knowledge entries, and detail expands the full content of a specific part. This is the progressive disclosure pattern in action.](https://raw.githubusercontent.com/langmartai/lm-assist/main/docs/screenshots/mcp-tool-logs.png)

### Step 5: Feedback Loop

Knowledge is not static. When Claude encounters outdated or incorrect knowledge, it can call `feedback()` to flag the issue. These flags feed into a review pipeline where knowledge entries get updated, corrected, or archived.

Over time, the knowledge base self-improves through use.

---

## What This Looks Like in Practice

![Session browser — browse all your Claude Code sessions across projects with live console access, token counts, model info, and session metadata. This is where your accumulated knowledge lives before extraction.](https://raw.githubusercontent.com/langmartai/lm-assist/main/docs/screenshots/session-browser.png)

**Session 1 (Tuesday):**
You ask Claude to understand your project's database migration system. Claude launches Explore subagents, reads migration files, analyzes patterns, and produces a detailed analysis. This session costs ~120k tokens total.

**Knowledge generated:** 4 entries covering migration structure, naming conventions, rollback patterns, and seed data management.

**Session 2 (Thursday):**
You need to write a new migration. When you type your prompt, the hook fires. Claude searches the knowledge base, finds the migration pattern entries, and immediately knows:
- Your migration naming convention
- The standard up/down structure you use
- How you handle rollbacks
- Where seed data goes

It writes the migration correctly on the first attempt. Exploration cost: ~3k tokens for the injected context. Total session: maybe 15k tokens instead of 100k+.

**Session 3 (Next Monday, different team member):**
A colleague asks about the migration system. Same knowledge is available. Same instant context. They never had to discover those patterns themselves.

---

## The Compound Effect

The value of session knowledge reuse compounds over time:

**Week 1:** A few knowledge entries from initial explorations. Modest savings.

**Month 1:** Dozens of entries covering core architecture, patterns, and decisions. New sessions on familiar topics start fast.

**Month 3:** Comprehensive coverage of the project. Most common questions already answered in the knowledge base. New team members get productive faster because Claude already has institutional knowledge.

**Ongoing:** The feedback loop keeps entries current. Outdated patterns get flagged and updated. The knowledge base becomes a living document that reflects the actual state of the codebase.

This is fundamentally different from traditional documentation:
- **Zero writing effort** — Knowledge is extracted automatically from sessions you already ran
- **Always specific** — Based on actual code exploration, not abstract descriptions
- **Self-improving** — Feedback from active use drives corrections
- **Machine-readable** — Vector-indexed for semantic search, not just keyword matching

---

## The Numbers

For a mid-size project with active development:

| Metric | Without Knowledge Reuse | With LM Assist |
|--------|------------------------|----------------|
| Exploration tokens per session | 50-150k | 3-5k (injected context) |
| Time to first useful response | 2-5 minutes | Seconds |
| Repeated research across sessions | Constant | Near zero |
| New team member ramp-up context | Manual or re-explored | Automatic |
| Monthly token overhead (per dev) | 500k-1M+ wasted | ~50k total injection |
| Knowledge curation effort | Manual documentation | Zero (automatic extraction) |

---

## Getting Started

LM Assist runs entirely on your machine. No data leaves your environment.

**Install:**
```bash
# From the lm-assist repo
claude plugin install .

# Or via npm
npm install -g lm-assist
```

**Start services:**
```bash
./core.sh start
```

**Generate knowledge from your existing sessions:**

Open the web UI at `http://localhost:3848`, navigate to the Knowledge page, and trigger generation. LM Assist scans your session history, extracts Explore subagent results, indexes them as vectors, and makes them available to all future sessions.

From that point on, every new Claude Code session benefits from everything Claude has already learned about your project.

---

## Summary

Your Claude Code sessions contain valuable, hard-won knowledge about your codebase. Every Explore subagent result is a structured research artifact that can inform future work. Without reuse, you pay the full exploration cost every time — hundreds of thousands of tokens repeated across sessions.

LM Assist closes this loop automatically:

1. **Extract** knowledge from Explore subagent results (no LLM cost, instant)
2. **Index** into a local vector database for semantic search
3. **Inject** relevant context into every new session via hook and MCP tools
4. **Improve** through feedback — Claude flags outdated knowledge, the system self-corrects

The result is sessions that start informed instead of ignorant, meaningful token and cost savings, and a knowledge base that grows with every session you run — all with zero manual effort.

Your sessions are not disposable transcripts. They are your project's memory. Use them.
