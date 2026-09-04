# The MCP connector — how Claude reaches lm-assist

> The main door. This page explains what the connector is, how it gets installed (you don't
> install it — lm-assist does, after it connects to the hub), why a relay sits in the middle,
> and how the 280+ tools are governed. Usage examples live in
> [`examples/mcp-connector-install`](../examples/mcp-connector-install/).

## What you see

In the Claude desktop app (and at claude.ai → Settings → Connectors) the connector shows up as
**lm-assist langmart**, type *Web · Custom*, with a green check once connected:

![Claude desktop app — Settings → Connectors, lm-assist langmart connected](../examples/mcp-connector-install/claude-app-connectors.png)

Inside any conversation, the composer's **+ → Connectors** submenu lists it with an on/off
toggle and a *Tool access* entry for per-tool approval:

![claude.ai conversation — the Connectors submenu with lm-assist langmart enabled](../examples/mcp-connector-install/claudeai-connector-menu-masked.png)

When it fires, the conversation shows *"Used lm-assist langmart integration"* above the reply
— see the real bootstrap-and-cross-node-sessions run in the
[connector example](../examples/mcp-connector-install/).

## Why there is a relay

Claude — whether that's claude.ai in a browser tab, a Cowork session, or the Claude desktop app —
runs in Anthropic's cloud, and an MCP connector must be an **HTTPS endpoint it can reach**. Your
machines are the opposite: behind NAT, on laptops that sleep, with no inbound ports. The hub
closes that gap:

```
claude.ai / Cowork / Claude app
        │  Streamable HTTP  POST https://mcp.<hub-domain>/mcp   (OAuth-bound connector)
        ▼
   LangMart Hub  ──── relays each MCP call over the node's own outbound WebSocket ────▶  node Core (:3100)
        ▲                                                                                     │
        └──────────────── result + provenance footer ⟦lm-assist@hub · node · cluster⟧ ◀──────┘
```

- Each node keeps **one outbound WebSocket** to the hub (`lm-assist login` / `setup --key`);
  nothing listens for inbound traffic on your machines.
- The hub serves the public MCP endpoint, derived from your hub URL
  (`wss://assist-api.<domain>` → `https://mcp.<domain>/mcp`), authenticates the caller, and
  forwards the call to the node the request names (or your default node). Cross-node reach —
  a claude.ai chat reading a session on your Windows box and driving a terminal on your Linux
  server — is this relay doing its job.
- **Claude Code on the same machine doesn't need the relay**: it spawns the MCP server over
  **stdio** and talks to the local Core directly. Both transports expose the same server and
  the same tool registry.

## Installed for you, after the hub connect

You don't add a URL by hand. Once a node connects to the hub, the connector — an OAuth client
for the public MCP endpoint, bound to your user — is provisioned automatically and appears under
Connectors as *lm-assist langmart*. Enrollment does the same for Claude Code: `lm-assist login
<keypack>` writes the hub MCP server into `~/.claude.json` (owner-only), so every new Claude
Code session on that machine carries the tools (`--no-mcp` opts out).

Two things happen on the claude.ai side afterwards, and lm-assist handles both when the node
holds a claude.ai browser session ([how to give it one](../examples/claudeai-browser-auth/)):

1. **Registration status** — the local Settings → MCP page shows each connector with its
   claude.ai registration state (`GET /mcp/connectors`), and the connector can be disabled or
   deleted from there.
2. **Upkeep as tools change** — when a plugin adds or removes tools, the node clears claude.ai's
   cached tool list, forces the bootstrap refetch, enables account-level tool access, and marks
   the new tools auto-approved — the chain that used to be four manual steps. It's idempotent,
   and deferred (not failed) on a node without a cookie.

If your account is on a hub that doesn't provision connectors, the manual path still exists:
claude.ai → Settings → Connectors → *Add custom connector* with the `https://mcp.<domain>/mcp`
URL, or `POST /claude-ai/mcp/servers` from the node.

## The first call: `bootstrap`

Every connected conversation should start with one call to `bootstrap` — no arguments. It
returns the complete set of use-case playbooks (what the fleet can do and how, cross-node and
cross-session) in pages, plus the routing that keeps a session from picking the wrong tool.
Governed tools softly refuse once until it has been called; `guide(topic)` answers a single
"how do I …" afterwards. The registry entry of `bootstrap` itself, on the **MCP Tools** page:

![MCP Tools page — the bootstrap tool selected](../examples/mcp-connector-install/mcp-tools-bootstrap.png)

## Governance

- **Scopes** — every tool declares `read` / `write` / `admin`; the badge is visible per tool on
  the MCP Tools page and drives approval defaults.
- **Registry overlay** — descriptions can be overridden and any tool switched off, fleet-synced,
  without a code change; the code default is always shown beside the override.
- **claude.ai approval** — the *Tool access* submenu is claude.ai's own per-tool gate; lm-assist
  can pre-approve its tools (`set_connector_auto_approve`) so driven calls don't die on
  "No approval received".
- **Result bounds** — every result is capped and carries a provenance footer naming the hub,
  node, and cluster it came from; truncation is announced, never silent.
- **Identity** — the hub binds the connector to your user; per-call session identity is
  resolved on the node, and every tool dispatches into the same Core REST API the web UI uses.

## Advanced: extend the connector with your own plugin

Any standard MCP stdio server dropped into a node's plugin directory becomes `ext__<plugin>__<tool>` on this same connector — governed by the loader (disabled until enabled on the node over loopback, checksum-pinned, audited). The whole loop from a single claude.ai prompt with no manual step — an agent on the node builds and enables it, Claude reconnects the connector, sets permissions, and calls it: [`examples/build-your-own-mcp-plugin`](../examples/build-your-own-mcp-plugin/). Contract: [`mcp-plugin-contract.md`](./mcp-plugin-contract.md).

## Troubleshooting

| Symptom | Meaning | Do |
|---|---|---|
| Connector shows ⚠ *Reconnect* | its OAuth grant expired | click **Reconnect** in Settings → Connectors |
| A tool you know exists isn't offered | claude.ai's cached tool list is stale | ask Claude to refresh the connector tools (`refresh_connector_tools`), or *Manage connectors → refresh* |
| "BOOTSTRAP_REQUIRED" | a governed tool was called before `bootstrap` | call `bootstrap` once, retry |
| Result names another node, or says not found | tools are node-scoped | pass the node the item lives on (`list_nodes` shows them) |
| Two connectors, one named *dev* | a dev hub is enrolled beside prod | they are independent fleets; use the prod one unless testing lm-assist itself |

Related: [`mcp-surfaces.md`](./mcp-surfaces.md) (server internals) ·
[`mcp-plugins-bundled.md`](./mcp-plugins-bundled.md) · [`mcp-plugin-contract.md`](./mcp-plugin-contract.md) ·
[`hub-client.md`](./hub-client.md) · [`claude-ai-routes.md`](./claude-ai-routes.md) (connector lifecycle routes).
