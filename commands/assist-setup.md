---
allowed-tools: Bash, Read, Edit
description: Install lm-assist services, claude-code-multisession skills, statusline, and optionally MCP/hooks
---

# /assist-setup — Setup lm-assist

Install lm-assist services, auto-install claude-code-multisession skills plugin if missing, install statusline, and optionally register MCP server.

## Steps

### 1. Install the npm package

```bash
npm list -g lm-assist --depth=0 2>/dev/null
npm install -g lm-assist
```

### 2. Start services

```bash
lm-assist start
```

Verify health:
```bash
curl -s --max-time 3 http://localhost:3100/health
```

### 3. Install claude-code-multisession plugin (if not installed)

Check if claude-code-multisession is already installed. If not, add marketplace and install it — this provides the observe/route skills and /sessions, /summary, /run commands.

```bash
# Check if claude-code-multisession is installed
claude plugin list 2>/dev/null | grep -q "claude-code-multisession" && echo "claude-code-multisession: installed" || echo "claude-code-multisession: not installed"
```

If not installed:
```bash
claude plugin marketplace add langmartai/lm-assist 2>/dev/null
claude plugin install claude-code-multisession@langmartai 2>/dev/null
```

### 4. Install statusline (always)

The statusline shows context %, rate limits, cost, and process info in the terminal status bar.

```bash
curl -s -X POST http://localhost:3100/claude-code/statusline/install
```

### 5. Optionally install MCP server and context hook

Only if the user wants knowledge features. Skip by default.

If `$ARGUMENTS` contains `--mcp` or `--knowledge` or `--all`:

```bash
# Find the install path
NPM_PREFIX=$(npm prefix -g)
# MCP server path
MCP_PATH="$NPM_PREFIX/lib/node_modules/lm-assist/core/dist/mcp-server/index.js"
# On Windows: $NPM_PREFIX/node_modules/lm-assist/core/dist/mcp-server/index.js
ls "$MCP_PATH" 2>/dev/null
```

Register MCP server in the plugin's `.mcp.json`:
```bash
ls ~/.claude/plugins/cache/langmartai/lm-assist/
```

Then use the Edit tool to update the `.mcp.json` to:
```json
{
  "mcpServers": {
    "lm-assist": {
      "command": "node",
      "args": ["<full-path-to>/core/dist/mcp-server/index.js"]
    }
  }
}
```

Also enable knowledge in project settings:
```bash
curl -s -X PUT http://localhost:3100/project-settings \
  -H 'Content-Type: application/json' \
  -d '{"knowledgeEnabled": true}'
```

### 6. Report result

Tell the user:
- lm-assist services running (API :3100, Web :3848)
- claude-code-multisession plugin installed (skills: observe, route; commands: /sessions, /summary, /run)
- Statusline installed
- Web UI: `http://localhost:3848`
- If MCP was installed: MCP server registered, restart Claude Code to activate
- If MCP was NOT installed: "Run `/assist-setup --mcp` to add knowledge tools"
- **Open a new Claude Code session** for skills to activate
