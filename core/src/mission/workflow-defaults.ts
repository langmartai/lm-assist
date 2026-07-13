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

PLAYBOOK EVOLUTION: your process docs live in the workflow registry (mission_workflow_list/get/set/history/rollback). You may improve an 'open' doc when experience shows a better process — but announce every self-edit in chat with one line of rationale, keep edits small, and never touch what the invariant preamble forbids. A human can roll back any edit.`;

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
