# Machine Access Profiles — Design

**Date:** 2026-07-12
**Status:** Approved for implementation (autonomous session; user review pending)
**Branch:** `feat/machine-access-profiles`

## Problem

Knowledge of how to reach other machines *from* a given lm-assist node — SSH endpoint, user, key path, and the per-machine operational quirks — lives scattered across memory files, global CLAUDE.md, and past sessions. Every LLM session must rediscover "how do I get from this node to 107" by grepping prose. There is no structured, queryable, node-local record, and no MCP surface that reports it.

Concrete example — a node today holds this kind of access map (in prose only). Values below are illustrative placeholders; real hostnames/IPs live only in each node's private memory, never in this repo:

| Machine | Access | Quirks |
|---|---|---|
| hub host | `ssh -i ~/.ssh/<key> <user>@<hub-host>` | hub-only host, never install lm-assist |
| data host | `ssh -i ~/.ssh/<key> <user>@<data-host>` | production data capture — do not disturb |
| linux node | `ssh -i ~/.ssh/<key> <user>@<linux-node>` | passwordless sudo; Core is systemd |
| windows node | `ssh -i ~/.ssh/<key> <user>@<windows-node>` | PowerShell via `-EncodedCommand`; Session-1 restarts via schtasks; elevated worker on `127.0.0.1:3110` |

Access is not always plain SSH. Windows→Windows remote code execution under account trust (WinRM `Invoke-Command`, `schtasks /S`, PsExec) is a real future need, and 107's elevated worker is an existing non-SSH access channel. v1 supports **SSH only**, but the schema must extend to these without a break.

## Goals

1. **Node-local store** of machine access profiles: `~/.lm-assist/machine-access.json` (dev repo: `machine-access-dev.json`). A plain file like `cluster.json` — **not** a synced dataset; profiles never leave the node except when reported on demand.
2. **v1 = SSH**: full support for `type: "ssh"` access methods. Unknown/future types load, persist, and report as `supported: false` (forward compatible).
3. **REST routes**: read for the web UI / local callers; **loopback-only writes** (same guard as `POST /cluster/self`).
4. **MCP read tool `machine_access`** reporting the meta so any LLM (local plugin session or remote connector routed to this node) knows what this node can reach and how — including that commands must run **on this node**.
5. **No secrets**: identity file *paths* only, never key material; no password/token fields in v1.

## Non-goals (v1)

- No fleet sync and no cross-node query parameter. The MCP provenance footer + connector routing already identify/select the answering node; each node reports only its own reach.
- No execution capability. The tool reports; running the SSH command happens through existing surfaces (Bash on the node, `agent_execute`, terminal driving).
- No web UI page, no `~/.ssh/config` import, no reachability probing — listed as future work.
- No `windows-account` implementation — schema slot + documentation only (explicit user de-prioritization).

## Design

### Storage & module

`core/src/machine-access/store.ts` owns the file, following `cluster-config.ts` exactly:

- Path: `~/.lm-assist/machine-access${IS_DEV_REPO ? '-dev' : ''}.json` (`IS_DEV_REPO = !__dirname.includes('node_modules')`).
- Read fresh from disk per operation (no watcher; the file is tiny and hand-editable — external edits are picked up on next read).
- Atomic save: write `<file>.tmp` then `renameSync` (avoids a torn file if Core dies mid-write).
- Missing or corrupt file → empty store + `console.warn`; never throws at Core boot (boot resilience, chokidar lesson).
- All functions accept an optional explicit file path (test injection); default is the standard path.

### Schema

```jsonc
{
  "version": 1,
  "machines": [
    {
      "id": "sg-hub",                    // required; slug [a-z0-9][a-z0-9._-]*
      "name": "SG hub instance",         // required; display name
      "description": "LangMartDesign hub host",
      "os": "linux",                     // free string; "linux" | "windows" | "darwin" typical
      "tags": ["oracle-cloud", "hub"],
      "enabled": true,                   // default true; disabled machines still listed, flagged
      "notes": "NEVER install lm-assist here. Deploy = git pull + ./core.sh restart 1 2 web --prod",
      "access": [                        // ordered by preference; >=1 entry
        {
          "type": "ssh",
          "host": "<hub-host>",         // required
          "user": "<user>",             // required
          "port": 22,                    // optional; default 22
          "identityFile": "~/.ssh/<key>",  // optional PATH — never key material
          "notes": "per-method notes"
        }
      ],
      "createdAt": "2026-07-12T...",     // set by store on create
      "updatedAt": "2026-07-12T..."      // set by store on every upsert
    }
  ]
}
```

`AccessMethod` is a discriminated union on `type`. v1 ships `SshAccess` only. Future types (documented, not implemented):

- `windows-account` — Windows→Windows RCE under current-account/domain trust. Sketch: `{ type, host, transport: 'winrm'|'schtasks'|'psexec', user?, authority: 'current-account'|'stored-credential' }`.
- `elevated-worker` — the 107 pattern: `{ type, url: 'http://127.0.0.1:3110', tokenFile: 'C:\\Users\\admin\\.lm-assist\\api-token' }`.

Forward-compat rules: on load, access entries with unknown `type` are kept verbatim and round-trip through save; reporting marks them `supported: false`. Unknown top-level file keys are preserved on save.

### Validation

- `id`: `[a-z0-9][a-z0-9._-]*`, max 64 chars, unique.
- `name`: non-empty string.
- `access`: non-empty array. Each `ssh` entry: `host` and `user` non-empty; `port` integer 1–65535 if present; `identityFile` if present must be a single-line path and must not contain `PRIVATE KEY` (refuses pasted key material).
- Invalid input → structured `INVALID_INPUT` error; nothing written.

### Derived reporting (not stored)

For each `ssh` access the store derives `command`: `ssh -i <identityFile> -p <port> <user>@<host>` (flags omitted when unset/default). Stored fields stay the single source of truth; the command is convenience output for the LLM.

### REST routes — `core/src/routes/core/machine-access.routes.ts`

| Method | Pattern | Guard | Purpose |
|---|---|---|---|
| GET | `/machine-access` | normal (same as other reads) | Full report: machines with derived commands, counts, node hostname |
| PUT | `/machine-access/machines/:id` | **loopback only** | Upsert one machine (id in path is authoritative; body may omit id) |
| DELETE | `/machine-access/machines/:id` | **loopback only** | Remove one machine |

Loopback guard = `isLoopbackAddress(req.clientIp)` from `enroll-exempt.ts` (the `POST /cluster/self` precedent). Writes are deliberately *not* reachable through the hub relay or LAN: registering/altering SSH endpoints is a node-owner action, done on the node (curl on loopback or hand-editing the JSON). Registered in `routes/core/index.ts`.

### MCP tool — `core/src/mcp-server/tools/machine-access.ts`

- Name: `machine_access`. Read-only (`annotations: { readOnlyHint: true }`, read scope — same registration style as `cluster_list`).
- Args: `{ id?: string; tag?: string }` — optional filters; no args lists everything.
- Output: JSON — node identity (hostname, so the reader knows *whose* reach this is), machines with derived commands + notes, and a fixed `usage` string: profiles are node-local; run the reported commands **on this node** (its terminal, `agent_execute`, or a local session's Bash); writes are loopback REST on the node.
- Registered via `MACHINE_ACCESS_TOOL_DEFS` + `MACHINE_ACCESS_HANDLERS` spread into `EXPANDED_TOOL_DEFS` / handler map in `expanded.ts` — this covers **both** MCP surfaces (stdio + HTTP `/mcp`) since both are configured from the same defs.

### Security

- **Writes**: loopback-only. Neither the hub relay nor LAN callers can add/modify/delete profiles.
- **Reads**: profile meta (host/user/port/key paths/notes) is the same class of information already present in the user's CLAUDE.md and memory, and key paths are useless off-node. Still, reads go through the normal API auth like every other read route.
- **No key material**: schema has no credential fields; `identityFile` validation rejects pasted keys; the store never opens the key file.

### Testing

`core/src/__tests__/machine-access-store.test.ts` (node:test, same dir as cluster tests so the `dist-test/__tests__/**` glob picks it up):

- validation: accepts the four real profile shapes; rejects bad id / missing host/user / bad port / key-material identityFile.
- CRUD round-trip on a temp file path: upsert → list → update (updatedAt changes, createdAt stable) → delete; unknown access `type` survives load→save; corrupt file → empty store.
- derived command: with/without port and identityFile.
- route guard: PUT/DELETE handlers return FORBIDDEN for non-loopback `clientIp`, work for `127.0.0.1` (handlers invoked directly with a minimal fake `ParsedRequest`).
- MCP handler: returns machines + usage text against a seeded temp store.

Manual verification: `./core.sh build`, start dev API, `curl` PUT + GET on `:3200`, confirm `machine_access` appears in the configured MCP tool list.

## Future work (explicitly out of v1)

1. `windows-account` + `elevated-worker` access types (implementation).
2. Optional `~/.ssh/config` import helper.
3. Web UI management page.
4. Cross-node aggregated view (peer-relay), if querying "who can reach X" fleet-wide becomes a need.
5. Reachability probe (`ssh -o BatchMode=yes true`) with cached status.
6. Seeding helper CLI (`lm-assist machine-access add ...`).

## Decision log

- **Plain node-local file, not a dataset** — matches the "accessible from this lm-assist node only" requirement; datasets sync (cluster/fleet scope) which is exactly what we don't want. Precedent: `cluster.json`.
- **Dev/prod file split** (`-dev` suffix) — consistent with `hub.json`/`cluster.json`/`gateway-id`; dev testing never touches prod data. The same physical machines may be seeded into both files; acceptable duplication.
- **PUT upsert instead of POST+PUT** — one write path, id authoritative in the URL; fewer routes to guard.
- **MCP tool is read-only** — the user asked for MCP to *report* the meta. Remote writes of SSH endpoints have bad security smell; loopback REST covers management.
- **No cross-node `node:` arg in v1** — the connector already routes per node and footers the origin; each node answers for itself. Aggregation is future work.

---

# v1.1 Addendum — hardening, gathering, discoverability (2026-07-14)

v1 shipped and was seeded on 117. This addendum makes the process **more stable, secure, and reliable**, makes the usage **meaningful and discoverable** (wired into `bootstrap`), and adds a *gathering* path (import + reachability check) so profiles are not purely hand-authored. Same node-local, no-secrets, loopback-write principles as v1 — nothing here relaxes them.

## Motivation (review findings on v1)

1. **Copy-paste / argv injection.** `host` and `user` are only checked non-empty. A hand-edited `host: "-oProxyCommand=curl…|sh"` or `user: "x; rm -rf ~"` would be baked into the derived `command` string an LLM is told to run, and into any probe's argv. An SSH option-injection via a leading `-` is a real class of bug. → **strict field grammar**.
2. **Report crashes on hand-edited files.** `GET /machine-access` maps over `p.access`; a hand-edited profile missing `access` (documented as a supported edit path) throws and takes down the whole report. → **resilient report** (never throw on one bad profile).
3. **File hygiene.** The store writes with default umask perms and keeps no prior copy. Access metadata deserves `0600`, and an overwrite should leave a one-deep `.bak`. → **0600 + backup**.
4. **Gathering is 100% manual.** No `~/.ssh/config` import, no way to verify a profile actually connects, no on-node recipe. → **import + check + guide**.

## Changes

### A. Validation grammar (store)

Tighten `validateProfile` (still returns first-error-or-null; still the only write gate):

- `host`: `^[A-Za-z0-9._:-]+$` (DNS names, IPv4, bracketless IPv6 hextets, no whitespace/metachars) **and must not start with `-`** (SSH option-injection guard).
- `user`: `^[A-Za-z0-9._-]+$` (portable username set), must not start with `-`.
- `identityFile`: unchanged path checks + must not start with `-`.
- `tags`: each tag `^[A-Za-z0-9._/-]+$` (they feed the `tag` filter; keep them clean).
- These apply to `ssh` entries. Unknown access types remain unconstrained beyond a non-empty `type` (forward compat) — but they never produce a `command`, so they are not an injection surface.

### B. Resilient report (store)

`toReportedMachine` never throws:
- If `access` is not an array → treat as `[]` and attach `reportError: 'access missing or malformed'` on the machine.
- Each entry that is an object with `type:'ssh'` **and passes ssh validation** → `supported:true` + derived `command`. An ssh entry that fails validation → `supported:false, command:undefined, invalid:'<reason>'` (never a bad command string). Non-ssh object → `supported:false`. Non-object entry → skipped with a machine-level `reportError`.

This makes `GET`/`machine_access` robust to a fat-fingered hand edit — the bad machine is flagged, the rest report fine.

### C. File hygiene (store)

`saveMachineAccess`: before `rename`, if the destination exists copy it to `<file>.bak` (one-deep, best-effort). Write the tmp file and the final file with mode `0600`. `mkdir` the `.lm-assist` dir if missing (already done). `chmod` after rename to be certain even if the file pre-existed with looser perms.

### D. Reachability check (new, loopback-only)

`POST /machine-access/machines/:id/check` — actively probe the machine's **first ssh access** and record the result. Node-owner action → loopback-only.

- Pure `buildSshProbeArgs(a: SshAccess, opts?): string[]` → argv for `ssh` (NOT a string):
  `-o BatchMode=yes` (never prompt/hang), `-o ConnectTimeout=<n>` (default 8), `-o StrictHostKeyChecking=accept-new` is **NOT** used — we use `-o StrictHostKeyChecking=yes` so an unknown host key is surfaced, never silently trusted (no `known_hosts` mutation), `-o IdentitiesOnly=yes` + `-i <identityFile>` when a key is set, `-p <port>` when non-default, then `<user>@<host>`, then `--`, then the remote command `true`. Leading-`-` fields are already rejected at write time; `--` before the remote command is defence in depth.
- Run via the existing `runCmd('ssh', args, {timeoutMs})` (execFile, no shell, never rejects, timeout+maxBuffer bounded). A hard `timeoutMs = (ConnectTimeout+5)*1000` backstops a wedged ssh.
- Pure `classifyProbe(code, stderr)` → `{ status: 'ok' | 'auth-failed' | 'host-key-unverified' | 'unreachable' | 'error', detail }`:
  - `code 0` → `ok`.
  - stderr matches `Permission denied|publickey|password` → `auth-failed` (reached the host, creds rejected — still proves reachability).
  - stderr matches `Host key verification failed|REMOTE HOST IDENTIFICATION` → `host-key-unverified`.
  - stderr matches `Could not resolve|Connection timed out|refused|No route|Network is unreachable` → `unreachable`.
  - else → `error` (with trimmed stderr tail as `detail`).
- Persist a compact `lastCheck: { status, detail?, at: ISO }` on the machine **without** bumping `updatedAt` (a probe is not an edit) via a new `setLastCheck(id, result, file?)`. `toReportedMachine` passes `lastCheck` through.
- Response: `{ id, check: {status, detail, at} }`. No secrets, no full stderr dump (tail only, capped).

Security notes: BatchMode guarantees no interactive hang; `StrictHostKeyChecking=yes` means the probe never writes trust; the remote command is the literal `true`; argv-array + `--` + leading-dash rejection close the injection paths. The probe uses only the key already on disk — nothing new is stored.

### E. ssh-config import (new, loopback-only)

`POST /machine-access/import` — parse `~/.ssh/config` into **draft** candidates for owner review. Loopback-only (writes profiles).

- Pure `parseSshConfig(text): SshConfigHost[]` — minimal parser: `Host <patterns>` blocks, case-insensitive keys, collects `HostName/User/Port/IdentityFile`; ignores `Include` (documented limitation) and any block whose pattern contains `*`/`?` (wildcards are not real machines).
- Pure `buildImportCandidates(hosts, {defaultUser}): MachineProfile[]` — one profile per concrete Host: `id` = slugified alias, `name` = alias, `os` unknown, `tags:['imported']`, `enabled:false` (drafts are inert until the owner enables), `access:[{type:'ssh', host: HostName||alias, user: User||defaultUser, port?, identityFile?}]`, `notes` noting the import source. Candidates that fail `validateProfile` are dropped with a reason.
- Route body: `{ apply?: boolean, path?: string }`. Default **dry-run** (`apply` falsely) → returns `{ candidates, skipped, wouldWrite }` and writes nothing. `apply:true` → upserts only candidates whose `id` does **not** already exist (never clobber a curated profile), returns `{ imported, skippedExisting, skippedInvalid }`. `path` overrides the default `~/.ssh/config` (test hook).
- The response tells the LLM to review, add per-machine notes (the operational gotchas import can't know), run `check`, and enable.

### F. Discoverability — `bootstrap` + `guide` + meaningful usage

- New `guide` topic **`machine-access`** in `guide.ts` (`GUIDES` + `BLURB` + `TOPIC_TOOLS['machine-access']=['machine_access']` + added to the bootstrap `order` array) — a short playbook: what it is (node-local reachability meta), when to use it (before SSHing anywhere / "how do I reach X"), the gather recipe (import dry-run → add notes from memory → check → enable), and the on-node execution semantic.
- Because it's in the `order` array, `bootstrap` (called first in every connector session) now surfaces machine-access automatically — **this is the "add to bootstrap" requirement**.
- `MACHINE_ACCESS_USAGE` reworded to lead with the *meaningful* case: "Before opening an SSH/remote session to another machine, call this to get the exact, verified command and the per-machine do/don't notes — instead of guessing or re-reading memory." Keep the node-local + on-node execution + no-secrets clauses.
- `machine_access` tool description gains a one-liner about `lastCheck` and `imported`/disabled drafts.

## Testing (added)

- store: host/user/tag grammar accept/reject incl. leading-`-`; report resilience (missing access, invalid ssh entry → flagged not thrown); save writes `0600` + creates `.bak` on overwrite; `setLastCheck` updates lastCheck without touching updatedAt.
- probe: `buildSshProbeArgs` (BatchMode/ConnectTimeout/IdentitiesOnly/port/`--`/order) + `classifyProbe` for each status from representative stderr; route guard loopback-only.
- import: `parseSshConfig` (multi-host, wildcard-excluded, case-insensitive, IdentityFile) + `buildImportCandidates` (enabled:false, imported tag, invalid dropped); route dry-run writes nothing, apply no-clobbers existing.
- guide: `machine-access` topic resolves and is present in the bootstrap `order`.

## Deploy + e2e (this pass, user-instructed)

Merge → push origin main → dist-sync deploy to 117 prod (:3100) → restart → `refresh_connector_tools` → call `machine_access` over the langmart connector (proves the HTTP `/mcp` surface end-to-end) and confirm `bootstrap` names it. Live `check` against 123 + 107; live `import` dry-run against 117's own `~/.ssh/config`.

## Still out of scope (unchanged)

`windows-account`/`elevated-worker` *implementation*; Web UI; cross-node aggregation; `Include`-directive expansion in the ssh-config parser; a CLI subcommand.
