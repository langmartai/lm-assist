# Task System Storage

Source: `utils/tasks.ts` (863 lines)

## File Layout

```
~/.claude/tasks/{taskListId}/
├── 1.json              ← individual task files
├── 2.json
├── .highwatermark      ← max ID ever assigned (prevents reuse after deletion)
└── .lock               ← list-level lock file
```

## Task Schema

```typescript
{
  id: string,
  subject: string,
  description: string,
  activeForm?: string,      // present continuous for spinner ("Running tests")
  owner?: string,           // agent ID
  status: "pending" | "in_progress" | "completed",
  blocks: string[],         // task IDs this task blocks
  blockedBy: string[],      // task IDs that block this task
  metadata?: Record<string, unknown>
}
```

## Task List ID Resolution (priority order)

1. `CLAUDE_CODE_TASK_LIST_ID` env var
2. In-process teammate's leader team name
3. `CLAUDE_CODE_TEAM_NAME` env var (process-based teammate)
4. `leaderTeamName` (set by TeamCreate)
5. Session ID (fallback)

## Locking

Uses `proper-lockfile` with exponential backoff:
```typescript
LOCK_OPTIONS = {
  retries: { retries: 30, minTimeout: 5, maxTimeout: 100 }
}
```
Designed for 10+ concurrent swarm agents (~2.6s total wait budget).

Two lock levels:
- **Task-level**: locks individual `{taskId}.json` for updates
- **List-level**: locks `.lock` for atomic busy-check + claim operations

## ID Management

- Numeric, auto-incrementing IDs
- `findHighestTaskId()` = max(files on disk, .highwatermark)
- High water mark written before deletion → prevents reuse
- IDs never recycled within a task list

## Team Integration

Team config: `~/.claude/teams/{sanitized-name}/config.json`
```json
{
  "leadAgentId": "...",
  "members": [{ "agentId": "...", "name": "...", "agentType": "..." }]
}
```

`getAgentStatuses()` cross-references task ownership with team members to report idle/busy.
`unassignTeammateTasks()` clears ownership when a teammate dies, resets tasks to pending.
