# Terminal API

REST endpoints for creating and controlling terminal tabs, tmux sessions, and
Claude Code instances running inside them. tmux is the uniform control
surface; GUI viewers (gnome-terminal, Windows Terminal over SSH) are optional.

Served by the core API (dev `:3200`, prod `:3100`). Reachable cross-machine
via the Hub API relay — callers target the host where the session actually
lives.

For the architecture and design rationale, see [terminal-refactor.md](./terminal-refactor.md).

## Tab kinds

| Kind | Where | What it does |
|------|-------|--------------|
| `gnome` | Linux host | Opens `gnome-terminal --tab`. Propagates the logged-in user's display env so it works over SSH. |
| `wt-ssh` | Windows host | Opens a Windows Terminal tab via a per-call scheduled task, running `ssh -t <target> tmux attach -t <session>`. |
| `tmux` | any POSIX host | Creates a detached tmux session only — no GUI viewer. Multiple viewers can attach separately. |

## Common response shape

```json
{ "success": true, "data": { ... } }
{ "success": false, "error": { "code": "<TerminalErrorCode>", "message": "...", "details": {...} } }
```

Error codes (typed union, see `core/src/terminal/errors.ts`):

| Code | HTTP | When |
|---|---|---|
| `INVALID_INPUT` | 400 | DTO validation failed (regex mismatch, out-of-range int, missing required field) |
| `SESSION_NOT_FOUND` | 404 | Named tmux session or tab id doesn't exist |
| `PRECONDITION_FAILED` | 409 | Operation requires a specific CC phase / dialog state that isn't current |
| `POSTCONDITION_FAILED` | 500 | tmux reported success but the state didn't actually transition |
| `PLATFORM_UNSUPPORTED` | 501 | Endpoint requires a platform this host doesn't have |
| `TMUX_NOT_INSTALLED` | 503 | tmux binary not on PATH |
| `TIMEOUT` | 504 | `wait-for` exceeded `timeoutMs` |
| `TMUX_ERROR` | 500 | Underlying tmux command failed |
| `SPAWN_FAILED` | 500 | gnome-terminal / wt.exe spawn rejected |
| `REGISTRY_ERROR` | 500 | Tab registry lock / IO failure |
| `SESSION_DIED` | 500 | tmux session disappeared mid-operation |

Header `X-LM-Caller: <name>` (optional) tags audit log entries with the
caller identity (e.g. `engine-v6`, `manual-test`).

## Endpoints

### Tab lifecycle

| Method | Path | Body |
|--------|------|------|
| POST | `/terminal/tabs` | `{ kind, title?, cwd?, command?, tmuxSession?, sshTarget?, env?, cols?, rows? }` |
| GET  | `/terminal/tabs` | — (returns `{ tabs: TabRecord[] }`, each with `alive: boolean`) |
| GET  | `/terminal/tabs/:id` | — |
| DELETE | `/terminal/tabs/:id` | — (kills tmux session if any, sends SIGHUP to the visible gnome tab's bash if no tmux is linked; returns `{ removed, killedTmux, closedTab }`) |
| POST | `/terminal/tabs/prune-dead` | — (removes registry entries whose tmux session is gone; returns `{ pruned: string[] }`) |

Tab ids are `tab-xxxxxxxx`. Registry persisted at
`~/.cache/lm-assist/terminal-tabs.json` with atomic writes (tmp + rename),
file lock, and mtime-based reload.

### Gnome tab specifics (Linux)

- Requires a logged-in GNOME desktop session on the host (X or Wayland).
  `findDesktopEnv` reads the env of a running `gnome-terminal-server` /
  `gnome-shell` / KDE / Sway / Xorg process to propagate `DISPLAY`,
  `WAYLAND_DISPLAY`, `XDG_RUNTIME_DIR`, `DBUS_SESSION_BUS_ADDRESS`,
  `XAUTHORITY`. If none is found the API returns `SPAWN_FAILED`.
- `cwd` is pre-checked via `fs.statSync`; non-existent paths return
  `INVALID_INPUT` (gnome-terminal would silently fall back to its own cwd).
- `command` is run inside the new tab via `bash -c 'eval "$1"; exec bash'`
  with the command passed as a positional argv, NOT interpolated into the
  bash source. The shell evaluation of the command CONTENT is by design
  (so `cd /foo && tail -f log` works as a caller types it).
- The PID of the bash running inside the new tab is captured via a
  pre/post diff of `gnome-terminal-server`'s children and stored as
  `meta.tabPid`. `DELETE` sends `SIGHUP` to that PID (interactive bash
  ignores `SIGTERM`; `SIGHUP` simulates the controlling terminal going
  away, so bash exits and gnome-terminal closes the empty pane).
- **Per-tab title limitation** on gnome-terminal 3.44 (Ubuntu 22.04):
  OSC 0 dynamic title is not applied for plain-bash tabs even though
  the helper script sends it correctly (verified at the byte level).
  TMUX-attached tabs work because tmux owns the title from inside the
  pane. Workaround: use `tmuxSession` instead of plain `command` if
  you need a visible per-tab label.

### wt-ssh tab specifics (Windows)

- Requires a Windows lm-assist host (`PLATFORM_UNSUPPORTED` from any other
  OS). Untested in CI (no Windows runner); the validation surface (W1–W3
  tests) verifies platform gating and input sanitization.
- Per-call bat file at `~/.lm-assist/wt-tabs/wt-<id>.bat` and per-call
  scheduled task `LmAssistOpenWtTab-<id>` — no shared resource race
  between concurrent `openWtSshTab` calls (was a real bug in earlier
  implementations).
- `sshTarget` allowlist `^[A-Za-z0-9_]+(@[A-Za-z0-9_.\-]+)?$` rejects
  `&`, `|`, `;`, `^`, backticks at the validation boundary. Even past
  the allowlist, `windowsEscape` wraps the value in CMD double quotes
  with caret-escapes for `& | < > ^`.
- Per-call cleanup runs after 5 minutes (deletes the scheduled task +
  bat file). If lm-assist crashes mid-call, the next `schtasks /run`
  attempt may surface a stale-task warning.

### tmux control

All operate on the tmux server local to the request handler.

| Method | Path | Body / Query |
|--------|------|--------------|
| GET    | `/terminal/tmux` | list sessions, returns `{ sessions: TmuxSessionState[], platformSupported }` |
| POST   | `/terminal/tmux` | `{ name, cwd?, cols?, rows?, command? }` — create detached. Returns `{ name, existed }` |
| DELETE | `/terminal/tmux/:name` | kill-session, returns `{ killed: boolean }` |
| POST   | `/terminal/tmux/:name/send-keys` | `{ keys, literal?, enter?, paneQualifier? }` |
| GET    | `/terminal/tmux/:name/capture`   | `?lines=N&start=-N&paneQualifier=W.P` |
| POST   | `/terminal/tmux/:name/wait-for`  | `{ pattern, literal?, flags?, timeoutMs?, pollMs?, lines?, paneQualifier? }` |

**Important — `paneQualifier`, not session override.** The body field
`paneQualifier` (or legacy alias `target`) accepts only `N` or `N.M`
(window or window.pane). It is combined with the URL `:name` to form
`session:N.M`. It cannot be used to redirect to a different session — that
would defeat the URL-as-routing-key contract.

`send-keys` semantics:
- `literal: true` → tmux `-l` flag, characters typed verbatim (key names not interpreted)
- `enter: true` → append an Enter key. Combined into the same tmux call when `literal: false` (no race); separate call when `literal: true` (cannot mix `-l` with key names).
- All operations on the same session are serialized by a per-session async mutex; parallel callers cannot interleave keystrokes.

`wait-for` returns `{ outcome: 'matched' | 'timeout' | 'session-gone', elapsedMs, screen }`. Patterns must be non-empty; invalid regexes are rejected at the validation boundary, not at runtime.

`capture` `start` may be negative to reach into scrollback (tmux `-S`).
`lines` filters to the last N lines after trimming trailing blanks.

### Claude Code adapter

State-aware operations. Every mutation asserts a phase precondition.

| Method | Path | Body |
|--------|------|------|
| POST | `/terminal/cc/:name/launch` | `{ cwd, model?, extraFlags?, skipPermissions?, cols?, rows?, readyPattern?, readyTimeoutMs?, autoAcceptTrust? }` |
| POST | `/terminal/cc/:name/pivot`  | `{ newSessionId, prompt, promptPattern?, timeoutMs? }` |
| POST | `/terminal/cc/:name/prompt` | `{ text, allowNewlines? }` |
| GET  | `/terminal/cc/:name/status` | — (returns `CCSessionState`) |
| POST | `/terminal/cc/:name/interrupt` | — (sends Ctrl-C) |
| POST | `/terminal/cc/:name/slash` | `{ cmd, args? }` (sends `/cmd args` + Enter; precondition: phase=idle) |
| POST | `/terminal/cc/:name/accept-dialog` | — (Enter; precondition: pendingDialog != null) |
| POST | `/terminal/cc/:name/reject-dialog` | — (Esc; precondition: pendingDialog != null) |
| POST | `/terminal/cc/:name/select-choice` | `{ n }` (digit 1–9; precondition: dialog accepting numbered choice) |

#### `launch`
Creates the tmux session if needed, sends `claude <flags>`, waits for idle.
Defaults: `skipPermissions: true`, `autoAcceptTrust: true`, `cols: 220`,
`rows: 60`, `readyPattern: 'ctx:'`, `readyTimeoutMs: 30000`.

`extraFlags` is MERGED with the default `--dangerously-skip-permissions`
(set `skipPermissions: false` to opt out). Passing `flags: []` or
`flags: ['--model', 'haiku']` no longer silently drops the dangerous flag —
that was the bug that caused CC to hang on the trust prompt in earlier
versions.

If the trust prompt appears before `ctx:` and `autoAcceptTrust: true`,
launch sends Enter to accept and re-waits for idle. Returns
`{ ready, finalPhase, trustPromptHandled, elapsedMs }`.

Resolves the `claude` binary via `getClaudeBinaryPath()` (POSIX:
`~/.local/bin/claude`), not raw PATH lookup — works under restricted
service environments.

#### `pivot`
Race-safe `/resume <id>` followed by re-sending the prompt. Snapshots the
screen pre-resume, waits for the screen to materially change (proving the
resume started loading), THEN waits for the new idle phase. Without this,
the wait would match the pre-pivot `❯` instantly and send the prompt during
the resume's loading screen — that was the original Bug 2.

#### `prompt`
Precondition: phase=idle. Rejects newlines by default
(`allowNewlines: false`) — CC submits on Enter, so a multi-line string
would split into multiple prompts. Pass `allowNewlines: true` to override
(useful for paste-mode workflows).

#### `status`
Returns the full `CCSessionState`:

```ts
{
  phase: 'unknown' | 'launching' | 'trust-prompt' | 'idle' | 'busy' | 'plan-mode' | 'permission' | 'dead',
  model: string | null,            // e.g. 'Opus 4.7', parsed from TUI footer
  lastSnapshot: { text, capturedAt } | null,
  currentMode: 'normal' | 'plan' | 'bash' | 'unknown',
  pendingDialog: 'trust' | 'permission' | 'compact' | 'choice' | null,
  authState: 'authenticated' | 'unauthenticated' | 'unknown',
  contextPct: number | null,       // 0-100, parsed from `ctx: NN%` footer
  authEmail: string | null,        // from ~/.claude.json oauthAccount
}
```

Auth detection is layered:
1. Read `~/.claude.json` `oauthAccount.accountUuid` (primary, file-based)
2. Fallback: scan screen for "Please log in", OAuth URL, etc.
3. Otherwise: `'unknown'`

#### `interrupt`
Sends Ctrl-C to cancel a running CC operation. No phase precondition — by
design callable when CC is busy or wedged.

#### `slash`
Sends `/cmd args` + Enter. Precondition: phase=idle (a slash command issued
while CC is busy is undefined behavior). `cmd` must match
`/^[a-z][a-z0-9_-]{0,31}$/i` (covers all built-in CC commands). `args` is
sent literally; newlines rejected.

Useful for: `/clear`, `/agents`, `/logout`, `/config`, `/export`, `/compact`, `/help`, `/init`, `/release-notes`, plugin commands, etc.

#### `accept-dialog` / `reject-dialog`
Confirm/cancel any pending dialog (trust, permission, compact, choice).
Returns `{ dialog }` so the caller knows which dialog was answered.
`PRECONDITION_FAILED` if no dialog is pending — protects against stray
Enter/Esc keystrokes leaking into the prompt buffer.

#### `select-choice`
Press a digit key 1–9 for numbered menus. Precondition: a numbered-menu
dialog is pending (`trust`/`permission`/`compact`/`choice`).

## Examples

### Launch CC and send a prompt

```bash
API=http://localhost:3100

# Launch
curl -s $API/terminal/cc/my-cc/launch \
  -H 'content-type: application/json' \
  -d '{"cwd":"/home/ubuntu/my-project","readyTimeoutMs":45000}'
# → { ready: true, finalPhase: "idle", trustPromptHandled: false, elapsedMs: 4321 }

# Status
curl -s $API/terminal/cc/my-cc/status
# → phase, model, contextPct, authEmail, ...

# Prompt
curl -s $API/terminal/cc/my-cc/prompt \
  -H 'content-type: application/json' \
  -d '{"text":"List the files in this directory"}'

# Poll for completion via the footer's idle marker
curl -s $API/terminal/tmux/my-cc/wait-for \
  -H 'content-type: application/json' \
  -d '{"pattern":"ctx:","literal":true,"timeoutMs":60000}'
```

### Handle a permission dialog

```bash
# If CC pauses on "Allow this action?"
curl -s $API/terminal/cc/my-cc/status \
  | jq '.data.pendingDialog'
# → "permission"

curl -s -X POST $API/terminal/cc/my-cc/accept-dialog
# → { dialog: "permission" }
```

### Interrupt + clear

```bash
curl -s -X POST $API/terminal/cc/my-cc/interrupt
# Ctrl-C → CC returns to idle within a few seconds

curl -s $API/terminal/cc/my-cc/slash \
  -H 'content-type: application/json' \
  -d '{"cmd":"clear"}'
```

### Cross-machine via Hub relay

Same as before — replace `localhost:3100` with the Hub relay URL for the
target machine. The Hub forwards request bodies and headers unchanged.

## Audit log

Every mutation produces a JSONL line at
`~/.cache/lm-assist/terminal-audit-{YYYY-MM-DD}.jsonl`:

```json
{"ts":"2026-05-14T06:42:17.123Z","op":"cc.prompt","session":"my-cc","outcome":"ok","elapsedMs":47,"caller":"engine-v6","details":{}}
```

Failures include `errorCode` and `errorMessage` fields.

## Prerequisites

- **POSIX:** tmux installed (`/tmux/install` endpoint helps with first-time setup). For `gnome` tabs also requires `gnome-terminal` and a logged-in desktop session.
- **Windows:** Windows Terminal (`wt.exe`), OpenSSH client, an SSH key registered with the target Linux host.
- **CC adapter:** `claude` resolvable via `getClaudeBinaryPath()` (POSIX: `~/.local/bin/claude` or PATH; Windows: PATH).

## Validation reference

All caller-supplied strings are allowlisted at the route boundary:

| Field | Regex | Notes |
|---|---|---|
| `name` (session) | `/^[A-Za-z0-9_-][A-Za-z0-9_.\-+ ]{0,127}$/` | tmux rejects `:` `.` in session names anyway |
| `paneQualifier` | `/^\d+(\.\d+)?$/` | window or window.pane only — NEVER a session |
| `sshTarget` | `/^[A-Za-z0-9_]+(@[A-Za-z0-9_.\-]+)?$/` | rejects `&`, `;`, `\|`, etc. |
| `cwd` | `/^[\/A-Za-z][^\0;&\|\`$<>(){}*?"'\\]*$/` | absolute, no shell metachars |
| `id` (tab) | `/^tab-[a-z0-9]{8}$/` | generated by registry |
| `cmd` (slash) | `/^[a-z][a-z0-9_-]{0,31}$/i` | covers all built-in CC commands |
| `n` (choice) | integer 1–9 |  |
| `cols` | integer 20–1000 |  |
| `rows` | integer 5–500 |  |
| `timeoutMs` | integer 1–600000 |  |
| `pollMs` | integer 50–10000 |  |
| `lines` | integer 1–10000 | 0 explicitly rejected |
| `keys` | non-empty string, ≤64 KB |  |
| `text` (prompt) | non-empty string, ≤64 KB; `allowNewlines:false` rejects `\r\n` |  |
| env var name | `/^[A-Z_][A-Z0-9_]*$/i` |  |

Unknown fields in request bodies are ignored (not rejected); use the schemas
in `core/src/terminal/validate.ts` as the source of truth.

## cwd allowlist (terminal_open_tab, agent_execute, git clone/commit-push)

The gate (`core/src/utils/cwd-allowlist.ts`) allows the worker's OWN home dir and below,
**plus extra roots the node declares**:

- env `LM_ASSIST_CWD_ROOTS` — `;`-separated on every platform (a Windows path contains `:`), e.g. `C:\home;D:\work`
- file `<dataDir>/cwd-roots` (`~/.lm-assist/cwd-roots`, or `LM_ASSIST_DATA_DIR`) — one path per line, `#` comments

Windows compares case-insensitively. A refusal names the effective policy and both ways to extend
it. `windows_terminal_create` / `windows_terminal_launch` (the Claude-launch surface) are deliberately
NOT gated — this used to be an undocumented inconsistency (2026-09: `C:\home` repos refused by
`terminal_open_tab` on 107 while `windows_terminal_create` opened them).
