# Claude Code Internals — Knowledge Base

Reference documentation derived from analysis of the Claude Code v2.1.88 source (leaked via npm source map, March 2026). This knowledge base documents the internal architecture, storage formats, API protocols, and system design used by Claude Code.

## Purpose

This documentation serves the lm-assist project — understanding Claude Code's internals is essential for:
- Reading and indexing session JSONL files correctly
- Understanding the storage formats and path conventions
- Knowing what data is available and how it's structured
- Building compatible tools and viewers

## Structure

```
claude-code-internals/
├── README.md                          ← This file
├── storage/
│   ├── session-jsonl.md               ← Session JSONL format, write patterns, entry types
│   ├── task-system.md                 ← Task file storage, locking, ID resolution
│   ├── directory-layout.md            ← Full ~/.claude/ directory tree
│   ├── path-sanitization.md           ← How project paths are encoded/decoded
│   ├── plugin-system.md               ← Plugin marketplace, manifests, cache, installation
│   ├── skills-commands.md             ← Skills & commands: frontmatter, loading, directories
│   └── agent-system.md               ← Built-in + custom agents, memory, execution, storage
├── api/
│   ├── inference-endpoint.md          ← Messages API call construction, headers, body
│   ├── all-endpoints.md               ← Complete API endpoint map
│   └── beta-headers.md                ← All beta header values and when they're used
├── system-prompt/
│   ├── main-prompt.md                 ← System prompt assembly, sections, order
│   ├── special-modes.md               ← KAIROS, Undercover, Proactive, Simple modes
│   └── background-agents.md           ← Memory extraction, session memory, magic docs prompts
├── compaction/
│   ├── overview.md                    ← 5-layer context management architecture
│   ├── full-compact.md                ← Full compact process, prompt, post-compact recovery
│   └── microcompact.md                ← Time-based clearing, API context management, cached MC
├── concurrency/
│   └── multi-instance.md              ← How multiple instances handle same session file
├── oauth/
│   └── auth-storage.md                ← OAuth flow, credential storage, token refresh
├── browser-automation/
│   └── chrome-mcp.md                  ← Claude-in-Chrome architecture, native messaging, bridge
└── memory/
    └── memory-system.md               ← Auto-memory, MEMORY.md, KAIROS daily logs, team memory
```

## Source Reference

- **Source**: `@anthropic-ai/claude-code@2.1.88` npm package source map
- **Extracted to**: `/tmp/claude-code-leak/claude-code-2.1.88/source/src/`
- **Key files**: Listed in each section document
