# Memory System

Source: `memdir/paths.ts`, `memdir/memdir.ts`, `memdir/memoryTypes.ts`

## Path Resolution

Priority order:
1. `CLAUDE_COWORK_MEMORY_PATH_OVERRIDE` env var (Cowork/SDK full-path override)
2. `autoMemoryDirectory` in settings.json (trusted sources only — **project settings excluded** for security)
3. `~/.claude/projects/{sanitized-git-root}/memory/` (default)

Git root is canonical (`findCanonicalGitRoot`) so **all worktrees share one memory directory**.

## MEMORY.md Limits

- **200 lines** max (`MAX_ENTRYPOINT_LINES`)
- **25KB** max (`MAX_ENTRYPOINT_BYTES`)
- Truncation warning appended if exceeded
- Always loaded into conversation context

## Four-Type Taxonomy

| Type | Description | When to Save |
|------|-------------|-------------|
| `user` | Role, goals, preferences, knowledge | Learn details about the user |
| `feedback` | Corrections AND confirmations | User corrects or validates approach |
| `project` | Ongoing work, decisions, deadlines | Learn who/what/why/when |
| `reference` | Pointers to external systems | Learn about external resources |

## Memory File Format

```markdown
---
name: {memory name}
description: {one-line description}
type: {user|feedback|project|reference}
---

{content — for feedback/project: rule/fact, then **Why:** and **How to apply:**}
```

## Two-Step Save Process

1. Write memory to own file (e.g., `user_role.md`, `feedback_testing.md`)
2. Add pointer to `MEMORY.md`: `- [Title](file.md) — one-line hook`

MEMORY.md is an **index**, not a memory. Each entry: one line, under ~150 chars.

## What NOT to Save

- Code patterns, conventions, architecture, file paths — derivable from project
- Git history — `git log`/`git blame` are authoritative
- Debugging solutions — fix is in the code, commit message has context
- Anything in CLAUDE.md files
- Ephemeral task details

## Three Memory Modes

### Standard Mode (default)
Read/write MEMORY.md + topic files. Background extraction agent may update between turns.

### Team Memory (`TEAMMEM` feature flag)
Combined auto + team memory directories:
- Auto: `{base}/projects/{key}/memory/`
- Team: `{base}/projects/{key}/memory/team/`
Sync via `POST /api/claude_code/team_memory/sync`

### KAIROS Daily Log Mode
Append-only to `memory/logs/YYYY/MM/YYYY-MM-DD.md`. Date derived from context, not hardcoded. A separate nightly `/dream` skill distills logs into topic files + MEMORY.md.

## Background Memory Extraction

`feature('EXTRACT_MEMORIES')`: A background agent fork runs after turns where the main agent didn't write memories. Limited tool access. 2-turn budget: parallel reads → parallel writes.

## Security

`autoMemoryDirectory` from project settings (`.claude/settings.json`) is **excluded** — a malicious repo could set `autoMemoryDirectory: "~/.ssh"` and gain write access via the filesystem carve-out.

Path validation rejects: relative paths, root/near-root, UNC paths, null bytes, bare `~`.

## Searching Past Context

When enabled, system prompt includes grep instructions:
1. Search memory dir: `Grep pattern="..." path="{memoryDir}" glob="*.md"`
2. Session transcripts (last resort): `Grep pattern="..." path="{projectDir}/" glob="*.jsonl"`
