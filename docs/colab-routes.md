# Google Colab CLI API (`colab`)

`lm-assist` wraps the official `google-colab-cli` (`colab`) binary behind structured REST endpoints and MCP tools (`colab_query` / `colab_mutate`) following the same pattern as `/github/*`.

> **Platform requirement:** Upstream `google-colab-cli` supports **Linux and macOS** only. When operating from a Windows coordinator in a multi-node cluster, invoke `colab_query` / `colab_mutate` with `node="<linux-node>"` (or hit `/colab/*` on the Linux node).

---

## Setup on Linux / macOS Nodes

Install `google-colab-cli`:

```bash
uv tool install google-colab-cli
# or:
pip install google-colab-cli
```

Authenticate (either OAuth2 browser flow stored in keyring/config, or GCP Application Default Credentials):

```bash
# Headless / agent ADC setup
gcloud auth application-default login \
  --scopes=openid,https://www.googleapis.com/auth/cloud-platform,https://www.googleapis.com/auth/userinfo.email,https://www.googleapis.com/auth/colaboratory
```

Optional override for the binary path: `LM_ASSIST_COLAB_BIN=/path/to/colab`.

---

## REST Endpoints

| Method | Path | Body | Purpose |
|---|---|---|---|
| `GET` | `/colab` | — | Lists supported `actions`, `readActions`, and `writeActions`. |
| `GET` | `/colab/status` | — | Runs `doctor` (checks platform support, resolved binary, `colab version`, `colab whoami` auth state, keyring status, and `loginGuide`). |
| `GET` | `/colab/overview` | `?auth=oauth2\|adc` | Combined snapshot (`doctor` + `usage` credits/rate + merged `sessions` status & `activeCount`). |
| `GET` | `/colab/usage` / `/colab/credits` | `?auth=oauth2\|adc` | Returns compute units balance, hourly burn rate, and active assignments (`usage`). |
| `GET` | `/colab/sessions` / `/colab/instances` | `?auth=oauth2\|adc` | Lists active Colab VM instances with hardware, shape, variant, and `activeCount`. |
| `GET` | `/colab/login/status` | `?auth=oauth2\|adc` | Checks current Colab CLI authentication identity (`loggedIn`, `email`, `authProvider`, `expiresIn`, `keyringWarning`, `loginGuide`). |
| `POST` | `/colab/login/start` | `{ auth?, oauthConfig?, config? }` | Starts guided login: for `oauth2`, returns `{ status: 'already_logged_in', email }` or `{ status: 'awaiting_code', loginId, authUrl, keyringWarning, instructions }`; for `adc`, returns `ADC_LOGIN_COMMAND` if unauthenticated. |
| `POST` | `/colab/login/complete` | `{ loginId, code }` | Submits the authorization code copied from `authUrl` to complete `oauth2` sign-in and reports `logged_in` + `persisted`. |
| `POST` | `/colab/:action` | Action JSON params | Executes one validated Colab CLI action and returns `{ success, ok, backend: 'colab-cli', data | error }`. |

Global parameters accepted by `POST /colab/:action` (placed **before** the subcommand):
- `auth?: 'oauth2' | 'adc'` (`--auth`)
- `oauthConfig?: string` (`-c`)
- `config?: string` (`--config`)
- `timeoutMs?: number` (clamped `1000..600000`)

---

## Supported Actions

### Read actions (`colab_query`)

| Action | Key Params | Underlying CLI |
|---|---|---|
| `doctor` | — | Checks platform, binary, `colab version`, non-interactive `colab whoami` auth state, keyring/ADC presence, and `loginGuide` |
| `overview` | — | Combined `doctor`, `usage` (credits/rate), and merged `sessions` + `status` |
| `version` | — | `colab version` |
| `whoami` | — | `colab whoami` (token identity, provider, expiry, scopes) |
| `sessions` | — | `colab sessions` |
| `status` | `session?` | `colab status [-s NAME]` |
| `usage` | — | `colab usage` |
| `url` | `session?` | `colab url [-s NAME]` (never `--open`) |
| `ls` | `session?, path?` | `colab ls [-s NAME] [PATH]` |
| `log` | `session?, n?, outputFile?` | `colab log [-s NAME] [-n N] [-o FILE]` (`n` clamped `1..200`; `outputFile` allowlist-gated) |

### Write actions (`colab_mutate`)

| Action | Key Params | Underlying CLI |
|---|---|---|
| `login-start` | `auth?, oauthConfig?, config?` | Starts guided OAuth2 login (returns `authUrl` + `loginId`) or returns `gcloud` ADC command |
| `login-complete` | `loginId, code` | Completes pending OAuth2 login by passing the copied authorization code |
| `new` | `session?, gpu?, tpu?, highMem?` | `colab new` (`gpu`: `T4\|L4\|G4\|A100\|H100`; `tpu`: `v5e1\|v6e1`) |
| `stop` | `session? \| all?` | `colab stop [-s NAME]` or `colab stop --all` |
| `stop` | `session?` | `colab stop [-s NAME]` |
| `restart-kernel` | `session?` | `colab restart-kernel [-s NAME]` |
| `exec` | `session?, code \| file, outputImage?` | `colab exec` (`code` via stdin, or allowlisted `-f file`) |
| `run` | `script, gpu?, tpu?, highMem?, keep?, args?` | `colab run` (allowlisted `script` + forwarded `args[]`) |
| `install` | `session?, packages[] \| requirementsFile` | `colab install` (validated package specs or allowlisted `-r file`) |
| `upload` | `session?, localPath, remotePath` | `colab upload` (`localPath` allowlisted) |
| `download` | `session?, remotePath, localPath` | `colab download` (`localPath` allowlisted) |
| `rm` | `session?, remotePath` | `colab rm` |
| `drivemount` | `session?, path?` | `colab drivemount` |
| `auth` | `session?` | `colab auth` |
| `logout` | — | `colab logout` |
| `ssh-exec` | `session?, command[]` | `colab ssh [-s NAME] -- <argv...>` |

### HTTP-only Passthrough (not exposed over MCP)

- `POST /colab/cli` with `{ args: string[], stdin?, ...globalParams }` invokes `colab` directly on the REST API for advanced subcommands (`repl`, etc.); `colab_mutate` intentionally restricts MCP callers to the structured `COLAB_WRITE_ACTIONS`.

---

## Web UI & CLI

- **Web Dashboard (`/colab`, `:3848/colab`):** Provided by `web/src/app/(dashboard)/colab/page.tsx` and linked from the sidebar (**Colab**). Supports self-service OAuth2/ADC sign-in (`login-start` → clickable Google auth link → paste code → `login-complete`), `logout`, live compute-unit balance & burn rate cards, and runtime lifecycle controls (`new`, `restart-kernel`, `stop`, `stop --all`).
- **Node CLI (`lm-assist colab`):**
  - `lm-assist colab status [--auth oauth2|adc]` — prints CLI version/binary, signed-in email, compute units balance/burn rate, and active instances.
  - `lm-assist colab login [--auth oauth2|adc]` — runs guided OAuth2 login interactively in the terminal (prints URL, reads pasted code, completes token exchange) or prints the `gcloud` ADC command.
  - `lm-assist colab usage` (alias `credits`) — prints compute units balance, hourly rate, and active assignments.
  - `lm-assist colab sessions` (alias `instances`) — lists active Colab VM sessions.
  - `lm-assist colab logout [--auth oauth2|adc]` — clears Colab CLI credentials.

---

## Security & Redaction

- All local file paths (`file`, `script`, `localPath`, `requirementsFile`, `outputImage`, `outputFile`) are checked against `isCwdAllowed(...)` (out-of-bounds paths fail with `code: 'FORBIDDEN'`).
- Output (`stdout` / `stderr`) is truncated at `64 KiB` and scrubbed for `Bearer ...`, `ya29....`, `AIza...`, and `1//...` tokens before returning or logging.
