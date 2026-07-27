# Plugin, hooks and slash commands

> Read before changing the plugin manifest, the context-inject hook, or a slash command.
>
> Split out of the repo [CLAUDE.md](../CLAUDE.md) so it is read on demand instead of loaded into every session. Content is unchanged.

## Hook Scripts (`core/hooks/`)

| Script | Platform | Description |
|--------|----------|-------------|
| `context-inject-hook.js` | All (Node.js) | Cross-platform context injection hook (Windows, macOS, Linux) |
| `statusline-worktree.sh` | Linux/macOS | Claude Code status line showing git branch, session info |

The **context-inject hook** is the primary hook. It uses Node.js for cross-platform support (no shell dependencies like jq, curl, or flock).

## Plugin / Slash Commands

lm-assist is packaged as a Claude Code plugin. On `claude plugin install .`, the plugin auto-registers:
- **MCP server** (`lm-assist`) — search, detail, feedback tools
- **Hook** — context injection (UserPromptSubmit) via cross-platform Node.js script
- **Slash commands** — 6 commands for managing lm-assist

The **statusline** is optional and not auto-installed by the plugin.

**Plugin structure:**
- `.claude-plugin/plugin.json` — Plugin metadata
- `.mcp.json` — MCP server auto-registration
- `hooks/hooks.json` — Hook auto-registration (context-inject only)
- `commands/` — Slash command definitions

**Slash commands:**

| Command | Description |
|---------|-------------|
| `/assist` | Open the web UI — checks API health, opens browser or prints URL |
| `/assist-logs` | View context-inject hook logs (`GET /assist-resources/log?file=context-inject-hook.log`) |
| `/assist-mcp-logs` | View MCP tool call logs (`GET /assist-resources/log?file=mcp-calls.jsonl`) |
| `/assist-search` | Search the knowledge base (`GET /knowledge/search?q=...`) |
| `/assist-status` | Show status of all components — API, web, MCP, hooks, statusline, hub, knowledge |
| `/assist-setup` | Start services and verify integrations (statusline optional via `--statusline`) |

All commands call the existing REST API with `curl` on the active port (dev :3200, prod :3100). If the API is not running, commands advise the user to start it or run `/assist-setup`.

**Install methods:**
- Plugin: `claude plugin install .` (from repo root)
- npm global: `npm install -g lm-assist` then `/assist-setup`
