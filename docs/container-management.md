# Container management — Docker (Docker Desktop on Windows / Docker Engine on Linux)

Fleet-wide container management: a common API (`/container/*` routes) over one engine backend,
surfaced as 5 MCP tools. Sibling of [vm-management](vm-management.md), same file split. Unlike
Hyper-V vs KVM, the Docker CLI is ONE cross-platform binary — so there is a single backend whose
*daemon probe* is platform-aware, not two backends. A node with no reachable daemon degrades
gracefully: `container_status` still answers `available:false` + a `reason` naming the fix, and
every other call fails `DOCKER_UNAVAILABLE` instead of hanging.

## Where things live

```
core/src/container/
├── types.ts          ← engine-facing contract: ContainerBackend, ContainerInfo, ContainerRunSpec,
│                       ContainerError + ContainerErrorCode (DOCKER_UNAVAILABLE, UNSAFE_PATH,
│                       CONTAINER_NOT_MANAGED, BUSY, …). No docker flags, no model prose.
├── config.ts         ← deployment facts ONLY: binary, endpoint, elevation, volumeRoots, labels,
│                       charset regexes, limits, timeouts. Read PER CALL — no restart needed.
├── docker-backend.ts ← the only place `docker` flags exist: argv arrays, JSON parsing, daemon probe.
└── service.ts        ← THE single import surface. Validation, containment, managed gate, bounded
                        single-flight write mutex. Routes + MCP tools import from here only.
core/src/routes/core/container.routes.ts · core/src/mcp-server/tools/container.ts (5 loopback tools)
```

## MCP tools (all carry the fleet `node` selector automatically)

| tool | scope | what |
|---|---|---|
| `container_status` | read | engine doctor + bounded inventory `{containers,total,truncated}`; `name=` → one container in full; `images=true` adds images. No `container_list` — status absorbs it (catalogue byte budget). |
| `container_run` | write | `docker run -d` under the managed label; pulls the image if missing |
| `container_power` | write | `action:start\|stop\|restart`; idempotent, returns the new state |
| `container_logs` | read | bounded tail of stdout+stderr merged |
| `container_delete` | admin | stop if running, remove; `remove_image` also drops an unused image |

## Routes

```
GET  /container/status ?name= ?images=1 · /list {containers,total,truncated} · /images · /logs ?name=&lines=&since=&timestamps=
GET  /container/config → {file, config, effective}   PUT /container/config → whitelist patch; unknown ⇒ UNSUPPORTED_FIELD (echoes it)
POST /container/run {name,image,command,env,ports,volumes,restart,memoryMB,cpus,network,workdir,autoRemove,pull,notes}
POST /container/power {name,action,force?,timeoutSec?}   ·   POST /container/delete {name,force?,removeImage?}
```

## Config — `<dataDir>/container[-dev].json`, read on EVERY call

`<dataDir>` = `LM_ASSIST_DATA_DIR` or `~/.lm-assist`; the `-dev` suffix applies to a repo build
(`__dirname` outside `node_modules`, unless `LM_ASSIST_PROD=true`) so dev and prod never collide.
Effective value = **env > config file > default**, resolved per call — a config change needs no restart.

| field | env override | default |
|---|---|---|
| `dockerBin` | `LM_CONTAINER_BIN` | `docker` — a bare name (`/^[A-Za-z0-9._-]{1,32}$/`) or an absolute path; anything else falls back to `docker` rather than reaching `spawn()` |
| `dockerHost` | `LM_CONTAINER_HOST` | inherited `DOCKER_HOST`, else npipe (win32) / `unix:///var/run/docker.sock` |
| `elevation` | `LM_CONTAINER_ELEVATION` | `auto` (direct, then `sudo -n` on POSIX) · `always` · `never` |
| `volumeRoots` | `LM_CONTAINER_VOLUME_ROOTS` (os-path-separator separated) | **empty — bind mounts refused** |
| `defaultNetwork` | — | `null` (engine default bridge) |
| `limits` | — | `maxContainers` 100 · `maxMemoryMB` 32768 · `maxCpus` 16 · `maxPorts` 20 · `maxVolumes` 10 · `maxEnv` 50 · `maxCommandArgs` 50 |

## Rules that bite

- **The security boundary is the input charset, checked BEFORE any engine call.** `CONTAINER_NAME_RE`
  `/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/` (a strict subset of Docker's own rule, so a name can never
  look like a flag), plus `IMAGE_REF_RE`, `NETWORK_NAME_RE`, `ENV_KEY_RE`, `CONTAINER_PATH_RE`. `..`
  is rejected on the RAW input — `path.resolve` normalizes it away, and a caller who writes `..` is a
  caller to refuse. Widening any of these widens what reaches the engine.
- **Every command is an ARGV ARRAY, never a shell string** — nothing is re-parsed, so quoting is moot;
  the regexes are the belt to that brace, not a substitute for it.
- **Bind mounts are OFF by default and CONTAINED when on.** `volumeRoots` starts empty ⇒ every `-v` is
  refused `UNSAFE_PATH`, because a mount reaches out of the sandbox into the host filesystem and a
  container process is frequently root — it equals handing out that path with write access. With
  roots set, each source must resolve under one: decided in TS (case-insensitive on Windows), never
  by the engine.
- **Env VALUES are never returned by a read.** `ContainerInfo.envKeys` carries names only: container
  env routinely holds credentials. Values go in, they do not come back out.
- **Managed-label gate:** containers lm-assist creates carry `lm-assist=managed`; `delete`, `stop` and
  `restart` refuse one without it (`CONTAINER_NOT_MANAGED`) unless `force:true`. `start` is
  deliberately ungated — starting a stopped container is not destructive. Stop/restart ARE gated (VM
  power was not) because this fleet runs real services in containers and a container name is far
  easier to typo into. `force:true` also turns stop into `docker kill` and delete into `rm -f`.
- **Privilege is PROVEN, never inferred.** The probe runs `docker version --format '{{json .}}'` and
  requires a **`Server` block**. Group membership lies in both directions (fresh `docker` membership
  needs a new login session before the socket answers this process) and so does the client version —
  on 107 the CLI is installed and `docker version` exits 1 because Docker Desktop is not running.
  That case reports `privilege:"unavailable"` WITH `clientVersion`, keeping "CLI present, daemon down"
  distinguishable from "docker not installed". `sudo -n` is tried only on POSIX and only when not
  already root; the prefix is cached per process, and `status()` re-probes so a just-started daemon
  shows up at once.
- **Bounded reads** — a capped result always reports `total` + `truncated`, never a bare array. List
  cap 100 (`total` is the REAL count); images cap 100; logs `lines` default 100 / max 1000 plus a hard
  `MAX_LOG_BYTES` 100,000, keeping the **tail** (the end of a log explains the failure), `truncated`
  for either cap, `bytes` = pre-truncation size. `since` takes only `10m`/`2h` or an RFC3339 stamp.

## Gotchas

- **`workdir`, `autoRemove` and `pull` exist on `POST /container/run` but NOT in the MCP schema** —
  deliberate, to hold the tool family inside the catalogue byte budget. Use the route for those three;
  everything else the schema advertises (including `volumes`) is forwarded.
- MCP snake_case → route camelCase: `memory_mb`→`memoryMB`, `timeout_sec`→`timeoutSec`,
  `remove_image`→`removeImage`. A misspelled MCP key is silently absent, not an error.
  Writes serialize behind a 30 s mutex → `BUSY`; reads stay lock-free.
- Timeouts sit under `workerPostRaw`'s 120 s loopback ceiling (run 110 s incl. pull, start 60 s,
  stop/restart ≤110 s, delete 60 s). A hub-relayed connector call is cut at ~25–30 s — a slow first
  pull still completes server-side; follow with `container_status`, do not retry.
- A string `command` is split on whitespace into argv — no shell, so `sh -c "a && b"` must be an
  array. Notes are a label value: newlines, commas and `'"`$` stripped (500 chars), because `docker
  ps` joins labels with commas — which is also why `managed` in `list()` comes from a label-FILTERED
  id query, not from parsing that string.
- Registration is FOUR places — `tools/container.ts`, `expanded.ts`, `TOOL_SCOPES` in `configure.ts`
  (missing scope CRASHES Core on `tools/list`), `registry/catalog.ts`. Catalogue budget raised
  295,000 → 300,000 B (285 tools = 296,090 B, ~3,910 B headroom; the family costs 5,045 B, 1,235 B
  of it the injected node paragraph).
- **Verified 2026-08-12, both paths.** Full lifecycle through the MCP tools on node **117** (Ubuntu,
  Docker Engine 27.5.1, privilege `direct`): 16/16 steps — run → status → logs → managed-gate refusals
  → stop/start/restart → delete (+ `remove_image`) → absence, with the node's production containers
  (`langmart-postgres`, `npm`) asserted still running before and after. Graceful-degradation path on
  **107** (Windows, CLI 29.1.2 present, Docker Desktop down): 5/5 — `available:false` with a fixing
  `reason`, `clientVersion` set but `version` null, writes refused `DOCKER_UNAVAILABLE`, and validation
  still refusing bad input before the daemon is ever probed. Unit tests:
  `core/src/__tests__/container-service-validation.test.ts` (20 pure validation/containment tests).
  E2e recipe: sandboxed Core (`LM_ASSIST_DATA_DIR` scratch dir + `--port 3211`), MCP StreamableHTTP on
  `/mcp` with `x-api-key` from the sandbox `api-token`, provenance footer stripped before `JSON.parse`.
