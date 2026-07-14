'use client';

import { useEffect, useState } from 'react';
import type { CallFn, EditTarget } from './types';
import { errText, timeAgo } from './format';

/** Section wrapper. When `rawData` is provided, a "raw" toggle appears top-right of the header
 *  row; toggling it reveals `<pre>{JSON.stringify(rawData,null,2)}</pre>` (capped `max-h-64
 *  overflow-auto`) under `children`. Sections with no `rawData` (e.g. an unrecognized-shape
 *  StatusBlock that already renders its own always-visible `<pre>`, or QueueList sections) render
 *  exactly as before. */
function Section({ title, rawData, children }: { title: string; rawData?: unknown; children: React.ReactNode }) {
  const [showRaw, setShowRaw] = useState(false);
  return (
    <div className="border border-gray-800 rounded p-3 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="text-gray-300 font-medium">{title}</div>
        {rawData !== undefined && (
          <button
            onClick={() => setShowRaw((s) => !s)}
            className="text-[10px] text-gray-500 hover:text-gray-300 border border-gray-800 rounded px-1.5 py-0.5 shrink-0"
          >
            {showRaw ? 'hide raw' : 'raw'}
          </button>
        )}
      </div>
      {children}
      {rawData !== undefined && showRaw && (
        <pre className="text-xs text-gray-400 bg-gray-900 rounded p-2 overflow-auto max-h-64">{JSON.stringify(rawData, null, 2)}</pre>
      )}
    </div>
  );
}

/** One recentEvents-style entry: `{ts, mode?, project?, decision?, detail?}`. */
type DaemonEvent = { ts?: unknown; mode?: unknown; project?: unknown; decision?: unknown; detail?: unknown };

/** The known daemon shape: `{mode?, running?, hostId?, counts?, recentEvents?}`. */
type DaemonShape = { mode?: unknown; running?: unknown; hostId?: unknown; counts?: unknown; recentEvents?: unknown };

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Renders `daemon.{mode,running,hostId,counts,recentEvents}` as cards. Every field is optional. */
function DaemonCard({ daemon }: { daemon: DaemonShape }) {
  const running = daemon.running === true;
  const mode = typeof daemon.mode === 'string' ? daemon.mode : undefined;
  const hostId = typeof daemon.hostId === 'string' ? daemon.hostId : undefined;
  const off = mode === 'off' || mode === undefined;
  const dotColor = running ? 'bg-emerald-500' : off ? 'bg-gray-600' : 'bg-amber-500';
  const textColor = running ? 'text-emerald-400' : off ? 'text-gray-500' : 'text-amber-400';
  const statusWord = running ? 'running' : off ? 'off' : (mode ?? 'unknown');

  const counts = isRecord(daemon.counts) ? daemon.counts : undefined;
  const countEntries = counts
    ? Object.entries(counts).filter(([, v]) => typeof v === 'number')
    : [];

  const events = Array.isArray(daemon.recentEvents) ? (daemon.recentEvents as DaemonEvent[]) : [];
  const lastEvents = events.slice(-5).reverse();

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1.5 text-xs">
        <span className={`inline-block w-1.5 h-1.5 rounded-full ${dotColor}`} />
        <span className={textColor}>{statusWord}</span>
        {mode && <span className="text-gray-600">· mode: {mode}</span>}
        {hostId && <span className="text-gray-600">· host: {hostId}</span>}
      </div>
      {countEntries.length > 0 && (
        <div className="grid grid-cols-3 gap-x-4 gap-y-1 text-[11px]">
          {countEntries.map(([k, v]) => (
            <div key={k} className="flex items-center justify-between gap-2">
              <span className="text-gray-500">{k}</span>
              <span className="text-gray-300 tabular-nums">{String(v)}</span>
            </div>
          ))}
        </div>
      )}
      {lastEvents.length > 0 && (
        <div className="space-y-0.5">
          {lastEvents.map((ev, i) => {
            const ts = typeof ev.ts === 'number' ? ev.ts : NaN;
            const decision = typeof ev.decision === 'string' ? ev.decision : '';
            const project = typeof ev.project === 'string' ? ev.project : '';
            return (
              <div key={i} className="text-[11px] text-gray-500 flex items-center gap-2">
                <span className="text-gray-600 shrink-0">{timeAgo(ts)}</span>
                <span className="text-gray-400 truncate flex-1">{decision}</span>
                {project && <span className="text-gray-600 truncate max-w-[8rem]">{project}</span>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Renders `config`'s non-null scalar keys as chips (object/array values are skipped). */
function ConfigChips({ config }: { config: Record<string, unknown> }) {
  const entries = Object.entries(config).filter(
    ([, v]) => v !== null && v !== undefined && (typeof v !== 'object')
  );
  if (entries.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1">
      {entries.map(([k, v]) => (
        <span key={k} className="bg-gray-900 border border-gray-800 rounded px-1.5 py-0.5 text-[10px] text-gray-400">
          {k}: <span className="text-gray-300">{String(v)}</span>
        </span>
      ))}
    </div>
  );
}

/** True if `v` looks like the known daemon-status shape, so it's worth rendering as a DaemonCard
 *  rather than raw JSON. Endpoints observed live: `/memory|rules/sync/status` nest this object under
 *  `daemon`; `/memory|rules/autosync/status` return it flat (no wrapper) — both normalize below.
 *  Requires `mode`, `counts`, or `recentEvents` — NOT `running`/`hostId` alone, since
 *  `/memory/harvest/status` also has a bare `running: boolean` field but none of the others, and
 *  should fall through to the raw-JSON path rather than render as a near-empty daemon card. */
function looksLikeDaemon(v: unknown): v is DaemonShape {
  return isRecord(v) && ('mode' in v || 'counts' in v || 'recentEvents' in v);
}

/** Normalizes the two known status response layouts into `{config?, daemon?}`:
 *  - wrapped: `{ config?: object, daemon?: DaemonShape }` (memory/rules sync/status)
 *  - flat: the DaemonShape fields directly on the root, no `config` (memory/rules autosync/status)
 *  Anything else (e.g. harvest/status's differently-shaped payload) → null, caller falls back to raw. */
function normalizeStatusShape(data: unknown): { config?: Record<string, unknown>; daemon?: DaemonShape } | null {
  if (!isRecord(data)) return null;
  const hasWrapper = ('config' in data && (data.config === undefined || isRecord(data.config)))
    || (isRecord(data.daemon) && looksLikeDaemon(data.daemon));
  if (hasWrapper) {
    return {
      config: isRecord(data.config) ? data.config : undefined,
      daemon: isRecord(data.daemon) && looksLikeDaemon(data.daemon) ? data.daemon : undefined,
    };
  }
  if (looksLikeDaemon(data)) return { daemon: data };
  return null;
}

/** Fetches `path` and renders humanized cards for the known daemon-status shape (see
 *  `normalizeStatusShape`), falling back to a capped raw `<pre>` for anything else. Reports the
 *  fetched payload to the parent Section (via `onData`) so the *known-shape* case can still offer
 *  a "raw" toggle in the section header — see the `rawData` comment on `Section`. */
function StatusBlock({ call, path, refreshTick, onData }:
  { call: CallFn; path: string; refreshTick?: number; onData?: (data: unknown) => void }) {
  const [data, setData] = useState<unknown>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setError(null);
    call(path)
      .then((r) => { if (alive) { setData(r); onData?.(r); } })
      .catch((e) => { if (alive) setError(errText(e)); });
    return () => { alive = false; };
  }, [call, path, refreshTick]);
  if (error) return <div className="text-rose-400 text-xs">{error}</div>;
  if (!data) return <div className="text-gray-500 text-xs">Loading…</div>;

  const known = normalizeStatusShape(data);
  if (!known) {
    // Unrecognized shape (e.g. harvest/status's own field set) → today's raw-JSON fallback,
    // always visible (no separate toggle needed) but still capped so a huge payload can't blow up the section.
    return <pre className="text-xs text-gray-400 bg-gray-900 rounded p-2 overflow-x-auto max-h-64 overflow-auto">{JSON.stringify(data, null, 2)}</pre>;
  }

  return (
    <div className="space-y-2">
      {known.config && <ConfigChips config={known.config} />}
      {known.daemon && <DaemonCard daemon={known.daemon} />}
    </div>
  );
}

type Row = Record<string, unknown>;

const rowKey = (row: Row, i: number) =>
  String(row.id ?? row.recordId ?? `${row.title ?? ''}:${row._proposalStatus ?? row.status ?? ''}:${i}`);

function QueueList({ call, path, listKey, onEdit, refreshTick }:
  { call: CallFn; path: string; listKey: string; onEdit?: (t: EditTarget) => void; refreshTick?: number }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setError(null);
    call<Record<string, unknown>>(path)
      .then((r) => { if (alive) setRows((r[listKey] as Row[]) || (r.items as Row[]) || []); })
      .catch((e) => { if (alive) setError(errText(e)); });
    return () => { alive = false; };
  }, [call, path, listKey, refreshTick]);
  if (error) return <div className="text-rose-400 text-xs">{error}</div>;
  if (rows === null) return <div className="text-gray-500 text-xs">Loading…</div>;
  if (rows.length === 0) return <div className="text-gray-500 text-xs">Empty.</div>;
  return (
    <div className="space-y-1">
      <div className="text-[10px] text-gray-500">{rows.length} item{rows.length === 1 ? '' : 's'}</div>
      {rows.map((row, i) => {
        const key = rowKey(row, i);
        return (
          <div key={key} className="text-xs">
            <button onClick={() => setOpen(open === key ? null : key)} className="text-left w-full flex items-center gap-2 hover:bg-gray-900 rounded px-1 py-0.5">
              <span className="text-gray-300 truncate flex-1">
                {String(row.title ?? row.name ?? row.id ?? row.recordId ?? `item ${i + 1}`)}
              </span>
              <span className="text-gray-500">{String(row._proposalStatus ?? row.status ?? '')}</span>
              <span className="text-gray-600">{String(row.suggestedProject ?? row._originProjectSlug ?? row.project ?? '')}</span>
            </button>
            {open === key && (
              <div className="pl-2 space-y-1">
                {/* FileEditor create for memory requires a projectId — only offer when the proposal names one */}
                {onEdit && Boolean(row.suggestedProject || row._originProjectSlug) && (
                  <button
                    onClick={() => {
                      const content = typeof row.content === 'string' ? row.content
                        : typeof row.body === 'string' ? row.body
                        : JSON.stringify(row, null, 2);
                      const projectId = String(row.suggestedProject || row._originProjectSlug);
                      onEdit({ kind: 'memory', projectId, filename: '', content });
                    }}
                    className="px-2 py-0.5 rounded bg-emerald-800 text-emerald-100 hover:bg-emerald-700 text-[10px]">
                    Open as new memory file
                  </button>
                )}
                <pre className="text-[10px] text-gray-400 bg-gray-900 rounded p-2 overflow-x-auto max-h-64 overflow-auto">{JSON.stringify(row, null, 2)}</pre>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** Section + StatusBlock, wired so the header's "raw" toggle only appears once the fetch has
 *  resolved to a *recognized* daemon-status shape — StatusBlock's own unrecognized-shape fallback
 *  already shows its `<pre>` unconditionally, so a second toggle there would be redundant. */
function StatusSection({ title, call, path, refreshTick }: { title: string; call: CallFn; path: string; refreshTick?: number }) {
  const [data, setData] = useState<unknown>(null);
  const rawData = normalizeStatusShape(data) ? data : undefined;
  return (
    <Section title={title} rawData={rawData}>
      <StatusBlock call={call} path={path} refreshTick={refreshTick} onData={setData} />
    </Section>
  );
}

export function SyncTab({ call, onEdit, refreshTick }: { call: CallFn; onEdit?: (t: EditTarget) => void; refreshTick?: number }) {
  return (
    <div className="h-full min-h-0 overflow-y-auto space-y-4 pr-1">
    <div className="text-xs text-gray-500">
      Sync/signpost toggles live in <a href="settings" className="underline hover:text-gray-300">Settings → Memory</a>; this tab is status only.
    </div>
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 text-sm">
      <StatusSection title="Memory sync" call={call} path="/memory/sync/status" refreshTick={refreshTick} />
      <StatusSection title="Rules sync" call={call} path="/rules/sync/status" refreshTick={refreshTick} />
      <StatusSection title="Memory autosync daemon" call={call} path="/memory/autosync/status" refreshTick={refreshTick} />
      <StatusSection title="Rules autosync daemon" call={call} path="/rules/autosync/status" refreshTick={refreshTick} />
      <StatusSection title="Harvest daemon" call={call} path="/memory/harvest/status" refreshTick={refreshTick} />
      <Section title="Proposals (propose-only — applying is a human/agent step)">
        <QueueList call={call} path="/memory/proposals?limit=50" listKey="proposals" onEdit={onEdit} refreshTick={refreshTick} />
      </Section>
      <Section title="Reconcile plan"><QueueList call={call} path="/memory/reconcile/plan?limit=50" listKey="items" refreshTick={refreshTick} /></Section>
      <Section title="Validate plan"><QueueList call={call} path="/memory/validate/plan?limit=50" listKey="items" refreshTick={refreshTick} /></Section>
    </div>
    </div>
  );
}
