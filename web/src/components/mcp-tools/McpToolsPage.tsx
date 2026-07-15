'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Wrench, RefreshCw, ShieldAlert } from 'lucide-react';
import { useAppMode } from '@/contexts/AppModeContext';
import { errText, timeAgo } from '@/components/memory/format';
import {
  groupTools,
  toolBadges,
  truncateDescription,
  type McpToolRow,
  type ToolRegistryDocView,
  type ToolScope,
} from '@/lib/mcp-tools';
import { ToolDetail } from './ToolDetail';

interface ToolListResponse {
  tools?: McpToolRow[];
  orphanDocs?: ToolRegistryDocView[];
  categories?: string[];
  counts?: { tools: number; overridden: number; disabled: number; orphans: number };
}

interface AccessConfigResponse {
  tools?: Array<{ tool: string; scope: ToolScope; adminGate: boolean }>;
}

interface PendingAction {
  id: string;
  tool: string;
  summary: string;
  createdAt: number;
  expiresAt: number;
}

export const SCOPE_BADGE_STYLE: Record<ToolScope, { color: string; border: string; background: string }> = {
  read: { color: 'rgba(52,211,153,0.95)', border: '1px solid rgba(52,211,153,0.4)', background: 'rgba(52,211,153,0.08)' },
  write: { color: 'rgba(251,191,36,0.95)', border: '1px solid rgba(251,191,36,0.4)', background: 'rgba(251,191,36,0.08)' },
  admin: { color: 'rgba(248,113,113,0.95)', border: '1px solid rgba(248,113,113,0.4)', background: 'rgba(248,113,113,0.08)' },
};

export function ScopeBadge({ scope }: { scope: ToolScope }) {
  return (
    <span
      style={{
        fontSize: 9,
        padding: '1px 5px',
        borderRadius: 'var(--radius-sm)',
        flexShrink: 0,
        ...SCOPE_BADGE_STYLE[scope],
      }}
    >
      {scope}
    </span>
  );
}

/**
 * /mcp-tools — first-class management page for the MCP tool registry: every tool
 * this Core advertises (both MCP surfaces share one list), grouped by category,
 * with editable description overrides + enable/disable applied live, plus the
 * admin-approval gates and pending confirmations absorbed from the old Settings
 * MCP tab (server behavior unchanged — same /mcp/access + /mcp/pending routes).
 */
export function McpToolsPage() {
  const { apiClient, proxy } = useAppMode();
  const apiFetch = useCallback(
    async <T,>(path: string, opts?: { method?: string; body?: unknown }): Promise<T> =>
      apiClient.fetchPath<T>(path, { method: opts?.method, body: opts?.body, machineId: proxy.machineId || undefined }),
    [apiClient, proxy.machineId],
  );

  const [tools, setTools] = useState<McpToolRow[]>([]);
  const [orphanDocs, setOrphanDocs] = useState<ToolRegistryDocView[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [gates, setGates] = useState<Map<string, boolean>>(new Map());
  const [pending, setPending] = useState<PendingAction[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await apiFetch<{ success?: boolean; data?: ToolListResponse } & ToolListResponse>('/mcp-tools');
      const data = (list as { data?: ToolListResponse }).data ?? list;
      setTools(data.tools ?? []);
      setOrphanDocs(data.orphanDocs ?? []);
      setCategories(data.categories ?? []);
      // Admin gates + pending confirmations are separate (older) endpoints — best-effort,
      // the registry page must not fail on them.
      try {
        const access = await apiFetch<{ success?: boolean; data?: AccessConfigResponse }>('/mcp/access');
        const rows = access.data?.tools ?? [];
        setGates(new Map(rows.map((r) => [r.tool, r.adminGate])));
      } catch {
        setGates(new Map());
      }
      try {
        const p = await apiFetch<{ success?: boolean; data?: { pending?: PendingAction[] } }>('/mcp/pending');
        setPending(p.data?.pending ?? []);
      } catch {
        setPending([]);
      }
    } catch (e) {
      setError(errText(e));
    } finally {
      setLoading(false);
    }
  }, [apiFetch]);

  useEffect(() => {
    void fetchAll();
    const t = setInterval(() => void fetchAll(), 10000); // pending confirmations expire in 10 min — keep them fresh
    return () => clearInterval(t);
  }, [fetchAll]);

  const groups = useMemo(() => groupTools(tools, categories), [tools, categories]);
  const counts = useMemo(
    () => ({
      tools: tools.length,
      overridden: tools.filter((t) => t.hasOverride).length,
      disabled: tools.filter((t) => !t.enabled).length,
    }),
    [tools],
  );

  const resolvePending = async (id: string, action: 'confirm' | 'deny') => {
    try {
      await apiFetch(`/mcp/pending/${encodeURIComponent(id)}/${action}`, { method: 'POST' });
    } catch {
      /* the refresh below surfaces current state either way */
    }
    void fetchAll();
  };

  const selectedGate = selected ? gates.get(selected) ?? false : false;

  return (
    <div className="h-full flex flex-col overflow-hidden" style={{ background: 'var(--color-bg-root)' }}>
      {/* Header bar (app page-frame convention) */}
      <div
        className="flex flex-wrap items-center"
        style={{ padding: '16px 20px', borderBottom: '1px solid var(--color-border-default)', gap: 12 }}
      >
        <Wrench size={20} style={{ color: 'var(--color-accent)' }} />
        <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--color-text-primary)' }}>MCP Tools</div>
        <span style={{ fontSize: 12, color: 'var(--color-text-tertiary)' }}>
          Every tool this Core exposes over MCP — descriptions and on/off are editable; names, schemas and handlers stay code-owned.
        </span>
        <div className="flex items-center gap-2" style={{ marginLeft: 'auto' }}>
          <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>
            {counts.tools} tools · {counts.overridden} overridden · {counts.disabled} disabled
          </span>
          <button
            className="btn btn-sm btn-ghost"
            onClick={() => void fetchAll()}
            disabled={loading}
            title="Refresh tools + registry"
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

      {/* Pending admin confirmations (absorbed from the Settings MCP tab — same endpoints) */}
      {pending.length > 0 && (
        <div
          style={{
            margin: '12px 20px 0',
            padding: '10px 12px',
            borderRadius: 'var(--radius-sm)',
            border: '1px solid rgba(251,191,36,0.45)',
            background: 'rgba(251,191,36,0.08)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 600, color: 'rgba(251,191,36,0.95)', marginBottom: 6 }}>
            <ShieldAlert size={13} /> {pending.length} pending admin confirmation{pending.length > 1 ? 's' : ''} — parked tool calls awaiting your decision
          </div>
          {pending.map((p) => (
            <div key={p.id} className="flex flex-wrap items-center" style={{ gap: 8, padding: '4px 0', fontSize: 12 }}>
              <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--color-text-primary)' }}>{p.tool}</span>
              <span style={{ color: 'var(--color-text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 480 }} title={p.summary}>
                {p.summary}
              </span>
              <span style={{ fontSize: 10, color: 'var(--color-text-tertiary)' }}>{timeAgo(p.createdAt)}</span>
              <span style={{ display: 'flex', gap: 4, marginLeft: 'auto' }}>
                <button className="btn btn-sm btn-primary" style={{ fontSize: 11 }} onClick={() => void resolvePending(p.id, 'confirm')}>
                  Confirm
                </button>
                <button className="btn btn-sm btn-ghost" style={{ fontSize: 11 }} onClick={() => void resolvePending(p.id, 'deny')}>
                  Deny
                </button>
              </span>
            </div>
          ))}
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
          {loading && tools.length === 0 ? (
            <div style={{ padding: '8px 16px', fontSize: 12, color: 'var(--color-text-tertiary)' }}>Loading…</div>
          ) : (
            <>
              {groups.map((g) => (
                <div key={g.category} style={{ marginBottom: 14 }}>
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
                    {g.category} <span style={{ fontWeight: 400 }}>({g.tools.length})</span>
                  </div>
                  {g.tools.map((row) => {
                    const isSel = row.name === selected;
                    const badges = toolBadges(row);
                    return (
                      <button
                        key={row.name}
                        onClick={() => setSelected(row.name)}
                        style={{
                          display: 'block',
                          width: '100%',
                          textAlign: 'left',
                          padding: '6px 16px',
                          background: isSel ? 'var(--color-bg-elevated)' : 'transparent',
                          borderLeft: isSel ? '2px solid var(--color-accent)' : '2px solid transparent',
                          cursor: 'pointer',
                          opacity: badges.off ? 0.55 : 1,
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
                            {row.name}
                          </span>
                          <ScopeBadge scope={badges.scope} />
                          {badges.off && (
                            <span className="badge" style={{ fontSize: 9, ...SCOPE_BADGE_STYLE.admin }}>off</span>
                          )}
                          {badges.override && (
                            <span className="badge" style={{ fontSize: 9, ...SCOPE_BADGE_STYLE.write }}>override</span>
                          )}
                          {row.rev !== undefined && !badges.override && !badges.off && (
                            <span className="badge badge-outline" style={{ fontSize: 9 }}>rev {row.rev}</span>
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
                          title={row.effectiveDescription}
                        >
                          {truncateDescription(row.effectiveDescription, 120)}
                        </div>
                      </button>
                    );
                  })}
                </div>
              ))}
              {orphanDocs.length > 0 && (
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
                    title="Registry docs whose tool name is not advertised by this build (other-build tools or e2e scratch docs)"
                  >
                    unregistered docs <span style={{ fontWeight: 400 }}>({orphanDocs.length})</span>
                  </div>
                  {orphanDocs.map((d) => (
                    <button
                      key={d.name}
                      onClick={() => setSelected(d.name)}
                      style={{
                        display: 'block',
                        width: '100%',
                        textAlign: 'left',
                        padding: '6px 16px',
                        background: d.name === selected ? 'var(--color-bg-elevated)' : 'transparent',
                        borderLeft: d.name === selected ? '2px solid var(--color-accent)' : '2px solid transparent',
                        cursor: 'pointer',
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--color-text-primary)' }}>{d.name}</span>
                        <span className="badge badge-default" style={{ fontSize: 9 }}>not advertised</span>
                        <span className="badge badge-outline" style={{ fontSize: 9 }}>rev {d.rev}</span>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
        </div>

        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          {selected ? (
            <ToolDetail
              name={selected}
              apiFetch={apiFetch}
              adminGate={selectedGate}
              onChanged={() => void fetchAll()}
            />
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
              Select a tool to view and manage it.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
