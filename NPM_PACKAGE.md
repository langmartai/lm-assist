# LM Assist npm Package

LM Assistant is now available as an npm package for easy installation and deployment.

## Installation

### Global Installation
```bash
npm install -g lm-assist
```

### Local Project Installation
```bash
npm install lm-assist
```

### Using npx (No Installation)
```bash
npx lm-assist start
```

## Quick Start

### Start Services
```bash
lm-assist start
```

This starts:
- **API Server** on http://localhost:3100
- **Web UI** on http://localhost:3848

### Other Commands
```bash
lm-assist stop              # Stop all services
lm-assist restart           # Restart services
lm-assist status            # Check service health
lm-assist logs core         # View API logs
lm-assist logs web          # View Web UI logs
lm-assist build             # Rebuild application
lm-assist hub start         # Connect to LangMart Hub
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

### Context Hook Logs
![Context Hook Logs](https://raw.githubusercontent.com/langmartai/lm-assist/main/docs/screenshots/preview/context-hook-logs.png)

### Settings
![Settings](https://raw.githubusercontent.com/langmartai/lm-assist/main/docs/screenshots/preview/settings.png)

## Configuration

### Environment Variables
Create a `.env` file in your working directory:

```bash
ANTHROPIC_API_KEY=sk-your-key-here
API_PORT=3100
WEB_PORT=3848
TIER_AGENT_HUB_URL=wss://hub.example.com
TIER_AGENT_API_KEY=sk-hub-api-key
```

See `.env.example` in the package for all available options.

## Requirements

- **Node.js:** 18.0.0 or higher
- **npm:** 9.0.0 or higher
- **Python:** 3.8+ (for ttyd support)

## Package Contents

The npm package includes:

- **Backend API** — Node.js/TypeScript REST API with:
  - Session management
  - Knowledge base with vector search
  - MCP server for context integration
  - Hub client for remote relay

- **Frontend UI** — Next.js 16 with React 19 providing:
  - Session browsing and management
  - Knowledge views
  - Settings and configuration
  - Real-time terminal integration

## Data Storage

All data is stored locally:

- **Sessions:** `~/.claude/projects/*/sessions/*.jsonl`
- **Tasks:** `~/.claude/tasks/`
- **Config:** `~/.lm-assist/`
- **Knowledge:** `~/.lm-assist/knowledge`

## API Endpoints

The API server (port 3100) provides endpoints for:

- **Sessions:** `/sessions`, `/sessions/:id`
- **Projects:** `/projects`, `/projects/:path/sessions`
- **Tasks:** `/tasks`, `/task-store/tasks`
- **Knowledge:** `/knowledge`, `/knowledge/search`
- **Health:** `/health`, `/status`

See the [GitHub repository](https://github.com/langmartai/lm-assist) for complete API documentation.

## License

GNU Affero General Public License v3 (AGPL-3.0-or-later)

All modifications and derivative works must be licensed under the same terms.

## Support

- **GitHub:** https://github.com/langmartai/lm-assist
- **Issues:** https://github.com/langmartai/lm-assist/issues

## Development

For development installation from source:

```bash
git clone https://github.com/langmartai/lm-assist.git
cd lm-assist
npm install
npm run build
./core.sh start
```

## Troubleshooting

### Port Already in Use
```bash
lm-assist start --api-port 3101 --web-port 3849
```

### Clear Cache and Rebuild
```bash
lm-assist clean
lm-assist build
```

### View Detailed Logs
```bash
lm-assist logs core
lm-assist logs web
```

### Hub Connection Issues
```bash
lm-assist hub status
lm-assist hub logs
```
