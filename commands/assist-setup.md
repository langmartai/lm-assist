---
allowed-tools: Bash, Read, Edit
description: Install lm-assist services, statusline, and optionally MCP/hooks
---

# /assist-setup — Setup lm-assist

Install the lm-assist npm package, start services, install the statusline, and optionally register MCP server and context hook.

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

### 3. Install statusline (always)

The statusline shows context %, rate limits, cost, and process info in the terminal status bar.

```bash
curl -s -X POST http://localhost:3100/claude-code/statusline/install
```

### 4. Optionally install MCP server and context hook

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

### 5. Report result

Tell the user:
- lm-assist services running (API :3100, Web :3848)
- Statusline installed
- Skills and commands available: `/sessions`, `/summary`, `/run`
- Web UI: `http://localhost:3848`
- If MCP was installed: MCP server registered, restart Claude Code to activate
- If MCP was NOT installed: "Run `/assist-setup --mcp` to add knowledge tools"
