'use client';

import { isValidElement, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Lock, RotateCcw, Save } from 'lucide-react';
import { MarkdownSplitEditor } from '@/components/missions/MarkdownSplitEditor';
import { ConfirmButton, errText, timeAgo } from '@/components/memory/format';
import { MermaidBlock } from './MermaidBlock';
import {
  checkRevConflict,
  linkifyDocIds,
  splitRenderedPreamble,
  type WorkflowActorSummary,
  type WorkflowDocSummary,
} from '@/lib/mission-process';

type ApiFetch = <T>(path: string, opts?: { method?: string; body?: unknown }) => Promise<T>;

interface WorkflowGetResponse {
  doc?: (WorkflowDocSummary & { body?: string }) | null;
  defaultBody?: string | null;
  rendered?: string;
}

interface SnapshotRow {
  rev: number;
  at: number;
  actor?: WorkflowActorSummary;
  title?: string;
  editPolicy?: string;
  bodyBytes?: number;
}

type Tab = 'rendered' | 'raw' | 'edit' | 'history';

/**
 * One workflow doc: provenance bar + Rendered (invariant preamble marked
 * immutable) / Raw / Edit (rev-conflict-guarded save) / History (+ rollback).
 */
export function ProcessDetail({
  id,
  apiFetch,
  onDocChanged,
  knownIds,
  onSelectDoc,
}: {
  id: string;
  apiFetch: ApiFetch;
  onDocChanged: () => void;
  /** All doc ids in the loaded registry (stored + defaults) — the linkifier's existence gate. */
  knownIds: ReadonlySet<string>;
  /** Client-side navigation: select another doc in this page (no reload). */
  onSelectDoc: (id: string) => void;
}) {
  const [data, setData] = useState<WorkflowGetResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('rendered');

  // Edit state. loadedRev is the optimistic-concurrency anchor: the rev we last
  // loaded (0 = un-stored default). Save re-GETs and refuses if it advanced.
  const [draftTitle, setDraftTitle] = useState('');
  const [draftBody, setDraftBody] = useState('');
  const [baseTitle, setBaseTitle] = useState('');
  const [baseBody, setBaseBody] = useState('');
  const [loadedRev, setLoadedRev] = useState(0);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<{ freshRev: number; byKind?: string } | null>(null);

  const [snapshots, setSnapshots] = useState<SnapshotRow[] | null>(null);
  const [histLoading, setHistLoading] = useState(false);
  const [histError, setHistError] = useState<string | null>(null);

  // Drop responses of a superseded request (fast doc switching).
  const seqRef = useRef(0);

  // Markdown overrides for the Rendered view: #doc: links become client-side
  // navigation chips, and ```mermaid fences render as diagrams (pre unwrapped).
  const mdComponents = useMemo<Components>(() => ({
    a: ({ href, children }) => {
      if (typeof href === 'string' && href.startsWith('#doc:')) {
        const target = href.slice('#doc:'.length);
        return (
          <button
            type="button"
            className="badge badge-blue"
            style={{ cursor: 'pointer', fontFamily: 'var(--font-mono)', verticalAlign: 'baseline' }}
            title={`Open ${target}`}
            onClick={() => onSelectDoc(target)}
          >
            {children}
          </button>
        );
      }
      return (
        <a href={href} target="_blank" rel="noreferrer">
          {children}
        </a>
      );
    },
    code: ({ className, children }) => {
      if (typeof className === 'string' && className.includes('language-mermaid')) {
        return <MermaidBlock chart={String(children ?? '').replace(/\n$/, '')} />;
      }
      return <code className={className}>{children}</code>;
    },
    pre: ({ children }) => {
      // A mermaid fence renders itself (MermaidBlock) — drop the surrounding <pre>.
      const child = Array.isArray(children) ? (children as ReactNode[])[0] : children;
      if (
        isValidElement(child) &&
        typeof (child.props as { className?: unknown }).className === 'string' &&
        ((child.props as { className: string }).className.includes('language-mermaid'))
      ) {
        return <>{children}</>;
      }
      return <pre>{children}</pre>;
    },
  }), [onSelectDoc]);

  const load = useCallback(async () => {
    const seq = ++seqRef.current;
    setLoading(true);
    setError(null);
    try {
      const r = await apiFetch<WorkflowGetResponse>(`/mission/workflows/${encodeURIComponent(id)}`);
      if (seq !== seqRef.current) return;
      setData(r);
      const body = r.doc?.body ?? r.defaultBody ?? '';
      const title = r.doc?.title ?? id;
      setDraftBody(body);
      setDraftTitle(title);
      setBaseBody(body);
      setBaseTitle(title);
      setLoadedRev(r.doc?.rev ?? 0);
      setConflict(null);
    } catch (e) {
      if (seq !== seqRef.current) return;
      setError(errText(e));
      setData(null);
    } finally {
      if (seq === seqRef.current) setLoading(false);
    }
  }, [apiFetch, id]);

  const loadHistory = useCallback(async () => {
    setHistLoading(true);
    setHistError(null);
    try {
      const r = await apiFetch<{ snapshots?: SnapshotRow[] }>(
        `/mission/workflows/${encodeURIComponent(id)}/history`,
      );
      setSnapshots(r.snapshots ?? []);
    } catch (e) {
      setHistError(errText(e));
    } finally {
      setHistLoading(false);
    }
  }, [apiFetch, id]);

  useEffect(() => {
    setTab('rendered');
    setSaveError(null);
    setConflict(null);
    setSnapshots(null);
    void load();
  }, [id, load]);

  useEffect(() => {
    if (tab === 'history' && snapshots === null && !histLoading) void loadHistory();
  }, [tab, snapshots, histLoading, loadHistory]);

  const doc = data?.doc ?? null;
  const humanOnly = doc?.editPolicy === 'human-only';
  const dirty = draftBody !== baseBody || draftTitle !== baseTitle;

  const save = async () => {
    if (saving) return;
    setSaving(true);
    setSaveError(null);
    setConflict(null);
    try {
      // Rev-conflict guard: re-GET and refuse when someone else edited since load.
      const fresh = await apiFetch<WorkflowGetResponse>(`/mission/workflows/${encodeURIComponent(id)}`);
      const chk = checkRevConflict(loadedRev, fresh.doc ?? null);
      if (chk.conflict) {
        setConflict({ freshRev: chk.freshRev, byKind: fresh.doc?.lastUpdatedBy?.kind });
        return;
      }
      await apiFetch(`/mission/workflows/${encodeURIComponent(id)}`, {
        method: 'POST',
        body: { title: draftTitle, body: draftBody },
      });
      await load();
      onDocChanged();
    } catch (e) {
      setSaveError(errText(e));
    } finally {
      setSaving(false);
    }
  };

  const rollback = async (toRev: number) => {
    setHistError(null);
    try {
      await apiFetch(`/mission/workflows/${encodeURIComponent(id)}/rollback`, {
        method: 'POST',
        body: { toRev },
      });
      await load();
      await loadHistory();
      onDocChanged();
    } catch (e) {
      setHistError(errText(e));
    }
  };

  if (loading && !data) {
    return <div style={{ padding: 20, fontSize: 12, color: 'var(--color-text-tertiary)' }}>Loading {id}…</div>;
  }
  if (error) {
    return (
      <div style={{ padding: 20 }}>
        <div style={{ fontSize: 12, color: 'var(--color-status-red)' }}>{error}</div>
        <button className="btn btn-sm btn-ghost" style={{ marginTop: 8 }} onClick={() => void load()}>
          Retry
        </button>
      </div>
    );
  }
  if (!data) return null;

  const rawBody = doc?.body ?? data.defaultBody ?? '';
  const { preamble, body: renderedBody } = splitRenderedPreamble(data.rendered ?? '');
  // Known-id link chips only touch prose (fenced blocks stay byte-identical for mermaid).
  const linkedBody = linkifyDocIds(renderedBody, knownIds);

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* Provenance bar */}
      <div
        style={{
          padding: '12px 20px',
          borderBottom: '1px solid var(--color-border-default)',
          display: 'flex',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: 8,
          flexShrink: 0,
        }}
      >
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 13, color: 'var(--color-text-primary)' }}>{id}</span>
        <span style={{ fontSize: 13, color: 'var(--color-text-secondary)' }}>{doc?.title ?? '(default doc)'}</span>
        {doc ? (
          <span className="badge badge-outline">rev {doc.rev}</span>
        ) : (
          <span className="badge badge-default">default — not stored yet</span>
        )}
        {doc && (
          <span className={`badge ${humanOnly ? 'badge-blue' : 'badge-default'}`}>{doc.editPolicy}</span>
        )}
        {doc?.lastUpdatedBy && (
          <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>
            last edit: {doc.lastUpdatedBy.kind ?? 'unknown'}
            {doc.updatedAt ? ` · ${timeAgo(doc.updatedAt)} (${new Date(doc.updatedAt).toLocaleString()})` : ''}
          </span>
        )}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
          {(['rendered', 'raw', 'edit', 'history'] as const).map((t) => (
            <button
              key={t}
              className={`btn btn-sm ${tab === t ? 'btn-primary' : 'btn-ghost'}`}
              style={{ fontSize: 11, textTransform: 'capitalize' }}
              onClick={() => setTab(t)}
            >
              {t}
            </button>
          ))}
        </div>
      </div>

      {/* Tab content */}
      {tab === 'rendered' && (
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 20 }}>
          {preamble && (
            <div
              style={{
                marginBottom: 16,
                padding: '10px 12px',
                borderRadius: 'var(--radius-sm)',
                border: '1px dashed var(--color-border-strong)',
                background: 'var(--color-bg-elevated)',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  fontSize: 11,
                  fontWeight: 600,
                  color: 'var(--color-text-tertiary)',
                  marginBottom: 6,
                }}
              >
                <Lock size={11} /> INVARIANT PREAMBLE — immutable; prepended to every doc, not editable by anyone
              </div>
              <pre
                style={{
                  margin: 0,
                  whiteSpace: 'pre-wrap',
                  fontFamily: 'var(--font-mono)',
                  fontSize: 11,
                  lineHeight: 1.5,
                  color: 'var(--color-text-secondary)',
                }}
              >
                {preamble}
              </pre>
            </div>
          )}
          <div className="prose" style={{ fontSize: 13, lineHeight: 1.6 }}>
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>
              {linkedBody}
            </ReactMarkdown>
          </div>
        </div>
      )}

      {tab === 'raw' && (
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 20 }}>
          <pre
            style={{
              margin: 0,
              whiteSpace: 'pre-wrap',
              fontFamily: 'var(--font-mono)',
              fontSize: 12,
              lineHeight: 1.6,
              color: 'var(--color-text-primary)',
            }}
          >
            {rawBody}
          </pre>
        </div>
      )}

      {tab === 'edit' &&
        (humanOnly ? (
          <div style={{ padding: 20, maxWidth: 560 }}>
            <div
              style={{
                padding: '12px 14px',
                borderRadius: 'var(--radius-sm)',
                border: '1px solid var(--color-border-strong)',
                background: 'var(--color-bg-elevated)',
                fontSize: 12,
                lineHeight: 1.6,
                color: 'var(--color-text-secondary)',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 600, marginBottom: 6 }}>
                <Lock size={12} /> Read-only: this doc is human-only
              </div>
              Its editPolicy is <code>human-only</code>, so the controller may never change it and this page keeps it
              read-only too. Edit it via the MCP <code>mission_workflow_set</code> tool if you really need to change
              it; History and Rollback remain available here.
            </div>
          </div>
        ) : (
          <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            {conflict && (
              <div
                style={{
                  margin: '10px 20px 0',
                  padding: '8px 12px',
                  borderRadius: 'var(--radius-sm)',
                  border: '1px solid rgba(251,191,36,0.5)',
                  background: 'rgba(251,191,36,0.08)',
                  fontSize: 12,
                  color: 'var(--color-status-orange)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  flexShrink: 0,
                }}
              >
                <span>
                  Doc changed since you loaded it (rev {loadedRev} → {conflict.freshRev}
                  {conflict.byKind ? `, by ${conflict.byKind}` : ''}). Save refused — reload to continue; your draft
                  stays in the editor until you reload.
                </span>
                <button className="btn btn-sm btn-ghost" style={{ flexShrink: 0 }} onClick={() => void load()}>
                  <RotateCcw size={11} /> Reload (discard draft)
                </button>
              </div>
            )}
            {saveError && (
              <div
                style={{
                  margin: '10px 20px 0',
                  padding: '8px 12px',
                  borderRadius: 'var(--radius-sm)',
                  border: '1px solid rgba(248,113,113,0.4)',
                  background: 'rgba(248,113,113,0.08)',
                  fontSize: 12,
                  color: 'var(--color-status-red)',
                  flexShrink: 0,
                }}
              >
                {saveError}
              </div>
            )}
            <div style={{ padding: '10px 20px 0', display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
              <input
                className="input"
                value={draftTitle}
                onChange={(e) => setDraftTitle(e.target.value)}
                placeholder="Title"
                style={{ flex: 1, fontSize: 13 }}
              />
              <button
                className="btn btn-sm btn-ghost"
                disabled={!dirty || saving}
                onClick={() => {
                  setDraftBody(baseBody);
                  setDraftTitle(baseTitle);
                  setSaveError(null);
                  setConflict(null);
                }}
              >
                Revert
              </button>
              <button className="btn btn-sm btn-primary" disabled={!dirty || saving} onClick={() => void save()}>
                <Save size={12} /> {saving ? 'Saving…' : `Save (rev ${loadedRev} → ${loadedRev + 1})`}
              </button>
            </div>
            <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', padding: '10px 20px 20px' }}>
              <MarkdownSplitEditor value={draftBody} onChange={setDraftBody} mono />
            </div>
          </div>
        ))}

      {tab === 'history' && (
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 20 }}>
          {histError && (
            <div style={{ marginBottom: 10, fontSize: 12, color: 'var(--color-status-red)' }}>{histError}</div>
          )}
          {histLoading && <div style={{ fontSize: 12, color: 'var(--color-text-tertiary)' }}>Loading history…</div>}
          {!histLoading && snapshots && snapshots.length === 0 && (
            <div style={{ fontSize: 12, color: 'var(--color-text-tertiary)' }}>
              No snapshots yet — the doc has never been written (defaults have no history).
            </div>
          )}
          {!histLoading && snapshots && snapshots.length > 0 && (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ textAlign: 'left', color: 'var(--color-text-tertiary)' }}>
                  <th style={{ padding: '4px 8px' }}>rev</th>
                  <th style={{ padding: '4px 8px' }}>when</th>
                  <th style={{ padding: '4px 8px' }}>actor</th>
                  <th style={{ padding: '4px 8px' }}>title</th>
                  <th style={{ padding: '4px 8px' }}>bytes</th>
                  <th style={{ padding: '4px 8px' }} />
                </tr>
              </thead>
              <tbody>
                {snapshots.map((s) => (
                  <tr key={s.rev} style={{ borderTop: '1px solid var(--color-border-subtle)' }}>
                    <td style={{ padding: '6px 8px', fontFamily: 'var(--font-mono)' }}>
                      {s.rev}
                      {doc && s.rev === doc.rev && (
                        <span className="badge badge-green" style={{ marginLeft: 6, fontSize: 9 }}>current</span>
                      )}
                    </td>
                    <td style={{ padding: '6px 8px' }} title={new Date(s.at).toLocaleString()}>
                      {timeAgo(s.at)}
                    </td>
                    <td style={{ padding: '6px 8px' }}>{s.actor?.kind ?? 'unknown'}</td>
                    <td
                      style={{
                        padding: '6px 8px',
                        maxWidth: 260,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {s.title ?? ''}
                    </td>
                    <td style={{ padding: '6px 8px', fontFamily: 'var(--font-mono)' }}>{s.bodyBytes ?? ''}</td>
                    <td style={{ padding: '6px 8px', textAlign: 'right' }}>
                      {(!doc || s.rev !== doc.rev) && (
                        <ConfirmButton
                          label="Rollback"
                          confirmLabel={`Roll back to rev ${s.rev}?`}
                          onConfirm={() => rollback(s.rev)}
                        />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}
