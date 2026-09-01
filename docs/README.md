# lm-assist Documentation

Organized index of everything under `docs/`. Files keep their historical paths (many are deep-linked
from elsewhere); this page is the navigation layer.

## Start here

- [how-it-works.md](./how-it-works.md) — how the pieces fit: Core API, Web UI, MCP server, hooks, statusline
- [install-and-modes.md](./install-and-modes.md) — install paths, dev vs prod modes, which port is serving
- [build-pack-install-upgrade.md](./build-pack-install-upgrade.md) — the authoritative build → pack → install → upgrade → deploy reference
- [deploy-prod.md](./deploy-prod.md) — production deployment
- [experimental.md](./experimental.md) — experimental flags and features

## Architecture & internals

- [architecture.md](./architecture.md) — Core/Web split, route handler pattern, `RouteContext`, `ApiResponse` (+ [diagram](./architecture-diagram.svg))
- [claude-code-session-internals.md](./claude-code-session-internals.md) — the JSONL session format lm-assist parses
- [cross-node-transport-map.md](./cross-node-transport-map.md) — how bytes move between nodes: relay, bus, port-forward
- [cloud-worker-orchestration.md](./cloud-worker-orchestration.md) — cloud worker sessions and their lifecycle
- [session-knowledge-reuse.md](./session-knowledge-reuse.md) — knowledge extraction and reuse pipeline
- [terminal-refactor.md](./terminal-refactor.md) — terminal subsystem design notes

## API reference

- [api-endpoints.md](./api-endpoints.md) — the Core REST API: endpoints, query params, the three session indexing dimensions
- [claude-code-routes.md](./claude-code-routes.md) — Claude Code OAuth proxy surface (14 endpoints)
- [claude-ai-routes.md](./claude-ai-routes.md) — claude.ai web-session proxy surface (28 endpoints, cookie + via-Chrome paths)
- [github-routes.md](./github-routes.md) — GitHub integration routes
- [terminal-api.md](./terminal-api.md) — web terminal + tmux driving API
- [cowork-web-endpoints.md](./cowork-web-endpoints.md) — claude.ai Cowork control-channel endpoints

## Feature guides

- [mission-control.md](./mission-control.md) — missions, the controller, auto-resume, model fallback, scheduled passes
- [session-messaging.md](./session-messaging.md) — sending input to live sessions; submit/delivery verification
- [memory-reads.md](./memory-reads.md) — memory files, cross-host memory, project resolution
- [backlog-registry.md](./backlog-registry.md) — the backlog graph and fleet-synced registry write rules
- [node-placement.md](./node-placement.md) — node identity, clusters, selection, placement
- [hub-client.md](./hub-client.md) — hub connection, config resolution, relay
- [web-deployment-and-hub-auth.md](./web-deployment-and-hub-auth.md) — web deployment + hub authentication flow
- [ui-panes-deploy.md](./ui-panes-deploy.md) — pluggable UI panes: build, sync, tokens, gateway-hosted panes
- [claude-ai.md](./claude-ai.md) — claude.ai integration: conversations, rename, tokens, fork
- [voice.md](./voice.md) — browser voice for claude.ai conversations (+ [HTTPS transport](./voice-https-transport.md), [wire protocol](./claude-ai-voice-protocol.md))

## MCP & plugins

- [mcp-surfaces.md](./mcp-surfaces.md) — the MCP server: tool registration, resolver hot path, description budgets
- [mcp-plugins-bundled.md](./mcp-plugins-bundled.md) — bundled first-party plugins: vendoring, trust, checksums, opt-out
- [mcp-plugin-contract.md](./mcp-plugin-contract.md) — the ext-plugin contract (`ext__<plugin>__<tool>`) + [JSON schema](./mcp-plugin.schema.json)
- [plugin-and-hooks.md](./plugin-and-hooks.md) — the Claude Code plugin, hooks, statusline, slash commands
- [mcp-tool-output-audit.md](./mcp-tool-output-audit.md) — output-bound audit across all tools
- [mcp-output-size-offenders.md](./mcp-output-size-offenders.md) — result-size ceiling findings

## Service connectors

- [gmail-connector.md](./gmail-connector.md) — Gmail over CDP: endpoint strategy, profiles, tools
- [linkedin-connector.md](./linkedin-connector.md) — LinkedIn over CDP: virtualized lists, accumulation model
- [whatsapp-connector.md](./whatsapp-connector.md) — WhatsApp connector
- [vm-management.md](./vm-management.md) — VM tools over Hyper-V and KVM; input charset boundaries
- [container-management.md](./container-management.md) — Docker tools; managed labels, volume roots

## Working notes & records

- [perf/](./perf/) — performance investigations
- [reviews/](./reviews/) — review records
- [plans/](./plans/) — implementation plans
- [superpowers/](./superpowers/) — design specs (`specs/`) and plans written with the superpowers workflow
- [skills-reference/](./skills-reference/) — skills reference material
- [mission-onboarding-multiphase-review.md](./mission-onboarding-multiphase-review.md) — multi-phase review record of mission onboarding
- [screenshots/](./screenshots/) — UI screenshots used by the README and npm page
