# lm-assist GitHub Routes (`/github/*`)

A unified, multi-backend GitHub action endpoint. Built + tested cross-host (117 + 123) 2026-06-02.

## Endpoint

```
GET  /github                 → { ok, data: { actions: [...] } }   (list available actions)
POST /github/<action>        body = action params → { ok, backend, data } | { ok:false, error }
```

`<action>` ∈ `auth/status whoami repo/get pr/list pr/create pr/close issue/create issue/close
branch/delete file/put git/clone git/commit-push gh api`.

## Three backends (auto-selected, with fallback)

| backend | does | needs | host portability |
|---|---|---|---|
| **api** | REST/GraphQL: repos, PRs, issues, comments, reviews, checks, file contents, refs | a token | ✅ any (token + network) |
| **gh** | `gh` CLI passthrough + convenience flows; uses gh's own auth | `gh` installed + authed | ⚠️ host-dependent |
| **git** | clone / commit / push in a managed working tree | a clone + creds (token-https or SSH) | ✅ (git everywhere) |

Routing: actions prefer `api` when a token is present, fall back to `gh`; `git/*` actions use the git
backend (token-https, or `ssh:true` for SSH keys). Each response reports the `backend` that served it.

## Credential safety (enforced)

- The token is resolved + injected **inside the service** and is **never logged or returned**.
- Resolver order (first hit wins): env `LM_ASSIST_GITHUB_TOKEN` / `GITHUB_TOKEN` / `GH_TOKEN` →
  file `~/.lm-assist/github-token` → `gh auth token` → parse `~/.config/gh/hosts.yml` `oauth_token`.
- For the git backend the token is injected via `http.<host>.extraheader: Authorization: Basic …` env
  (never written into the repo URL/reflog); `ssh:true` uses SSH keys with no token at all.
- Debug logs (stderr) show only `token=present(len=N)|absent source=<src>` — masked, no value.
- HTTP responses are scrubbed of any token-shaped strings as a backstop.

## Structured errors + auth-missing handling

`auth/status` reports each backend's `{available, reason}` (`no_token_source` / `not_installed` /
`not_authenticated` / `no_git_credential`). Action errors carry a code + the offending backend:

`AUTH_MISSING` (401) · `AUTH_INVALID` (401) · `FORBIDDEN` (403, scope/permission) · `NOT_FOUND` (404) ·
`RATE_LIMITED` (429) · `CONFLICT` · `VALIDATION` (422) · `PUSH_REJECTED` · `BACKEND_UNAVAILABLE` (503) ·
`NETWORK` · `SERVER` · `COMMIT_FAILED` · `UNKNOWN_ACTION`. No throw escapes the handler.

## Files

- `core/src/github/github-service.ts` — resolver + 3 backend adapters + workdir manager + actions.
- `core/src/routes/core/github.routes.ts` — the route (registered in `routes/core/index.ts`).
- Compiles clean (`tsc --noEmit` exit 0). Activates on the next lm-assist build + restart.

## Validated (cross-host, 2026-06-02)

- **117** (gh authed, token in hosts.yml, SSH keys): `auth/status` (all 3 available), `whoami`/`repo/get`/
  `pr/list` (api), `git/clone` + `git/commit-push` over **SSH** (branch pushed), `gh` passthrough.
  Real error cases surfaced + handled: `pr/create`/`branch/delete` → **403 FORBIDDEN** (the gh OAuth token
  is read-scoped), `issue/create` → **410** (issues disabled on repo). Write path that works on 117 = git/SSH.
- **123** (no gh, no token, no git identity): graceful — `auth/status` reports each backend unavailable
  with reason; actions return clean `BACKEND_UNAVAILABLE` (503) / `AUTH_MISSING` (401), no crashes.
  With a token supplied via env: `api` + `git` (https-token) work; `gh` still reported unavailable.

## Note on write scope

A *read-scoped* token (like a gh OAuth token) does api reads but 403s on api writes (PR create, ref
delete). For autonomous api writes use a **write-scoped PAT** (or the git/SSH backend for push). This is
the same scope reality as CCR's `import-token` — see `docs/ccr-protocol-and-js-client.md`.
