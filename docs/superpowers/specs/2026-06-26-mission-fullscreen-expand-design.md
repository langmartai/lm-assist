# Mission UI — Expand large elements to full-screen

**Status:** Approved design (2026-06-26)

## Goal

On the mission page, any large-content element can be **maximized to a full-screen
overlay** for comfortable viewing/editing and collapsed back. A single reusable
overlay primitive serves every element (the user confirmed "all").

## Scope — which elements

1. **Editable text fields** in `MissionDetailView` — Objective, Plan, Next steps.
2. **Mission chat** in `MissionDetailView` — the live controller conversation (`MissionSessionChat`).
3. **Executor / session view** — the `CcrCloudView` (cloud) / `MissionSessionChat` (native)
   rendered in a mission session tab in `MissionsPage`.

## Architecture — one reusable overlay primitive

### `FullScreenOverlay.tsx` (new)
- Presentational overlay rendered via `createPortal(…, document.body)` so it escapes the
  tab's scroll container and covers the whole viewport **including the left nav**.
- `position: fixed; inset: 0; z-index: 9990` (below the 9999 auth `SessionExpiredOverlay`),
  background `var(--color-bg-root)`.
- Header bar: a title (left) + a **collapse** button (`Minimize2`, right).
- Closes on the collapse button **or `Esc`**. Body scroll locked (`document.body.style.overflow='hidden'`) while open, restored on close/unmount.
- Props: `{ title: ReactNode; onClose: () => void; headerExtra?: ReactNode; children: ReactNode }`.
  `headerExtra` hosts per-element header controls (e.g. the text-field Save button + toggle).
- Also exports **`ExpandIconButton`** — a ghost `Maximize2` icon button used as the affordance
  on each element. Props `{ onClick; title? }`.

### State
- One `expanded` value per host component:
  - `MissionDetailView`: `null | 'objective' | 'plan' | 'nextSteps' | 'chat'`.
  - `MissionsPage` session tab: a boolean per active session tab.
- Only one overlay open at a time per host.

## Expanded content per element

### Text fields → `MarkdownSplitEditor.tsx` (new)
- Props: `{ value: string; onChange: (v: string) => void; previewTransform?: (v: string) => string; mono?: boolean }`.
- Layout: left = a large editable `<textarea>` (fills height); right = live Markdown
  preview via `react-markdown` + `remark-gfm` (already in the app, used by the chat).
- A segmented **Edit / Split / Preview** toggle (default **Split**) controls which panes show.
- **Next steps** passes `previewTransform = (v) => v.split('\n').filter(Boolean).map(s => '- ' + s).join('\n')`
  so the bullet list renders; Objective/Plan use identity.
- **Edit-sync (critical):** the overlay textarea is bound to the **same** `draft` state and
  setters the inline textareas already use (e.g. `value={d.plan}`,
  `onChange={(v) => setDraft(p => ({ ...(p ?? d), plan: v }))}`). No separate copy ⇒ dirty
  tracking, the existing **Save** button, and the 5s-poll "keep my edits" guard all work
  unchanged, and collapsing preserves edits. The overlay's `headerExtra` renders the existing
  Save button + "saved" indicator so the user can save without collapsing.

### Mission chat → existing `MissionSessionChat`
- Rendered full-size inside the overlay with `heightFill` (already supported) and the same
  `missionTag`. Typing/sending unchanged.

### Executor / session view → existing `CcrCloudView` / `MissionSessionChat`
- A floating `ExpandIconButton` in the session tab content wrapper (top-right) opens the overlay.
- The overlay renders the same view filling the space.
- **`CcrCloudView` gains an optional `fill?: boolean` prop:** when true the outer card uses
  `flex: 1; height: 100%; maxHeight: none` (and drops `marginTop`) instead of the default
  `maxHeight: 520`, so it grows to fill the overlay. Inline (non-overlay) usage is unchanged
  (prop defaults to false). The native case uses `MissionSessionChat heightFill`.

## Files

| File | Change |
|------|--------|
| `web/src/components/missions/FullScreenOverlay.tsx` | **new** — overlay portal + `ExpandIconButton` |
| `web/src/components/missions/MarkdownSplitEditor.tsx` | **new** — split editor + markdown preview |
| `web/src/components/missions/MissionDetailView.tsx` | expand buttons on Objective/Plan/Next-steps/chat; render overlay for the active one |
| `web/src/components/missions/MissionsPage.tsx` | expand button in the session tab; render overlay around the session view |
| `web/src/components/ccr/CcrCloudView.tsx` | add optional `fill?: boolean` prop |

## Interaction defaults

- One overlay at a time per host.
- Open via the subtle ghost maximize icon on the element.
- Close via the collapse button **or `Esc`**.
- Full-viewport portal over the nav; body scroll locked while open.
- The affordance is a ghost icon so it doesn't clutter the compact layout.

## Testing

No web unit-test runner exists, so verification is **in-browser on the dev web (`:3948`)** via
the Chrome MCP (LAN IP + injected `lanAccessToken`, per the dev-web-browser-testing note):
1. Open a mission tab; click the maximize icon on Objective/Plan/Next-steps → overlay opens
   full-viewport, Edit/Split/Preview toggle works, edits flow to the inline field, Save works,
   Esc + collapse button close it, edits persist.
2. Maximize the Mission chat → full-screen chat renders + can send.
3. Open a session tab, maximize → `CcrCloudView` fills the viewport (not capped at 520).
4. Confirm no regression to inline (non-expanded) rendering.
