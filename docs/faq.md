# FAQ

Short answers to the questions that actually get asked. Each one links to the topic file
that carries the detail — this page is a signpost, not a replacement for those.

A recurring theme worth stating up front: **lm-assist observes and drives Claude Code, but it
is not Claude Code.** Several things people report as lm-assist bugs are Claude Code's own
behaviour, and the first question below is the clearest example.

---

## Sessions and messages

### Why does my session say "Another Claude session sent a message"?

**That text is written by Claude Code, not by lm-assist**, and in the common case it is
describing your session's *own* teammates.

The strings live in the Claude Code binary itself. When a turn is delivered to a session and
classified as coming from another agent, the CLI prepends a header and appends a safety
paragraph:

```
Another Claude session sent a message:
<teammate-message teammate_id="reviewer-1">
{"type":"idle_notification","from":"reviewer-1",…}
</teammate-message>

This came from another Claude session — not typed by your user … that's permission laundering.
```

The CLI has a second, more accurate paragraph for the case where the sender is a subagent or
teammate *inside the same session* ("That 'other Claude session' is an agent working inside this
same session…"). It is selected only when the delivery carries a sender task id, which the
teammate completion path does not set — so teammate reports get the generic peer wording
instead.

Measured on one machine across every stored transcript: 188 such wrappers, **188 of them using
the peer paragraph**, and 185 of them sent by a teammate the receiving session had spawned
itself. Spanning many CLI versions, so it is not a regression in any one of them.

**What this means in practice:**

- "Another Claude session" usually means "one of my own teammates reported in". It does not
  imply an unrelated session messaged you.
- The safety paragraph is still worth obeying — a teammate cannot grant permission escalation
  either — but it is not evidence that something went wrong.
- **There is no lm-assist setting that changes this wording.** The classification happens before
  lm-assist is involved.

lm-assist's only interaction with the string is *reading* it: `core/src/search/prompt-classifier.ts`
classifies such turns as `teammate_message` so they are filtered out of prompt search rather than
ranked as if you had typed them.

#### Is there a way to avoid it?

This is a known upstream bug —
[anthropics/claude-code#73647](https://github.com/anthropics/claude-code/issues/73647) (open,
`bug` + `has repro`), with many independent reports. Multiple people have confirmed there is **no
settings key, env var or flag** that controls it; the text is a bare string literal in the CLI
binary.

One workaround is reported to work, and it is a *spawn-time* choice:

| how the subagent is spawned | delivery channel | boilerplate |
|---|---|---|
| Agent tool **with `isolation: "worktree"`** | async-task → `task-notification` | **no** |
| Agent tool **without** `isolation` | named teammate → mailbox | yes, on every delivery |

So spawning workers with `isolation: "worktree"` routes their completions through the
task-notification channel, which carries no peer wrapper. Community-reported in the thread above;
not verified in this repo, and it changes where the worker runs, so weigh that against the noise.

Two things that do **not** work:

- **Hooks.** `UserPromptSubmit` never fires on teammate-message deliveries, so you cannot filter
  them on the receiving side — see
  [#92891](https://github.com/anthropics/claude-code/issues/92891).
- **Upgrading and expecting it gone.** v2.1.247 collapsed peer messages to a one-line preview,
  but that is the *renderer* — the full block is still injected into the model's context, and the
  collapse did not reach every surface.

The proper fix is tracked as
[#86821](https://github.com/anthropics/claude-code/issues/86821) — harness-verified lineage on
inter-agent envelopes, which is exactly the missing signal: the CLI already has the accurate
"agent inside this same session" wording and selects it only when the delivery carries a sender
task id, which the teammate completion path does not set.

### Can lm-assist cause that wrapper to appear?

Indirectly, and rarely. Claude Code applies it to any turn it classifies as peer-originated, so a
turn delivered into a session by an external host — including lm-assist's own control plane — can
be classified that way and get the warning attached. lm-assist supplies the message body; Claude
Code chooses the framing.

If you see it on something that is clearly *your* instruction (a mission brief, a `/model` command),
that is this case, not a teammate.

### `send_session_message` reported failure — was my message delivered?

Possibly. Claude Code **queues** input typed while it is busy, and a queued message is a
successful submit. Read the status codes rather than assuming:

| status | meaning |
|---|---|
| `pending` / `TARGET_UNREACHABLE` | nothing was typed in — safe to retry freely |
| `unverified` / `DELIVERY_UNVERIFIED` | body reached the composer, submit unconfirmed — **may have landed**; retry only with the same `messageId` |
| `received` | delivered |

`unverified` is deliberately not `pending` so a sweeper can never auto-redeliver a
may-have-landed message. Detail: [`session-messaging.md`](./session-messaging.md).

### A send/drive call returned success — is that proof the session received it?

No. A successful response means the request was accepted, not that the target rendered a turn
from it. Confirm by observing the target — its transcript or its live state — not by trusting the
call's own return value. The same doctrine applies to pane captures: a body can appear several
times in a pane (queued block, statusline echo, the model quoting it back), so pane text is not a
delivery count.

### Does lm-assist send my session data anywhere?

Not on its own. It reads local Claude Code session files and serves them over a local API. Data
leaves the machine only through features you turn on — the hub connection, a published UI pane, or
an explicit remote call. See **Security model** in the [README](../README.md).

---

## Install, ports and modes

### Which instance am I talking to — dev or prod?

They run in separate port spaces so both can run at once:

| Mode | Core API | Web UI | Managed by |
|------|----------|--------|------------|
| **Prod** (npm package) | 3100 | 3848 | `lm-assist start/stop` |
| **Dev** (repo checkout) | 3200 | 3948 | `./core.sh start/stop` |

`./core.sh status` shows both side by side. **Never cross the streams** — `lm-assist` does not
manage dev services and `./core.sh` does not manage prod. Detail:
[`install-and-modes.md`](./install-and-modes.md).

> If your shell exports `API_PORT`, `./core.sh` inherits it and can act on the *other* instance.
> Run `env -u API_PORT ./core.sh …` when in doubt.

### Core won't start and the log says `ERR_REQUIRE_ESM`

A dependency resolved to an ESM-only build that the CommonJS core cannot `require()`. The usual
culprit is `chokidar`, which must stay pinned at `^3.6.0`. Symptom: services look half-up, the Web
UI starts but `curl localhost:3100/health` fails, and anything relayed through the hub reports the
MCP as down.

Recovery, plus why v5 breaks selectively (it works on newer Node and dies on Node 18), is in the
root [`CLAUDE.md`](../CLAUDE.md#dependency-pin--chokidar-must-stay-360-do-not-bump).

### Do I need an API key?

No. lm-assist works entirely against your local Claude Code session data. A `.env` is optional and
only needed for ports and an optional hub connection.

### `npm install` behaves strangely inside `core/` or `web/`

It's an npm workspace — install from the repo root, not from inside a member. Dependencies hoist
to the root `node_modules/`.

---

## Hub, MCP and connectors

### "The lm-assist MCP is down"

Usually the Core process, not the MCP itself: the hub relays to Core, so a Core that failed to bind
its port surfaces as an MCP outage. Check `curl localhost:3100/health` first, then the hub client.

Also note the effective hub config is `~/.lm-assist/hub.json`, **not** `.env` — editing `.env` and
seeing no change is expected. Detail: [`hub-client.md`](./hub-client.md).

### Why does a connector tool work on one machine and not another?

Because some connectors are bound to a machine, not to your account. The Gmail and LinkedIn tools
drive a **real signed-in browser on a specific node** — deploying the code does not make another
node able to read your mail, and every call routes to one node. Ask the connector's status tool per
node rather than assuming fleet-wide availability.

Two consequences worth knowing: the tools are advertised whether or not that node is signed in, and
**restarting Core kills the browser it launched**. Detail:
[`gmail-connector.md`](./gmail-connector.md), [`linkedin-connector.md`](./linkedin-connector.md).

### A tool is missing from my session's tool list

Tool exposure is scope-gated, and per-tool descriptions and on/off switches live in a fleet-synced
registry that a session can adjust. Start with the tool registry rather than the code. Detail:
[`mcp-surfaces.md`](./mcp-surfaces.md).

---

## Search, memory and history

### Search doesn't find a prompt I know I wrote

Prompt search indexes your *actual* prompts and deliberately filters injected boilerplate —
controller preambles, task notifications, security-review templates, teammate envelopes and the
like. On one measured corpus roughly 86% of user-channel messages were injected text rather than
typed prompts; ranking without that filter ranks the automation, not you.

If the text you're looking for lives inside one of those injected blocks, it is classified as
synthetic and filtered from results by default.

### `memory_file` returns `PROJECT_NOT_FOUND`

The failure is deterministic per input, not intermittent — sort failures by the *argument* you
passed, not by when they happened. Usually the `project_id` is not the one you expect. Detail:
[`memory-reads.md`](./memory-reads.md).

### Which endpoint gives me a specific turn or prompt from a stored session?

Sessions are JSONL, sliced by three indexing dimensions (`lineIndex`, `turnIndex`,
`userPromptIndex`) plus delta and conditional fetches. Every endpoint and query parameter is in
[`api-endpoints.md`](./api-endpoints.md).

---

## Web UI, panes and missions

### I deployed, but a pane still shows the old version

A Core build does **not** deploy panes. The pane server rides the build, but the shim does not —
so a mismatch only bites when a pane's short-lived token expires. Run `./core.sh panes sync`.

Panes scoped to the gateway are hosted there and serve with no node up; the node-side sync
deliberately skips them. Detail: [`ui-panes-deploy.md`](./ui-panes-deploy.md).

### A scheduled job ran once and never again

An unbounded scheduled pass does not merely time out — it can **silently disable the job**. Order
matters too: auto-resume runs first and unbounded, model-fallback second under a budget. Detail:
[`mission-control.md`](./mission-control.md).

### A session looks stalled — will lm-assist recover it?

There is auto-resume and a model-limit fallback, both gated and both observable through the stall
status surface. What they will and won't do, and the traps in reordering them, are in
[`mission-control.md`](./mission-control.md).

---

## Reporting problems

### Is this an lm-assist bug or a Claude Code bug?

A quick test: **does the behaviour involve lm-assist's API, tools, web UI or fleet plumbing?** If
yes, it belongs here. If it is how a Claude session words something, classifies a message, renders
a turn, or handles its own subagents, it is Claude Code and lm-assist cannot change it — the first
question on this page is the canonical example.

For Claude Code itself, use `/feedback` inside Claude Code. For lm-assist, open an issue on the
repository.

### Where do I look first?

1. `./core.sh status` — is the thing you're talking to actually up, and on the port you think?
2. The matching topic file in `docs/` — the index in [`CLAUDE.md`](../CLAUDE.md) maps symptoms and
   error strings to files.
3. `grep -rl "<term>" docs/` — there are more topic files than this FAQ references.
