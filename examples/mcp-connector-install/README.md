# Install the lm-assist MCP connector

Goal: every capability of your fleet — sessions, search, memory, terminal driving, missions,
connectors, VMs, containers — available as MCP tools inside **Claude Code** and **claude.ai**.

## Claude Code (automatic on enrollment)

Enrolling a machine into your fleet registers the hub MCP server for Claude Code in the same step:

```bash
# on an already-enrolled node: mint a one-time keypack
lm-assist login --new-node          # prints lmkp_…

# on the new machine: redeem it
lm-assist login <lmkp_…>
#   ✓ Registered 'langmart' MCP for Claude Code — worker-role tools load in NEW sessions
```

That writes the hub MCP entry (URL + key, owner-only `0600`) into `~/.claude.json`, so every **new**
Claude Code session on that machine carries the tools. Opt out with `--no-mcp`. The connection rides
the always-up hub `/mcp` endpoint, so there is no local-Core startup-ordering problem.

## claude.ai (one-time custom connector)

1. claude.ai → **Settings → Connectors → Add custom connector**
2. URL: `https://mcp.<your-hub-domain>/mcp` (the hub derives it from your hub URL — e.g. a hub at
   `wss://assist-api.example.com` serves MCP at `https://mcp.example.com/mcp`)
3. Complete the sign-in the connector prompts for.

## First call: `bootstrap`

In any connected conversation, call `bootstrap` once with no arguments. It loads the complete set
of use-case playbooks — what the fleet can do and how — paged so nothing is truncated. From then on
`guide(topic)` answers "how do I …" questions on demand.

## Managing the surface

The **MCP Tools** page shows every tool the Core exposes — scope badges, per-tool description
overrides and enable/disable, synced fleet-wide through the registry:

![MCP Tools page with the bootstrap tool selected](./mcp-tools-bootstrap.png)

From a conversation, the same management is available as tools: `refresh_connector_tools` (clear
claude.ai's cached tool list and refetch), `set_connector_tool_access`, `set_connector_auto_approve`.
