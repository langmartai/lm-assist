---
allowed-tools: Bash
description: Show lm-assist component status
---

# /assist-status — Component Status

Check the status of all lm-assist components: API server, web UI, MCP server, hooks, statusline, hub, and knowledge stats.

## Steps

Run all status checks (proceed through each even if some fail):

1. **API Server** — Check health:
```bash
curl -s --max-time 2 http://localhost:3100/health
```

2. **API Status** — Get uptime and project path:
```bash
curl -s --max-time 2 http://localhost:3100/status
```

3. **Web UI** — Check if the web server responds:
```bash
curl -s --max-time 2 -o /dev/null -w "%{http_code}" http://localhost:3848
```

4. **MCP Server** — Check installation:
```bash
curl -s --max-time 3 http://localhost:3100/claude-code/mcp
```

5. **Context Hook** — Check installation:
```bash
curl -s --max-time 3 http://localhost:3100/claude-code/context-hook
```

6. **Statusline** — Check installation:
```bash
curl -s --max-time 3 http://localhost:3100/claude-code/statusline
```

7. **Hub Client** — Check connection:
```bash
curl -s --max-time 3 http://localhost:3100/hub/status
```

8. **Knowledge Stats** — Get knowledge entry count:
```bash
curl -s --max-time 3 http://localhost:3100/knowledge
```

## Output Format

Present a clean status dashboard:

```
lm-assist Status
================

Core Services:
  API Server:    [running/stopped] (uptime, project path)
  Web UI:        [running/stopped] (http://localhost:3848)

Claude Code Integration:
  MCP Server:    [installed/not installed] (tools: search, detail, feedback)
  Context Hook:  [installed/not installed]
  Statusline:    [installed/not installed]

Hub:
  Connection:    [connected/disconnected/not configured]

Knowledge:
  Entries:       N knowledge entries
```

If the API is not running, show that first and note that other checks require the API. Suggest `/assist-setup` to install everything.
