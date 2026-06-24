# Mission Provenance + Repo/Branch Pickers (Wave 1) — Design

**Goal:** Make a Mission record *who-touched-it*: capture a globally-addressable reference to the conversation/session that created it and every actor that updated it (full attributed trail). Plus: in the Mission create/edit UI, pick repository and branch from dropdowns (reusing the existing CCR repo/branch endpoints).

**Out of scope (Wave 2):** "controller runs as a session" + default-open-the-controller-session UI. This spec keeps the controller a fleet-elected scheduled job and only attributes its updates.

**Architecture:** A new `MissionActor` reference type stamped at create/update. Resolution happens **in Core** (where the session caches + resolver live). The mission stays the lean consolidated record — actors are pointers (kind+id+node), not copies. The reference is globally addressable so a fleet-synced mission assembled across nodes / remote MCP conversations resolves anywhere.

**Tech stack:** TypeScript (core, CJS), Next.js/React (web). Mission store = data service. Existing session-resolver (`mcp-session-resolver.ts`) + MCP context (`principal-context.ts`).

## Global Constraints

- Core build is CommonJS — no new ESM static imports; SDK/chokidar caveats unchanged.
- Mission routes use the bare `{success,data}`/`{success,error}` envelope (NOT `wrapResponse`), matching the existing `mission.routes.ts`.
- Resolution must be **best-effort and non-fatal**: if the caller can't be resolved, fall back to a coarse actor; never throw out of create/update.
- Back-compat: existing persisted missions have no `createdBy`/`lastUpdatedBy` and adjustments have no `actor`. Reads must tolerate this (backfill, never crash).
- MCP number/bool tool args may arrive as strings (coerce) — unchanged from existing handlers.

---

## Data model (`core/src/mission/mission-model.ts`)

```ts
export type ActorKind = 'local-session' | 'ccr' | 'claudeai-conversation' | 'controller' | 'user';
export type ActorChannel = 'mcp' | 'controller' | 'user' | 'api';

export interface MissionActor {
  kind: ActorKind;
  id?: string | null;        // session UUID | cse_/session_ | conversation uuid | null (user/controller-job)
  node?: string | null;      // REQUIRED for 'local-session' (node-qualifies the local id); set for controller/user; null for global ccr/claudeai
  channel: ActorChannel;     // how it reached the mission
  label?: string;            // snapshot for display ("Claude Code @gw4-123: lm-assist", "claude.ai: planning", "CCR: worker")
  toolUseId?: string | null; // raw caller tag (audit)
  at: number;
}
```

`Mission` gains:
```ts
  createdBy: MissionActor;
  lastUpdatedBy: MissionActor;
```
`MissionAdjustment` gains `actor: MissionActor` (keep existing `by: 'controller'|'user'` for back-compat).

- `newMission(input, now, genId)` takes an added `createdBy: MissionActor`; sets `createdBy` and `lastUpdatedBy = createdBy`.
- New helper `coarseActor(channel: ActorChannel, node: string): MissionActor` → `{kind: channel==='controller'?'controller':'user', channel, node, at: now}` for non-resolvable callers.
- New helper `backfillActor(m)` semantics live on read (store layer), not in the pure model.

## Resolution (`core/src/mission/mission-actor.ts` — NEW, Core-only IO seam)

`resolveMcpActor(toolUseId: string | undefined, node: string, now: number): Promise<MissionActor>`:
- If `toolUseId`: run `resolveCallerCandidates()` inside `runWithMcpContext({principal:{type:'local'}, toolUseId}, …)` (so the resolver sees the id).
  - `precise && claudeCode` → `{kind:'local-session', id:claudeCode.id, node, channel:'mcp', label:claudeCode.label, toolUseId, at}`.
  - else `claudeAi` → `{kind:'claudeai-conversation', id:claudeAi.id, channel:'mcp', label:claudeAi.label, toolUseId, at}`.
  - else `claudeCode` (recency) → `{kind:'local-session', id, node, channel:'mcp', label, toolUseId, at}`.
- No toolUseId / nothing resolved → `{kind:'user', channel:'mcp', node, toolUseId, at}`.
- Wrapped in try/catch → on any failure returns the coarse `{kind:'user', channel:'mcp', node, toolUseId, at}`. Never throws.

(The `ccr` kind is produced by the controller path when it knows a binding's `ccr.sid`; not by `resolveMcpActor`.)

## Capture flow

**MCP tools (`core/src/mcp-server/tools/mission.ts`):** before `workerPost`, attach the caller hint:
```ts
const tu = currentMcpContext()?.toolUseId;
const body = { ...a, _actor: { channel: 'mcp', toolUseId: tu ?? null } };
```
for `mission_create` and `mission_update`. (`currentMcpContext` import added.)

**Routes (`core/src/routes/core/mission.routes.ts`):** `handleCreate`/`handlePatch` resolve the actor:
- Read `b._actor` hint. If `_actor.channel==='mcp'` → `await resolveMcpActor(_actor.toolUseId, thisNode(), Date.now())`.
- Else → `coarseActor('user', thisNode())` (direct REST/UI edit).
- `handleCreate`: pass actor into `newMission`.
- `handlePatch`: set `m.lastUpdatedBy = actor`; push the adjustment with `{...existing fields, actor}`.
- Strip `_actor` from the body before field application so it can't be mistaken for a mission field.
- The actor param is injectable for tests (`handleCreate(b, ownerNode, port?, actor?)`, `handlePatch(id, b, port?, actor?)`); when omitted the handler resolves from `b._actor`.

**Controller (`core/src/mission/mission-controller.ts`):** where it records an adjustment (the adjust-apply path), stamp `actor`:
- `{kind:'controller', channel:'controller', node:<elected/self node>, id:<binding.ccr?.sid ?? binding.sessionId ?? null>, at}` and set `m.lastUpdatedBy` to it.
- When the actor references the executor it's driving and a `ccr` binding exists, `kind:'ccr', id:ccr.sid`.

## Back-compat (`core/src/mission/mission-store.ts`)

On read (`getMission`/`listMissions` mapping), if a record lacks `createdBy`: synthesize `{kind:'user', channel:'api', node:m.ownerNode, at:m.createdAt}` for both `createdBy` and `lastUpdatedBy`. For each adjustment lacking `actor`, synthesize from `by`: `{kind:by==='controller'?'controller':'user', channel:by==='controller'?'controller':'user', node:m.ownerNode, at:adj.at}`. Pure helper `withActorBackfill(m)`; applied in the store's read path.

## Web UI

**Provenance display (`web/src/components/missions/MissionsPage.tsx`):** per mission, show "Created by `<label>`" and a collapsible **contributor trail** = `adjustments[]` rendered as `at · channel · label — change`, each row a link to that actor when resolvable:
- `local-session` → existing session view (cross-node aware via node).
- `ccr` → the CCR/cloud view (reuses `CcrCloudView`).
- `claudeai-conversation` → `https://claude.ai/chat/<id>` (new tab).
- `controller`/`user` → plain text (node).

**Repo/branch pickers (same file, create/edit form):** replace the `env.repo` / `env.branch` text inputs with dropdowns:
- Repo `<select>` populated from `GET /ccr/cloud/repos` (`{repos:[…]}`) via the existing api client; on change → `GET /ccr/cloud/branches?repo=<repo>` → branch `<select>`.
- Each keeps a "— custom —" option that reveals the original free-text input (repos not in the list / manual entry).
- Loading + error states; empty repo list → fall back to text inputs.

## Tests (`core/src/__tests__/`)

- `mission-actor.test.ts` — `resolveMcpActor`: precise CC → local-session(+node); claudeAi recency → claudeai-conversation; nothing → coarse user; never throws (stub resolver). `coarseActor` shape.
- `mission-model.test.ts` (extend) — `newMission` sets `createdBy`+`lastUpdatedBy`; adjustment carries `actor`.
- `mission-store` round-trip (stub DataService) — `withActorBackfill` synthesizes createdBy + adjustment actors for legacy records; preserves present ones.
- `mission.routes` — create stamps actor from `_actor` mcp hint (mocked `resolveMcpActor`); patch sets `lastUpdatedBy` + appends adjustment actor; direct (no `_actor`) → user; `_actor` never leaks into mission fields.
- Controller — adjust-apply path stamps a `controller` actor (and `ccr` when a ccr binding exists).

## Verification (e2e, on deploy)

- REST: `POST /mission` with `_actor` → `createdBy` populated; `PATCH` → `lastUpdatedBy` + adjustment actor; legacy mission (hand-written, no provenance) reads without error (backfilled).
- MCP: `mission_create` via `/mcp` → mission's `createdBy.toolUseId` matches the call; `mission_update` appends an attributed adjustment.
- Web: `/missions` renders Created-by + trail; repo dropdown lists repos, selecting one loads branches.
