'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Lock, ShieldCheck } from 'lucide-react';
import { ConfirmButton, errText, timeAgo } from '@/components/memory/format';
import { checkRevConflict, type ToolDetailResponse, type ToolHistoryEntry } from '@/lib/mcp-tools';
import { ScopeBadge } from './McpToolsPage';

type Tab = 'description' | 'implementation' | 'settings' | 'history';

interface ToolDetailProps {
  name: string;
  apiFetch: <T>(path: string, opts?: { method?: string; body?: unknown }) => Promise<T>;
  /** Current admin-approval gate state for this tool (from /mcp/access). */
  adminGate: boolean;
  /** Any successful write happened — parent refreshes list + gates + pending. */
  onChanged: () => void;
}

const PANEL: React.CSSProperties = {
  padding: '10px 12px',
  borderRadius: 'var(--radius-sm)',
  border: '1px solid var(--color-border-default)',
  background: 'var(--color-bg-elevated)',
};

const MONO_PRE: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 11,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  color: 'var(--color-text-secondary)',
  margin: 0,
};

/** Right-pane detail for one MCP tool: Description (editable override, default
 *  always shown + restorable) / Implementation (read-only code view) / Settings
 *  (enable + admin gate) / History (rev list + rollback). Mirrors ProcessDetail. */
export function ToolDetail({ name, apiFetch, adminGate, onChanged }: ToolDetailProps) {
  const [data, setData] = useState<ToolDetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('description');
  const [draft, setDraft] = useState('');
  const [base, setBase] = useState('');
  const [loadedRev, setLoadedRev] = useState(0);
  const [saving, setSaving] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);
  const seqRef = useRef(0);

  const load = useCallback(async () => {
    const seq = ++seqRef.current;
    setLoading(true);
    setError(null);
    try {
      const d = await apiFetch<ToolDetailResponse>(`/mcp-tools/${encodeURIComponent(name)}`);
      if (seq !== seqRef.current) return; // stale response for a previous tool
      setData(d);
      const over = d.doc?.descriptionOverride ?? '';
      setDraft(over);
      setBase(over);
      setLoadedRev(d.doc?.rev ?? 0);
    } catch (e) {
      if (seq !== seqRef.current) return;
      setError(errText(e));
    } finally {
      if (seq === seqRef.current) setLoading(false);
    }
  }, [apiFetch, name]);

  useEffect(() => {
    setTab('description');
    setActionError(null);
    setConflict(null);
    void load();
  }, [name, load]);

  const doc = data?.doc ?? null;
  const dirty = draft !== base;

  /** All registry writes flow through here: rev-conflict pre-check, POST, reload. */
  const post = async (body: Record<string, unknown>, opts?: { skipConflictCheck?: boolean }) => {
    if (saving) return;
    setSaving(true);
    setActionError(null);
    setConflict(null);
    try {
      if (!opts?.skipConflictCheck) {
        const fresh = await apiFetch<ToolDetailResponse>(`/mcp-tools/${encodeURIComponent(name)}`);
        const chk = checkRevConflict(loadedRev, fresh.doc ?? null);
        if (chk) {
          setConflict(chk);
          return;
        }
      }
      await apiFetch(`/mcp-tools/${encodeURIComponent(name)}`, { method: 'POST', body });
      await load();
      onChanged();
    } catch (e) {
      setActionError(errText(e));
    } finally {
      setSaving(false);
    }
  };

  const rollback = async (toRev: number) => {
    setActionError(null);
    try {
      await apiFetch(`/mcp-tools/${encodeURIComponent(name)}/rollback`, { method: 'POST', body: { toRev } });
      await load();
      onChanged();
    } catch (e) {
      setActionError(errText(e));
    }
  };

  const toggleGate = async () => {
    setActionError(null);
    try {
      await apiFetch(`/mcp/access/tool-gate`, { method: 'PUT', body: { tool: name, enabled: !adminGate } });
      onChanged();
    } catch (e) {
      setActionError(errText(e));
    }
  };

  if (loading && !data) {
    return <div style={{ padding: 20, fontSize: 12, color: 'var(--color-text-tertiary)' }}>Loading {name}…</div>;
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

  const history: ToolHistoryEntry[] = [...(doc?.history ?? [])].reverse();
  const isKnown = data.knownTool;
  const enabled = doc?.enabled ?? true;
  const isProtected = data.protected === true;
  const defaultDescription = data.defaultDescription ?? '';
  const effectiveDescription = doc?.descriptionOverride ?? defaultDescription;

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
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 13, color: 'var(--color-text-primary)' }}>{name}</span>
        {isKnown && data.scope && <ScopeBadge scope={data.scope} />}
        {isKnown && <span className="badge badge-outline">{data.category}</span>}
        {!isKnown && <span className="badge badge-default">not advertised by this build</span>}
        {isProtected && (
          <span className="badge badge-blue" title="Protected: cannot be disabled (orientation surface). Description overrides are still allowed.">
            <ShieldCheck size={10} style={{ marginRight: 3, verticalAlign: -1 }} />protected
          </span>
        )}
        {!enabled && <span className="badge" style={{ background: 'rgba(248,113,113,0.15)', color: 'rgba(248,113,113,0.95)' }}>disabled</span>}
        {doc ? (
          <span className="badge badge-outline">rev {doc.rev}</span>
        ) : (
          <span className="badge badge-default">default — no registry doc</span>
        )}
        {doc?.lastUpdatedBy && (
          <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>
            last edit: {doc.lastUpdatedBy.kind ?? 'unknown'}
            {doc.updatedAt ? ` · ${timeAgo(doc.updatedAt)}` : ''}
          </span>
        )}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
          {(['description', 'implementation', 'settings', 'history'] as const).map((t) => (
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

      {(actionError || conflict) && (
        <div
          style={{
            margin: '10px 20px 0',
            padding: '8px 12px',
            borderRadius: 'var(--radius-sm)',
            border: `1px solid ${conflict ? 'rgba(251,191,36,0.45)' : 'rgba(248,113,113,0.4)'}`,
            background: conflict ? 'rgba(251,191,36,0.08)' : 'rgba(248,113,113,0.08)',
            color: conflict ? 'rgba(251,191,36,0.95)' : 'var(--color-status-red)',
            fontSize: 12,
            flexShrink: 0,
          }}
        >
          {conflict ?? actionError}
          {conflict && (
            <button className="btn btn-sm btn-ghost" style={{ marginLeft: 8, fontSize: 11 }} onClick={() => void load()}>
              Reload latest
            </button>
          )}
        </div>
      )}

      {/* ── Description ─────────────────────────────────────────── */}
      {tab === 'description' && (
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 20, display: 'flex', flexDirection: 'column', gap: 14 }}>
          {isKnown ? (
            <>
              <div>
                <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-text-tertiary)', marginBottom: 6 }}>
                  EFFECTIVE DESCRIPTION — what tools/list serves right now{doc?.descriptionOverride != null ? ' (override active)' : ' (code default)'}
                </div>
                <div style={{ ...PANEL }}>
                  <pre style={MONO_PRE}>{effectiveDescription}</pre>
                </div>
              </div>

              <div>
                <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-text-tertiary)', marginBottom: 6 }}>
                  OVERRIDE — stored in the fleet registry; leave empty and Restore default to clear
                </div>
                <textarea
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  placeholder="No override — the code default above is served. Type here to override the description."
                  spellCheck={false}
                  style={{
                    width: '100%',
                    minHeight: 120,
                    resize: 'vertical',
                    padding: '8px 10px',
                    borderRadius: 'var(--radius-sm)',
                    border: '1px solid var(--color-border-default)',
                    background: 'var(--color-bg-root)',
                    color: 'var(--color-text-primary)',
                    fontFamily: 'var(--font-mono)',
                    fontSize: 12,
                  }}
                />
                <div style={{ display: 'flex', gap: 6, marginTop: 8, alignItems: 'center' }}>
                  <button
                    className="btn btn-sm btn-primary"
                    disabled={!dirty || saving || draft.trim().length === 0}
                    onClick={() => void post({ descriptionOverride: draft })}
                    title={draft.trim().length === 0 ? 'Use Restore default to clear the override' : undefined}
                  >
                    Save override (rev {loadedRev} → {loadedRev + 1})
                  </button>
                  <button className="btn btn-sm btn-ghost" disabled={!dirty || saving} onClick={() => setDraft(base)}>
                    Revert
                  </button>
                  {doc?.descriptionOverride != null && (
                    <ConfirmButton
                      label="Restore default"
                      confirmLabel="Really restore code default?"
                      onConfirm={() => void post({ descriptionOverride: null })}
                      className="btn btn-sm btn-ghost"
                    />
                  )}
                </div>
              </div>

              <div>
                <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-text-tertiary)', marginBottom: 6 }}>
                  <Lock size={10} style={{ marginRight: 4, verticalAlign: -1 }} />
                  DEFAULT FROM CODE — always available, never editable here
                </div>
                <div style={{ ...PANEL, border: '1px dashed var(--color-border-strong)' }}>
                  <pre style={MONO_PRE}>{defaultDescription}</pre>
                </div>
              </div>
            </>
          ) : (
            <div style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>
              This registry doc has no matching tool in this build (created by another build or as an e2e scratch doc).
              Its override text: <pre style={{ ...MONO_PRE, marginTop: 8 }}>{doc?.descriptionOverride ?? '(none)'}</pre>
            </div>
          )}
        </div>
      )}

      {/* ── Implementation (read-only) ─────────────────────────── */}
      {tab === 'implementation' && (
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 20, display: 'flex', flexDirection: 'column', gap: 14 }}>
          {isKnown ? (
            <>
              <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>
                <Lock size={10} style={{ marginRight: 4, verticalAlign: -1 }} />
                Read-only view of the actual implementation. Names, schemas, scopes and handlers are code-owned — the registry cannot change them.
              </div>
              <div>
                <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-text-tertiary)', marginBottom: 6 }}>DEFINING MODULE</div>
                <div style={{ ...PANEL }}>
                  <pre style={MONO_PRE}>{data.implementation?.module ?? data.module ?? '(unknown)'}</pre>
                </div>
              </div>
              <div>
                <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-text-tertiary)', marginBottom: 6 }}>
                  TOOL DEFINITION (as advertised — includes inputSchema)
                </div>
                <div style={{ ...PANEL, maxHeight: 320, overflowY: 'auto' }}>
                  <pre style={MONO_PRE}>{JSON.stringify(data.def, null, 2)}</pre>
                </div>
              </div>
              <div>
                <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-text-tertiary)', marginBottom: 6 }}>
                  REGISTERED HANDLER SOURCE (String(handler) of the in-process handler)
                </div>
                <div style={{ ...PANEL, maxHeight: 400, overflowY: 'auto' }}>
                  <pre style={MONO_PRE}>{data.implementation?.handlerSource ?? '(no in-process handler registered)'}</pre>
                </div>
              </div>
            </>
          ) : (
            <div style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>
              No implementation on this build — the name is not an advertised tool here.
            </div>
          )}
        </div>
      )}

      {/* ── Settings ───────────────────────────────────────────── */}
      {tab === 'settings' && (
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 20, display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ ...PANEL }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-text-primary)', marginBottom: 4 }}>Enabled</div>
            <div style={{ fontSize: 11, color: 'var(--color-text-secondary)', marginBottom: 8 }}>
              A disabled tool is omitted from tools/list on both MCP surfaces and every call is rejected with a clear
              TOOL_DISABLED error — live, no Core restart. Re-enabling is instant.
            </div>
            {isProtected ? (
              <div style={{ fontSize: 12, color: 'var(--color-text-tertiary)', display: 'flex', alignItems: 'center', gap: 6 }}>
                <ShieldCheck size={13} style={{ color: 'var(--color-accent)' }} />
                Protected tool — cannot be disabled ({'bootstrap, guide, session_status'} keep agents able to orient and self-help).
              </div>
            ) : enabled ? (
              <ConfirmButton
                label="Disable tool"
                confirmLabel={`Really disable ${name}?`}
                onConfirm={() => void post({ enabled: false }, { skipConflictCheck: true })}
                className="btn btn-sm btn-ghost"
              />
            ) : (
              <button className="btn btn-sm btn-primary" disabled={saving} onClick={() => void post({ enabled: true }, { skipConflictCheck: true })}>
                Enable tool
              </button>
            )}
          </div>

          {isKnown && (
            <div style={{ ...PANEL }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-text-primary)', marginBottom: 4 }}>Admin approval gate</div>
              <div style={{ fontSize: 11, color: 'var(--color-text-secondary)', marginBottom: 8 }}>
                When gated, remote MCP calls to this tool park as pending confirmations (banner on this page) instead of
                executing — same guard the Settings MCP tab used to manage, unchanged server-side.
              </div>
              <button className={`btn btn-sm ${adminGate ? 'btn-primary' : 'btn-ghost'}`} disabled={saving} onClick={() => void toggleGate()}>
                {adminGate ? 'Gated — click to remove gate' : 'Not gated — click to require approval'}
              </button>
            </div>
          )}

          {isKnown && (
            <div style={{ ...PANEL, fontSize: 11, color: 'var(--color-text-secondary)' }}>
              <div>scope: <b>{data.scope}</b> · category: <b>{data.category}</b></div>
              <div style={{ marginTop: 4, fontFamily: 'var(--font-mono)' }}>{data.module}</div>
            </div>
          )}
        </div>
      )}

      {/* ── History ────────────────────────────────────────────── */}
      {tab === 'history' && (
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 20 }}>
          {history.length === 0 ? (
            <div style={{ fontSize: 12, color: 'var(--color-text-tertiary)' }}>
              No registry history — this tool runs on pure code defaults.
            </div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ textAlign: 'left', color: 'var(--color-text-tertiary)', fontSize: 11 }}>
                  <th style={{ padding: '4px 8px' }}>rev</th>
                  <th style={{ padding: '4px 8px' }}>when</th>
                  <th style={{ padding: '4px 8px' }}>actor</th>
                  <th style={{ padding: '4px 8px' }}>state after</th>
                  <th style={{ padding: '4px 8px' }}>changes</th>
                  <th style={{ padding: '4px 8px' }} />
                </tr>
              </thead>
              <tbody>
                {history.map((h) => (
                  <tr key={h.rev} style={{ borderTop: '1px solid var(--color-border-default)' }}>
                    <td style={{ padding: '6px 8px', fontFamily: 'var(--font-mono)' }}>
                      {h.rev}
                      {doc && h.rev === doc.rev && <span className="badge badge-green" style={{ fontSize: 9, marginLeft: 6 }}>current</span>}
                    </td>
                    <td style={{ padding: '6px 8px', color: 'var(--color-text-secondary)' }} title={new Date(h.at).toLocaleString()}>
                      {timeAgo(h.at)}
                    </td>
                    <td style={{ padding: '6px 8px', color: 'var(--color-text-secondary)' }}>
                      {h.actor?.kind ?? 'unknown'}{h.actor?.channel ? ` · ${h.actor.channel}` : ''}
                    </td>
                    <td style={{ padding: '6px 8px' }}>
                      {h.state.enabled ? (
                        <span className="badge badge-outline" style={{ fontSize: 9 }}>on</span>
                      ) : (
                        <span className="badge" style={{ fontSize: 9, background: 'rgba(248,113,113,0.15)', color: 'rgba(248,113,113,0.95)' }}>off</span>
                      )}
                      {h.state.descriptionOverride != null && (
                        <span className="badge" style={{ fontSize: 9, marginLeft: 4, background: 'rgba(251,191,36,0.12)', color: 'rgba(251,191,36,0.95)' }}>
                          override len {h.state.descriptionOverride.length}
                        </span>
                      )}
                    </td>
                    <td style={{ padding: '6px 8px', color: 'var(--color-text-tertiary)', fontFamily: 'var(--font-mono)', fontSize: 10 }}>
                      {Object.keys(h.changes ?? {}).join(', ') || '—'}
                    </td>
                    <td style={{ padding: '6px 8px', textAlign: 'right' }}>
                      {doc && h.rev !== doc.rev && (
                        <ConfirmButton
                          label="Rollback"
                          confirmLabel={`Restore rev ${h.rev}?`}
                          onConfirm={() => void rollback(h.rev)}
                          className="btn btn-sm btn-ghost"
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
