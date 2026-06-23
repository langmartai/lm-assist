# Convergent cross-node memory sync (default-on, git-remote peers, auto-merge) + Memory settings UI

Status: DESIGN (2026-06-23, approved in brainstorming).

## Goal

Make cross-node memory sync **on by default**, surface it in a **Memory settings tab**, and extend it
from cloud→home to **any two nodes that share a project** (matched by git remote) so their curated
project memory **converges** — divergent edits of the same file **auto-merge** (deterministic 3-way,
LLM only on a real conflict) instead of being kept as separate per-host mirrors or lost to
last-writer-wins.

## Background (what exists after 0.1.74)

- `core/src/memory/autosync.ts` — `MemoryAutoSyncDaemon`: detect (memory-map delta) → filter/guard →
  (mode `on`) push-back to a `homeNode` via `pushToHome` + hub-notify; `onRemoteUpdate` refreshes.
  Mode from `resolveMode()` (env `MEMORY_AUTOSYNC`, default `observe`). `planPushBack(cfg, changed)`:
  ephemeral+homeNode → push; **persistent → none** (the gap this spec closes).
- `core/src/memory/mcp-transport.ts` — `pullFromHome`/`pushToHome` relayed over the hub (key-in-body).
- `core/src/routes/core/memory-sync.routes.ts` — `POST /memory/export|ingest|sync/enable|pull`,
  `GET /memory/sync/status`; ingest writes peer records under `<cwd>/memory/<host>/` (the mirror).
- `core/src/memory/node-mode.ts` — `~/.lm-assist/memory-sync.json {nodeMode, homeNode, project, homeProject}`.
- `core/src/project-settings.ts` — `ProjectSettings` (+`crossProjectSignpostEnabled`); `GET/PUT /project-settings`.
- Divergence detection ALREADY exists: `memory_import_candidates` (peer record newer-than/absent-locally),
  `getDiff` (live vs mirror liveOnly/repoOnly/differing), plan-only `memory-reconcile`.
- LLM agents available: `core/src/sdk-runner.ts` (`/agent/execute`), the harvest pipeline.
- Web Settings: `web/src/app/(dashboard)/settings/page.tsx` (tabbed).

## Design

### Increment 1 — default-on + Memory settings tab (small, ships first)

1. **`memorySyncEnabled: boolean`** in `ProjectSettings`, default **true**. `resolveMode()` becomes:
   explicit `MEMORY_AUTOSYNC` env wins (`off`/`observe`/`on`); else `memorySyncEnabled ? 'on' : 'off'`.
   Safe on unconfigured persistent nodes today (no peers ⇒ `planPushBack` still "none" ⇒ no transport;
   `on` only adds the local memory-map `--commit` delta-log append).
2. **`PUT /project-settings`** passes through `memorySyncEnabled` + `crossProjectSignpostEnabled`, and
   applies live (toggle the signpost sweep / set the daemon mode) like the `knowledgeEnabled` toggle does.
3. **Memory settings tab** (web): toggles for cross-project signpost + memory sync; a read-only status
   block from `GET /memory/sync/status` (node mode, peers, daemon mode + counts).

### Increment 2 — git-remote peers + convergent auto-merge (the big one)

**2.1 Cross-node project identity = git remote.**
- `projectRemoteKey(cwd)`: normalized `git -C <cwd> remote get-url origin` →
  `host/owner/repo` (strip scheme, `git@`→`/`, `.git`, trailing `/`, lowercase host). Null if no remote.
- `GET /memory/projects-by-remote?key=<k>` → this node's local project slug(s) whose cwd has remote `k`
  (so a peer can address this node's copy by slug). Built from the projects list + a cwd→remote scan,
  cached.

**2.2 Peer discovery.**
- For each git-backed local project, the daemon resolves peers = fleet nodes (`list_nodes` via the hub
  peer client) whose `/memory/projects-by-remote?key=<myRemote>` returns a slug. Result: a peer set
  `[{node, slug}]` per project, cached (refreshed on the project-set watcher + periodically).
- `planPushBack` generalizes: a node (persistent OR ephemeral) pushes its project-domain changes to
  **every** peer for that project. cloud→home is the special case (peer = home).

**2.3 Convergent transport.**
- On local change (`on`): for each peer, `pushToHome(peer.node, peer.slug, thisHost, records, key)`
  → the peer ingests (§2.4) → notify. On bootstrap/notify/periodic: pull each peer's export → merge.
- The project's **live** memory is the convergence point (not a read-only mirror): merged files land in
  the live dir so Claude Code + the tools see the converged set. (Per-host mirror dirs remain only as the
  staging the receiver merges FROM.)

**2.4 Auto-merge (hybrid, base-aware).**
- **Base store:** per project, the last-converged content of each file is kept in
  `<cwd>/memory/.sync-base/<file>` (+ a hash index). The base = the common ancestor for 3-way.
- **On an incoming peer file** `f`:
  - identical to local → no-op (dedup by hash).
  - local unchanged since base → fast-forward to peer (no merge).
  - peer unchanged since base → keep local.
  - both changed since base → **deterministic 3-way merge** (`diff3(base, local, peer)`):
    - clean (non-overlapping hunks) → write merged → update base → propagate.
    - conflict (overlapping hunks) → **LLM merge**: spawn an agent (sdk-runner) with base/local/peer +
      "merge into one coherent memory file, lose no information, resolve contradictions, keep frontmatter
      valid" → validate frontmatter → write merged → update base → propagate. On LLM failure → leave
      local, record a `memory-reconcile` plan item (no data loss, human/agent resolves).
  - no base (first contact) → if differing, treat as both-changed (LLM merge); else fast-forward.
- **Excluded from sync/merge:** `persistence: temporary`, host-local (shareability), credential-pattern
  filenames, `_cross-project.md`, `_hosts.md` — same guards as today.
- **Convergence:** every same-remote peer's live memory eventually equals the merged set (commutative via
  the shared base + hash dedup; re-merging an already-merged file is a no-op).

**2.5 Daemon + bootstrap wiring.** The daemon's `on`-mode path uses the peer set + merge-ingest. Cloud
bootstrap keeps `/memory/sync/enable` (now: also auto-resolves peers by remote). The Memory tab shows the
resolved peers per project + last merge/conflict counts.

## Files (create / modify)

Increment 1: `core/src/project-settings.ts`, `core/src/memory/autosync.ts` (resolveMode),
`core/src/routes/core/project-settings.routes.ts` (passthrough + live apply), web settings tab
(`web/src/app/(dashboard)/settings/...`).

Increment 2: `core/src/memory/project-remote.ts` (projectRemoteKey + by-remote lookup),
`core/src/memory/peer-resolve.ts` (peer set from list_nodes + by-remote), `core/src/memory/merge3.ts`
(deterministic 3-way + base store), `core/src/memory/llm-merge.ts` (agent conflict resolver),
`core/src/memory/ingest.ts` (merge-on-ingest), `core/src/routes/core/memory-sync.routes.ts`
(`/memory/projects-by-remote`, merge ingest), `core/src/memory/autosync.ts` (peer push/pull + planPushBack
generalization), `core/src/memory/mcp-transport.ts` (peer addressing). Tests throughout.

## Testing

- Unit: `resolveMode` honors setting+env; `projectRemoteKey` normalization; peer-resolve matching;
  `merge3` clean/conflict/no-base/fast-forward; LLM-merge prompt + frontmatter validation (mock agent);
  ingest convergence + dedup idempotency; exclusions.
- Integration: 3-node convergence — A and B diverge a file, sync → both converge to the merged content;
  non-overlapping edits merge with no LLM; overlapping triggers the (mocked) LLM path; temporary/host-local
  never sync; a third sweep is a no-op (idempotent/convergent).

## Decisions (brainstorming)

- Default-on via a `memorySyncEnabled` setting (env overrides).
- Cross-node project identity = **git remote** (auto peer discovery; slug-independent).
- Conflict = **auto-merge** (converge), **hybrid**: deterministic 3-way, LLM only on overlapping conflict;
  never silent LWW. LLM failure degrades to a reconcile-plan item (no loss).
- Convergence target = the **live** memory set (sync writes live, base-aware so non-conflicting edits are
  safe).

## Out of scope (YAGNI)

- A central hub memory store (peer-to-peer mesh).
- CRDT character-level merge (file-level 3-way + LLM suffices).
- Real-time streaming (notify + debounced pull).
