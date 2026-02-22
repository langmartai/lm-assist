---
allowed-tools: Bash
description: Install and configure all lm-assist components
---

# /assist-setup — One-Command Installer

Start lm-assist services and ensure all Claude Code integrations are working.

**Note:** If lm-assist was installed as a Claude Code plugin (`claude plugin install`), the MCP server and hooks (context injection) are already registered automatically. This command focuses on starting services, verifying the integrations, and optionally installing the statusline.

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

### 2. Install Dependencies & Build

Check if dependencies are installed and code is built:
```bash
# Check if node_modules exists (from the lm-assist directory)
ls <lm-assist-dir>/node_modules/.package-lock.json 2>/dev/null
```

If `node_modules` doesn't exist, install dependencies:
```bash
cd <lm-assist-dir> && npm install
```

Check if core is built:
```bash
ls <lm-assist-dir>/core/dist/cli.js 2>/dev/null
```

If `core/dist` doesn't exist, build:
```bash
cd <lm-assist-dir> && npm run build:core
```

### 3. Start Services

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

### 4. Verify MCP Server

Check if the MCP server is reachable (it may be registered by the plugin or manually):
```bash
curl -s --max-time 3 http://localhost:3100/claude-code/mcp
```

If not installed (e.g., non-plugin install), install it:
```bash
curl -s -X POST http://localhost:3100/claude-code/mcp/install
```

### 5. Verify Context Hook

Check if the context-inject hook is active (registered by plugin hooks or manually):
```bash
curl -s --max-time 3 http://localhost:3100/claude-code/context-hook
```

If not installed (e.g., non-plugin install), install it:
```bash
curl -s -X POST http://localhost:3100/claude-code/context-hook/install
```

### 6. Install Statusline (Optional)

The statusline is not installed by the plugin — it's optional. Check and offer to install:
```bash
curl -s --max-time 3 http://localhost:3100/claude-code/statusline
```

If not installed, ask the user if they want it, then install:
```bash
curl -s -X POST http://localhost:3100/claude-code/statusline/install
```

### 7. Verify

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

[1/5] Installing dependencies...     done (already installed)
[2/5] Starting services...          done
[3/5] Verifying MCP server...       active (tools: search, detail, feedback)
[4/5] Verifying context hook...     active
[5/5] Verifying installation...     all components healthy

Setup complete!
  Web UI: http://localhost:3848
  Statusline: not installed (optional — run /assist-setup --statusline to add)
  Run /assist-status to check component status
  Run /assist-search <query> to search your knowledge base
```

If any step fails, report the specific error and continue with remaining steps. Summarize what succeeded and what needs attention at the end.

## Arguments

Parse `$ARGUMENTS` for:
- `--statusline`: Also install the statusline (without this flag, just ask the user)
- Everything else is ignored
