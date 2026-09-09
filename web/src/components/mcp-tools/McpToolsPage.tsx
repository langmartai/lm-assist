'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Wrench, RefreshCw, ShieldAlert, Puzzle, PlugZap, Activity, Layers } from 'lucide-react';
import { useAppMode } from '@/contexts/AppModeContext';
import { ConfirmButton, errText, timeAgo } from '@/components/memory/format';
import {
  groupTools,
  summarizeCounts,
  toolBadges,
  truncateDescription,
  activeProfileRow,
  profileDeltaLabel,
  profileUnavailableMessage,
  sortProfiles,
  unmatchedSelectorNote,
  type McpProfileStatus,
  type McpToolRow,
  type ToolRegistryDocView,
  type ToolScope,
} from '@/lib/mcp-tools';
import { ToolDetail } from './ToolDetail';
import { PluginsPanel } from './PluginsPanel';
import type { PluginListResponse } from '@/lib/mcp-plugins';

interface HubStatus {
  configured?: boolean; connected?: boolean; authenticated?: boolean; hubUrl?: string; error?: string;
}
interface McpStatus {
  core: { status?: string; error?: string } | null;
  plugins: (PluginListResponse & { error?: string }) | { error?: string } | null;
  hub: HubStatus | null;
  connector: { name?: string; connected?: boolean; toolCount?: number; error?: string } | null;
}

function StatusRow({ label, ok, detail }: { label: string; ok: boolean | null; detail: string }) {
  const color = ok === null ? 'var(--color-text-tertiary)' : ok ? 'rgba(74,222,128,0.95)' : 'rgba(248,113,113,0.95)';
  return (
    <div className="flex items-center gap-2" style={{ fontSize: 12 }}>
      <span style={{ width: 8, height: 8, borderRadius: '50%', background: color, flexShrink: 0 }} />
      <span style={{ color: 'var(--color-text-secondary)', width: 92 }}>{label}</span>
      <span style={{ color: 'var(--color-text-tertiary)' }}>{detail}</span>
    </div>
  );
}

function McpStatusPanel({ status, loading, onRefresh }: { status: McpStatus | null; loading: boolean; onRefresh: () => void }) {
  const p = status?.plugins as (PluginListResponse & { error?: string }) | { error?: string } | null;
  const counts = p && 'counts' in p ? p.counts : null;
  const hub = status?.hub;
  const conn = status?.connector;
  return (
    <div style={{ padding: '12px 20px', borderBottom: '1px solid var(--color-border-default)', background: 'var(--color-canvas-subtle)', display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div className="flex items-center gap-2" style={{ marginBottom: 2 }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-text-primary)' }}>MCP status</span>
        <button className="btn btn-xs btn-ghost" style={{ marginLeft: 'auto' }} onClick={onRefresh} disabled={loading}>
          <RefreshCw size={11} className={loading ? 'animate-spin' : undefined} /> Refresh
        </button>
      </div>
      <StatusRow label="Core /health" ok={status?.core ? !status.core.error && status.core.status === 'healthy' : null}
        detail={status?.core?.error ? status.core.error : (status?.core?.status || '…')} />
      <StatusRow label="Plugins" ok={p ? !('error' in p && p.error) : null}
        detail={p && 'error' in p && p.error ? p.error : counts ? `${counts.enabled} enabled / ${counts.total} total${counts.unhealthy ? `, ${counts.unhealthy} unhealthy` : ''}` : '…'} />
      <StatusRow label="Connector" ok={conn ? !conn.error && !!conn.connected : null}
        detail={conn?.error ? conn.error : conn ? `${conn.name || 'langmart'} · ${conn.connected ? 'connected' : 'disconnected'}${conn.toolCount != null ? ` · ${conn.toolCount} tools` : ''}` : '…'} />
      <StatusRow label="Hub" ok={hub ? !hub.error && !!hub.authenticated : null}
        detail={hub?.error ? hub.error : hub ? `${hub.authenticated ? 'authenticated' : hub.connected ? 'connected (not authed)' : hub.configured ? 'configured, offline' : 'not configured'}${hub.hubUrl ? ` · ${hub.hubUrl.replace(/^wss?:\/\//, '')}` : ''}` : '…'} />
    </div>
  );
}

/**
 * The tool-loading profile: how many tools this node ADVERTISES in `tools/list`.
 *
 * Worth a panel of its own because the cost is invisible and paid unconditionally —
 * `tools/list` is charged to every conversation before it calls anything (admin ≈ 320
 * tools ≈ 80K tokens here, basic ≈ 42 ≈ 12K). The four caveats at the bottom are not
 * decoration: each one is a way an operator can read this control as something it is
 * not (a permission, a per-user setting, an override, an instant change).
 */
function ProfilePanel({
  status,
  loading,
  error,
  busy,
  onRefresh,
  onSelect,
}: {
  status: McpProfileStatus | null;
  loading: boolean;
  error: string | null;
  /** Name of the profile currently being switched to, if any. */
  busy: string | null;
  onRefresh: () => void;
  onSelect: (name: string) => void;
}) {
  const active = activeProfileRow(status);
  const rows = status ? sortProfiles(status.profiles) : [];
  return (
    <div style={{ padding: '12px 20px', borderBottom: '1px solid var(--color-border-default)', background: 'var(--color-canvas-subtle)', display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div className="flex flex-wrap items-center gap-2">
        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-text-primary)' }}>Tool loading profile</span>
        <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>
          How many tools this node advertises in <code style={{ fontFamily: 'var(--font-mono)' }}>tools/list</code> — the fixed cost every conversation pays before it calls anything.
        </span>
        <button className="btn btn-xs btn-ghost" style={{ marginLeft: 'auto' }} onClick={onRefresh} disabled={loading}>
          <RefreshCw size={11} className={loading ? 'animate-spin' : undefined} /> Refresh
        </button>
      </div>

      {error && (
        <div style={{ fontSize: 11, color: 'rgba(248,113,113,0.95)' }}>{error}</div>
      )}

      {!status && !error ? (
        <div style={{ fontSize: 12, color: 'var(--color-text-tertiary)' }}>Loading…</div>
      ) : (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {rows.map((p) => {
            const isActive = p.name === status?.active;
            const delta = profileDeltaLabel(active, p);
            const unmatched = unmatchedSelectorNote(p);
            return (
              <div
                key={p.name}
                style={{
                  flex: '1 1 260px',
                  minWidth: 240,
                  padding: '8px 10px',
                  borderRadius: 'var(--radius-sm)',
                  border: isActive ? '1px solid var(--color-accent)' : '1px solid var(--color-border-default)',
                  background: isActive ? 'var(--color-bg-elevated)' : 'transparent',
                }}
              >
                <div className="flex items-center gap-2">
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--color-text-primary)' }}>{p.name}</span>
                  <span className="badge badge-outline" style={{ fontSize: 9 }}>{p.tools} tools</span>
                  {isActive ? (
                    <span className="badge" style={{ fontSize: 9, ...SCOPE_BADGE_STYLE.read }}>active</span>
                  ) : busy ? (
                    <span style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--color-text-tertiary)' }}>
                      {busy === p.name ? 'Switching…' : ''}
                    </span>
                  ) : (
                    // The page's own two-click confirm (same one Disable and Restore default
                    // use). This switch is node-global, so a stray click would narrow the tool
                    // surface of every other session on this host.
                    <span style={{ marginLeft: 'auto' }}>
                      <ConfirmButton
                        label="Use"
                        confirmLabel={`Switch this node to ${p.name}?`}
                        onConfirm={() => onSelect(p.name)}
                        className="btn btn-xs btn-ghost"
                      />
                    </span>
                  )}
                </div>
                <div style={{ fontSize: 11, color: 'var(--color-text-secondary)', marginTop: 4 }}>{p.description}</div>
                {delta && (
                  <div style={{ fontSize: 10, color: 'var(--color-text-tertiary)', marginTop: 3 }}>{delta}</div>
                )}
                {unmatched && (
                  <div style={{ fontSize: 10, color: 'rgba(251,191,36,0.95)', marginTop: 3 }}>{unmatched}</div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {status && (
        <div style={{ fontSize: 10, color: 'var(--color-text-tertiary)' }}>
          {status.setAt
            ? `Active profile "${status.active}" set ${timeAgo(status.setAt)}${status.setBy ? ` by ${status.setBy}` : ''}.`
            : `Active profile "${status.active}" — never changed on this node (admin is the default: nothing is hidden until someone chooses).`}
        </div>
      )}

      <div style={{ fontSize: 10, color: 'var(--color-text-tertiary)', lineHeight: 1.5 }}>
        <div>
          <b>Advertise-only.</b> A narrower profile changes what is <i>listed</i>, not what may run — hidden tools stay callable.
          It secures nothing: the admin gates on this page and the per-tool scopes are the security boundary.
        </div>
        <div>
          <b>Node-global.</b> One setting for the whole node, not a per-user preference — every other session on this host sees the surface you pick here.
        </div>
        <div>
          <b>The per-tool registry wins.</b> A tool switched off on this page stays off in every profile; a profile can only narrow further, never re-enable.
        </div>
        <div>
          <b>Not instant.</b> A local Claude Code session picks the change up within ~30s; a claude.ai connector caches <code style={{ fontFamily: 'var(--font-mono)' }}>tools/list</code> and needs a <code style={{ fontFamily: 'var(--font-mono)' }}>refresh_connector_tools</code> (or the Sync button) to see it.
        </div>
      </div>
    </div>
  );
}

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

/** fetchJson already unwraps the {success,data,meta} envelope; tolerate a still-wrapped
 *  body from other transports. Same one-liner fetchAll/loadStatus inline, named once for
 *  the profile calls below. */
function unwrapBody<T>(body: T | { data?: T }): T {
  return ((body as { data?: T })?.data ?? body) as T;
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
  const [gatesUnavailable, setGatesUnavailable] = useState(false);
  const [pending, setPending] = useState<PendingAction[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  // Third-party plugins are a separate review surface on the same page: their tools
  // are advertised here, but approving one authorises code execution.
  const [showPlugins, setShowPlugins] = useState(false);
  // Connector sync + MCP/hub status (the two operator actions).
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);
  const [showStatus, setShowStatus] = useState(false);
  const [status, setStatus] = useState<McpStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(false);
  // Tool loading profile: how many tools this node advertises in tools/list.
  const [showProfile, setShowProfile] = useState(false);
  const [profile, setProfile] = useState<McpProfileStatus | null>(null);
  const [profileLoading, setProfileLoading] = useState(false);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [profileBusy, setProfileBusy] = useState<string | null>(null);
  const seqRef = useRef(0);

  const fetchAll = useCallback(async () => {
    const seq = ++seqRef.current;
    setLoading(true);
    setError(null);
    // apiFetch (fetchJson) already unwraps the {success,data,meta} envelope; tolerate
    // a still-wrapped body from other transports with a `.data ?? body` fallback.
    const unwrap = <T,>(body: T | { data?: T }): T => ((body as { data?: T })?.data ?? body) as T;
    try {
      const [listR, accessR, pendingR] = await Promise.allSettled([
        apiFetch<ToolListResponse | { data?: ToolListResponse }>('/mcp-tools'),
        // Admin gates + pending confirmations are separate (older) endpoints —
        // best-effort, the registry page must not fail on them.
        apiFetch<AccessConfigResponse | { data?: AccessConfigResponse }>('/mcp/access'),
        apiFetch<{ pending?: PendingAction[] } | { data?: { pending?: PendingAction[] } }>('/mcp/pending'),
      ]);
      if (seq !== seqRef.current) return; // a newer refresh already landed — drop this one
      if (listR.status === 'rejected') throw listR.reason;
      const data = unwrap(listR.value) as ToolListResponse;
      setTools(data.tools ?? []);
      setOrphanDocs(data.orphanDocs ?? []);
      setCategories(data.categories ?? []);
      if (accessR.status === 'fulfilled') {
        const cfg = unwrap(accessR.value) as AccessConfigResponse;
        setGates(new Map((cfg.tools ?? []).map((r) => [r.tool, r.adminGate])));
        setGatesUnavailable(false);
      } else {
        // Keep the last-known gates and SAY the state is unknown — silently rendering
        // every tool as "not gated" would misreport the security posture.
        setGatesUnavailable(true);
      }
      if (pendingR.status === 'fulfilled') {
        const pp = unwrap(pendingR.value) as { pending?: PendingAction[] };
        setPending(pp.pending ?? []);
      } // rejected ⇒ keep the previous list; the next poll self-corrects
    } catch (e) {
      if (seq === seqRef.current) setError(errText(e));
    } finally {
      if (seq === seqRef.current) setLoading(false);
    }
  }, [apiFetch]);

  useEffect(() => {
    void fetchAll();
    const t = setInterval(() => void fetchAll(), 10000); // pending confirmations expire in 10 min — keep them fresh
    return () => clearInterval(t);
  }, [fetchAll]);

  const groups = useMemo(() => groupTools(tools, categories), [tools, categories]);
  const counts = useMemo(() => summarizeCounts(tools), [tools]);

  // Manually propagate plugin tool changes to the claude.ai connector without a
  // restart (cache-clear → bootstrap refetch → tool-access → auto-approve).
  // Loopback-only server-side (like enable/disable) — works from the on-host UI.
  const syncConnector = useCallback(async () => {
    setSyncing(true);
    setSyncMsg(null);
    try {
      const r = await apiFetch<{ ok?: boolean; steps?: Array<{ step: string; ok: boolean; detail?: string }>; syncedTools?: string[] } | { data?: { ok?: boolean; steps?: Array<{ step: string; ok: boolean; detail?: string }>; syncedTools?: string[] } }>(
        '/mcp-plugins/sync-connector', { method: 'POST' });
      const d = ('data' in (r as object) ? (r as { data?: unknown }).data : r) as { ok?: boolean; steps?: Array<{ step: string; ok: boolean; detail?: string }>; syncedTools?: string[] };
      const bad = (d?.steps || []).filter((s) => !s.ok);
      setSyncMsg(bad.length
        ? `Sync incomplete: ${bad.map((s) => s.step).join(', ')} failed`
        : `Connector synced${d?.syncedTools?.length ? ` — ${d.syncedTools.length} plugin tool(s)` : ''}. New tools appear in a fresh conversation.`);
    } catch (e) {
      setSyncMsg(`Sync failed: ${errText(e)}`);
    } finally {
      setSyncing(false);
    }
  }, [apiFetch]);

  // MCP status incl. hub: core health, plugin subsystem, hub connection, connector.
  const loadStatus = useCallback(async () => {
    setStatusLoading(true);
    const unwrap = <T,>(r: T | { data?: T }): T => ('data' in (r as object) ? (r as { data?: T }).data : r) as T;
    const s: McpStatus = { core: null, plugins: null, hub: null, connector: null };
    try { s.core = unwrap(await apiFetch<{ status?: string }>('/health')); } catch (e) { s.core = { error: errText(e) }; }
    try { s.plugins = unwrap(await apiFetch<PluginListResponse>('/mcp-plugins')); } catch (e) { s.plugins = { error: errText(e) }; }
    try { s.hub = unwrap(await apiFetch<HubStatus>('/hub/status')); } catch (e) { s.hub = { error: errText(e) }; }
    try {
      const c = unwrap(await apiFetch<{ servers?: Array<{ name?: string; url?: string; connected?: boolean; tools?: string[] }> }>('/claude-ai/mcp/servers'));
      const lm = (c?.servers || []).find((x) => /langmart/i.test(x.url || '') || /langmart/i.test(x.name || '')) || (c?.servers || [])[0];
      s.connector = lm ? { name: lm.name, connected: lm.connected, toolCount: lm.tools?.length } : { error: 'no connector' };
    } catch (e) { s.connector = { error: errText(e) }; }
    setStatus(s);
    setStatusLoading(false);
  }, [apiFetch]);

  // GET /mcp-tools/profile. Fetched once on mount rather than in the 10s poll: the header
  // needs to name the active profile, but a profile changes when someone changes it — not
  // on a timer — and this page already spends three requests a tick.
  const loadProfile = useCallback(async () => {
    setProfileLoading(true);
    try {
      setProfile(unwrapBody(await apiFetch<McpProfileStatus>('/mcp-tools/profile')));
      setProfileError(null);
    } catch (e) {
      // Keep the last-known profile rather than blanking it: a failed read is not evidence
      // that the node switched to anything.
      setProfileError(profileUnavailableMessage(errText(e)));
    } finally {
      setProfileLoading(false);
    }
  }, [apiFetch]);

  // POST /mcp-tools/profile returns the same body GET does, so the new active profile and
  // the recounted sizes land without a re-read. On failure re-read anyway — the write may
  // have landed and only the response been lost, and a stale card would claim otherwise.
  const selectProfile = useCallback(async (name: string) => {
    setProfileBusy(name);
    setProfileError(null);
    try {
      setProfile(unwrapBody(await apiFetch<McpProfileStatus>('/mcp-tools/profile', { method: 'POST', body: { profile: name } })));
    } catch (e) {
      setProfileError(`Switch to "${name}" failed: ${errText(e)}`);
      await loadProfile();
    } finally {
      setProfileBusy(null);
    }
  }, [apiFetch, loadProfile]);

  useEffect(() => { void loadProfile(); }, [loadProfile]);

  const toggleStatus = useCallback(() => {
    setShowStatus((v) => {
      if (!v) void loadStatus();
      return !v;
    });
  }, [loadStatus]);

  const resolvePending = async (id: string, action: 'confirm' | 'deny') => {
    let failMsg: string | null = null;
    try {
      await apiFetch(`/mcp/pending/${encodeURIComponent(id)}/${action}`, { method: 'POST' });
    } catch (e) {
      // e.g. the pending expired between render and click — the user must see that
      // the tool call did NOT run, not just watch the row vanish.
      failMsg = `${action} failed: ${errText(e)}`;
    }
    await fetchAll();
    if (failMsg) setError(failMsg);
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
          {gatesUnavailable && (
            <span
              style={{ fontSize: 11, color: 'rgba(251,191,36,0.95)' }}
              title="/mcp/access is unreachable — gate toggles are paused until it recovers"
            >
              admin-gate state unavailable
            </span>
          )}
          <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>
            {counts.tools} tools · {counts.overridden} overridden · {counts.disabled} disabled
          </span>
          <button
            className={`btn btn-sm ${showProfile ? 'btn-primary' : 'btn-ghost'}`}
            onClick={() => setShowProfile((v) => !v)}
            title="Tool loading profile: how many tools this node advertises in tools/list. Advertise-only — a narrower profile hides tools from the list, it does not disable them."
          >
            <Layers size={12} /> Profile{profile ? `: ${profile.active}` : ''}
          </button>
          <button
            className={`btn btn-sm ${showPlugins ? 'btn-primary' : 'btn-ghost'}`}
            onClick={() => setShowPlugins((v) => !v)}
            title="Third-party MCP plugins: review, enable/disable, checksum pin, health and audit"
          >
            <Puzzle size={12} /> Plugins
          </button>
          <button
            className="btn btn-sm btn-ghost"
            onClick={() => void syncConnector()}
            disabled={syncing}
            title="Sync plugin tools to the claude.ai connector without a restart (cache-clear → refetch → enable → auto-approve). On-host only."
          >
            <PlugZap size={12} className={syncing ? 'animate-pulse' : undefined} /> Sync
          </button>
          <button
            className={`btn btn-sm ${showStatus ? 'btn-primary' : 'btn-ghost'}`}
            onClick={toggleStatus}
            title="MCP status: /mcp surface, plugin subsystem, claude.ai connector, and hub connection"
          >
            <Activity size={12} /> Status
          </button>
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

      {syncMsg && (
        <div
          onClick={() => setSyncMsg(null)}
          style={{ padding: '8px 20px', fontSize: 12, cursor: 'pointer', borderBottom: '1px solid var(--color-border-default)',
            color: syncMsg.startsWith('Sync failed') || syncMsg.includes('incomplete') ? 'rgba(248,113,113,0.95)' : 'var(--color-text-secondary)' }}
          title="Click to dismiss"
        >
          {syncMsg}
        </div>
      )}

      {showProfile && (
        <ProfilePanel
          status={profile}
          loading={profileLoading}
          error={profileError}
          busy={profileBusy}
          onRefresh={() => void loadProfile()}
          onSelect={(name) => void selectProfile(name)}
        />
      )}

      {showStatus && (
        <McpStatusPanel status={status} loading={statusLoading} onRefresh={() => void loadStatus()} />
      )}

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
          {showPlugins ? (
            <PluginsPanel apiFetch={apiFetch} />
          ) : selected ? (
            <ToolDetail
              name={selected}
              apiFetch={apiFetch}
              adminGate={selectedGate}
              gateStateKnown={!gatesUnavailable}
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
