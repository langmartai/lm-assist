'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { BookText, RefreshCw } from 'lucide-react';
import { useAppMode } from '@/contexts/AppModeContext';
import { errText, timeAgo } from '@/components/memory/format';
import {
  contentBadges,
  groupContentUnits,
  type ContentUnitRow,
} from '@/lib/assist-content';
import { ContentDetail } from './ContentDetail';

interface ContentListResponse {
  units?: ContentUnitRow[];
  orphanDocs?: Array<{ name: string; rev: number; updatedAt?: number; lastUpdatedBy?: { kind?: string } }>;
  groups?: string[];
  counts?: { units: number; overridden: number; orphans: number };
}

/**
 * /assist-content — viewer/editor for the assist-content registry: the bootstrap/guide
 * onboarding content the MCP connector serves, editable fleet-wide without a code
 * deploy (the mission-processes treatment). List = code units grouped bootstrap vs
 * guide (+ orphan docs); detail = rendered/raw/edit/history with a rev-conflict-guarded
 * save path and rollback.
 */
export function AssistContentPage() {
  const { apiClient, proxy } = useAppMode();
  const apiFetch = useCallback(
    async <T,>(path: string, opts?: { method?: string; body?: unknown }): Promise<T> =>
      apiClient.fetchPath<T>(path, { method: opts?.method, body: opts?.body, machineId: proxy.machineId || undefined }),
    [apiClient, proxy.machineId],
  );

  const [units, setUnits] = useState<ContentUnitRow[]>([]);
  const [orphans, setOrphans] = useState<ContentListResponse['orphanDocs']>([]);
  const [groupsOrder, setGroupsOrder] = useState<string[]>(['bootstrap', 'guide']);
  const [counts, setCounts] = useState<{ units: number; overridden: number; orphans: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await apiFetch<ContentListResponse>('/assist-content');
      setUnits(list.units ?? []);
      setOrphans(list.orphanDocs ?? []);
      if (list.groups?.length) setGroupsOrder(list.groups);
      setCounts(list.counts ?? null);
    } catch (e) {
      setError(errText(e));
    } finally {
      setLoading(false);
    }
  }, [apiFetch]);

  useEffect(() => {
    void fetchAll();
  }, [fetchAll]);

  const groups = useMemo(() => groupContentUnits(units, groupsOrder), [units, groupsOrder]);

  // bootstrap.header is the natural entry point: it leads the bootstrap output.
  useEffect(() => {
    if (!selectedId && units.length > 0) setSelectedId(units[0].id);
  }, [selectedId, units]);

  return (
    <div className="h-full flex flex-col overflow-hidden" style={{ background: 'var(--color-bg-root)' }}>
      {/* Header bar (app page-frame convention) */}
      <div
        className="flex flex-wrap items-center"
        style={{ padding: '16px 20px', borderBottom: '1px solid var(--color-border-default)', gap: 12 }}
      >
        <BookText size={20} style={{ color: 'var(--color-accent)' }} />
        <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--color-text-primary)' }}>Assist Content</div>
        <span style={{ fontSize: 12, color: 'var(--color-text-tertiary)' }}>
          The bootstrap/guide onboarding playbooks the MCP connector serves — override any unit fleet-wide, live, no
          deploy.
        </span>
        <div className="flex items-center gap-2" style={{ marginLeft: 'auto' }}>
          {counts && (
            <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>
              {counts.units} units · {counts.overridden} overridden{counts.orphans ? ` · ${counts.orphans} orphan` : ''}
            </span>
          )}
          <button
            className="btn btn-sm btn-ghost"
            onClick={() => void fetchAll()}
            disabled={loading}
            title="Refresh the registry list"
          >
            <RefreshCw size={12} className={loading ? 'animate-spin' : undefined} /> Refresh
          </button>
        </div>
      </div>

      {error && (
        <div
          style={{
            margin: '12px 20px 0',
            padding: '8px 12px',
            borderRadius: 'var(--radius-sm)',
            border: '1px solid rgba(248,113,113,0.4)',
            background: 'rgba(248,113,113,0.08)',
            color: 'var(--color-status-red)',
            fontSize: 12,
          }}
        >
          {error}
        </div>
      )}

      {/* Body: list | detail */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden', minHeight: 0 }}>
        <div
          style={{
            width: 320,
            flexShrink: 0,
            overflowY: 'auto',
            borderRight: '1px solid var(--color-border-default)',
            padding: '12px 0',
          }}
        >
          {loading && units.length === 0 ? (
            <div style={{ padding: '8px 16px', fontSize: 12, color: 'var(--color-text-tertiary)' }}>Loading…</div>
          ) : (
            <>
              {groups.map((g) => (
                <div key={g.group} style={{ marginBottom: 14 }}>
                  <div
                    style={{
                      padding: '2px 16px 6px',
                      fontSize: 11,
                      fontWeight: 600,
                      letterSpacing: 0.5,
                      textTransform: 'uppercase',
                      color: 'var(--color-text-tertiary)',
                    }}
                  >
                    {g.group} <span style={{ fontWeight: 400 }}>({g.rows.length})</span>
                  </div>
                  {g.rows.map((row) => {
                    const selected = row.id === selectedId;
                    const b = contentBadges(row);
                    return (
                      <button
                        key={row.id}
                        onClick={() => setSelectedId(row.id)}
                        style={{
                          display: 'block',
                          width: '100%',
                          textAlign: 'left',
                          padding: '6px 16px',
                          background: selected ? 'var(--color-bg-elevated)' : 'transparent',
                          borderLeft: selected ? '2px solid var(--color-accent)' : '2px solid transparent',
                          cursor: 'pointer',
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                          <span
                            style={{
                              fontFamily: 'var(--font-mono)',
                              fontSize: 12,
                              color: 'var(--color-text-primary)',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                            }}
                          >
                            {row.id}
                          </span>
                          {b.stored ? (
                            <span className="badge badge-outline" style={{ fontSize: 9 }}>rev {row.rev}</span>
                          ) : (
                            <span className="badge badge-default" style={{ fontSize: 9 }}>default</span>
                          )}
                          {b.override && <span className="badge badge-blue" style={{ fontSize: 9 }}>override</span>}
                          {b.blurbOverride && <span className="badge badge-blue" style={{ fontSize: 9 }}>blurb</span>}
                          {b.inBootstrap && (
                            <span className="badge badge-default" style={{ fontSize: 9 }} title="Rendered inside the bootstrap output">
                              §bootstrap
                            </span>
                          )}
                        </div>
                        <div
                          style={{
                            fontSize: 11,
                            color: 'var(--color-text-secondary)',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {row.title}
                        </div>
                        {row.rev != null && (
                          <div style={{ fontSize: 10, color: 'var(--color-text-tertiary)' }}>
                            {row.lastUpdatedBy?.kind ?? 'unknown'}
                            {row.updatedAt ? ` · ${timeAgo(row.updatedAt)}` : ''}
                          </div>
                        )}
                      </button>
                    );
                  })}
                </div>
              ))}
              {(orphans?.length ?? 0) > 0 && (
                <div style={{ marginBottom: 14 }}>
                  <div
                    style={{
                      padding: '2px 16px 6px',
                      fontSize: 11,
                      fontWeight: 600,
                      letterSpacing: 0.5,
                      textTransform: 'uppercase',
                      color: 'var(--color-text-tertiary)',
                    }}
                  >
                    orphans <span style={{ fontWeight: 400 }}>({orphans!.length})</span>
                  </div>
                  {orphans!.map((o) => (
                    <button
                      key={o.name}
                      onClick={() => setSelectedId(o.name)}
                      style={{
                        display: 'block',
                        width: '100%',
                        textAlign: 'left',
                        padding: '6px 16px',
                        background: o.name === selectedId ? 'var(--color-bg-elevated)' : 'transparent',
                        borderLeft: o.name === selectedId ? '2px solid var(--color-accent)' : '2px solid transparent',
                        cursor: 'pointer',
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--color-text-primary)' }}>
                          {o.name}
                        </span>
                        <span className="badge badge-outline" style={{ fontSize: 9 }}>rev {o.rev}</span>
                        <span className="badge badge-default" style={{ fontSize: 9 }} title="No code unit emits this id — it never renders">
                          orphan
                        </span>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
        </div>

        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          {selectedId ? (
            <ContentDetail id={selectedId} apiFetch={apiFetch} onDocChanged={() => void fetchAll()} onSelectUnit={setSelectedId} />
          ) : (
            <div
              style={{
                flex: 1,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: 'var(--color-text-tertiary)',
                fontSize: 13,
              }}
            >
              Select a content unit to view it.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
