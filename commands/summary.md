---
allowed-tools: Bash
description: Summarize the current session — what we're working on, what was done, current state
---

# /summary — Current Session Summary

Generate or refresh a summary of THIS session. Shows what we're working on, what was accomplished, and current state. Used by the routing system to ensure new prompts stay in the right session.

## Steps

1. **Get the current session ID:**
```bash
echo "Session ID: $CLAUDE_SESSION_ID"
echo "Project: $PWD"
```

2. **Check if a summary already exists for this session:**
```bash
curl -s --max-time 3 "http://localhost:3100/sessions/$CLAUDE_SESSION_ID/summary" | python3 -c "
import sys,json
d = json.load(sys.stdin).get('data')
if d and d.get('summary'):
    print(f'Existing summary (built to turn {d.get(\"lastTurnIndex\",0)}):')
    print(f'  Display name: {d.get(\"displayName\",\"(none)\")}')
    print(f'  Summary: {d.get(\"summary\")}')
else:
    print('No summary exists yet.')
"
```

3. **Read the conversation to understand what this session has done:**

If no summary exists, read the full conversation. If a summary exists but is stale (new turns since last summary), read only the new turns.

```bash
# For new summary: read last 20 turns
curl -s --max-time 5 "http://localhost:3100/sessions/$CLAUDE_SESSION_ID/conversation?toolDetail=summary&lastN=20" | python3 -c "
import sys,json
d = json.load(sys.stdin).get('data',{})
messages = d.get('messages',[])
print(f'{len(messages)} messages in last 20 turns')
for m in messages:
    role = m.get('type','')
    content = (m.get('content','') or '')[:200]
    if role == 'human' and content:
        print(f'  USER: {content}')
    elif role == 'assistant' and len(content) > 50:
        print(f'  CLAUDE: {content[:150]}')
"
```

4. **Generate the summary by analyzing what you just read from the conversation.**

The summary must answer:
- **What is this session about?** — the overall goal/theme
- **What has been accomplished?** — key milestones, files changed, features built
- **Current state?** — what we're working on RIGHT NOW, any blockers
- **Key context** — important decisions made, patterns established, things to remember

Also generate a **display name** (2-4 words, kebab-case) if this session doesn't already have a customTitle.

5. **Get the current turn count for tracking:**
```bash
curl -s --max-time 3 "http://localhost:3100/sessions/$CLAUDE_SESSION_ID" | python3 -c "
import sys,json
d = json.load(sys.stdin).get('data',{})
print(f'turns={d.get(\"numTurns\",0)} cost=\${d.get(\"totalCostUsd\",0):.2f} slug={d.get(\"slug\",\"\")}')
"
```

6. **Save the summary:**
```bash
curl -s -X PUT "http://localhost:3100/sessions/$CLAUDE_SESSION_ID/summary" \
  -H 'Content-Type: application/json' \
  -d '{
    "summary": "YOUR_GENERATED_SUMMARY",
    "displayName": "YOUR_DISPLAY_NAME",
    "slug": "SESSION_SLUG",
    "projectPath": "PROJECT_PATH",
    "lastTurnIndex": CURRENT_TURN_COUNT,
    "totalTurns": CURRENT_TURN_COUNT
  }'
```

7. **Rename the session** if it doesn't have a customTitle and you generated a displayName:
```
/rename YOUR_DISPLAY_NAME
```

8. **Record learning signals** from what this session is about:
```bash
curl -s -X POST http://localhost:3100/learn \
  -H 'Content-Type: application/json' \
  -d '{
    "signals": [
      {"type": "keyword", "value": "MAIN_TOPIC", "projectPath": "PROJECT_PATH", "projectName": "PROJECT_NAME"},
      {"type": "area", "value": "AREA_OF_PROJECT", "projectPath": "PROJECT_PATH"}
    ]
  }'
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
  • MILESTONE_1
  • MILESTONE_2
  • MILESTONE_3

Current state:
  WHAT_WE_ARE_DOING_NOW

Key context:
  • IMPORTANT_DECISION_1
  • PATTERN_ESTABLISHED
```

If `$ARGUMENTS` contains text, treat it as additional context to include in the summary (e.g., `/summary just finished the routing tests`).
