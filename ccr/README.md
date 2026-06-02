# CCR bridge — make any local Claude Code session remote-controllable via claude.ai

Standalone Node tools (run on the host where the local `claude` runs; here: 123).
They use the **Claude Code Remote (CCR)** worker API on `api.anthropic.com` (OAuth from
`~/.claude/.credentials.json`) and lm-assist's **terminal/tmux endpoint** (`:3100`) for downstream input.

## ccr-bridge.js — TWO-WAY bridge
`node ccr-bridge.js <tmuxSession> <transcript.jsonl> [twoway|oneway]`
(prefix `NODE_EXTRA_CA_CERTS=/home/yi/lm-proxy/ca/ca.crt` on 123 for the MITM CA.)

- Creates a CCR worker session: `POST /v1/code/sessions` -> `POST /{cse}/bridge` (worker_jwt) ->
  `PUT /{cse}/worker {worker_status:"WORKER_STATUS_RUNNING"}` -> `GET /{cse}/worker/events/stream` (SSE).
- **Upstream (always):** tails the local session transcript `.jsonl`; each new user/assistant message is
  re-wrapped `{payload:{type,message,session_id}}` and POSTed to `/{cse}/worker/events`. Renders at
  `https://claude.ai/code/session_<id>`.
- **Downstream (twoway only — requires tmux):** on an inbound SSE frame with
  `event_type:"user", source:"client"` (a prompt typed on claude.ai web/phone), it injects
  `payload.message.content` into the local session via lm-assist
  `POST :3100/terminal/tmux/<tmuxSession>/send-keys {keys,literal:true,enter:true}`.
  Responds `success` to `control_request` frames. Echo-dedup: web-originated prompts are not
  re-mirrored upstream (only the assistant reply is).
- **oneway mode:** for sessions NOT in tmux (cannot be driven) — upstream mirror only; inbound prompts
  are logged and ignored.

## ccr-oneway-mirror.js — one-shot upstream mirror (no live tail)
`node ccr-oneway-mirror.js <transcript.jsonl>` — mirrors a recorded transcript to a fresh CCR session and
prints the URL. Read mirrored events back at `GET /v1/code/sessions/{cse}/events` (NOT teleport-events,
which is for cloud-run sessions).

## ccr-cloud-run-client.js — the OTHER model (cloud BYOC), for reference
Creates a `POST /v1/sessions` cloud-run session (a container runs claude); drive via
`/v1/sessions/{id}/events`, read via `/teleport-events`. Distinct from the worker-mirror model above.

## Validated 2026-06-02 on 123
Two-way loop confirmed end-to-end and rendered in claude.ai on the 123 browser: typed a prompt on the web,
it injected into a local tmux `claude` via lm-assist send-keys, the local claude answered, and the answer
mirrored back up and rendered on the web.

## Gotchas
- worker register = `PUT /worker` with enum `WORKER_STATUS_RUNNING` (POST is 405; `"running"` is 400).
- read mirrored events at `/events`, not `/teleport-events`.
- two tokens: OAuth `sk-ant-oat` (create/bridge/read) + worker JWT `sk-ant-si` (worker/events).
- gate: requires a claude.ai subscriber account with `tengu_ccr_bridge` (Remote Control) enabled.

## TODO (full lm-assist integration)
Wire as an lm-assist route (`core/src/routes/core/ccr.routes.ts` + `core/src/ccr/`) with start/stop
endpoints so it is managed by the service rather than a standalone process. Deferred: the dev repo
`core` build currently fails on pre-existing unrelated `claude-ai.routes.ts` errors, and the running
service is the npm-global dist.
