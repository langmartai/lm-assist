# Session JSONL Storage

Source: `utils/sessionStorage.ts` (1350+ lines), `utils/sessionStoragePortable.ts`

## File Location

```
~/.claude/projects/{sanitized-cwd}/{sessionId}.jsonl
```

Subagent transcripts:
```
~/.claude/projects/{sanitized-cwd}/{sessionId}/subagents/{runId}/agent-{agentId}.jsonl
~/.claude/projects/{sanitized-cwd}/{sessionId}/subagents/agent-{agentId}.jsonl
```

Sidecar metadata:
```
agent-{agentId}.meta.json   → { agentType, worktreePath?, description? }
```

## Write Architecture

The `Project` class (singleton) manages all writes via a **batched queue system**:

```
enqueueWrite(filePath, entry)
  → per-file queue: Map<filePath, Array<{entry, resolve}>>
  → scheduleDrain() sets 100ms timer
  → drainWriteQueue() concatenates entries, calls fsAppendFile once
  → MAX_CHUNK_BYTES = 100MB per batch
```

Key design:
- **Lazy session file creation**: File isn't created until first user/assistant message (`materializeSessionFile`)
- **Batched I/O**: 100ms flush interval, multiple entries per write
- **Mode 0o600**: All session files are owner-read-only
- **mkdir on ENOENT**: `appendToFile` creates parent dirs on first failure

## Entry Types

### Transcript messages (participate in parentUuid chain)
- `user` — user prompts, tool results
- `assistant` — model responses
- `attachment` — file attachments, skill listings, deltas
- `system` — compact boundaries, system events

### Metadata entries (re-appended to tail on exit)
- `custom-title` — user-set session title
- `ai-title` — auto-generated title
- `tag` — session tag
- `last-prompt` — most recent user prompt (for --resume picker)
- `agent-name`, `agent-color`, `agent-setting` — agent context
- `mode` — coordinator/normal
- `worktree-state` — active worktree info
- `pr-link` — PR number, URL, repository

### Internal entries
- `compact_boundary` — compaction marker (parentUuid: null, new chain root)
- `attribution-snapshot` — file attribution state
- `file-history-snapshot` — file change tracking
- `content-replacement` — tool result storage references
- `marble-origami-commit` — context collapse commits
- `marble-origami-snapshot` — context collapse state
- `queue-operation` — message queue operations
- `summary` — session summary with leafUuid
- `speculation-accept` — speculative execution acceptance

### Legacy entries (skipped on load)
- `progress` — ephemeral tool progress (removed from persistence in PR #24099)
- `bash_progress`, `powershell_progress`, `mcp_progress`, `sleep_progress`

## UUID Chain (DAG)

Every transcript message has:
- `uuid` — unique identifier
- `parentUuid` — points to previous message in chain (null for first/boundary)
- `isSidechain` — true for subagent/fork messages

On resume, `buildConversationChain()` walks `parentUuid` from the newest non-sidechain leaf back to root. This is a linked-list traversal of a DAG.

`recoverOrphanedParallelToolResults()` post-processes to recover sibling assistant blocks from parallel tool_use (streaming emits one AssistantMessage per content_block_stop).

## Tail Metadata Trick

On session exit, `reAppendSessionMetadata()` re-appends title/tag/last-prompt/agent-name/etc to the JSONL tail. This ensures `readLiteMetadata` (which only reads the last 64KB) always finds them, even after thousands of messages push the original entries out of the tail window.

## Session Listing

`listSessionsImpl()` uses a two-pass strategy:
1. **Stat pass** (cheap): readdir + stat each .jsonl for mtime
2. **Content pass** (expensive): `readSessionLite()` reads first 64KB + last 64KB

Field extraction uses manual character-by-character JSON scanners (`extractJsonStringField`, `extractLastJsonStringField`) — no full JSON.parse needed.

Pagination: `limit`/`offset` params trigger stat-first sorting before expensive reads.

## Deduplication

```typescript
const messageSet = await getSessionMessages(sessionId) // memoized Set<UUID>
const isNewUuid = !messageSet.has(entry.uuid)
if (isAgentSidechain || isNewUuid) {
  void this.enqueueWrite(targetFile, entry)
}
```

Sidechain entries bypass dedup for the main session set (they go to separate agent files).

## Key Constants

- `MAX_TRANSCRIPT_READ_BYTES = 50MB` — OOM protection for full reads
- `MAX_TOMBSTONE_REWRITE_BYTES = 50MB` — skip removeMessageByUuid for huge files
- `LITE_READ_BUF_SIZE = 65536` — head/tail read buffer (64KB)
- `FLUSH_INTERVAL_MS = 100` — write queue drain interval
- `MAX_CHUNK_BYTES = 100MB` — max batch size before forced mid-drain flush
