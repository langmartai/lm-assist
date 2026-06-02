# lm-assist GitHub Routes (`/github/*`)

A unified, multi-backend GitHub action endpoint. Built + tested cross-host (117 + 123) 2026-06-02.

## Endpoint

```
GET  /github                 → { ok, data: { actions: [...] } }   (list available actions)
POST /github/<action>        body = action params → { ok, backend, data } | { ok:false, error }
```

`<action>` ∈ `auth/status accounts/list whoami repo/get repo/list pr/list pr/create pr/close
issue/create issue/close branch/delete file/put fork git/clone git/commit-push gh api`.

## Multiple accounts

Every action accepts an optional `"account": "<github-login>"` in the body to act as a specific
GitHub account. `POST accounts/list` enumerates the accounts available on the host (names + sources,
**never tokens**). With no `account`, the host's default credential is used (unchanged behaviour).

Per-account credential resolution (first hit wins), host-portable across gh versions:

1. env `LM_ASSIST_GITHUB_TOKEN_<ACCOUNT>` (e.g. `LM_ASSIST_GITHUB_TOKEN_YIHUANGDB`)
2. file `~/.lm-assist/github-accounts.json` — `{ "<account>": "<token>" }` or
   `{ "<account>": { "token": "...", "ssh"?: bool }, "default": "<account>" }`
3. `gh auth token --user <account>` (modern gh keyring; skipped silently on old gh that lacks `--user`)
4. gh `hosts.yml` — new multi-user `users:` block, or old single-user `user:`/`oauth_token`

**Fail-closed:** an explicitly requested account with **no** resolvable credential returns
`AUTH_MISSING` — it does **not** silently fall back to the host's ambient gh/SSH auth (which would act
as a different account). The git backend's `ssh:true` path auths by SSH key (= the key's owner), so for
account-scoped writes use a per-account token (api or git https-token), not `account` + `ssh`.

## Three backends (auto-selected, with fallback)

| backend | does | needs | host portability |
|---|---|---|---|
| **api** | REST/GraphQL: repos, PRs, issues, comments, reviews, checks, file contents, refs | a token | ✅ any (token + network) |
| **gh** | `gh` CLI passthrough + convenience flows; uses gh's own auth | `gh` installed + authed | ⚠️ host-dependent |
| **git** | clone / commit / push in a managed working tree | a clone + creds (token-https or SSH) | ✅ (git everywhere) |

Routing: actions prefer `api` when a token is present, fall back to `gh`; `git/*` actions use the git
backend (token-https, or `ssh:true` for SSH keys). Each response reports the `backend` that served it.

## Repos, forks, and directory-aware git

- `repo/list` — repos. No `owner` → the **account's own** repos (`/user/repos`, includes private;
  optional `visibility` all|public|private). With `owner` → that user/org's repos
  (`/users/{owner}/repos`). Optional `sort` (default `pushed`), `per_page`, `page`. Returns a compact
  list (`full_name, private, default_branch, pushed_at, html_url`) so responses stay small.
- `fork` — `POST /repos/{owner}/{repo}/forks` (optional `organization` to fork into an org). GitHub
  forks are asynchronous: the call returns before the fork is fully ready.
- **Directory-aware git** — `git/clone` and `git/commit-push` accept an optional `dir` that targets a
  **real directory** instead of the default managed scratch dir (`~/.lm-assist/github-workdirs/{owner}/{repo}`,
  which is shallow and wiped+re-cloned each call). A `dir` is gated by the **shared lm-assist allowlist**
  (`/home/ubuntu/*`, the same gate `agent_execute` uses — `core/src/utils/cwd-allowlist.ts`). Safety:
  - only the managed scratch dir is ever wiped; a caller `dir` is **never clobbered**;
  - `git/clone dir=…` refuses a non-empty directory (`DIR_NOT_EMPTY`); `depth` controls shallowness (0 = full);
  - `git/commit-push dir=…` requires an existing `.git` checkout (`NOT_A_REPO`) and operates **in place**
    (writes `files`, optional `branch` via `checkout -b` falling back to `checkout`, commit, push HEAD/branch);
  - a `dir` outside the allowlist → `FORBIDDEN_DIR`.

## Credential safety (enforced)

- The token is resolved + injected **inside the service** and is **never logged or returned**.
- Resolver order (first hit wins): env `LM_ASSIST_GITHUB_TOKEN` / `GITHUB_TOKEN` / `GH_TOKEN` →
  file `~/.lm-assist/github-token` → `gh auth token` → parse `~/.config/gh/hosts.yml` `oauth_token`.
- For the git backend the token is injected via `http.<host>.extraheader: Authorization: Basic …` env
  (never written into the repo URL/reflog); `ssh:true` uses SSH keys with no token at all.
- Debug logs (stderr) show only `token=present(len=N)|absent source=<src>` — masked, no value.
- **No credential leaves the endpoint.** Every response is deep-redacted in `runAction` (the underlying
  service) before return: token-shaped values (`gh*_…`, `github_pat_…`) and secret-bearing keys
  (`temp_clone_token`, `oauth_token`, `access_token`, `refresh_token`, `client_secret`, `authorization`,
  `token`) become `<REDACTED>`. This holds for every caller — HTTP endpoint and CLI alike.
- The `gh` passthrough is blocked from **reading** credentials: `gh auth …` and `gh config get … token`
  return `FORBIDDEN_PASSTHROUGH` (they never run). Tokens are used only to authenticate inside the service.

## Structured errors + auth-missing handling

`auth/status` reports each backend's `{available, reason}` (`no_token_source` / `not_installed` /
`not_authenticated` / `no_git_credential`). Action errors carry a code + the offending backend:

`AUTH_MISSING` (401) · `AUTH_INVALID` (401) · `FORBIDDEN` (403, scope/permission) · `NOT_FOUND` (404) ·
`RATE_LIMITED` (429) · `CONFLICT` · `GONE` (410) · `VALIDATION` (422) · `PUSH_REJECTED` ·
`BACKEND_UNAVAILABLE` (503) · `NETWORK` · `SERVER` · `COMMIT_FAILED` · `FORBIDDEN_PASSTHROUGH` ·
`FORBIDDEN_DIR` · `DIR_NOT_EMPTY` · `NOT_A_REPO` · `UNKNOWN_ACTION`. No throw escapes the handler.

## MCP tools (`github_query` / `github_mutate`)

The endpoint is exposed over MCP as two scope-classified tools (lm-assist's expanded-catalog framework —
def in `EXPANDED_TOOL_DEFS`, scope in `TOOL_SCOPES`, handler in `EXPANDED_HANDLERS`; both the
StreamableHTTP `/mcp` and stdio `/mcp-call` transports advertise + dispatch them). Each handler POSTs to
`/github/<action>` on loopback (`workerPostRaw`), so every guarantee above — multi-account, fail-closed,
deep-redaction, dir allowlist — applies unchanged.

- **`github_query`** (scope `read`, auto-approved): `auth/status`, `accounts/list`, `whoami`, `repo/get`,
  `repo/list`, `pr/list`. Params: `account, owner, repo, state, visibility, sort, per_page`.
- **`github_mutate`** (scope `write`, per-call approval): `pr/create`, `pr/close`, `issue/create`,
  `issue/close`, `branch/delete`, `file/put`, `fork`, `git/clone`, `git/commit-push`. Params:
  `account, owner, repo, branch, title, body, head, base, number, path, content, message, files[],
  ssh, organization, dir, depth`.

The raw `gh` / `api` passthrough actions are **not** exposed over MCP (HTTP endpoint only). Files:
`core/src/mcp-server/tools/github.ts`, wired in `tools/expanded.ts`, scopes in `configure.ts`.

## Files

- `core/src/github/github-service.ts` — resolver + 3 backend adapters + workdir manager + actions.
- `core/src/routes/core/github.routes.ts` — the route (registered in `routes/core/index.ts`).
- Compiles clean (`tsc` exit 0). **LIVE on 117 + 123 `:3100`** (and on Windows when lm-assist is started —
  dist patched, core left stopped). All of this (multi-account, credential hardening, MCP tools, repo/list +
  fork + dir-aware git) is merged to `origin/main` and tracked under CHANGELOG `[Unreleased]` — **not yet
  npm-published**, so the live installed dists stay patched until a release is cut.

## Validated (cross-host, 2026-06-02)

- **117** (gh authed, token in hosts.yml, SSH keys): `auth/status` (all 3 available), `whoami`/`repo/get`/
  `pr/list` (api), `git/clone` + `git/commit-push` over **SSH** (branch pushed), `gh` passthrough.
  Real error cases surfaced + handled: `pr/create`/`branch/delete` → **403 FORBIDDEN** (the gh OAuth token
  is read-scoped), `issue/create` → **410** (issues disabled on repo). Write path that works on 117 = git/SSH.
- **123** (no gh, no token, no git identity): graceful — `auth/status` reports each backend unavailable
  with reason; actions return clean `BACKEND_UNAVAILABLE` (503) / `AUTH_MISSING` (401), no crashes.
  With a token supplied via env: `api` + `git` (https-token) work; `gh` still reported unavailable.

### Multi-account validated (2026-06-02)

- **Windows** (gh 2.76 keyring holds **two** accounts — YiHuangDB + langmartai): live endpoint —
  `accounts/list` → both (YiHuangDB active); `whoami account=langmartai` → langmartai,
  `whoami account=YiHuangDB` → YiHuangDB (distinct identities); **access differentiation** —
  `repo/get YiHuangDB/lm-unified-trade` (private) returns the repo as `account=YiHuangDB` but
  **NOT_FOUND** as `account=langmartai`; `account=nosuchacct` → **AUTH_MISSING** (fail-closed).
  Core log credential-clean (`token=present(len=N)`, zero token-shaped strings).
- **117** (gh 2.4 single-user hosts.yml = langmartai only): `accounts/list` → langmartai; `account=langmartai`
  works via hosts.yml; `account=YiHuangDB` → **AUTH_MISSING** (no YiHuangDB credential on the host — fails
  closed instead of acting as langmartai). Drop a YiHuangDB PAT in `~/.lm-assist/github-accounts.json` (or
  `LM_ASSIST_GITHUB_TOKEN_YIHUANGDB`) to enable it.

Note: gh **v2.4** (117) has no `gh auth token --user` — the resolver falls through to hosts.yml; gh **v2.76**
(Windows) supports it and reads the keyring. The layered resolver works on both.

## Note on write scope

A *read-scoped* token (like a gh OAuth token) does api reads but 403s on api writes (PR create, ref
delete). For autonomous api writes use a **write-scoped PAT** (or the git/SSH backend for push). This is
the same scope reality as CCR's `import-token` — see `docs/ccr-protocol-and-js-client.md`.
