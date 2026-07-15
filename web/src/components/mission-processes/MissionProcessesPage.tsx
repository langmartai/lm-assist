'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Workflow, RefreshCw } from 'lucide-react';
import { useAppMode } from '@/contexts/AppModeContext';
import { errText, timeAgo } from '@/components/memory/format';
import {
  groupWorkflows,
  parseCaseIndex,
  type WorkflowDocSummary,
} from '@/lib/mission-process';
import { ProcessDetail } from './ProcessDetail';

interface WorkflowListResponse {
  workflows?: WorkflowDocSummary[];
  defaults?: string[];
}

interface WorkflowGetResponse {
  doc?: (WorkflowDocSummary & { body?: string }) | null;
  defaultBody?: string | null;
  rendered?: string;
}

/**
 * /mission-processes — viewer/editor for the mission-workflows registry
 * (controller/onboard/drive playbooks + the case.* learned-case library).
 * List = stored docs AND un-seeded defaults, grouped by namespace; detail =
 * rendered/raw/edit/history with a rev-conflict-guarded save path.
 */
export function MissionProcessesPage() {
  const { apiClient, proxy } = useAppMode();
  const apiFetch = useCallback(
    async <T,>(path: string, opts?: { method?: string; body?: unknown }): Promise<T> =>
      apiClient.fetchPath<T>(path, { method: opts?.method, body: opts?.body, machineId: proxy.machineId || undefined }),
    [apiClient, proxy.machineId],
  );

  const [workflows, setWorkflows] = useState<WorkflowDocSummary[]>([]);
  const [defaults, setDefaults] = useState<string[]>([]);
  const [caseCues, setCaseCues] = useState<Map<string, string>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await apiFetch<WorkflowListResponse>('/mission/workflows');
      setWorkflows(list.workflows ?? []);
      setDefaults(list.defaults ?? []);
      // case.index cues are decorative — fetch best-effort, never fail the page on them.
      try {
        const idx = await apiFetch<WorkflowGetResponse>('/mission/workflows/case.index');
        setCaseCues(parseCaseIndex(idx.doc?.body ?? idx.defaultBody));
      } catch {
        setCaseCues(new Map());
      }
    } catch (e) {
      setError(errText(e));
    } finally {
      setLoading(false);
    }
  }, [apiFetch]);

  useEffect(() => {
    void fetchAll();
  }, [fetchAll]);

  const groups = useMemo(() => groupWorkflows(workflows, defaults), [workflows, defaults]);
  const storedCount = workflows.length;
  const defaultCount = defaults.length;

  return (
    <div className="h-full flex flex-col overflow-hidden" style={{ background: 'var(--color-bg-root)' }}>
      {/* Header bar (app page-frame convention) */}
      <div
        className="flex flex-wrap items-center"
        style={{ padding: '16px 20px', borderBottom: '1px solid var(--color-border-default)', gap: 12 }}
      >
        <Workflow size={20} style={{ color: 'var(--color-accent)' }} />
        <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--color-text-primary)' }}>Processes</div>
        <span style={{ fontSize: 12, color: 'var(--color-text-tertiary)' }}>
          Mission Control playbooks + learned-case library — watch and evolve what governs the controller.
        </span>
        <div className="flex items-center gap-2" style={{ marginLeft: 'auto' }}>
          <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>
            {storedCount} stored · {defaultCount} default
          </span>
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
          {loading && workflows.length === 0 ? (
            <div style={{ padding: '8px 16px', fontSize: 12, color: 'var(--color-text-tertiary)' }}>Loading…</div>
          ) : (
            groups.map((g) => (
              <div key={g.ns} style={{ marginBottom: 14 }}>
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
                  {g.ns} <span style={{ fontWeight: 400 }}>({g.rows.length})</span>
                </div>
                {g.rows.map((row) => {
                  const selected = row.id === selectedId;
                  const cue = g.ns === 'case' ? caseCues.get(row.id) : undefined;
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
                        {row.kind === 'default' ? (
                          <span className="badge badge-default" style={{ fontSize: 9 }}>default</span>
                        ) : (
                          <span className="badge badge-outline" style={{ fontSize: 9 }}>rev {row.doc?.rev}</span>
                        )}
                        {row.doc?.editPolicy === 'human-only' && (
                          <span className="badge badge-blue" style={{ fontSize: 9 }}>human-only</span>
                        )}
                      </div>
                      {row.doc && (
                        <div
                          style={{
                            fontSize: 11,
                            color: 'var(--color-text-secondary)',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {row.doc.title}
                        </div>
                      )}
                      {row.doc && (
                        <div style={{ fontSize: 10, color: 'var(--color-text-tertiary)' }}>
                          {row.doc.lastUpdatedBy?.kind ?? 'unknown'}
                          {row.doc.updatedAt ? ` · ${timeAgo(row.doc.updatedAt)}` : ''}
                        </div>
                      )}
                      {cue && (
                        <div
                          style={{
                            fontSize: 10,
                            fontStyle: 'italic',
                            color: 'var(--color-text-tertiary)',
                            display: '-webkit-box',
                            WebkitLineClamp: 2,
                            WebkitBoxOrient: 'vertical',
                            overflow: 'hidden',
                          }}
                          title={cue}
                        >
                          {cue}
                        </div>
                      )}
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>

        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          {selectedId ? (
            <ProcessDetail id={selectedId} apiFetch={apiFetch} onDocChanged={() => void fetchAll()} />
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
              Select a process doc to view it.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
