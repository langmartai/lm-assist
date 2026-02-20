# Experimental Features

> These features are under active development and may change.

## Milestones

Milestones are key achievements automatically extracted from Claude Code sessions using LLM-powered summaries. They provide a high-level view of what was accomplished across sessions.

- Extracted per session via the milestone pipeline
- Viewable in the web UI under each session
- Searchable via the MCP `search` tool and `/assist-search`
- Available via REST API: `GET /milestones/:sessionId`

Trigger extraction manually:

```bash
curl -X POST http://localhost:3100/milestone-pipeline/extract
```

## Architecture Models

Architecture models are auto-generated documentation of your project's structure, derived from the codebase and session history.

- Generated on demand from your source files and past sessions
- Viewable in the web UI under the **Architecture** page
- Searchable via the MCP `search` tool
- Available via REST API: `GET /architecture`

Generate or regenerate:

```bash
curl -X POST http://localhost:3100/architecture/generate
```

Both features require an `ANTHROPIC_API_KEY` set in `.env`.

## FlowGraph (DAG Tab)

The FlowGraph tab visualises the message dependency graph for a session — showing branches, forks, and the order of tool calls as a flow diagram.

Enabled alongside other experimental features via **Settings → Experiment → Enable experiment features**.
When disabled, the tab is hidden from the session detail view.
