# lm-assist Examples

One folder per use case — a walkthrough, the exact commands/tools involved, and screenshots from a real running fleet.

![lm-assist capability map — three doors into one control plane, with the MCP connector as the main door used from claude.ai conversations, Cowork sessions, and local or remote Claude Code sessions](../docs/capability-map.svg)

**How to read it:** the **MCP connector** (center) is the main door — it's how Claude itself uses your
fleet, whether you're in a claude.ai conversation, a Cowork session, or a Claude Code session (local
or remote/CCR). The **Web UI** is where you watch and drive things visually; the **skills & plugin**
door lives inside the Claude Code terminal. All three land on the same Core.

> **About the screenshots:** they are captured from real accounts on a live deployment, so all
> personal content (email text, chat names, message previews, account identifiers, keys, internal
> addresses) is deliberately blurred at capture time. The UI chrome is what matters.

| Example | What it shows |
|---------|---------------|
| [mcp-connector-install](./mcp-connector-install/) | Put lm-assist's 280+ MCP tools inside Claude Code and claude.ai |
| [claudeai-browser-auth](./claudeai-browser-auth/) | Give a node a claude.ai browser session — and what lm-assist then automates for the connector |
| [claudeai-conversation-search](./claudeai-conversation-search/) | Full-text search across ALL your claude.ai conversations |
| [gmail-connector](./gmail-connector/) | Read and act on Gmail from any Claude session (CDP, your own logged-in browser) |
| [whatsapp-connector](./whatsapp-connector/) | WhatsApp reads/sends through the connector's own WhatsApp Web tab |
| [linkedin-connector](./linkedin-connector/) | LinkedIn reads/writes with no personal API — a real driven browser |

All connector tools are node-scoped: they are advertised fleet-wide, but each call routes to one
node, and only a node whose own browser is signed in can serve it. Check the matching `*_status`
tool per node first.
