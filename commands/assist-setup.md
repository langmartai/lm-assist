---
allowed-tools: Bash
description: Install and configure all lm-assist components
---

# /assist-setup — One-Command Installer

Start lm-assist services and install all Claude Code integrations (MCP server, context hook, statusline).

## Steps

### 1. Locate lm-assist

Find the lm-assist installation directory. Check in order:
```bash
# Check if we're in the lm-assist directory
ls ./core.sh 2>/dev/null && echo "FOUND: $(pwd)"

# Check common locations
ls ~/lm-assist/core.sh 2>/dev/null && echo "FOUND: $HOME/lm-assist"

# Check if installed globally via npm
npm list -g lm-assist --depth=0 2>/dev/null
```

If not found, tell the user to clone or install lm-assist first.

### 2. Start Services

Check if the API is already running:
```bash
curl -s --max-time 2 http://localhost:3100/health
```

If not running, start services:
```bash
cd <lm-assist-dir> && ./core.sh start
```

Wait for the API to become healthy (check up to 5 times with 3-second intervals):
```bash
for i in 1 2 3 4 5; do
  curl -s --max-time 2 http://localhost:3100/health && break
  sleep 3
done
```

### 3. Install MCP Server

Check current status and install if needed:
```bash
curl -s --max-time 3 http://localhost:3100/claude-code/mcp
```

If not installed:
```bash
curl -s -X POST http://localhost:3100/claude-code/mcp/install
```

### 4. Install Context Hook

Check and install:
```bash
curl -s --max-time 3 http://localhost:3100/claude-code/context-hook
```

If not installed:
```bash
curl -s -X POST http://localhost:3100/claude-code/context-hook/install
```

### 5. Install Statusline

Check and install:
```bash
curl -s --max-time 3 http://localhost:3100/claude-code/statusline
```

If not installed:
```bash
curl -s -X POST http://localhost:3100/claude-code/statusline/install
```

### 6. Verify

Run a final status check:
```bash
curl -s --max-time 2 http://localhost:3100/health
curl -s --max-time 3 http://localhost:3100/claude-code/mcp
curl -s --max-time 3 http://localhost:3100/claude-code/context-hook
curl -s --max-time 3 http://localhost:3100/claude-code/statusline
```

## Output Format

Show progress as you go:

```
lm-assist Setup
===============

[1/5] Starting services...        done
[2/5] Installing MCP server...    done (tools: search, detail, feedback)
[3/5] Installing context hook...  done
[4/5] Installing statusline...    done
[5/5] Verifying installation...   all components healthy

Setup complete!
  Web UI: http://localhost:3848
  Run /assist-status to check component status
  Run /assist-search <query> to search your knowledge base
```

If any step fails, report the specific error and continue with remaining steps. Summarize what succeeded and what needs attention at the end.

## Arguments

`$ARGUMENTS` are ignored — this command always does a full setup.
