# Memory read path — project ids and typed refusals

> Read before changing `memory_file`, `search_memory`, or project-id resolution.
>
> Split out of the repo [CLAUDE.md](../CLAUDE.md) so it is read on demand instead of loaded into every session. Content is unchanged.

### Memory read path — `project_id` takes the project NAME, and refusals are typed

The same bug class on a READ path (2026-07-26, `bl_4140a6fc`). `memory_file` was
reported as "intermittently fails with a bare *MCP tool call failed*", suspected to be a
payload-size or relay-timeout cutoff on the larger full-file body. It was neither:
`mcp-calls.jsonl` showed every failure as `durationMs 1-10` with a 35-byte body —
`Project not found: lm-assist`. A ~20KB MEMORY.md returns fine and a 200KB body
round-trips in ms. **`resolveProjectIdToCwd` took only the encoded slug
(`-home-ubuntu-lm-assist`); the caller sent the NAME.** A name has no leading dash, so
it is not legacy-slug shaped → base64 → garbage → null.

- 🔴 **"Intermittent" was DETERMINISTIC PER INPUT** — it varied only because the caller
  sometimes used the slug and sometimes the name. Sort failures by ARGUMENT, not by time,
  before theorising about load or size.
- 🔴 **`search_memory` never failed because its `project` arg is an optional ABSOLUTE
  PATH defaulting to a sweep of every project** — it never asks the caller to name a slug,
  so there is no id to get wrong. That asymmetry pointed at id resolution, not transport;
  the same fact was first read as evidence for a size cutoff.
- **Resolution order:** strict (slug / decodable path) runs FIRST and is unchanged; only
  on failure does it match the project NAME or an absolute path against the **enumerated**
  project set — so a name can never become path traversal. **Ambiguity is REFUSED, never
  guessed** (`PROJECT_AMBIGUOUS` lists the ids). Cost on an 80-project host: fast path
  ~7-10ms, fallback ~21ms, and the fallback only runs where the call previously failed.
- **Typed errors** (`core/src/api/memory-api.ts` + `mcp-server/tools/expanded.ts`):
  `PROJECT_NOT_FOUND` echoes what was sent AND names candidates (`lm-assistt` → *"Did you
  mean: lm-assist"*), distinct from `FILE_NOT_FOUND`/`SOURCE_NOT_FOUND`; transport
  failures split `[READ_TIMEOUT]` (retry safe — a read is idempotent) vs
  `[CORE_UNREACHABLE]` (NOTHING was read), mirroring ORIGIN_TIMEOUT/ORIGIN_UNREACHABLE.
- 🔴 **A dropped `error.code` manufactures phantom transport bugs.** `workerGet`'s
  `unwrapEnvelope` keeps only `error.message` — which is exactly how a 0ms bad-id refusal
  reached the caller as "MCP tool call failed". Reads that classify their own failures use
  **`workerGetRaw`**. The 15s timeout was deliberately NOT raised: measurement showed
  orders of magnitude of headroom, and raising it only delays a wedged Core's answer.
