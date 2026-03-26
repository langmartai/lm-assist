---
allowed-tools: Bash
description: Summarize the current session — what we're working on, what was done, current state
---

# /summary — Current Session Summary

Generate or refresh a summary of THIS session. Shows what we're working on, what was accomplished, and current state. Used by the routing system to ensure new prompts stay in the right session.

## Step 1: Gather all session data

Run this single script to collect session ID, existing summary, conversation, and metadata:

```bash
node -e "
const http = require('http');
const cwd = process.cwd();
const projectName = cwd.split('/').pop();

function api(path, timeout = 5000) {
  return new Promise((resolve) => {
    const req = http.get('http://localhost:3100' + path, { timeout }, (res) => {
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
    console.log('ERROR: lm-assist API is not running. Start with: lm-assist start');
    return;
  }

  // Detect current session — most recent for this project
  const sessions = await api('/sessions?cwd=' + encodeURIComponent(cwd) + '&limit=3');
  const sid = sessions?.data?.sessions?.[0]?.sessionId;
  if (!sid) {
    console.log('ERROR: Could not determine session ID');
    return;
  }

  console.log('Session: ' + sid);
  console.log('Project: ' + cwd);

  // Existing summary
  console.log('\n--- EXISTING SUMMARY ---');
  const summary = await api('/sessions/' + sid + '/summary');
  if (summary?.data?.summary) {
    const d = summary.data;
    console.log('Display name: ' + (d.displayName || '(none)'));
    console.log('Last turn index: ' + (d.lastTurnIndex || 0));
    console.log('Summary: ' + d.summary);
  } else {
    console.log('No summary exists yet.');
  }

  // Session metadata
  console.log('\n--- SESSION METADATA ---');
  const meta = await api('/sessions/' + sid);
  if (meta?.data) {
    const d = meta.data;
    console.log('turns=' + (d.numTurns || 0));
    console.log('cost=\$' + (d.totalCostUsd || 0).toFixed(2));
    console.log('slug=' + (d.slug || ''));
    console.log('customTitle=' + (d.customTitle || ''));
    console.log('model=' + (d.model || ''));
    console.log('status=' + (d.status || ''));
  }

  // Conversation (last 20 turns)
  console.log('\n--- CONVERSATION ---');
  const conv = await api('/sessions/' + sid + '/conversation?toolDetail=summary&lastN=20', 10000);
  if (conv?.data?.messages?.length) {
    const msgs = conv.data.messages;
    console.log(msgs.length + ' messages in last 20 turns');
    for (const m of msgs) {
      const content = (m.content || '').slice(0, 200);
      if (m.type === 'human' && content) console.log('  USER: ' + content);
      else if (m.type === 'assistant' && content.length > 50) console.log('  CLAUDE: ' + content.slice(0, 150));
    }
  } else {
    console.log('No conversation data available.');
  }
})();
"
```

## Step 2: Generate the summary

Analyze the data from Step 1 and generate:

- **Summary text** — what this session is about, what was accomplished, current state, key context
- **Display name** — 2-4 words, kebab-case (if no customTitle exists)
- **Learning signals** — main topic keyword and area of project

## Step 3: Save summary and record learning

Run this single script to save the summary AND record learning signals in one call. Replace the placeholder values with your generated content:

```bash
node -e "
const http = require('http');
const sessionId = process.argv[1];
const cwd = process.cwd();
const projectName = cwd.split('/').pop();

// Replace these with generated values
const summary = process.argv[2];
const displayName = process.argv[3];
const turnCount = parseInt(process.argv[4]) || 0;
const keyword = process.argv[5];
const area = process.argv[6];

function apiPost(path, body, method = 'POST') {
  return new Promise((resolve) => {
    const payload = JSON.stringify(body);
    const url = new URL('http://localhost:3100' + path);
    const req = http.request({ hostname: url.hostname, port: url.port, path: url.pathname, method, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }, timeout: 5000 }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.write(payload);
    req.end();
  });
}

(async () => {
  // Save summary
  const result = await apiPost('/sessions/' + sessionId + '/summary', {
    summary, displayName, projectPath: cwd,
    lastTurnIndex: turnCount, totalTurns: turnCount
  }, 'PUT');
  const saved = result?.success || false;

  // Record learning signals
  const learn = await apiPost('/learn', {
    signals: [
      { type: 'keyword', value: keyword, projectPath: cwd, projectName },
      { type: 'area', value: area, projectPath: cwd }
    ]
  });
  const learned = learn?.success || false;

  console.log('Summary: ' + (saved ? 'saved' : 'failed') + ' | Learning: ' + (learned ? 'recorded' : 'failed'));
})();
" -- "SESSION_ID" "YOUR_GENERATED_SUMMARY" "YOUR_DISPLAY_NAME" "TURN_COUNT" "MAIN_TOPIC" "AREA_OF_PROJECT"
```

## Step 4: Rename session (if needed)

If the session doesn't have a customTitle, rename it:
```
/rename YOUR_DISPLAY_NAME
```

## Output

Present the summary clearly:

```
Session Summary
═══════════════
Name:    SESSION_DISPLAY_NAME
Project: PROJECT_NAME
Turns:   N | Cost: $X.XX
Status:  in progress / completed / blocked

What this session is about:
  OVERALL_GOAL_DESCRIPTION

What was accomplished:
  - MILESTONE_1
  - MILESTONE_2
  - MILESTONE_3

Current state:
  WHAT_WE_ARE_DOING_NOW

Key context:
  - IMPORTANT_DECISION_1
  - PATTERN_ESTABLISHED
```

If `$ARGUMENTS` contains text, treat it as additional context to include in the summary (e.g., `/summary just finished the routing tests`).
