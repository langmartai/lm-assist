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

import { useCallback, useEffect, useState } from 'react';
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

export default function McpAccessTab({ baseUrl }: { baseUrl: string }) {
  const [cfg, setCfg] = useState<AccessConfig | null>(null);
  const [pending, setPending] = useState<Pending[]>([]);
  const [msg, setMsg] = useState<{ text: string; type: 'ok' | 'error' } | null>(null);
  const [loading, setLoading] = useState(false);

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
        <div className="space-y-1">
          {(['admin', 'write', 'read'] as Scope[]).flatMap((sc) =>
            (cfg?.tools.filter((t) => t.scope === sc) || []).map((t) => (
              <div key={t.tool} className="flex items-center justify-between border-b border-gray-800 py-1.5">
                <div className="flex items-center gap-2">
                  <span
                    className={`font-mono text-xs ${t.description ? 'cursor-help underline decoration-dotted decoration-gray-600 underline-offset-4' : ''}`}
                    title={t.description || undefined}
                  >
                    {t.tool}
                  </span>
                  <ScopeBadge s={t.scope} />
                </div>
                <button
                  onClick={() => setGate(t.tool, !t.adminGate)}
                  className={`px-2 py-1 rounded text-xs border ${t.adminGate ? 'bg-rose-900/40 text-rose-300 border-rose-700' : 'border-gray-600 text-gray-500'}`}
                >
                  {t.adminGate ? 'Admin confirm ON' : 'off'}
                </button>
              </div>
            )),
          )}
          {!cfg && <p className="text-gray-500">Loading…</p>}
        </div>
      </section>

      <button onClick={load} disabled={loading} className="text-xs text-gray-400 hover:text-gray-200">{loading ? 'Refreshing…' : 'Refresh'}</button>
    </div>
  );
}
