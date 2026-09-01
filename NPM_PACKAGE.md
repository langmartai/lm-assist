# LM Assist npm Package

lm-assist ships on npm as a prebuilt package — the Core API, the web dashboard, the MCP server, and the CLI in one install.

## Installation

```bash
npm install -g lm-assist        # global (recommended) — postinstall starts services
npx lm-assist start             # or run without installing
```

## Quick Start

```bash
lm-assist start
```

This starts:
- **Core API** on http://localhost:3100
- **Web UI** on http://localhost:3848

### Other Commands

```bash
lm-assist stop                    # Stop all services
lm-assist restart                 # Restart services
lm-assist status                  # Check service health
lm-assist logs core|web           # View logs
lm-assist upgrade                 # Upgrade to the latest published version
lm-assist upgrade --from <spec>   # Upgrade to a tgz / version / github:ref / URL
lm-assist login <keypack>         # Enroll this machine into a fleet
lm-assist hub start|stop|status   # Hub connection
```

## Screenshots

### Session Browser
![Session Browser](https://raw.githubusercontent.com/langmartai/lm-assist/main/docs/screenshots/preview/session-browser.png)

### Session Detail — Chat View
![Session Detail Chat](https://raw.githubusercontent.com/langmartai/lm-assist/main/docs/screenshots/preview/session-detail-chat.png)

### Session Terminal
![Session Terminal](https://raw.githubusercontent.com/langmartai/lm-assist/main/docs/screenshots/preview/session-terminal.png)

### Agent Tree
![Agent Tree](https://raw.githubusercontent.com/langmartai/lm-assist/main/docs/screenshots/preview/agent-tree.png)

### Plan View
![Plan View](https://raw.githubusercontent.com/langmartai/lm-assist/main/docs/screenshots/preview/plan-view.png)

### Task Kanban
![Task Kanban](https://raw.githubusercontent.com/langmartai/lm-assist/main/docs/screenshots/preview/task-kanban.png)

### Knowledge Base
![Knowledge Base](https://raw.githubusercontent.com/langmartai/lm-assist/main/docs/screenshots/preview/knowledge-base.png)

### Team View
![Team View](https://raw.githubusercontent.com/langmartai/lm-assist/main/docs/screenshots/preview/team-view.png)

### MCP Tool Logs
![MCP Tool Logs](https://raw.githubusercontent.com/langmartai/lm-assist/main/docs/screenshots/preview/mcp-tool-logs.png)

### Settings
![Settings](https://raw.githubusercontent.com/langmartai/lm-assist/main/docs/screenshots/preview/settings.png)

## Configuration

Optional — lm-assist works with your local Claude Code session data out of the box. Create a `.env` in your working directory to customize:

```bash
API_PORT=3100
WEB_PORT=3848
TIER_AGENT_HUB_URL=wss://hub.example.com   # optional fleet hub
TIER_AGENT_API_KEY=sk-hub-api-key          # optional hub key
```

See `.env.example` in the package for all available options.

## Requirements

- **Node.js:** 20.9 or higher
- **npm:** 9.0.0 or higher

## Package Contents

- **Core API** — REST API (860+ endpoints): sessions, monitor, agents, missions, memory, search, fleet, connectors
- **MCP server** — 280+ scope-gated tools for Claude Code and claude.ai, plus the ext-plugin loader and bundled first-party plugins
- **Web UI** — Next.js dashboard: session insight views, terminal, missions, memory/rules, settings
- **CLI** — `lm-assist` service manager with upgrade and fleet enrollment

## Data Storage

All data is stored locally:

- **Sessions:** `~/.claude/projects/` (read from Claude Code's own files)
- **Tasks:** `~/.claude/tasks/`
- **Config & state:** `~/.lm-assist/`

## License

GNU Affero General Public License v3 (AGPL-3.0-or-later). All modifications and derivative works must be licensed under the same terms.

## Support

- **GitHub:** https://github.com/langmartai/lm-assist
- **Issues:** https://github.com/langmartai/lm-assist/issues
- **Docs:** https://github.com/langmartai/lm-assist/tree/main/docs

## Development

```bash
git clone https://github.com/langmartai/lm-assist.git
cd lm-assist
npm install --ignore-scripts
npm run build
./core.sh start
```

See [`docs/build-pack-install-upgrade.md`](docs/build-pack-install-upgrade.md) for the full build/pack/upgrade reference.
