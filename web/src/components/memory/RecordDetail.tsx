'use client';

import { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { X, Copy, Check } from 'lucide-react';
import type { CallFn, MapRecord, EditTarget } from './types';
import { errText, ConfirmButton } from './format';

const PROTECTED_MEMORY = new Set(['_cross-project.md', '_hosts.md']);

interface SourceInfo { source: string; dirPath: string; fileCount: number; maxMtimeMs: number }

/** ReactMarkdown link override: external http(s) links open in a new tab;
 *  anything else (relative/in-app routes that don't resolve from a memory
 *  doc) renders as inert styled text instead of a dead-route navigation. */
function MarkdownLink({ href, children }: { href?: string; children?: React.ReactNode }) {
  if (href && /^https?:\/\//i.test(href)) {
    return <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>;
  }
  return <span className="text-gray-400">{children}</span>;
}

export function RecordDetail({ record, call, onEdit, onClose, refreshTick, selfNode }:
  { record: MapRecord; call: CallFn; onEdit?: (t: EditTarget) => void; onClose: () => void; refreshTick?: number; selfNode?: string | null }) {
  const [full, setFull] = useState<MapRecord | null>(null);
  const [sources, setSources] = useState<SourceInfo[]>([]);
  const [source, setSource] = useState('live');
  const [file, setFile] = useState<{ body: string; hash?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // A record is backed by a fetchable memory-dir file only when it's a real
  // memory file or a MEMORY.md bullet. CLAUDE.md sections (kind='claude-section')
  // and user-global pseudo-projects have no by-project file → render-only.
  const isClaudeSection = record.kind === 'claude-section';
  const isIndexEntry = record.kind === 'index-entry';
  const fileBacked = !record.project.startsWith('(') && !isClaudeSection;
  const pid = encodeURIComponent(record.project);
  const fname = encodeURIComponent(record.file);

  useEffect(() => {
    let alive = true;
    setError(null);
    call<MapRecord>(`/memory/record/${encodeURIComponent(record.recordId)}`)
      .then((r) => { if (alive) setFull(r); })
      .catch((e) => { if (alive) setError(errText(e)); });
    if (!fileBacked) return () => { alive = false; };
    call<{ sources: SourceInfo[] }>(`/memory/by-project/${pid}/sources`)
      .then((r) => { if (alive) setSources(r.sources || []); })
      .catch(() => { if (alive) setSources([]); });
    return () => { alive = false; };
  }, [call, record.recordId, pid, fileBacked, refreshTick]);

  useEffect(() => {
    let alive = true;
    setFile(null);
    if (!fileBacked) return () => { alive = false; };
    call<{ body: string; hash?: string }>(`/memory/by-project/${pid}/file/${fname}?source=${encodeURIComponent(source)}`)
      .then((r) => { if (alive) setFile(r); })
      // A missing raw file is not fatal — the rendered record still shows.
      .catch(() => { if (alive) setFile(null); });
    return () => { alive = false; };
  }, [call, pid, fname, source, fileBacked, refreshTick]);

  // Escape closes the pane, but the file-editor overlay (a modal above this
  // pane) wins if it's open — its own Escape handler owns the key then.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (document.querySelector('[data-file-editor]')) return;
      onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const copyText = file?.body ?? full?.complete ?? '';
  const copy = async () => {
    await navigator.clipboard.writeText(copyText);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  // Deleting the file is only meaningful for a standalone memory file — a
  // MEMORY.md bullet must not delete the whole index.
  const editable = fileBacked && source === 'live' && !PROTECTED_MEMORY.has(record.file);
  const deletable = editable && !isIndexEntry;

  return (
    <div className="basis-[36rem] min-w-[20rem] max-w-[36rem] shrink border border-gray-800 rounded bg-gray-950 h-full flex flex-col">
      <div className="p-3 pb-0">
        <div className="flex items-start justify-between gap-2">
          <div>
            <div className="text-gray-100 font-medium">{record.title || record.file}</div>
            <div className="text-gray-500 text-xs flex items-center gap-1.5">
              <span>{record.project} · {record.file} · {record.node}</span>
              {record.node && selfNode && record.node !== selfNode && (
                <span
                  title={`Recorded on ${record.node}; the raw file shown is the copy visible to this node.`}
                  className="text-amber-300/90 text-[10px] border border-amber-900/50 bg-amber-950/30 rounded px-1.5 py-0.5">
                  origin: {record.node}
                </span>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {copyText && (
              <button onClick={() => void copy()} title="Copy" className="text-gray-500 hover:text-gray-200 flex items-center gap-1">
                {copied ? <Check size={16} className="text-emerald-400" /> : <Copy size={16} />}
                {copied && <span className="text-emerald-400 text-[10px]">Copied</span>}
              </button>
            )}
            <button onClick={onClose} className="text-gray-500 hover:text-gray-200"><X size={16} /></button>
          </div>
        </div>
        {error && <div className="text-rose-400 text-xs">{error}</div>}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-3">
        {full?.complete && (
          <div className="prose prose-invert prose-sm max-w-none border-b border-gray-800 pb-3">
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: MarkdownLink }}>{full.complete}</ReactMarkdown>
          </div>
        )}

        {isClaudeSection && (
          <div className="text-gray-500 text-[10px]">Source: {record.file} — project instructions, read-only here.</div>
        )}

        {fileBacked && (
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
            {deletable && file && (
              <ConfirmButton label="Delete" confirmLabel="Confirm delete"
                onConfirm={async () => {
                  try {
                    await call(`/memory/by-project/${pid}/file/${fname}?removeIndexLine=true&expectedHash=${file.hash || ''}`, { method: 'DELETE' });
                    onClose();
                  } catch (e) { setError(errText(e)); }
                }}
              />
            )}
            {!editable && <span className="ml-auto text-gray-500 text-[10px]">read-only ({source === 'live' ? 'managed file' : 'mirror'})</span>}
          </div>
        )}
        {fileBacked && file && (
          <pre className="text-xs text-gray-300 bg-gray-900 rounded p-2 overflow-x-auto whitespace-pre-wrap">{file.body}</pre>
        )}
      </div>
    </div>
  );
}
