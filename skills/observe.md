---
description: "Use when the user asks about Claude Code sessions, running executions, agent status, session costs, token usage, subagent trees, or wants to run/monitor agent executions. Covers session browsing, cost tracking, execution management, and debugging across any project."
allowed-tools: Bash
---

# lm-assist Observability

Query sessions, monitor executions, debug agent behavior, and control agent runs through the lm-assist REST API.

**API base:** `http://localhost:3100`

All commands use `curl -s` with `--max-time 5`. Parse JSON responses with `python3 -c "import sys,json; ..."`.

## Resolve Session ID

When the user references a session by name, partial ID, or relative reference, resolve it:

1. **Slug match** — if user says a slug name like "silly-plotting-parasol" or a prefix like "silly-plot":
```bash
curl -s http://localhost:3100/projects/sessions | python3 -c "
import sys,json
sessions = json.load(sys.stdin).get('data',{}).get('sessions',[])
q = 'USER_QUERY'.lower()
matches = [s for s in sessions if (s.get('slug') or '').lower().startswith(q) or s.get('sessionId','').startswith(q)]
for s in matches[:5]:
    print(f'{s[\"sessionId\"][:12]}  {s.get(\"slug\",\"-\")}  {s.get(\"customTitle\",\"-\")}')
"
```

2. **"last session" / "most recent"** — take first from list (already sorted by lastModified desc).

3. **"the running one"** — use `GET /monitor/executions` and take the matching execution's sessionId.

4. **Ambiguous** — if multiple matches, list them and ask the user to pick.

Once resolved, use the full session ID for all subsequent queries.

---

## 1. MONITOR — Session List, Costs, Running Executions

### List recent sessions

Show sessions for the current project or all projects:

```bash
# Current project sessions (replace CWD with actual working directory)
curl -s "http://localhost:3100/projects/sessions" | python3 -c "
import sys,json
data = json.load(sys.stdin).get('data',{})
sessions = data.get('sessions',[])[:15]
print(f'Sessions ({len(sessions)} of {data.get(\"total\",len(sessions))})')
print('─' * 90)
print(f'{\"Status\":<8} {\"Slug\":<30} {\"Project\":<20} {\"Model\":<8} {\"Cost\":>8} {\"Turns\":>6} {\"Modified\":<10}')
for s in sessions:
    status = '[RUN]' if s.get('isRunning') else ''
    slug = (s.get('customTitle') or s.get('slug') or s['sessionId'][:12])[:28]
    project = (s.get('projectPath','').split('/')[-1] or '-')[:18]
    model = (s.get('model','') or '-').replace('claude-','').replace('opus-4-6','opus').replace('sonnet-4-6','sonnet')[:7]
    cost = f'\${s[\"totalCostUsd\"]:.2f}' if s.get('totalCostUsd') else '-'
    turns = str(s.get('numTurns','')) or '-'
    print(f'{status:<8} {slug:<30} {project:<20} {model:<8} {cost:>8} {turns:>6}')
"
```

### List all projects

```bash
curl -s http://localhost:3100/projects | python3 -c "
import sys,json
projects = json.load(sys.stdin).get('data',{}).get('projects',[])
for p in projects:
    name = p.get('projectName','') or p.get('name','')
    count = p.get('sessionCount',0)
    print(f'  {count:>4} sessions  {name}')
"
```

### Check running executions

```bash
curl -s http://localhost:3100/monitor/executions | python3 -c "
import sys,json
data = json.load(sys.stdin).get('data',{})
execs = data.get('executions',[])
if not execs:
    print('No running executions.')
else:
    for e in execs:
        eid = e.get('executionId','')[:12]
        sid = e.get('sessionId','')[:12]
        status = e.get('status','')
        turns = e.get('turnCount',0)
        cost = e.get('costUsd',0)
        elapsed = e.get('elapsedMs',0) // 1000
        mins = elapsed // 60
        print(f'  {eid}  session:{sid}  {status}  T:{turns}  \${cost:.2f}  {mins}m')
"
```

### Monitor summary

```bash
curl -s http://localhost:3100/monitor/summary | python3 -c "
import sys,json; print(json.dumps(json.load(sys.stdin).get('data',{}), indent=2))
"
```

---

## 2. DEBUG — Session Detail, Subagents, DAG

### Session detail

Get full session data (replace SESSION_ID with the resolved ID):

```bash
curl -s "http://localhost:3100/sessions/SESSION_ID" | python3 -c "
import sys,json
d = json.load(sys.stdin).get('data',{})
print(f'Session: {d.get(\"slug\") or d.get(\"sessionId\",\"\")[:12]}')
print(f'  Custom Title: {d.get(\"customTitle\",\"-\")}')
print(f'  Status: {d.get(\"status\",\"-\")}')
print(f'  Model: {d.get(\"model\",\"-\")}')
print(f'  Cost: \${d.get(\"totalCostUsd\",0):.4f}')
print(f'  Turns: {d.get(\"numTurns\",0)}')
print(f'  Duration: {(d.get(\"duration\",0) or 0)//1000}s')
print(f'  Claude Code: {d.get(\"claudeCodeVersion\",\"-\")}')
print(f'  Permission: {d.get(\"permissionMode\",\"-\")}')
print(f'  Team: {d.get(\"teamName\",\"-\")}')
print(f'  Forked from: {d.get(\"forkedFromSessionId\",\"-\")}')
# Token breakdown
u = d.get('usage') or d.get('inputTokens') and d
if isinstance(u, dict):
    print(f'  Tokens: in={u.get(\"inputTokens\",0):,} out={u.get(\"outputTokens\",0):,} cache_read={u.get(\"cacheReadInputTokens\",0):,} cache_create={u.get(\"cacheCreationInputTokens\",0):,}')
# Subagent count
subs = d.get('subagents',[])
if subs:
    print(f'  Subagents: {len(subs)}')
# Plans
plans = d.get('plans',[])
if plans:
    print(f'  Plans: {len(plans)}')
"
```

### Session conversation

```bash
curl -s "http://localhost:3100/sessions/SESSION_ID/conversation?toolDetail=summary&lastN=20" | python3 -c "
import sys,json
d = json.load(sys.stdin).get('data',{})
messages = d.get('messages',[])
for m in messages[-20:]:
    role = m.get('type','')
    content = (m.get('content','') or '')[:200]
    if role == 'human':
        print(f'\n> USER: {content}')
    elif role == 'assistant':
        print(f'  CLAUDE: {content}')
    elif role == 'tool':
        tool = m.get('toolName','')
        print(f'  [{tool}] {content[:100]}')
"
```

### Subagent hierarchy

```bash
curl -s "http://localhost:3100/sessions/SESSION_ID/subagents" | python3 -c "
import sys,json
d = json.load(sys.stdin).get('data',{})
agents = d.get('subagents') or d.get('invocations') or []
if not agents:
    print('No subagents in this session.')
else:
    for a in agents:
        name = a.get('name') or a.get('agentName','?')
        atype = a.get('type') or a.get('agentType','')
        status = a.get('status','')
        prompt = (a.get('prompt','') or '')[:80]
        print(f'  {name} ({atype}) [{status}] — {prompt}')
"
```

### Session DAG

```bash
curl -s "http://localhost:3100/sessions/SESSION_ID/session-dag" | python3 -c "
import sys,json
d = json.load(sys.stdin).get('data',{})
nodes = d.get('nodes',[])
edges = d.get('edges',[])
print(f'Session DAG: {len(nodes)} nodes, {len(edges)} edges')
for n in nodes[:20]:
    ntype = n.get('type','')
    label = n.get('label','')[:60]
    meta = n.get('metadata',{})
    slug = meta.get('slug','')
    print(f'  [{ntype}] {label} {slug}')
"
```

### Related sessions

```bash
curl -s "http://localhost:3100/sessions/SESSION_ID/related" | python3 -c "
import sys,json
d = json.load(sys.stdin).get('data',{})
for key in ['parent','forks','subagents','siblings']:
    items = d.get(key)
    if items:
        if isinstance(items, list):
            print(f'{key}: {len(items)} sessions')
            for s in items[:5]:
                sid = s if isinstance(s,str) else s.get('sessionId','')[:12]
                print(f'  {sid}')
        else:
            print(f'{key}: {items}')
"
```

---

## 3. CONTROL — Execute, Abort, Cache

### Execute agent on project

Before executing, ALWAYS check for running executions first:

```bash
# Step 1: Check running executions
curl -s http://localhost:3100/monitor/executions | python3 -c "
import sys,json
execs = json.load(sys.stdin).get('data',{}).get('executions',[])
running = [e for e in execs if e.get('isRunning')]
if running:
    print(f'WARNING: {len(running)} execution(s) already running:')
    for e in running:
        print(f'  {e.get(\"executionId\",\"\")[:12]} T:{e.get(\"turnCount\",0)} \${e.get(\"costUsd\",0):.2f}')
    print('Ask user before proceeding.')
else:
    print('No running executions. Safe to proceed.')
"
```

```bash
# Step 2: Execute (replace PROMPT and CWD)
curl -s -X POST http://localhost:3100/agent/execute \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"FORMATTED_PROMPT","cwd":"PROJECT_CWD"}' | python3 -c "
import sys,json
d = json.load(sys.stdin)
if d.get('success'):
    eid = d.get('data',{}).get('executionId','')
    print(f'Execution started: {eid}')
else:
    print(f'Failed: {d.get(\"error\",{}).get(\"message\",\"unknown error\")}')
"
```

```bash
# Step 3: Confirm started (wait 3s, then check)
sleep 3 && curl -s http://localhost:3100/monitor/executions | python3 -c "
import sys,json
execs = json.load(sys.stdin).get('data',{}).get('executions',[])
for e in execs:
    print(f'  {e.get(\"executionId\",\"\")[:12]}  {e.get(\"status\",\"\")}  T:{e.get(\"turnCount\",0)}')
"
```

When formatting the prompt, expand the user's casual intent into clear, actionable instructions. Example:
- User says: "review the auth module"
- Format as: "Review the authentication module for security vulnerabilities, code quality issues, and test coverage gaps. Report findings with severity ratings and specific file/line references."

### Abort execution

```bash
curl -s -X POST http://localhost:3100/monitor/abort/EXECUTION_ID | python3 -c "
import sys,json; d=json.load(sys.stdin); print('Aborted' if d.get('success') else f'Failed: {d.get(\"error\",{}).get(\"message\",\"\")}')"
```

### Abort all executions

```bash
curl -s -X POST http://localhost:3100/monitor/abort-all | python3 -c "
import sys,json; d=json.load(sys.stdin); print(json.dumps(d.get('data',{}), indent=2))"
```

### Cache management

```bash
# Warm session cache (pre-load for faster queries)
curl -s -X POST http://localhost:3100/session-cache/warm | python3 -c "
import sys,json; d=json.load(sys.stdin); print(f'Warmed: {json.dumps(d.get(\"data\",{}))}')"

# Clear all caches
curl -s -X POST http://localhost:3100/session-cache/clear | python3 -c "
import sys,json; d=json.load(sys.stdin); print(f'Cleared: {json.dumps(d.get(\"data\",{}))}')"
```

---

## 4. SESSION SUMMARIES — Understand What Each Session Does

Session summaries are LLM-generated descriptions stored persistently with delta tracking.
When you need to understand what sessions are doing (e.g., before deciding to resume vs create new), follow this flow:

### Step 1: Check which sessions need summaries

```bash
curl -s http://localhost:3100/sessions/summaries/needs-update?maxAgeDays=5 | python3 -c "
import sys,json
data = json.load(sys.stdin).get('data',{})
sessions = data.get('sessions',[])
if not sessions:
    print('All recent session summaries are up to date.')
else:
    print(f'{len(sessions)} session(s) need summary updates:')
    for s in sessions[:10]:
        slug = s.get('slug') or s['sessionId'][:12]
        status = s['status']
        current = s['currentTurns']
        summarized = s['summarizedTurns']
        delta = current - summarized
        print(f'  {slug}  [{status}]  {summarized}/{current} turns  (+{delta} new)')
"
```

### Step 2: Generate or update summaries

For each session that needs a summary, read its conversation and write a summary:

```bash
# Read conversation for a session (new sessions: read all; stale: read from last summarized turn)
# For NEW summary (no existing):
curl -s "http://localhost:3100/sessions/SESSION_ID/conversation?toolDetail=summary&lastN=30" | python3 -c "
import sys,json
d = json.load(sys.stdin).get('data',{})
messages = d.get('messages',[])
for m in messages:
    role = m.get('type','')
    content = (m.get('content','') or '')[:300]
    if role == 'human':
        print(f'USER: {content}')
    elif role == 'assistant':
        print(f'CLAUDE: {content[:200]}')
    elif role == 'tool':
        print(f'  [{m.get(\"toolName\",\"\")}]')
"
```

```bash
# For STALE summary (update from turn N):
curl -s "http://localhost:3100/sessions/SESSION_ID?fromTurnIndex=LAST_TURN&unlimited=true" | python3 -c "
import sys,json
d = json.load(sys.stdin).get('data',{})
prompts = d.get('userPrompts',[])
responses = d.get('responses',[])
print(f'New turns since last summary:')
for p in prompts:
    print(f'  USER: {(p.get(\"text\",\"\") or \"\")[:200]}')
for r in responses[-3:]:
    print(f'  CLAUDE: {(r.get(\"text\",\"\") or \"\")[:200]}')
"
```

After reading the conversation, generate TWO things:

**1. Summary** (2-3 sentences) answering:
- What is this session about? (the goal/task)
- What was accomplished? (key actions, files changed, decisions made)
- Current state? (completed, in progress, blocked, abandoned)

**2. Display Name** (kebab-case, 2-4 words) — a descriptive name for the session.
Only generate if the session has NO `customTitle` (user hasn't renamed it via /rename).
Follow Claude Code's naming style but make it meaningful instead of random:

| Random slug (Claude Code default) | Descriptive displayName (what we generate) |
|-----------------------------------|---------------------------------------------|
| silly-plotting-parasol | trade-delta-analysis |
| refactored-twirling-karp | observability-skill-impl |
| toasty-dancing-teapot | skill-validation-test |
| warm-herding-bubble | xeenhub-review |

Rules for displayName:
- 2-4 words, kebab-case (lowercase, hyphens)
- Describe WHAT the session does, not random words
- Keep it short enough to scan in a sidebar
- Skip if session has `customTitle` — the user already named it

### Saving: current session vs other sessions

**For the CURRENT session** (the one you're running in right now):
- Call `/rename <displayName>` directly to update the session name in Claude Code
- This writes a `custom-title` message to the JSONL and the name appears immediately everywhere
- Only do this if the session doesn't already have a customTitle

**For OTHER sessions** (summarizing sessions you're not running in):
- Store the `displayName` in the summary API only
- Do NOT try to rename them — they'll get renamed when the skill runs in their own session
- The web UI will show the stored displayName from the summary

Save the summary (for both current and other sessions):

```bash
curl -s -X PUT "http://localhost:3100/sessions/SESSION_ID/summary" \
  -H 'Content-Type: application/json' \
  -d '{
    "summary": "YOUR_GENERATED_SUMMARY",
    "displayName": "GENERATED_DISPLAY_NAME",
    "slug": "SESSION_SLUG",
    "projectPath": "PROJECT_PATH",
    "lastTurnIndex": CURRENT_TURN_COUNT,
    "lastLineIndex": 0,
    "totalTurns": CURRENT_TURN_COUNT
  }'
```

For the current session only, also rename it:
```
/rename GENERATED_DISPLAY_NAME
```

### Step 3: Read summaries for session routing

When the user wants to run a new task, check existing summaries first:

```bash
curl -s http://localhost:3100/sessions/summaries | python3 -c "
import sys,json
summaries = json.load(sys.stdin).get('data',{}).get('summaries',[])
for s in summaries[:10]:
    slug = s.get('slug') or s['sessionId'][:12]
    summary = s.get('summary','')[:150]
    turns = s.get('totalTurns',0)
    updated = s.get('updatedAt','')[:10]
    print(f'{slug} ({turns}T, {updated})')
    print(f'  {summary}')
    print()
"
```

Compare the user's new task against existing summaries. If a session already covers the same topic:
- Tell the user: "Session X already covers this topic. Resume it with `claude --resume SESSION_ID` instead of starting fresh?"
- Show the relevant summary so they can decide

### Summary generation priority

Process sessions in this order:
1. **Currently running** — most urgent to understand
2. **Last 24 hours** — recent context
3. **2-3 days** — still relevant
4. **4-5 days** — background context

Only generate summaries for sessions with 3+ real user prompts (skip warmup/empty sessions).

---

## Error Handling

- **API not running** (connection refused): Tell user "lm-assist API is not running. Start with `lm-assist start` or `/assist-setup`."
- **Session not found**: Suggest similar slugs from the session list.
- **Execution already running**: Report it and ask user to abort first or run in parallel.
- **Validation error**: Show the error message from the API response.

## Output Guidelines

- Format as clean tables, not raw JSON dumps
- Show costs in `$X.XX` format
- Truncate long slugs/paths to fit terminal width
- Highlight running sessions with `[RUN]` status
- Use `python3 -c` for inline JSON parsing (available on all platforms)
