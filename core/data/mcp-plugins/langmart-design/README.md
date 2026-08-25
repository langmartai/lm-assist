# langmart-design — LangMart platform management over MCP (read-only v0.1)

An lm-assist MCP plugin (Contract v1) exposing the LangMart platform's
management surface as 30 **read-only** tools: provider connections, the model
registry, organizations/memberships, usage + request logs + cost insights,
quotas, alerts, support tickets, and automation inventory (read only — no
execution tool exists).

Once enabled in an lm-assist Core, the tools appear fleet-wide as
`ext__langmart-design__<tool>` in every session and claude.ai conversation
carrying the lm-assist connector. Consumers configure nothing.

## How it works

`server.js` is a dependency-free MCP stdio server that forwards each tool
call as exactly one **GET** to the LangMart gateway (gateway-type1) REST API
— the same endpoints the platform's in-process assistant tools use. The
HTTP client hardcodes GET and no mutating tool is defined, so the plugin is
read-only by construction regardless of what the granted key could do.

## Grants (set at enable time, owner-only)

| env | value |
|---|---|
| `LANGMART_API_BASE` | Gateway origin, no path: `https://api.langmart.ai` (prod), `https://api.xeenhub.com` (dev), or `http://localhost:8081` (local dev gateway) |
| `LANGMART_API_KEY` | A normal LangMart **user API key** (`sk-langmart-…`). MCP-OAuth tokens are rejected by the gateway on `/api/*` — use an account key. Prefer a member-role key: admin endpoints are excluded from this plugin anyway, and the gateway enforces roles server-side. |

## Notes for tool users

- IDs are UUIDs: get connection ids from `connections_list`, org ids from
  `organizations_list`. Sequence numbers ("1", "2") are not accepted.
- `platform_health` needs no auth — use it to separate "gateway down /
  wrong base" from "bad key".
- List tools paginate where the gateway supports it (`limit`/`offset`);
  `request_log_get` with `show_full_body=true` can return large payloads.

## Versioning

`tools.json` is the single source of truth for the tool surface; the
manifest's `tools[]` and payload `checksum` are regenerated from it by
`../tools/gen-manifest.js`. Any payload edit requires regeneration and a
fresh owner re-enable (the loader auto-disables on checksum drift).
