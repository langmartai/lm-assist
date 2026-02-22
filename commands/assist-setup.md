---
allowed-tools: Bash, Read, Edit
description: Install lm-assist npm package and register MCP server
---

# /assist-setup — Install lm-assist

Install the lm-assist npm package globally and register the MCP server in the plugin config.

## Steps

### 1. Install the npm package

Check if already installed, then install or update:
```bash
npm list -g lm-assist --depth=0 2>/dev/null
npm install -g lm-assist
```

### 2. Find the install path

Get the npm global prefix to build the MCP server path:
```bash
npm prefix -g
```

The MCP server entry point is at:
- **Linux/macOS**: `<npm-prefix>/lib/node_modules/lm-assist/core/dist/mcp-server/index.js`
- **Windows**: `<npm-prefix>/node_modules/lm-assist/core/dist/mcp-server/index.js`

Verify the file exists:
```bash
ls "<computed-path>" 2>/dev/null
```

### 3. Register MCP server in the plugin

Read and update the plugin's `.mcp.json` file at `~/.claude/plugins/cache/langmartai/lm-assist/<version>/.mcp.json`.

Find the correct path:
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

Also update `~/.claude/plugins/marketplaces/langmartai/.mcp.json` with the same content.

### 4. Report result

Tell the user:
- Installation complete
- MCP server registered in plugin
- Restart Claude Code to load the MCP server
- Then type `/assist` to open the web UI
