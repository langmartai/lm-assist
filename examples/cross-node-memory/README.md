# Cross-node, cross-project memory

Claude Code keeps curated memory per project — markdown files under
`~/.claude/projects/<project>/memory/` with a `MEMORY.md` index that loads into every session.
It's the operator's own captured facts, feedback, and project notes. Left alone, that memory is
trapped twice: per **project**, and per **machine**.

lm-assist makes the same files one surface across both boundaries — searchable, comparable, and
importable from any Claude session, without changing how Claude Code writes them.

## Ask anything, anywhere

> **You:** do I have any notes about the chokidar pin?
>
> **Claude:** *(lm-assist → search_memory)* Two hits across your projects — in *deploy-notes*
> (project A): "the pin must stay ^3.6.0…", and in *release-checklist* (project B): "verify the
> pin before packing". Want me to open either one?

`search_memory` sweeps **every project's memory by default** and tags each hit with its project.
Real full-text search (bm25, CJK-aware) — not substring noise.

Tools involved: search_memory

## One project, every machine

> **You:** does any of my machines remember why we pinned the database driver?
>
> **Claude:** *(lm-assist → memory_projects, memory_cross_host)* One hit, and only in the
> laptop's mirror — *db-driver-pin*: "v2.4 breaks streaming; stay on 2.3 until the upstream fix
> lands." It's not present locally, and the mirror is fresh. Want to see what else the laptop
> has that this machine lacks?
>
> **You:** sure
>
> **Claude:** *(lm-assist → memory_import_candidates)* Two candidates: *db-driver-pin* (missing
> here) and *load-test-notes* (the laptop's copy is three weeks newer). These are suggestions
> only — nothing is imported unless you say so.

> **You:** how big is my memory estate overall?
>
> **Claude:** *(lm-assist → memory_map)* At record level: 400+ records across a dozen projects
> and 3 nodes, most of them current, a handful flagged stale. I can drill into any project,
> read one file in full, or save a new fact from right here.

Tools involved: memory_projects, memory_cross_host, memory_import_candidates, memory_file, memory_record, memory_write, memory_map

Under the hood the memory dirs are mirrored between hosts by the convergent memory sync, so
"what does any of my machines remember about X" is one call, and staleness is measured rather
than guessed.

## Rules travel the same way

The `rule_*` twins (`rule_map`, `rule_cross_host`, `rule_record`, `rule_sync_status`,
`rule_import_candidates`) do the same for `~/.claude/rules/` — with **fleet auto-convergence**
for user rules and per-OS scoping, so a Windows-only rule never haunts a Linux node.

## The Web UI view

The Memory page shows the whole estate — projects down the left with live counts, records with
type and freshness chips (`current` / `stale` / `outdated` / `superseded`), search across all
projects, and a Rules tab beside it:

![The Memory page across all projects, content masked](./memory-page-masked.png)

Notes:
- lm-assist reads and mirrors the files Claude Code already owns — there is no second memory
  store to keep consistent.
- Import is deliberately a suggestion (`memory_import_candidates` is read-only); the operator
  or a session chooses what crosses machines.
- The knowledge store (auto-extracted from sessions, searched by `search`) and claude.ai
  conversations (see [claudeai-conversation-search](../claudeai-conversation-search/)) are
  separate layers — this one is the memory *you* curated.
