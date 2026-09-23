# One MCP connector per tool-loading profile — Design

**Date:** 2026-09-23 · **Status:** approved design, not yet implemented
**Builds on:** tool loading profiles (`core/src/mcp-server/registry/profiles.ts`, commit `47c3544`).
**Scope:** let a user hold several lm-assist connectors side by side — e.g. `lm-assist langmart basic`
and `lm-assist langmart admin` in claude.ai, `lm-assist-basic` in Claude Code — each advertising its
own profile, with the rest of the product (connector upkeep, identity text, bootstrap, UI, docs)
aware that more than one exists.

## 1. Why

A profile today is **node-global**: one file, `~/.lm-assist/mcp-profile[-dev].json`, read inside the
`tools/list` closure. Every client of a node sees the same surface. That cannot express "this
conversation wants 42 tools, that one wants 320", and it has a second, quieter defect: the hub answers
`initialize`/`tools/list` from the user's **most-recently-connected** node, so an unpinned connector's
surface is whatever file that node happens to hold, and it flips when another node reconnects.

Carrying the profile **on the request** fixes both: the surface belongs to the connector, not to the
node that happens to answer.

## 2. Decisions (taken with the user, 2026-09-23)

| # | Decision | Rejected alternative, and why |
|---|---|---|
| D1 | The profile rides the **URL path**: `https://mcp.<domain>/mcp/<profile>` | Query form (`/mcp?profile=`) — RFC 8707 says a resource identifier SHOULD NOT carry a query, the hub's protected-resource metadata returns a constant `resource`, and a client that normalises the query would silently lose the pin. Token-bound profile (stored on the OAuth client) — misses DCR-registered connectors and Claude Code's plain sk-key Bearer. claude.ai per-connector tool access — unverified that it removes tools from the model's context. |
| D2 | **Advertise-only**, as profiles already are. A hidden tool stays callable. | Refusing calls outside the pin — a false boundary (the hub does not bind tokens to a resource, so any token works on any profile URL) and it hard-fails while claude.ai's cached list lags. The profile is a context budget, not a permission; TOOL_SCOPES, the admin gate and the overlay remain the controls. |
| D3 | Core gets a **create flow** for per-profile claude.ai connectors. | Manual only — leaves N connectors to be kept in sync by hand. |
| D4 | The hub change is part of this work and is deployed. | Node-only — the hub drops the path and query today, so claude.ai pins would stay dormant. |
| D5 | The `langmart` profile is renamed **`platform`**; `langmart` stays accepted as an alias. | Keeping `langmart` — the existing connector is already named "lm-assist langmart" after the HUB, so the profile connector would be "lm-assist langmart langmart", and the hub/profile clash would persist in every surface. |

## 3. Model

- A **pin** is a profile name carried by one request.
- **Effective profile** = the pin when present and known; otherwise the **node default** (the existing
  file, default `admin`). A pin is never written to the file or to the module cache.
- 🔴 **No pin + node default `admin` (the shipped default) ⇒ byte-identical output to today** —
  tools/list, instructions, footer, bootstrap. This is the compatibility contract; the existing pinned
  tests (`result-origin.test.ts`, `fleet-identity.test.ts`, `session-start-routing.test.ts`) keep
  passing unmodified. A node whose operator already narrowed the default (no pin, default `basic`) gets
  the profile-aware banner and bootstrap too — the effective profile, not the pin, drives them. The
  footer's `· profile` segment appears only when a pin is present.
- Precedence is unchanged: the overlay wins (a disabled tool is off under every profile), the profile
  narrows, and PROTECTED_TOOLS (`bootstrap`, `guide`, `mcp_profile`, `session_status`) are always
  listed.
- **Unknown pin ⇒ fail open, visibly.** Serve the node default, and say so in the first sentence of the
  instructions, in the result footer, and in the tools/list log line. A typo, or a newer profile name
  reaching an older node, must never blank the tool surface — and must never look like it worked.

## 4. URL contract

| Surface | Unpinned (unchanged) | Pinned |
|---|---|---|
| Public MCP endpoint (claude.ai, Claude Code over HTTP) | `https://mcp.<domain>/mcp` | `https://mcp.<domain>/mcp/<profile>` |
| OAuth protected-resource metadata (RFC 9728) | `/.well-known/oauth-protected-resource/mcp` | `/.well-known/oauth-protected-resource/mcp/<profile>` → `resource: <base>/mcp/<profile>` |
| Hub → node relay (every relay, default AND node-targeted) | `/mcp` | `/mcp?profile=<profile>` |
| Direct to a Core (mission controller, local HTTP clients) | `http://127.0.0.1:<port>/mcp` | `…/mcp?profile=<profile>` |
| stdio (Claude Code spawning the MCP server) | — | env `LM_MCP_PROFILE=<profile>` |

- Profile-name grammar: `^[a-z][a-z0-9-]{0,31}$`. `connectors` is reserved (the hub serves
  `/mcp/connectors` under the same router).
- The node only ever sees the **query** form, so the pin never collides with the node's own `/mcp/*`
  REST routes (`/mcp/search`, `/mcp/connectors`, `/mcp/pending`, …). `rest-server.ts` already matches
  `/mcp` with the query stripped and passes the raw `req` through, and the relay handler already
  re-appends a relayed `query` — no node routing change is needed.
- The authorization server, its metadata, dynamic client registration and the login bridge are
  unchanged; a per-profile connector is just another DCR client of the same AS.

### Hub contract (implemented in the hub's own repository)

The hub is a separate codebase; this spec states only the contract lm-assist relies on.

1. Route `POST|GET|DELETE /mcp/:profile` (grammar above, `connectors` excluded) to the same
   authentication and relay as `/mcp`.
2. Serve `/.well-known/oauth-protected-resource/mcp/:profile` with `resource` equal to the profile URL.
3. Forward the profile to the node **on every relay** as the query `profile=<name>` — including
   node-targeted `tools/call`, so the target node's footer, bootstrap and `mcp_profile` see the pin.
4. Validate grammar only; the node owns the profile list (so adding a profile never needs a hub change).
5. Unpinned `/mcp` behaviour is unchanged.

## 5. Serving on the node

### 5.1 Resolution

`registry/profiles.ts` gains a pure resolver:

```ts
interface EffectiveProfile {
  name: string;                          // what is actually applied
  source: 'pin' | 'node-default';
  pin?: string;                          // as received (present even when unknown)
  unknownPin?: boolean;                  // pin present but not a known profile
}
resolveEffectiveProfile(pin: string | undefined): EffectiveProfile   // no I/O beyond activeProfileName()'s cached read
```

`getProfile()` resolves the `langmart` alias to `platform` (own-key lookup preserved — the
`constructor`/`__proto__` outage guard stays). The node-default file accepts either name.

### 5.2 Threading the pin

- **HTTP** — `handleMcpRequest` (`routes/core/mcp.routes.ts`) reads `profile` from `req.url`'s query,
  resolves it, and passes it two ways:
  - to `buildServer(effective)` → `configureMcpServer(…, { profile })` — used by the tools/list filter
    and by `getLmAssistInstructions(effective)` (the server is built BEFORE the request context exists,
    so the instructions cannot read it from context);
  - into `runWithMcpContext({ principal, toolUseId, profile })` — so tool handlers (`mcp_profile`,
    `bootstrap`, `session_status`) and the result footer can read it. Verified: AsyncLocalStorage set
    around `transport.handleRequest` reaches the handlers, and two concurrent requests with different
    pins each see their own.
- **stdio** — `core/src/mcp-server/index.ts` reads `LM_MCP_PROFILE` once at start, passes it as the same
  `configureMcpServer` option, and forwards it to Core on every `/mcp-call` as the header
  `x-lm-mcp-profile`; `mcp-api.routes.ts` lifts that header into `runWithMcpContext` so Core-side
  handlers see the same pin.
- `McpCallContext` (`principal-context.ts`) gains `profile?: EffectiveProfile`.

### 5.3 Hot-path rules (from `docs/mcp-surfaces.md`)

- No disk or network per request for the pin (it is parsed from the URL/env; the node default keeps its
  1.5 s cached read).
- No tool counting on `initialize`. The banner names the profile, not a live count.
- When the effective profile has no `ext__` selector and is not `all`, tools/list **skips** the
  fleet plugin fan-out (`fleetExtToolDefs`, up to 5 s) — it would all be filtered out anyway.
- tools/list writes one line to the Core log (`[mcp] tools/list …`): effective profile, source, pin (if
  any), advertised count. Not to `mcp-calls.jsonl` — that is a 1,000-line capped fleet dataset whose
  tool-call history a per-request line would push out.

## 6. What the model is told

- **Instructions banner.** The first sentence (Claude Code cuts instructions at ~2,048 chars, so
  anything later can be invisible) becomes
  `⟦THIS CONNECTOR⟧ lm-assist · PRODUCTION · profile basic` when pinned (and names an unknown pin and
  the fallback). The two-connector paragraph is rewritten to distinguish two axes:
  different **hubs** are independent fleets (the existing prod/dev guidance, including "fall back to
  the other"); different **profiles on the same hub** share the same nodes and are NOT a failover —
  a failure on one will be on the other too.
- **Footer** (`result-origin.ts`) gains `· profile <name>` only when a pin is present.
- **`session_status`** reports the effective profile and its source. The bootstrap page's own identity
  block stays profile-unaware; the banner, `session_status`, the footer and bootstrap's closing
  "hidden by this profile" line carry the profile.
- **Bootstrap / guide** become profile-aware: a section whose governed tools are ALL hidden under the
  effective profile is left out; the page manifest is built from what is actually delivered (not from
  the static section order); one closing line lists what the profile hides and that the unpinned or
  `admin` connector carries it. The "call `list_claudeai_conversations` first" mandate is emitted only
  when the profile advertises that tool.
- **Bootstrap gate key.** When a narrowed profile is in effect, the gate marker is keyed
  `<conversation>#<profile>`; a full bootstrap keeps the bare key. The gate passes on the bare key OR
  the matching `#<profile>` key. So a full bootstrap satisfies every profile, a narrowed one satisfies
  only itself, and the key is just a string — it flows through the in-memory registry, the node-local
  persist file and the fleet-shared `mcp-bootstrap` dataset without a schema change.
- **`mcp_profile`**
  - `get` reports `{ effective, source, pin, nodeDefault }` plus this fleet's connector URL for each
    profile. It makes NO claude.ai call (it is a protected, always-listed tool, and reading claude.ai's
    connector list is a ~30 s stream); it points at `mcp_connectors {action:"list"}` for per-profile
    claude.ai status.
  - `set` changes the **node default only** (affects unpinned clients). On a pinned connector the reply
    says loudly that THIS connector did not change and names the connector that has the requested
    profile.
  - Description and notes stop saying "node-global".

## 7. Connector management in Core

### 7.1 Identifying our connectors — by URL, all of them

New module `core/src/mcp-server/profile-connectors.ts`:

- `connectorUrlFor(profile | null)` → `<mcpPublicBase()>/mcp` or `…/mcp/<profile>`.
- `classifyConnectorUrl(url)` → `{ ours: boolean, profile: string | null }` against THIS node's public
  MCP base (so a dev Core never touches the prod connector, and vice versa).
- `ourConnectors(servers)` → every claude.ai server whose URL is ours, each tagged with its profile.

It replaces every first-match `/langmart/i` pick:

| Site | Today | After |
|---|---|---|
| `plugins/connector-sync.ts` `pickLangmartConnector` | first `/langmart/i` | all of `ourConnectors()` |
| `tools/refresh-connector.ts` `resolveConnector` | uuid / unique substring / first `/langmart/i` | uuid / name / **profile name**; no argument ⇒ all ours |
| `connector-tools-array.ts` `pickLmAssistConnector` | first `/langmart\|lm-assist/i` | deterministic: the unpinned connector, else `admin`, else the widest; optional `profile` |
| `connectors.ts` registration status | exact `url === base/mcp`, one shared status | per URL, per profile |
| `web/…/McpToolsPage.tsx` status card | first `/langmart/i` | one row per connector |
| `ui-apps/assist-mcp-tools` status card | same | same |

### 7.2 Upkeep across N connectors

- `syncConnectorForPluginTools` loops over every connector; for each it enables tool access and
  auto-approve only for the added tools **that connector's profile advertises**, and checks
  "is it listed yet" against **that connector's** tools event, not the whole org stream.
- All writes of the account's `enabled_mcp_tools` map (tool access, auto-approve, sync) go through one
  **serial queue** and are batched into a single read-modify-write per pass — the PATCH replaces the
  whole map, so concurrent writers drop each other's keys.
- Driven auto-approval (`discoverApprovalKeys`) is keyed by (connector, tool), choosing the connector
  from the tool's `<integration>:` prefix; today the last connector written wins.
- A node-default change (`mcp_profile set`, `POST /mcp-tools/profile`) now clears the cache of the
  **unpinned** connectors automatically (fire-and-forget, same deferral as the plugin sync when the node
  holds no claude.ai cookie). Pinned connectors are unaffected by a node-default change.

### 7.3 Create / list / delete

- REST under `/mcp/` (a path no older Core routes: it answers 404, where `/mcp-tools/<x>` would be read
    as the registry's `/mcp-tools/:name` and write a junk tool doc):
  - `GET /mcp/profile-connectors` → per profile: URL, claude.ai `{uuid, name, connected,
    authStatus, toolCount}` or `null`, plus the unpinned connector.
  - `POST /mcp/profile-connectors {profile}` → **idempotent by URL**: if a server with that URL
    exists, return it; otherwise `POST /claude-ai/mcp/servers {url, name}` with the name
    `lm-assist <hub-label> <profile>` (e.g. `lm-assist langmart basic`). Returns the uuid, its
    `authStatus`, and the one remaining step.
  - `DELETE /mcp/profile-connectors/:profile` → removes the claude.ai server for that URL.
- MCP tool `mcp_connectors` (`list | create | delete`), category `claudeai`, scope `admin` (it writes the
  user's claude.ai account). Registered in all four places a new tool needs: `TOOL_SCOPES`, the category
  map, `EXPANDED_HANDLERS`, `tool-output-budget.ts`.
- **Connect (OAuth) stays one browser step per connector.** claude.ai generates the OAuth `state`
  in-page and validates it on its callback, so it cannot be completed server-side; the create response
  names the step (claude.ai → Customize → Connectors → *Connect* on that connector). Create connectors
  one at a time: registration on the hub is a read-modify-write, and concurrent registrations can lose
  a client.

## 8. Claude Code

- `lm-assist mcp add [--profile <p>] [--stdio]` writes an entry named `lm-assist-<p>`:
  HTTP → `https://mcp.<domain>/mcp/<p>` with the node's Bearer key; `--stdio` → the local MCP server
  with `env.LM_MCP_PROFILE=<p>`. `lm-assist mcp remove --profile <p>` removes it.
- `lm-assist login` gains `--mcp-profile <p>`, passed to the entry it already writes.
- The `lm-assist-hub` key is **not** renamed or re-pinned: the mission controller and its playbooks
  depend on `mcp__lm-assist-hub__*` and need the `mission`/`worker` categories.
- Note for users: every enabled entry loads, so `basic` + `admin` side by side costs MORE than `admin`
  alone. Pick one per session (project-scope `.mcp.json`, or `--mcp-config`).

## 9. UI

- **MCP Tools page, Profile panel** (`web/src/components/mcp-tools/McpToolsPage.tsx`,
  `web/src/lib/mcp-tools.ts`): "Node-global" becomes **Node default** (and says it applies to unpinned
  clients only), and a **Connectors** table is added — profile, URL (copy), claude.ai status, tool
  count, Create / Delete — backed by `/mcp/profile-connectors`.
- **`ui-apps/assist-mcp-tools` pane**: the same table. Its grants gain exact rules for
  `GET|POST /mcp/profile-connectors` and `DELETE /mcp/profile-connectors/*`; any new request
  field is optional (four deployed panes inline the shim), and it ships via `./core.sh panes sync`.

## 10. Docs

- `docs/mcp-connector.md` — a "one connector per profile" section; and correct the existing claim that
  the connector is "provisioned automatically" (no code does that; the create flow in §7.3 is now the
  supported path).
- `docs/mcp-surfaces.md` — the pin: resolution, threading, hot-path rules, the unpinned byte-identity
  contract.
- `docs/api-endpoints.md` — the new routes.
- `CLAUDE.md` index — one row (triggers: `mcp_profile`, `?profile=`, `LM_MCP_PROFILE`,
  `profile-connectors`, "one connector per profile"; tripwire: advertise-only, and no pin must stay
  byte-identical).
- `README.md` — one line.

## 11. Testing

**Unit (node `--test`)**
- resolution: pin known / unknown / absent / alias `langmart`→`platform` / prototype keys.
- tools/list under a pin; unpinned output byte-identical to the pre-change fixture.
- concurrent requests with different pins stay isolated.
- banner: the profile is in the first sentence and under the truncation limit; unpinned banner unchanged.
- footer: `· profile` segment only when pinned.
- bootstrap: sections filtered, manifest matches delivered topics; gate key rules (full satisfies all,
  narrowed satisfies only itself).
- `mcp_profile` get/set semantics under a pin.
- `classifyConnectorUrl` / `ourConnectors` incl. a dev base vs a prod URL; sync loops all connectors and
  issues one batched write; approval keys per connector.
- existing tests that read the real profile file are isolated with `LM_ASSIST_DATA_DIR`.

**Live, in order**
1. Dev Core: `POST :3200/mcp?profile=basic` initialize + tools/list; concurrent `basic` vs `admin`.
2. stdio with `LM_MCP_PROFILE=basic`.
3. Hub, after its deploy: `https://mcp.<domain>/mcp/basic` with a Bearer key, answered by a node on the
   new build; unpinned `/mcp` still returns the full surface.
4. claude.ai: create `lm-assist <hub> basic` through §7.3, Connect it, confirm its tool count and the
   banner/footer in a conversation.

## 12. Rollout and compatibility

- Deploying the hub first is safe: an older node ignores the `profile` query and serves its own default.
- Pins take effect on a fleet only once the node answering is on the new build. The hub picks the
  most-recently-connected node for unpinned-and-untargeted calls, so a mixed fleet gives a pinned
  connector the full surface whenever an old node answers — visible, since the banner will not name a
  profile.
- A new UI against an older Core: the new routes 404 and the UI hides the Connectors table; it never
  sends a connector field to the old `POST /mcp-tools/profile`, which would narrow the whole node.

## 13. Out of scope (noted, not fixed here)

- Deriving the profile from the caller's API-key role (backlog `bl_24f34aa7`) — still needs the hub to
  forward a caller identity.
- Automating the claude.ai Connect click in Core.
- Data-driven (operator-editable) profile definitions. The comment in `profiles.ts` claiming operators
  can edit them "without touching code" is corrected instead.
- Hub defects found while mapping, outside this contract: an unregistered `PATCH /mcp/connectors`, the
  registration read-modify-write race, unknown routes answering 500 instead of 404.
