# Harness runs — durable records of qwen / opencode agent runs

> Read before touching `core/src/harness/run-*.ts`, `core/src/harness/backfill.ts`, `core/src/harness/redact.ts`,
> the `/harness/runs*` or `/harness/runners` routes, or anything that reads OpenCode's database.
> Endpoint reference: [api-endpoints.md](./api-endpoints.md#harness-non-claude-agent-runners).

Every run of a **registered (pluggable) harness** — today `qwen` and `opencode` — leaves a durable
record, a redacted capture of its stdout and a redacted copy of its prompt. Foreground and
background alike. The web page `/harness` and the `GET /harness/runs*` routes read them.

The builtin runners `sdk` and `tmux` are **not** recorded here: they run Claude Code itself, so
their transcripts are ordinary Claude Code sessions (`/sessions`).

## Where it lives

All paths are lazy functions over `getDataDir()` / `isDevRepo()` (`core/src/harness/run-paths.ts`),
so `LM_ASSIST_DATA_DIR` redirects them — tests rely on that. Dev and prod Cores share
`~/.lm-assist`, so each gets its own index and run root.

| what | dev (:3200) | prod (:3100) | mode |
|---|---|---|---|
| index (event-sourced JSONL) | `harness-runs-index-dev.jsonl` | `harness-runs-index.jsonl` | 0600 |
| run root | `harness-runs-dev/` | `harness-runs/` | 0700 |
| per run `<root>/<executionId>/` | `stdout.log` (capture), `prompt.txt`, `qwen-home/` (qwen only) | same | dir 0700, files 0600 |
| legacy root `harness-runs/` | read by the one-shot dev backfill only | is the run root | tightened to 0700 by backfill |
| OpenCode DB | `LM_HARNESS_OPENCODE_DB` or `~/.local/share/opencode/opencode.db` | same | **read-only, never ours** |

A record's `runDir` is stored RELATIVE to the data dir. `resolveRecordRunDir()` only returns a path
that is a direct child of one of the two roots and not a symlink — the index is a file on disk, so
its locators are input, not truth.

## How a run is recorded

`registerHarness()` stores every harness wrapped by `withRunRecording()` (`run-recorder.ts`), so a
new harness cannot be added unrecorded. The wrapper is idempotent and must never import
`registry.ts` (registry imports it).

1. **Refuse a bad executionId** — it names the run dir and keys both agent-api's background map and
   the harness's live-child map. An id not matching `RUN_ID_RE` gets `INVALID_EXECUTION_ID`; a reused
   one gets `DUPLICATE_EXECUTION_ID`. agent-api checks first (before anything is keyed by the id) —
   and refuses a BACKGROUND request for ANY runner (sdk, tmux, harness) that reuses the id of a run
   still in flight, since every background branch keys the same map;
   the recorder checks again, and the run dir's leaf `mkdir` is non-recursive, so an existing dir is
   an `EEXIST` even when the index is unreadable. Neither refusal is recorded.
2. **Write the start record synchronously, before the harness runs**, then mark the id in flight.
3. The harness reports through optional hooks (`HarnessRunHooks`, the third `execute()` argument):
   `onResolved` (model, profile name, base-URL host, cwd), `onSpawn` (pid), `onStdout` (captured),
   `onSettle` (why it ended: `exit | timeout | launch_error | config_error | spawn_throw`). A harness
   must behave identically without hooks and calls each through a guard that swallows throws.
4. On settle, one patch with the outcome; after the response is returned, an enrichment patch from
   the transcript (tool counts by native name, files touched, reasoning tokens, CLI version). When no
   transcript source is readable the tool counts stay UNSET (the UI shows `—`), never a written 0.
   Files touched skip write/edit calls that FAILED. A qwen run's `numTurns` is the result frame's own
   `num_turns`; without one (a timeout) turns are counted with the transcript layer's rule — a frame
   joins the open turn until that turn has reported usage (qwen 0.15.10 splits every turn into a
   thinking frame and a tool/text frame with different uuids).

🔴 **Recording is invisible to the caller.** The inner response is returned BY IDENTITY, a rejection
is re-thrown unchanged, and a read-only data dir, a full disk or a throwing observer cannot change
either — the record is lost, the run is not. Store failures are logged once per class, by run id
only, never content.

### Status

Terminal status at settle, in this order: `config_error`→`refused`; `launch_error|spawn_throw`→
`launch_failed`; abort requested and not successful→`aborted`; `timeout`→`timed_out`;
success→`succeeded`; else `failed`.

The stored status stays `running` until settle, and the **served** status is derived
(`deriveStatus`): an unended run owned by this process is `running` only while it is in flight;
one owned by another process is `running` only while that pid is alive **with the same start ticks**
(`/proc/<pid>/stat` field 22 — a pid alone is reused). Anything else is `interrupted`. At boot,
dead-owner runs are patched `interrupted` / `termination: core_restart`.

🔴 **Nothing ever signals a pid read from disk.** For an interrupted run the detail route only
*reports* `childAlive` (pid present and started within 5 s of the recorded spawn). Abort always goes
through the harness's in-memory live map (the process group).

## Abort

`POST /agent/execution/:id/abort` now also ends **foreground** harness runs: they are in no agent-api
map, so the route finds the record (by execution id or harness session id) and, if the run is in
flight here, asks the harness to abort it. The response shape is unchanged; a failure carries the
harness's honest `reason`.

## Transcript sources

| source | what | when `auto` picks it |
|---|---|---|
| `captured` | `stdout.log`, one `<epochMs>\t<redacted line>` per line; a line over 1 MB becomes `{"_lmTruncatedLine":true,"bytes":N}`; writing stops at 8 MB (`capture.truncated`) | a live run |
| `qwen-chat` | qwen's own chat JSONL under the run's `QWEN_HOME` | a finished qwen run with a chat file |
| `opencode-db` | OpenCode's SQLite session/message/part rows | a finished opencode run with a session id |

The normalizers live in `core/src/harness/transcript/` and are pure: synchronous, never throw, never
write, no redaction of their own (the routes redact; `loadTranscript` takes a `redact` hook so each
field is redacted BEFORE it is cut to `maxField`). A text/reasoning/tool/user event cut to `maxField`
carries `truncated: true` itself.

The OpenCode version token is `o:<max(session, message, part time_updated)>:<part count>`: OpenCode
upserts a step's end (error, completion) onto the MESSAGE row and tool state onto existing PART rows
without touching the session row, so a version of the session row alone served a stale cached parse.
While a run is live, the step still streaming is not reported as `killed_step`.

## OpenCode's database is the operator's

Harness runs share `~/.local/share/opencode/opencode.db` with the operator's own OpenCode, and it
also holds credential and account tables. So:

- opened `readonly` + `fileMustExist`, per request, closed in `finally`, `busy_timeout` 500 ms;
- one-shot statements only — no transactions, no iterators — so WAL checkpointing is never blocked;
- only the constant SQL in `transcript/opencode-db.ts`, with explicit columns on `session` /
  `message` / `part`; never `immutable`, never a copied file;
- only session ids bound to one of our records are queried; error response headers/bodies are dropped;
- 🔴 **never spawn `opencode export`** — measured to MUTATE the DB (it bumps the project's
  `time_updated` and checkpoints the WAL).

## Redaction

`redact.ts`. The provider key is handed to the child (qwen via its env, opencode via a config file),
so one `env` from the agent puts it in stdout, the native transcript and the result.

- **Exact values**: every `apiKey` of 8+ chars from BOTH modes' provider files (legacy dirs are
  shared) plus `LM_HARNESS_API_KEY`. Re-read when either file changes, at least every 30 s.
- **Patterns**: `sk-` + 20 key chars, and `Bearer <16+ chars>`. There is deliberately no generic
  `key=value` rule — it mangles ordinary content far more often than it catches anything.
- Applied at **write** time (capture lines, `prompt.txt`, previews, errors, stderr) AND at **serve**
  time (every `/harness/runs*` and `/harness/runners` response, via `redactDeep` over string leaves).
- **Redact, then cut.** A key that straddles a cut survives as a fragment exact matching misses. So
  the recorder redacts a whole prompt before slicing it, the transcript route redacts each field
  before `maxField` cuts it, and `redactString` also replaces a 12+ char head of a configured key at
  the END of a string (or its tail at the START) — the only place a cut can leave one.
- Records hold the profile NAME and the base-URL HOST only.

Limits: a secret an agent reads from a project file and prints is not a configured key and may not
match a pattern; the owner can still see it. And serve-time redaction knows only the keys configured
NOW: after a non-`sk-` key is rotated out of the provider file (or `LM_HARNESS_API_KEY` is dropped),
a native transcript that quoted the old key (qwen chat JSONL, OpenCode's DB — neither is redacted at
rest) serves it again. Revoke a rotated key.

## Retention and maintenance

`initHarnessRuns()` (called from control-api after harness registration; deferred, try/catch'd,
repeated on an unref'd 6 h timer):

- **interrupted sweep** (boot) as above;
- **retention**: terminal records older than `LM_HARNESS_RUN_RETENTION_DAYS` (default 30; `0` keeps
  everything) are dropped, then all but the newest 500 terminal records. Running records are never
  dropped. A dropped record's run dir is deleted ONLY if this Core recorded it (`origin: recorded`,
  same mode) and it resolves inside this Core's own root — legacy dirs, the other mode's dirs and
  anything in OpenCode's DB are never touched;
- **compaction**: tmp → rename → chmod 0600, one `start` line per record plus the meta line, when the
  file (with foldable history) passes `max(2 MB, 2 × its size after the last compaction)` or
  `max(5000, 4 × records)` lines, and at boot. The recorder checks after every run, and the run that
  just finished always has unfolded lines — a bare "past 2 MB" rule rewrote a legitimately large
  index after every run, synchronously, on the response path;
- **stale credential sweep**: `os.tmpdir()/lm-harness-opencode-*` dirs owned by this uid, older than
  24 h and not used by a live run. (A run also refuses a NUL byte in prompt/model/cwd BEFORE writing
  its credential file, and cleans up — unpinning the dir first — if the write or `spawn()` throws.)

## Backfill (dev only)

Runs from before the recorder existed are backfilled **once**, lazily on the first
`GET /harness/runs` or `/harness/runners`, and only by a dev Core — measured, the published 0.2.4
package ships no harness code, so every legacy run came from a dev Core and a prod Core has nothing
to recover. A `meta` line marks it done;
failures become `backfill.warnings`, never a failed request.

- **qwen**: each `harness-runs/<id>/` with a `qwen-home/` and no `stdout.log`/`prompt.txt` (those
  belong to a recording Core). Status is inferred from the chat/debug files; a dir with no chat file
  is `not_started`.
- **opencode**: sessions whose model provider id is the harness's fixed `lmharness` and that have no
  parent, skipping any already recorded — in THIS index or the other mode's (read-only) — and any
  created at or after the first recorded OpenCode run in either: both modes share the DB, and a run
  in flight has a session row seconds before its first stdout frame names it. They have no execution
  id, so their record id is `oc-<sessionId>`. An operator provider with the same id would match too —
  every backfilled record is marked `inferred`.

## Not on the hub relay

None of `/harness/*` is on the relay allow-list (`relay-harness-allow.test.ts` pins that): the page is
node-local, like `/mcp-tools`. `PUT /harness/provider/:name` stores a credential and is loopback-only;
its guard also refuses any request carrying `x-relay-source` (the relay reaches Core over 127.0.0.1
with the owner token) or `x-forwarded-host|for|proto` (the web's `/_coreapi` rewrite reaches it from
127.0.0.1 too, for any LAN client). Changing an existing profile's `baseUrl` requires re-supplying
its `apiKey`, so no write can point a stored key at another host. If cross-node viewing is added, add only the narrow read prefixes
`/harness/runs` and `/harness/runners` — never a bare `/harness`.

## Tests

`cd core && npm run build:test && node scripts/run-tests.js harness- relay-harness` —
`harness-run-store`, `harness-run-recorder`, `harness-redact`, `harness-runs-routes`,
`harness-agent-dispatch`, `relay-harness-allow`, plus the pre-existing harness suites and the
transcript suites. Every suite redirects `LM_ASSIST_DATA_DIR` (and `LM_HARNESS_OPENCODE_DB`) to a temp
dir and asserts a synthetic sentinel key never reaches a file or a response.
