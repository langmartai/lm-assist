# Mission Dashboard Enhancements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Mission Graph dashboard richer + directly customizable — text search, comprehensive fetch-on-click node detail (full mission + relationships + history + sub-3 scheduling state), a friendly filter editor (dropdowns + Save-as-view) that subsumes the quick-chips, and tag/attribute surfacing on BOTH the dashboard and the Missions page.

**Architecture:** Web-only; reuses the SVG `DagGraph`, the sub-4 adapter/hooks, and existing mission APIs (no backend change). Pure helpers (`matchesSearch`, `buildFilter`) are TDD'd; a new `useMissionDetail` hook fetches the full mission + schedule + sessions on click; the detail panel and a new filter editor consume them.

**Tech Stack:** Next.js 16 / React 19 / Tailwind v4. Tests: **vitest** (`web/src/lib/__tests__/`), `import { test, expect } from 'vitest'`.

## Global Constraints

- **Tests:** pure helpers TDD'd via vitest. Run ONE file: `cd /home/ubuntu/lm-assist/web && npx vitest run src/lib/__tests__/mission-graph-adapter.test.ts`. React/hooks are `tsc --noEmit`-clean + browser-smoke (no component test runner).
- **`tsc` check (per task touching .tsx/.ts):** `cd /home/ubuntu/lm-assist/web && npx tsc --noEmit 2>&1 | grep -E "<changed file basename>" || echo "CLEAN"`. Pre-existing unrelated tsc errors elsewhere are out of scope; NONE may name your changed files.
- **API:** `useAppMode()` → `{ apiClient, proxy }`. `apiClient.fetchPath<T>(path, { method?, body?, machineId })` returns the UNWRAPPED `data` payload (Core wraps `{success,data}`). ALWAYS pass `machineId: proxy.machineId || undefined`. `GET /mission/:id` → the raw `Mission`. `POST /mission/schedule` (body `{}`) → `{ready,blocked,serializeGroups,epicRollups,containers}`. `GET /mission/:id/sessions` → bound sessions. `POST /mission/graph` (body `{filter?,expand?}`) → `{nodes,edges}`. `POST /mission/views` (body `{id?,name,query:{filter,expand},display}`) → the saved `MissionView`. `GET /mission/views` → `{views}`.
- **No backend change. No new dependency.** Stage ONLY the files each task names (never `git add -A` — the tree has unrelated untracked files).
- **Node:** the subagent shell default (18) runs vitest + tsc fine. The controller does the `nvm use 20` browser-smoke.
- **Build order:** Phase 1 (Tasks 1–6, info richness) then Phase 2 (Tasks 7–8, filter editor). Each task ends shippable.

---

## File Structure

- **Create:** `web/src/hooks/useMissionDetail.ts`; `web/src/components/missions/dashboard/{MissionSearchBox,MissionFilterEditor}.tsx`.
- **Modify:** `web/src/lib/mission-graph-types.ts` (+`MissionFull`/`MissionChange`); `web/src/lib/mission-graph-adapter.ts` (+`matchesSearch`,`buildFilter`); `web/src/lib/__tests__/mission-graph-adapter.test.ts`; `web/src/components/missions/dashboard/{MissionNodeDetail,MissionDashboardPage,MissionGraphCanvas}.tsx`; `web/src/hooks/useMissionViews.ts` (+`saveView`); `web/src/components/missions/{MissionsPage,MissionDetailView}.tsx` (tags). The standalone `MissionQuickFilters` usage is removed in Task 8 (file can stay on disk, unused).

---

### Task 1: Pure helpers + types (`matchesSearch`, `buildFilter`, `MissionFull`)

**Files:**
- Modify: `web/src/lib/mission-graph-types.ts`, `web/src/lib/mission-graph-adapter.ts`
- Test: `web/src/lib/__tests__/mission-graph-adapter.test.ts`

**Interfaces:**
- Produces: `matchesSearch(node: MissionNode, query: string): boolean`; `buildFilter(state): { filter: MissionFilter[]; expand?: {direction?:string;depth?:number} }`; types `MissionFull`, `MissionChange`.

- [ ] **Step 1: Add the types** to `web/src/lib/mission-graph-types.ts` (append):

```ts
export interface MissionChange { rev: number; at: number; actor: { kind: string; channel: string; label?: string; id?: string | null }; changes: Record<string, { from: unknown; to: unknown }>; }
export interface MissionFull {
  id: string; title: string; status: string;
  objective?: string; plan?: string; nextSteps?: string[];
  tags?: Record<string, string[]>; parentId?: string | null; dependsOn?: string[];
  progress?: { percent?: number; summary?: string } | null;
  history?: MissionChange[];
}
```

- [ ] **Step 2: Write the failing tests** — append to `web/src/lib/__tests__/mission-graph-adapter.test.ts` (it already imports from vitest + has a node builder; add these imports/tests; if a node builder named `mn` is absent, define it):

```ts
import { matchesSearch, buildFilter } from '@/lib/mission-graph-adapter';

const node = (over: Partial<import('@/lib/mission-graph-types').MissionNode> = {}) =>
  ({ id: 'm1', title: 'Auth epic', status: 'active', tags: { project: ['web'] }, parentId: null, ...over });

test('matchesSearch: empty query matches all', () => {
  expect(matchesSearch(node() as any, '')).toBe(true);
});
test('matchesSearch: ANDs space-separated terms over title/id/status/tags', () => {
  expect(matchesSearch(node() as any, 'auth web')).toBe(true);   // title + tag value
  expect(matchesSearch(node() as any, 'auth missing')).toBe(false);
  expect(matchesSearch(node() as any, 'active')).toBe(true);     // status
  expect(matchesSearch(node({ id: 'mission_abc' }) as any, 'abc')).toBe(true); // id
});
test('buildFilter: status + tags → MissionFilter[] with op:in', () => {
  const r = buildFilter({ statuses: ['active', 'done'], tags: { project: ['web'] } });
  expect(r.filter).toContainEqual({ field: 'status', op: 'in', value: ['active', 'done'] });
  expect(r.filter).toContainEqual({ field: 'tags.project', op: 'in', value: ['web'] });
  expect(r.expand).toBeUndefined();
});
test('buildFilter: empty selections → empty filter; direction none → no expand', () => {
  expect(buildFilter({}).filter).toEqual([]);
  expect(buildFilter({ expand: { direction: 'none', depth: 2 } }).expand).toBeUndefined();
});
test('buildFilter: a real direction → expand with depth default 1', () => {
  expect(buildFilter({ expand: { direction: 'dependencies' } }).expand).toEqual({ direction: 'dependencies', depth: 1 });
});
```

- [ ] **Step 3: Run to confirm fail** — `cd /home/ubuntu/lm-assist/web && npx vitest run src/lib/__tests__/mission-graph-adapter.test.ts 2>&1 | tail -8`. Expected: FAIL (`matchesSearch`/`buildFilter` not exported).

- [ ] **Step 4: Implement** — append to `web/src/lib/mission-graph-adapter.ts`:

```ts
/** Space-separated terms ANDed; each matches case-insensitively against title/id/status/tag values. */
export function matchesSearch(node: MissionNode, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const tagVals = Object.values(node.tags ?? {}).flat().join(' ');
  const hay = `${node.title} ${node.id} ${node.status} ${tagVals}`.toLowerCase();
  return q.split(/\s+/).every((term) => hay.includes(term));
}

/** Build a server MissionFilter[] + expand from the friendly filter-editor state (status/tag multi-selects + expand). */
export function buildFilter(state: {
  statuses?: string[];
  tags?: Record<string, string[]>;
  expand?: { direction?: string; depth?: number };
}): { filter: MissionFilter[]; expand?: { direction?: string; depth?: number } } {
  const filter: MissionFilter[] = [];
  if (state.statuses?.length) filter.push({ field: 'status', op: 'in', value: state.statuses });
  if (state.tags) for (const [dim, vals] of Object.entries(state.tags)) {
    if (vals.length) filter.push({ field: `tags.${dim}`, op: 'in', value: vals });
  }
  const dir = state.expand?.direction;
  const expand = dir && dir !== 'none' ? { direction: dir, depth: state.expand?.depth ?? 1 } : undefined;
  return { filter, expand };
}
```

- [ ] **Step 5: Run to confirm pass** — `cd /home/ubuntu/lm-assist/web && npx vitest run src/lib/__tests__/mission-graph-adapter.test.ts 2>&1 | tail -6`. Expected: all PASS.

- [ ] **Step 6: Commit** — `cd /home/ubuntu/lm-assist && git add web/src/lib/mission-graph-types.ts web/src/lib/mission-graph-adapter.ts web/src/lib/__tests__/mission-graph-adapter.test.ts && git commit -m "feat(web): mission dashboard search + filter-builder pure helpers + MissionFull type"`

---

### Task 2: `useMissionDetail` hook (fetch full mission + schedule + sessions)

**Files:**
- Create: `web/src/hooks/useMissionDetail.ts`

**Interfaces:**
- Consumes: `useAppMode` (`{apiClient, proxy}`); `MissionFull` from `@/lib/mission-graph-types`.
- Produces (Task 3 imports): `useMissionDetail(id: string | null): { mission: MissionFull|null, schedule: ScheduleData|null, sessions: SessionInfo[], loading, error }`.

- [ ] **Step 1: Create the hook** — `web/src/hooks/useMissionDetail.ts`:

```ts
'use client';
import { useState, useEffect } from 'react';
import { useAppMode } from '@/contexts/AppModeContext';
import type { MissionFull } from '@/lib/mission-graph-types';

export type ScheduleData = {
  ready: string[];
  blocked: { id: string; reason: string; waitOn?: string[] }[];
  serializeGroups: { group: string; missionIds: string[]; running: string | null }[];
  epicRollups: { parentId: string; status: string; progressPercent: number; childCount: number; doneCount: number }[];
  containers: string[];
};
export type SessionInfo = { sid: string; status?: string; transport?: string; node?: string | null };

export function useMissionDetail(id: string | null) {
  const { apiClient, proxy } = useAppMode();
  const [mission, setMission] = useState<MissionFull | null>(null);
  const [schedule, setSchedule] = useState<ScheduleData | null>(null);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) { setMission(null); setSchedule(null); setSessions([]); setError(null); return; }
    let cancelled = false;
    setLoading(true); setError(null);
    const mid = proxy.machineId || undefined;
    Promise.all([
      apiClient.fetchPath<MissionFull>(`/mission/${encodeURIComponent(id)}`, { machineId: mid }),
      apiClient.fetchPath<ScheduleData>('/mission/schedule', { method: 'POST', body: {}, machineId: mid }).catch(() => null),
      apiClient.fetchPath<unknown>(`/mission/${encodeURIComponent(id)}/sessions`, { machineId: mid }).catch(() => null),
    ]).then(([m, sch, sessRaw]) => {
      if (cancelled) return;
      setMission(m ?? null);
      setSchedule(sch ?? null);
      // sessions route shape is best-effort: accept an array or {sessions:[...]}
      const arr = Array.isArray(sessRaw) ? sessRaw : ((sessRaw as { sessions?: SessionInfo[] })?.sessions ?? []);
      setSessions(arr as SessionInfo[]);
    }).catch((e) => { if (!cancelled) setError((e as Error).message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [id, apiClient, proxy.machineId]);

  return { mission, schedule, sessions, loading, error };
}
```

- [ ] **Step 2: Type-check** — `cd /home/ubuntu/lm-assist/web && npx tsc --noEmit 2>&1 | grep useMissionDetail || echo "CLEAN: useMissionDetail.ts"`. Expected: CLEAN.

- [ ] **Step 3: Commit** — `cd /home/ubuntu/lm-assist && git add web/src/hooks/useMissionDetail.ts && git commit -m "feat(web): useMissionDetail — fetch full mission + schedule + sessions on click"`

---

### Task 3: Comprehensive `MissionNodeDetail`

**Files:**
- Modify: `web/src/components/missions/dashboard/MissionNodeDetail.tsx` (full rewrite)

**Interfaces:**
- Consumes: `useMissionDetail` (Task 2); `MissionEdge` from `@/lib/mission-graph-types`.
- Produces (Task 4 imports): `MissionNodeDetail({ nodeId, edges, onSelect, onClose })` — `nodeId: string|null`, `edges: MissionEdge[]`, `onSelect: (id:string|null)=>void`, `onClose: ()=>void`.

- [ ] **Step 1: Rewrite the file** — `web/src/components/missions/dashboard/MissionNodeDetail.tsx`:

```tsx
'use client';
import Link from 'next/link';
import { useMissionDetail } from '@/hooks/useMissionDetail';
import type { MissionEdge } from '@/lib/mission-graph-types';

const STATUS_COLOR: Record<string, string> = {
  active: '#34d399', waiting: '#fbbf24', paused: '#9ca3af', blocked: '#f87171', done: '#60a5fa', failed: '#ef4444', draft: '#6b7280',
};

function rel(ts: number): string {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return `${Math.floor(s)}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function MissionNodeDetail({ nodeId, edges, onSelect, onClose }: {
  nodeId: string | null;
  edges: MissionEdge[];
  onSelect: (id: string | null) => void;
  onClose: () => void;
}) {
  const { mission, schedule, sessions, loading } = useMissionDetail(nodeId);
  if (!nodeId) return null;

  // relationships from the loaded graph edges (parent edge = {from:parentId,to:childId}; dependsOn = {from:me,to:dep})
  const children = edges.filter((e) => e.type === 'parent' && e.from === nodeId).map((e) => e.to);
  const dependents = edges.filter((e) => e.type === 'dependsOn' && e.to === nodeId).map((e) => e.from);
  const parentId = mission?.parentId ?? null;
  const dependsOn = mission?.dependsOn ?? [];

  // this mission's scheduling state
  const blocked = schedule?.blocked.find((b) => b.id === nodeId);
  const serial = schedule?.serializeGroups.find((g) => g.missionIds.includes(nodeId));
  const epic = schedule?.epicRollups.find((r) => r.parentId === nodeId);
  const sched = blocked ? `Blocked: ${blocked.reason}${blocked.waitOn?.length ? ` (waiting on ${blocked.waitOn.join(', ')})` : ''}`
    : schedule?.ready.includes(nodeId) ? 'Ready'
    : epic ? `Epic: ${epic.doneCount}/${epic.childCount} done`
    : serial ? `Serialized in "${serial.group}"${serial.running && serial.running !== nodeId ? ' (queued)' : ''}`
    : null;

  const Chip = ({ id }: { id: string }) => (
    <button onClick={() => onSelect(id)} className="rounded border border-neutral-700 px-1.5 py-0.5 text-[11px] text-blue-300 hover:border-blue-400 hover:text-blue-200" title={id}>{id}</button>
  );

  return (
    <div className="w-80 shrink-0 overflow-y-auto border-l border-neutral-800 p-4 text-sm">
      <div className="mb-2 flex items-start justify-between gap-2">
        <h3 className="font-semibold text-neutral-100">{mission?.title ?? nodeId}</h3>
        <button onClick={onClose} className="shrink-0 text-neutral-500 hover:text-neutral-200">✕</button>
      </div>
      <div className="mb-3 flex items-center gap-2 text-xs">
        <span className="rounded px-1.5 py-0.5" style={{ background: (STATUS_COLOR[mission?.status ?? ''] ?? '#6b7280') + '33', color: STATUS_COLOR[mission?.status ?? ''] ?? '#9ca3af' }}>{mission?.status ?? '…'}</span>
        {mission?.progress?.percent != null && <span className="text-neutral-400">{mission.progress.percent}%</span>}
        {sched && <span className="text-neutral-400">· {sched}</span>}
      </div>
      {loading && !mission && <div className="text-xs text-neutral-500">Loading…</div>}

      {mission?.objective && <Section title="Objective"><p className="text-neutral-300">{mission.objective}</p></Section>}
      {mission?.plan && <Section title="Plan"><p className="whitespace-pre-wrap text-neutral-300">{mission.plan}</p></Section>}
      {mission?.nextSteps?.length ? <Section title="Next steps"><ul className="list-disc pl-4 text-neutral-300">{mission.nextSteps.map((s, i) => <li key={i}>{s}</li>)}</ul></Section> : null}

      {mission?.tags && Object.keys(mission.tags).length > 0 && (
        <Section title="Tags">
          <div className="space-y-1">
            {Object.entries(mission.tags).map(([dim, vals]) => (
              <div key={dim} className="flex flex-wrap items-center gap-1 text-xs">
                <span className={dim.startsWith('ctl:') ? 'text-amber-400' : 'text-neutral-500'}>{dim}{dim.startsWith('ctl:') ? ' (controller)' : ''}:</span>
                {vals.map((v) => <span key={v} className="rounded bg-neutral-800 px-1.5 py-0.5 text-neutral-200">{v}</span>)}
              </div>
            ))}
          </div>
        </Section>
      )}

      {(parentId || dependsOn.length || children.length || dependents.length) ? (
        <Section title="Relationships">
          <div className="space-y-1 text-xs">
            {parentId && <div className="flex flex-wrap items-center gap-1"><span className="text-neutral-500">parent:</span> <Chip id={parentId} /></div>}
            {dependsOn.length > 0 && <div className="flex flex-wrap items-center gap-1"><span className="text-neutral-500">depends on:</span> {dependsOn.map((d) => <Chip key={d} id={d} />)}</div>}
            {dependents.length > 0 && <div className="flex flex-wrap items-center gap-1"><span className="text-neutral-500">blocks:</span> {dependents.map((d) => <Chip key={d} id={d} />)}</div>}
            {children.length > 0 && <div className="flex flex-wrap items-center gap-1"><span className="text-neutral-500">children:</span> {children.map((d) => <Chip key={d} id={d} />)}</div>}
          </div>
        </Section>
      ) : null}

      {mission?.history?.length ? (
        <Section title="Recent changes">
          <div className="space-y-1 text-[11px] text-neutral-400">
            {mission.history.slice(-5).reverse().map((h) => (
              <div key={h.rev}>r{h.rev} · {h.actor?.label ?? h.actor?.kind ?? 'unknown'} · {rel(h.at)} · {Object.keys(h.changes ?? {}).join(', ')}</div>
            ))}
          </div>
        </Section>
      ) : null}

      {sessions.length > 0 && (
        <Section title="Sessions">
          <div className="space-y-1 text-[11px] text-neutral-400">{sessions.map((s) => <div key={s.sid}>{s.sid.slice(0, 12)} · {s.status ?? s.transport ?? ''}</div>)}</div>
        </Section>
      )}

      <Link href={`/missions?mission=${encodeURIComponent(nodeId)}`} className="mt-3 inline-block text-xs text-blue-400 hover:underline">Open in Missions →</Link>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mt-3 border-t border-neutral-800 pt-2">
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-neutral-500">{title}</div>
      {children}
    </div>
  );
}
```

- [ ] **Step 2: Type-check** — `cd /home/ubuntu/lm-assist/web && npx tsc --noEmit 2>&1 | grep MissionNodeDetail || echo "CLEAN: MissionNodeDetail.tsx"`. Expected: CLEAN. (It will be wired into the page in Task 4 — the page still passes the OLD props until then, so a transient type mismatch in MissionDashboardPage.tsx is expected and fixed in Task 4. Confirm only MissionNodeDetail.tsx itself is clean here.)

- [ ] **Step 3: Commit** — `cd /home/ubuntu/lm-assist && git add web/src/components/missions/dashboard/MissionNodeDetail.tsx && git commit -m "feat(web): comprehensive mission node detail (full mission + relationships + scheduling + history + sessions)"`

---

### Task 4: `MissionSearchBox` + dashboard Phase-1 wiring

**Files:**
- Create: `web/src/components/missions/dashboard/MissionSearchBox.tsx`
- Modify: `web/src/components/missions/dashboard/MissionDashboardPage.tsx`

**Interfaces:**
- Consumes: `matchesSearch` (Task 1); `MissionNodeDetail({nodeId,edges,onSelect,onClose})` (Task 3); existing `MissionViewPicker`/`MissionQuickFilters`/`MissionGraphCanvas`/`useMissionViews`/`useMissionGraph`/`applyQuickFilters`.

- [ ] **Step 1: Create `MissionSearchBox.tsx`**:

```tsx
'use client';
export function MissionSearchBox({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="border-b border-neutral-800 p-3">
      <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-400">Search</div>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="title, id, status, tags… (space = AND)"
        className="w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs text-neutral-100 placeholder:text-neutral-600"
      />
    </div>
  );
}
```

- [ ] **Step 2: Rewrite `MissionDashboardPage.tsx`** (adds search state + header summary; passes `nodeId`+`edges` to the new detail; applies `matchesSearch`):

```tsx
'use client';
import { useMemo, useState } from 'react';
import { useMissionViews } from '@/hooks/useMissionViews';
import { useMissionGraph, type GraphSource } from '@/hooks/useMissionGraph';
import { applyQuickFilters, matchesSearch } from '@/lib/mission-graph-adapter';
import { MissionGraphCanvas } from './MissionGraphCanvas';
import { MissionViewPicker } from './MissionViewPicker';
import { MissionQuickFilters } from './MissionQuickFilters';
import { MissionSearchBox } from './MissionSearchBox';
import { MissionNodeDetail } from './MissionNodeDetail';

export function MissionDashboardPage() {
  const { views, loading: viewsLoading, refresh: refreshViews } = useMissionViews();
  const [activeId, setActiveId] = useState<string | null>(null);
  const [statuses, setStatuses] = useState<string[]>([]);
  const [tags, setTags] = useState<Record<string, string[]>>({});
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const source: GraphSource = activeId ? { viewId: activeId } : {};
  const { graph, view, loading, error, refresh } = useMissionGraph(source);

  const rawNodes = graph?.nodes ?? [];
  const filteredNodes = useMemo(
    () => applyQuickFilters(rawNodes, { statuses, tags }).filter((n) => matchesSearch(n, search)),
    [rawNodes, statuses, tags, search],
  );
  const nodeIds = useMemo(() => new Set(filteredNodes.map((n) => n.id)), [filteredNodes]);
  const filteredEdges = useMemo(() => (graph?.edges ?? []).filter((e) => nodeIds.has(e.from) && nodeIds.has(e.to)), [graph, nodeIds]);

  const toggleStatus = (s: string) => setStatuses((cur) => (cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s]));
  const toggleTag = (dim: string, val: string) => setTags((cur) => {
    const vals = cur[dim] ?? [];
    const next = vals.includes(val) ? vals.filter((x) => x !== val) : [...vals, val];
    const out = { ...cur, [dim]: next };
    if (next.length === 0) delete out[dim];
    return out;
  });
  const selectView = (id: string | null) => { setActiveId(id); setSelectedId(null); setStatuses([]); setTags({}); setSearch(''); };

  const activeView = views.find((v) => v.id === activeId);
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-3 border-b border-neutral-800 px-4 py-2 text-xs text-neutral-400">
        <span className="font-semibold text-neutral-200">Mission Graph</span>
        <span>{filteredNodes.length} shown / {rawNodes.length} total</span>
        <span>· {activeView ? activeView.name : 'ad-hoc'}</span>
        {view?.display?.groupBy && <span>· grouped by {view.display.groupBy}</span>}
        <button onClick={() => { refreshViews(); refresh(); }} className="ml-auto text-neutral-400 hover:text-neutral-100" disabled={loading}>↻ Refresh</button>
      </div>
      <div className="flex min-h-0 flex-1">
        <div className="flex w-64 shrink-0 flex-col overflow-y-auto border-r border-neutral-800">
          <MissionViewPicker views={views} activeId={activeId} onSelect={selectView} onRefresh={() => { refreshViews(); refresh(); }} loading={viewsLoading} />
          <MissionSearchBox value={search} onChange={setSearch} />
          <MissionQuickFilters nodes={rawNodes} statuses={statuses} onToggleStatus={toggleStatus} tags={tags} onToggleTag={toggleTag} />
        </div>
        <div className="relative flex-1">
          {loading && <div className="absolute left-2 top-2 z-10 text-xs text-neutral-500">Loading…</div>}
          {error && <div className="absolute left-2 top-2 z-10 text-xs text-red-400">{error}</div>}
          <MissionGraphCanvas nodes={filteredNodes} edges={filteredEdges} display={view?.display} selectedId={selectedId} onSelect={setSelectedId} />
        </div>
        <MissionNodeDetail nodeId={selectedId} edges={graph?.edges ?? []} onSelect={setSelectedId} onClose={() => setSelectedId(null)} />
      </div>
    </div>
  );
}
```

(Note: the detail gets the FULL `graph?.edges` — not the search-narrowed `filteredEdges` — so relationship chips work even when a related mission is filtered out of view.)

- [ ] **Step 2b: Type-check** — `cd /home/ubuntu/lm-assist/web && npx tsc --noEmit 2>&1 | grep -E "MissionDashboardPage|MissionSearchBox|MissionNodeDetail" || echo "CLEAN"`. Expected: CLEAN (the Task-3 detail props now match).

- [ ] **Step 3: Commit** — `cd /home/ubuntu/lm-assist && git add web/src/components/missions/dashboard/MissionSearchBox.tsx web/src/components/missions/dashboard/MissionDashboardPage.tsx && git commit -m "feat(web): dashboard search box + header summary + wire comprehensive detail"`

---

### Task 5: Tags/attributes on the Missions page

**Files:**
- Modify: `web/src/components/missions/MissionsPage.tsx`, `web/src/components/missions/MissionDetailView.tsx`

**Interfaces:** read-only display of `tags`/`parentId`/`dependsOn`. No new exports.

- [ ] **Step 1: Add fields to the web `Mission` interface** in `MissionsPage.tsx` (the `interface Mission {` block ~line 91). Add these two lines (after `dependsOn: string[];`):

```ts
  tags: Record<string, string[]>;
  parentId: string | null;
```

- [ ] **Step 2: Extend the keyword-search haystack** in `MissionsPage.tsx` (~line 264). Replace:

```ts
      const hay = `${m.title} ${m.objective} ${m.id} ${m.status}`.toLowerCase();
```
with:
```ts
      const tagValues = Object.values(m.tags ?? {}).flat().join(' ');
      const hay = `${m.title} ${m.objective} ${m.id} ${m.status} ${tagValues}`.toLowerCase();
```

- [ ] **Step 3: Add a tag-chips row to `renderMissionItem`.** In `MissionsPage.tsx`, find the meta row that renders `m.env.isolation`/`m.id` (~line 1293-1303, inside `renderMissionItem`). Immediately AFTER that meta row's closing `</div>`, insert:

```tsx
                    {(Object.keys(m.tags ?? {}).length > 0 || m.parentId || (m.dependsOn?.length ?? 0) > 0) && (
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 4, fontSize: 10 }}>
                        {Object.entries(m.tags ?? {}).flatMap(([dim, vals]) => vals.map((v) => (
                          <span key={`${dim}:${v}`} style={{ background: dim.startsWith('ctl:') ? 'var(--color-bg-elevated, #1e293b)' : 'var(--color-bg-surface, #0f172a)', color: dim.startsWith('ctl:') ? '#fbbf24' : 'var(--color-text-tertiary, #94a3b8)', border: '1px solid var(--color-border, #334155)', borderRadius: 4, padding: '1px 5px' }} title={dim}>{dim.replace(/^ctl:/, '')}: {v}</span>
                        )))}
                        {m.parentId && <span style={{ color: 'var(--color-text-tertiary, #94a3b8)' }} title={`parent ${m.parentId}`}>↑ parent</span>}
                        {(m.dependsOn?.length ?? 0) > 0 && <span style={{ color: 'var(--color-text-tertiary, #94a3b8)' }} title={m.dependsOn.join(', ')}>⛓ {m.dependsOn.length} dep</span>}
                      </div>
                    )}
```

(Match the surrounding inline-style convention used in `renderMissionItem`.)

- [ ] **Step 4: Add tags/relationships to `MissionDetailView.tsx`.** First add to the `interface MissionDetail {` block (~line 42): `tags?: Record<string, string[]>; parentId?: string | null; dependsOn?: string[];`. Then in Section 1 (editable fields, ~after the Next-steps field, before the Save row, ~line 420), insert a read-only block:

```tsx
        {(mission.tags && Object.keys(mission.tags).length > 0) || mission.parentId || (mission.dependsOn?.length ?? 0) > 0 ? (
          <div style={{ marginTop: 8, fontSize: 11, color: 'var(--color-text-secondary)' }}>
            {Object.entries(mission.tags ?? {}).map(([dim, vals]) => (
              <div key={dim} style={{ marginBottom: 2 }}><span style={{ color: dim.startsWith('ctl:') ? '#fbbf24' : 'var(--color-text-tertiary)' }}>{dim}:</span> {vals.join(', ')}</div>
            ))}
            {mission.parentId && <div>parent: {mission.parentId}</div>}
            {(mission.dependsOn?.length ?? 0) > 0 && <div>depends on: {mission.dependsOn!.join(', ')}</div>}
          </div>
        ) : null}
```

(Use `mission` or whatever the in-scope mission variable is named in `MissionDetailView` — confirm the variable name when editing.)

- [ ] **Step 5: Type-check** — `cd /home/ubuntu/lm-assist/web && npx tsc --noEmit 2>&1 | grep -E "MissionsPage|MissionDetailView" || echo "CLEAN"`. Expected: CLEAN.

- [ ] **Step 6: Commit** — `cd /home/ubuntu/lm-assist && git add web/src/components/missions/MissionsPage.tsx web/src/components/missions/MissionDetailView.tsx && git commit -m "feat(web): surface tags + parent/dependsOn on the Missions page list + detail + search"`

---

### Task 6: Dashboard card tag indicator

**Files:**
- Modify: `web/src/components/missions/dashboard/MissionGraphCanvas.tsx`

- [ ] **Step 1: Add a compact tag indicator to the card.** In `MissionGraphCanvas.tsx`, inside `renderNode`, the card currently renders a title `<div>` then a fields row. Add a third line showing the groupBy value (when set) else a tag-count, after the fields row `<div>` (inside the card div). Replace the fields-row block:

```tsx
          <div className="mt-0.5 flex flex-wrap gap-1 text-[10px] text-neutral-400">
            {fields.map((f) => (
              <span key={f}>{f === 'status' ? String(node.metadata.status) : f === 'progress' ? `${node.metadata.progressPercent ?? 0}%` : String((node.metadata as Record<string, unknown>)[f] ?? '')}</span>
            ))}
          </div>
```
with (adds a tag indicator line):
```tsx
          <div className="mt-0.5 flex flex-wrap gap-1 text-[10px] text-neutral-400">
            {fields.map((f) => (
              <span key={f}>{f === 'status' ? String(node.metadata.status) : f === 'progress' ? `${node.metadata.progressPercent ?? 0}%` : String((node.metadata as Record<string, unknown>)[f] ?? '')}</span>
            ))}
            {(() => {
              const t = node.metadata.tags as Record<string, string[]> | undefined;
              const count = t ? Object.values(t).reduce((a, v) => a + v.length, 0) : 0;
              const gb = display?.groupBy ? (t?.[display.groupBy] ?? [])[0] : null;
              return gb ? <span className="text-neutral-500">#{gb}</span> : count > 0 ? <span className="text-neutral-600">🏷{count}</span> : null;
            })()}
          </div>
```

- [ ] **Step 2: Type-check** — `cd /home/ubuntu/lm-assist/web && npx tsc --noEmit 2>&1 | grep MissionGraphCanvas || echo "CLEAN: MissionGraphCanvas.tsx"`. Expected: CLEAN.

- [ ] **Step 3: Commit** — `cd /home/ubuntu/lm-assist && git add web/src/components/missions/dashboard/MissionGraphCanvas.tsx && git commit -m "feat(web): compact tag indicator on mission graph cards"`

---

### Task 7: `MissionFilterEditor` + `saveView`

**Files:**
- Create: `web/src/components/missions/dashboard/MissionFilterEditor.tsx`
- Modify: `web/src/hooks/useMissionViews.ts` (+`saveView`)

**Interfaces:**
- Consumes: `MissionNode`, `MissionViewDisplay` types; the editor state shape `{ statuses, tags, expand }`.
- Produces (Task 8 imports): `MissionFilterEditor({ nodes, statuses, tags, onToggleStatus, onToggleTag, expand, onExpandChange, onReset, onSaveView })`; `useMissionViews().saveView(body)`.

- [ ] **Step 1: Add `saveView` to `useMissionViews.ts`.** Inside `useMissionViews`, after `refresh`, add (and include it in the returned object):

```ts
  const saveView = useCallback(async (body: { id?: string; name: string; query: MissionView['query']; display: MissionView['display'] }) => {
    const v = await apiClient.fetchPath<MissionView>('/mission/views', { method: 'POST', body, machineId: proxy.machineId || undefined });
    await refresh();
    return v;
  }, [apiClient, proxy.machineId, refresh]);
```
Change the return to `return { views, loading, error, refresh, saveView };`.

- [ ] **Step 2: Create `MissionFilterEditor.tsx`** (friendly dropdowns — status multi, tag-dim value multi, expand; Reset + Save-as-view):

```tsx
'use client';
import { useMemo } from 'react';
import type { MissionNode } from '@/lib/mission-graph-types';

const STATUSES = ['active', 'waiting', 'paused', 'blocked', 'done', 'failed'];
const DIRECTIONS = ['none', 'dependencies', 'dependents', 'children', 'parents', 'all'];

export type ExpandState = { direction: string; depth: number };

export function MissionFilterEditor({ nodes, statuses, tags, onToggleStatus, onToggleTag, expand, onExpandChange, onReset, onSaveView }: {
  nodes: MissionNode[];
  statuses: string[];
  tags: Record<string, string[]>;
  onToggleStatus: (s: string) => void;
  onToggleTag: (dim: string, val: string) => void;
  expand: ExpandState;
  onExpandChange: (e: ExpandState) => void;
  onReset: () => void;
  onSaveView: () => void;
}) {
  const present = useMemo(() => new Set(nodes.map((n) => n.status)), [nodes]);
  const tagDims = useMemo(() => {
    const dims = new Map<string, Set<string>>();
    for (const n of nodes) for (const [dim, vals] of Object.entries(n.tags ?? {})) {
      let set = dims.get(dim); if (!set) { set = new Set(); dims.set(dim, set); }
      for (const v of vals) set.add(v);
    }
    return [...dims.entries()].map(([dim, vals]) => ({ dim, vals: [...vals].sort() }));
  }, [nodes]);

  const chip = (on: boolean) => `rounded-full border px-2 py-0.5 text-xs ${on ? 'border-neutral-500 bg-neutral-700 text-neutral-100' : 'border-neutral-800 text-neutral-400 hover:border-neutral-600'}`;

  return (
    <div className="p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-wide text-neutral-400">Filter</span>
        <div className="flex gap-2 text-[11px]">
          <button onClick={onReset} className="text-neutral-400 hover:text-neutral-100">Reset</button>
          <button onClick={onSaveView} className="text-blue-400 hover:text-blue-300">Save as view</button>
        </div>
      </div>
      <div className="mb-1 text-[10px] uppercase tracking-wide text-neutral-500">Status</div>
      <div className="flex flex-wrap gap-1.5">
        {STATUSES.filter((s) => present.has(s)).map((s) => (
          <button key={s} onClick={() => onToggleStatus(s)} className={chip(statuses.includes(s))}>{s}</button>
        ))}
      </div>
      {tagDims.map(({ dim, vals }) => (
        <div key={dim} className="mt-2">
          <div className="mb-1 text-[10px] uppercase tracking-wide text-neutral-500">{dim}</div>
          <div className="flex flex-wrap gap-1.5">
            {vals.map((v) => <button key={v} onClick={() => onToggleTag(dim, v)} className={chip((tags[dim] ?? []).includes(v))}>{v}</button>)}
          </div>
        </div>
      ))}
      <div className="mt-3">
        <div className="mb-1 text-[10px] uppercase tracking-wide text-neutral-500">Expand (server)</div>
        <div className="flex items-center gap-1.5">
          <select value={expand.direction} onChange={(e) => onExpandChange({ ...expand, direction: e.target.value })} className="rounded border border-neutral-700 bg-neutral-900 px-1 py-0.5 text-xs text-neutral-200">
            {DIRECTIONS.map((d) => <option key={d} value={d}>{d}</option>)}
          </select>
          {expand.direction !== 'none' && (
            <select value={expand.depth} onChange={(e) => onExpandChange({ ...expand, depth: Number(e.target.value) })} className="rounded border border-neutral-700 bg-neutral-900 px-1 py-0.5 text-xs text-neutral-200">
              {[1, 2, 3].map((d) => <option key={d} value={d}>depth {d}</option>)}
            </select>
          )}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Type-check** — `cd /home/ubuntu/lm-assist/web && npx tsc --noEmit 2>&1 | grep -E "MissionFilterEditor|useMissionViews" || echo "CLEAN"`. Expected: CLEAN.

- [ ] **Step 4: Commit** — `cd /home/ubuntu/lm-assist && git add web/src/components/missions/dashboard/MissionFilterEditor.tsx web/src/hooks/useMissionViews.ts && git commit -m "feat(web): MissionFilterEditor (status/tag/expand dropdowns) + saveView hook"`

---

### Task 8: Dashboard Phase-2 wiring (filter editor replaces quick-chips; server scope + save-as-view)

**Files:**
- Modify: `web/src/components/missions/dashboard/MissionDashboardPage.tsx`

**Interfaces:** Consumes `MissionFilterEditor` + `ExpandState` (Task 7); `buildFilter` (Task 1); `useMissionViews().saveView` (Task 7); `useMissionGraph({filter,expand})`.

- [ ] **Step 1: Rewrite `MissionDashboardPage.tsx`** — replace `MissionQuickFilters` with `MissionFilterEditor`, add `expand` state, drive the server source from `buildFilter` when there's an expand/scope, and wire Save-as-view:

```tsx
'use client';
import { useMemo, useState } from 'react';
import { useMissionViews } from '@/hooks/useMissionViews';
import { useMissionGraph, type GraphSource } from '@/hooks/useMissionGraph';
import { applyQuickFilters, matchesSearch, buildFilter } from '@/lib/mission-graph-adapter';
import { MissionGraphCanvas } from './MissionGraphCanvas';
import { MissionViewPicker } from './MissionViewPicker';
import { MissionFilterEditor, type ExpandState } from './MissionFilterEditor';
import { MissionSearchBox } from './MissionSearchBox';
import { MissionNodeDetail } from './MissionNodeDetail';

export function MissionDashboardPage() {
  const { views, loading: viewsLoading, refresh: refreshViews, saveView } = useMissionViews();
  const [activeId, setActiveId] = useState<string | null>(null);
  const [statuses, setStatuses] = useState<string[]>([]);
  const [tags, setTags] = useState<Record<string, string[]>>({});
  const [expand, setExpand] = useState<ExpandState>({ direction: 'none', depth: 1 });
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // server source: a saved view, OR ad-hoc — with a server-side filter only when expand/scope is active
  const source: GraphSource = useMemo(() => {
    if (activeId) return { viewId: activeId };
    if (expand.direction !== 'none') { const { filter, expand: ex } = buildFilter({ statuses, tags, expand }); return { filter, expand: ex }; }
    return {};
  }, [activeId, expand, statuses, tags]);
  const { graph, view, loading, error, refresh } = useMissionGraph(source);

  const rawNodes = graph?.nodes ?? [];
  const filteredNodes = useMemo(
    () => applyQuickFilters(rawNodes, { statuses, tags }).filter((n) => matchesSearch(n, search)),
    [rawNodes, statuses, tags, search],
  );
  const nodeIds = useMemo(() => new Set(filteredNodes.map((n) => n.id)), [filteredNodes]);
  const filteredEdges = useMemo(() => (graph?.edges ?? []).filter((e) => nodeIds.has(e.from) && nodeIds.has(e.to)), [graph, nodeIds]);

  const toggleStatus = (s: string) => setStatuses((cur) => (cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s]));
  const toggleTag = (dim: string, val: string) => setTags((cur) => {
    const vals = cur[dim] ?? [];
    const next = vals.includes(val) ? vals.filter((x) => x !== val) : [...vals, val];
    const out = { ...cur, [dim]: next };
    if (next.length === 0) delete out[dim];
    return out;
  });
  const selectView = (id: string | null) => { setActiveId(id); setSelectedId(null); setStatuses([]); setTags({}); setSearch(''); setExpand({ direction: 'none', depth: 1 }); };
  const resetFilter = () => { setActiveId(null); setStatuses([]); setTags({}); setExpand({ direction: 'none', depth: 1 }); };
  const onSaveView = async () => {
    const name = typeof window !== 'undefined' ? window.prompt('View name?') : null;
    if (!name) return;
    const { filter, expand: ex } = buildFilter({ statuses, tags, expand });
    try { await saveView({ name, query: { filter, expand: ex }, display: view?.display ?? {} }); } catch { /* surfaced by the view list not updating */ }
  };

  const activeView = views.find((v) => v.id === activeId);
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-3 border-b border-neutral-800 px-4 py-2 text-xs text-neutral-400">
        <span className="font-semibold text-neutral-200">Mission Graph</span>
        <span>{filteredNodes.length} shown / {rawNodes.length} total</span>
        <span>· {activeView ? activeView.name : 'ad-hoc filter'}</span>
        {view?.display?.groupBy && <span>· grouped by {view.display.groupBy}</span>}
        <button onClick={() => { refreshViews(); refresh(); }} className="ml-auto text-neutral-400 hover:text-neutral-100" disabled={loading}>↻ Refresh</button>
      </div>
      <div className="flex min-h-0 flex-1">
        <div className="flex w-64 shrink-0 flex-col overflow-y-auto border-r border-neutral-800">
          <MissionViewPicker views={views} activeId={activeId} onSelect={selectView} onRefresh={() => { refreshViews(); refresh(); }} loading={viewsLoading} />
          <MissionSearchBox value={search} onChange={setSearch} />
          <MissionFilterEditor nodes={rawNodes} statuses={statuses} tags={tags} onToggleStatus={toggleStatus} onToggleTag={toggleTag} expand={expand} onExpandChange={setExpand} onReset={resetFilter} onSaveView={onSaveView} />
        </div>
        <div className="relative flex-1">
          {loading && <div className="absolute left-2 top-2 z-10 text-xs text-neutral-500">Loading…</div>}
          {error && <div className="absolute left-2 top-2 z-10 text-xs text-red-400">{error}</div>}
          <MissionGraphCanvas nodes={filteredNodes} edges={filteredEdges} display={view?.display} selectedId={selectedId} onSelect={setSelectedId} />
        </div>
        <MissionNodeDetail nodeId={selectedId} edges={graph?.edges ?? []} onSelect={setSelectedId} onClose={() => setSelectedId(null)} />
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Type-check + full web vitest** — `cd /home/ubuntu/lm-assist/web && npx tsc --noEmit 2>&1 | grep MissionDashboardPage || echo "CLEAN"` (expect CLEAN), then `npx vitest run 2>&1 | tail -5` (expect all pass — the adapter suite + smoke).

- [ ] **Step 3: Commit** — `cd /home/ubuntu/lm-assist && git add web/src/components/missions/dashboard/MissionDashboardPage.tsx && git commit -m "feat(web): filter editor replaces quick-chips — status/tag (client) + expand (server) + save-as-view"`

---

## Self-Review

**1. Spec coverage:** §1 layout/header → Task 4/8 (header summary + scrollable rail). §2 search → Task 1 (`matchesSearch`) + Task 4 (box+wire). §3 comprehensive detail → Task 2 (`useMissionDetail`) + Task 3 (`MissionNodeDetail`). §4 filter editor + save-as-view → Task 1 (`buildFilter`) + Task 7 (`MissionFilterEditor`+`saveView`) + Task 8 (wire, replace quick-chips, server scope). §5 tags in both → Task 5 (Missions page) + Task 6 (dashboard cards) + Task 3 (dashboard detail tags). §6 no backend change → respected (only existing endpoints). §7 testing → Tasks 1/8 vitest + per-task tsc + controller browser-smoke. §8 build order → Tasks 1–6 (Phase 1) then 7–8 (Phase 2). ✅ No gaps.

**2. Placeholder scan:** every code step has complete code; commands have expected output. The Task-5 insertions are precise (anchored to named lines/rows). The sessions-route shape is handled defensively in Task 2 (array-or-`{sessions}`). No TBD/TODO.

**3. Type consistency:** `MissionFull`/`MissionChange` (Task 1) consumed by `useMissionDetail` (Task 2) + `MissionNodeDetail` (Task 3). `MissionNodeDetail({nodeId,edges,onSelect,onClose})` (Task 3) matches the page's call (Task 4/8). `buildFilter` shape (Task 1) consumed by Task 8. `saveView` (Task 7) signature matches Task 8's call. `ExpandState` (Task 7) used by Task 8. `useMissionGraph` `GraphSource` `{filter,expand}` branch (existing) matches Task 8's `source`. ✅

**Note:** Task 3 leaves `MissionDashboardPage.tsx` momentarily mismatched (old props) until Task 4 rewires it — Task 3's tsc check scopes to `MissionNodeDetail.tsx` only; Task 4 restores a clean whole-app tsc. Reviewers: this is intentional sequencing, not a defect.
