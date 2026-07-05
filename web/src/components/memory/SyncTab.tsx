'use client';

import { useEffect, useState } from 'react';
import type { CallFn, EditTarget } from './types';

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border border-gray-800 rounded p-3 space-y-2">
      <div className="text-gray-300 font-medium">{title}</div>
      {children}
    </div>
  );
}

function StatusBlock({ call, path, refreshTick }: { call: CallFn; path: string; refreshTick?: number }) {
  const [data, setData] = useState<unknown>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { call(path).then(setData).catch((e) => setError(String(e))); }, [call, path, refreshTick]);
  if (error) return <div className="text-rose-400 text-xs">{error}</div>;
  if (!data) return <div className="text-gray-500 text-xs">Loading…</div>;
  return <pre className="text-xs text-gray-400 bg-gray-900 rounded p-2 overflow-x-auto">{JSON.stringify(data, null, 2)}</pre>;
}

type Row = Record<string, unknown>;

function QueueList({ call, path, listKey, onEdit, refreshTick }:
  { call: CallFn; path: string; listKey: string; onEdit?: (t: EditTarget) => void; refreshTick?: number }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [open, setOpen] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    call<Record<string, unknown>>(path)
      .then((r) => setRows((r[listKey] as Row[]) || (r.items as Row[]) || []))
      .catch((e) => setError(String(e)));
  }, [call, path, listKey, refreshTick]);
  if (error) return <div className="text-rose-400 text-xs">{error}</div>;
  if (rows.length === 0) return <div className="text-gray-500 text-xs">Empty.</div>;
  return (
    <div className="space-y-1">
      {rows.map((row, i) => (
        <div key={i} className="text-xs">
          <button onClick={() => setOpen(open === i ? null : i)} className="text-left w-full flex items-center gap-2 hover:bg-gray-900 rounded px-1 py-0.5">
            <span className="text-gray-300 truncate flex-1">
              {String(row.title ?? row.name ?? row.id ?? row.recordId ?? `item ${i + 1}`)}
            </span>
            <span className="text-gray-500">{String(row._proposalStatus ?? row.status ?? '')}</span>
            <span className="text-gray-600">{String(row.suggestedProject ?? row._originProjectSlug ?? row.project ?? '')}</span>
          </button>
          {open === i && (
            <div className="pl-2 space-y-1">
              {/* FileEditor create for memory requires a projectId — only offer when the proposal names one */}
              {onEdit && Boolean(row.suggestedProject || row._originProjectSlug) && (
                <button
                  onClick={() => {
                    const content = typeof row.content === 'string' ? row.content
                      : typeof row.body === 'string' ? row.body
                      : JSON.stringify(row, null, 2);
                    const projectId = String(row.suggestedProject ?? row._originProjectSlug);
                    onEdit({ kind: 'memory', projectId, filename: '', content });
                  }}
                  className="px-2 py-0.5 rounded bg-emerald-800 text-emerald-100 hover:bg-emerald-700 text-[10px]">
                  Open as new memory file
                </button>
              )}
              <pre className="text-[10px] text-gray-400 bg-gray-900 rounded p-2 overflow-x-auto">{JSON.stringify(row, null, 2)}</pre>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

export function SyncTab({ call, onEdit, refreshTick }: { call: CallFn; onEdit?: (t: EditTarget) => void; refreshTick?: number }) {
  return (
    <div className="space-y-4">
    <div className="text-xs text-gray-500">
      Sync/signpost toggles live in <a href="settings" className="underline hover:text-gray-300">Settings → Memory</a>; this tab is status only.
    </div>
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 text-sm">
      <Section title="Memory sync"><StatusBlock call={call} path="/memory/sync/status" refreshTick={refreshTick} /></Section>
      <Section title="Rules sync"><StatusBlock call={call} path="/rules/sync/status" refreshTick={refreshTick} /></Section>
      <Section title="Memory autosync daemon"><StatusBlock call={call} path="/memory/autosync/status" refreshTick={refreshTick} /></Section>
      <Section title="Rules autosync daemon"><StatusBlock call={call} path="/rules/autosync/status" refreshTick={refreshTick} /></Section>
      <Section title="Harvest daemon"><StatusBlock call={call} path="/memory/harvest/status" refreshTick={refreshTick} /></Section>
      <Section title="Proposals (propose-only — applying is a human/agent step)">
        <QueueList call={call} path="/memory/proposals?limit=50" listKey="proposals" onEdit={onEdit} refreshTick={refreshTick} />
      </Section>
      <Section title="Reconcile plan"><QueueList call={call} path="/memory/reconcile/plan?limit=50" listKey="items" refreshTick={refreshTick} /></Section>
      <Section title="Validate plan"><QueueList call={call} path="/memory/validate/plan?limit=50" listKey="items" refreshTick={refreshTick} /></Section>
    </div>
    </div>
  );
}
