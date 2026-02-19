---
allowed-tools: Bash
description: Open the lm-assist web UI in a browser
---

# /assist — Open Web UI

Check if the lm-assist API is running, then open the web UI.

## Steps

1. Check if the API is healthy:
```bash
curl -s --max-time 2 http://localhost:3100/health
```

2. If the API is running, get the status for details:
```bash
curl -s --max-time 2 http://localhost:3100/status
```

3. If the API is healthy, open the web UI in the user's browser:
```bash
open http://localhost:3848 2>/dev/null || xdg-open http://localhost:3848 2>/dev/null || echo "Open http://localhost:3848 in your browser"
```

4. If the API is **not** running, tell the user:
   - The lm-assist services are not running
   - They can start them with: `./core.sh start` (from the lm-assist directory)
   - Or run `/assist-setup` to do a full install and start

## Output Format

If healthy, report:
- API status (healthy)
- Web UI URL: `http://localhost:3848`
- Project path and uptime from the status response

If not healthy, report the services are down and suggest starting them.

## Arguments

If the user passes `$ARGUMENTS`, treat them as ignored — this command takes no arguments.
