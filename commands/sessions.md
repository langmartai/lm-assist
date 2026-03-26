---
allowed-tools: Bash
description: List recent Claude Code sessions with costs and status
---

# /sessions — Session List

Show recent Claude Code sessions with costs, turns, model, and running status.

## Arguments

- No arguments: show sessions across all projects
- `$ARGUMENTS[0]`: filter by project name (partial match)

## Execution

Run this single script. It handles health check, session fetch, and execution monitoring in one call:

```bash
node -e "
const http = require('http');
const filter = process.argv[1] || '';

function api(path) {
  return new Promise((resolve) => {
    const req = http.get('http://localhost:3100' + path, { timeout: 5000 }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

(async () => {
  const health = await api('/health');
  if (!health?.success) {
    console.log('lm-assist API is not running.\nStart with: lm-assist start\nOr run: /assist-setup');
    return;
  }

  const data = await api('/projects/sessions');
  if (!data?.data?.sessions) { console.log('Failed to fetch sessions.'); return; }

  let sessions = data.data.sessions;
  const total = data.data.total || sessions.length;

  if (filter) {
    sessions = sessions.filter(s => ((s.projectPath || '') + (s.projectName || '')).toLowerCase().includes(filter.toLowerCase()));
  }

  const running = sessions.filter(s => s.isRunning);
  const rest = sessions.filter(s => !s.isRunning).slice(0, 15);
  const show = [...running, ...rest];

  console.log('Sessions (' + running.length + ' running, ' + total + ' total)');
  if (filter) console.log('Filtered: ' + filter);
  console.log('\u2500'.repeat(95));
  const hdr = (s,n) => (s + ' '.repeat(n)).slice(0,n);
  const rgt = (s,n) => (' '.repeat(n) + s).slice(-n);
  console.log(hdr('Status',7) + hdr('Name',28) + hdr('Project',18) + hdr('Model',8) + rgt('Cost',8) + rgt('Turns',6));
  console.log('\u2500'.repeat(95));

  for (const s of show) {
    const status = s.isRunning ? '[RUN]' : '';
    const name = (s.customTitle || s.slug || s.sessionId.slice(0,12)).slice(0,26);
    const project = ((s.projectPath || '').split('/').pop() || '-').slice(0,16);
    const model = (s.model || '-').replace('claude-','').replace('opus-4-6','opus').replace('sonnet-4-6','sonnet').slice(0,7);
    const cost = s.totalCostUsd ? '\$' + s.totalCostUsd.toFixed(2) : '-';
    const turns = String(s.numTurns || '-');
    console.log(hdr(status,7) + hdr(name,28) + hdr(project,18) + hdr(model,8) + rgt(cost,8) + rgt(turns,6));
  }

  // Running executions
  const exData = await api('/monitor/executions');
  if (exData?.data?.executions) {
    const re = exData.data.executions.filter(e => e.isRunning);
    if (re.length) {
      console.log('\nRunning Executions (' + re.length + '):');
      for (const e of re) {
        const eid = (e.executionId || '').slice(0,12);
        const t = e.turnCount || 0;
        const c = (e.costUsd || 0).toFixed(2);
        const elapsed = Math.floor((e.elapsedMs || 0) / 1000);
        const mins = Math.floor(elapsed / 60);
        const secs = elapsed % 60;
        console.log('  ' + eid + '  T:' + t + '  \$' + c + '  ' + mins + 'm' + secs + 's');
      }
    }
  }

  const totalCost = sessions.reduce((a, s) => a + (s.totalCostUsd || 0), 0);
  console.log('\u2500'.repeat(95));
  console.log('Total cost: \$' + totalCost.toFixed(2));
})();
" -- "$ARGUMENTS[0]"
```

## Output

Present the script output directly. Do NOT reformat as markdown — show it as-is from the terminal.
