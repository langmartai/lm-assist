# Machine Access Profiles — Design

**Date:** 2026-07-12
**Status:** Approved for implementation (autonomous session; user review pending)
**Branch:** `feat/machine-access-profiles`

## Problem

Knowledge of how to reach other machines *from* a given lm-assist node — SSH endpoint, user, key path, and the per-machine operational quirks — lives scattered across memory files, global CLAUDE.md, and past sessions. Every LLM session must rediscover "how do I get from this node to 107" by grepping prose. There is no structured, queryable, node-local record, and no MCP surface that reports it.

Concrete example — node 117 today holds (in prose only):

| Machine | Access | Quirks |
|---|---|---|
| SG hub | `ssh -i ~/.ssh/ssh-keys/id_rsa opc@213.35.107.246` | hub-only host, never install lm-assist |
| JP | `ssh -i ~/.ssh/ssh-keys/id_rsa opc@158.101.158.137` | LIVE tick capture — do not disturb |
| 123 / yitest | `ssh -i ~/.ssh/ssh-keys/id_rsa yi@10.0.1.123` | passwordless sudo; Core is systemd |
| 107 / Windows | `ssh -i ~/.ssh/langmart_admin_key admin@10.0.1.107` | PowerShell via `-EncodedCommand`; Session-1 restarts via schtasks; elevated worker on `127.0.0.1:3110` |

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
          "host": "213.35.107.246",     // required
          "user": "opc",                // required
          "port": 22,                    // optional; default 22
          "identityFile": "~/.ssh/ssh-keys/id_rsa",  // optional PATH — never key material
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
