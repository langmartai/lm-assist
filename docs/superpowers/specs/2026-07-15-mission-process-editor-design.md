# Mission Process Viewer/Editor (web) — Design

**Mission:** mission_fab3d21c · **Branch:** feat/mission-process-editor · **Date:** 2026-07-15

A sidebar page `/mission-processes` ("Processes") to monitor and steer the mission-workflows
registry (controller/onboard/drive playbooks + the case.* learned-case library). Web-only —
uses the existing REST surface (`/mission/workflows*`, leader-anchored server-side); no core changes.

## Component tree

```
web/src/app/(dashboard)/mission-processes/page.tsx      ('use client' re-export, app convention)
└─ MissionProcessesPage (components/mission-processes/MissionProcessesPage.tsx)
   ├─ header: cowork-style frame (Workflow icon, title "Processes", subtitle; refresh btn right)
   └─ body: flex row, overflow-hidden
      ├─ list column (w-80, shrink-0, overflow-y-auto): groups in fixed order
      │    controller. onboard. drive. wrapup. recover. observe. case. (other)
      │    row = id (mono) · title · badges: rev N / human-only / "default" (un-seeded)
      │          · lastUpdatedBy.kind + timeAgo(updatedAt); case rows show RECOGNIZE cue line
      └─ ProcessDetail (flex-1 min-w-0 flex-col; components/mission-processes/ProcessDetail.tsx)
         ├─ provenance bar: id, title, badges (rev, editPolicy, default), lastUpdatedBy(kind), updatedAt
         ├─ view tabs: Rendered | Raw | Edit | History
         │   Rendered: invariant preamble in a bordered "🔒 immutable" block (split on ⟦/INVARIANTS⟧),
         │             body via ReactMarkdown .prose (same as MarkdownSplitEditor preview)
         │   Raw: mono pre-wrap of doc.body ?? defaultBody
         │   Edit: title input + MarkdownSplitEditor(value, onChange, mono) + Save/Cancel
         │         (open docs only; human-only ⇒ tab disabled + explanation, per contract)
         │   History: table rev/at/actor.kind/title/bodyBytes + per-row ConfirmButton "Rollback"
         └─ error banners via errText(); conflict banner with [Reload] action
```

## Data flow (existing patterns only)

- `const { apiClient, proxy } = useAppMode()`; `apiFetch = apiClient.fetchPath(path, {method, body, machineId})`
  (exact MissionsPage pattern; fetchPath unwraps `{data}`; x-api-key/auth handled inside the client — never raw fetch).
- List: `GET /mission/workflows` → `{workflows: WorkflowDoc[], defaults: string[]}`; grouped client-side.
  Case cues: one extra `GET /mission/workflows/case.index` → parse `case.<slug> — <cue>` rows from
  `doc.body ?? defaultBody` → Map(id→cue) rendered in the case group.
- Detail: `GET /mission/workflows/:id` → `{doc|null, defaultBody|null, rendered}`; doc null ⇒ "default
  (not stored yet)" badge; editing a default creates the stored doc (server seeds on write).
- Save: `POST /mission/workflows/:id {title, body}` → attributed `kind:'user'` server-side (no `_actor`).
- History: `GET /mission/workflows/:id/history` → `{snapshots:[{rev,at,actor,title,bodyBytes}]}`.
- Rollback: `POST /mission/workflows/:id/rollback {toRev}` after two-step ConfirmButton; then re-fetch doc+history.

## Rev-conflict guard (requirement 3)

On load, remember `loadedRev = doc?.rev ?? 0` (0 = un-stored default). Save is a two-step in the
component: (1) re-`GET /mission/workflows/:id`; if `(fresh.doc?.rev ?? 0) !== loadedRev` ⇒ REFUSE:
conflict banner "Doc changed (rev X → Y, by <kind>) — Reload to continue", draft kept in the editor
until Reload is clicked (no overwrite-anyway option, per contract); (2) else POST, then set
`loadedRev = saved.doc.rev`, baseline = draft (dirty cleared). The check is pure
(`checkRevConflict(loadedRev, freshDoc)` in the lib) and unit-tested; the TOCTOU window between
re-GET and POST is accepted (server has no expectedRev and core is frozen).

## Pure lib + tests (requirement 7)

`web/src/lib/mission-process.ts`: `groupWorkflows(workflows, defaults)` (namespace grouper, fixed
order, unknown→other, sorted rows, stored|default kind) · `parseCaseIndex(body)` (row regex,
em-dash tolerant) · `splitRenderedPreamble(rendered)` · `checkRevConflict(loadedRev, doc)`.
Vitest: `web/src/lib/__tests__/mission-process.test.ts` (grouping, cue parsing incl. malformed
lines, preamble split, conflict matrix incl. default→stored transition).

## Files add/change

- **add** `web/src/app/(dashboard)/mission-processes/page.tsx`
- **add** `web/src/components/mission-processes/MissionProcessesPage.tsx`, `ProcessDetail.tsx`
- **add** `web/src/lib/mission-process.ts` + `web/src/lib/__tests__/mission-process.test.ts`
- **edit** `web/src/components/layout/Sidebar.tsx` — `{ href:'/mission-processes', icon: Workflow,
  label:'Processes' }` next to Missions
- reuse: `MarkdownSplitEditor`, `errText/timeAgo/ConfirmButton` (components/memory/format.tsx),
  `.badge/.badge-*` + `btn/input/prose` global classes, cowork page frame.

## E2E (requirement 8, browser-off)

Worktree deps via `cp -al` hardlink from main checkout (read-only on main). `next dev` on a
lsof-verified free port with `NEXT_PUBLIC_LOCAL_API_PORT=3100`. Evidence (commands+output):
(a) `GET /mission-processes` → 200 + page shell; (b) live `GET /mission/workflows` (x-api-key from
`~/.lm-assist/api-token`, value never echoed) → 29+ docs incl. case.*; (c) `controller.pass` →
rendered starts with `⟦INVARIANTS`; (d) scratch doc **case.e2e-ui-probe** only: create (SITUATION/
RECOGNIZE/HANDLE/SOURCE placeholder) → edit → rev bump → history rows → rollback {toRev:1} restores
rev1 body — replaying the exact request sequence the UI issues (same paths/bodies), since browser
tools are off; rev-guard logic covered by vitest. No real playbook is ever written.
