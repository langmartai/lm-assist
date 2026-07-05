'use client';

import { useCallback, useEffect, useState } from 'react';
import type { CallFn, MemoryProjectSummary, MapRecord, ImportCandidate, EditTarget } from './types';
import { RecordDetail } from './RecordDetail';

const TYPE_COLORS: Record<string, string> = {
  user: 'bg-sky-900 text-sky-200', feedback: 'bg-amber-900 text-amber-200',
  project: 'bg-emerald-900 text-emerald-200', reference: 'bg-violet-900 text-violet-200',
  claude: 'bg-gray-700 text-gray-200', index: 'bg-gray-700 text-gray-300',
};
const VALIDITY_COLORS: Record<string, string> = {
  current: 'bg-emerald-900 text-emerald-200', stale: 'bg-amber-900 text-amber-200',
  outdated: 'bg-rose-900 text-rose-200', superseded: 'bg-gray-700 text-gray-400',
};

export function Badge({ text, palette }: { text: string; palette: Record<string, string> }) {
  return <span className={`px-1.5 py-0.5 rounded text-[10px] ${palette[text] || 'bg-gray-700 text-gray-300'}`}>{text}</span>;
}

export function MemoryBrowser({ call, onEdit }: { call: CallFn; onEdit?: (t: EditTarget) => void }) {
  const [projects, setProjects] = useState<MemoryProjectSummary[]>([]);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [records, setRecords] = useState<MapRecord[]>([]);
  const [candidates, setCandidates] = useState<ImportCandidate[]>([]);
  const [selected, setSelected] = useState<MapRecord | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    call<MemoryProjectSummary[]>('/memory/projects')
      .then(setProjects).catch((e) => setError(String(e)));
  }, [call]);

  const loadRecords = useCallback(() => {
    setLoading(true); setError(null);
    const params = new URLSearchParams({ level: 'brief', limit: '200' });
    if (projectId) params.set('projects', projectId);
    if (q.trim()) params.set('q', q.trim());
    call<MapRecord[]>(`/memory/map?${params}`)
      .then((r) => setRecords(Array.isArray(r) ? r : []))
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [call, projectId, q]);

  useEffect(() => { const t = setTimeout(loadRecords, 300); return () => clearTimeout(t); }, [loadRecords]);

  useEffect(() => {
    if (!projectId) { setCandidates([]); return; }
    call<{ candidates: ImportCandidate[] }>(`/memory/by-project/${encodeURIComponent(projectId)}/sync/import-candidates`)
      .then((r) => setCandidates(r.candidates || [])).catch(() => setCandidates([]));
  }, [call, projectId]);

  const importToLive = async (c: ImportCandidate) => {
    try {
      await call(`/memory/by-project/${encodeURIComponent(projectId!)}/file/${encodeURIComponent(c.filename)}`,
        { method: 'PUT', body: { content: c.body } });
      loadRecords();
      setCandidates((cs) => cs.filter((x) => x !== c));
    } catch (e) { setError(String(e)); }
  };

  return (
    <div className="flex gap-4 text-sm">
      {/* Project rail */}
      <div className="w-56 shrink-0 space-y-1">
        <button onClick={() => setProjectId(null)}
          className={`w-full text-left px-2 py-1 rounded ${projectId === null ? 'bg-gray-800 text-gray-100' : 'text-gray-400 hover:text-gray-200'}`}>
          All projects
        </button>
        {projects.map((p) => (
          <button key={p.projectId} onClick={() => setProjectId(p.projectId)}
            title={p.projectPath}
            className={`w-full text-left px-2 py-1 rounded truncate ${projectId === p.projectId ? 'bg-gray-800 text-gray-100' : 'text-gray-400 hover:text-gray-200'}`}>
            {p.projectPath.split('/').pop() || p.projectId}
            <span className="text-gray-500 ml-1 text-xs">{p.fileCount}</span>
          </button>
        ))}
      </div>

      {/* Records */}
      <div className="flex-1 min-w-0 space-y-2">
        <div className="flex gap-2">
          <input value={q} onChange={(e) => setQ(e.target.value)}
            placeholder={projectId ? 'Search this project…' : 'Search all projects…'}
            className="flex-1 bg-gray-900 border border-gray-700 rounded px-2 py-1 text-gray-200" />
          {onEdit && projectId && (
            <button onClick={() => onEdit({ kind: 'memory', projectId, filename: '', content: '' })}
              className="px-2 py-1 rounded bg-emerald-800 text-emerald-100 hover:bg-emerald-700 text-xs">
              + New memory
            </button>
          )}
        </div>
        {error && <div className="text-rose-400 text-xs">{error}</div>}
        {loading && <div className="text-gray-500 text-xs">Loading…</div>}
        <div className="divide-y divide-gray-800 border border-gray-800 rounded">
          {records.map((r) => (
            <button key={r.recordId} onClick={() => setSelected(r)}
              className="w-full text-left px-3 py-2 hover:bg-gray-900 flex items-center gap-2">
              <span className="text-gray-200 truncate flex-1">{r.title || r.file}</span>
              <Badge text={r.type} palette={TYPE_COLORS} />
              <Badge text={r.validity} palette={VALIDITY_COLORS} />
              <span className="text-gray-500 text-xs">{r.node}</span>
              {!projectId && <span className="text-gray-600 text-xs truncate max-w-40">{r.project}</span>}
            </button>
          ))}
          {!loading && records.length === 0 && <div className="px-3 py-4 text-gray-500">No records.</div>}
        </div>

        {/* Import candidates (per-project) */}
        {projectId && candidates.length > 0 && (
          <div className="border border-gray-800 rounded p-3 space-y-2">
            <div className="text-gray-300 font-medium">Import candidates (newer on other hosts)</div>
            {candidates.map((c, i) => (
              <div key={`${c.source}:${c.filename}:${i}`} className="flex items-center gap-2">
                <span className="text-gray-200 truncate flex-1">{c.filename}</span>
                <span className="text-gray-500 text-xs">{c.source}{c.reason ? ` · ${c.reason}` : ''}</span>
                <button onClick={() => void importToLive(c)}
                  className="px-2 py-0.5 rounded bg-sky-900 text-sky-100 hover:bg-sky-800 text-xs">Import to live</button>
              </div>
            ))}
          </div>
        )}
      </div>

      {selected && (
        <RecordDetail key={selected.recordId} record={selected} call={call} onEdit={onEdit} onClose={() => { setSelected(null); loadRecords(); }} />
      )}
    </div>
  );
}
