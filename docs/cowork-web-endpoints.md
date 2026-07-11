# Claude Cowork — Web API Endpoint Map (for lm-assist integration)

> Profiled live on **123 (yi@10.0.1.123)** via lm-proxy + the paired research browser, **2026-07-11**, against the
> **July 7 2026 "Cowork on web & mobile"** release. Supersedes the desktop-only profiling in the
> `cowork-dispatch-protocol` memory (2026-06-03). Org used: `7cad1e03-e98e-42ca-8571-311a4ce74b8b`.
>
> **Provenance tags:** `[LIVE]` = captured/confirmed this session · `[BUNDLE]` = enumerated from the app JS
> (961 chunks / 80 MB) · `[LM-PROXY]` = decrypted body from the 123 audit log · `[JUN]` = from the June desktop
> profiling, re-listed for completeness (verify before relying).

---

## 0. Verification status, completeness corrections & bootstrap  (verified 2026-07-11)

**Method:** each endpoint below was hit live from the authed browser session (cookie) and/or read decrypted from the
123 lm-proxy audit log. `200/400/404/405/409` = the **actual status observed this session**. `405` = the route
**exists** but rejects that method (so the method is a write) — useful positive evidence, not a miss.

### 0a. Verified matrix (status observed this session)
| Endpoint | Method | Observed | Evidence |
|---|---|---|---|
| `/api/organizations/{org}/cowork/sessions` | POST | **200** (warming create) | net-log `[LIVE]` |
| `/api/organizations/{org}/cowork/sessions/{cse}` | GET | **404** (not the runtime obj) | `[LIVE]` |
| `/api/organizations/{org}/cowork/sessions/{cse}/mcp-servers` | GET | **405** (exists, write) | `[LIVE]` |
| `/api/organizations/{org}/cowork/dispatch/sessions` | POST | **404 — DEPRECATED** (was June get-or-create) | `[LIVE]` |
| `/api/organizations/{org}/cowork/scheduled_tasks` | GET | **200** `{data}` | `[LIVE]` |
| `/api/organizations/{org}/cowork/devices` | GET | **200** `{devices}` | `[LIVE]` |
| `/api/organizations/{org}/cowork/remote_devices` | GET | **200** `{devices}` | `[LIVE]` |
| `/api/organizations/{org}/cowork_settings` | GET | **200** `{enabled:true,can_be_enabled:true,dittos_enabled:true,…}` | `[LIVE]` |
| `/api/organizations/{org}/dust/generate_session_title` | POST | **200** | `[LIVE]` |
| `/api/bootstrap/{org}/app_start` | GET | **200** (16 keys, see §0c) | `[LIVE]` |
| `/api/bootstrap/{org}/bootstrap` | GET | **404** (wrong path; it's `app_start`) | `[LIVE]` |
| `/api/bootstrap/{org}/cowork_sysprompt_map` | GET | **200** | `[LIVE]` |
| `/api/bootstrap/{org}/current_user_access` | GET | **200** `{features,account_permissions,account_features}` | `[LIVE]` |
| `/v1/code/sessions` (`?tags=cowork`) | GET | **200** `{data,next_cursor,resume_token}` | `[LIVE]` |
| `/v1/code/sessions/{cse}` | GET / PUT | **200** (`environment_kind:anthropic_cloud`) | `[LIVE]` |
| `/v1/code/sessions/{cse}/events` | POST / GET | **200** (GET → `{data,resume_cursor}`) | `[LIVE]` |
| `/v1/code/sessions/{cse}/events/stream` | GET(SSE) | **200** | `[LIVE]` |
| `/v1/code/sessions/watch` | GET(SSE) | **200** | `[LIVE]` |
| `/v1/code/sessions/{cse}/ping` | POST | **200** | `[LIVE]` |
| `/v1/code/sessions/{cse}/teleport-events` | GET | **200** `application/json` | `[LIVE]` |
| `/v1/code/sessions/{cse}/mcp-servers` | GET | **405** (exists, write) | `[LIVE]` |
| `/v1/code/sessions/{cse}/mcp-approvals` | GET | **405** (exists, write) | `[LIVE]` |
| `/v1/code/sessions/{cse}/screenshots` | GET | **200** `{screenshots}` | `[LIVE]` |
| `/v1/code/sessions/{cse}/worker/register` | POST | **200** `{has_producer_binding,worker_epoch}` | lm-proxy `[LM-PROXY]` |
| `/v1/code/sessions/{cse}/worker` | GET / PUT | **200 / 409** (epoch fence) | `[LM-PROXY]` |
| `/v1/code/sessions/{cse}/worker/heartbeat` | POST | (observed body) | `[LM-PROXY]` |
| `/v1/code/sessions/{cse}/worker/events/stream` | GET(SSE) | (observed) | `[LM-PROXY]` |
| `/v1/environment_providers/private/organizations/{org}/environments` | GET | **200** `{environments,has_more,…}` (bridge env for 123) | `[LIVE]` |
| `/v1/environments` | GET | **400** (needs params + `environments-2025-11-01` beta) | `[LIVE]` |

### 0b. Completeness corrections (things the first pass missed / got wrong)
- **`/cowork/dispatch/sessions` is gone (404).** The June "dispatch singleton" is no longer a live route; the unified
  July model creates every task via `cowork/sessions` (warming) + `PUT /v1/code/sessions/{cse}`.
- **`/v1/code/sessions/{cse}/` has a richer per-session action surface than §3 exercised** (from the bundle sub-resource
  sweep, `[BUNDLE]` unless verified above): `archive`, `unarchive`, `client/presence`, `feedback`, `mark_read`,
  **`move-to-cloud`** (migrate a local/bridge session → cloud — the local→remote handoff), `share`, `screenshots`✓,
  `mcp-servers`✓405, `mcp-approvals`✓405 (**the tool-approval submit surface**), `terminal`, `debug-export`,
  `proxy/0/__control/downloadsource`.
- **`/cowork/sessions/{id}/` sub-resources:** `download-file`, `mcp-servers`, `project` (attach to a Project), `release-cu`
  (release the cloud compute unit / container). `[BUNDLE]`
- **`/v1/sessions/{id}/`** (persistent store): `archive`, `unarchive`, `events`, `events/stream`, `resources`, `backend-admin`. `[BUNDLE]`
- Non-cowork noise to ignore in captures: `browser-intake-*datadoghq.com` (RUM), `s-cdn.anthropic.com` (Sift),
  `a-api.anthropic.com/v1/{b,m}` (analytics), `assets-proxy.anthropic.com/*.js` (chunks).

### 0c. Bootstrap — is it required for cowork?  **Yes for the UI; for the API only "cowork enabled + org id + auth".**
- The web app runs a **cold-load bootstrap fan** (long `staleTime`, so it does *not* refire on soft nav):
  **`GET /api/bootstrap/{org}/app_start`** → `{account, org_statsig, org_growthbook, system_prompts,
  current_user_access, model_selector_state, model_selector_config, claude_ai_available_models, memory_mode,
  org_feature_flags, …}` (16 keys, **200** verified); plus **`GET /api/organizations/{org}/cowork_settings`** and a
  conditional **`GET /api/bootstrap/{org}/cowork_sysprompt_map`** (200).
- **The whole Cowork UI is gated on `cowork_settings`:** bundle computes `coworkEnabled = …cowork_settings.enabled…`;
  `can_be_enabled:false` = org **hard-blocked by policy (e.g. HIPAA)**. Verified this account: `enabled:true,
  can_be_enabled:true` → cowork available.
- **What is actually *required* to drive cowork by API (the lm-assist-relevant answer):**
  1. **Cowork enabled on the account** — `cowork_settings.enabled=true` (server state; if off + `can_be_enabled=true`,
     enable once via a `cowork_settings` write — the UI toggle sends `{cowork_settings:{enabled:true}}`).
  2. **Org id + valid auth** — the org uuid is obtainable **headlessly via OAuth** (no cookie): `GET /api/oauth/profile`
     → **200** `{account:{uuid,email,has_claude_max}, organization:{uuid}}` (verified). Cache it; no bootstrap replay.
     *(Note: `/api/oauth/**` is OAuth-authed even though sibling `/api/organizations/{org}/**` are cookie-only.)*
  3. The **cowork system prompt (`cowork_sysprompt_map`) is applied server-side** in the cloud container — the client
     does **not** send it, so it is **not** a client-side prerequisite for `POST /v1/code/sessions/{cse}/events`.
  ⇒ **No per-session bootstrap handshake is required.** lm-assist needs a one-time enablement check + a cached org id,
  then it can create/drive sessions directly. (The full boot fan is a UI concern, cached for hours.)

### 0d. Headless full lifecycle via OAuth (api.anthropic.com) — **VERIFIED e2e 2026-07-11**
Ran the **entire cowork process from 123 with only the OAuth bearer** (no browser, no cookie); cleaned up after.
1. **CREATE** `POST /v1/code/sessions {"environment_id":"env_011111…117","config":{"model":"claude-sonnet-5"},"tags":["cowork"],"title":"…"}` → **200**, returns `{deduplicated:false, session:{…}}`; server **auto-adds tags `product:cowork-remote`,`config:cowork-remote`** + `environment_kind:anthropic_cloud`, `status:active`. ⚠️ use **`environment_id`** (the cloud singleton), NOT `environment_kind` (→ 400 "Extra inputs are not permitted").
2. **SEND** `POST /v1/code/sessions/{cse}/events` (user payload, `session_id` = `session_<same id>`) → **200** `{results:[{event_id,sequence_num}]}`.
3. **RUN+READ** — the `anthropic_cloud` container spun up & ran within **~3 s**: `GET …/events` → 27 events (`system,user,assistant,result,active_goal,env_manager_log,rate_limit_event`); **assistant reply = the exact marker** `COWORK-OAUTH-E2E-7731`. ✓ (no local worker needed — cloud executes.)
4. **MANAGE** `PUT /v1/code/sessions/{cse}` → **200**; `POST /v1/code/sessions/{cse}/archive` → **200** (session-level management verbs accepted).
5. **DELETE** `DELETE /v1/code/sessions/{cse}` → **200 `{}`**; `GET` after → **404 not_found** (clean). ✓

⇒ **lm-assist can run the whole cowork create→drive→read→manage→delete loop headless via OAuth — no browser, no Cloudflare.** The browser/cookie path is needed ONLY for the account-level **management** endpoints (`cowork_settings` enablement, `devices`/`remote_devices`, `scheduled_tasks`, the `cowork/sessions` warming wrapper, `environment_providers` listing, bootstrap, `dust`/`wiggle` files). Note the OAuth front door wraps reads as `{session:{…}}` / `{deduplicated,session:{…}}` (vs claude.ai's `{response_shape:{…}}`).

---

## 0e. Capability coverage — what's verified vs blocked (2026-07-11)

Exercised each cowork capability (throwaway sessions, cleaned up). `✅`=verified working · `❌`=blocked/uncracked · `🟡`=partial/not-exercised.

| Capability | Status | Notes |
|---|---|---|
| Core loop (create→send→read→reply, cloud+local, headless OAuth) | ✅ | proven e2e |
| Session mgmt: rename (PUT title), archive/unarchive, mark_read | ✅ | title changed; `mark_read`→`{unread:false}` |
| File **upload** `POST /api/{org}/upload` | ✅ | → `file_uuid`+metadata (cookie) |
| Scheduled tasks | ✅ (endpoint) | `POST /cowork/scheduled_tasks` needs `name`(+schedule); list `{data}` |
| Push infra | ✅ | `notification/preferences`→`push_reachability`; `notification/channels`→5 |
| Outputs write (`/mnt/user-data/outputs`) | ✅ | agent writes files |
| Connector **tool-call** from agent | ✅ (June) | brokered via `claude.ai /api/{org}/mcp/servers/{uuid}/tools/call` |
| Connector attach — **mechanism CRACKED** | ✅ (via cookie) / ❌ (headless) | **Connectors are auto-attached SERVER-SIDE by the cookie `POST /api/{org}/cowork/sessions` create** — the client sends NOTHING (verified: intercepted the UI's warming-create=`{title:__warming__,model,effort_level}`, `PUT init`=`{client_metadata}`, `events`; none carry connectors, yet the resulting session has `mcp_connector_ids:[…]` + proper `cowork-remote` tags). Raw OAuth `/v1/code/sessions` create skips this. `local_mcps` (the only connector-ish request field) is for **inline** MCP server defs, NOT account connectors (bare/uuid/object forms all no-op). ⇒ headless connector attach requires the **cookie `cowork/sessions` create** (via-chrome), then drive via OAuth. |
| **Live approval** prompt→decision | ❌ | cowork **auto-approves** even with `set_permission_mode:default` (unsupervised by design). Needs `cowork_settings.skip_approvals_enabled=false` (cookie/account). Endpoints exist (`mcp-approvals`=PUT/POST, `control_request`/`control_response`). |
| File attach → delivery | ✅ **local** / 🟡 **cloud** | Delivery = **STAGING into the sandbox uploads dir** — NOT the generic `/api/{org}/upload`+`file_attachments` ref (→ agent NO-ACCESS), and NOT `wiggle/upload-file` (that's for chat conversations — it 400s on the cowork `cse_` id, and the UI's own `wiggle/list-files` also 400'd for cowork). **LOCAL — CRACKED:** a file placed in the device's ditto **`<ditto>/uploads/`** dir is delivered into the sandbox (bound at `../uploads/` from the agent's `outputs` cwd; **verified**: agent read a staged file → `FILEPROOF: …`). The API-way to put it there = the agent's `device_stage_files` tool / desktop attach flow (or, since the node IS the device, a direct filesystem write). **CLOUD:** files materialize at `/mnt/user-data/uploads/` via the UI attach flow / `device_stage_files`; not replicable via pure API here (cloud container inaccessible; `file_upload` picker needs a user-shared file). **Connectors for LOCAL** load from the ditto's `remoteMcpServersConfig` (account-wide), not per-session `mcp_connector_ids`. |
| Artifact/outputs **preview + download** | 🟡 | via cookie `wiggle/{list-files,download-file,convert-file-to-artifact}`; not exercised; `config.outcomes` stayed `[]` |
| Full **mobile push** delivery | 🟡 | infra verified; end delivery needs a real phone |
| `feedback` / `move-to-cloud` / `terminal` / `share` | 🟡 | `feedback` 400 (wrong body field); `move-to-cloud` needs `environment_id` in body; `terminal` 403 org-disabled; `share` skipped (access-control) |

**Takeaway for lm-assist:** the OAuth runtime covers the whole task loop + session mgmt; the **cookie/UI-only** gaps (connector attach, attach delivery, artifact rendering, scheduled/settings) must go through a real browser (`via-chrome`). Approval isn't exercisable unless the account disables `skip_approvals`.

---

## 1. What the July release changed

Cowork (an agentic **background-task** product, previously a desktop app since Jan 2026) now runs on **web + mobile**
for Max users, and — the key architectural change — **executes remotely in the cloud by default** so a task keeps
running with the laptop closed and syncs across devices. Chat + Cowork now **share one home** at `claude.ai`.

- On the web: a composer toggle **`Chat | Cowork`** on the home screen; choosing **Cowork** creates a *task* (URL `claude.ai/cowork/{cse_id}`).
- The Cowork task UI has right-side **Progress / Outputs / Context** panels and a **`Manual`** execution-mode selector
  (backed by `cowork_settings.auto_mode_enabled`) plus a **Project** selector. Badged **Beta**.
- "Scheduled tasks run with no device online"; "when Claude reaches a call only you can make, it asks, and the question
  reaches your phone" (approval → push).

---

## 2. Web (cloud) vs Local (bridge) — the execution model  `[LIVE]`

Both are modeled as cowork **environments**. A session's `environment_kind` decides where tool execution happens.

| | **Web / cloud** (the new default) | **Local / bridge** (desktop app) |
|---|---|---|
| `environment_kind` | `anthropic_cloud` | (session on a) `bridge` env |
| Environment id | well-known singleton `env_011111…117` | per-device `env_…`, `device_name:"<host>:cowork:<4hex>"` |
| Where tools run | Anthropic cloud container (Claude Code **2.1.206**) | on the device, as a polling **worker** |
| Transport host | **`claude.ai`** (`/v1/code/**` + `/api/**`), same-origin **cookie** auth | **`api.anthropic.com`** (`/v1/code/**/worker/**`), **OAuth** bearer |
| Session `config.origin` | `web_claude_ai` | (bridge) |
| Reachability | none needed (cloud) | outbound-only poll/heartbeat; NAT-friendly; single-writer via `worker_epoch` fencing |

**Observed on 123:** my web task ran in `anthropic_cloud`; the desktop app on 123 is registered as the bridge env
`yitest-Virtual-Machine:cowork:b016` (`online:true`) and heartbeats the worker channel. Same account, two targets.

> **Transport takeaway for lm-assist:** the *web* surface is `claude.ai/**` with the browser session cookie (+ the
> `anthropic-client-*` fingerprint headers claude.ai injects). The *cloud runtime* underneath is the CCR/BYOC
> `/v1/code/**` API — reachable **directly on `api.anthropic.com` with the account OAuth token** for headless callers
> (this is how lm-assist would drive it without a browser). The **worker** endpoints are only for a device that wants
> to *host* local execution.

---

## 3. Web Cowork launch sequence (captured live, in order)  `[LIVE]`

Sending one task from the home composer fired, on `claude.ai`:

1. `POST /api/organizations/{org}/cowork/sessions` — **warming pre-create** (fires on first keystroke; returns a `cse_…`)
2. `POST /api/organizations/{org}/dust/generate_session_title` — auto-title
3. `PUT  /v1/code/sessions/{cse}` — initialize/configure the code session
4. `GET  /v1/code/sessions/watch?exclude_tags=-&resume_token=…` — **account-wide live-session SSE**
5. `POST /v1/code/sessions/{cse}/ping` — keepalive
6. `POST /v1/code/sessions/{cse}/events` — **send the user task**
7. `GET  /v1/code/sessions/{cse}/events?limit=500` — read transcript
8. `GET  /v1/code/sessions/{cse}/events/stream` — **live SSE** of new events
9. `GET/PUT /v1/code/sessions/{cse}` — poll / update state (repeated)
10. side calls: `.../conversations/{cse}/wiggle/list-files`, `POST /v1/code/github/batch-branch-status`,
    `GET /api/organizations/{org}/{memory,sync/settings,notification/preferences,chat_conversations_v2}`

(Non-cowork noise filtered: `browser-intake-*datadoghq.com` RUM, `s-cdn.anthropic.com` Sift, `a-api.anthropic.com/v1/b`
analytics, asset chunks.)

---

## 4. Endpoint catalog (grouped)

### 4a. Cowork session lifecycle — `claude.ai/api/organizations/{org}/cowork/*`  (cookie auth)
| Method | Path | Notes |
|---|---|---|
| POST | `/cowork/sessions` | create / **warming** pre-create (`__warming__` title). `[LIVE]` |
| GET/PATCH/DELETE | `/cowork/sessions/{id}` | list/patch/delete wrapper. NOTE `GET …/cowork/sessions/{cse}` → **404**; the *runtime* object is `/v1/code/sessions/{cse}` (§4c). `[LIVE 404]` `[BUNDLE]` |
| ~~POST~~ | ~~`/cowork/dispatch/sessions`~~ | ⚠️ **404 — DEPRECATED in July release** (was the June get-or-create dispatch singleton; now every task goes through `cowork/sessions`+`/v1/code/sessions`). `[LIVE 404]` |
| GET/POST | `/cowork/scheduled_tasks` | scheduled cowork tasks → `{data:[…]}` ("runs with no device online"). `[LIVE]` |
| GET | `/cowork_settings` | feature/permission flags (see §6). `[LIVE]` |
| — | `/cowork/messages/{id}/safety_flags` | per-message safety. `[BUNDLE]` |
| — | `/cowork/attachments` | attachment refs. `[BUNDLE]` |
| GET/…| `/cowork/devices`, `/cowork/devices/{id}`, `/cowork/remote_devices` | **device registry** (the phone/laptop/desktop fleet for check-in + push). `[BUNDLE]` |
| — | `/cowork/files/{id}` | cowork file ref. `[BUNDLE]` |
| GET | `/cowork/trial`, `/cowork/trial/dev` | trial/promo state. `[BUNDLE]` |
| GET | `/api/bootstrap/{org}/cowork_sysprompt_map` | system-prompt map served at bootstrap. `[BUNDLE]` |

### 4b. "dust" helpers (LLM-generated metadata) — `claude.ai/api/organizations/{org}/dust/*`
`generate_session_title` `[LIVE]`, `generate_title_and_branch`, `generate_routine_draft` (→ scheduled/routine),
`project_suggestion`, `chat_continuations`, `command_display_names`, `org_shortname`, `hdyhau`.  `[BUNDLE]`

### 4c. Code-session **runtime** (the drive channel) — `claude.ai/v1/code/sessions/*`  (cookie; proxied to backend)
Same API as CCR/BYOC; on the web it is called **same-origin on `claude.ai`**, headers
`anthropic-version:2023-06-01`, `anthropic-beta:ccr-byoc-2025-07-29`, `anthropic-client-feature:ccr`, `x-organization-uuid`.

| Method | Path | Notes |
|---|---|---|
| GET/POST | `/v1/code/sessions` | account **task/session list** → `{data, next_cursor, resume_token}`. `[LIVE]` |
| GET/PUT/PATCH/DELETE | `/v1/code/sessions/{cse}` | session object (see §5). GET returns `{response_shape:{…}}`. `[LIVE]` |
| POST | `/v1/code/sessions/{cse}/events` | **send** user/control events. `[LIVE]` |
| GET | `/v1/code/sessions/{cse}/events?limit=&…` | **read** transcript → `{data:[…], resume_cursor}`. `[LIVE]` |
| GET | `/v1/code/sessions/{cse}/events/stream` | **live SSE** (resumable via `resume_cursor`/`last-event-id`). `[LIVE]` |
| GET | `/v1/code/sessions/watch` | **account-wide** live-session SSE (`session_update`/`session_deleted`). `[LIVE]` |
| POST | `/v1/code/sessions/{cse}/ping` | keepalive. `[LIVE]` |
| GET | `/v1/code/sessions/{cse}/teleport-events` | open-in-desktop / teleport → `application/json`. `[LIVE 200]` |
| GET | `/v1/code/sessions/{cse}/screenshots` | → `{screenshots}`. `[LIVE 200]` |
| PUT/POST | `/v1/code/sessions/{cse}/mcp-servers` | attach/set MCP connectors (GET→405). `[LIVE 405]` |
| POST | `/v1/code/sessions/{cse}/mcp-approvals` | **submit tool-permission decisions** (GET→405). `[LIVE 405]` |
| POST | `/v1/code/sessions/{cse}/move-to-cloud` | **migrate a local/bridge session → cloud** (local→remote handoff). `[BUNDLE]` |
| POST | `/v1/code/sessions/{cse}/{share,mark_read,feedback,archive,unarchive}` | share / read-state / feedback / archive. `[BUNDLE]` |
| POST | `/v1/code/sessions/{cse}/client/presence` | client presence `{client_id}`. `[BUNDLE]` `[JUN]` |
| — | `/v1/code/sessions/{cse}/{terminal,debug-export,proxy/0/__control/downloadsource}` | terminal / debug export / proxy control. `[BUNDLE]` |

### 4d. **Worker** channel (only a *local* device that hosts execution) — `api.anthropic.com/v1/code/sessions/{cse}/worker/*`  (OAuth)  `[LM-PROXY]`
| Method | Path | Body / result (decrypted) |
|---|---|---|
| POST | `/worker/register` | `{}` → `{"has_producer_binding":false,"worker_epoch":"28"}` |
| GET | `/worker` | → `{"worker":{session_id, worker_epoch, external_metadata,…}}` |
| PUT | `/worker` | `{"worker_status":"idle","worker_epoch":N,"external_metadata":{pending_action,task_summary}}` → **409 epoch mismatch** if stale (single-writer fence) |
| POST | `/worker/heartbeat` | `{"session_id":"cse_…","worker_epoch":N}` (~1/s) |
| GET | `/worker/events/stream` | SSE — receive assigned work |
| POST | `/worker/events`, `/worker/events/delivery` | send assistant/result/env events back `[JUN]` |
| POST | `/v1/code/sessions/{cse}/bridge`, `/v1/environments/{env}/bridge/reconnect` | bridge attach/reconnect `[JUN]` |

### 4e. Environments (execution targets) — `api.anthropic.com` / `claude.ai`
| Method | Path | Notes |
|---|---|---|
| GET | `/v1/environment_providers/private/organizations/{org}/environments?included_worker_types=cowork` | list envs → `{environments, has_more, first_id, last_id}`; shows `bridge` device(s). `[LIVE]` |
| GET/DELETE | `/v1/environments/{env}` | get / **`DELETE …?force=true`** = the web "Disconnect device" (needs `anthropic-beta: environments-2025-11-01`). `[JUN]` |
| POST | `/v1/environments/{env}/archive`, GET `/work/stats` | archive / stats. `[BUNDLE]` |
| POST | `/v1/environments/bridge` | register this device as a bridge env. `[JUN]` |

### 4f. Files — `claude.ai/api/organizations/{org}/conversations/{cse}/wiggle/*`  (cookie)
`list-files`, `upload-file`, `download-file(s)`, `delete-file`, `convert-file-to-artifact`, `export-to-google-drive`;
plus `…/snapshots/{id}/wiggle/download-file(s)`. Generic blob upload is `POST /api/{org}/upload` (note `/api/{ORG}/…`,
not `/api/organizations/…`). Cowork artifacts render via the `cowork-artifact://{id}` scheme + `/cowork-artifact/{id}`. `[BUNDLE]` `[JUN]`

### 4g. Automation / scheduling (adjacent, used by Cowork "Scheduled")
`/v1/code/triggers`, `/v1/code/triggers/{id}`(+`/run`,`/fork`,`/runs/{id}`,`/api-token`), `/v1/code/webhook-triggers(/{id})`,
`/v1/code/organization/triggers`. Routines/scheduled tasks dispatch a cowork session on a cron. `[BUNDLE]`

### 4h. Persistent conversation/session store — `api.anthropic.com/v1/sessions/*`
`/v1/sessions(/{id})`, `/{id}/events`(+`/stream`), `/v1/sessions/ws/{id}` (WS subscribe), `/{id}/resources(/{id})`,
`/{id}/archive|unarchive`. (Fire history / cross-device sync substrate.) `[BUNDLE]` `[JUN]`

### 4i. Broader web code-session surface (NOT cowork-core, but same `/v1/code` namespace — good to know)
`agent-proxy*` (egress proxy profiles/credentials/oauth), `agents(/{id})` (+ slack/teams bindings), `github/*` (repo/PR/issue),
`runners/self-hosted/*` (self-hosted execution pools), `pr-steward/*`, `baku/sessions/*` (artifact "apps"), `slack/*`,
`screenshots/latest`, `plugins`. `[BUNDLE]`

---

## 5. Key request/response shapes  `[LIVE]`

**Session object** (`GET /v1/code/sessions/{cse}` → `{response_shape:{…}}`):
```jsonc
{
  "id": "cse_…",
  "environment_id": "env_011111…117",         // anthropic_cloud singleton
  "environment_kind": "anthropic_cloud",       // vs a bridge env for local
  "connection_status": "connected|disconnected",
  "config": { "model":"claude-sonnet-5", "effort_level":"medium",
              "origin":"web_claude_ai",
              "mcp_connector_ids":["…","8f61a74e-…(lm-assist)"], "sources":[], "outcomes":[] },
  "client_metadata": { "remote_cowork": { "userSelectedFolders": [] } },
  "external_metadata": { "container_cc_version":"2.1.206", "last_served_model":"claude-sonnet-5",
                         "post_turn_summary": { "status_category":"review_ready",
                                                "status_detail":"replied with …" } },
  "post_turn_summary": { "status_category":"review_ready", "needs_action":"", "is_noteworthy":false,
                         "recent_action":"", "title":"", "description":"" },  // NEW — mobile "highlights"/check-in
  "participants": [], "client_presence": [], "created_at": "…", "last_event_at": "…"
}
```

**Events read** (`GET /v1/code/sessions/{cse}/events` → **`{data:[…], resume_cursor}`** — changed from the old
`{events, has_more, last_id}`). Each event: `{event_id, event_type, sequence_num, source, sent_by_account_id,
device_attestation_status, created_at, payload}`. Payload `type`s seen for one trivial task (34 events):
`system, user, assistant, result, control_request, control_response, rate_limit_event, env_manager_log`, and **`active_goal`** (NEW — drives the Progress panel). The `result` payload is telemetry-rich
(`total_cost_usd, usage, modelUsage, num_turns, ttft_ms, stop_reason, fast_mode_state, warm_spare_claimed, permission_denials, …`).

**Send** (`POST /v1/code/sessions/{cse}/events`) `[JUN]`, unchanged shape:
```jsonc
{ "events":[ { "payload": { "type":"user", "uuid":"…", "session_id":"session_…",
   "parent_tool_use_id":null, "message": { "role":"user", "content":"…" } } } ] }
```
The same channel also carries control events: `control_request` subtypes `interrupt` / `set_permission_mode` /
`set_model` / `rename_session` / `initialize`, and `control_response` (tool-permission decisions). Reply from a cowork
agent arrives as a **`SendUserMessage` tool_use**, not a plain assistant text block.

**Worker** bodies — see §4d (register/heartbeat/PUT with `worker_epoch` fencing).  `[LM-PROXY]`

---

## 6. Auth & headers — **VERIFIED cookie-vs-OAuth matrix (2026-07-11)**

Two credential types × two hosts. Each row was hit **both** ways this session — OAuth bearer from 123 via lm-proxy
(fresh token) and the browser cookie — and the status recorded.

| Endpoint family | `api.anthropic.com` + **OAuth bearer** | `claude.ai` + **cookie** | Verdict |
|---|---|---|---|
| `/v1/code/sessions` + `/{cse}` + `/events` (runtime: create/read/drive) | **200** | **200** | **BOTH** |
| `/v1/code/sessions/{cse}/worker/**` (worker/host) | **200** (OAuth; desktop app) | — (device-side only) | **OAuth** |
| `/v1/environment_providers/private/**` (env listing) | **403** `account_session_invalid` | **200** | **COOKIE-only** |
| `/api/organizations/{org}/cowork/**` (warming-create, devices, remote_devices, scheduled_tasks, …) | **403** `account_session_invalid` | **200** | **COOKIE-only** |
| `/api/bootstrap/{org}/**` (app_start, cowork_sysprompt_map, current_user_access) | **403** | **200** | **COOKIE-only** |
| `/api/organizations/{org}` + `dust/**` + `wiggle/**` | **403** | **200** | **COOKIE-only** |

**Evidence (bodies):**
- OAuth against any `/api/**` (and `/v1/environment_providers/private/**`) → **`403 {"type":"error","error":{"type":"permission_error","message":"Invalid authorization","details":{"error_code":"account_session_invalid"}}}`** — these require the **claude.ai account SESSION (cookie)**; an OAuth bearer is the wrong credential type. (So it is not "the same backend accepts either" for these — they are genuinely session-scoped.)
- OAuth against `/v1/code/**` → **200**, including the **web-created cloud session** `cse_…` and its `/events`. The earlier 401 was only the expired token.
- **claude.ai + bearer (no cookie) → 403 Cloudflare "Just a moment"** HTML — scripting `claude.ai` directly is bot-blocked regardless of credential; it needs a **real cf-cleared browser context** (or the browser's own cookie + cf-clearance).

**Credential/host rules:**
- **OAuth bearer** (`~/.claude/.credentials.json`) is valid on **`api.anthropic.com`** for the **`/v1/code/**` runtime** (+ `/v1/environments/**` bare API with `environments-2025-11-01` beta). No Cloudflare. *(Token expires — stale ⇒ 401; the account must refresh it.)*
- **Account cookie** is valid on **`claude.ai`** for **everything** (both the proxied `/v1/code/**` and the native `/api/**`), but only from a **real browser** (Cloudflare gate).
- Headers (both): `anthropic-version:2023-06-01`, `anthropic-beta:ccr-byoc-2025-07-29`, `anthropic-client-feature:ccr`, `x-organization-uuid`; the browser also auto-adds `anthropic-client-platform:web_claude_ai`, `-client-version/-sha`, `-device-id`, `-anonymous-id`, `x-activity-session-id`.

**Consequence for lm-assist:**
- **Headless (OAuth → api.anthropic.com)** covers the whole **session runtime** — create (`POST /v1/code/sessions`), drive (`/events`), stream (`/events/stream`, `/watch`), `/ping`, and worker-hosting. This is the core cowork loop, **no browser required**.
- **Cookie-only (claude.ai, real browser via the `via-chrome` pattern)** is unavoidable for the cowork **management** layer: enablement (`cowork_settings`), `devices`/`remote_devices`, `scheduled_tasks`, the `cowork/sessions` warming wrapper, `environment_providers` listing, `dust`/`wiggle`, bootstrap.

**`cowork_settings`** flags: `enabled, can_be_enabled, dittos_enabled, skip_approvals_enabled,
auto_mode_enabled (← the Manual/Auto toggle), always_allow_for_mcp_write_tools_enabled, first_enabled_at, otlp_*`.

---

## 7. Introducing Cowork into lm-assist — recommended surface

lm-assist already proxies claude.ai (`/claude-ai/*` cookie-file + `/claude-ai/via-chrome/*`) and Claude-Code OAuth
(`/claude-code/*`). A **`/cowork/*`** family would mirror that. Minimum viable set to "support Cowork":

1. **Create a cloud task** — `POST /v1/code/sessions` (or `POST …/cowork/sessions` warming → `PUT /v1/code/sessions/{cse}`)
   with `config.environment_kind=anthropic_cloud`, model, effort, `mcp_connector_ids`.
2. **Drive it** — `POST /v1/code/sessions/{cse}/events` (user + control), `GET …/events` + `…/events/stream` (SSE read).
3. **List / monitor** — `GET /v1/code/sessions` (`{data,next_cursor}`) + `GET /v1/code/sessions/watch` (account SSE);
   surface `post_turn_summary.status_category` (`review_ready`/`needs_action`) for a check-in view.
4. **Environments** — `GET /v1/environment_providers/private/organizations/{org}/environments?included_worker_types=cowork`
   to enumerate cloud vs the fleet's bridge devices; `DELETE /v1/environments/{env}?force=true` to reclaim a device slot.
5. **Scheduled** — `GET/POST …/cowork/scheduled_tasks` (+ `/v1/code/triggers`) for background/no-device runs.
6. **Files/outputs** — `…/conversations/{cse}/wiggle/*` and `/api/{org}/upload`; artifacts via `cowork-artifact/{id}`.
7. **Optional (host local execution on an lm-assist node)** — implement the **worker** loop (§4d): register → PUT/heartbeat
   with `worker_epoch` → `worker/events/stream` receive → `worker/events` send. This makes an lm-assist node a *bridge*
   cowork environment (like the desktop app), executing tasks locally.

**Two integration modes**, matching lm-assist's existing patterns:
- **Headless / cross-node:** OAuth token → `api.anthropic.com/v1/code/**` (no Cloudflare); best for cron/dashboards.
- **Interactive:** the browser/cookie session → `claude.ai/**` via the `via-chrome` snippet pattern; needed for the
  `/api/organizations/{org}/cowork/**` claude.ai-native calls (settings, dust, wiggle, devices).

---

## Appendix — capture method (reproducible on 123)
- lm-proxy intercepts `claude.ai` + `*.anthropic.com` (own DNS on :15353 → 10.0.1.123, iptables 443→8443, CA-trusted);
  audit log `/home/yi/lm-proxy/logs/http-audit.jsonl` (schema `{client{pid,comm,cmdline},hostname,request{method,url,headers,body},response{status,body,sse_events},time}`).
- Live UI + endpoint sequence: paired research browser at `claude.ai` (authed) + `read_network_requests` + authed in-page `fetch()` reads.
- Full endpoint enumeration: recursively fetched the app module graph (961 chunks) via lm-proxy and grepped endpoint literals.
- Decrypted local worker bodies: extracted from the desktop-app (`electron`) rows in the 123 audit log.
- ⚠️ The paired research browser was **not** on 123, so the *web* leg was read from the browser's own network log +
  in-page fetches, not lm-proxy; the *worker/local* leg and the static bundle **were** via lm-proxy on 123.
