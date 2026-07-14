'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Search, X, RefreshCw } from 'lucide-react';
import type { CallFn, MemoryProjectSummary, MapRecord, ImportCandidate, EditTarget } from './types';
import { RecordDetail } from './RecordDetail';
import { errText, timeAgo } from './format';

const TYPE_COLORS: Record<string, string> = {
  user: 'bg-sky-900 text-sky-200', feedback: 'bg-amber-900 text-amber-200',
  project: 'bg-emerald-900 text-emerald-200', reference: 'bg-violet-900 text-violet-200',
  claude: 'bg-gray-700 text-gray-200', index: 'bg-gray-700 text-gray-300',
};
const VALIDITY_COLORS: Record<string, string> = {
  current: 'bg-emerald-900 text-emerald-200', stale: 'bg-amber-900 text-amber-200',
  outdated: 'bg-rose-900 text-rose-200', superseded: 'bg-gray-700 text-gray-400',
};
const VALIDITY_ORDER = ['current', 'stale', 'outdated', 'superseded'];

export function Badge({ text, palette, hint }: { text: string; palette: Record<string, string>; hint?: string }) {
  return <span title={hint} className={`px-1.5 py-0.5 rounded text-[10px] ${palette[text] || 'bg-gray-700 text-gray-300'}`}>{text}</span>;
}

/** Multi-select filter chip: active uses the record's own palette color, inactive = gray outline. */
function FilterChip({ text, active, color, onClick }: { text: string; active: boolean; color: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick}
      className={`px-1.5 py-0.5 rounded text-[10px] border ${active ? `${color} border-transparent` : 'bg-transparent text-gray-500 border-gray-700 hover:text-gray-300 hover:border-gray-600'}`}>
      {text}
    </button>
  );
}

export function MemoryBrowser({ call, onEdit, refreshTick, selfNode }: { call: CallFn; onEdit?: (t: EditTarget) => void; refreshTick?: number; selfNode?: string | null }) {
  const [projects, setProjects] = useState<MemoryProjectSummary[]>([]);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [records, setRecords] = useState<MapRecord[]>([]);
  const [candidates, setCandidates] = useState<ImportCandidate[]>([]);
  const [selected, setSelected] = useState<MapRecord | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [importing, setImporting] = useState<Set<string>>(new Set());
  const [typeFilter, setTypeFilter] = useState<Set<string>>(new Set());
  const [validityFilter, setValidityFilter] = useState<Set<string>>(new Set());
  const [sort, setSort] = useState<'recent' | 'title'>('recent');

  useEffect(() => {
    call<MemoryProjectSummary[]>('/memory/projects')
      .then(setProjects).catch((e) => setError(errText(e)));
  }, [call]);

  const loadRecords = useCallback(() => {
    setLoading(true); setError(null);
    const params = new URLSearchParams({ level: 'brief', limit: '200' });
    if (projectId) params.set('projects', projectId);
    if (q.trim()) params.set('q', q.trim());
    call<MapRecord[]>(`/memory/map?${params}`)
      .then((r) => setRecords(Array.isArray(r) ? r : []))
      .catch((e) => setError(errText(e)))
      .finally(() => setLoading(false));
  }, [call, projectId, q]);

  useEffect(() => { const t = setTimeout(loadRecords, 300); return () => clearTimeout(t); }, [loadRecords, refreshTick]);

  const typeOptions = useMemo(() => {
    const s = new Set<string>();
    for (const r of records) if (r.type) s.add(r.type);
    return Array.from(s).sort();
  }, [records]);

  const toggleType = (t: string) => setTypeFilter((s) => { const n = new Set(s); n.has(t) ? n.delete(t) : n.add(t); return n; });
  const toggleValidity = (v: string) => setValidityFilter((s) => { const n = new Set(s); n.has(v) ? n.delete(v) : n.add(v); return n; });

  const filteredRecords = useMemo(() => {
    let list = records;
    if (typeFilter.size > 0) list = list.filter((r) => typeFilter.has(r.type));
    if (validityFilter.size > 0) list = list.filter((r) => validityFilter.has(r.validity));
    list = [...list];
    if (sort === 'title') list.sort((a, b) => (a.title || a.file).localeCompare(b.title || b.file));
    else list.sort((a, b) => b.recordedAtMs - a.recordedAtMs);
    return list;
  }, [records, typeFilter, validityFilter, sort]);

  useEffect(() => {
    if (!projectId) { setCandidates([]); return; }
    call<{ candidates: ImportCandidate[] }>(`/memory/by-project/${encodeURIComponent(projectId)}/sync/import-candidates`)
      .then((r) => setCandidates(r.candidates || [])).catch(() => setCandidates([]));
  }, [call, projectId, refreshTick]);

  const importToLive = async (c: ImportCandidate) => {
    const key = `${c.source}:${c.filename}`;
    if (importing.has(key)) return; // already in flight — no double-fire
    setImporting((s) => new Set(s).add(key));
    try {
      await call(`/memory/by-project/${encodeURIComponent(projectId!)}/file/${encodeURIComponent(c.filename)}`,
        { method: 'PUT', body: { content: c.body } });
      loadRecords();
      setCandidates((cs) => cs.filter((x) => x !== c));
    } catch (e) { setError(errText(e)); }
    finally { setImporting((s) => { const n = new Set(s); n.delete(key); return n; }); }
  };

  const totalFileCount = projects.reduce((sum, p) => sum + p.fileCount, 0);

  return (
    <div className="h-full min-h-0 flex gap-4 text-sm">
      {/* Project rail */}
      <div className="w-56 shrink-0 flex flex-col min-h-0">
        <button onClick={() => setProjectId(null)}
          className={`w-full flex items-center gap-2 text-left px-2 py-1 rounded ${projectId === null ? 'bg-gray-800 text-gray-100' : 'text-gray-400 hover:text-gray-200'}`}>
          <span className="flex-1 truncate">All projects</span>
          <span className="shrink-0 text-[10px] tabular-nums px-1.5 py-0.5 rounded-full bg-gray-800 text-gray-400">{totalFileCount}</span>
        </button>
        <div className="flex-1 min-h-0 overflow-y-auto space-y-1 pr-1">
          {projects.map((p) => (
            <button key={p.projectId} onClick={() => setProjectId(p.projectId)}
              title={p.projectPath}
              className={`w-full flex items-center gap-2 text-left px-2 py-1 rounded ${projectId === p.projectId ? 'bg-gray-800 text-gray-100' : 'text-gray-400 hover:text-gray-200'}`}>
              <span className="flex-1 truncate">{p.projectPath.split('/').pop() || p.projectId}</span>
              <span className="shrink-0 text-[10px] tabular-nums px-1.5 py-0.5 rounded-full bg-gray-800 text-gray-400">{p.fileCount}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Records */}
      <div className="flex-1 min-w-0 flex flex-col min-h-0 gap-2">
        <div className="flex gap-2">
          <div className="flex-1 relative">
            <Search size={14} className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-500 pointer-events-none" />
            <input value={q} onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Escape' && q) { e.stopPropagation(); setQ(''); } }}
              placeholder={projectId ? 'Search this project…' : 'Search all projects…'}
              className="w-full bg-gray-900 border border-gray-700 rounded pl-7 pr-7 py-1 text-gray-200" />
            {q && (
              <button type="button" onClick={() => setQ('')} aria-label="Clear search"
                className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300">
                <X size={14} />
              </button>
            )}
          </div>
          <button type="button" onClick={() => loadRecords()} aria-label="Refresh"
            className="px-2 py-1 rounded border border-gray-700 text-gray-400 hover:text-gray-200 hover:border-gray-600">
            <RefreshCw size={14} />
          </button>
          {onEdit && projectId && (
            <button onClick={() => onEdit({ kind: 'memory', projectId, filename: '', content: '' })}
              className="px-2 py-1 rounded bg-emerald-800 text-emerald-100 hover:bg-emerald-700 text-xs">
              + New memory
            </button>
          )}
        </div>

        {/* Filter chips */}
        {(typeOptions.length > 0) && (
          <div className="flex flex-wrap items-center gap-1">
            {typeOptions.map((t) => (
              <FilterChip key={t} text={t} active={typeFilter.has(t)} color={TYPE_COLORS[t] || 'bg-gray-700 text-gray-300'} onClick={() => toggleType(t)} />
            ))}
            <span className="w-px self-stretch bg-gray-800 mx-1" />
            {VALIDITY_ORDER.map((v) => (
              <FilterChip key={v} text={v} active={validityFilter.has(v)} color={VALIDITY_COLORS[v] || 'bg-gray-700 text-gray-300'} onClick={() => toggleValidity(v)} />
            ))}
          </div>
        )}

        {/* Count + sort */}
        <div className="flex items-center justify-between text-[10px] text-gray-500">
          <span>
            {filteredRecords.length}/{records.length}
            {records.length === 200 && <span className="ml-2">first 200 matches — refine search</span>}
          </span>
          <select value={sort} onChange={(e) => setSort(e.target.value as 'recent' | 'title')}
            className="bg-gray-900 border border-gray-700 rounded px-1 py-0.5 text-gray-300 text-[10px]">
            <option value="recent">Recent</option>
            <option value="title">Title A-Z</option>
          </select>
        </div>

        {error && <div className="text-rose-400 text-xs">{error}</div>}
        <div className={`flex-1 min-h-0 overflow-y-auto space-y-2 ${loading && records.length > 0 ? 'opacity-60' : ''}`}>
          <div className="divide-y divide-gray-800 border border-gray-800 rounded">
            {filteredRecords.map((r) => (
              <button key={r.recordId} onClick={() => setSelected(r)}
                className="w-full text-left px-3 py-2 hover:bg-gray-900 flex items-center gap-2 focus-visible:ring-1 focus-visible:ring-gray-500 outline-none">
                <span className="text-gray-200 truncate flex-1" title={r.title || r.file}>{r.title || r.file}</span>
                <span className="shrink-0"><Badge text={r.type} palette={TYPE_COLORS} hint="record type" /></span>
                <span className="shrink-0"><Badge text={r.validity} palette={VALIDITY_COLORS} hint="validity" /></span>
                <span className="shrink-0 text-gray-500 text-xs">{r.node}</span>
                {!projectId && <span className="shrink-0 text-gray-600 text-xs truncate max-w-40" title={r.project}>{r.project}</span>}
                <span className="text-[10px] text-gray-600 shrink-0 w-14 text-right">{timeAgo(r.recordedAtMs)}</span>
              </button>
            ))}
            {loading && records.length === 0 && <div className="px-3 py-4 text-gray-500">Loading…</div>}
            {!loading && records.length === 0 && <div className="px-3 py-4 text-gray-500">No records.</div>}
            {!loading && records.length > 0 && filteredRecords.length === 0 && <div className="px-3 py-4 text-gray-500">No records match the current filters.</div>}
          </div>

          {/* Import candidates (per-project) */}
          {projectId && candidates.length > 0 && (
            <div className="border border-gray-800 rounded p-3 space-y-2">
              <div className="text-gray-300 font-medium">Import candidates (newer on other hosts)</div>
              {candidates.map((c, i) => {
                const inFlight = importing.has(`${c.source}:${c.filename}`);
                return (
                  <div key={`${c.source}:${c.filename}:${i}`} className="flex items-center gap-2">
                    <span className="text-gray-200 truncate flex-1">{c.filename}</span>
                    <span className="text-gray-500 text-xs">{c.source}{c.reason ? ` · ${c.reason}` : ''}</span>
                    {Number.isFinite(c.relevanceScore) && (
                      <span className="text-[10px] text-gray-500 bg-gray-800 rounded px-1.5 py-0.5">rel {c.relevanceScore!.toFixed(2)}</span>
                    )}
                    <button onClick={() => void importToLive(c)} disabled={inFlight}
                      className="px-2 py-0.5 rounded bg-sky-900 text-sky-100 hover:bg-sky-800 text-xs disabled:opacity-50">
                      {inFlight ? 'Importing…' : 'Import to live'}
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {selected && (
        <RecordDetail key={selected.recordId} record={selected} call={call} onEdit={onEdit} onClose={() => { setSelected(null); loadRecords(); }} refreshTick={refreshTick} selfNode={selfNode} />
      )}
    </div>
  );
}
