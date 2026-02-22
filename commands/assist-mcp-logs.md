---
allowed-tools: Bash
description: View MCP tool call logs
---

# /assist-mcp-logs — MCP Tool Call Logs

Query the MCP server's tool call log to see search, detail, and feedback calls made by Claude Code.

## Steps

1. Check if the API is healthy:
```bash
curl -s --max-time 2 http://localhost:3100/health
```

If the API is not running, tell the user to start services with `lm-assist start` or run `/assist-setup`.

2. Fetch the MCP call logs:
```bash
curl -s "http://localhost:3100/assist-resources/log?file=mcp-calls.jsonl&limit=${LIMIT}&search=${SEARCH}"
```

## Arguments

Parse `$ARGUMENTS` for:
- `--limit N` or `-n N`: Number of entries to return (default: 30)
- `--search TERM` or `-s TERM`: Filter by search term (matches tool name, args, results)
- Any other text: Treat as a search term

Examples:
- `/assist-mcp-logs` — Show last 30 MCP tool calls
- `/assist-mcp-logs search` — Filter for search tool calls
- `/assist-mcp-logs --search detail --limit 10` — Show last 10 detail calls
- `/assist-mcp-logs feedback` — Show feedback submissions

## Output Format

Display each MCP call showing:
- Timestamp
- Tool name (search, detail, or feedback)
- Arguments passed
- Duration (ms)
- Whether it succeeded or errored

Summarize usage patterns: which tools are called most, average response times, any errors.
