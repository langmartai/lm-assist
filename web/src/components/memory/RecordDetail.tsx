'use client';

import { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { X } from 'lucide-react';
import type { CallFn, MapRecord, EditTarget } from './types';

const PROTECTED_MEMORY = new Set(['_cross-project.md', '_hosts.md']);

interface SourceInfo { source: string; dirPath: string; fileCount: number; maxMtimeMs: number }

export function RecordDetail({ record, call, onEdit, onClose }:
  { record: MapRecord; call: CallFn; onEdit?: (t: EditTarget) => void; onClose: () => void }) {
  const [full, setFull] = useState<MapRecord | null>(null);
  const [sources, setSources] = useState<SourceInfo[]>([]);
  const [source, setSource] = useState('live');
  const [file, setFile] = useState<{ body: string; hash?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  // CLAUDE.md-section records use pseudo-projects like '(user-global)' — no
  // by-project file access for those; record render only.
  const hasFileAccess = !record.project.startsWith('(');
  const pid = encodeURIComponent(record.project);
  const fname = encodeURIComponent(record.file);

  useEffect(() => {
    let alive = true;
    setError(null);
    call<MapRecord>(`/memory/record/${encodeURIComponent(record.recordId)}`)
      .then((r) => { if (alive) setFull(r); })
      .catch((e) => { if (alive) setError(String(e)); });
    if (!hasFileAccess) return () => { alive = false; };
    call<{ sources: SourceInfo[] }>(`/memory/by-project/${pid}/sources`)
      .then((r) => { if (alive) setSources(r.sources || []); })
      .catch(() => { if (alive) setSources([]); });
    return () => { alive = false; };
  }, [call, record.recordId, pid, hasFileAccess]);

  useEffect(() => {
    let alive = true;
    setFile(null);
    setError(null);
    if (!hasFileAccess) return () => { alive = false; };
    call<{ body: string; hash?: string }>(`/memory/by-project/${pid}/file/${fname}?source=${encodeURIComponent(source)}`)
      .then((r) => { if (alive) setFile(r); })
      .catch((e) => { if (alive) setError(String(e)); });
    return () => { alive = false; };
  }, [call, pid, fname, source, hasFileAccess]);

  const editable = hasFileAccess && source === 'live' && !PROTECTED_MEMORY.has(record.file);

  return (
    <div className="w-[36rem] shrink-0 border border-gray-800 rounded p-3 space-y-3 bg-gray-950 max-h-[80vh] overflow-y-auto">
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="text-gray-100 font-medium">{record.title || record.file}</div>
          <div className="text-gray-500 text-xs">{record.project} · {record.file} · {record.node}</div>
        </div>
        <button onClick={onClose} className="text-gray-500 hover:text-gray-200"><X size={16} /></button>
      </div>
      {error && <div className="text-rose-400 text-xs">{error}</div>}

      {full?.complete && (
        <div className="prose prose-invert prose-sm max-w-none border-b border-gray-800 pb-3">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{full.complete}</ReactMarkdown>
        </div>
      )}

      {hasFileAccess && (
        <div className="flex items-center gap-2">
          <span className="text-gray-400 text-xs">Raw file:</span>
          <select value={source} onChange={(e) => setSource(e.target.value)}
            className="bg-gray-800 border border-gray-700 rounded px-1.5 py-0.5 text-xs text-gray-200">
            {(sources.length ? sources.map((s) => s.source) : ['live']).map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
          {onEdit && editable && file && (
            <button
              onClick={() => onEdit({ kind: 'memory', projectId: record.project, filename: record.file, content: file.body, hash: file.hash })}
              className="ml-auto px-2 py-0.5 rounded bg-emerald-800 text-emerald-100 hover:bg-emerald-700 text-xs">
              Edit
            </button>
          )}
          {!editable && <span className="ml-auto text-gray-500 text-[10px]">read-only ({source === 'live' ? 'managed file' : 'mirror'})</span>}
        </div>
      )}
      {file && (
        <pre className="text-xs text-gray-300 bg-gray-900 rounded p-2 overflow-x-auto whitespace-pre-wrap">{file.body}</pre>
      )}
    </div>
  );
}
