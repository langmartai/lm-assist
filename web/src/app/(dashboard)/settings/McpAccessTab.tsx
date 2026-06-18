'use client';

/**
 * MCP Admin Approval tab — per-user, this node, your account.
 *
 * This MCP connection is the user's own; there is no other principal to
 * authorize. The only control here is an OPTIONAL extra confirmation gate the
 * user can switch on PER TOOL:
 *   - ungated tool (default for every tool) → runs normally; whatever per-tool
 *     approval claude.ai applies is outside our control.
 *   - gated tool → parks as a pending action, released only by an out-of-band
 *     Confirm here (or POST /mcp/pending/:id/confirm). The model cannot reach
 *     that endpoint, so it can never release its own gated action.
 *
 * UI over the worker's /mcp/access (tool catalog + gate state),
 * /mcp/access/tool-gate (toggle a gate), and /mcp/pending* (confirm/deny).
 */

import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { workerFetch } from '@/lib/api-client';

type Scope = 'read' | 'write' | 'admin';

interface ToolRow { tool: string; scope: Scope; adminGate: boolean; description?: string }
interface AccessConfig { tools: ToolRow[] }
interface Pending {
  id: string; tool: string; summary: string;
  createdAt: number; expiresAt: number;
}

const scopeColor: Record<Scope, string> = {
  read: 'bg-emerald-900/40 text-emerald-300 border-emerald-700',
  write: 'bg-amber-900/40 text-amber-300 border-amber-700',
  admin: 'bg-rose-900/40 text-rose-300 border-rose-700',
};

function ScopeBadge({ s }: { s: Scope }) {
  return <span className={`inline-block px-1.5 py-0.5 rounded text-xs border ${scopeColor[s]}`}>{s}</span>;
}

// Functional grouping for the tool list (presentation only). Order = display order.
const FAMILY_ORDER = [
  'Search & Knowledge', 'Agent & Executions', 'Terminal', 'Windows Terminal',
  'claude.ai', 'Remote Control (CCR)', 'GitHub', 'Data Service', 'Files',
  'Transfer & Ports', 'Messaging', 'Nodes', 'Other',
] as const;

const KNOWLEDGE_TOOLS = new Set([
  'search', 'detail', 'feedback', 'list_recent_sessions', 'list_projects', 'search_memory',
  'memory_projects', 'memory_cross_host', 'memory_import_candidates', 'memory_map', 'memory_record', 'rule_map',
]);

function familyOf(tool: string): string {
  if (tool.startsWith('windows_terminal')) return 'Windows Terminal';
  if (tool.startsWith('terminal_') || tool === 'cc_sessions') return 'Terminal';
  if (tool.startsWith('ccr_')) return 'Remote Control (CCR)';
  if (tool.startsWith('agent_') || tool === 'list_executions' || tool === 'get_execution') return 'Agent & Executions';
  if (tool.startsWith('github_')) return 'GitHub';
  if (tool.startsWith('data_')) return 'Data Service';
  if (tool.startsWith('fs_')) return 'Files';
  if (tool.startsWith('transfer_') || tool.includes('port_forward')) return 'Transfer & Ports';
  if (tool === 'send_session_message' || tool === 'list_session_messages' || tool === 'get_message_status') return 'Messaging';
  if (tool === 'list_nodes') return 'Nodes';
  if (tool.startsWith('claudeai_') || tool === 'list_claudeai_conversations' || tool === 'read_conversation' || tool === 'delete_conversation') return 'claude.ai';
  if (KNOWLEDGE_TOOLS.has(tool)) return 'Search & Knowledge';
  return 'Other';
}

const SCOPE_RANK: Record<Scope, number> = { admin: 0, write: 1, read: 2 };

// Per-family accent (inline style — keep out of Tailwind's purge path).
const FAMILY_COLOR: Record<string, string> = {
  'Search & Knowledge': '#38bdf8',
  'Agent & Executions': '#a78bfa',
  Terminal: '#34d399',
  'Windows Terminal': '#2dd4bf',
  'claude.ai': '#fbbf24',
  'Remote Control (CCR)': '#e879f9',
  GitHub: '#94a3b8',
  'Data Service': '#60a5fa',
  Files: '#a3e635',
  'Transfer & Ports': '#fb923c',
  Messaging: '#f472b6',
  Nodes: '#22d3ee',
  Other: '#9ca3af',
};

export default function McpAccessTab({ baseUrl }: { baseUrl: string }) {
  const [cfg, setCfg] = useState<AccessConfig | null>(null);
  const [pending, setPending] = useState<Pending[]>([]);
  const [msg, setMsg] = useState<{ text: string; type: 'ok' | 'error' } | null>(null);
  const [loading, setLoading] = useState(false);

  // Click-to-open, draggable tool-description popup; closes on an outside click.
  const [popup, setPopup] = useState<{ tool: string; desc: string; x: number; y: number } | null>(null);
  const popupRef = useRef<HTMLDivElement>(null);

  // Per-family collapse (default: all expanded).
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const toggleCollapse = (fam: string) =>
    setCollapsed((s) => { const n = new Set(s); if (n.has(fam)) n.delete(fam); else n.add(fam); return n; });

  const openPopup = (e: ReactMouseEvent, t: ToolRow) => {
    if (!t.description) return;
    const x = Math.max(8, Math.min(e.clientX, window.innerWidth - 400));
    const y = Math.max(8, Math.min(e.clientY, window.innerHeight - 260));
    setPopup({ tool: t.tool, desc: t.description, x, y });
  };

  // Close when clicking anywhere outside the popup. The opening click can't
  // trigger this — the listener is only attached after `popup` becomes set.
  useEffect(() => {
    if (!popup) return;
    const onDown = (e: MouseEvent) => {
      if (popupRef.current && !popupRef.current.contains(e.target as Node)) setPopup(null);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [popup]);

  // Drag the popup by its header.
  const startDrag = (e: ReactMouseEvent) => {
    e.preventDefault();
    const sx = e.clientX, sy = e.clientY;
    const ox = popup?.x ?? 0, oy = popup?.y ?? 0;
    const onMove = (ev: MouseEvent) =>
      setPopup((p) => (p ? { ...p, x: ox + (ev.clientX - sx), y: oy + (ev.clientY - sy) } : p));
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };

  const flash = (text: string, type: 'ok' | 'error') => {
    setMsg({ text, type });
    setTimeout(() => setMsg(null), 4000);
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [a, p] = await Promise.all([
        workerFetch(`${baseUrl}/mcp/access`).then((r) => r.json()),
        workerFetch(`${baseUrl}/mcp/pending`).then((r) => r.json()),
      ]);
      if (a?.success) setCfg(a.data);
      if (p?.success) setPending(p.data.pending);
    } catch (e) {
      flash(`Load failed: ${e instanceof Error ? e.message : String(e)}`, 'error');
    } finally {
      setLoading(false);
    }
  }, [baseUrl]);

  useEffect(() => {
    load();
    const t = setInterval(load, 10000); // refresh pendings
    return () => clearInterval(t);
  }, [load]);

  const setGate = async (tool: string, enabled: boolean) => {
    try {
      const r = await workerFetch(`${baseUrl}/mcp/access/tool-gate`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tool, enabled }),
      }).then((x) => x.json());
      if (r?.success) {
        setCfg(r.data);
        flash(`${tool}: admin approval ${enabled ? 'on' : 'off'}`, 'ok');
      } else flash(r?.error?.message || 'Update failed', 'error');
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e), 'error');
    }
  };

  const resolvePending = async (id: string, action: 'confirm' | 'deny') => {
    try {
      const r = await workerFetch(`${baseUrl}/mcp/pending/${encodeURIComponent(id)}/${action}`, { method: 'POST' }).then((x) => x.json());
      flash(r?.success ? `Action ${action}ed` : (r?.error?.message || `${action} failed`), r?.success ? 'ok' : 'error');
      load();
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e), 'error');
    }
  };

  const gatedCount = cfg?.tools.filter((t) => t.adminGate).length ?? 0;

  return (
    <div className="space-y-6 text-sm">
      {msg && (
        <div className={`px-3 py-2 rounded ${msg.type === 'ok' ? 'bg-emerald-900/40 text-emerald-200' : 'bg-rose-900/40 text-rose-200'}`}>
          {msg.text}
        </div>
      )}

      <div>
        <h3 className="text-base font-semibold mb-1">MCP Admin Approval</h3>
        <p className="text-gray-400">
          This MCP is your own connection on this node — there is no other account to authorize. By default every
          tool runs under claude.ai&apos;s normal per-tool approval (outside our control). Optionally switch on an
          extra admin confirm for specific tools below: a gated tool parks as a pending action and runs only after
          you Confirm it here.
        </p>
      </div>

      {/* Pending admin actions */}
      <section>
        <h4 className="font-semibold mb-2">Pending admin actions {pending.length > 0 && <span className="text-rose-400">({pending.length})</span>}</h4>
        {pending.length === 0 ? (
          <p className="text-gray-500">No gated tool calls awaiting confirmation.</p>
        ) : (
          <div className="space-y-2">
            {pending.map((p) => (
              <div key={p.id} className="flex items-center justify-between border border-rose-800 rounded px-3 py-2 bg-rose-950/20">
                <div>
                  <div className="font-mono">{p.tool}</div>
                  <div className="text-gray-400 text-xs">expires {new Date(p.expiresAt).toLocaleTimeString()}</div>
                </div>
                <div className="flex gap-2">
                  <button onClick={() => resolvePending(p.id, 'confirm')} className="px-2 py-1 rounded bg-rose-700 hover:bg-rose-600 text-white text-xs">Confirm &amp; run</button>
                  <button onClick={() => resolvePending(p.id, 'deny')} className="px-2 py-1 rounded bg-gray-700 hover:bg-gray-600 text-white text-xs">Deny</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Per-tool admin gate */}
      <section>
        <h4 className="font-semibold mb-2">
          Tool admin gate {gatedCount > 0 && <span className="text-rose-400">({gatedCount} gated)</span>}
        </h4>
        <p className="text-gray-500 mb-2 text-xs">
          Toggle the extra admin confirm per tool. Default is off (normal claude.ai approval). The scope badge is a
          sensitivity hint only.
        </p>
        <div className="space-y-2">
          {cfg && FAMILY_ORDER.map((fam) => {
            const tools = cfg.tools
              .filter((t) => familyOf(t.tool) === fam)
              .sort((a, b) => (SCOPE_RANK[a.scope] - SCOPE_RANK[b.scope]) || a.tool.localeCompare(b.tool));
            if (tools.length === 0) return null;
            const gated = tools.filter((t) => t.adminGate).length;
            const color = FAMILY_COLOR[fam] || '#9ca3af';
            const isCollapsed = collapsed.has(fam);
            return (
              <div key={fam} className="rounded-lg border border-gray-800 bg-gray-900/40 overflow-hidden">
                <button
                  type="button"
                  onClick={() => toggleCollapse(fam)}
                  className="w-full flex items-center gap-2.5 px-3 py-2 bg-gray-800/40 hover:bg-gray-800/70 transition-colors text-left"
                  style={{ borderLeft: `3px solid ${color}` }}
                >
                  <span className="h-2 w-2 rounded-full shrink-0" style={{ background: color }} />
                  <span className="font-semibold text-xs text-gray-200">{fam}</span>
                  <span className="text-[10px] text-gray-400 bg-gray-800 rounded-full px-1.5 py-px tabular-nums">{tools.length}</span>
                  {gated > 0 && (
                    <span className="text-[10px] text-rose-300 bg-rose-900/40 border border-rose-800/60 rounded-full px-1.5 py-px">{gated} gated</span>
                  )}
                  <span
                    className="ml-auto text-gray-500 text-[10px] transition-transform duration-150"
                    style={{ transform: isCollapsed ? 'rotate(-90deg)' : 'none' }}
                  >
                    ▼
                  </span>
                </button>
                {!isCollapsed && (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-5 px-3 py-1">
                    {tools.map((t) => (
                      <div key={t.tool} className="flex items-center justify-between gap-2 border-b border-gray-800/50 py-1.5 min-w-0">
                        <div className="flex items-center gap-2 min-w-0">
                          <span
                            className={`font-mono text-xs truncate ${t.description ? 'cursor-pointer text-gray-300 hover:text-white underline decoration-dotted decoration-gray-600 underline-offset-4' : 'text-gray-400'}`}
                            onClick={t.description ? (e) => openPopup(e, t) : undefined}
                          >
                            {t.tool}
                          </span>
                          <ScopeBadge s={t.scope} />
                        </div>
                        <button
                          type="button"
                          onClick={() => setGate(t.tool, !t.adminGate)}
                          title="Admin confirm gate — parks the call as pending until you Confirm it here"
                          className={`shrink-0 px-2 py-0.5 rounded text-[10px] border transition-colors ${t.adminGate ? 'bg-rose-900/40 text-rose-300 border-rose-700' : 'border-gray-700 text-gray-500 hover:border-gray-500 hover:text-gray-300'}`}
                        >
                          {t.adminGate ? 'gated' : 'off'}
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
          {!cfg && <p className="text-gray-500">Loading…</p>}
        </div>
      </section>

      <button onClick={load} disabled={loading} className="text-xs text-gray-400 hover:text-gray-200">{loading ? 'Refreshing…' : 'Refresh'}</button>

      {popup && (
        <div
          ref={popupRef}
          style={{ position: 'fixed', left: popup.x, top: popup.y, width: 380, maxWidth: '90vw', zIndex: 50 }}
          className="rounded border border-gray-700 bg-gray-900 shadow-2xl text-xs"
        >
          <div
            onMouseDown={startDrag}
            className="flex items-center justify-between gap-3 px-3 py-2 border-b border-gray-700 bg-gray-800 rounded-t cursor-move select-none"
          >
            <span className="font-mono text-gray-200">{popup.tool}</span>
            <button onClick={() => setPopup(null)} className="text-gray-400 hover:text-gray-100 leading-none" aria-label="Close">✕</button>
          </div>
          <div className="px-3 py-2 max-h-72 overflow-auto whitespace-pre-wrap text-gray-300 leading-relaxed">
            {popup.desc}
          </div>
        </div>
      )}
    </div>
  );
}
