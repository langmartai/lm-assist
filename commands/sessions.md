---
allowed-tools: Bash
description: List recent Claude Code sessions with costs and status
---

# /sessions — Session List

Show recent Claude Code sessions with costs, turns, model, and running status.

## Arguments

- No arguments: show sessions across all projects
- `$ARGUMENTS[0]`: filter by project name (partial match)

## Steps

1. **Check API health:**
```bash
curl -s --max-time 2 http://localhost:3100/health
```
If not healthy, tell the user to start lm-assist with `lm-assist start` or `/assist-setup`.

2. **Fetch sessions:**
```bash
curl -s --max-time 5 http://localhost:3100/projects/sessions | python3 -c "
import sys,json
data = json.load(sys.stdin).get('data',{})
sessions = data.get('sessions',[])
total = data.get('total', len(sessions))

# Filter by project if argument provided
project_filter = '''$ARGUMENTS[0]'''.strip()
if project_filter:
    sessions = [s for s in sessions if project_filter.lower() in (s.get('projectPath','') + s.get('projectName','')).lower()]

# Separate running from completed
running = [s for s in sessions if s.get('isRunning')]
rest = [s for s in sessions if not s.get('isRunning')][:10 - len(running)]
show = running + rest

print(f'Sessions ({len(show)} of {total})')
if project_filter:
    print(f'Filtered: {project_filter}')
print('─' * 95)
fmt = '{:<7} {:<28} {:<18} {:<8} {:>8} {:>6}'
print(fmt.format('Status', 'Name', 'Project', 'Model', 'Cost', 'Turns'))
print('─' * 95)
for s in show:
    status = '[RUN]' if s.get('isRunning') else ''
    name = (s.get('customTitle') or s.get('slug') or s['sessionId'][:12])[:26]
    project = (s.get('projectPath','').split('/')[-1] or '-')[:16]
    model = (s.get('model','') or '-').replace('claude-','').replace('opus-4-6','opus').replace('sonnet-4-6','sonnet')[:7]
    cost = f'\${s[\"totalCostUsd\"]:.2f}' if s.get('totalCostUsd') else '-'
    turns = str(s.get('numTurns','')) or '-'
    print(fmt.format(status, name, project, model, cost, turns))
"
```

3. **Check running executions:**
```bash
curl -s --max-time 3 http://localhost:3100/monitor/executions | python3 -c "
import sys,json
execs = json.load(sys.stdin).get('data',{}).get('executions',[])
running = [e for e in execs if e.get('isRunning')]
if running:
    print(f'\nRunning Executions ({len(running)}):')
    for e in running:
        eid = e.get('executionId','')[:12]
        turns = e.get('turnCount',0)
        cost = e.get('costUsd',0)
        elapsed = (e.get('elapsedMs',0) or 0) // 1000
        mins = elapsed // 60
        secs = elapsed % 60
        print(f'  {eid}  T:{turns}  \${cost:.2f}  {mins}m{secs}s')
"
```

## Output

Present the table output from the python script directly. Do NOT reformat as markdown — show it as-is from the terminal output.

If the API is not running, show:
```
lm-assist API is not running.
Start with: lm-assist start
Or run: /assist-setup
```
