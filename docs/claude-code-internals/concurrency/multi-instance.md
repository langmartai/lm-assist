# Multi-Instance Concurrency

Source: `utils/concurrentSessions.ts`, `utils/sessionStorage.ts`

## Key Finding: No File Lock on Session JSONL

There is **no file-level lock** on session JSONL files. Multiple Claude Code instances can write to the same file simultaneously.

## Three Concurrency Mechanisms

### 1. PID Registry (Advisory Detection)

Each instance registers at startup:
```
~/.claude/sessions/{pid}.json
→ { pid, sessionId, cwd, startedAt, kind, entrypoint, messagingSocketPath }
```

`countConcurrentSessions()` scans this directory, calls `isProcessRunning(pid)` for each. Stale PIDs (crashed processes) are swept (except on WSL where Windows PIDs aren't probeable).

Session switches (`switchSession`) patch the PID file with new sessionId.

This is **advisory only** — does not prevent concurrent writes.

### 2. UUID Deduplication (Write Safety)

```typescript
const messageSet = await getSessionMessages(sessionId)  // memoized Set<UUID>
const isNewUuid = !messageSet.has(entry.uuid)
if (isAgentSidechain || isNewUuid) {
  void this.enqueueWrite(targetFile, entry)
  messageSet.add(entry.uuid)
}
```

Each instance generates unique UUIDs. Dedup prevents the same message from being written twice (relevant for fork/resume scenarios, not concurrent writes).

### 3. parentUuid DAG (Read-Time Resolution)

On resume, `buildConversationChain()` walks from the newest non-sidechain leaf back to root via `parentUuid`. If two instances wrote concurrently:

```
Instance A: X → msg-1 → msg-3 → ...
Instance B: X → msg-2 → msg-4 → ...
```

Both chains exist in the JSONL. On resume, the chain with the newest-timestamp leaf wins. The other is invisible (orphaned but not deleted).

### Append Safety

`fsAppendFile` uses `O_APPEND` — atomic up to `PIPE_BUF` (4KB on Linux). The 100ms batch timer means writes may exceed 4KB. If two large batches flush simultaneously, byte-level interleave can corrupt JSONL lines. The `parseJSONL` reader handles this by skipping unparseable lines.

## --continue vs --resume vs --fork

| Mode | JSONL File | Session ID | Behavior |
|------|-----------|------------|----------|
| `--continue` | Same file | Reused | Appends to existing |
| `--resume <id>` | Same file | Reused | Appends to existing |
| `--fork-session` | New file | New | Copies parent chain |

`--continue` checks for live bg/daemon sessions (via UDS socket) and skips them. No such check for interactive sessions.

## What Breaks

Two instances on the same session create a **forked DAG** — identical to `--fork-session` but unintentional. No data loss, but only one branch visible per resume. lm-assist's `session-dag.ts` can visualize both branches.

## Task System Locking

Unlike sessions, the task system **does** use proper file locking:
- `proper-lockfile` with 30 retries, 5-100ms exponential backoff
- Task-level locks on individual JSON files
- List-level locks for atomic operations (claim + busy check)
