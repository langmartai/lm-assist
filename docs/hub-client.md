# Hub client — config files, which hub each env dials

> Read before changing hub connectivity or debugging "the MCP is down".
>
> Split out of the repo [CLAUDE.md](../CLAUDE.md) so it is read on demand instead of loaded into every session. Content is unchanged.

## Hub Client

Connects to LangMart Hub for remote API relay, console relay, and session sync. Auto-connects on server start if `TIER_AGENT_HUB_URL` and `TIER_AGENT_API_KEY` are configured. Auto-reconnects with exponential backoff on disconnect.

```bash
./core.sh hub start    # Connect
./core.sh hub stop     # Disconnect
./core.sh hub status   # Connection info
./core.sh hub logs     # Hub log entries
```



**Effective hub config lives in saved files, not just `.env`.** The Core reads `~/.lm-assist/hub.json` (prod) / `~/.lm-assist/hub-dev.json` (dev) — `{ hubUrl, apiKey, apiPort, assistWebPort }`. `.env`'s `TIER_AGENT_HUB_URL` is only the fallback used when the saved file has none. The `-dev` suffix is applied automatically when running from the repo (`IS_DEV_REPO`).

**Which hub each env connects to (do not mix):**

| Env | `hubUrl` | meaning |
|-----|----------|---------|
| **Prod** (npm, :3100) | `wss://assist-api.langmart.ai` | LangMart **prod** hub (SG instance) |
| **Dev** (repo, :3200) | `wss://assist-api.xeenhub.com` | **xeenhub** dev/HMR hub |

The Core dials the hub **outbound** over WebSocket on start: register → `register_ack` → `auth_confirmed`. Verify: `curl -s localhost:3100/health` (Core up) and `curl -s localhost:3100/hub/status` → `{ configured, connected, authenticated, hubUrl, apiKeyConfigured }`. The public MCP path is `Claude Code → mcp.langmart.ai → langmart hub → this prod worker`; when prod is authenticated the `mcp__claude_ai_lm-assist_langmart__*` tools appear in the Claude Code session. A 502 from `assist-api.langmart.ai` means the SG hub origin is down (not a local problem); a crash-looped local `langmart-gateway.service` (xeenhub Type-3 gateway, :8083, needs a marketplace at :8081) is unrelated leftover and **not** in this path.
