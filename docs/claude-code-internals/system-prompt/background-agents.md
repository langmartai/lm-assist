# Background Agent Prompts

Source: `services/extractMemories/prompts.ts`, `services/SessionMemory/prompts.ts`, `services/MagicDocs/prompts.ts`

## Memory Extraction Agent

Runs as a **perfect fork** of the main conversation (same system prompt, same message prefix). Fires when the main agent didn't write memories for a given turn range.

**Limited tools**: Read, Grep, Glob, read-only Bash (ls/find/cat/stat/wc/head/tail), Edit/Write for memory dir only. No MCP, no Agent, no write-capable Bash. `rm` denied.

**Turn budget optimization**: "Turn 1 — all Read calls in parallel; Turn 2 — all Write/Edit calls in parallel."

**Constraint**: "You MUST only use content from the last ~{N} messages. Do not investigate or verify further."

Memory format: Frontmatter YAML (name, description, type) + markdown body. Two-step: write topic file, then update MEMORY.md index.

## Session Memory Agent

Updates structured `summary.md` at `~/.claude/projects/{key}/{sessionId}/session-memory/summary.md`.

**Template sections** (must preserve headers + italic descriptions):
1. Session Title (5-10 words)
2. Current State
3. Task specification
4. Files and Functions
5. Workflow
6. Errors & Corrections
7. Codebase and System Documentation
8. Learnings
9. Key results
10. Worklog

**Constraints**:
- Max 2000 tokens per section, 12000 total
- DETAILED, INFO-DENSE content
- Include specifics: file paths, function names, error messages, exact commands
- Always update "Current State" — critical for compaction continuity
- Do not duplicate info from CLAUDE.md files
- Use Edit tool in parallel, then stop

## Magic Docs Agent

Updates `# MAGIC DOC: {title}` files. Custom prompt loadable from `~/.claude/magic-docs/prompt.md`.

**Philosophy**: "BE TERSE. High signal only."
- Document: WHY things exist, HOW components connect, WHERE to start reading, WHAT patterns
- Skip: detailed implementation, exhaustive API docs, play-by-play narratives
- Keep current — update IN-PLACE, don't append historical notes
- Fix errors: typos, grammar, broken formatting, incorrect information
- Clean up or DELETE sections no longer relevant

## Compact Agent

Not a background agent per se, but uses a forked-agent path for LLM summarization:
- Reuses main conversation's prompt cache (cache-safe params)
- `maxTurns: 1`, no tools
- NO_TOOLS_PREAMBLE enforced at start AND end of prompt
- `<analysis>` scratchpad block stripped from output
- See `compaction/full-compact.md` for details
