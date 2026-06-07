'use client';

/**
 * MCP Access Control tab — manages who may call which MCP tools on this node.
 *
 * Authorization is owned by lm-assist (config at ~/.lm-assist/mcp-access.json),
 * not the gateway. This tab is the UI over the worker's /mcp/access* + /mcp/pending
 * REST endpoints:
 *   - tool catalog (tool -> required scope)
 *   - default scopes for unmatched callers
 *   - per-subject grants (by connector clientId, langmart email, or userId)
 *   - parked admin actions to confirm / deny (out-of-band)
 */

import { useCallback, useEffect, useState } from 'react';

type Scope = 'read' | 'write' | 'admin';
const SCOPES: Scope[] = ['read', 'write', 'admin'];

interface Grant {
  id: string;
  clientId?: string;
  email?: string;
  userId?: string;
  scopes: Scope[];
  note?: string;
  updatedAt: string;
}
interface ToolRow { tool: string; scope: Scope }
interface AccessConfig { defaultScopes: Scope[]; grants: Grant[]; tools: ToolRow[]; autoApproveAdmin: boolean }
interface Pending {
  id: string; tool: string; summary: string;
  subject: { clientId?: string; email?: string; userId?: string };
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

  // new-grant form
  const [matchType, setMatchType] = useState<'email' | 'clientId' | 'userId'>('email');
  const [matchValue, setMatchValue] = useState('');
  const [newScopes, setNewScopes] = useState<Scope[]>(['read']);
  const [note, setNote] = useState('');

  const flash = (text: string, type: 'ok' | 'error') => {
    setMsg({ text, type });
    setTimeout(() => setMsg(null), 4000);
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [a, p] = await Promise.all([
        fetch(`${baseUrl}/mcp/access`).then((r) => r.json()),
        fetch(`${baseUrl}/mcp/pending`).then((r) => r.json()),
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

  const toggleScope = (list: Scope[], s: Scope, set: (v: Scope[]) => void) => {
    set(list.includes(s) ? list.filter((x) => x !== s) : [...list, s]);
  };

  const addGrant = async () => {
    if (!matchValue.trim()) return flash('Enter a value to match', 'error');
    if (newScopes.length === 0) return flash('Pick at least one scope', 'error');
    const body: Record<string, unknown> = { scopes: newScopes, note: note || undefined };
    body[matchType] = matchValue.trim();
    try {
      const r = await fetch(`${baseUrl}/mcp/access/grant`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }).then((x) => x.json());
      if (r?.success) {
        flash('Grant saved', 'ok');
        setMatchValue(''); setNote(''); setNewScopes(['read']);
        load();
      } else flash(r?.error?.message || 'Save failed', 'error');
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e), 'error');
    }
  };

  const removeGrant = async (id: string) => {
    try {
      await fetch(`${baseUrl}/mcp/access/grant/${encodeURIComponent(id)}`, { method: 'DELETE' });
      load();
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e), 'error');
    }
  };

  const setDefaults = async (scopes: Scope[]) => {
    try {
      await fetch(`${baseUrl}/mcp/access/defaults`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scopes }),
      });
      load();
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e), 'error');
    }
  };

  const setAutoApprove = async (enabled: boolean) => {
    try {
      const r = await fetch(`${baseUrl}/mcp/access/auto-approve`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      }).then((x) => x.json());
      flash(r?.success ? `Auto-approve turned ${enabled ? 'on' : 'off'}` : (r?.error?.message || 'Update failed'), r?.success ? 'ok' : 'error');
      load();
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e), 'error');
    }
  };

  const resolvePending = async (id: string, action: 'confirm' | 'deny') => {
    try {
      const r = await fetch(`${baseUrl}/mcp/pending/${encodeURIComponent(id)}/${action}`, { method: 'POST' }).then((x) => x.json());
      flash(r?.success ? `Action ${action}ed` : (r?.error?.message || `${action} failed`), r?.success ? 'ok' : 'error');
      load();
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e), 'error');
    }
  };

  const subjectLabel = (s: Pending['subject']) =>
    s.clientId ? `client ${s.clientId}` : s.email ? s.email : s.userId ? `user ${s.userId.slice(0, 8)}` : 'anonymous';

  return (
    <div className="space-y-6 text-sm">
      {msg && (
        <div className={`px-3 py-2 rounded ${msg.type === 'ok' ? 'bg-emerald-900/40 text-emerald-200' : 'bg-rose-900/40 text-rose-200'}`}>
          {msg.text}
        </div>
      )}

      <div>
        <h3 className="text-base font-semibold mb-1">MCP Access Control</h3>
        <p className="text-gray-400">
          Authorization lives on this node. The gateway authenticates the caller and routes the MCP request here;
          these rules decide what each caller may do. Default is read-only; grant write/admin per connector or user.
        </p>
      </div>

      {/* Admin action approval mode */}
      <section>
        <h4 className="font-semibold mb-2">Admin action approval</h4>
        <div className="flex items-center justify-between border border-gray-700 rounded px-3 py-2">
          <div className="pr-4">
            <div className="font-medium">{cfg?.autoApproveAdmin ? 'Auto-approve ON' : 'Manual confirm'}</div>
            <div className="text-gray-500 text-xs mt-0.5">
              {cfg?.autoApproveAdmin
                ? 'Admin tools held by a caller run immediately. Callers without admin scope are still denied.'
                : 'Admin tool calls park below and need an out-of-band Confirm before they run.'}
            </div>
          </div>
          <button
            onClick={() => cfg && setAutoApprove(!cfg.autoApproveAdmin)}
            disabled={!cfg}
            className={`px-3 py-1 rounded text-xs border ${cfg?.autoApproveAdmin ? 'bg-emerald-900/40 text-emerald-300 border-emerald-700' : 'border-gray-600 text-gray-400'}`}
          >
            {cfg?.autoApproveAdmin ? 'On' : 'Off'}
          </button>
        </div>
      </section>

      {/* Pending admin actions */}
      <section>
        <h4 className="font-semibold mb-2">Pending admin actions {pending.length > 0 && <span className="text-rose-400">({pending.length})</span>}</h4>
        {pending.length === 0 ? (
          <p className="text-gray-500">No admin tool calls awaiting confirmation.</p>
        ) : (
          <div className="space-y-2">
            {pending.map((p) => (
              <div key={p.id} className="flex items-center justify-between border border-rose-800 rounded px-3 py-2 bg-rose-950/20">
                <div>
                  <div className="font-mono">{p.tool}</div>
                  <div className="text-gray-400 text-xs">{subjectLabel(p.subject)} · expires {new Date(p.expiresAt).toLocaleTimeString()}</div>
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

      {/* Default scopes */}
      <section>
        <h4 className="font-semibold mb-2">Default scopes (callers with no grant)</h4>
        <div className="flex gap-2">
          {SCOPES.map((s) => {
            const on = cfg?.defaultScopes.includes(s);
            return (
              <button
                key={s}
                onClick={() => cfg && setDefaults(on ? cfg.defaultScopes.filter((x) => x !== s) : [...cfg.defaultScopes, s])}
                className={`px-2 py-1 rounded text-xs border ${on ? scopeColor[s] : 'border-gray-700 text-gray-500'}`}
              >
                {s}
              </button>
            );
          })}
        </div>
      </section>

      {/* Grants */}
      <section>
        <h4 className="font-semibold mb-2">Grants</h4>
        <div className="space-y-2 mb-3">
          {cfg?.grants.length === 0 && <p className="text-gray-500">No grants yet — everyone gets the default scopes.</p>}
          {cfg?.grants.map((g) => (
            <div key={g.id} className="flex items-center justify-between border border-gray-700 rounded px-3 py-2">
              <div>
                <div className="font-mono text-xs">
                  {g.clientId ? `client ${g.clientId}` : g.email ? g.email : `user ${g.userId}`}
                </div>
                <div className="flex gap-1 mt-1">{g.scopes.map((s) => <ScopeBadge key={s} s={s} />)}</div>
                {g.note && <div className="text-gray-500 text-xs mt-1">{g.note}</div>}
              </div>
              <button onClick={() => removeGrant(g.id)} className="px-2 py-1 rounded bg-gray-700 hover:bg-gray-600 text-xs">Remove</button>
            </div>
          ))}
        </div>

        {/* Add grant */}
        <div className="border border-gray-700 rounded p-3 space-y-2">
          <div className="font-medium">Add grant</div>
          <div className="flex gap-2 items-center flex-wrap">
            <select value={matchType} onChange={(e) => setMatchType(e.target.value as typeof matchType)} className="bg-gray-800 border border-gray-700 rounded px-2 py-1">
              <option value="email">email</option>
              <option value="clientId">clientId</option>
              <option value="userId">userId</option>
            </select>
            <input value={matchValue} onChange={(e) => setMatchValue(e.target.value)} placeholder="value to match" className="bg-gray-800 border border-gray-700 rounded px-2 py-1 flex-1 min-w-[180px]" />
          </div>
          <div className="flex gap-2">
            {SCOPES.map((s) => (
              <button key={s} onClick={() => toggleScope(newScopes, s, setNewScopes)} className={`px-2 py-1 rounded text-xs border ${newScopes.includes(s) ? scopeColor[s] : 'border-gray-700 text-gray-500'}`}>{s}</button>
            ))}
          </div>
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="note (optional)" className="bg-gray-800 border border-gray-700 rounded px-2 py-1 w-full" />
          <button onClick={addGrant} className="px-3 py-1 rounded bg-blue-700 hover:bg-blue-600 text-white">Save grant</button>
        </div>
      </section>

      {/* Tool catalog */}
      <section>
        <h4 className="font-semibold mb-2">Tool catalog ({cfg?.tools.length ?? 0})</h4>
        <div className="grid grid-cols-2 gap-x-6 gap-y-1">
          {(['read', 'write', 'admin'] as Scope[]).flatMap((sc) =>
            (cfg?.tools.filter((t) => t.scope === sc) || []).map((t) => (
              <div key={t.tool} className="flex items-center justify-between border-b border-gray-800 py-1">
                <span className="font-mono text-xs">{t.tool}</span>
                <ScopeBadge s={t.scope} />
              </div>
            )),
          )}
        </div>
      </section>

      <button onClick={load} disabled={loading} className="text-xs text-gray-400 hover:text-gray-200">{loading ? 'Refreshing…' : 'Refresh'}</button>
    </div>
  );
}
