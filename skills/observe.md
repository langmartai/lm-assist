---
description: "Use when the user asks about Claude Code sessions, running executions, agent status, session costs, token usage, subagent trees, or wants to run/monitor agent executions. Covers session browsing, cost tracking, execution management, and debugging across any project."
allowed-tools: Bash
---

# lm-assist Observability

Query sessions, monitor executions, debug agent behavior, and control agent runs through the lm-assist REST API.

**API base:** `http://localhost:3100`

All commands use `curl -s` with `--max-time 5`. Parse JSON responses with `python3 -c "import sys,json; ..."`.

## Project Context

**Most prompts are for the current project.** Always start routing from the current project's sessions before looking at other projects.

Routing priority:
1. **Current session** — is the user's request a continuation of what we're already doing?
2. **Current project sessions** — is there another session in this project that already did this work?
3. **Other projects** — only if the user explicitly mentions another project or the task clearly belongs elsewhere

### Project summaries

Check what each project is about:

```bash
# Get all project summaries
curl -s http://localhost:3100/projects/summaries | python3 -c "
import sys,json
summaries = json.load(sys.stdin).get('data',{}).get('summaries',[])
for s in summaries:
    print(f'{s[\"projectName\"]:20} {s.get(\"summary\",\"\")[:100]}')
"
```

If project summaries don't exist yet, generate them by dispatching a background agent **in each project's directory**. The agent reads that project's CLAUDE.md and codebase to understand it.

```bash
# Step 1: Get project list
curl -s http://localhost:3100/projects | python3 -c "
import sys,json
projects = json.load(sys.stdin).get('data',{}).get('projects',[])
for p in projects:
    name = p.get('projectName','') or p.get('name','')
    count = p.get('sessionCount',0)
    path = p.get('path','')
    print(f'{name:20} {count:>4} sessions  path={path}')
"

# Step 2: Check which projects need summaries
curl -s http://localhost:3100/projects/summaries | python3 -c "
import sys,json
existing = {s['projectPath'] for s in json.load(sys.stdin).get('data',{}).get('summaries',[])}
print(f'Have summaries: {existing}')
"
```

For each project WITHOUT a summary, dispatch a background agent **IN that project's directory**. Use `POST /agent/execute` with `"cwd": "PROJECT_PATH"`.

The agent prompt should instruct it to explore the actual project — not just CLAUDE.md. CLAUDE.md may be incomplete or outdated. The source of truth is the code.

The agent should:

1. **Scan the project root** — `ls -la` to find key files (package.json, Makefile, Dockerfile, docker-compose.yml, core.sh, .env.example, tsconfig.json, pyproject.toml, Cargo.toml, go.mod, etc.)
2. **Read package.json / pyproject.toml / Cargo.toml** — name, version, scripts, dependencies, workspaces
3. **Read CLAUDE.md if it exists** — but treat as supplementary, not primary
4. **Read service management scripts** — core.sh, start.sh, Makefile targets. Actually read the file to find ports, commands, service names
5. **List directories** — `ls` to understand project structure, identify monorepo vs single project
6. **Check .env.example** — find port numbers, API keys, database URLs, external service configs
7. **Check deployment** — look for Dockerfile, docker-compose.yml, deploy.sh, CI/CD configs (.github/workflows/, .gitlab-ci.yml), Procfile, serverless.yml, terraform/
8. **Check recent git log** — `git log --oneline -15` to see what's been worked on
9. **Check running processes** — if services have ports, check what's actually running
10. **Read key source files** — entry points (src/index.ts, src/main.py, main.go), route definitions, config files

Then save a comprehensive summary via `PUT /projects/summary` with ALL these fields:

```json
{
  "projectPath": "/path/to/project",
  "projectName": "project-name",
  "summary": "1-2 sentence description of what this project IS",
  "stack": ["TypeScript", "Node.js", "..."],
  "areas": ["core API", "web UI", "..."],
  "recentFocus": "What's been worked on in the last few days",
  "services": "How to start/stop/restart. e.g.: ./core.sh start, ./core.sh stop, ./core.sh status. Ports: API :3100, Web :3848",
  "keyCommands": "Most used commands. e.g.: ./core.sh build, npm install, npm run dev, ./core.sh logs core",
  "structure": "Key directories: core/ (backend API), web/ (Next.js UI), hooks/ (Claude Code hooks), commands/ (slash commands)",
  "keyEndpoints": "Most important API endpoints. e.g.: GET /health, GET /sessions, GET /monitor/executions, POST /agent/execute",
  "commonWorkflows": "What users do most: 1) Edit TypeScript → ./core.sh build → ./core.sh restart. 2) npm publish for releases. 3) lm-assist upgrade for prod updates",
  "deployment": "How to deploy: npm publish → lm-assist upgrade on prod. SG instance: ssh opc@213.35.107.246, do NOT auto-deploy. Prod port :3100, dev port :3200",
  "importantNotes": "Critical constraints: Always use ./core.sh, never direct npm/node. Dev/prod run on separate ports. Knowledge system has kill switch.",
  "fullReference": "Complete markdown reference extracted from CLAUDE.md — include service management, port mapping, key API endpoints, deployment steps, and any operational constraints users need daily"
}
```

The `fullReference` field should be a comprehensive markdown block (500-1000 words) that captures everything from CLAUDE.md that a user would need during daily work — not a summary but a practical reference card.

**CRITICAL: Project folder context rules:**
- Each agent MUST run with `"cwd": "PROJECT_PATH"` — this ensures all file reads, `ls`, `git log`, and scripts execute in the correct project
- The `projectPath` saved in the summary MUST be the absolute path (e.g. `/home/ubuntu/lm-assist`, not `~/lm-assist` or `lm-assist`)
- All commands in `services`, `keyCommands`, `commonWorkflows`, `deployment` must be written relative to the project root (e.g. `./core.sh start`, not `/home/ubuntu/lm-assist/core.sh start`) — because they will be run from inside that project directory
- When another session later uses this summary to run commands, it must `cd` to `projectPath` first or use `--cwd`
- For the current project, you can read files and run commands directly — no need to dispatch an agent

### Routing with project context

When user asks to do something:

```
1. Is this about the CURRENT project?
   → YES (most cases): check current project sessions first
   → NO (user mentions another project): check that project

2. Within the target project, find relevant sessions:
   → GET /sessions/summaries — filter by projectPath
   → Match task description against session summaries

3. Recommend: RESUME / FORK / QUEUE / NEW
   → Current session continuation? Just do it.
   → Same project, different session? RESUME/FORK/QUEUE.
   → Different project? Suggest switching: "This looks like it belongs in PROJECT_NAME."
```

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

Compare the user's new task against existing summaries. If a relevant session exists, reason about what to do:

#### Session Routing Decision

Read the summary and understand WHAT the session did, then decide:

**RESUME** — when the session's existing work directly continues into the new task.
- The session explored or built something the new task needs to extend
- The session's context (files read, decisions made, patterns understood) is valuable for the new task
- Example: session explored API routes → new task adds an API endpoint. Resume: the session already knows the route structure.

**FORK** — when the session is relevant but shouldn't be modified.
- The session did related work but is being used by another workflow or the user wants to keep its history clean
- The session's work is a reference but the new task diverges significantly
- The session is still running — fork to work in parallel without interfering
- Example: session implemented feature A → new task is feature B in same area. Fork: share context but don't mix histories.
- Command: `claude --resume SESSION_ID --fork`

**NEW** — when no session's work meaningfully overlaps with the new task.
- The summaries don't match the new task's domain
- The closest session worked in a completely different area of the codebase
- Example: existing sessions are all about trading → new task is about auth. Start fresh.

**QUEUE** — when the most relevant session is currently running. Don't wait idly — queue the work.
- The session is actively working and the new task belongs in the same session
- Queue the prompt: it will be processed when the current work finishes
- The prompt is stored as a structured entry (original intent + formatted prompt + routing reason)

**Do NOT use turn count, session age, or cost as the primary factor.** A 2000-turn session that already built exactly the foundation you need is better to resume than a 5-turn session that happens to be recent. The question is always: **does resuming this session save real work?**

Present your recommendation to the user:
```
Found relevant session: SESSION_DISPLAY_NAME (SESSION_ID)
Summary: SESSION_SUMMARY
Status: running/idle/completed
Recommendation: RESUME/FORK/NEW/QUEUE
Reason: WHY this is the right choice

To resume:  claude --resume SESSION_ID
To fork:    claude --resume SESSION_ID --fork
```

Let the user decide — always present the option, never auto-resume without asking.

### Queuing prompts for running sessions

When the recommendation is QUEUE (session is running), store the prompt:

```bash
# Step 1: Format the user's intent into a clear, actionable prompt
# (same as /run prompt formatting — expand casual intent into clear instructions)

# Step 2: Queue it
curl -s -X POST "http://localhost:3100/sessions/SESSION_ID/queue" \
  -H 'Content-Type: application/json' \
  -d '{
    "originalIntent": "WHAT THE USER SAID",
    "formattedPrompt": "EXPANDED ACTIONABLE PROMPT",
    "routingReason": "WHY this session was chosen — what it already knows",
    "contextHint": "WHAT the session should know about its state before processing this",
    "sessionDisplayName": "SESSION_DISPLAY_NAME",
    "priority": "normal",
    "projectPath": "PROJECT_PATH"
  }'
```

The `contextHint` is important — it tells the session what to be aware of when it picks up the queued work. Example: "You just finished implementing delta analysis for technical track. This queued task extends that to the fundamental track."

### Checking and listing queued prompts

```bash
# List all pending prompts across all sessions
curl -s http://localhost:3100/sessions/queue | python3 -c "
import sys,json
data = json.load(sys.stdin).get('data',{})
prompts = data.get('prompts',[])
if not prompts:
    print('No queued prompts.')
else:
    print(f'{len(prompts)} queued prompt(s):')
    for p in prompts:
        name = p.get('sessionDisplayName') or p['sessionId'][:12]
        intent = p.get('originalIntent','')[:80]
        pri = p.get('priority','normal')
        queued = p.get('queuedAt','')[:16]
        print(f'  [{pri}] {name}: {intent} (queued {queued})')
"

# List queue for a specific session
curl -s http://localhost:3100/sessions/SESSION_ID/queue | python3 -c "
import sys,json
data = json.load(sys.stdin).get('data',{})
for p in data.get('prompts',[]):
    print(f'  [{p[\"priority\"]}] {p[\"originalIntent\"][:100]}')
    print(f'    Formatted: {p[\"formattedPrompt\"][:100]}')
    print(f'    Reason: {p[\"routingReason\"][:80]}')
    print()
"

# Get next prompt to process (when session finishes current work)
curl -s http://localhost:3100/sessions/SESSION_ID/queue/next
```

### Processing queued prompts

When a session finishes its current work and checks for queued prompts:

1. Call `GET /sessions/SESSION_ID/queue/next` to get the next pending prompt
2. If one exists, use the `formattedPrompt` as the next user prompt
3. Mark it dispatched: `POST /sessions/SESSION_ID/queue/QUEUE_ID/dispatch`
4. After completing the work, mark completed: `POST /sessions/SESSION_ID/queue/QUEUE_ID/complete`

### Summary generation priority

Process sessions in this order:
1. **Currently running** — most urgent to understand
2. **Last 24 hours** — recent context
3. **2-3 days** — still relevant
4. **4-5 days** — background context

Only generate summaries for sessions with 3+ real user prompts (skip warmup/empty sessions).

---

## 5. AUTO-LEARNING — Evolve Summaries From Every Interaction

After EVERY routing decision or session query, emit learning signals so summaries improve over time.

```bash
# Record what was learned from this interaction
curl -s -X POST http://localhost:3100/learn \
  -H 'Content-Type: application/json' \
  -d '{
    "signals": [
      {"type": "keyword", "value": "FEATURE_OR_TERM_MENTIONED", "projectPath": "PROJECT_PATH", "projectName": "PROJECT_NAME"},
      {"type": "area", "value": "AREA_OF_PROJECT_WORKED_IN", "projectPath": "PROJECT_PATH"},
      {"type": "command", "value": "COMMAND_USER_RAN_OR_ASKED_ABOUT", "projectPath": "PROJECT_PATH"},
      {"type": "routing", "value": "Routed FROM_SESSION to TO_SESSION because REASON", "projectPath": "TARGET_PROJECT"}
    ]
  }'
```

**What to record after each interaction:**

| Situation | Signals to emit |
|-----------|----------------|
| User asks about a feature | `keyword: "feature name"` for the project |
| User runs a command | `command: "./core.sh build"` for the project |
| User queries an endpoint | `endpoint: "GET /sessions"` for the project |
| Routing decision made | `routing: "delta analysis → trade-delta-analysis session"` |
| User says "no, wrong project" | `correction: "regime analysis is NOT lm-assist, IS lm-unified-trade"` |
| User works in a specific area | `area: "web UI"` or `area: "analysis pipeline"` |

**How learning improves routing over time:**

When regenerating project summaries, include accumulated signals:

```bash
# Get learning context for a project before regenerating its summary
curl -s "http://localhost:3100/learn/project/$(python3 -c 'import urllib.parse; print(urllib.parse.quote("/home/ubuntu/lm-assist"))')" | python3 -c "
import sys,json
data = json.load(sys.stdin).get('data',{})
print(f'Signals: {data.get(\"total\",0)}')
print(f'Context:\n{data.get(\"context\",\"(none)\")}')"
```

The `context` string can be included in the project summary agent's prompt so it knows:
- Which features users mention most → prioritize in summary
- Which commands are used most → put in keyCommands
- Which areas are worked in most → highlight in areas
- Routing corrections → fix misclassifications

**The learning loop:**
1. User prompts → skill extracts signals → `POST /learn`
2. Signals accumulate per project (with frequency counts)
3. When project summary is regenerated, `GET /learn/project/:path` provides context
4. New summary includes top signals → routing becomes more accurate
5. Eventually summaries are comprehensive enough that deep scans are rarely needed

**Emit signals lazily** — don't block the user's workflow. A single `POST /learn` with 2-5 signals per interaction is enough. Let frequency counts do the heavy lifting.

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
