# Terminal API

REST endpoints for creating and controlling terminal tabs across platforms,
with `tmux` as the uniform control surface.

All endpoints are served by the core API (dev `:3200`, prod `:3100`) and are
reachable cross-machine via the Hub API relay — the caller just targets the
host where the tab needs to open or where the tmux session actually runs.

## Tab kinds

| Kind | Where | What it does |
|------|-------|--------------|
| `gnome` | Linux host | Opens a new `gnome-terminal --tab`. Propagates the logged-in user's `DISPLAY`/D-Bus env so it works even when the request came in over SSH. |
| `wt-ssh` | Windows host | Opens a new Windows Terminal tab via a scheduled task, running `ssh -t <target> tmux attach -t <session>`. The scheduled task bridges SSH session 0 → interactive console session 1. |
| `tmux` | any POSIX host | Creates a detached tmux session only — no GUI viewer. Any number of tabs, `ttyd` web terminals, or SSH clients can attach separately. |

## Endpoints

### Tab lifecycle

| Method | Path | Body |
|--------|------|------|
| POST | `/terminal/tabs` | `{ kind, title?, cwd?, command?, tmuxSession?, sshTarget?, env?, cols?, rows? }` |
| GET  | `/terminal/tabs` | — |
| GET  | `/terminal/tabs/:id` | — |
| DELETE | `/terminal/tabs/:id` | — |

Deleting a tab kills its tmux session (if any) which in turn closes the GUI
viewer. The registry is persisted at `~/.cache/lm-assist/terminal-tabs.json`.

### tmux control (this host's tmux server)

| Method | Path | Body / Query |
|--------|------|--------------|
| GET    | `/terminal/tmux` | list sessions |
| POST   | `/terminal/tmux` | `{ name, cwd?, cols?, rows?, command? }` — create detached |
| DELETE | `/terminal/tmux/:name` | kill-session |
| POST   | `/terminal/tmux/:name/send-keys` | `{ keys, literal?, enter?, target? }` |
| GET    | `/terminal/tmux/:name/capture`   | `?lines=N&target=name:win.pane` |
| POST   | `/terminal/tmux/:name/wait-for`  | `{ pattern, literal?, flags?, timeoutMs?, pollMs?, lines? }` |

`send-keys` flags map directly to `tmux send-keys` — `literal: true` adds
`-l` (text as typed, no key-name interpretation), `enter: true` appends an
`Enter` key after.

`wait-for` polls `capture-pane` until `pattern` matches (regex by default,
substring when `literal: true`). Returns `{ matched, elapsedMs, screen }`.

### Claude Code wrappers (tmux-pivot pattern)

Thin convenience layer for the pattern documented in
[docs/claude-code-internals/compaction/custom-synthetic-session.md](./claude-code-internals/compaction/custom-synthetic-session.md).

| Method | Path | Body |
|--------|------|------|
| POST | `/terminal/cc/:name/launch` | `{ cwd, model?, flags?, readyPattern?, readyTimeoutMs? }` |
| POST | `/terminal/cc/:name/pivot`  | `{ newSessionId, prompt, promptPattern?, timeoutMs? }` |
| POST | `/terminal/cc/:name/prompt` | `{ text }` |

`launch` creates the tmux session, runs `claude <flags> --model <model>`,
and waits for the ready indicator (default substring `ctx:`). `pivot`
sends `/resume <id>` then re-sends the prompt literally after the `❯`
prompt reappears. `prompt` just sends literal text + Enter.

## Usage patterns

### Open a local gnome tab attached to a tmux session

```bash
# Create tmux, attach a visible gnome tab, drive from the API
curl -s http://localhost:3100/terminal/tabs \
  -H 'content-type: application/json' \
  -d '{"kind":"gnome","title":"work","tmuxSession":"work","cwd":"/home/ubuntu"}'

curl -s http://localhost:3100/terminal/tmux/work/send-keys \
  -H 'content-type: application/json' \
  -d '{"keys":"htop","enter":true}'
```

### Cross-machine: Windows tab viewing a Linux tmux session

```bash
LINUX=http://10.0.1.117:3100     # lm-assist on Linux box
WIN=http://10.0.1.107:3100       # lm-assist on Windows box

# 1. Create the tmux session on Linux
curl -s $LINUX/terminal/tmux \
  -H 'content-type: application/json' \
  -d '{"name":"build","cols":180,"rows":50}'

# 2. Open a Windows Terminal tab that SSHes in and attaches
curl -s $WIN/terminal/tabs \
  -H 'content-type: application/json' \
  -d '{"kind":"wt-ssh","title":"build","sshTarget":"ubuntu@10.0.1.117","tmuxSession":"build"}'

# 3. Drive from anywhere — output appears in the Windows tab
curl -s $LINUX/terminal/tmux/build/send-keys \
  -H 'content-type: application/json' \
  -d '{"keys":"npm run build","enter":true}'
```

The same flow works over the Hub — if both hosts are connected,
replace the direct `10.0.1.107:3100` URL with the Hub relay URL for that
machine and everything tunnels through the cloud.

### Claude Code runtime pivoting (documented use case)

Runs Claude Code under tmux and pivots it to a freshly-built session in
response to a user prompt — same pattern as
`docs/claude-code-internals/compaction/custom-synthetic-session.md:322`,
but exposed as API.

```bash
API=http://localhost:3100

# 1. Launch CC in a tmux session (waits for the ready indicator)
curl -s $API/terminal/cc/cc-main/launch \
  -H 'content-type: application/json' \
  -d '{"cwd":"/home/ubuntu/project","model":"haiku"}'

# 2. User prompt arrives. Your controller has built a synthetic session
#    with the right context. Pivot CC to it and re-send the prompt.
curl -s $API/terminal/cc/cc-main/pivot \
  -H 'content-type: application/json' \
  -d '{
    "newSessionId":"abc123-...",
    "prompt":"explain the auth middleware changes"
  }'

# 3. Or just send a prompt to the currently-loaded session
curl -s $API/terminal/cc/cc-main/prompt \
  -H 'content-type: application/json' \
  -d '{"text":"run the tests"}'
```

To make this visible, open a tab attached to the same tmux session — the
CC TUI will render in real time:

```bash
# Linux-side viewer
curl -s $API/terminal/tabs -d '{"kind":"gnome","tmuxSession":"cc-main"}' -H 'content-type: application/json'
# Or Windows-side viewer
curl -s http://win-host:3100/terminal/tabs -d '{"kind":"wt-ssh","sshTarget":"ubuntu@linux-host","tmuxSession":"cc-main"}' -H 'content-type: application/json'
```

## Prerequisites

### Linux (for `gnome` tabs)
- `gnome-terminal` installed (default on Ubuntu desktop).
- A logged-in desktop session owned by the same user running lm-assist. If
  the API is reached over SSH, the manager finds the desktop env vars
  (`DISPLAY`, `DBUS_SESSION_BUS_ADDRESS`, `XDG_RUNTIME_DIR`) by scanning
  `/proc/<pid>/environ` of the running `gnome-terminal-server` /
  `gnome-shell`.

### Windows (for `wt-ssh` tabs)
- Windows Terminal (`wt.exe`) installed — comes preinstalled on Windows 11.
- OpenSSH client installed (standard on modern Windows) and an SSH key
  registered with the target Linux host so `ssh -t <target>` works
  non-interactively.
- A user logged in to the console session. The manager creates a scheduled
  task `LmAssistOpenWtTab` on first use and triggers it with
  `schtasks /run`; Task Scheduler routes the invocation to the interactive
  user session so the tab becomes visible.

### tmux (any POSIX host in the control path)
- `tmux` installed. On Linux, see `/tmux/status` endpoint for auto-install
  helpers.

## Implementation notes

- Each lm-assist handles only the tab kinds its OS supports. A
  cross-platform controller can discover capabilities via `GET /health`
  (`platform` field) and dispatch to the appropriate host.
- Tab deletion kills the tmux session, which closes any attached viewers
  transitively. The tab entry is always removed from the registry even if
  the tmux kill fails.
- All `tmux` control endpoints operate on the tmux server local to the
  lm-assist handling the request. There is no remote tmux control — to
  drive a session on another host, call that host's lm-assist (directly
  or via the Hub relay).
