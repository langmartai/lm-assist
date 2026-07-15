'use client';

import { isValidElement, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { AlertTriangle, RotateCcw, Save } from 'lucide-react';
import { MarkdownSplitEditor } from '@/components/missions/MarkdownSplitEditor';
import { ConfirmButton, errText, timeAgo } from '@/components/memory/format';
import { MermaidBlock } from '@/components/mission-processes/MermaidBlock';
import { checkRevConflict } from '@/lib/mission-process';
import {
  formatBytes,
  utf8Bytes,
  type ContentDetailResponse,
  type ContentDocView,
} from '@/lib/assist-content';

type ApiFetch = <T>(path: string, opts?: { method?: string; body?: unknown }) => Promise<T>;

type Tab = 'rendered' | 'raw' | 'edit' | 'history';

const MAX_CONTENT_OVERRIDE_BYTES = 16384;

/**
 * One content unit: provenance bar + Rendered / Raw / Edit (rev-conflict-guarded save,
 * Restore-default) / History (+ rollback). Mirrors ProcessDetail's tab UX; writes apply
 * the ORIGIN's returned doc directly (ToolDetail idiom — a re-GET on a non-origin node
 * reads the lagging replica and would make the save look dropped).
 */
export function ContentDetail({
  id,
  apiFetch,
  onDocChanged,
  onSelectUnit,
}: {
  id: string;
  apiFetch: ApiFetch;
  onDocChanged: () => void;
  /** Navigate to another unit — powers the overview's [`unit.id`](#doc:unit.id) chips
   *  (same mechanism as ProcessDetail's doc links). */
  onSelectUnit?: (id: string) => void;
}) {
  const [data, setData] = useState<ContentDetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('rendered');

  // Edit state. loadedRev is the optimistic-concurrency anchor: the rev we last
  // loaded (0 = un-stored default). Save re-GETs and refuses if it advanced.
  const [draftBody, setDraftBody] = useState('');
  const [baseBody, setBaseBody] = useState('');
  const [draftBlurb, setDraftBlurb] = useState('');
  const [baseBlurb, setBaseBlurb] = useState('');
  const [loadedRev, setLoadedRev] = useState(0);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<{ freshRev: number; byKind?: string } | null>(null);

  // Drop responses of a superseded request (fast unit switching).
  const seqRef = useRef(0);

  const applyLoaded = useCallback((r: ContentDetailResponse) => {
    setData(r);
    const body = r.effectiveBody ?? '';
    const blurb = r.effectiveBlurb ?? '';
    setDraftBody(body);
    setBaseBody(body);
    setDraftBlurb(blurb);
    setBaseBlurb(blurb);
    setLoadedRev(r.doc?.rev ?? 0);
    setConflict(null);
  }, []);

  const load = useCallback(async () => {
    const seq = ++seqRef.current;
    setLoading(true);
    setError(null);
    try {
      const r = await apiFetch<ContentDetailResponse>(`/assist-content/${encodeURIComponent(id)}`);
      if (seq !== seqRef.current) return;
      applyLoaded(r);
    } catch (e) {
      if (seq !== seqRef.current) return;
      setError(errText(e));
      setData(null);
    } finally {
      if (seq === seqRef.current) setLoading(false);
    }
  }, [apiFetch, id, applyLoaded]);

  useEffect(() => {
    setTab('rendered');
    setSaveError(null);
    setConflict(null);
    void load();
  }, [id, load]);

  const doc = data?.doc ?? null;
  const knownUnit = data?.knownUnit ?? false;
  const hasBlurb = data?.hasBlurb ?? false;
  const dirty = draftBody !== baseBody || (hasBlurb && draftBlurb !== baseBlurb);
  const draftBytes = utf8Bytes(draftBody);
  const overCap = draftBytes > MAX_CONTENT_OVERRIDE_BYTES;

  /** Writes are origin-anchored; the response carries the ORIGIN's fresh doc — apply
   *  it in place instead of re-GETting the (possibly lagging) local replica. */
  const applyDoc = useCallback((newDoc: ContentDocView | null | undefined) => {
    if (!newDoc || !data) return false;
    const next: ContentDetailResponse = {
      ...data,
      doc: newDoc,
      effectiveBody: newDoc.contentOverride ?? data.defaultBody,
      effectiveBlurb: newDoc.blurbOverride ?? data.defaultBlurb ?? null,
    };
    applyLoaded(next);
    return true;
  }, [data, applyLoaded]);

  /** All registry writes flow through here: rev-conflict pre-check, POST, apply. */
  const post = async (body: Record<string, unknown>, opts?: { skipConflictCheck?: boolean }) => {
    if (saving) return;
    setSaving(true);
    setSaveError(null);
    setConflict(null);
    try {
      if (!opts?.skipConflictCheck) {
        const fresh = await apiFetch<ContentDetailResponse>(`/assist-content/${encodeURIComponent(id)}`);
        const chk = checkRevConflict(loadedRev, fresh.doc ?? null);
        if (chk.conflict) {
          setConflict({ freshRev: chk.freshRev, byKind: fresh.doc?.lastUpdatedBy?.kind });
          return;
        }
      }
      const r = await apiFetch<{ doc?: ContentDocView }>(`/assist-content/${encodeURIComponent(id)}`, { method: 'POST', body });
      if (!applyDoc(r?.doc)) await load();
      onDocChanged();
    } catch (e) {
      setSaveError(errText(e));
    } finally {
      setSaving(false);
    }
  };

  const save = async () => {
    const body: Record<string, unknown> = { contentOverride: draftBody };
    if (hasBlurb && draftBlurb !== baseBlurb) {
      // An emptied blurb field means "back to the code default" (null), not an empty string.
      body.blurbOverride = draftBlurb.trim() === '' ? null : draftBlurb;
    }
    await post(body);
  };

  const restoreDefault = async () => {
    await post({ contentOverride: null, ...(hasBlurb ? { blurbOverride: null } : {}) }, { skipConflictCheck: true });
  };

  const rollback = async (toRev: number) => {
    if (saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      const r = await apiFetch<{ doc?: ContentDocView }>(`/assist-content/${encodeURIComponent(id)}/rollback`, {
        method: 'POST',
        body: { toRev },
      });
      if (!applyDoc(r?.doc)) await load();
      onDocChanged();
    } catch (e) {
      setSaveError(errText(e));
    } finally {
      setSaving(false);
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

  const effectiveBody = data.effectiveBody ?? '';
  const overridden = doc?.contentOverride != null;

  const mdComponents = {
    a: ({ href, children }: { href?: string; children?: ReactNode }) => {
      if (typeof href === 'string' && href.startsWith('#doc:') && onSelectUnit) {
        const target = href.slice('#doc:'.length);
        return (
          <button
            type="button"
            className="badge badge-blue"
            style={{ cursor: 'pointer', fontFamily: 'var(--font-mono)', verticalAlign: 'baseline' }}
            title={`Open ${target}`}
            onClick={() => onSelectUnit(target)}
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
    code: ({ className, children }: { className?: string; children?: ReactNode }) => {
      if (typeof className === 'string' && className.includes('language-mermaid')) {
        return <MermaidBlock chart={String(children ?? '').replace(/\n$/, '')} />;
      }
      return <code className={className}>{children}</code>;
    },
    pre: ({ children }: { children?: ReactNode }) => {
      const child = Array.isArray(children) ? (children as ReactNode[])[0] : children;
      if (
        isValidElement(child) &&
        typeof (child.props as { className?: unknown }).className === 'string' &&
        (child.props as { className: string }).className.includes('language-mermaid')
      ) {
        return <>{children}</>;
      }
      return <pre>{children}</pre>;
    },
  };

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
        <span style={{ fontSize: 13, color: 'var(--color-text-secondary)' }}>
          {data.title ?? (knownUnit ? '' : '(orphan doc — no code unit)')}
        </span>
        {doc ? (
          <span className="badge badge-outline">rev {doc.rev}</span>
        ) : (
          <span className="badge badge-default">default — not stored yet</span>
        )}
        {overridden && <span className="badge badge-blue">override</span>}
        {doc?.blurbOverride != null && <span className="badge badge-blue">blurb</span>}
        {(data.renderedIn ?? []).map((t) => (
          <span key={t} className="badge badge-default" title={`This unit's body renders in the ${t} tool output`}>
            §{t}
          </span>
        ))}
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

      {/* Tab content */}
      {tab === 'rendered' && (
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 20 }}>
          {!knownUnit && (
            <div style={{ marginBottom: 12, fontSize: 12, color: 'var(--color-status-orange)', display: 'flex', gap: 6, alignItems: 'center' }}>
              <AlertTriangle size={12} /> Orphan doc — this build emits no such unit, so it NEVER renders in bootstrap/guide.
            </div>
          )}
          {knownUnit && data.key === 'index' && data.group === 'guide' && (
            <div style={{ marginBottom: 12, fontSize: 11, color: 'var(--color-text-tertiary)' }}>
              The `## Topics` list that follows this preamble in the live guide output is GENERATED from the topic
              catalog (edit a topic's one-liner via its own doc; the list itself stays code-owned).
            </div>
          )}
          {hasBlurb && (
            <div style={{ marginBottom: 12, fontSize: 12, color: 'var(--color-text-secondary)' }}>
              <span style={{ color: 'var(--color-text-tertiary)' }}>index one-liner:</span>{' '}
              {data.effectiveBlurb ?? ''}
              {doc?.blurbOverride != null && <span className="badge badge-blue" style={{ marginLeft: 6, fontSize: 9 }}>override</span>}
            </div>
          )}
          <div className="prose" style={{ fontSize: 13, lineHeight: 1.6 }}>
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>
              {effectiveBody}
            </ReactMarkdown>
          </div>
        </div>
      )}

      {tab === 'raw' && (
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 20 }}>
          {overridden && data.defaultBody != null && (
            <div style={{ marginBottom: 10, fontSize: 11, color: 'var(--color-text-tertiary)' }}>
              Showing the OVERRIDE (rev {doc?.rev}); the code default ({formatBytes(utf8Bytes(data.defaultBody))}) is
              restorable from the Edit tab.
            </div>
          )}
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
            {effectiveBody}
          </pre>
        </div>
      )}

      {tab === 'edit' && (
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
          {!knownUnit && (
            <div style={{ margin: '10px 20px 0', fontSize: 12, color: 'var(--color-status-orange)', display: 'flex', gap: 6, alignItems: 'center', flexShrink: 0 }}>
              <AlertTriangle size={12} /> Orphan doc — edits persist (history/rollback work) but never render anywhere.
            </div>
          )}
          {hasBlurb && (
            <div style={{ padding: '10px 20px 0', display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
              <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)', flexShrink: 0 }}>index one-liner</span>
              <input
                className="input"
                value={draftBlurb}
                onChange={(e) => setDraftBlurb(e.target.value)}
                placeholder="(empty = restore the code default)"
                style={{ flex: 1, fontSize: 12 }}
              />
            </div>
          )}
          <div style={{ padding: '10px 20px 0', display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
            <span style={{ fontSize: 11, color: overCap ? 'var(--color-status-red)' : 'var(--color-text-tertiary)' }}>
              {formatBytes(draftBytes)} / {formatBytes(MAX_CONTENT_OVERRIDE_BYTES)}
            </span>
            {overridden && (
              <ConfirmButton
                label="Restore default"
                confirmLabel="Really restore the code default?"
                onConfirm={() => void restoreDefault()}
              />
            )}
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
              <button
                className="btn btn-sm btn-ghost"
                disabled={!dirty || saving}
                onClick={() => {
                  setDraftBody(baseBody);
                  setDraftBlurb(baseBlurb);
                  setSaveError(null);
                  setConflict(null);
                }}
              >
                Revert
              </button>
              <button className="btn btn-sm btn-primary" disabled={!dirty || saving || overCap} onClick={() => void save()}>
                <Save size={12} /> {saving ? 'Saving…' : `Save (rev ${loadedRev} → ${loadedRev + 1})`}
              </button>
            </div>
          </div>
          <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', padding: '10px 20px 20px' }}>
            <MarkdownSplitEditor value={draftBody} onChange={setDraftBody} mono />
          </div>
        </div>
      )}

      {tab === 'history' && (
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 20 }}>
          {!doc || doc.history.length === 0 ? (
            <div style={{ fontSize: 12, color: 'var(--color-text-tertiary)' }}>
              No revisions yet — the doc has never been written (defaults have no history).
            </div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ textAlign: 'left', color: 'var(--color-text-tertiary)' }}>
                  <th style={{ padding: '4px 8px' }}>rev</th>
                  <th style={{ padding: '4px 8px' }}>when</th>
                  <th style={{ padding: '4px 8px' }}>actor</th>
                  <th style={{ padding: '4px 8px' }}>override</th>
                  <th style={{ padding: '4px 8px' }}>blurb</th>
                  <th style={{ padding: '4px 8px' }} />
                </tr>
              </thead>
              <tbody>
                {[...doc.history].reverse().map((h) => (
                  <tr key={h.rev} style={{ borderTop: '1px solid var(--color-border-subtle)' }}>
                    <td style={{ padding: '6px 8px', fontFamily: 'var(--font-mono)' }}>
                      {h.rev}
                      {h.rev === doc.rev && (
                        <span className="badge badge-green" style={{ marginLeft: 6, fontSize: 9 }}>current</span>
                      )}
                    </td>
                    <td style={{ padding: '6px 8px' }} title={new Date(h.at).toLocaleString()}>
                      {timeAgo(h.at)}
                    </td>
                    <td style={{ padding: '6px 8px' }}>{h.actor?.kind ?? 'unknown'}</td>
                    <td style={{ padding: '6px 8px', fontFamily: 'var(--font-mono)' }}>
                      {h.state.contentOverride == null ? '— default' : formatBytes(utf8Bytes(h.state.contentOverride))}
                    </td>
                    <td style={{ padding: '6px 8px', fontFamily: 'var(--font-mono)' }}>
                      {h.state.blurbOverride == null ? '—' : `"${h.state.blurbOverride.slice(0, 40)}${h.state.blurbOverride.length > 40 ? '…' : ''}"`}
                    </td>
                    <td style={{ padding: '6px 8px', textAlign: 'right' }}>
                      {h.rev !== doc.rev && (
                        <ConfirmButton
                          label="Rollback"
                          confirmLabel={`Roll back to rev ${h.rev}?`}
                          onConfirm={() => void rollback(h.rev)}
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
