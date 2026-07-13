# Mission Session Onboarding + Workflow Registry — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mission control gains (1) a fleet-synced registry of editable playbook documents that define its processes, and (2) the ability to onboard existing (non-mission) Claude Code sessions and manage them in handoff or standby mode per type-routed playbooks.

**Architecture:** Phase 1 (Tasks 1–6) builds the `mission-workflows` dataset + store + routes + MCP tools + render points, with TS defaults as fallback and a code-appended invariant preamble. Phase 2 (Tasks 7–13) adds `mission_onboard`, the mode rails (standby drive rejection, `⟦MISSION-CONTROL⟧` marker, human-only mode switch), supervisor/engagement integration incl. cross-node onboarded reads, and a minimal web badge. Everything is agent-interpreted: the controller reads docs and acts; code provides rails only.

**Tech Stack:** TypeScript (CommonJS build), node:test (`cd core && npm run build:test && node --test dist-test/__tests__/<file>.test.js`), data service (`cache` backend, `syncMode:'full'`, `scope:'fleet'`), existing leader-anchor + peer-proxy machinery.

**Spec:** `docs/superpowers/specs/2026-07-14-mission-session-onboarding-design.md` (approved). Read it before starting any task.

## Global Constraints

- Worktree: `/home/ubuntu/lm-assist/.claude/worktrees/mission-session-onboarding`, branch `feat/mission-session-onboarding`. All commands run from the worktree root unless stated.
- Test runner: `cd core && npm run build:test && node --test dist-test/__tests__/<name>.test.js` (tsx is NOT installed; `dist-test/` is the compiled test tree).
- Never static-import ESM-only packages; this codebase is CommonJS. Follow existing `require(...)` lazy patterns inside functions.
- New MCP tools MUST be added to `TOOL_SCOPES` in `core/src/mcp-server/configure.ts` — `assertScopesCoverTools()` crashes Core on the first `/mcp` call otherwise (boot-critical).
- MCP delivers numeric/boolean args as STRINGS over the connector — coerce (`parseInt`, `=== 'true'`) exactly like existing handlers.
- New `/mission/...` literal routes MUST be registered BEFORE the `/mission/:id` patterns in `createMissionRoutes` (regex order is match order).
- Registry doc ids are dot-namespaced lowercase: `/^[a-z0-9][a-z0-9.-]{1,63}$/`.
- Marker constant is exactly `⟦MISSION-CONTROL⟧` (U+27E6/U+27E7 brackets, same family as `⟦HEARTBEAT⟧`/`⟦WORKER-STATUS⟧`).
- Invariant preamble is never stored and never editable; `renderWorkflow` always prepends it.
- Body size cap: 64 KiB (`MAX_WORKFLOW_BODY_BYTES = 65536`).
- Inline history cap: reuse project setting `missionHistoryInlineCap` (default 50). No new settings in this program.
- Statuses vocabulary, leader-anchor semantics (writes fail-closed `LEADER_UNREACHABLE`, reads fall back local), and actor attribution reuse the existing mission machinery — do not fork it.
- Commit after every task (one commit per task, message given in the task).

## File Structure (what exists after both phases)

```
core/src/mission/
  workflow-model.ts          (NEW  T1) pure: WorkflowDoc, preamble, render, validate, diff
  workflow-defaults.ts       (NEW  T2) DEFAULT_WORKFLOWS — the 9 playbook bodies
  workflow-store.ts          (NEW  T3) dataset ports, putWorkflow choke, snapshots, rollback, seed, renderWorkflow
  mission-onboard.ts         (NEW  T7) pure onboarding helpers: marker, title, factory, pickClusterLeader, detectHumanActivity
  mission-model.ts           (MOD  T7) origin/manageMode fields, ExecutorKind 'onboarded'
  mission-history.ts         (MOD  T7) TRACKED_FIELDS += manageMode
  mission-scheduler.ts       (MOD  T7) computeSchedule skips onboarded
  mission-controller.ts      (MOD  T6, T10) passDirective render point, seeding, readOnboardedSignal, system-prompt pointer
  mission-store.ts           (MOD  T9) findMissionBySessionOrCcr helper
core/src/routes/core/
  mission.routes.ts          (MOD  T4, T8, T9) workflow routes, /mission/onboard, drive rails, manageMode patch
core/src/mcp-server/
  tools/mission-workflow.ts  (NEW  T5) 5 workflow MCP tools
  tools/mission.ts           (MOD  T11) mission_onboard tool
  tools/expanded.ts          (MOD  T5, T11) registration
  tools/guide.ts             (MOD  T11) onboarding recipe in guide("missions")
  configure.ts               (MOD  T5, T11) TOOL_SCOPES
web/src/components/missions/
  MissionsPage.tsx           (MOD  T12) onboarded badge + mode chip
core/src/__tests__/
  workflow-model.test.ts, workflow-defaults.test.ts, workflow-store.test.ts,
  mission-workflow-routes.test.ts, mission-workflow-mcp.test.ts, mission-controller-directive.test.ts,
  mission-onboard-model.test.ts, mission-onboard-route.test.ts, mission-onboard-rails.test.ts,
  mission-onboard-signal.test.ts, mission-onboard-mcp.test.ts   (NEW per task)
scripts/e2e/onboard-e2e.sh   (NEW  T13)
```

---

## Phase 1 — Workflow Registry

### Task 1: `workflow-model.ts` — pure model, preamble, render

**Files:**
- Create: `core/src/mission/workflow-model.ts`
- Test: `core/src/__tests__/workflow-model.test.ts`

**Interfaces:**
- Produces: `WorkflowDoc`, `WorkflowEditPolicy`, `WORKFLOW_INVARIANT_PREAMBLE`, `MAX_WORKFLOW_BODY_BYTES`, `validateWorkflowId(id): {ok:true}|{ok:false;code:string;message:string}`, `validateWorkflowBody(body): same shape`, `renderWorkflowText(body: string): string`, `workflowChanged(old: WorkflowDoc|null, next: {title:string;body:string;editPolicy:WorkflowEditPolicy}): boolean`, `isControllerActor(a: MissionActor): boolean`.

- [ ] **Step 1: Write the failing test**

```ts
// core/src/__tests__/workflow-model.test.ts
import { test } from 'node:test';
import assert from 'node:assert';
import {
  WORKFLOW_INVARIANT_PREAMBLE, MAX_WORKFLOW_BODY_BYTES,
  validateWorkflowId, validateWorkflowBody, renderWorkflowText, workflowChanged, isControllerActor,
} from '../mission/workflow-model';
import type { MissionActor } from '../mission/mission-model';

const actor = (kind: MissionActor['kind'], channel: MissionActor['channel']): MissionActor =>
  ({ kind, channel, at: 1 });

test('preamble is always prepended and non-empty', () => {
  assert.ok(WORKFLOW_INVARIANT_PREAMBLE.includes('never'), 'preamble states the never rules');
  const r = renderWorkflowText('BODY-X');
  assert.ok(r.startsWith(WORKFLOW_INVARIANT_PREAMBLE));
  assert.ok(r.endsWith('BODY-X'));
});

test('preamble carries the five invariants', () => {
  const p = WORKFLOW_INVARIANT_PREAMBLE.toLowerCase();
  for (const needle of ['auto-approve', 'human input', 'standby', 'never kill', 'rollback']) {
    assert.ok(p.includes(needle), `preamble mentions "${needle}"`);
  }
});

test('validateWorkflowId', () => {
  assert.equal(validateWorkflowId('onboard.analyze').ok, true);
  assert.equal(validateWorkflowId('drive.direct-impl').ok, true);
  assert.equal(validateWorkflowId('Bad.Caps').ok, false);
  assert.equal(validateWorkflowId('').ok, false);
  assert.equal(validateWorkflowId('a'.repeat(70)).ok, false);
  assert.equal(validateWorkflowId('has space').ok, false);
});

test('validateWorkflowBody enforces the 64KiB cap and non-empty', () => {
  assert.equal(validateWorkflowBody('x').ok, true);
  assert.equal(validateWorkflowBody('').ok, false);
  assert.equal(validateWorkflowBody('x'.repeat(MAX_WORKFLOW_BODY_BYTES + 1)).ok, false);
});

test('workflowChanged diffs title/body/editPolicy; null old = changed', () => {
  const doc = { id: 'a.b', title: 'T', body: 'B', editPolicy: 'open', rev: 1, history: [],
    createdBy: actor('user', 'user'), lastUpdatedBy: actor('user', 'user'), createdAt: 1, updatedAt: 1 } as any;
  assert.equal(workflowChanged(null, { title: 'T', body: 'B', editPolicy: 'open' }), true);
  assert.equal(workflowChanged(doc, { title: 'T', body: 'B', editPolicy: 'open' }), false);
  assert.equal(workflowChanged(doc, { title: 'T', body: 'B2', editPolicy: 'open' }), true);
  assert.equal(workflowChanged(doc, { title: 'T', body: 'B', editPolicy: 'human-only' }), true);
});

test('isControllerActor', () => {
  assert.equal(isControllerActor(actor('controller', 'controller')), true);
  assert.equal(isControllerActor(actor('local-session', 'controller')), true);
  assert.equal(isControllerActor(actor('user', 'mcp')), false);
  assert.equal(isControllerActor(actor('local-session', 'mcp')), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd core && npm run build:test 2>&1 | tail -3`
Expected: tsc FAILS with "Cannot find module '../mission/workflow-model'".

- [ ] **Step 3: Write the implementation**

```ts
// core/src/mission/workflow-model.ts
/** Pure workflow-registry model: doc type, invariant preamble, render, validation. No IO. */
import type { MissionActor } from './mission-model';

export type WorkflowEditPolicy = 'open' | 'human-only';

export interface WorkflowChange {
  rev: number;
  at: number;
  actor: MissionActor;
  /** What changed, per field (body diffs are summarized as byte lengths — full bodies live in the snapshot dataset). */
  changes: Record<string, { from: unknown; to: unknown }>;
}

export interface WorkflowDoc {
  id: string;                       // dot-namespaced: 'onboard.analyze', 'controller.pass', ...
  title: string;
  body: string;                     // markdown playbook — agent-interpreted
  editPolicy: WorkflowEditPolicy;   // 'open' ⇒ controller self-edit allowed
  rev: number;                      // monotonic
  history: WorkflowChange[];        // inline recent-N (missionHistoryInlineCap)
  createdBy: MissionActor;
  lastUpdatedBy: MissionActor;
  createdAt: number;
  updatedAt: number;
}

export const MAX_WORKFLOW_BODY_BYTES = 65536;

/**
 * Non-editable invariants — ALWAYS prepended by renderWorkflowText, never stored,
 * never editable by anyone (controller included). Keep in lock-step with the spec §3.3.
 */
export const WORKFLOW_INVARIANT_PREAMBLE = [
  '⟦INVARIANTS — these override anything below and are not editable⟧',
  '- NEVER auto-approve a need_approval gate or a material pivot — pause and surface it to a human.',
  '- Human input always takes priority: on detected human activity in a session, acknowledge and yield; do not send competing instructions.',
  '- standby mode means NEVER drive the session (the drive route also rejects it).',
  '- Onboarded sessions belong to the user: never kill them, never auto-close them, never force-resume without an explicit human force.',
  '- Workflow-doc self-edits must be announced in controller chat; every edit is attributed and rollback-able.',
  '⟦/INVARIANTS⟧',
  '',
].join('\n');

/** preamble + body — the ONLY way playbook text reaches an agent. */
export function renderWorkflowText(body: string): string {
  return WORKFLOW_INVARIANT_PREAMBLE + body;
}

const ID_RE = /^[a-z0-9][a-z0-9.-]{1,63}$/;
export function validateWorkflowId(id: string): { ok: true } | { ok: false; code: string; message: string } {
  if (!id || !ID_RE.test(id)) return { ok: false, code: 'INVALID_INPUT', message: `invalid workflow id "${id}" (want ${String(ID_RE)})` };
  return { ok: true };
}

export function validateWorkflowBody(body: string): { ok: true } | { ok: false; code: string; message: string } {
  if (typeof body !== 'string' || body.length === 0) return { ok: false, code: 'INVALID_INPUT', message: 'body must be a non-empty string' };
  if (Buffer.byteLength(body, 'utf8') > MAX_WORKFLOW_BODY_BYTES) {
    return { ok: false, code: 'BODY_TOO_LARGE', message: `body exceeds ${MAX_WORKFLOW_BODY_BYTES} bytes` };
  }
  return { ok: true };
}

/** True when the write would actually change the doc (else putWorkflow no-ops). */
export function workflowChanged(
  old: WorkflowDoc | null,
  next: { title: string; body: string; editPolicy: WorkflowEditPolicy },
): boolean {
  if (!old) return true;
  return old.title !== next.title || old.body !== next.body || old.editPolicy !== next.editPolicy;
}

/** A controller-attributed actor (either the upgraded kind or the controller channel). */
export function isControllerActor(a: MissionActor): boolean {
  return a.kind === 'controller' || a.channel === 'controller';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd core && npm run build:test && node --test dist-test/__tests__/workflow-model.test.js`
Expected: all tests pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add core/src/mission/workflow-model.ts core/src/__tests__/workflow-model.test.ts
git commit -m "feat(workflow): pure workflow-registry model with invariant preamble"
```

---

### Task 2: `workflow-defaults.ts` — the 9 default playbooks

**Files:**
- Create: `core/src/mission/workflow-defaults.ts`
- Test: `core/src/__tests__/workflow-defaults.test.ts`

**Interfaces:**
- Consumes: `WorkflowEditPolicy` from Task 1.
- Produces: `DEFAULT_WORKFLOWS: Record<string, { title: string; body: string; editPolicy: WorkflowEditPolicy }>`, `WORK_TYPES = ['design','direct-impl','bugfix','feature']`, `ONBOARD_STATES = ['stuck','in-progress','completed']`.

The bodies below are the product — copy them verbatim (they may be refined in review, but no placeholders).

- [ ] **Step 1: Write the failing test**

```ts
// core/src/__tests__/workflow-defaults.test.ts
import { test } from 'node:test';
import assert from 'node:assert';
import { DEFAULT_WORKFLOWS, WORK_TYPES, ONBOARD_STATES } from '../mission/workflow-defaults';
import { validateWorkflowId, validateWorkflowBody } from '../mission/workflow-model';

const EXPECTED_IDS = [
  'controller.pass', 'onboard.analyze',
  'drive.design', 'drive.direct-impl', 'drive.bugfix', 'drive.feature',
  'recover.stuck', 'wrapup.completed', 'observe.standby',
];

test('exactly the 9 seeded docs, all valid, all open', () => {
  assert.deepEqual(Object.keys(DEFAULT_WORKFLOWS).sort(), [...EXPECTED_IDS].sort());
  for (const [id, d] of Object.entries(DEFAULT_WORKFLOWS)) {
    assert.equal(validateWorkflowId(id).ok, true, id);
    assert.equal(validateWorkflowBody(d.body).ok, true, id);
    assert.ok(d.title.length > 0, id);
    assert.equal(d.editPolicy, 'open', id);
  }
});

test('every work type has a drive doc; states covered', () => {
  for (const wt of WORK_TYPES) assert.ok(DEFAULT_WORKFLOWS[`drive.${wt}`], `drive.${wt}`);
  assert.deepEqual(ONBOARD_STATES, ['stuck', 'in-progress', 'completed']);
});

test('controller.pass carries the routing rule, marker, and self-edit discipline', () => {
  const b = DEFAULT_WORKFLOWS['controller.pass'].body;
  for (const needle of ['mission_workflow_get', 'onboard:state', 'onboard:work-type', 'wrapup.completed', 'recover.stuck', '⟦MISSION-CONTROL⟧', 'manageMode', 'announce']) {
    assert.ok(b.includes(needle), `controller.pass mentions ${needle}`);
  }
});

test('onboard.analyze names the classification enums', () => {
  const b = DEFAULT_WORKFLOWS['onboard.analyze'].body;
  for (const v of ['stuck', 'in-progress', 'completed', 'design', 'direct-impl', 'bugfix', 'feature', 'mission_session_read', 'mission_update']) {
    assert.ok(b.includes(v), `onboard.analyze mentions ${v}`);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd core && npm run build:test 2>&1 | tail -3`
Expected: tsc FAILS — module `../mission/workflow-defaults` not found.

- [ ] **Step 3: Write the implementation**

The `controller.pass` body is the EXISTING `CONTROLLER_PASS_DIRECTIVE` text (copy it verbatim from `core/src/mission/mission-controller.ts:430-431` as the first paragraph) followed by the onboarded-handling addendum. Full file:

```ts
// core/src/mission/workflow-defaults.ts
/** TS-default playbook bodies. Fallback when the registry is unavailable; seeded into the dataset by the leader. */
import type { WorkflowEditPolicy } from './workflow-model';

export const WORK_TYPES = ['design', 'direct-impl', 'bugfix', 'feature'] as const;
export const ONBOARD_STATES = ['stuck', 'in-progress', 'completed'] as const;

// NOTE: keep this string byte-identical to CONTROLLER_PASS_DIRECTIVE in mission-controller.ts
// (Task 6 makes mission-controller.ts import the default from HERE so there is one source).
const PASS_BASE =
  'Run a controller pass now. FIRST call mission_changes — re-evaluate any mission an external actor (a human or another node) edited since your last pass BEFORE anything else, and adapt rather than override. THEN call mission_schedule for the deterministic plan: act on each id in `ready` (place/spawn an executor via ccr_cloud_start, NEVER agent_execute, then bind with mission_update({binding})); for each `epicRollups` entry whose status/progress differs from the stored parent, apply it with mission_update; leave `blocked` and `containers` alone (they are gated/rolled-up by code). For two ready missions that touch the same area with no explicit dependsOn, decide parallel-vs-sequence (use mission_neighbors/mission_graph to see structure) and if you serialize them, tag them mission_tag({add:{"ctl:serialize-group":["<group>"]}}) so the scheduler enforces it next pass. Record your view with ctl: tags (e.g. ctl:readiness). Answer any worker pendingQuestion IMMEDIATELY via mission_session_answer; resume a non-live bound worker with mission_session_resume(sid) before respawning. BEFORE you place/spawn an executor for a `ready` mission, call session_footprints (your cluster) and AVOID a node/repo/branch/worktree an UNMANAGED recent session occupies — especially one whose openChanges overlap the mission repo/branch or whose branch is pushed:false — and any port an exclusive service holds; mission-managed sessions (managed set) are your own, never a conflict. If the only placement collides, DEFER: leave the mission ready, tag ctl:deferred-contention with the conflicting session, and revisit next pass. If the survey is partial/warming, treat unknown nodes as clear and re-check next pass. Then await the next pass.';

const PASS_ONBOARDED = `

ONBOARDED MISSIONS (origin:'onboarded' — an EXISTING user session adopted into mission control):
- These are ALREADY BOUND to their session: never spawn/place an executor for them; the session IS the executor.
- Route by tags, then FETCH AND FOLLOW that doc via mission_workflow_get:
  onboard:state=analyzing  → mission_workflow_get("onboard.analyze")
  onboard:state=completed  → mission_workflow_get("wrapup.completed")
  onboard:state=stuck      → mission_workflow_get("recover.stuck") first, then the work-type doc
  otherwise                → mission_workflow_get("drive.<onboard:work-type>")  (design | direct-impl | bugfix | feature)
- manageMode gates you HARD: 'standby' = observe only — mission_session_drive is REJECTED by the server; follow observe.standby. 'handoff' = you drive end-to-end. Only a HUMAN can switch manageMode (mission_update rejects you); if you believe the mode should change, say so in chat and wait.
- Every drive you send to an onboarded session is auto-prefixed ⟦MISSION-CONTROL⟧ so human input stays distinguishable. If new session output contains a HUMAN message (no marker), acknowledge and yield: do not send competing instructions until the session is idle again.
- Answers to a pendingQuestion go through mission_session_answer as usual (never prefixed).

PLAYBOOK EVOLUTION: your process docs live in the workflow registry (mission_workflow_list/get/set/history/rollback). You may improve an 'open' doc when experience shows a better process — but ANNOUNCE every self-edit in chat with one line of rationale, keep edits small, and never touch what the invariant preamble forbids. A human can roll back any edit.`;

export const DEFAULT_WORKFLOWS: Record<string, { title: string; body: string; editPolicy: WorkflowEditPolicy }> = {
  'controller.pass': {
    title: 'Controller pass directive',
    editPolicy: 'open',
    body: PASS_BASE + PASS_ONBOARDED,
  },

  'onboard.analyze': {
    title: 'Onboarding intake analysis',
    editPolicy: 'open',
    body: `You are analyzing an EXISTING session that was just onboarded (mission tag onboard:state=analyzing).

GOAL: understand the session, record that understanding on the mission, classify it, then hand off to the right process.

1. READ the session history with mission_session_read(sid) — sid is the mission binding.sessionId; pass node from binding.node when set. For long transcripts read in pages (lastN=100, then larger) and build a running summary; do NOT paste raw transcript into the mission.
2. Determine, concretely:
   - GOAL: what is this session trying to achieve? (its own words, condensed)
   - DONE: what has it already completed (with evidence — files changed, tests run, decisions made)?
   - NOW: what is it currently doing / what was the last activity?
   - STATE: exactly one of stuck | in-progress | completed.
     stuck = repeating errors, waiting on something unavailable, or no progress across recent turns.
     completed = the session's own goal is met (claimed AND plausibly evidenced).
   - WORK-TYPE: exactly one of design | direct-impl | bugfix | feature.
     design = the deliverable is a decision/spec/plan, not code.
     direct-impl = straightforward implementation with no open design questions.
     bugfix = fixing broken behavior (reproduce → root cause → fix).
     feature = new capability that may need design + implementation + verification.
3. Honor the human note: the mission's first nextSteps entry may be "Human note: ..." — treat it as authoritative intent context.
4. RECORD it with mission_update: objective = the goal (1-3 sentences); plan = what remains, as you understand it; nextSteps = concrete next actions (keep the Human note line first if present); title = "Onboarded: <short goal>".
5. TAG it with mission_tag: {set:{"onboard:work-type":["<type>"],"onboard:state":["<state>"]}} — this REPLACES onboard:state=analyzing and routes future passes.
6. Then:
   - manageMode standby → post a concise summary in controller chat (goal / state / work-type / what you'd do in handoff) and follow observe.standby from now on.
   - manageMode handoff → immediately fetch the routed doc (wrapup.completed / recover.stuck / drive.<work-type>) and proceed.`,
  },

  'drive.design': {
    title: 'Drive design-type work',
    editPolicy: 'open',
    body: `Driving an onboarded session whose work is DESIGN (the deliverable is a decision/spec/plan).

- Establish from the transcript what design questions are OPEN vs already settled; never reopen settled ones.
- Drive the session to converge: one focused instruction per drive (⟦MISSION-CONTROL⟧ is added for you) — e.g. "resolve open question X and update the spec", "write the decision + trade-offs into <file>".
- Judgment calls that belong to the human (product direction, irreversible trade-offs, spending) → do NOT decide: set the mission status to paused, record the question in nextSteps, and surface it in chat (a need_approval gate if the session raises one).
- DONE when a concrete design artifact exists (spec file, ADR, or an unambiguous written decision) — record its path/ref in mission results via mission_update, mark the mission done, summarize in chat.`,
  },

  'drive.direct-impl': {
    title: 'Drive direct implementation',
    editPolicy: 'open',
    body: `Driving an onboarded session doing STRAIGHTFORWARD IMPLEMENTATION (no open design questions).

- Confirm scope from the analysis; if the transcript reveals hidden design questions, retag onboard:work-type=design and switch docs.
- Drive stepwise to completion: implement → test → verify. Prefer the session's own conventions (its CLAUDE.md, its test runner).
- REQUIRE EVIDENCE before accepting done: a passing test run / build output visible in the session transcript — "it should work now" is not done.
- On repeated failure of the same step (2+ attempts), switch to recover.stuck.
- DONE: evidence recorded in mission results (mission_update), status done, chat summary.`,
  },

  'drive.bugfix': {
    title: 'Drive bug-fix work',
    editPolicy: 'open',
    body: `Driving an onboarded session fixing a BUG.

- Sequence is fixed: REPRODUCE → ROOT-CAUSE → FIX → REGRESSION-TEST → VERIFY. Do not let the session fix before the root cause is confirmed and stated — if the transcript shows fix-guessing, drive it back to reproduction/diagnosis first.
- The regression test must FAIL before the fix and PASS after (ask the session to show both runs when practical).
- If reproduction is impossible (environment/data missing), that is a human question: pause + surface, don't let the session guess-fix.
- DONE: root cause stated + fix + passing regression test evidenced in the transcript; record in results; status done; chat summary.`,
  },

  'drive.feature': {
    title: 'Drive feature work',
    editPolicy: 'open',
    body: `Driving an onboarded session building a FEATURE.

- First verify requirements are unambiguous from the transcript + mission objective; ambiguity → surface the specific question to the human (paused + chat), do not invent product decisions.
- If a design phase is genuinely needed, run the drive.design process for that portion first, then return here.
- Then drive implement → test → verify end-to-end (the feature demonstrably works, not just compiles); require evidence like drive.direct-impl.
- Watch scope: if the session drifts beyond the mission objective, steer it back; material scope change = human decision (pause + surface).
- DONE: working feature evidenced end-to-end; results recorded; status done; chat summary.`,
  },

  'recover.stuck': {
    title: 'Recover a stuck session',
    editPolicy: 'open',
    body: `An onboarded session is STUCK (onboard:state=stuck, or you detected no progress / repeated failures).

1. CLASSIFY the blocker from the last transcript pages:
   - error-loop: same error across attempts → drive one targeted instruction naming the loop and a different diagnostic step ("stop retrying X; read the actual error source at <ref>; state the root cause before any further change").
   - missing-info: the session needs an answer/credential/decision → if a human must supply it: mission paused + ask in chat. If YOU can supply it from mission context, drive it.
   - waiting-on-human: an unanswered question in the session → answer via mission_session_answer if it is within mission scope and NOT a gate/pivot; else surface to the human.
   - environment: dead process / lost connection / expired auth → try mission_session_resume(sid); needs-force is a HUMAN decision (surface it, never force yourself).
2. ONE recovery attempt per pass — then reassess on the next engagement. Two failed recovery attempts on the same blocker → mission status blocked + a clear chat escalation (what was tried, what's needed).
3. Once unstuck: retag onboard:state=in-progress and return to the work-type doc.`,
  },

  'wrapup.completed': {
    title: 'Wrap up a completed session',
    editPolicy: 'open',
    body: `The onboarded session's work appears COMPLETED.

1. VERIFY the claim against evidence in the transcript (tests passed, artifact delivered, goal met). If evidence is thin and the mission is handoff-mode, drive ONE verification instruction (e.g. "run the test suite and show the summary"). In standby, note the gap instead of driving.
2. RECORD the outcome: mission_update results (what was delivered, refs/paths), progress 100, a 2-4 sentence closing summary in the plan or chat.
3. FOLLOW-UPS the session surfaced (todos, deferred items) → list them in nextSteps as PROPOSALS for the human; you may suggest new missions in chat but do not create them unprompted.
4. Mark the mission done. The session itself is LEFT UNTOUCHED (never close/kill an onboarded session).`,
  },

  'observe.standby': {
    title: 'Standby observation conduct',
    editPolicy: 'open',
    body: `This onboarded mission is manageMode=standby: the human runs the session; you WATCH.

- NEVER drive it (the server rejects mission_session_drive anyway). Never answer its questions unless the human asked you to in chat.
- The supervisor tracks progress for you (interim). On a material engagement, refresh the mission record via mission_update (objective drift, progress, state tag) so the mission stays a truthful live summary.
- NOTIFY the human in chat (concise, one message) when you observe: the session finished its goal · it looks stuck (repeated errors / long stall) · it hit a gate-like question aimed at a human · onboard:state changed.
- If the human asks you to take over, remind them: mission_update({manageMode:"handoff"}) — you cannot switch it yourself.`,
  },
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd core && npm run build:test && node --test dist-test/__tests__/workflow-defaults.test.js`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add core/src/mission/workflow-defaults.ts core/src/__tests__/workflow-defaults.test.ts
git commit -m "feat(workflow): default playbook library (9 docs incl. onboarding + drive processes)"
```

---

### Task 3: `workflow-store.ts` — dataset, put choke, snapshots, rollback, seed, render

**Files:**
- Create: `core/src/mission/workflow-store.ts`
- Test: `core/src/__tests__/workflow-store.test.ts`

**Interfaces:**
- Consumes: Task 1 model, Task 2 defaults, `getDataService`/`CallCtx`/`DataRecord` (same imports as `mission-store.ts`), `getProjectSettings().missionHistoryInlineCap`, `defaultActor()` from `mission-history.ts`.
- Produces:
  - `WorkflowPort { isEnabled(): boolean; get(id): Promise<WorkflowDoc|null>; list(): Promise<WorkflowDoc[]>; put(d: WorkflowDoc): Promise<void>; }`
  - `WorkflowSnapshotPort { isEnabled(): boolean; put(s: WorkflowSnapshot): Promise<void>; get(docId: string, rev: number): Promise<WorkflowSnapshot|null>; list(docId: string, opts:{limit?:number;beforeRev?:number}): Promise<WorkflowSnapshot[]>; }`
  - `WorkflowSnapshot { id: string /* `${docId}:${rev}` */; docId: string; rev: number; at: number; actor: MissionActor; title: string; body: string; editPolicy: WorkflowEditPolicy }`
  - `getWorkflow(id, port?)`, `listWorkflows(port?)`, `putWorkflow(input: {id;title;body;editPolicy}, actor, port?, snap?): Promise<{doc: WorkflowDoc; changed: boolean}>` (validates, enforces rev/history/snapshot; throws `Error` with `.code` on validation failure)
  - `rollbackWorkflow(id, toRev, actor, port?, snap?): Promise<{doc: WorkflowDoc}|{error:{code,message}}>`
  - `seedDefaultWorkflows(port?, snap?): Promise<number>` (upserts MISSING ids only; returns count seeded; actor = system user)
  - `renderWorkflow(id, port?): Promise<string>` (store body if present else `DEFAULT_WORKFLOWS[id].body` else throws `Error('unknown workflow ...')`; always through `renderWorkflowText`)
  - `getWorkflowRaw(id, port?): Promise<{doc: WorkflowDoc|null; defaultBody: string|null; rendered: string}>` for the GET route.

**Design notes (differ from mission-history deliberately):** history side-storage is FULL SNAPSHOTS per rev (docs ≤64KiB; makes rollback exact), not truncated diffs. The inline `history` entries store `{body:{from:'len:<n>',to:'len:<m>'}}` style summaries for body + real values for title/editPolicy. Datasets: `mission-workflows` + `mission-workflow-history`, both `backend:'cache'`, `visibility:'cross-node-readable'`, `syncMode:'full'`, **`scope:'fleet'`** (pass `scope: 'fleet'` in the createDataset input object, same `as any` cast as mission-store's `ensureDataset`).

- [ ] **Step 1: Write the failing test** — cover with an in-memory fake port pair:

```ts
// core/src/__tests__/workflow-store.test.ts
import { test } from 'node:test';
import assert from 'node:assert';
import { putWorkflow, rollbackWorkflow, seedDefaultWorkflows, renderWorkflow, getWorkflowRaw,
  type WorkflowPort, type WorkflowSnapshotPort, type WorkflowSnapshot } from '../mission/workflow-store';
import { WORKFLOW_INVARIANT_PREAMBLE, type WorkflowDoc } from '../mission/workflow-model';
import { DEFAULT_WORKFLOWS } from '../mission/workflow-defaults';
import type { MissionActor } from '../mission/mission-model';

function fakes() {
  const docs = new Map<string, WorkflowDoc>();
  const snaps = new Map<string, WorkflowSnapshot>();
  const port: WorkflowPort = {
    isEnabled: () => true,
    get: async (id) => docs.get(id) ? JSON.parse(JSON.stringify(docs.get(id))) : null,
    list: async () => [...docs.values()].map((d) => JSON.parse(JSON.stringify(d))),
    put: async (d) => { docs.set(d.id, JSON.parse(JSON.stringify(d))); },
  };
  const snap: WorkflowSnapshotPort = {
    isEnabled: () => true,
    put: async (s) => { snaps.set(s.id, s); },
    get: async (docId, rev) => snaps.get(`${docId}:${rev}`) ?? null,
    list: async (docId, opts) => [...snaps.values()].filter((s) => s.docId === docId && (opts.beforeRev == null || s.rev < opts.beforeRev)).sort((a, b) => b.rev - a.rev).slice(0, opts.limit ?? 50),
  };
  return { port, snap, docs, snaps };
}
const user: MissionActor = { kind: 'user', channel: 'mcp', at: 1 };
const ctrl: MissionActor = { kind: 'controller', channel: 'controller', at: 2 };

test('putWorkflow creates rev1 with snapshot, bumps on change, no-ops on identical', async () => {
  const { port, snap, snaps } = fakes();
  const r1 = await putWorkflow({ id: 'x.y', title: 'T', body: 'B1', editPolicy: 'open' }, user, port, snap);
  assert.equal(r1.doc.rev, 1); assert.equal(r1.changed, true);
  assert.ok(snaps.get('x.y:1'), 'snapshot spilled');
  const r2 = await putWorkflow({ id: 'x.y', title: 'T', body: 'B1', editPolicy: 'open' }, user, port, snap);
  assert.equal(r2.changed, false); assert.equal(r2.doc.rev, 1);
  const r3 = await putWorkflow({ id: 'x.y', title: 'T', body: 'B2', editPolicy: 'open' }, ctrl, port, snap);
  assert.equal(r3.doc.rev, 2); assert.equal(r3.doc.lastUpdatedBy.kind, 'controller');
  assert.equal(snaps.get('x.y:2')!.body, 'B2');
});

test('putWorkflow validates id and body', async () => {
  const { port, snap } = fakes();
  await assert.rejects(() => putWorkflow({ id: 'BAD ID', title: 't', body: 'b', editPolicy: 'open' }, user, port, snap));
  await assert.rejects(() => putWorkflow({ id: 'a.b', title: 't', body: '', editPolicy: 'open' }, user, port, snap));
});

test('rollback writes the old body as a NEW rev', async () => {
  const { port, snap } = fakes();
  await putWorkflow({ id: 'x.y', title: 'T', body: 'B1', editPolicy: 'open' }, user, port, snap);
  await putWorkflow({ id: 'x.y', title: 'T', body: 'B2', editPolicy: 'open' }, user, port, snap);
  const r = await rollbackWorkflow('x.y', 1, user, port, snap);
  assert.ok(!('error' in r));
  assert.equal((r as any).doc.rev, 3);
  assert.equal((r as any).doc.body, 'B1');
  const missing = await rollbackWorkflow('x.y', 99, user, port, snap);
  assert.equal((missing as any).error.code, 'NOT_FOUND');
});

test('seed inserts only missing docs and is idempotent', async () => {
  const { port, snap } = fakes();
  const n1 = await seedDefaultWorkflows(port, snap);
  assert.equal(n1, Object.keys(DEFAULT_WORKFLOWS).length);
  const n2 = await seedDefaultWorkflows(port, snap);
  assert.equal(n2, 0);
});

test('renderWorkflow: store body wins, default falls back, always preambled', async () => {
  const { port, snap } = fakes();
  const viaDefault = await renderWorkflow('controller.pass', port);
  assert.ok(viaDefault.startsWith(WORKFLOW_INVARIANT_PREAMBLE));
  assert.ok(viaDefault.includes('Run a controller pass now.'));
  await putWorkflow({ id: 'controller.pass', title: 'T', body: 'CUSTOM', editPolicy: 'open' }, user, port, snap);
  const viaStore = await renderWorkflow('controller.pass', port);
  assert.ok(viaStore.endsWith('CUSTOM'));
  await assert.rejects(() => renderWorkflow('no.such.doc', port));
});

test('getWorkflowRaw returns doc+rendered', async () => {
  const { port, snap } = fakes();
  const r = await getWorkflowRaw('controller.pass', port);
  assert.equal(r.doc, null);
  assert.ok(r.rendered.includes('Run a controller pass now.'));
});
```

- [ ] **Step 2: Run to verify failure** — `cd core && npm run build:test 2>&1 | tail -3` → module not found.

- [ ] **Step 3: Implementation.** Mirror `mission-store.ts` structure exactly (livePort/defaultPort/ensureDataset with `scope:'fleet'` added to both createDataset calls; `systemCtx()`; record mapping `fields: {...doc}`). Core logic:

```ts
// core/src/mission/workflow-store.ts  (key logic — full file mirrors mission-store.ts plumbing)
import { WorkflowDoc, WorkflowEditPolicy, WorkflowChange, validateWorkflowId, validateWorkflowBody, workflowChanged, renderWorkflowText } from './workflow-model';
import { DEFAULT_WORKFLOWS } from './workflow-defaults';
import type { MissionActor } from './mission-model';
import { getDataService } from '../data/data-service';
import { getProjectSettings } from '../project-settings';
import type { CallCtx } from '../data/data-service';

const DATASET = 'mission-workflows';
const SNAP_DATASET = 'mission-workflow-history';
// ... WorkflowPort / WorkflowSnapshotPort interfaces + livePort()/liveSnapshotPort()/default ports:
//     copy the mission-store.ts livePort/ensureDataset pattern verbatim, with
//     createDataset({ id: DATASET, backend: 'cache', title: 'Mission Workflows',
//       visibility: 'cross-node-readable', syncMode: 'full', scope: 'fleet', config: { kind: 'cache' } } as any)
//     and the same for SNAP_DATASET (title 'Mission Workflow History').

export async function putWorkflow(
  input: { id: string; title: string; body: string; editPolicy: WorkflowEditPolicy },
  actor: MissionActor,
  port: WorkflowPort = defaultPort(),
  snap: WorkflowSnapshotPort = defaultSnapshotPort(),
): Promise<{ doc: WorkflowDoc; changed: boolean }> {
  const vid = validateWorkflowId(input.id);
  if (!vid.ok) { const e = new Error(vid.message) as any; e.code = vid.code; throw e; }
  const vb = validateWorkflowBody(input.body);
  if (!vb.ok) { const e = new Error(vb.message) as any; e.code = vb.code; throw e; }
  const prev = await port.get(input.id);
  if (prev && !workflowChanged(prev, input)) return { doc: prev, changed: false };
  const now = Date.now();
  const rev = (prev?.rev ?? 0) + 1;
  const cap = getProjectSettings().missionHistoryInlineCap ?? 50;
  const change: WorkflowChange = {
    rev, at: now, actor,
    changes: {
      ...(prev?.title !== input.title ? { title: { from: prev?.title ?? null, to: input.title } } : {}),
      ...(prev?.body !== input.body ? { body: { from: `len:${prev?.body.length ?? 0}`, to: `len:${input.body.length}` } } : {}),
      ...(prev?.editPolicy !== input.editPolicy ? { editPolicy: { from: prev?.editPolicy ?? null, to: input.editPolicy } } : {}),
    },
  };
  const doc: WorkflowDoc = {
    id: input.id, title: input.title, body: input.body, editPolicy: input.editPolicy,
    rev, history: [...(prev?.history ?? []), change].slice(-cap),
    createdBy: prev?.createdBy ?? actor, lastUpdatedBy: actor,
    createdAt: prev?.createdAt ?? now, updatedAt: now,
  };
  await port.put(doc);
  try {
    await snap.put({ id: `${doc.id}:${rev}`, docId: doc.id, rev, at: now, actor, title: doc.title, body: doc.body, editPolicy: doc.editPolicy });
  } catch { /* best-effort durable snapshot */ }
  return { doc, changed: true };
}

export async function rollbackWorkflow(
  id: string, toRev: number, actor: MissionActor,
  port: WorkflowPort = defaultPort(), snap: WorkflowSnapshotPort = defaultSnapshotPort(),
): Promise<{ doc: WorkflowDoc } | { error: { code: string; message: string } }> {
  const target = await snap.get(id, toRev);
  if (!target) return { error: { code: 'NOT_FOUND', message: `no snapshot ${id}:${toRev}` } };
  const { doc } = await putWorkflow({ id, title: target.title, body: target.body, editPolicy: target.editPolicy }, actor, port, snap);
  return { doc };
}

export async function seedDefaultWorkflows(
  port: WorkflowPort = defaultPort(), snap: WorkflowSnapshotPort = defaultSnapshotPort(),
): Promise<number> {
  if (!port.isEnabled()) return 0;
  let n = 0;
  const seedActor: MissionActor = { kind: 'user', channel: 'api', label: 'system-seed', at: Date.now() };
  for (const [id, d] of Object.entries(DEFAULT_WORKFLOWS)) {
    const existing = await port.get(id).catch(() => null);
    if (existing) continue;
    try { await putWorkflow({ id, ...d }, seedActor, port, snap); n++; } catch { /* per-doc best-effort */ }
  }
  return n;
}

export async function renderWorkflow(id: string, port: WorkflowPort = defaultPort()): Promise<string> {
  let body: string | null = null;
  try { body = (await port.get(id))?.body ?? null; } catch { body = null; }
  if (body == null) body = DEFAULT_WORKFLOWS[id]?.body ?? null;
  if (body == null) throw new Error(`unknown workflow "${id}" (no stored doc, no default)`);
  return renderWorkflowText(body);
}

export async function getWorkflowRaw(id: string, port: WorkflowPort = defaultPort()): Promise<{ doc: WorkflowDoc | null; defaultBody: string | null; rendered: string }> {
  let doc: WorkflowDoc | null = null;
  try { doc = await port.get(id); } catch { doc = null; }
  const defaultBody = DEFAULT_WORKFLOWS[id]?.body ?? null;
  const body = doc?.body ?? defaultBody;
  if (body == null) { const e = new Error(`unknown workflow "${id}"`) as any; e.code = 'NOT_FOUND'; throw e; }
  return { doc, defaultBody, rendered: renderWorkflowText(body) };
}
// plus: getWorkflow / listWorkflows / listWorkflowSnapshots thin wrappers over the ports.
```

- [ ] **Step 4: Run to verify pass** — `node --test dist-test/__tests__/workflow-store.test.js` → all pass.
- [ ] **Step 5: Commit** — `git commit -m "feat(workflow): fleet-synced workflow store with snapshots, rollback, seeding, render"`

---

### Task 4: Workflow REST routes + editPolicy enforcement

**Files:**
- Modify: `core/src/routes/core/mission.routes.ts` (handlers near the other `handle*` exports; registration inside `createMissionRoutes` — see step 3 for exact position)
- Test: `core/src/__tests__/mission-workflow-routes.test.ts`

**Interfaces:**
- Consumes: Task 3 store fns; existing `actorFor`, `anchorToLeader`, `realLeaderAnchor`, `ok`/`fail`, `isControllerActor` (Task 1).
- Produces route handlers (exported for tests):
  - `handleWorkflowList(port?, leader?)` → `ok({ workflows: WorkflowDoc[] , defaults: string[] })` (defaults = ids present only as TS defaults)
  - `handleWorkflowGet(id, port?, leader?)` → `ok({ doc, defaultBody, rendered })` or `fail('NOT_FOUND')`
  - `handleWorkflowSet(id, b, port?, snap?, actor?, leader?)` → editPolicy-gated write
  - `handleWorkflowHistory(id, opts, snap?, leader?)` → `ok({ snapshots })` (each WITHOUT `body` — `{rev,at,actor,title,editPolicy,bodyBytes}` — bodies are fetched via rollback/get)
  - `handleWorkflowRollback(id, b, port?, snap?, actor?, leader?)`

**editPolicy rules (enforce in `handleWorkflowSet`):**
1. Load existing doc (or default entry). Effective policy = `doc?.editPolicy ?? DEFAULT_WORKFLOWS[id]?.editPolicy ?? 'open'`.
2. If effective policy is `'human-only'` and `isControllerActor(who)` → `fail('FORBIDDEN', 'this workflow doc is human-only')`.
3. If `b.editPolicy` is present AND differs from the effective policy AND `isControllerActor(who)` → `fail('FORBIDDEN', 'editPolicy changes are human-only')`.
4. Rollback (`handleWorkflowRollback`) applies rule 1-2 the same way (a controller may roll back an 'open' doc).

- [ ] **Step 1: Failing test** (DI everything; no live data service):

```ts
// core/src/__tests__/mission-workflow-routes.test.ts
import { test } from 'node:test';
import assert from 'node:assert';
import { handleWorkflowList, handleWorkflowGet, handleWorkflowSet, handleWorkflowHistory, handleWorkflowRollback } from '../routes/core/mission.routes';
// reuse the fakes() pair from workflow-store.test — copy the helper into this file (tests must be self-contained).
import type { MissionActor } from '../mission/mission-model';
// ... fakes() copied here ...
const user: MissionActor = { kind: 'user', channel: 'mcp', at: 1 };
const ctrl: MissionActor = { kind: 'controller', channel: 'controller', at: 2 };

test('set/get/list roundtrip', async () => {
  const { port, snap } = fakes();
  const w = await handleWorkflowSet('a.b', { title: 'T', body: 'B', editPolicy: 'open' }, port, snap, user);
  assert.equal(w.success, true);
  const g = await handleWorkflowGet('a.b', port);
  assert.equal((g.data as any).doc.rev, 1);
  assert.ok((g.data as any).rendered.includes('B'));
  const l = await handleWorkflowList(port);
  assert.ok((l.data as any).workflows.some((d: any) => d.id === 'a.b'));
  assert.ok((l.data as any).defaults.includes('controller.pass'), 'unseeded defaults listed');
});

test('human-only doc rejects controller writes and controller editPolicy changes', async () => {
  const { port, snap } = fakes();
  await handleWorkflowSet('h.doc', { title: 'T', body: 'B', editPolicy: 'human-only' }, port, snap, user);
  const denied = await handleWorkflowSet('h.doc', { title: 'T', body: 'B2', editPolicy: 'human-only' }, port, snap, ctrl);
  assert.equal(denied.success, false);
  assert.equal(denied.error!.code, 'FORBIDDEN');
  const flip = await handleWorkflowSet('o.doc', { title: 'T', body: 'B', editPolicy: 'human-only' }, port, snap, ctrl);
  assert.equal(flip.success, false, 'controller cannot set human-only on create either');
});

test('controller CAN edit an open doc', async () => {
  const { port, snap } = fakes();
  await handleWorkflowSet('o.doc', { title: 'T', body: 'B', editPolicy: 'open' }, port, snap, user);
  const r = await handleWorkflowSet('o.doc', { title: 'T', body: 'B2', editPolicy: 'open' }, port, snap, ctrl);
  assert.equal(r.success, true);
  assert.equal((r.data as any).doc.lastUpdatedBy.kind, 'controller');
});

test('history lists snapshot metadata without bodies; rollback restores', async () => {
  const { port, snap } = fakes();
  await handleWorkflowSet('a.b', { title: 'T', body: 'B1', editPolicy: 'open' }, port, snap, user);
  await handleWorkflowSet('a.b', { title: 'T', body: 'B2', editPolicy: 'open' }, port, snap, user);
  const h = await handleWorkflowHistory('a.b', {}, snap);
  const rows = (h.data as any).snapshots;
  assert.equal(rows.length, 2);
  assert.equal(rows[0].rev, 2);
  assert.equal(rows[0].body, undefined);
  assert.equal(typeof rows[0].bodyBytes, 'number');
  const rb = await handleWorkflowRollback('a.b', { toRev: '1' }, port, snap, user); // string coercion!
  assert.equal(rb.success, true);
  assert.equal((rb.data as any).doc.body, 'B1');
});

test('invalid id/body surface structured errors', async () => {
  const { port, snap } = fakes();
  const bad = await handleWorkflowSet('BAD ID', { title: 't', body: 'b', editPolicy: 'open' }, port, snap, user);
  assert.equal(bad.success, false);
  assert.equal(bad.error!.code, 'INVALID_INPUT');
});
```

- [ ] **Step 2: Verify failure** — build fails on missing exports.
- [ ] **Step 3: Implement.** Handlers (place after `handleHistory` in mission.routes.ts):

```ts
// mission.routes.ts additions (imports at top):
import { getWorkflow, listWorkflows, putWorkflow, rollbackWorkflow, getWorkflowRaw, listWorkflowSnapshots,
  type WorkflowPort, type WorkflowSnapshotPort } from '../../mission/workflow-store';
import { isControllerActor, type WorkflowEditPolicy } from '../../mission/workflow-model';
import { DEFAULT_WORKFLOWS } from '../../mission/workflow-defaults';

export async function handleWorkflowList(port?: WorkflowPort, leader?: LeaderAnchorDeps): Promise<Envelope> {
  const anchored = await anchorToLeader(leader, 'GET', '/mission/workflows');
  if (anchored) return anchored;
  const workflows = await listWorkflows(port);
  const stored = new Set(workflows.map((w) => w.id));
  const defaults = Object.keys(DEFAULT_WORKFLOWS).filter((id) => !stored.has(id));
  return ok({ workflows, defaults });
}

export async function handleWorkflowGet(id: string, port?: WorkflowPort, leader?: LeaderAnchorDeps): Promise<Envelope> {
  const anchored = await anchorToLeader(leader, 'GET', `/mission/workflows/${encodeURIComponent(id)}`);
  if (anchored) return anchored;
  try { return ok(await getWorkflowRaw(id, port)); }
  catch (e) { return fail((e as any).code ?? 'NOT_FOUND', (e as Error).message); }
}

export async function handleWorkflowSet(id: string, b: Record<string, unknown>, port?: WorkflowPort, snap?: WorkflowSnapshotPort, actor?: MissionActor, leader?: LeaderAnchorDeps): Promise<Envelope> {
  const anchored = await anchorToLeader(leader, 'POST', `/mission/workflows/${encodeURIComponent(id)}`, b, true);
  if (anchored) return anchored;
  const who = actor ?? await actorFor(b);
  const existing = await getWorkflow(id, port).catch(() => null);
  const effectivePolicy: WorkflowEditPolicy = existing?.editPolicy ?? DEFAULT_WORKFLOWS[id]?.editPolicy ?? 'open';
  if (effectivePolicy === 'human-only' && isControllerActor(who)) return fail('FORBIDDEN', 'this workflow doc is human-only');
  const nextPolicy = (str(b.editPolicy) === 'human-only' ? 'human-only' : str(b.editPolicy) === 'open' ? 'open' : effectivePolicy) as WorkflowEditPolicy;
  if (nextPolicy !== effectivePolicy && isControllerActor(who)) return fail('FORBIDDEN', 'editPolicy changes are human-only');
  const title = str(b.title) ?? existing?.title ?? DEFAULT_WORKFLOWS[id]?.title ?? id;
  const body = str(b.body) ?? existing?.body ?? DEFAULT_WORKFLOWS[id]?.body;
  if (body === undefined) return fail('INVALID_INPUT', 'body is required for a new doc');
  try {
    const r = await putWorkflow({ id, title, body, editPolicy: nextPolicy }, who, port, snap);
    return ok({ doc: r.doc, changed: r.changed });
  } catch (e) { return fail((e as any).code ?? 'INVALID_INPUT', (e as Error).message); }
}

export async function handleWorkflowHistory(id: string, opts: { limit?: number; beforeRev?: number }, snap?: WorkflowSnapshotPort, leader?: LeaderAnchorDeps): Promise<Envelope> {
  const qs = new URLSearchParams();
  if (opts.limit != null) qs.set('limit', String(opts.limit));
  if (opts.beforeRev != null) qs.set('beforeRev', String(opts.beforeRev));
  const anchored = await anchorToLeader(leader, 'GET', `/mission/workflows/${encodeURIComponent(id)}/history${qs.toString() ? `?${qs}` : ''}`);
  if (anchored) return anchored;
  const rows = await listWorkflowSnapshots(id, opts, snap);
  return ok({ snapshots: rows.map(({ body, ...rest }) => ({ ...rest, bodyBytes: Buffer.byteLength(body, 'utf8') })) });
}

export async function handleWorkflowRollback(id: string, b: Record<string, unknown>, port?: WorkflowPort, snap?: WorkflowSnapshotPort, actor?: MissionActor, leader?: LeaderAnchorDeps): Promise<Envelope> {
  const anchored = await anchorToLeader(leader, 'POST', `/mission/workflows/${encodeURIComponent(id)}/rollback`, b, true);
  if (anchored) return anchored;
  const who = actor ?? await actorFor(b);
  const existing = await getWorkflow(id, port).catch(() => null);
  const effectivePolicy: WorkflowEditPolicy = existing?.editPolicy ?? DEFAULT_WORKFLOWS[id]?.editPolicy ?? 'open';
  if (effectivePolicy === 'human-only' && isControllerActor(who)) return fail('FORBIDDEN', 'this workflow doc is human-only');
  const toRevRaw = b.toRev;
  const toRev = typeof toRevRaw === 'number' ? toRevRaw : parseInt(String(toRevRaw ?? ''), 10);
  if (Number.isNaN(toRev)) return fail('INVALID_INPUT', 'toRev (number) is required');
  const r = await rollbackWorkflow(id, toRev, who, port, snap);
  if ('error' in r) return fail(r.error.code, r.error.message);
  return ok({ doc: r.doc });
}
```

Registration — insert into `createMissionRoutes` IMMEDIATELY AFTER the `/mission/views` literal block (currently the `GET /mission/views` line) and BEFORE the `/mission/(?<id>...)/place` line:

```ts
    // workflow registry literals — MUST be before every /mission/:id pattern
    { method: 'GET', pattern: /^\/mission\/workflows$/, handler: async () => handleWorkflowList(undefined, realLeaderAnchor()) },
    { method: 'GET', pattern: /^\/mission\/workflows\/(?<id>[^/]+)\/history$/, handler: async (req) => {
        const rawLimit = req.query?.limit != null ? parseInt(String(req.query.limit), 10) : undefined;
        const rawBefore = req.query?.beforeRev != null ? parseInt(String(req.query.beforeRev), 10) : undefined;
        return handleWorkflowHistory(req.params.id, {
          limit: rawLimit != null && !Number.isNaN(rawLimit) ? rawLimit : undefined,
          beforeRev: rawBefore != null && !Number.isNaN(rawBefore) ? rawBefore : undefined,
        }, undefined, realLeaderAnchor());
      } },
    { method: 'POST', pattern: /^\/mission\/workflows\/(?<id>[^/]+)\/rollback$/, handler: async (req) => handleWorkflowRollback(req.params.id, (req.body || {}) as Record<string, unknown>, undefined, undefined, undefined, realLeaderAnchor()) },
    { method: 'GET', pattern: /^\/mission\/workflows\/(?<id>[^/]+)$/, handler: async (req) => handleWorkflowGet(req.params.id, undefined, realLeaderAnchor()) },
    { method: 'POST', pattern: /^\/mission\/workflows\/(?<id>[^/]+)$/, handler: async (req) => handleWorkflowSet(req.params.id, (req.body || {}) as Record<string, unknown>, undefined, undefined, undefined, realLeaderAnchor()) },
```

Also export `listWorkflowSnapshots` from workflow-store if Task 3 didn't (wrapper over snapshot port `.list`).

- [ ] **Step 4: Verify pass** — `node --test dist-test/__tests__/mission-workflow-routes.test.js`.
- [ ] **Step 5: Commit** — `git commit -m "feat(workflow): /mission/workflows routes with editPolicy enforcement and leader-anchored writes"`

---

### Task 5: MCP tools `mission_workflow_*`

**Files:**
- Create: `core/src/mcp-server/tools/mission-workflow.ts`
- Modify: `core/src/mcp-server/tools/expanded.ts` (import at the `MISSION_*` import block ~line 53-55; spread defs next to `...MISSION_QUERY_TOOL_DEFS` ~line 1009; spread handlers next to `...MISSION_QUERY_HANDLERS` ~line 1865)
- Modify: `core/src/mcp-server/configure.ts` — add to `TOOL_SCOPES` (the block at ~line 269): `mission_workflow_list: 'read'`, `mission_workflow_get: 'read'`, `mission_workflow_set: 'write'`, `mission_workflow_history: 'read'`, `mission_workflow_rollback: 'write'`.
- Test: `core/src/__tests__/mission-workflow-mcp.test.ts`

**Interfaces:**
- Consumes: `_passthrough` `ok/err/workerGet/workerPost`, `currentMcpContext`, `withActorHint` (import from `./mission-query`).
- Produces: `MISSION_WORKFLOW_TOOL_DEFS`, `MISSION_WORKFLOW_HANDLERS` (same shape as `MISSION_QUERY_*`).

- [ ] **Step 1: Failing test**

```ts
// core/src/__tests__/mission-workflow-mcp.test.ts
import { test } from 'node:test';
import assert from 'node:assert';
import { MISSION_WORKFLOW_TOOL_DEFS, MISSION_WORKFLOW_HANDLERS } from '../mcp-server/tools/mission-workflow';

test('exactly the 5 workflow tools, defs and handlers aligned', () => {
  const names = MISSION_WORKFLOW_TOOL_DEFS.map((d) => d.name).sort();
  assert.deepEqual(names, ['mission_workflow_get', 'mission_workflow_history', 'mission_workflow_list', 'mission_workflow_rollback', 'mission_workflow_set']);
  assert.deepEqual(Object.keys(MISSION_WORKFLOW_HANDLERS).sort(), names);
  for (const d of MISSION_WORKFLOW_TOOL_DEFS) assert.ok(d.description.length > 20, d.name);
});

test('TOOL_SCOPES covers the 5 tools', () => {
  const { TOOL_SCOPES } = require('../mcp-server/configure');
  for (const d of MISSION_WORKFLOW_TOOL_DEFS) assert.ok(TOOL_SCOPES[d.name], d.name);
});
```

(If `TOOL_SCOPES` is not exported from configure.ts, export it — check first: `grep -n "TOOL_SCOPES" core/src/mcp-server/configure.ts`. If another test already asserts coverage via `assertScopesCoverTools`, mirror that pattern instead.)

- [ ] **Step 2: Verify failure.**
- [ ] **Step 3: Implement** (mirror `mission-query.ts` exactly):

```ts
// core/src/mcp-server/tools/mission-workflow.ts
/** Workflow-registry MCP tools (proxy the /mission/workflows routes). */
import type { McpToolResult } from '../configure';
import { ok, err, workerGet, workerPost } from './_passthrough';
import { currentMcpContext } from '../principal-context';
import { withActorHint } from './mission-query';

const S = { type: 'string' as const };
const obj = (props: Record<string, unknown>, required: string[] = []) => ({ type: 'object' as const, properties: props, required });
const pretty = (v: unknown): McpToolResult => ok(JSON.stringify(v, null, 2));

export const MISSION_WORKFLOW_TOOL_DEFS = [
  { name: 'mission_workflow_list', description: 'List mission-control workflow/playbook docs (stored + un-seeded TS defaults). These agent-interpreted docs define how the controller onboards, drives, and wraps up work.', inputSchema: obj({}) },
  { name: 'mission_workflow_get', description: 'Get one workflow doc by id (e.g. controller.pass, onboard.analyze, drive.bugfix): {doc (stored or null), defaultBody, rendered (invariant preamble + body — the text to FOLLOW)}.', inputSchema: obj({ id: S }, ['id']) },
  { name: 'mission_workflow_set', description: 'Create/update a workflow doc: {id, body, title?, editPolicy?:open|human-only}. Versioned + attributed; human-only docs and editPolicy changes reject controller callers. Self-edits must be announced in chat.', inputSchema: obj({ id: S, body: S, title: S, editPolicy: { ...S, enum: ['open', 'human-only'] } }, ['id', 'body']) },
  { name: 'mission_workflow_history', description: 'Snapshot history of a workflow doc, newest-first: {id, limit?, beforeRev?} → rev/at/actor/title/bodyBytes per revision.', inputSchema: obj({ id: S, limit: { type: 'number' as const }, beforeRev: { type: 'number' as const } }, ['id']) },
  { name: 'mission_workflow_rollback', description: 'Roll a workflow doc back to an earlier revision (writes that revision as a NEW attributed rev): {id, toRev}.', inputSchema: obj({ id: S, toRev: { type: 'number' as const } }, ['id', 'toRev']) },
] as const;

export const MISSION_WORKFLOW_HANDLERS: Record<string, (args: Record<string, unknown>) => Promise<McpToolResult>> = {
  mission_workflow_list: async () => { try { return pretty(await workerGet('/mission/workflows')); } catch (e) { return err((e as Error).message); } },
  mission_workflow_get: async (a) => { try { const id = String(a.id || ''); if (!id) return err('id is required'); return pretty(await workerGet(`/mission/workflows/${encodeURIComponent(id)}`)); } catch (e) { return err((e as Error).message); } },
  mission_workflow_set: async (a) => { try { const id = String(a.id || ''); if (!id) return err('id is required'); return pretty(await workerPost(`/mission/workflows/${encodeURIComponent(id)}`, withActorHint(a, currentMcpContext()?.toolUseId))); } catch (e) { return err((e as Error).message); } },
  mission_workflow_history: async (a) => { try { const id = String(a.id || ''); if (!id) return err('id is required'); const qs = new URLSearchParams(); if (a.limit != null) qs.set('limit', String(a.limit)); if (a.beforeRev != null) qs.set('beforeRev', String(a.beforeRev)); return pretty(await workerGet(`/mission/workflows/${encodeURIComponent(id)}/history${qs.toString() ? `?${qs}` : ''}`)); } catch (e) { return err((e as Error).message); } },
  mission_workflow_rollback: async (a) => { try { const id = String(a.id || ''); if (!id) return err('id is required'); return pretty(await workerPost(`/mission/workflows/${encodeURIComponent(id)}/rollback`, withActorHint(a, currentMcpContext()?.toolUseId))); } catch (e) { return err((e as Error).message); } },
};
```

Then wire expanded.ts (import + two spreads) and configure.ts TOOL_SCOPES (5 entries).

- [ ] **Step 4: Verify pass** + boot-assert safety: `node --test dist-test/__tests__/mission-workflow-mcp.test.js` and run the existing scopes test if present (`ls dist-test/__tests__ | grep -i scope`).
- [ ] **Step 5: Commit** — `git commit -m "feat(workflow): mission_workflow_* MCP tools (list/get/set/history/rollback)"`

---

### Task 6: Render points — supervisor pass directive, seeding, system-prompt pointer

**Files:**
- Modify: `core/src/mission/mission-controller.ts`
- Test: `core/src/__tests__/mission-controller-directive.test.ts`

**Interfaces:**
- Consumes: `renderWorkflow`, `seedDefaultWorkflows` (Task 3).
- Produces: `SupervisorDeps.passDirective?: () => Promise<string>` (optional dep; production wired).

- [ ] **Step 1: Failing test**

```ts
// core/src/__tests__/mission-controller-directive.test.ts
import { test } from 'node:test';
import assert from 'node:assert';
import { runSupervisorTick, CONTROLLER_PASS_DIRECTIVE, CONTROLLER_SYSTEM_PROMPT, type SupervisorDeps } from '../mission/mission-controller';

function baseDeps(overrides: Partial<SupervisorDeps>): SupervisorDeps {
  const cs = { node: 'n1', sessionId: 'uuid-1', cse: null, tmux: 't', startedAt: 1, lastDriveAt: undefined } as any;
  return {
    amMonitor: async () => ({ isMonitor: true, monitorNodeId: 'n1' }),
    getControllerSession: async () => cs,
    putControllerSession: async () => {},
    isLive: () => true,
    launch: async () => cs,
    drive: async () => {},
    teardown: async () => {},
    driveIntervalMin: 5,
    now: 10 * 60_000,
    ...overrides,
  } as SupervisorDeps;
}

test('drive uses the injected passDirective render', async () => {
  let sent = '';
  const deps = baseDeps({
    drive: async (_cs, directive) => { sent = directive ?? ''; },
    passDirective: async () => 'RENDERED-PASS',
  });
  const r = await runSupervisorTick(deps);
  assert.equal(r.action, 'drive');
  assert.equal(sent, 'RENDERED-PASS');
});

test('passDirective failure falls back to the TS const', async () => {
  let sent = '';
  const deps = baseDeps({
    drive: async (_cs, directive) => { sent = directive ?? ''; },
    passDirective: async () => { throw new Error('registry down'); },
  });
  await runSupervisorTick(deps);
  assert.equal(sent, CONTROLLER_PASS_DIRECTIVE);
});

test('roster-change still overrides with the roster directive', async () => {
  // engagement deps present, roster changed → CONTROLLER_ROSTER_CHANGED_DIRECTIVE regardless of passDirective
  let sent = '';
  const deps = baseDeps({
    drive: async (_cs, directive) => { sent = directive ?? ''; },
    passDirective: async () => 'RENDERED-PASS',
    listActiveForEngage: async () => [],
    readSignal: async () => ({ alive: true, gated: false, cursor: 0, newLines: [] }),
    getEngagement: async () => ({ lastEngagedAt: 1, lastActiveIds: [], seen: {}, lastRosterKey: 'old' }),
    putEngagement: async () => {},
    rosterKey: async () => 'new',
  });
  await runSupervisorTick(deps);
  assert.ok(sent.startsWith('⟦CLUSTER ROSTER CHANGED⟧'));
});

test('system prompt points at the workflow registry', () => {
  assert.ok(CONTROLLER_SYSTEM_PROMPT.includes('mission_workflow_get'));
  assert.ok(CONTROLLER_SYSTEM_PROMPT.includes('workflow registry') || CONTROLLER_SYSTEM_PROMPT.includes('mission-workflows'));
});
```

- [ ] **Step 2: Verify failure** (passDirective unknown → tsc error).
- [ ] **Step 3: Implement:**

1. `SupervisorDeps` — add after `selfId?`:
```ts
  /** Render the standard pass directive from the workflow registry ('controller.pass').
   *  Optional; absent or throwing → CONTROLLER_PASS_DIRECTIVE (TS fallback). */
  passDirective?: () => Promise<string>;
```
2. In `runSupervisorTick` replace line 825 `let directive = CONTROLLER_PASS_DIRECTIVE;` with:
```ts
  let directive = CONTROLLER_PASS_DIRECTIVE;
  if (deps.passDirective) {
    try { directive = await deps.passDirective(); } catch { /* registry unavailable → TS fallback */ }
  }
```
(the roster-change branch below it overwrites `directive` — unchanged, satisfies test 3).
3. `CONTROLLER_PASS_DIRECTIVE` — replace the literal with a re-export of the single source (avoids drift): at the top of mission-controller.ts `import { DEFAULT_WORKFLOWS } from './workflow-defaults';` and change the const to:
```ts
export const CONTROLLER_PASS_DIRECTIVE = DEFAULT_WORKFLOWS['controller.pass'].body;
```
(The Task 2 body = old text + onboarded addendum, so the fallback directive now includes onboarded handling too — intended.)
4. Production wiring in `registerMissionController`'s `realDeps` (where `drive:`/`launch:` are defined, ~line 1052): add
```ts
      passDirective: async () => {
        const { renderWorkflow } = require('./workflow-store') as typeof import('./workflow-store');
        return renderWorkflow('controller.pass');
      },
```
5. Seeding — in the production `launch` impl, immediately AFTER the `const cs: ControllerSession = {...}` object is built and BEFORE `return cs;` (~line 1050):
```ts
        try {
          const { seedDefaultWorkflows } = require('./workflow-store') as typeof import('./workflow-store');
          const n = await seedDefaultWorkflows();
          if (n > 0) console.log(`[mission-controller] seeded ${n} default workflow docs`);
        } catch { /* best-effort — defaults render as fallback anyway */ }
```
6. `CONTROLLER_SYSTEM_PROMPT` — append a new paragraph before the final `'The user may message you directly…'` block:
```ts
  '',
  'PROCESS DOCS: your operating processes live in the workflow registry (fleet-synced,',
  'human-editable). The pass directive names which doc to fetch for a mission —',
  'mission_workflow_get(id) returns the rendered text to FOLLOW. You may improve an',
  '"open" doc via mission_workflow_set when experience warrants it, but ANNOUNCE every',
  'self-edit in chat with a one-line rationale; humans can inspect and roll back any',
  'edit (mission_workflow_history / mission_workflow_rollback).',
```

- [ ] **Step 4: Verify** — new test file passes AND the full mission surface stays green:
`node --test dist-test/__tests__/mission-controller-directive.test.js && node --test dist-test/__tests__/mission*.test.js 2>&1 | tail -5`
Expected: 0 fail (the pass-directive const now includes the addendum — if an existing test asserts the exact old directive string, update THAT assertion to `assert.ok(CONTROLLER_PASS_DIRECTIVE.startsWith('Run a controller pass now.'))`).

- [ ] **Step 5: Commit** — `git commit -m "feat(workflow): controller pass directive renders from registry; leader seeds defaults; system-prompt pointer"`

---

## Phase 2 — Session Onboarding

### Task 7: Model + pure onboarding helpers

**Files:**
- Modify: `core/src/mission/mission-model.ts` (Mission fields, ExecutorKind)
- Modify: `core/src/mission/mission-history.ts` (TRACKED_FIELDS)
- Modify: `core/src/mission/mission-scheduler.ts` (skip onboarded)
- Create: `core/src/mission/mission-onboard.ts`
- Test: `core/src/__tests__/mission-onboard-model.test.ts`

**Interfaces (produces):**
- `mission-model.ts`: `export type ExecutorKind = 'orchestrator' | 'worker' | 'onboarded';`; `Mission` gains `origin?: 'onboarded'; manageMode?: ManageMode;` with `export type ManageMode = 'handoff' | 'standby';`
- `mission-history.ts`: `TRACKED_FIELDS` gains `'manageMode'`.
- `mission-onboard.ts`:
  - `MISSION_CONTROL_MARKER = '⟦MISSION-CONTROL⟧'`
  - `markDriveText(text: string): string` (prefix + space unless already prefixed)
  - `isOnboarded(m: Mission): boolean`
  - `onboardTitle(sid: string): string` → `` `Onboarded: ${sid.slice(0, 12)}…` ``
  - `detectTransport(sid: string): 'cloud' | 'native'` (`/^(cse_|session_)/`)
  - `buildOnboardMission(input: { sid: string; node: string; transport: 'cloud'|'native'; mode: ManageMode; note?: string; crossCluster: boolean; ownerNode: string; createdBy: MissionActor }, now: number, genId: () => string): Mission`
  - `pickClusterLeader(cluster: string, records: Array<{gatewayId: string; cluster: string}>, online: string[]): string | null` (lowest gatewayId, lexicographic, in that cluster AND online; unassigned records count as cluster 'default')
  - `detectHumanActivity(msgs: Array<{ role: string; text: string }>): boolean` — true when any `role === 'user'` message has non-empty plain text that does NOT start with `MISSION_CONTROL_MARKER`, `<system` (harness injections), `[{` (raw tool_result arrays), or `Run a controller pass` (supervisor directives).

- [ ] **Step 1: Failing test**

```ts
// core/src/__tests__/mission-onboard-model.test.ts
import { test } from 'node:test';
import assert from 'node:assert';
import { MISSION_CONTROL_MARKER, markDriveText, isOnboarded, onboardTitle, detectTransport, buildOnboardMission, pickClusterLeader, detectHumanActivity } from '../mission/mission-onboard';
import { TRACKED_FIELDS } from '../mission/mission-history';
import { computeSchedule } from '../mission/mission-scheduler';
import { newMission, type MissionActor } from '../mission/mission-model';

const who: MissionActor = { kind: 'user', channel: 'mcp', at: 1 };

test('marker + markDriveText idempotent', () => {
  assert.equal(markDriveText('do X'), `${MISSION_CONTROL_MARKER} do X`);
  assert.equal(markDriveText(`${MISSION_CONTROL_MARKER} do X`), `${MISSION_CONTROL_MARKER} do X`);
});

test('transport + title', () => {
  assert.equal(detectTransport('session_abc'), 'cloud');
  assert.equal(detectTransport('cse_abc'), 'cloud');
  assert.equal(detectTransport('0a1b2c3d-e4f5-6789-abcd-ef0123456789'), 'native');
  assert.ok(onboardTitle('0a1b2c3d-e4f5-6789').startsWith('Onboarded: '));
});

test('buildOnboardMission shape', () => {
  const m = buildOnboardMission({ sid: 'u-1', node: 'gw4-aaa', transport: 'native', mode: 'standby', note: 'finish tonight', crossCluster: true, ownerNode: 'gw4-bbb', createdBy: who }, 1000, () => 'mission_test1');
  assert.equal(m.origin, 'onboarded');
  assert.equal(m.manageMode, 'standby');
  assert.equal(m.status, 'active');
  assert.deepEqual(m.binding, { sessionId: 'u-1', node: 'gw4-aaa', kind: 'onboarded', boundAt: 1000 });
  assert.deepEqual(m.tags['onboard:state'], ['analyzing']);
  assert.deepEqual(m.tags['onboard:cross-cluster'], ['true']);
  assert.equal(m.nextSteps![0], 'Human note: finish tonight');
  assert.equal(isOnboarded(m), true);
});

test('manageMode is history-tracked', () => {
  assert.ok((TRACKED_FIELDS as readonly string[]).includes('manageMode'));
});

test('computeSchedule never readies an onboarded mission', () => {
  const m = buildOnboardMission({ sid: 'u-1', node: 'n', transport: 'native', mode: 'handoff', crossCluster: false, ownerNode: 'n', createdBy: who }, 1, () => 'mission_ob1');
  (m as any).status = 'waiting'; // even if someone flips it to a schedulable status
  const plain = newMission({ title: 't', objective: 'o', ownerNode: 'n', createdBy: who }, 1, () => 'mission_pl1');
  (plain as any).status = 'draft';
  const s = computeSchedule([m, plain]);
  assert.ok(!s.ready.includes('mission_ob1'));
  assert.ok(!s.blocked.some((b) => b.id === 'mission_ob1'));
  assert.ok(s.ready.includes('mission_pl1'));
});

test('pickClusterLeader lowest online in-cluster gatewayId', () => {
  const records = [
    { gatewayId: 'gw4-b', cluster: 'staging' }, { gatewayId: 'gw4-a', cluster: 'staging' },
    { gatewayId: 'gw4-c', cluster: 'prod' },
  ];
  assert.equal(pickClusterLeader('staging', records, ['gw4-a', 'gw4-b', 'gw4-c']), 'gw4-a');
  assert.equal(pickClusterLeader('staging', records, ['gw4-b']), 'gw4-b');
  assert.equal(pickClusterLeader('staging', records, ['gw4-c']), null);
  assert.equal(pickClusterLeader('nope', records, ['gw4-a']), null);
});

test('detectHumanActivity filters non-human user-role content', () => {
  assert.equal(detectHumanActivity([{ role: 'user', text: 'please also add tests' }]), true);
  assert.equal(detectHumanActivity([{ role: 'user', text: `${MISSION_CONTROL_MARKER} continue` }]), false);
  assert.equal(detectHumanActivity([{ role: 'user', text: '<system-reminder>x</system-reminder>' }]), false);
  assert.equal(detectHumanActivity([{ role: 'user', text: '[{"tool_use_id":"t1","content":"ok"}]' }]), false);
  assert.equal(detectHumanActivity([{ role: 'assistant', text: 'thinking' }]), false);
  assert.equal(detectHumanActivity([{ role: 'user', text: 'Run a controller pass now.' }]), false);
  assert.equal(detectHumanActivity([]), false);
});
```

- [ ] **Step 2: Verify failure.**
- [ ] **Step 3: Implement.**

`mission-model.ts` diffs:
```ts
export type ExecutorKind = 'orchestrator' | 'worker' | 'onboarded';
export type ManageMode = 'handoff' | 'standby';
// Mission interface — after `interim?`:
  /** 'onboarded' = an EXISTING user session adopted into mission control (spec 2026-07-14). */
  origin?: 'onboarded';
  /** Onboarded-only: handoff = controller drives; standby = observe-only. Human-switched. */
  manageMode?: ManageMode;
```
`mission-history.ts`: `export const TRACKED_FIELDS = [ 'title', 'objective', 'plan', 'nextSteps', 'projects', 'tags', 'parentId', 'dependsOn', 'status', 'env', 'manageMode' ] as const;`

`mission-scheduler.ts` — in the ready/blocked loop, FIRST line inside `for (const m of missions) {`:
```ts
    if (m.origin === 'onboarded') continue;     // already bound to its session — never spawn-ready
```

`mission-onboard.ts` (new, full):
```ts
/** Pure helpers for onboarding EXISTING sessions into mission control. No IO. */
import { Mission, MissionActor, ManageMode, newMission } from './mission-model';

export const MISSION_CONTROL_MARKER = '⟦MISSION-CONTROL⟧';

export function markDriveText(text: string): string {
  return text.startsWith(MISSION_CONTROL_MARKER) ? text : `${MISSION_CONTROL_MARKER} ${text}`;
}

export function isOnboarded(m: Pick<Mission, 'origin'>): boolean { return m.origin === 'onboarded'; }

export function onboardTitle(sid: string): string { return `Onboarded: ${sid.slice(0, 12)}…`; }

const CLOUD_RE = /^(cse_|session_)/;
export function detectTransport(sid: string): 'cloud' | 'native' { return CLOUD_RE.test(sid) ? 'cloud' : 'native'; }

export function buildOnboardMission(
  input: { sid: string; node: string; transport: 'cloud' | 'native'; mode: ManageMode; note?: string; crossCluster: boolean; ownerNode: string; createdBy: MissionActor },
  now: number,
  genId: () => string,
): Mission {
  const m = newMission({
    title: onboardTitle(input.sid),
    objective: `Manage the onboarded session ${input.sid} (analysis pending — see onboard.analyze).`,
    ownerNode: input.ownerNode,
    createdBy: input.createdBy,
    tags: {
      'onboard:state': ['analyzing'],
      ...(input.crossCluster ? { 'onboard:cross-cluster': ['true'] } : {}),
    },
    nextSteps: input.note ? [`Human note: ${input.note}`] : undefined,
    env: { isolation: 'shared', host: input.node === 'cloud' ? undefined : input.node, resources: [] },
  }, now, genId);
  m.origin = 'onboarded';
  m.manageMode = input.mode;
  m.binding = { sessionId: input.sid, node: input.node, kind: 'onboarded', boundAt: now };
  return m;
}

/** Lowest online gatewayId belonging to `cluster` (records with no cluster count as 'default'). */
export function pickClusterLeader(
  cluster: string,
  records: Array<{ gatewayId: string; cluster?: string | null }>,
  online: string[],
): string | null {
  const onlineSet = new Set(online);
  const members = records
    .filter((r) => (r.cluster ?? 'default') === cluster && onlineSet.has(r.gatewayId))
    .map((r) => r.gatewayId)
    .sort();
  return members[0] ?? null;
}

/** True when any NEW user-role message is a plain human prompt (not our marker, not harness/tooling noise). */
export function detectHumanActivity(msgs: Array<{ role: string; text: string }>): boolean {
  for (const m of msgs) {
    if (m.role !== 'user') continue;
    const t = (m.text || '').trim();
    if (!t) continue;
    if (t.startsWith(MISSION_CONTROL_MARKER)) continue;
    if (t.startsWith('<system')) continue;          // <system-reminder> harness injections
    if (t.startsWith('[{')) continue;               // serialized tool_result arrays
    if (t.startsWith('Run a controller pass')) continue; // supervisor directives (controller session)
    return true;
  }
  return false;
}
```

- [ ] **Step 4: Verify pass** + whole mission suite still green (`node --test dist-test/__tests__/mission*.test.js 2>&1 | tail -5`).
- [ ] **Step 5: Commit** — `git commit -m "feat(onboard): mission model origin/manageMode, scheduler exclusion, pure onboarding helpers"`

---

### Task 8: `POST /mission/onboard` — the onboarding rail

**Files:**
- Modify: `core/src/routes/core/mission.routes.ts`
- Test: `core/src/__tests__/mission-onboard-route.test.ts`

**Interfaces:**
- Consumes: Task 7 helpers; `anchorToLeader`/`realLeaderAnchor`; `getClusterRecords` (already imported), `getMyCluster` (already imported), `listAllOnlineNodeIds` from `../../data/peer-client` (line 195 — the UNSCOPED online list; `listOnlineNodeIds` is cluster-scoped, wrong here), `proxyPost` (peer-client), `sessionVerdict` from `../../terminal/cc-sessions`.
- Produces: `handleOnboard(b, deps): Promise<Envelope>` with
```ts
export interface OnboardDeps {
  port?: MissionDataPort;
  actor?: MissionActor;
  leader?: LeaderAnchorDeps;                       // own-cluster anchoring
  clusterRecords?: () => Promise<Array<{ gatewayId: string; cluster?: string | null }>>;
  myCluster?: () => string;
  onlineNodes?: () => Promise<string[]>;
  proxyPost?: (node: string, path: string, body: unknown) => Promise<unknown>;
  /** Local native session existence check; consulted only when the session node === thisNode(). */
  nativeExists?: (sid: string) => boolean;
  selfNode?: () => string;
}
```

**Body contract:** `{ sessionId?, cluster?, mode?, note?, node? , _actor? }`. Response `ok({ mission, existing: boolean, cluster, leaderNode })`.

- [ ] **Step 1: Failing test**

```ts
// core/src/__tests__/mission-onboard-route.test.ts
import { test } from 'node:test';
import assert from 'node:assert';
import { handleOnboard } from '../routes/core/mission.routes';
import type { Mission, MissionActor } from '../mission/mission-model';
import type { MissionDataPort } from '../mission/mission-store';

function memPort(): MissionDataPort & { docs: Map<string, Mission> } {
  const docs = new Map<string, Mission>();
  return {
    docs,
    isEnabled: () => true,
    get: async (id) => docs.get(id) ?? null,
    list: async () => [...docs.values()],
    put: async (m) => { docs.set(m.id, m); },
    del: async (id) => { docs.delete(id); },
  };
}
const user: MissionActor = { kind: 'user', channel: 'mcp', at: 1 };
const localSession: MissionActor = { kind: 'local-session', id: 'caller-uuid-1', channel: 'mcp', at: 1 };
const ctrl: MissionActor = { kind: 'controller', channel: 'controller', at: 1 };

function deps(port: MissionDataPort, over: Record<string, unknown> = {}) {
  return {
    port, actor: user,
    clusterRecords: async () => [{ gatewayId: 'gw4-self', cluster: 'staging' }, { gatewayId: 'gw4-other', cluster: 'prod' }],
    myCluster: () => 'staging',
    onlineNodes: async () => ['gw4-self', 'gw4-other'],
    proxyPost: async () => { throw new Error('no proxy expected'); },
    nativeExists: () => true,
    selfNode: () => 'gw4-self',
    ...over,
  } as any;
}

test('explicit sessionId onboards with defaults (standby, own cluster)', async () => {
  const port = memPort();
  const r = await handleOnboard({ sessionId: 'uuid-x' }, deps(port));
  assert.equal(r.success, true);
  const m = (r.data as any).mission as Mission;
  assert.equal(m.origin, 'onboarded');
  assert.equal(m.manageMode, 'standby');
  assert.equal(m.binding!.sessionId, 'uuid-x');
  assert.equal(m.binding!.node, 'gw4-self');
  assert.deepEqual(m.tags['onboard:state'], ['analyzing']);
});

test('self-onboard resolves sid from a precise local-session actor; coarse actor errors', async () => {
  const port = memPort();
  const ok1 = await handleOnboard({}, deps(port, { actor: localSession }));
  assert.equal(ok1.success, true);
  assert.equal(((ok1.data as any).mission as Mission).binding!.sessionId, 'caller-uuid-1');
  const bad = await handleOnboard({}, deps(memPort(), { actor: user }));
  assert.equal(bad.success, false);
  assert.equal(bad.error!.code, 'INVALID_INPUT');
});

test('idempotent per session (non-terminal)', async () => {
  const port = memPort();
  const a = await handleOnboard({ sessionId: 'uuid-x' }, deps(port));
  const b = await handleOnboard({ sessionId: 'uuid-x', mode: 'handoff' }, deps(port));
  assert.equal(b.success, true);
  assert.equal((b.data as any).existing, true);
  assert.equal((b.data as any).mission.id, (a.data as any).mission.id);
  assert.equal((b.data as any).mission.manageMode, 'standby', 'existing mission returned unchanged');
});

test('mode validation + cloud transport node', async () => {
  const port = memPort();
  const bad = await handleOnboard({ sessionId: 'uuid-x', mode: 'auto' }, deps(port));
  assert.equal(bad.error!.code, 'INVALID_INPUT');
  const cloud = await handleOnboard({ sessionId: 'session_abc', mode: 'handoff' }, deps(port));
  assert.equal((cloud.data as any).mission.binding.node, 'cloud');
});

test('missing native session on own node → SESSION_NOT_FOUND', async () => {
  const r = await handleOnboard({ sessionId: 'uuid-x' }, deps(memPort(), { nativeExists: () => false }));
  assert.equal(r.error!.code, 'SESSION_NOT_FOUND');
});

test('cross-cluster target proxies to that cluster leader (fail-closed)', async () => {
  const port = memPort();
  let proxied: { node: string; path: string; body: any } | null = null;
  const r = await handleOnboard({ sessionId: 'uuid-x', cluster: 'prod' }, deps(port, {
    proxyPost: async (node: string, path: string, body: any) => { proxied = { node, path, body }; return { success: true, data: { mission: { id: 'mission_remote' } } }; },
  }));
  assert.equal(r.success, true);
  assert.equal(proxied!.node, 'gw4-other');
  assert.equal(proxied!.path, '/mission/onboard');
  assert.equal(proxied!.body.node, 'gw4-self', 'origin node stamped BEFORE proxying');
  const down = await handleOnboard({ sessionId: 'uuid-x', cluster: 'prod' }, deps(memPort(), {
    onlineNodes: async () => ['gw4-self'],
  }));
  assert.equal(down.error!.code, 'LEADER_UNREACHABLE');
});

test('cross-cluster session tagged', async () => {
  const port = memPort();
  // session node gw4-self is in staging; target staging→ no tag; but a node in prod with target staging → tag
  const r = await handleOnboard({ sessionId: 'uuid-x', node: 'gw4-other' }, deps(port, { nativeExists: () => { throw new Error('must not check non-self node'); } }));
  assert.equal(r.success, true);
  assert.deepEqual((r.data as any).mission.tags['onboard:cross-cluster'], ['true']);
});
```

- [ ] **Step 2: Verify failure.**
- [ ] **Step 3: Implement** in mission.routes.ts (after `handleWorkflowRollback`; imports: `buildOnboardMission, detectTransport, pickClusterLeader` from `../../mission/mission-onboard`):

```ts
export interface OnboardDeps { /* as in Interfaces above */ }

export async function handleOnboard(b: Record<string, unknown>, d: OnboardDeps = {}): Promise<Envelope> {
  const self = d.selfNode ? d.selfNode() : thisNode();
  const who = d.actor ?? await actorFor(b);

  // 1) resolve session id: explicit, else the caller's own (precise local-session actor).
  const sid = str(b.sessionId) ?? (who.kind === 'local-session' && who.id ? who.id : undefined);
  if (!sid) return fail('INVALID_INPUT', 'sessionId required — the caller session could not be resolved; pass sessionId explicitly');

  // 2) mode + note
  const modeRaw = str(b.mode) ?? 'standby';
  if (modeRaw !== 'handoff' && modeRaw !== 'standby') return fail('INVALID_INPUT', 'mode must be handoff|standby');
  const note = str(b.note);

  // 3) transport + session node. Stamp the ORIGIN node before any proxy hop so the
  //    target-cluster leader binds the right node (the session lives where the call started).
  const transport = detectTransport(sid);
  const sessionNode = transport === 'cloud' ? 'cloud' : (str(b.node) ?? self);
  if (transport === 'native' && !str(b.node)) b.node = sessionNode;

  // 4) local existence check — only meaningful for a native session on THIS node.
  if (transport === 'native' && sessionNode === self) {
    const exists = d.nativeExists ?? ((s: string) => {
      const { sessionVerdict } = require('../../terminal/cc-sessions') as typeof import('../../terminal/cc-sessions');
      const v = sessionVerdict(s);
      return v.connectStrategy !== 'none' || v.inTmux; // any transcript or live process counts
    });
    try { if (!exists(sid)) return fail('SESSION_NOT_FOUND', `no local session ${sid}`); }
    catch { /* verdict failure — proceed; reads will surface it */ }
  }

  // 5) cluster targeting
  const records = await (d.clusterRecords ?? getClusterRecords)();
  const myClusterName = (d.myCluster ?? getMyCluster)();
  const target = str(b.cluster) ?? myClusterName;
  if (target === myClusterName) {
    const anchored = await anchorToLeader(d.leader, 'POST', '/mission/onboard', b, true);
    if (anchored) return anchored;
  } else {
    const online = await (d.onlineNodes ?? (() => {
      const { listAllOnlineNodeIds } = require('../../data/peer-client') as typeof import('../../data/peer-client');
      return listAllOnlineNodeIds();
    }))();
    const leaderNode = pickClusterLeader(target, records as any, online);
    if (!leaderNode) return fail('LEADER_UNREACHABLE', `no online node in cluster "${target}"`);
    if (leaderNode !== self) {
      const pp = d.proxyPost ?? ((n: string, p: string, body: unknown) => {
        const { proxyPost } = require('../../data/peer-client') as typeof import('../../data/peer-client');
        return proxyPost(n, p, body);
      });
      try { return proxyEnvelope(await pp(leaderNode, '/mission/onboard', b)); }
      catch (e) { return fail('LEADER_UNREACHABLE', `cluster "${target}" leader unreachable: ${(e as Error).message}`); }
    }
  }

  // 6) local execution (we are the target-cluster leader, or anchoring found us local)
  const all = await listMissions(d.port);
  const existing = all.find((m) => m.origin === 'onboarded' && m.binding?.sessionId === sid && m.status !== 'done' && m.status !== 'failed');
  if (existing) return ok({ mission: existing, existing: true, cluster: target, leaderNode: self });

  const sessionCluster = (records as Array<{ gatewayId: string; cluster?: string | null }>).find((r) => r.gatewayId === sessionNode)?.cluster ?? 'default';
  const crossCluster = transport === 'native' && sessionCluster !== target;
  const m = buildOnboardMission(
    { sid, node: sessionNode, transport, mode: modeRaw, note, crossCluster, ownerNode: self, createdBy: who },
    Date.now(), genId,
  );
  await putMission(m, d.port, { actor: who });
  return ok({ mission: m, existing: false, cluster: target, leaderNode: self });
}
```

Registration — with the other `/mission` literals, directly after the workflow block from Task 4:
```ts
    { method: 'POST', pattern: /^\/mission\/onboard$/, handler: async (req) => handleOnboard((req.body || {}) as Record<string, unknown>, { leader: realLeaderAnchor() }) },
```

- [ ] **Step 4: Verify pass** — `node --test dist-test/__tests__/mission-onboard-route.test.js`.
- [ ] **Step 5: Commit** — `git commit -m "feat(onboard): POST /mission/onboard — self/explicit, cluster-targeted, idempotent"`

---

### Task 9: Mode rails — standby rejection, marker, human-only mode switch, reaper exclusion

**Files:**
- Modify: `core/src/routes/core/mission.routes.ts` (`SessionOpsDeps`, `handleSessionDrive`, `handlePatch`, `handleSessionResume`)
- Modify: `core/src/mission/mission-store.ts` (`findMissionBySessionOrCcr`)
- Test: `core/src/__tests__/mission-onboard-rails.test.ts`

**Interfaces:**
- `mission-store.ts` adds:
```ts
export async function findMissionBySessionOrCcr(sid: string, port: MissionDataPort = defaultPort()): Promise<Mission | null> {
  return (await port.list()).find((m) => !RESERVED_IDS.has(m.id) && (m.binding?.sessionId === sid || m.binding?.ccr?.sid === sid)) ?? null;
}
```
- `SessionOpsDeps` gains `findMission?: (sid: string) => Promise<Mission | null>;` — default impl in `defaultSessionOpsDeps()`:
```ts
    findMission: async (sid) => {
      const { findMissionBySessionOrCcr } = require('../../mission/mission-store') as typeof import('../../mission/mission-store');
      return findMissionBySessionOrCcr(sid);
    },
```

**Behavior changes:**
1. `handleSessionDrive` — in the LOCAL branch (after the cross-node proxy short-circuit, before transport dispatch):
```ts
  let driveText = text;
  if (d.findMission) {
    try {
      const m = await d.findMission(sid);
      if (m?.origin === 'onboarded') {
        if (m.manageMode === 'standby') return fail('STANDBY_MODE', 'mission is standby — the human runs this session; switch manageMode to handoff to drive');
        driveText = markDriveText(text);
      }
    } catch { /* best-effort — never block a normal drive on a store hiccup */ }
  }
```
(use `driveText` in both cloudDrive/nativeDrive calls; import `markDriveText` from `../../mission/mission-onboard`.)
2. `handlePatch` — after the `status` block (`if (sv) {...}`), add:
```ts
  if (b.manageMode !== undefined) {
    const mm = str(b.manageMode);
    if (m.origin !== 'onboarded') return fail('INVALID_INPUT', 'manageMode applies only to onboarded missions');
    if (mm !== 'handoff' && mm !== 'standby') return fail('INVALID_INPUT', 'manageMode must be handoff|standby');
    if (isControllerActor(who)) return fail('FORBIDDEN', 'manageMode is human-only — ask the user to switch it');
    m.manageMode = mm;
  }
```
(`isControllerActor` already imported in Task 4.)
3. `handleSessionResume` — replace the unconditional tracking block with an onboarded guard:
```ts
  if (result.transport === 'native' && result.resumed && result.reason === 'ok') {
    const now = Date.now();
    let onboarded = false;
    try {
      const { getMission: gm } = require('../../mission/mission-store') as typeof import('../../mission/mission-store');
      const m = body.missionId ? await gm(body.missionId) : null;
      onboarded = m?.origin === 'onboarded';
    } catch { /* best-effort */ }
    if (onboarded) return ok(result);                       // user session: never enrolled for auto-close
    const autoCloseAt = now + d.idleMin * 60_000;
    try { trackResumedNative(result.sid, body.missionId, now); } catch { /* best-effort */ }
    return ok({ ...result, autoCloseAt });
  }
```

- [ ] **Step 1: Failing test**

```ts
// core/src/__tests__/mission-onboard-rails.test.ts
import { test } from 'node:test';
import assert from 'node:assert';
import { handleSessionDrive, handlePatch } from '../routes/core/mission.routes';
import { buildOnboardMission, MISSION_CONTROL_MARKER } from '../mission/mission-onboard';
import type { MissionActor, Mission } from '../mission/mission-model';

const user: MissionActor = { kind: 'user', channel: 'mcp', at: 1 };
const ctrl: MissionActor = { kind: 'controller', channel: 'controller', at: 1 };

function onboarded(mode: 'handoff' | 'standby'): Mission {
  return buildOnboardMission({ sid: 'uuid-1', node: 'n1', transport: 'native', mode, crossCluster: false, ownerNode: 'n1', createdBy: user }, 1, () => 'mission_ob');
}

function driveDeps(m: Mission | null) {
  const sent: string[] = [];
  const deps = {
    resolve: () => ({ sid: 'uuid-1', transport: 'native' as const, missionId: m?.id ?? null, role: 'worker' as const }),
    cloudRead: async () => ({ messages: [] }),
    cloudDrive: async () => ({ delivered: true }),
    cloudStop: async () => ({ stopped: true }),
    nativeRead: async () => ({ messages: [] }),
    nativeRawMessages: async () => [],
    nativeDrive: async (_sid: string, text: string) => { sent.push(text); },
    nativeInterrupt: async () => {},
    nativeStop: async () => {},
    clearController: async () => {},
    getControllerSession: async () => null,
    findMission: async () => m,
  } as any;
  return { deps, sent };
}

test('standby drive rejected at the route', async () => {
  const { deps } = driveDeps(onboarded('standby'));
  const r = await handleSessionDrive('uuid-1', 'do things', deps);
  assert.equal(r.success, false);
  assert.equal(r.error!.code, 'STANDBY_MODE');
});

test('handoff drive is marker-prefixed exactly once', async () => {
  const { deps, sent } = driveDeps(onboarded('handoff'));
  await handleSessionDrive('uuid-1', 'do things', deps);
  await handleSessionDrive('uuid-1', `${MISSION_CONTROL_MARKER} again`, deps);
  assert.equal(sent[0], `${MISSION_CONTROL_MARKER} do things`);
  assert.equal(sent[1], `${MISSION_CONTROL_MARKER} again`);
});

test('non-onboarded drive untouched', async () => {
  const { deps, sent } = driveDeps(null);
  await handleSessionDrive('uuid-1', 'plain', deps);
  assert.equal(sent[0], 'plain');
});

test('manageMode patch: human ok, controller forbidden, non-onboarded invalid', async () => {
  const m = onboarded('standby');
  const port = { isEnabled: () => true, get: async () => m, list: async () => [m], put: async (x: Mission) => { Object.assign(m, x); }, del: async () => {} } as any;
  const okFlip = await handlePatch(m.id, { manageMode: 'handoff' }, port, user);
  assert.equal(okFlip.success, true);
  assert.equal((okFlip.data as any).manageMode, 'handoff');
  const denied = await handlePatch(m.id, { manageMode: 'standby' }, port, ctrl);
  assert.equal(denied.success, false);
  assert.equal(denied.error!.code, 'FORBIDDEN');
  const plainPort = { isEnabled: () => true, get: async () => ({ ...m, origin: undefined }), list: async () => [], put: async () => {}, del: async () => {} } as any;
  const invalid = await handlePatch(m.id, { manageMode: 'handoff' }, plainPort, user);
  assert.equal(invalid.error!.code, 'INVALID_INPUT');
});
```

- [ ] **Step 2: Verify failure.** — `findMission` unknown on deps type → tsc error.
- [ ] **Step 3: Implement** per the Behavior changes above.
- [ ] **Step 4: Verify pass** + whole mission suite green.
- [ ] **Step 5: Commit** — `git commit -m "feat(onboard): mode rails — standby drive rejection, marker prefix, human-only mode switch, reaper exclusion"`

---

### Task 10: Supervisor integration — onboarded signals, cross-node reads, human-activity engagement

**Files:**
- Modify: `core/src/mission/mission-controller.ts`
- Modify: `core/src/mission/mission-engagement.ts` (marker constant reuse only — see below; classifier unchanged)
- Test: `core/src/__tests__/mission-onboard-signal.test.ts`

**Interfaces:**
- Produces in mission-controller.ts:
```ts
export interface OnboardedReadDeps {
  selfNode: () => string;
  /** Local role-aware native read (AgentSessionStore). */
  readLocalConversation: (sid: string) => Promise<{ messages: Array<{ role: string; text: string }> }>;
  /** Local native liveness. */
  verdict: (sid: string) => { driveable: boolean };
  /** Cross-node read via the session ops proxy (POST /mission/session/:sid/read on the session's node). */
  proxyRead: (node: string, sid: string) => Promise<{ messages: Array<{ role: string; text: string }> }>;
  /** Cross-node liveness (POST /mission/session/:sid/status on the session's node). */
  proxyStatus: (node: string, sid: string) => Promise<{ alive: boolean }>;
}
export async function readOnboardedSignal(m: Mission, deps: OnboardedReadDeps): Promise<ExecNow & { humanActive: boolean }>;
```
- Behavior: cloud binding → delegate to existing `readCloudExecutor(m)` and map to ExecNow (humanActive=false — cloud CCRs are driven through claude.ai, human messages there DO carry through as user turns; detect with the same `detectHumanActivity` over new cloud messages when available: `readCloudExecutor` output messages are plain strings, so cloud humanActive stays false in v1 — note this as a documented v1 limit). Native local → verdict + `readLocalConversation`, cursor = messages.length, newLines = text of messages after `m.control.lastOutputCursor ?? 0`, humanActive = `detectHumanActivity(newMsgs)`. Native remote → `proxyStatus` + `proxyRead` same computation.
- Engagement wiring: in `registerMissionController`'s production `readSignal` dep (find where `readSignal: (m) => readExecutorSignal(m)` is wired — grep `readSignal:` in mission-controller.ts), replace with:
```ts
      readSignal: async (m) => {
        if (m.origin === 'onboarded') {
          const s = await readOnboardedSignal(m, defaultOnboardedReadDeps());
          if (s.humanActive) {
            // A human message is MATERIAL for the engagement classifier: inject a synthetic
            // status-marker line so classifyExecutorActivity fires without changing its API.
            return { ...s, newLines: ['⟦WORKER-STATUS⟧ human-activity', ...s.newLines] };
          }
          return s;
        }
        return readExecutorSignal(m);
      },
```
with `defaultOnboardedReadDeps()` building the real deps (AgentSessionStore like `readExecutorState`, `sessionVerdict`, and proxyRead/proxyStatus via `peer-client.proxyPost` to `/mission/session/:sid/read` / `/status` parsing the envelope `data`).
- Also: `listActiveForEngage` — verify it lists active missions incl. onboarded (it calls `listActiveMissions()`; onboarded missions are status 'active' → already included; NO change, but the test asserts it).

- [ ] **Step 1: Failing test**

```ts
// core/src/__tests__/mission-onboard-signal.test.ts
import { test } from 'node:test';
import assert from 'node:assert';
import { readOnboardedSignal, type OnboardedReadDeps } from '../mission/mission-controller';
import { buildOnboardMission, MISSION_CONTROL_MARKER } from '../mission/mission-onboard';
import type { MissionActor } from '../mission/mission-model';

const who: MissionActor = { kind: 'user', channel: 'mcp', at: 1 };
const msgs = (arr: Array<[string, string]>) => arr.map(([role, text]) => ({ role, text }));

function deps(over: Partial<OnboardedReadDeps> = {}): OnboardedReadDeps {
  return {
    selfNode: () => 'n1',
    readLocalConversation: async () => ({ messages: msgs([['user', 'start'], ['assistant', 'working']]) }),
    verdict: () => ({ driveable: true }),
    proxyRead: async () => { throw new Error('not expected'); },
    proxyStatus: async () => { throw new Error('not expected'); },
    ...over,
  };
}

test('local native: cursor advances, human plain prompt flags humanActive', async () => {
  const m = buildOnboardMission({ sid: 'u1', node: 'n1', transport: 'native', mode: 'handoff', crossCluster: false, ownerNode: 'n1', createdBy: who }, 1, () => 'mission_o1');
  m.control.lastOutputCursor = 1;
  const s = await readOnboardedSignal(m, deps({
    readLocalConversation: async () => ({ messages: msgs([['user', 'start'], ['user', 'please also handle errors']]) }),
  }));
  assert.equal(s.alive, true);
  assert.equal(s.cursor, 2);
  assert.deepEqual(s.newLines, ['please also handle errors']);
  assert.equal(s.humanActive, true);
});

test('marker-prefixed drives are NOT humanActive', async () => {
  const m = buildOnboardMission({ sid: 'u1', node: 'n1', transport: 'native', mode: 'handoff', crossCluster: false, ownerNode: 'n1', createdBy: who }, 1, () => 'mission_o2');
  const s = await readOnboardedSignal(m, deps({
    readLocalConversation: async () => ({ messages: msgs([[ 'user', `${MISSION_CONTROL_MARKER} continue`]]) }),
  }));
  assert.equal(s.humanActive, false);
});

test('remote native routes through proxyRead/proxyStatus', async () => {
  const m = buildOnboardMission({ sid: 'u1', node: 'n2', transport: 'native', mode: 'handoff', crossCluster: false, ownerNode: 'n1', createdBy: who }, 1, () => 'mission_o3');
  let readNode = ''; let statusNode = '';
  const s = await readOnboardedSignal(m, deps({
    proxyRead: async (node) => { readNode = node; return { messages: msgs([['user', 'hi from remote']]) }; },
    proxyStatus: async (node) => { statusNode = node; return { alive: true }; },
  }));
  assert.equal(readNode, 'n2');
  assert.equal(statusNode, 'n2');
  assert.equal(s.humanActive, true);
});

test('remote status/read failure degrades to alive (grace), no throw', async () => {
  const m = buildOnboardMission({ sid: 'u1', node: 'n2', transport: 'native', mode: 'standby', crossCluster: false, ownerNode: 'n1', createdBy: who }, 1, () => 'mission_o4');
  const s = await readOnboardedSignal(m, deps({
    proxyRead: async () => { throw new Error('net'); },
    proxyStatus: async () => { throw new Error('net'); },
  }));
  assert.equal(s.alive, true);
  assert.equal(s.cursor, 0);
  assert.equal(s.humanActive, false);
});
```

- [ ] **Step 2: Verify failure.**
- [ ] **Step 3: Implement** `readOnboardedSignal` + `defaultOnboardedReadDeps` + the `readSignal` wiring per Interfaces above:

```ts
// mission-controller.ts (imports: detectHumanActivity, isOnboarded from './mission-onboard')
export async function readOnboardedSignal(m: Mission, deps: OnboardedReadDeps): Promise<ExecNow & { humanActive: boolean }> {
  const sid = m.binding?.sessionId;
  if (!sid) return { alive: false, gated: false, cursor: 0, newLines: [], humanActive: false };
  if (m.binding?.node === 'cloud' || detectTransportSafe(sid) === 'cloud') {
    const st = await readCloudExecutor(m);
    return { alive: st.alive, gated: !!st.gate, cursor: st.newOutput?.cursor ?? (m.control.lastOutputCursor ?? 0), newLines: st.newOutput?.messages ?? [], humanActive: false };
  }
  const node = m.binding?.node;
  const local = !node || node === deps.selfNode();
  try {
    let alive: boolean; let messages: Array<{ role: string; text: string }>;
    if (local) {
      alive = deps.verdict(sid).driveable;
      messages = (await deps.readLocalConversation(sid)).messages;
    } else {
      alive = (await deps.proxyStatus(node!, sid)).alive;
      messages = (await deps.proxyRead(node!, sid)).messages;
    }
    const last = m.control.lastOutputCursor ?? 0;
    const fresh = messages.slice(last);
    return { alive, gated: false, cursor: messages.length, newLines: fresh.map((x) => x.text), humanActive: detectHumanActivity(fresh) };
  } catch {
    // transient (remote hop, fs): grace — alive, nothing new (mirrors handleSessionStatus's cloud grace)
    return { alive: true, gated: false, cursor: m.control.lastOutputCursor ?? 0, newLines: [], humanActive: false };
  }
}
function detectTransportSafe(sid: string): 'cloud' | 'native' {
  const { detectTransport } = require('./mission-onboard') as typeof import('./mission-onboard');
  return detectTransport(sid);
}
```

`defaultOnboardedReadDeps()` (module-level, near `readExecutorState`):
```ts
function defaultOnboardedReadDeps(): OnboardedReadDeps {
  return {
    selfNode: () => thisNode(),
    verdict: (sid) => { const v = sessionVerdict(sid); return { driveable: v.inTmux }; },
    readLocalConversation: async (sid) => {
      const store = new AgentSessionStore({ projectPath: process.cwd(), persist: false });
      const res = await store.getConversation({ sessionId: sid });
      return { messages: (res?.messages ?? []).map((msg: any) => ({ role: msg.role, text: msg.content })) };
    },
    proxyRead: async (node, sid) => {
      const { proxyPost } = require('../data/peer-client') as typeof import('../data/peer-client');
      const r = (await proxyPost(node, `/mission/session/${encodeURIComponent(sid)}/read`, {})) as any;
      const data = r?.data ?? r;
      return { messages: (data?.messages ?? []).map((x: any) => ({ role: x.role, text: x.text })) };
    },
    proxyStatus: async (node, sid) => {
      const { proxyPost } = require('../data/peer-client') as typeof import('../data/peer-client');
      const r = (await proxyPost(node, `/mission/session/${encodeURIComponent(sid)}/status`, {})) as any;
      const data = r?.data ?? r;
      return { alive: data?.alive !== false };
    },
  };
}
```
(`thisNode` — import from `./mission-store` if not already in scope in that file; check existing imports first.)

- [ ] **Step 4: Verify pass** + mission suite green.
- [ ] **Step 5: Commit** — `git commit -m "feat(onboard): supervisor reads onboarded sessions (local + cross-node) with human-activity detection"`

---

### Task 11: `mission_onboard` MCP tool + guide text

**Files:**
- Modify: `core/src/mcp-server/tools/mission.ts` — add to `MISSION_TOOL_DEFS` + `MISSION_HANDLERS` (match the file's existing def/handler style — look at `mission_create` there and mirror it, including `withActorHint`-equivalent actor stamping if that file uses one; if it defines its own `_actor` helper use that).
- Modify: `core/src/mcp-server/configure.ts` — `TOOL_SCOPES` `mission_onboard: 'write'`.
- Modify: `core/src/mcp-server/tools/guide.ts` — extend the `missions` topic text.
- Test: `core/src/__tests__/mission-onboard-mcp.test.ts`

**Tool def:**
```ts
  { name: 'mission_onboard', description: 'Onboard an EXISTING Claude Code session into mission control. Omit sessionId to onboard the CALLING session (self-handoff). mode: standby (default — observe only, human stays in charge) | handoff (mission control drives it end-to-end per the workflow playbooks). cluster targets which cluster\'s controller manages it (default: this node\'s). note = free-text intent for the analysis. Returns the created (or existing) mission.', inputSchema: obj({ sessionId: S, cluster: S, mode: { ...S, enum: ['handoff', 'standby'] }, note: S, node: S }) },
```
**Handler:** `mission_onboard: async (a) => { try { return pretty(await workerPost('/mission/onboard', withActorHint(a, currentMcpContext()?.toolUseId))); } catch (e) { return err((e as Error).message); } },`

**Guide addition** (inside the `missions` topic string in guide.ts, append a paragraph):
```
ONBOARDING AN EXISTING SESSION: from any session, call mission_onboard({}) to hand the CURRENT session to mission control (or mission_onboard({sessionId}) for another one). mode:"standby" (default) = mission control analyzes + watches, the human keeps driving; mode:"handoff" = mission control takes over and drives it to completion per the workflow playbooks (onboard.analyze → drive.<work-type>/recover.stuck/wrapup.completed). Switch anytime with mission_update({id, manageMode:"handoff"|"standby"}) — human-only. The playbooks themselves are editable: mission_workflow_list/get/set/history/rollback.
```

- [ ] **Step 1: Failing test**

```ts
// core/src/__tests__/mission-onboard-mcp.test.ts
import { test } from 'node:test';
import assert from 'node:assert';
import { MISSION_TOOL_DEFS } from '../mcp-server/tools/mission';

test('mission_onboard def present with the right schema', () => {
  const d = MISSION_TOOL_DEFS.find((x: any) => x.name === 'mission_onboard') as any;
  assert.ok(d, 'def exists');
  assert.ok(d.description.includes('standby'));
  for (const p of ['sessionId', 'cluster', 'mode', 'note']) assert.ok(d.inputSchema.properties[p], p);
  assert.deepEqual(d.inputSchema.required ?? [], [], 'no required args (self-onboard)');
});

test('scope registered', () => {
  const { TOOL_SCOPES } = require('../mcp-server/configure');
  assert.equal(TOOL_SCOPES.mission_onboard, 'write');
});
```

- [ ] **Step 2: Verify failure.**
- [ ] **Step 3: Implement** per the def/handler/guide/scopes above. If an existing test strict-enumerates `MISSION_TOOL_DEFS` (check `core/src/__tests__/mission-mcp.test.ts` — memory says it enumerates the tool list), UPDATE that enumeration to include `mission_onboard`.
- [ ] **Step 4: Verify pass** — new test + `node --test dist-test/__tests__/mission-mcp.test.js`.
- [ ] **Step 5: Commit** — `git commit -m "feat(onboard): mission_onboard MCP tool + guide recipe"`

---

### Task 12: Web — onboarded badge + mode chip on the Missions page

**Files:**
- Modify: `web/src/components/missions/MissionsPage.tsx`

No component test runner for web (tsc + vitest only for pure libs). Verification = `npx tsc --noEmit` delta-clean + visual smoke in Task 13.

- [ ] **Step 1: Locate the render sites.** `grep -n "badge" web/src/components/missions/MissionsPage.tsx | head -20` — find (a) the sidebar mission-list row where the status badge renders, and (b) the mission detail header. The Mission type used by the page lives in the same file or an imported type — extend it with `origin?: string; manageMode?: string;` where it is declared (grep `interface Mission` in `web/src`).

- [ ] **Step 2: Add the chips.** Next to the existing status badge in BOTH sites, insert:

```tsx
{m.origin === 'onboarded' && (
  <span className="badge badge-outline badge-xs" title="Existing session onboarded into mission control">onboarded</span>
)}
{m.origin === 'onboarded' && m.manageMode && (
  <span className={`badge badge-xs ${m.manageMode === 'handoff' ? 'badge-primary' : 'badge-ghost'}`}
        title={m.manageMode === 'handoff' ? 'mission control drives this session' : 'observe only — human drives'}>
    {m.manageMode}
  </span>
)}
```
(Use the page's existing badge class vocabulary — if rows use different classes than `badge badge-outline`, copy the exact classes of the adjacent status chip; the variable holding the mission may be named differently at each site — match it.)

- [ ] **Step 3: Type-check.** Run: `cd web && npx tsc --noEmit 2>&1 | wc -l` — the count must not exceed the pre-change baseline (record baseline first: run the same command before editing; repo carries ~39 pre-existing).

- [ ] **Step 4: Commit** — `git commit -m "feat(onboard): missions UI shows onboarded badge + manage-mode chip"`

---

### Task 13: E2E + full verification

**Files:**
- Create: `scripts/e2e/onboard-e2e.sh`

- [ ] **Step 1: Write the e2e script** (REST-level, isolated dev core — NO LLM, NO cloud; mirrors the fixture spirit of `scripts/e2e/live-rc-e2e.sh`):

```bash
#!/usr/bin/env bash
# E2E: workflow registry + session onboarding rails against an ISOLATED core.
# No cloud, no LLM, no prod impact. Requires: node, curl, jq; run from repo root.
set -euo pipefail
PORT="${PORT:-3211}"
DATA_DIR="$(mktemp -d)"
export LM_ASSIST_DATA_DIR="$DATA_DIR"      # isolated ~/.lm-assist substitute (see core/src/utils/path-utils)
API="http://127.0.0.1:${PORT}"
TOKEN_ARGS=()
cleanup() { kill "$CORE_PID" 2>/dev/null || true; rm -rf "$DATA_DIR"; }
trap cleanup EXIT

node core/dist/cli.js serve --port "$PORT" --host 127.0.0.1 & CORE_PID=$!
for i in $(seq 1 30); do curl -sf "$API/health" >/dev/null && break; sleep 1; done
# Resolve worker token if the isolated core minted one (path-utils getDataDir()/api-token)
[ -f "$DATA_DIR/api-token" ] && TOKEN_ARGS=(-H "x-api-key: $(cat "$DATA_DIR/api-token")")
req() { curl -s "${TOKEN_ARGS[@]}" -H 'content-type: application/json' "$@"; }
pass=0; fail=0
check() { local name="$1" cond="$2"; if [ "$cond" = "true" ]; then pass=$((pass+1)); echo "PASS $name"; else fail=$((fail+1)); echo "FAIL $name"; fi }

# 1. workflow list shows the 9 defaults (stored or default)
WL=$(req "$API/mission/workflows")
check "workflows listed" "$(echo "$WL" | jq '[(.data.workflows|length) + (.data.defaults|length)] | .[0] >= 9')"

# 2. set + get + rendered preamble
req -X POST "$API/mission/workflows/e2e.doc" -d '{"title":"E2E","body":"E2E-BODY","editPolicy":"open"}' >/dev/null
WG=$(req "$API/mission/workflows/e2e.doc")
check "workflow get rendered+preamble" "$(echo "$WG" | jq '.data.rendered | (contains("INVARIANTS") and contains("E2E-BODY"))')"

# 3. edit → history → rollback
req -X POST "$API/mission/workflows/e2e.doc" -d '{"body":"E2E-BODY-2"}' >/dev/null
RB=$(req -X POST "$API/mission/workflows/e2e.doc/rollback" -d '{"toRev":1}')
check "rollback to rev1 body" "$(echo "$RB" | jq '.data.doc.body == "E2E-BODY" and .data.doc.rev == 3')"

# 4. onboard a synthetic native session (transcript-only fixture)
SID="e2e00000-0000-4000-8000-00000000e2e1"
OB=$(req -X POST "$API/mission/onboard" -d "{\"sessionId\":\"$SID\",\"mode\":\"standby\"}")
MID=$(echo "$OB" | jq -r '.data.mission.id // empty')
check "onboard creates mission" "$( [ -n "$MID" ] && echo true || echo false )"
check "standby + analyzing tag" "$(echo "$OB" | jq '.data.mission.manageMode == "standby" and (.data.mission.tags["onboard:state"][0] == "analyzing")')"

# 5. idempotent
OB2=$(req -X POST "$API/mission/onboard" -d "{\"sessionId\":\"$SID\"}")
check "idempotent onboard" "$(echo "$OB2" | jq --arg mid "$MID" '.data.existing == true and .data.mission.id == $mid')"

# 6. standby drive rejected
DR=$(req -X POST "$API/mission/session/$SID/drive" -d '{"text":"hi"}')
check "standby drive rejected" "$(echo "$DR" | jq '.success == false and .error.code == "STANDBY_MODE"')"

# 7. mode switch (human) then schedule exclusion
req -X POST "$API/mission/$MID" -d '{"manageMode":"handoff"}' >/dev/null
SC=$(req -X POST "$API/mission/schedule" -d '{}')
check "onboarded never spawn-ready" "$(echo "$SC" | jq --arg mid "$MID" '.data.ready | index($mid) == null')"

echo "== $pass passed, $fail failed"; [ "$fail" -eq 0 ]
```

Note: if the isolated core rejects unauthenticated requests differently or `SESSION_NOT_FOUND` fires for the synthetic sid (no transcript on this host), adapt: create the minimal fixture transcript first (`~/.claude/projects/.../<SID>.jsonl` equivalent used by `sessionVerdict`) exactly as `scripts/e2e/live-rc-e2e.sh` does — read that script and reuse its fixture function. The e2e must end 0-fail; skipping a check requires a printed SKIP reason.

- [ ] **Step 2: Run everything.**

```bash
chmod +x scripts/e2e/onboard-e2e.sh
./core.sh build                                   # full compile
cd core && npm run build:test && node --test dist-test/__tests__/mission*.test.js dist-test/__tests__/workflow*.test.js 2>&1 | tail -5
cd .. && ./scripts/e2e/onboard-e2e.sh
```
Expected: build clean; test summary `fail 0`; e2e `0 failed`.

- [ ] **Step 3: Commit** — `git commit -m "test(onboard): REST-level e2e for workflow registry + onboarding rails"`

---

## Post-implementation (not tasks — process)

- Whole-branch review (superpowers:requesting-code-review / opus final review) before merge; merge/deploy/npm remain **user-gated**.
- Live controller-in-the-loop validation happens at deploy time on staging (123/107): onboard a real session in standby, watch the controller analyze + tag it; flip to handoff and watch a marker-prefixed drive — per the deployment checklist in the spec §8.
- Known v1 limits (documented in spec): cloud humanActive detection off; standby enforcement on non-leader nodes subject to dataset sync lag; `onboard.analyze` quality is playbook-driven and expected to be iterated via the registry itself.

## Plan Self-Review (done at write time)

- **Spec coverage:** §3.1-3.6 → T1-T6; §4.1 → T8; §4.2 → T2 (onboard.analyze) + T6 (engagement wake); §4.3 → T8/T9; §4.4 → T7/T10; §4.5 → T9 (reaper) + T7 (scheduler); §4.6 → T10; §5 → T2; §6 → T7/T8/T9/T11/T12; §7 error table → T3/T4/T8/T10 tests; §8 → per-task tests + T13.
- **Placeholders:** none — every code step carries the code; T3 abbreviates only the port plumbing explicitly labeled "copy the mission-store.ts livePort pattern verbatim", which is existing code to mirror, and T12 defers only class-name matching to the live file.
- **Type consistency:** `WorkflowPort`/`WorkflowSnapshotPort` names consistent T3→T4→T5; `OnboardDeps` T8 only; `ManageMode` defined T7, used T8/T9; `MISSION_CONTROL_MARKER` defined T7, used T9/T10; `passDirective` defined+used T6.
