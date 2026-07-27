/** TS-default playbook bodies. Fallback when the registry is unavailable; seeded into the dataset by the leader. */
import type { WorkflowEditPolicy } from './workflow-model';

export const WORK_TYPES = ['design', 'direct-impl', 'bugfix', 'feature'] as const;
export const ONBOARD_STATES = ['stuck', 'in-progress', 'completed'] as const;

// NOTE: single source: mission-controller.ts re-exports CONTROLLER_PASS_DIRECTIVE from this body.
const PASS_BASE =
  'Run a controller pass now. FIRST call mission_changes — re-evaluate any mission an external actor (a human or another node) edited since your last pass BEFORE anything else, and adapt rather than override. THEN call mission_schedule for the deterministic plan: act on each id in `ready` (place/spawn an executor via ccr_cloud_start, NEVER agent_execute, then bind with mission_update({binding})); for each `epicRollups` entry whose status/progress differs from the stored parent, apply it with mission_update; leave `blocked` and `containers` alone (they are gated/rolled-up by code). For two ready missions that touch the same area with no explicit dependsOn, decide parallel-vs-sequence (use mission_neighbors/mission_graph to see structure) and if you serialize them, tag them mission_tag({add:{"ctl:serialize-group":["<group>"]}}) so the scheduler enforces it next pass. Record your view with ctl: tags (e.g. ctl:readiness). Answer any worker pendingQuestion IMMEDIATELY via mission_session_answer; resume a non-live bound worker with mission_session_resume(sid) before respawning. BEFORE you place/spawn an executor for a `ready` mission, call session_footprints (your cluster) and AVOID a node/repo/branch/worktree an UNMANAGED recent session occupies — especially one whose openChanges overlap the mission repo/branch or whose branch is pushed:false — and any port an exclusive service holds; mission-managed sessions (managed set) are your own, never a conflict. If the only placement collides, DEFER: leave the mission ready, tag ctl:deferred-contention with the conflicting session, and revisit next pass. If the survey is partial/warming, treat unknown nodes as clear and re-check next pass. ' +
  'WHERE it runs is your decision, not a side effect of who placed it: before you spawn a `ready` mission with NO `env.host`, call node_select(missionId) — it ranks your cluster from live facts plus the taught `node-profiles` registry and returns every candidate with its reasons AND its notes (the prose is excluded from the ranking on purpose; weighing it is your job). Record the node you settle on with mission_update({id, env:{…existing env, host:"<node>"}}) BEFORE spawning. A spawn always launches on the node that RUNS it, so if your node is not this one, do NOT spawn — leave the mission ready, tag mission_tag({add:{"ctl:placement-remote":["<node>"]}}), and say so in your report. Teach what you learn about a node back with node_profile. ' +
  'REPORTING (mandatory): this command arrives wrapped with a ⟦CMD cmd-…⟧ id — END your reply with the matching ⟦RESULT cmd-…⟧ line followed by ONE line per task you acted on this pass, format "- <task>: done|in-progress|blocked|skipped — <verifiable evidence: mission id+rev, session id, commit, count>". The supervisor PARSES this block to verify the pass; a missing block is journaled as an unacknowledged command. Nothing to act on → "- no-op: acknowledged". Then await the next pass.';

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

MULTI-PHASE ONBOARDED MISSIONS: if onboard:work-type=multi-phase, route to drive.multi-phase (NOT a single drive.<type>). It is a COMPOSITE mission driven phase-by-phase via the durable ctl:phase tag (design/bugfix/impl/deploy), each phase using its own doc's rigor; it is only 'completed' when its FINAL phase — often a verified deploy — is done. Never mark a multi-phase mission done because its feature "works" but is not yet deployed.

PLAYBOOK EVOLUTION: your process docs live in the workflow registry (mission_workflow_list/get/set/history/rollback). You may improve an 'open' doc when experience shows a better process — but announce every self-edit in chat with one line of rationale, keep edits small, and never touch what the invariant preamble forbids. A human can roll back any edit.

CASE LIBRARY (recall-before-improvise): on ANY unexpected failure, error loop, or ≥2 failed attempts at the same step — yours or a driven session's — consult mission_workflow_get("case.index") BEFORE trying another variation, and follow a matching case's HANDLE. After resolving a difficult situation (especially one a human guided), store the learning per case.capture.`;

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
   - manageMode handoff → immediately fetch the routed doc (wrapup.completed / recover.stuck / drive.<work-type>) and proceed.

COMPOSITE / MULTI-PHASE WORK (do this in step 2 BEFORE picking a single work-type):
If the goal spans MORE THAN ONE work-type or is an ordered multi-step plan — e.g. it needs a design decision AND a distinct bug fix AND/OR a deploy, not just one of them — do NOT flatten it to a single type. Instead:
  - set onboard:work-type = multi-phase (mission_tag set {"onboard:work-type":["multi-phase"]}),
  - write the ORDERED phase plan into the mission plan as: "Phase 1 (design): …; Phase 2 (bugfix): …; Phase 3 (impl): …; Phase 4 (deploy): …" (only the phases that apply, in order),
  - set ctl:phase to the first not-yet-done phase: mission_tag set {"ctl:phase":["<first kind>"]}.
Then routing goes to drive.multi-phase, which drives each phase with its own rigor and only marks the mission done after the FINAL phase (often deploy) is verified. Reserve a single work-type (design/direct-impl/bugfix/feature) for genuinely single-purpose sessions.`,
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
    body: `0. CONSULT THE CASE LIBRARY FIRST: mission_workflow_get("case.index"); if any row's cues match this situation, fetch that case.<slug> and follow its HANDLE before anything below — recall beats improvisation (one failed approach = switch to recall, not a third variation). After resolution, store the learning per case.capture (update or add the case).

An onboarded session is STUCK (onboard:state=stuck, or you detected no progress / repeated failures).

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
4. Mark the mission done. The session itself is LEFT UNTOUCHED (never close/kill an onboarded session).

MULTI-PHASE COMPLETION: if onboard:work-type=multi-phase, confirm EVERY phase in the plan is done before marking the mission done — including a deploy phase (the release VERIFIED present, per drive.deploy), not just the feature working. Read ctl:phase and the plan; if any phase (especially deploy) is unfinished, return to drive.multi-phase instead of completing.`,
  },

  'drive.multi-phase': {
    title: 'Drive a composite multi-phase mission',
    editPolicy: 'open',
    body: `Driving a COMPOSITE onboarded mission — one whose goal spans several phases (e.g. design → bugfix → implement → deploy). One flat drive doc cannot carry this; you orchestrate the phases here.

STATE: the ordered phase plan lives in the mission plan. The CURRENT phase is the ctl:phase tag — a DURABLE, synced, versioned marker that survives your own failover, so ALWAYS read it first and never re-derive the phase from prose. Phase kinds: design | bugfix | impl | deploy (a mission may use any ordered subset).

EACH PASS:
1. Read ctl:phase. If absent, set it to the first not-yet-done phase from the plan: mission_tag set {"ctl:phase":["<kind>"]}.
2. Drive ONLY the current phase, with that phase's OWN rigor — FETCH and follow the matching doc:
     design → mission_workflow_get("drive.design")
     bugfix → mission_workflow_get("drive.bugfix")   (reproduce → root-cause → a regression test that FAILS before the fix and PASSES after — do NOT let the session skip this just because it sits inside a bigger task)
     impl   → mission_workflow_get("drive.direct-impl")   (or drive.feature if the impl itself needs design)
     deploy → mission_workflow_get("drive.deploy")
   Send ONE focused instruction per drive (the ⟦MISSION-CONTROL⟧ marker is added for you).
3. PARALLEL SUB-WORK (impl phase): if the phase decomposes into INDEPENDENT parts (e.g. three separate sub-checks), instruct the onboarded SESSION to fan them out to its OWN parallel sub-agents and then integrate — the session is the orchestrator of its own sub-agents; you do NOT spawn separate mission executors for an onboarded mission (the scheduler never places them). Monitor with mission_session_read; mission_sessions surfaces any sub-workers the session spawned.
4. A phase is COMPLETE only when its doc's done-criteria are met AND evidenced in the transcript. Record the phase evidence (refs) in results, then ADVANCE: mission_tag set the next phase kind — or, if this was the LAST phase, hand to wrapup.completed.
5. COMPLETION DISCIPLINE: a composite mission is NEVER 'completed' until its FINAL phase is done. If the plan ends in deploy, it is not done until the deploy is VERIFIED (see drive.deploy). Do not mark it done after the feature merely "works".
6. If a phase gets stuck, use recover.stuck for THAT phase, then resume it — do not skip ahead.`,
  },

  'drive.deploy': {
    title: 'Drive the deploy/release phase',
    editPolicy: 'open',
    body: `Driving the DEPLOY / RELEASE phase of an onboarded mission (the change must be SHIPPED, not just built).

PRE-CONDITION — never deploy unverified work: confirm the prior phases are done WITH EVIDENCE (tests/regression green, the feature demonstrably works) before shipping. Missing evidence → go back; do not deploy "to see if it works".

1. IDENTIFY the deploy mechanism from the repo/session: a deploy script (e.g. ./deploy.sh), a documented release procedure, or machine-access steps. If none is discoverable, that is a HUMAN question — pause and ask; do not invent a deploy.
2. SAFETY GATE by target:
   - scratch / staging / a reversible local release → you may drive the session to run it.
   - PRODUCTION or any irreversible / outward-facing deploy → this is a MATERIAL action: set the mission paused, state in chat EXACTLY what will run and where, and WAIT for a human to approve (or run it themselves). NEVER auto-deploy to prod (invariant: never auto-approve a material action).
3. RUN the deploy (drive the session to execute the mechanism) and CAPTURE its output.
4. VERIFY the release actually LANDED — the release marker / artifact / health of the deployed target (e.g. the RELEASED file exists; the new version answers). "The script exited 0" is necessary but NOT sufficient; confirm the observable result.
5. RECORD the deployed ref/target in mission results. Deploy is DONE only when the release is verified present. Only then may the mission move to wrapup.completed.`,
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

  'case.recall-before-improvise': {
    title: 'Case: stopper hit — recall before improvising',
    editPolicy: 'open',
    body: `SITUATION: An approach failed (especially twice), an unfamiliar error appeared, or you are about to conclude "needs a restart/reboot/manual fix".
RECOGNIZE: ≥2 failed attempts at the same step; an error you cannot explain; the words "just restart/kill/reboot it" forming in your plan.
HANDLE:
1. STOP improvising — one failed approach is the signal to switch to recall, not to try a third variation.
2. Scan case.index for a matching case; search memory (search_memory) and past sessions for this exact symptom — most dead-ends in this fleet are already documented.
3. Only if nothing is found: root-cause the actual code/system before changing anything. No fix without a confirmed root cause; never force-reset first.
WHY: Flailing through variations is slower and riskier than recall; a "kernel-wedged, needs reboot" once turned out to be the wrong kill tool over SSH.
SOURCE: user's codified panic-mode rule; session 99d239ac (2026-06).`,
  },

  'case.evidence-before-done': {
    title: 'Case: completion claims need live evidence',
    editPolicy: 'open',
    body: `SITUATION: Work looks finished (build green, merged, logs clean) and you are about to report or mark it done.
RECOGNIZE: "done/complete/fixed" forming with only unit tests, logs, or code inspection as evidence; celebratory summary right after a merge.
HANDLE:
1. Exercise the REAL path live (the actual tool call, endpoint, UI round-trip) — log/code inspection alone is inadmissible for a live-system claim.
2. Verify through an INDEPENDENT channel from the one that made the change (e.g. list/read it back via a different tool).
3. "Merged to main" ≠ shipped: a mission whose goal includes deploy/fleet is done only after the deploy step ran AND a post-deploy health/version check passed.
4. Loopback/unit green does NOT prove cross-node behavior — live-test cross-node before trusting channel/routing changes.
WHY: The user rejected done-claims repeatedly until real-path, independently-verified, post-deploy evidence existed.
SOURCE: sessions 99d239ac, be9aa2ff ("Deploy and test e2e"), 2026-06/07.`,
  },

  'case.parity-itemized-checklist': {
    title: 'Case: reference-product parity needs a per-feature checklist',
    editPolicy: 'open',
    body: `SITUATION: Building or driving work meant to mirror an existing product/page ("make it like X").
RECOGNIZE: A parity/lookalike goal; a comparison about to be summarized as "looks similar"; the reference not actually opened.
HANDLE:
1. Inspect the LIVE reference first (real browser/proxy) — never approximate it from memory.
2. Decompose the comparison into an itemized per-feature checklist as tracked tasks; verify each item against the live reference individually.
3. A working happy-path is NOT parity — layout, ordering, states, and missing-feature gaps only surface in side-by-side driving.
WHY: A "compared and looks right" claim was rejected twice; only the itemized checklist caught the real gaps.
SOURCE: sessions 98da62b4, 98db67bc (2026-07).`,
  },

  'case.postmortem-before-retry': {
    title: 'Case: failed deploy/build — postmortem before any retry',
    editPolicy: 'open',
    body: `SITUATION: A build or deploy failed or half-applied, and the instinct is to just run it again.
RECOGNIZE: Non-zero/partial deploy result; the next planned action is an identical retry.
HANDLE:
1. Produce the causal explanation FIRST (which step failed, why, what state it left behind).
2. Make non-recurrence a hard constraint on the retry (change the step, add the assert — not just re-run).
3. Deploy scripts must stage-and-verify the new artifact BEFORE tearing down the live service; never continue past a failed copy/extract.
WHY: "Why did the deploy fail — can you not do the wrong again?" — a healthy service was once torn down on the basis of a failed prep step.
SOURCE: sessions 99d239ac (2026-06); deploy-gotchas 2026-06-29.`,
  },

  'case.dead-session-resume': {
    title: 'Case: bound session is dead/unreachable — resume-first',
    editPolicy: 'open',
    body: `SITUATION: A mission's bound session has no live process (or is unreachable) and work must continue.
RECOGNIZE: liveness=false / verdict gone-or-refuse on the bound sid; temptation to spawn a fresh executor.
HANDLE:
1. NEVER resume over a live process, and never spawn a replacement while the original may be alive — re-check liveness first.
2. Prefer mission_session_resume: live+reachable is reconnected in place (context preserved); dead-with-transcript is resumed (same sid).
3. needs-force means a HUMAN decides — surface it; do not force yourself.
4. Only a confirmed-terminal (gone) session justifies a fresh spawn, as an explicit separate action; persist the new binding immediately (an unpersisted binding caused duplicate executors).
WHY: Resume preserves context; premature respawn caused 12 duplicate cloud sessions in one live incident.
SOURCE: sessions 99d239ac (0.1.85 C1, e2e runaway), 2026-06.`,
  },

  'case.wedged-interactive-prompt': {
    title: 'Case: driven session wedged on an interactive prompt',
    editPolicy: 'open',
    body: `SITUATION: A driven native session stops progressing; its queued instruction never becomes a committed turn.
RECOGNIZE: mission_session_read shows no new turns after a delivered drive; the REPL is waiting on trust/permission/onboarding UI the answer channel cannot clear (it only answers AskUserQuestion).
HANDLE:
1. Capture the screen (terminal_capture on its tmux) to SEE the actual prompt — do not keep re-driving.
2. Trust/onboarding prompts on a scratch/known-safe repo: answer via terminal keys (trust = "1"; a defensive "2" EXITS). Permission prompts for real actions: surface to the human — never blind-approve.
3. If the session will be driven long-term on scratch work, prefer relaunching it with skip-permissions (resume preserves the sid) so prompts stop recurring.
4. Tag the mission stuck + notify rather than looping drives into a wedged REPL.
WHY: A pre-existing no-skip-permissions session stalled a handoff mission; screen-capture identified it in one step.
SOURCE: session ec94254a live validation (2026-07-15).`,
  },

  'case.dry-run-destructive': {
    title: 'Case: bulk/destructive automation needs dry-run rails',
    editPolicy: 'open',
    body: `SITUATION: About to run or build anything that deletes/overwrites many records or files.
RECOGNIZE: A cleanup/bulk-delete step with pattern matching; no preview of what would be affected.
HANDLE:
1. Dry-run FIRST as a first-class mode (list exactly what would be deleted); only then execute.
2. Match by EXACT ids, never loose patterns that can over-match.
3. Ambiguous or empty state defaults to "delete nothing".
4. Back up the target before overwriting anything you did not create.
WHY: "Should have a button to set dry run, not hand-change script" — safety rails belong in the process, not in vigilance.
SOURCE: session 99d239ac (2026-06).`,
  },

  'case.deploy-path-check': {
    title: 'Case: pick the org-correct deploy path (no silent downgrades)',
    editPolicy: 'open',
    body: `SITUATION: Work is merged and must reach machines; the "textbook" path (npm publish/upgrade/install-latest) is tempting.
RECOGNIZE: Any publish/upgrade/install step in the plan; the org has a known-good custom path (dist-sync) and a registry that lags local builds.
HANDLE:
1. Check FIRST whether the standard channel would DOWNGRADE or re-break the fleet (npm latest older than local; known pinned-dep traps) — if so it is forbidden.
2. Use the documented org path: sync the built artifacts (core/dist + scripts) per node + restart; back up the target first.
3. After restart, verify the RUNNING process started AFTER the install finished and carries the change (a mid-install respawn loads stale code).
WHY: "We don't want npm publish revert to old npm version" — repeated as an absolute constraint.
SOURCE: sessions be9aa2ff, 99d239ac deploy gotchas (2026-06/07).`,
  },

  'case.blast-radius-user-gate': {
    title: 'Case: fleet-wide/prod/credential actions are human-gated',
    editPolicy: 'open',
    body: `SITUATION: An action would change something fleet-wide, touch production, connect credentials, or is hard to reverse.
RECOGNIZE: Scope larger than the current mission (all nodes, prod cluster, external accounts, irreversible deletes/deploys).
HANDLE:
1. Default OFF: ship such capabilities as explicit opt-in switches; never auto-enable as a side effect.
2. State exactly what would run and where, then WAIT for explicit human confirmation (a gate, not a notification).
3. Approval for one scope does not extend to the next — prod is gated even when staging was approved.
WHY: The user consistently gates merges, fleet rollouts, and credential connections; autonomy ends at blast radius.
SOURCE: sessions 99d239ac, be9aa2ff (standing practice).`,
  },

  'case.ask-vs-act-calibration': {
    title: 'Case: when to ask the human vs just execute',
    editPolicy: 'open',
    body: `SITUATION: Deciding whether to pause for the human or proceed.
RECOGNIZE: Either a real fork (multiple reasonable options, material consequences) OR an obvious next step you are about to "confirm" redundantly.
HANDLE:
1. Genuine fork + human available → surface it as an explicit structured choice (question/gate), options first, recommendation marked. Never silently pick.
2. Diagnosis stated + next action unambiguous → EXECUTE; asking "shall I proceed?" after stating the plan is rebuked ("Yes why ask me").
3. An explicit autonomy grant ("just do it, no need my approval, e2e") covers the whole implement→deploy→verify cycle — report at completion or blocking failure only.
4. Terse replies ("Go", "Yes", "1", "Good") during a staged plan = proceed to the next planned part verbatim — not new scope.
WHY: Both failure modes are real: silent assumptions on forks, and redundant check-ins on obvious paths.
SOURCE: sessions 99d239ac, 98da62b4, be9aa2ff (2026-06/07).`,
  },

  'case.human-correction-supremacy': {
    title: 'Case: human corrections override and tighten',
    editPolicy: 'open',
    body: `SITUATION: The human interrupts, contradicts a stated mechanism, or asks the same "why" again.
RECOGNIZE: [interrupt] + reissued instruction; "no/not that/wrong"; a repeated why after you already answered; a plain question poking an assumption.
HANDLE:
1. Consecutive interrupt+reissue = each version TIGHTENS the constraint; execute only the final, most-constrained restatement.
2. When contradicted on how something works: stop, re-derive from the live source (code/system), never re-assert the prior claim.
3. A repeated "why" is a demand for the exact root cause (file/line), not a re-summary.
4. A naive-sounding question about an identity/auth/trust boundary is a security probe: re-verify against source; "never trust client-supplied identity" is a hard invariant.
WHY: A basic "where does this id come from?" question uncovered a real prod impersonation vector.
SOURCE: sessions be9aa2ff (2026-07), 99d239ac.`,
  },

  'case.duplicate-executor-guard': {
    title: 'Case: never double-spawn executors',
    editPolicy: 'open',
    body: `SITUATION: An executor looks dead/stalled and a replacement is about to be started.
RECOGNIZE: Liveness read says not-alive shortly after a (re)start; binding not yet persisted; the same mission about to get a second session.
HANDLE:
1. Apply a startup grace window — a freshly-started executor looks dead before it registers.
2. Re-check liveness through the correct id-space (cloud ids differ across list vs status APIs) before declaring gone.
3. Persist the new binding IMMEDIATELY on any (re)launch — an unpersisted binding makes the next pass rebind/spawn again.
4. One executor per mission, ever; replacements only after confirmed-terminal.
WHY: A liveness/id-space mismatch once spawned 12 duplicate cloud sessions in 6 ticks.
SOURCE: session 99d239ac e2e (2026-06).`,
  },

  'case.cross-host-collision-check': {
    title: 'Case: audit all hosts before merge/push/placement',
    editPolicy: 'open',
    body: `SITUATION: About to merge/push shared work, or place an executor into a repo/branch/host.
RECOGNIZE: Multiple hosts/sessions touched the work; concurrent sessions may have pushed mid-flight; a placement targets a repo another session occupies.
HANDLE:
1. Enumerate git status on EVERY involved host; distinguish "modified by this work" from pre-existing dirt before proceeding.
2. Re-fetch origin before pushing — a concurrent session may have moved it; never assume your last known state.
3. Before placing executors, consult session_footprints and avoid nodes/repos/branches/worktrees an unmanaged session occupies; defer on collision.
WHY: "Double check this host and 107 has no new modified files" — clobbering concurrent work is unrecoverable.
SOURCE: sessions be9aa2ff, 99d239ac (2026-06/07).`,
  },

  'case.synthetic-drill': {
    title: 'Case: stress-drill a new process before trusting it',
    editPolicy: 'open',
    body: `SITUATION: A new orchestration/onboarding/process capability was just built or redesigned.
RECOGNIZE: The only validation so far is design review or unit tests; no real run at the target complexity.
HANDLE:
1. Construct a deliberately stressful synthetic scenario matching the target complexity class (multi-phase, multi-agent, with a planted defect and a deploy step).
2. Run the REAL process against it live; observe where it flattens, loses state, or stops early — friction found is a required fix, not an edge case.
3. Fix, then re-run the same scenario to show the before/after delta.
4. Report "what's wrong" explicitly — the drill's purpose is finding seams, not confirming success.
WHY: The onboarding process passed all unit gates yet flattened composite work and dropped deploys — only the drill exposed it.
SOURCE: session ec94254a (2026-07-15).`,
  },

  'case.background-cost-audit': {
    title: 'Case: standing automations get cost audits',
    editPolicy: 'open',
    body: `SITUATION: A recurring/background job (monitor, harvester, reviewer, poller) has been running for a while.
RECOGNIZE: You cannot say what a standing job consumed recently or whether it is still needed; a job silently uses paid tokens/quota.
HANDLE:
1. Periodically surface every standing job: is it still needed, how long has it run, what has it consumed (tokens/cost/CPU)?
2. Offload detection to cheap scripts; engage the LLM only on material change (the token-frugal pattern).
3. Anything unaccounted-for gets paused until justified.
WHY: "How many tokens has it used already" — silent unbounded consumption is a standing user concern.
SOURCE: sessions 99d239ac (Wave-4 design rationale), 2026-06.`,
  },

  'case.capture': {
    title: 'How to capture a learned case',
    editPolicy: 'open',
    body: `You resolved (or watched a human resolve) a DIFFICULT SITUATION. Store the learning so any future controller pass can reuse it — this is how the process evolves from experience.

WHEN TO CAPTURE (any of):
- a human intervened with guidance/correction while you were handling a mission or session;
- a recovery worked after ≥2 failed attempts (the working path is the knowledge);
- you scanned case.index, found NO match, and had to improvise a resolution.

HOW:
1. Slug it: case.<short-kebab-slug>. Check case.index FIRST — if a case already covers it, UPDATE that doc (refine RECOGNIZE/HANDLE) instead of adding a near-duplicate. The doc name must describe the situation it actually covers.
2. mission_workflow_set the doc in EXACTLY this shape (≤20 lines):
   SITUATION: <one line>
   RECOGNIZE: <observable cues>
   HANDLE: <numbered steps that worked — the HUMAN's guidance takes precedence when they conflict with your own derivation>
   WHY: <one line>
   SOURCE: <mission/session id or "human guidance", date>
3. Add/refresh its one-line row in case.index: \`case.<slug> — <RECOGNIZE one-liner>\`.
4. Announce in chat: "captured case.<slug>: <situation>".

RULES: never store secrets/tokens/credentials; HANDLE ≤6 steps (a recall card, not a manual); do not delete cases — refine them (history keeps every revision).`,
  },

  'case.index': {
    title: 'Case library index — scan on any difficulty',
    editPolicy: 'open',
    body: `Known difficult-situation cases, learned from real sessions. SCAN THIS FIRST when anything is failing, stuck, or repeating — recall beats improvisation. On a cue match, mission_workflow_get the case and follow its HANDLE. No match after a genuine scan → proceed (e.g. recover.stuck), then STORE what worked per case.capture.

FORMAT: case.<slug> — <recognition one-liner>

case.recall-before-improvise — ≥2 failed attempts / unexplained error / about to force-restart something
case.evidence-before-done — about to claim done/fixed with only unit tests, logs, or a merge as evidence
case.parity-itemized-checklist — mirroring a reference product; comparison about to be 'looks similar'
case.postmortem-before-retry — a build/deploy failed and the next step would be an identical retry
case.dead-session-resume — bound session not alive/unreachable; tempted to spawn a replacement
case.wedged-interactive-prompt — delivered drive never becomes a committed turn; REPL waiting on a prompt
case.dry-run-destructive — about to bulk-delete/cleanup/overwrite by pattern
case.deploy-path-check — about to publish/upgrade/install to ship work to machines
case.blast-radius-user-gate — action affects fleet/prod/credentials or is hard to reverse
case.ask-vs-act-calibration — deciding whether to ask the human or just execute
case.human-correction-supremacy — interrupted/contradicted/repeated-why by the human
case.duplicate-executor-guard — executor looks dead right after starting; replacement tempting
case.cross-host-collision-check — merging/pushing/placing where multiple hosts/sessions are involved
case.synthetic-drill — a new process/orchestration capability has only design/unit validation
case.background-cost-audit — a standing background job's cost/necessity is unknown`,
  },
};
