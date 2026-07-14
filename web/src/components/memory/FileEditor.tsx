'use client';

import { useEffect, useState } from 'react';
import { MarkdownSplitEditor } from '@/components/missions/MarkdownSplitEditor';
import type { CallFn, EditTarget } from './types';
import { errText } from './format';

const MEMORY_TEMPLATE = `---
name: short-kebab-slug
description: one-line summary used for recall
type: project
---

The fact. Keep it one topic per file.
`;

function pathsFor(t: EditTarget, filename: string) {
  if (t.kind === 'rule') {
    return {
      put: `/rules/file/${encodeURIComponent(filename)}`,
      post: `/rules/file`,
    };
  }
  const pid = encodeURIComponent(t.projectId!);
  return {
    put: `/memory/by-project/${pid}/file/${encodeURIComponent(filename)}`,
    post: `/memory/by-project/${pid}/file`,
  };
}

export function FileEditor({ target, call, onDone }:
  { target: EditTarget; call: CallFn; onDone: (saved: boolean) => void }) {
  const [created, setCreated] = useState(false);
  const [savedAny, setSavedAny] = useState(false);
  const isCreate = !target.filename && !created; // a warned create flips to edit mode
  const [filename, setFilename] = useState(target.filename);
  const initialContent = !target.filename && !target.content ? MEMORY_TEMPLATE : target.content;
  const [content, setContent] = useState(initialContent);
  const [baseline, setBaseline] = useState(initialContent); // last saved (or loaded) content, for the dirty check
  const [indexLine, setIndexLine] = useState('');
  const [hash, setHash] = useState<string | undefined>(target.hash);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  const save = async (overwrite = false) => {
    setBusy(true); setError(null); setConflict(false);
    const p = pathsFor(target, filename);
    try {
      let w: string[] = [];
      if (isCreate) {
        const body: Record<string, unknown> = { filename, content };
        if (target.kind === 'memory' && indexLine.trim()) body.indexLine = indexLine.trim();
        const r = await call<{ hash?: string; warnings?: string[] }>(p.post, { method: 'POST', body });
        setSavedAny(true); setCreated(true); setHash(r.hash); w = r.warnings || [];
      } else {
        const body: Record<string, unknown> = { content };
        if (hash && !overwrite) body.expectedHash = hash;
        const r = await call<{ hash?: string; warnings?: string[] }>(p.put, { method: 'PUT', body });
        setSavedAny(true); setHash(r.hash); w = r.warnings || [];
      }
      if (w.length === 0) { onDone(true); return; }
      // Saved, but with frontmatter warnings — stay open so they're visible.
      setWarnings(w); setBaseline(content);
    } catch (e) {
      if (String(e).includes('HASH_MISMATCH')) setConflict(true);
      else setError(errText(e));
    } finally { setBusy(false); }
  };

  const reload = async () => {
    setBusy(true); setError(null); setConflict(false);
    try {
      // Field asymmetry: rules GET returns `content`, memory GET returns `body`.
      if (target.kind === 'rule') {
        const r = await call<{ content: string; hash?: string }>(`/rules/file/${encodeURIComponent(filename)}`);
        setContent(r.content); setBaseline(r.content); setHash(r.hash);
      } else {
        const r = await call<{ body: string; hash?: string }>(
          `/memory/by-project/${encodeURIComponent(target.projectId!)}/file/${encodeURIComponent(filename)}`);
        setContent(r.body); setBaseline(r.body); setHash(r.hash);
      }
    } catch (e) { setError(errText(e)); } finally { setBusy(false); }
  };

  const dirty = content !== baseline;

  const cancel = () => {
    if (busy) return; // mid-save — Escape must not close the editor (Cancel button is already disabled on busy)
    if (dirty) { setConfirmDiscard(true); return; }
    onDone(savedAny); // any successful save this session (create or edit, warned or clean) still refreshes the list on close
  };

  // Warn on tab close mid-edit; only while there are unsaved changes.
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);

  // Escape triggers the same cancel flow as the Cancel button (discard-bar
  // gate included) — this is the editor overlay, so it always owns Escape
  // (no [data-file-editor] deference needed here — the overlay IS that gate
  // for RecordDetail/RulesBrowser).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') cancel(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [dirty, savedAny, onDone]);

  return (
    <div data-file-editor className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-6">
      <div className="bg-gray-950 border border-gray-700 rounded-lg w-full max-w-4xl h-[80vh] flex flex-col p-4 gap-3">
        <div className="flex items-center gap-2">
          <span className="text-gray-100 font-medium">{isCreate ? 'New' : 'Edit'} {target.kind === 'rule' ? 'rule' : 'memory'}</span>
          {isCreate ? (
            <input value={filename} onChange={(e) => setFilename(e.target.value)} placeholder="filename.md"
              className="bg-gray-900 border border-gray-700 rounded px-2 py-1 text-sm text-gray-200 flex-1" />
          ) : (
            <span className="text-gray-400 text-sm">{filename}{target.projectId ? ` · ${target.projectId}` : ''}</span>
          )}
        </div>
        {isCreate && target.kind === 'memory' && (
          <input value={indexLine} onChange={(e) => setIndexLine(e.target.value)}
            placeholder="MEMORY.md index line (optional): - [Title](filename.md) — hook"
            className="bg-gray-900 border border-gray-700 rounded px-2 py-1 text-xs text-gray-300" />
        )}
        <MarkdownSplitEditor value={content} onChange={setContent} mono />
        {warnings.length > 0 && <div className="text-amber-400 text-xs">{warnings.join(' · ')}</div>}
        {error && <div className="text-rose-400 text-xs">{error}</div>}
        {conflict && (
          <div className="text-amber-300 text-xs flex items-center gap-2">
            File changed on disk since you loaded it.
            <button onClick={() => void reload()} className="px-2 py-0.5 rounded bg-gray-800 hover:bg-gray-700">Reload (discard my edit)</button>
            <button onClick={() => void save(true)} className="px-2 py-0.5 rounded bg-rose-900 hover:bg-rose-800">Overwrite anyway</button>
          </div>
        )}
        {confirmDiscard && (
          <div className="text-amber-300 text-xs flex items-center gap-2">
            Unsaved changes.
            <button onClick={() => onDone(savedAny)} className="px-2 py-0.5 rounded bg-rose-900 hover:bg-rose-800">Discard</button>
            <button onClick={() => setConfirmDiscard(false)} className="px-2 py-0.5 rounded bg-gray-800 hover:bg-gray-700">Keep editing</button>
          </div>
        )}
        <div className="flex justify-end gap-2">
          <button onClick={cancel} disabled={busy}
            className="px-3 py-1 rounded text-sm text-gray-300 hover:text-gray-100">Cancel</button>
          <button onClick={() => void save()} disabled={busy || !filename.endsWith('.md') || !content.trim()}
            className="px-3 py-1 rounded text-sm bg-emerald-800 text-emerald-100 hover:bg-emerald-700 disabled:opacity-50">
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
