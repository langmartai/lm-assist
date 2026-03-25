---
allowed-tools: Bash
description: Execute an agent on current or specified project
---

# /run — Execute Agent

Launch an agent execution on the current project or a specified project path.

## Arguments

- `$ARGUMENTS`: The prompt/task for the agent to execute
- `--project /path/to/project`: Optional — override the target project (default: current working directory)

## Steps

1. **Check API health:**
```bash
curl -s --max-time 2 http://localhost:3100/health
```
If not healthy, tell the user to start lm-assist with `lm-assist start` or `/assist-setup`.

2. **Parse arguments:**
   - Extract `--project` value if present, otherwise use the current working directory as `PROJECT_CWD`
   - Everything else is the user's prompt

3. **Check for running executions on the target project:**
```bash
curl -s --max-time 3 http://localhost:3100/monitor/executions | python3 -c "
import sys,json
execs = json.load(sys.stdin).get('data',{}).get('executions',[])
running = [e for e in execs if e.get('isRunning')]
if running:
    print(f'WARNING: {len(running)} execution(s) already running:')
    for e in running:
        eid = e.get('executionId','')[:12]
        turns = e.get('turnCount',0)
        cost = e.get('costUsd',0)
        elapsed = (e.get('elapsedMs',0) or 0) // 1000
        print(f'  {eid}  T:{turns}  \${cost:.2f}  {elapsed}s elapsed')
    print()
    print('Options:')
    print('  - Proceed anyway (runs in parallel)')
    print('  - Abort the running execution first')
else:
    print('OK: No running executions.')
"
```

If executions are running, **ask the user** whether to proceed, abort first, or cancel. Do NOT auto-proceed.

4. **Format the prompt:**
   Take the user's input and expand it into a clear, actionable prompt. Examples:
   - "review auth" → "Review the authentication module for security vulnerabilities, code quality issues, and test coverage gaps. Report findings with severity ratings."
   - "fix the tests" → "Investigate and fix failing tests. Run the test suite, identify failures, analyze root causes, and implement fixes. Verify all tests pass after changes."
   - "add error handling to the API" → "Add comprehensive error handling to all API endpoints. Include input validation, proper HTTP status codes, error response formatting, and logging for debugging."

5. **Execute the agent:**
```bash
curl -s -X POST http://localhost:3100/agent/execute \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"FORMATTED_PROMPT","cwd":"PROJECT_CWD"}' | python3 -c "
import sys,json
d = json.load(sys.stdin)
if d.get('success'):
    data = d.get('data',{})
    eid = data.get('executionId','')
    print(f'Execution started: {eid}')
else:
    err = d.get('error',{})
    print(f'Failed: {err.get(\"message\",\"unknown error\")}')
"
```

6. **Confirm execution started (wait 3 seconds, then check):**
```bash
sleep 3 && curl -s --max-time 3 http://localhost:3100/monitor/executions | python3 -c "
import sys,json
execs = json.load(sys.stdin).get('data',{}).get('executions',[])
running = [e for e in execs if e.get('isRunning')]
if running:
    e = running[0]
    eid = e.get('executionId','')[:12]
    status = e.get('status','')
    turns = e.get('turnCount',0)
    print(f'Confirmed running: {eid}  status:{status}  T:{turns}')
    print(f'Monitor with: /sessions')
    print(f'Or open web UI: http://localhost:3848')
else:
    print('Execution may still be starting. Check with /sessions.')
"
```

## Output

Report the execution status clearly:
- Execution ID
- Status (running/queued)
- How to monitor progress (`/sessions` or web UI URL)

If the API is not running, show:
```
lm-assist API is not running.
Start with: lm-assist start
Or run: /assist-setup
```
