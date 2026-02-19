---
allowed-tools: Bash
description: View context-inject hook logs
---

# /assist-logs — Context Inject Hook Logs

Query the context-inject hook log to see what knowledge and milestones are being injected into Claude Code sessions.

## Steps

1. Check if the API is healthy:
```bash
curl -s --max-time 2 http://localhost:3100/health
```

If the API is not running, tell the user to start services with `./core.sh start` or run `/assist-setup`.

2. Fetch the context-inject hook logs:
```bash
curl -s "http://localhost:3100/assist-resources/log?file=context-inject-hook.log&limit=${LIMIT}&search=${SEARCH}"
```

## Arguments

Parse `$ARGUMENTS` for:
- `--limit N` or `-n N`: Number of log lines to return (default: 50)
- `--search TERM` or `-s TERM`: Filter logs by search term
- Any other text: Treat as a search term

Examples:
- `/assist-logs` — Show last 50 log entries
- `/assist-logs --limit 20` — Show last 20 entries
- `/assist-logs knowledge` — Filter for entries containing "knowledge"
- `/assist-logs --search error --limit 100` — Search for errors, show up to 100

## Output Format

Display the log entries in a readable format:
- For each entry, show the timestamp, event type, and relevant details
- If entries are empty, tell the user no logs were found (the hook may not be installed — suggest `/assist-setup`)
- Summarize the total number of entries and any patterns you notice
