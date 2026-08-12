# Brief: MCP-driven build/deploy — bootstrap, permissions, and node targeting

Handed off 2026-07-28 from the session that shipped `4f190a7 … 87ce5b4` on `main`.
Everything below is measured, not assumed.

## Three tasks

### 1. Harden `node_upgrade` for multi-node safety (the important one)

`core/src/mcp-server/tools/node-upgrade.ts` already exists: admin-scoped, destructive,
with a downgrade guard where a bare call is a safe no-op. Four gaps:

1. **No default node for destructive ops.** `node` currently falls back to "your default
   node" (most-recently-connected). Refuse instead, exactly like the existing `source`
   guard, and name the candidates. You should have to *say* which machine you replace.
2. **Pre-flight echo, not post-hoc footer.** Results carry `⟦lm-assist@hub · node · cluster⟧`,
   which is good provenance but arrives *after*. Before dispatching, resolve and state:
   hub, cluster, hostId, hostname, current build → intended build.
3. **Verify `source` exists ON THE TARGET.** `source` is an absolute path on the target
   node. Building a tgz on 117 and aiming it at 107 silently fails late. A cheap existence
   check turns that into a clear refusal.
4. **Two connectors, identical tool names.** prod hub and dev hub serve independent fleets.
   State the hub in the response, and fail loudly if the named node is not in that
   connector's fleet.

**Why this matters — routing ambiguity is real, observed four times in one session:**

| call | actually went to |
|---|---|
| `backlog_get` (no `node`) | yitest / **stage**, not the caller's node |
| `mission_update` | failed `no mission` until `cluster: "prod"` was passed |
| `refresh_connector_tools` | DESKTOP-GDKLATG |
| `ccr_remote_list` (no `node`) | defaulted to yitest |

Fine for a read. Unacceptable for a deploy.

### 2. Update bootstrap + permission prose for the new deploy flow

Editable fleet prose (assist-content registry), not code. Must now describe:

- `./core.sh deploy` and `.\core.ps1 deploy` — provenance gate → pack → install → verify.
  Both refuse a dirty or behind-`origin/main` checkout unless `--allow-dirty` / `-AllowDirty`.
- `node_upgrade source=<abs .tgz ON the target>` remains the cross-node path.
- 🔴 **Never `npm install -g lm-assist@latest`** — npm `latest` predates all of this and
  would downgrade the fleet *and* re-break the chokidar pin.
- Windows specifics now known rather than guessed (see below).

### 3. Seed a CCR session — done; this is it.

## Windows facts, all measured on 107

- **Core must run in Windows session 1.** Started over SSH it lands in session 0, looks
  perfectly healthy, and can drive nothing. `lm-assist start` now self-corrects via
  `schtasks /run /tn LmAssistCoreInteractive` and verifies where it landed.
- **The elevated worker is now RELOCATED** to `~/.lm-assist/worker-runtime` (a 4-file,
  zero-dependency closure) and its task points there. It used to run from the install dir
  and made every `npm install -g` fail with `EBUSY`, because Windows cannot rename a
  directory a process holds open. This is done and durable.
- 🔴 **STILL BROKEN — the next thing to fix.** `lm-assist upgrade` on Windows dies right
  after stopping services; the log always ends at Step 2:
  ```
  Killed PID … on port 3100
  Killed PID … on port 3848
  Removed PID file: core-prod.pid
  [log ends — step 3 never runs]
  ```
  Suspicion (UNPROVEN): the OpenSSH Job Object behaviour already noted in
  `service-manager.ts`. Do not repeat that as fact until measured.
- `schtasks /change` **hangs** behind the worker's `/exec` (prompts for the run-as password,
  no stdin). Use `Set-ScheduledTask`.
- The worker's `/exec` joins `args` with **plain spaces and no quoting**
  (`${cmd} ${args.join(' ')}`), so the array looks like argv but is string concatenation.
  Send one fully-quoted command. Auth is `x-api-key`; Bearer is rejected 401.
- `core.ps1` is **pure ASCII on purpose** — Windows PowerShell reads a BOM-less `.ps1` as
  ANSI, so non-ASCII breaks string literals and the file will not parse.

## Node map

| node | role | notes |
|---|---|---|
| 117 `ubuntu-Virtual-Machine` | prod | deployed via `./core.sh deploy`; reaper fix live; `OPERATOR_PAUSE` hack retired |
| 123 `yitest-Virtual-Machine` | stage | healthy; **no git checkout**, so the local-script workflow cannot run there yet |
| 107 `DESKTOP-GDKLATG` | Windows | all runtime fixes present; worker relocated; packaged install still blocked |

## Standing risks

- **Nothing is published to npm.** `install-source.json` reads `custom` on 117. A plain
  `lm-assist upgrade` (no `--from`) pulls npm latest and reverts everything.
- **No PR record.** The `gh` PAT lacks `pull_requests: write`, so 16 commits fast-forwarded
  straight onto `main`. SSH pushes are unaffected. Grant the scope if review gates matter.
- Pre-existing test baseline on `main`: **3060 pass, 3 fail, 1 hung** (SyncEngine ×3 +
  `memory-project-id-resolution` hang). Match this before blaming your own change.

## The discipline that actually mattered

Five bugs on this branch reported an *intention* as an *outcome*: `success:false`,
`launched:true`, `submitted:true`, DRY-RUN `would-reap=0`, and a deploy script exiting 0
on failure. Assume the next one exists.

And check your own instruments: four measurement errors in that session — comparing JSON
that included `requestId`, reading `$?` through a pipe (twice), and POSTing to the wrong
route — each of which briefly "proved" something false. Read the output, not the status.
