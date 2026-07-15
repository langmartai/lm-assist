# Diagnosis: mission-workflows registry writes silently fail on this host (117)

**Mission:** mission_fab3d21c · **Date:** 2026-07-15 · **Status:** diagnosis for human review — NO ownership/metadata mutation performed. The error-surfacing core fix (scope a, approved) is on `feat/mission-process-editor`; the ownership repair (scope b) is NOT executed and awaits a human decision.

## Symptom

`POST /mission/workflows/:id` on this host returns `success:true` with a rev bump, but nothing
persists: an immediate `GET` returns `NOT_FOUND`, the list never gains the doc, history stays
empty, and every retry "creates" rev 1 again.

Three independent confirmations:
- **Executor probe (this mission):** `case.e2e-ui-probe` — two POSTs, both `success:true rev:1
  changed:true`; GET between them → `NOT_FOUND`; history 0 rows; rollback errors.
- **Human probe:** `case.write-probe-117` — POST `success:true rev:1`, immediate GET shows the doc gone.
- **Controller datapoint:** controller edits to `case.wedged-interactive-prompt` (rev1→2) and
  `case.index` (rev2→3) at ~08:34 returned success and are absent post-restart (reads show rev1/rev2).

## Root cause (two stacked defects)

**1. The dataset is a read-only replica here — writes are refused by design.**
The registry persists via the generic data service: dataset `mission-workflows` (docs) +
`mission-workflow-history` (full-body snapshots), declared `scope:'fleet', syncMode:'full'`
(`core/src/mission/workflow-store.ts`). `DataService.put()` refuses any write when the local
descriptor carries an `origin` stamp (`core/src/data/data-service.ts` ~line 164):

```
if ((d as any).origin) return { ok:false, code:'READ_ONLY_REPLICA',
  reason:'dataset "mission-workflows" is a remote replica (read-only)' };
```

This host's descriptor registry (`~/.lm-assist/data/datasets.json` — note: there is NO
`GET /data/datasets/:id` route; inspect the file or `GET /data/catalog`) shows for BOTH datasets:

```
origin: { machineId: 'gw4-31432aec-98c6-407a-8a3b-5582179b8d38',
          hostname: 'yitest-Virtual-Machine' (node 123), os: 'linux' }
scope: 'fleet', syncMode: 'full', createdAt: 2026-07-14T18:03:29Z
```

So the **owner/origin is node 123**; 117 (and presumably 107) hold synced read-only replicas.
Origin landed on 123 because `ensureDataset()` auto-creates the dataset on whichever node first
executes a workflow-store operation with the data service enabled — that was 123 during the
onboarding-feature work on 07-14; fleet-scope full-sync then materialized origin-stamped replicas
everywhere else.

**ACL is NOT the cause:** the refusal fires before/independently of access checks (distinct code
`READ_ONLY_REPLICA`, not `ACCESS_DENIED`), and workflow-store writes use the local system
principal (`systemCtx()`), which passes `authorize(..., 'write')`.

**2. The refusal was swallowed — the route lied "success".**
`livePort().put()` / `liveSnapshotPort().put()` discarded `svc.put()`'s `{ok:false}` result (and
silently returned when the data service is disabled), so `putWorkflow` built the bumped doc in
memory and `handleWorkflowSet` returned it as success. Same for rollback. **Fixed on this branch**
(TDD, 6 tests in `core/src/__tests__/workflow-store-error-propagation.test.ts`): refused/disabled
writes now throw coded errors (`READ_ONLY_REPLICA` / `DATA_SERVICE_DISABLED` /
`SNAPSHOT_WRITE_FAILED` with doc-persisted context), and both handlers return clean
`success:false` envelopes. Writes on 117 now FAIL HONESTLY — they still fail until ownership is
repaired, which is the point: no more silent success-lie. (Snapshot-retention pruning stays
best-effort by design; seeding stays per-doc best-effort at boot.)

## Architectural mismatch (why this bites the leader)

Workflow routes anchor to the **mission leader** (election — currently 117, `selfId ==
monitorNodeId`), but persistence only accepts writes at the **dataset origin** (123). Those are
two unrelated "leaders"; whenever they diverge, every registry write on the mission leader is
refused. Blast radius on 117 today: web-UI saves, MCP `mission_workflow_set`/`_rollback`, and the
controller's own self-edits + case captures. Reads are fine (replica syncs).

**Controller's pre-restart observation (labeled hypothesis, needs confirmation):** rev bumps that
were *visible in reads* at ~08:34 and vanished across the Core restart are consistent with either
(i) the pre-restart build predating the origin-refusal gate, accepting writes into the local
replica cache which the next reconcile-from-origin clobbered, or (ii) an in-memory acceptance path
with the same reconcile outcome. Either way the same root: leader ≠ origin, refusals invisible.

## Remediation options (human decision — none executed)

1. **Re-home the datasets to the standing prod leader (117)** — recommended. E.g. on 123
   export/confirm replica parity, drop origin claim / re-create the dataset on 117 from the
   replica contents (29 docs + snapshot history), let full-sync re-stamp 123/107 as replicas.
   Needs a careful, human-supervised runbook (fleet data surgery; both datasets together).
2. **Anchor workflow writes to the dataset origin** instead of the mission leader (core change:
   route writes to `origin.machineId` via the hub/fabric) — keeps data topology as-is, more code.
3. **Data-layer write-forwarding from replica to origin** (generic fix for every fleet dataset,
   largest scope).
4. **Move mission leadership to 123** — operationally wrong for prod (117 is the intended leader).

Until one of these lands, the write-leg e2e for the /mission-processes page (create→edit→
history→rollback of scratch `case.e2e-ui-probe` against this host's :3100) remains blocked — now
with honest `READ_ONLY_REPLICA` errors instead of fake success once the branch core is deployed.
