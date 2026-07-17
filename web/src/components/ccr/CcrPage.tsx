'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Loader2, Eye, Radio, Cast, Square, ExternalLink, ChevronDown, Check, Settings2 } from 'lucide-react';
import { useAppMode } from '@/contexts/AppModeContext';
import { useMachineContext } from '@/contexts/MachineContext';
import { CcrSessionView } from './CcrSessionView';
import { CcrCloudView } from './CcrCloudView';
import { CcrComposer } from './CcrComposer';
import { CcrSessionList } from './CcrSessionList';
import { CcrSidebar } from './CcrSidebar';
import { CcrSearchModal } from './CcrSearchModal';
import { CcrDetailHeader } from './CcrDetailHeader';
import { CcrSessionControls } from './CcrSessionControls';
import { ModelEffortSelector } from '@/components/cowork/ModelEffortSelector';
import { useCcrData } from './useCcrData';
import { loadCcrView, saveCcrView, type CcrView } from '@/lib/ccr-view';
import type { ApiFetch, CcrRow } from './ccrTypes';

type Mode = 'load' | 'mirror' | 'connect';

const MODE_META: Record<Mode, { label: string; icon: typeof Eye; hint: string }> = {
  load: { label: 'Load', icon: Eye, hint: 'Read-only replay into claude.ai/code (safe, any session)' },
  mirror: { label: 'Mirror', icon: Radio, hint: 'One-way live view of a running session' },
  connect: { label: 'Connect', icon: Cast, hint: 'Two-way control — drive it from claude.ai/code' },
};

function parseCcrError(e: unknown): { code?: string; message: string } {
  const raw = e instanceof Error ? e.message : String(e);
  const m = raw.match(/\{[\s\S]*\}/);
  if (m) { try { const j = JSON.parse(m[0]); if (j?.error?.code || j?.error?.message) return { code: j.error.code, message: j.error.message || raw }; } catch { /* not json */ } }
  return { message: raw };
}
function friendlyCcrError(mode: Mode, e: unknown): string {
  const { code, message } = parseCcrError(e);
  switch (code) {
    case 'CONFLICT': return `Can't ${mode}: a live process already owns this session — connecting would corrupt its transcript. Use Load or Mirror instead.`;
    case 'SESSION_NOT_FOUND': return `Can't ${mode}: this session isn't on this host. Open this page on (or node-target) that host to bridge it.`;
    case 'TIMEOUT': return `${mode} timed out — the bridge couldn't reach claude.ai/code. Check the session cookie and retry.`;
    case 'TMUX_NOT_INSTALLED': return `Can't ${mode}: tmux isn't installed on this host.`;
    case 'PLATFORM_UNSUPPORTED': return `${mode} isn't supported on this platform.`;
    default: return `${mode} failed: ${message}`;
  }
}

export function CcrPage() {
  const { apiClient, proxy, hubUser, mode: appMode } = useAppMode();
  const { machines } = useMachineContext();
  const apiFetch = useCallback<ApiFetch>(
    (path, opts) => apiClient.fetchPath(path, { method: opts?.method, body: opts?.body, machineId: proxy.machineId || undefined }),
    [apiClient, proxy.machineId],
  );

  // ── THE data pipeline: one hook, one 5s poll, one row list for both panes ──
  const { rows, selfNode, nodes, loading, error, warning, nowMs, refresh } = useCcrData(apiFetch);

  /**
   * Row-scoped fetch: resources that physically live on a row's node (its
   * transcript, its bridge lifecycle) must be asked THERE. On a proxied/hub
   * page that's a native machine-targeted fetch; on a LAN page the browser
   * can't reach the hub cross-origin, so it goes through this node's Core
   * peer relay. Everything account-wide (/ccr/cloud/*) or node-routed
   * server-side (/mission/session/*) keeps the plain self fetch.
   */
  const fetchFor = useCallback((node?: string | null): ApiFetch => {
    if (!node || !selfNode || node === selfNode) return apiFetch;
    if (appMode === 'hub' || proxy.isProxied) {
      return (path, opts) => apiClient.fetchPath(path, { method: opts?.method, body: opts?.body, machineId: node });
    }
    return (path, opts) => apiFetch(`/peer-relay/${encodeURIComponent(node)}${path}`, opts);
  }, [apiFetch, apiClient, appMode, proxy.isProxied, selfNode]);

  /** gateway-id → friendly hostname (from the machines list; falls back to the id). */
  const nodeNames = useMemo(() => {
    const m: Record<string, string> = {};
    for (const mach of machines) {
      const id = mach.gatewayId || mach.id;
      if (id && mach.hostname) { m[id] = mach.hostname; m[mach.id] = mach.hostname; }
    }
    return m;
  }, [machines]);

  // ── ONE view state (category priority + node filter + status + sort) shared
  //    by the sidebar and the main list; persisted so polls/remounts never reset it. ──
  const [view, setViewState] = useState<CcrView>(loadCcrView);
  const setView = useCallback((v: CcrView) => { setViewState(v); saveCcrView(v); }, []);

  // Per-session URL: /ccr/<sid> deep-links a session (back-button + refresh + share).
  // We drive the URL with history.pushState (no Next remount) and read the initial sid from
  // the path; a popstate listener keeps back/forward in sync.
  const initialSid = typeof window !== 'undefined' ? (window.location.pathname.match(/^\/ccr\/([^/?#]+)/)?.[1] ?? null) : null;
  const [selectedId, setSelectedIdState] = useState<string | null>(initialSid ? decodeURIComponent(initialSid) : null);
  const selectSession = useCallback((id: string | null) => {
    setSelectedIdState(id);
    if (typeof window !== 'undefined') {
      const url = id ? `/ccr/${encodeURIComponent(id)}` : '/ccr';
      if (window.location.pathname !== url) window.history.pushState({ ccrSid: id }, '', url);
    }
  }, []);
  useEffect(() => {
    const onPop = () => setSelectedIdState(window.location.pathname.match(/^\/ccr\/([^/?#]+)/)?.[1] ? decodeURIComponent(RegExp.$1) : null);
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [confirmConnect, setConfirmConnect] = useState<string | null>(null);
  const [sessionErr, setSessionErr] = useState<Record<string, string>>({});
  const [searchOpen, setSearchOpen] = useState(false);
  // Cmd/Ctrl+K opens Search (replaces the dashboard overlay we lose going full-bleed).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key === 'k') { e.preventDefault(); setSearchOpen((v) => !v); } };
    document.addEventListener('keydown', onKey); return () => document.removeEventListener('keydown', onKey);
  }, []);
  const setBusyFor = (k: string, on: boolean) => setBusy((p) => { const n = new Set(p); if (on) n.add(k); else n.delete(k); return n; });

  const selected = useMemo(() => rows.find((r) => r.id === selectedId) || null, [rows, selectedId]);

  const startMode = useCallback(async (row: CcrRow, mode: Mode) => {
    const sid = row.id;
    setBusyFor(sid, true); setConfirmConnect(null);
    setSessionErr((p) => { const n = { ...p }; delete n[sid]; return n; });
    try { await fetchFor(row.node)(`/ccr/${mode}`, { method: 'POST', body: { sessionId: sid } }); await refresh(); }
    catch (e) { setSessionErr((p) => ({ ...p, [sid]: friendlyCcrError(mode, e) })); }
    finally { setBusyFor(sid, false); }
  }, [fetchFor, refresh]);

  const stopBridge = useCallback(async (row: CcrRow, bridgeId: string) => {
    setBusyFor(row.id, true);
    try { await fetchFor(row.node)(`/ccr/remote/${encodeURIComponent(bridgeId)}/stop`, { method: 'POST', body: {} }); await refresh(); }
    catch { /* surfaced by the next poll */ }
    finally { setBusyFor(row.id, false); }
  }, [fetchFor, refresh]);

  // Inline Load/Mirror/Connect + bridge-stop for a local session row.
  const rowActions = useCallback((row: CcrRow) => {
    if (row.kind !== 'local' || !row.local) return null;
    const v = row.local.verdict;
    const isBusy = busy.has(row.id);
    const allowed = (m: Mode) => v?.allowedModes?.includes(m);
    const bridge = row.remoteBridge;
    return (
      <>
        {bridge?.webUrl && <a className="btn btn-ghost btn-sm" href={bridge.webUrl} target="_blank" rel="noreferrer" title="Open the bridge on claude.ai/code"><ExternalLink size={13} /></a>}
        {bridge && <button className="btn btn-ghost btn-sm" disabled={isBusy} onClick={() => stopBridge(row, bridge.id)} title="Stop bridge">{isBusy ? <Loader2 size={12} style={{ animation: 'spin 1s linear infinite' }} /> : <Square size={12} />}</button>}
        {!bridge && (['load', 'mirror'] as Mode[]).map((m) => {
          const M = MODE_META[m]; const Icon = M.icon; const can = allowed(m);
          return <button key={m} className="btn btn-ghost btn-sm" disabled={isBusy || !can} title={can ? M.hint : `${m} unavailable`} onClick={() => startMode(row, m)}><Icon size={13} /></button>;
        })}
        {!bridge && allowed('connect') && (confirmConnect === row.id
          ? <><button className="btn btn-destructive btn-sm" disabled={isBusy} onClick={() => startMode(row, 'connect')}>Confirm</button><button className="btn btn-ghost btn-sm" onClick={() => setConfirmConnect(null)}>✕</button></>
          : <button className="btn btn-ghost btn-sm" disabled={isBusy} title={MODE_META.connect.hint} onClick={() => setConfirmConnect(row.id)}><Cast size={13} /></button>)}
      </>
    );
  }, [busy, confirmConnect, startMode, stopBridge]);

  const detailBody = (row: CcrRow) => (
    row.kind === 'local'
      ? <CcrSessionView sessionId={row.id} driveable={!!row.driveable} tmuxSession={row.local?.tmuxSession} apiFetch={fetchFor(row.node)} onClose={() => selectSession(null)} fill hideHeader />
      : <CcrCloudView sid={row.id} webUrl={row.webUrl || undefined} apiFetch={apiFetch} onClose={() => selectSession(null)} fill hideHeader />
  );

  const greetName = hubUser?.displayName || hubUser?.email?.split('@')[0] || '';

  return (
    // ── Full-bleed claude.ai/code layout: own sidebar + main, no app shell ──
    <div style={{ display: 'flex', height: '100%', overflow: 'hidden', background: 'var(--color-bg-root)' }}>
      <CcrSidebar
        rows={rows}
        view={view}
        onViewChange={setView}
        nodes={nodes}
        nodeNames={nodeNames}
        selfNode={selfNode}
        selectedId={selectedId}
        onSelect={(r) => selectSession(r.id)}
        onNewSession={() => selectSession(null)}
        onRefresh={refresh}
        onOpenSearch={() => setSearchOpen(true)}
        loading={loading}
        apiFetch={apiFetch}
        onChanged={refresh}
      />
      {searchOpen && (
        <CcrSearchModal rows={rows} nowMs={nowMs || Date.now()} onClose={() => setSearchOpen(false)} onSelect={(r) => selectSession(r.id)} />
      )}

      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {error && (
          <div style={{ margin: '12px 20px 0', padding: '8px 12px', borderRadius: 'var(--radius-md)', background: 'var(--color-bg-elevated)', border: '1px solid var(--color-status-red)', color: 'var(--color-status-red)', fontSize: 12 }}>{error}</div>
        )}
        {!error && warning && (
          <div title={warning} style={{ margin: '12px 20px 0', padding: '6px 12px', borderRadius: 'var(--radius-md)', background: 'var(--color-bg-elevated)', border: '1px solid var(--color-status-orange, #b8860b)', color: 'var(--color-status-orange, #b8860b)', fontSize: 11.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{warning}</div>
        )}

        {selected ? (
          // ── Detail view (claude.ai/code session) ──
          <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
            <CcrDetailHeader row={selected} apiFetch={apiFetch} onClose={() => selectSession(null)} onChanged={refresh} onDeleted={() => { selectSession(null); refresh(); }} />
            <CcrSessionControls row={selected} apiFetch={apiFetch} onChanged={refresh} nodeName={selected.node ? (nodeNames[selected.node] || selected.node) : null} />
            {selected.kind !== 'local' && <CloudControlBar row={selected} apiFetch={apiFetch} />}
            {selected.kind === 'local' && sessionErr[selected.id] && (
              <div style={{ margin: '8px 14px 0', padding: '6px 10px', borderRadius: 'var(--radius-sm)', background: 'var(--color-bg-elevated)', border: '1px solid var(--color-status-red)', fontSize: 11.5, color: 'var(--color-status-red)' }}>{sessionErr[selected.id]}</div>
            )}
            <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden', padding: '0 14px 14px' }}>
              {detailBody(selected)}
            </div>
          </div>
        ) : (
          // ── Home: greeting + session list (scrolls) above, composer pinned at the bottom ──
          <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
            <div style={{ flex: 1, overflow: 'auto', padding: '28px 20px 8px' }}>
              <div style={{ maxWidth: 900, margin: '0 auto' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 22 }}>
                  <span style={{ color: 'var(--color-accent)', fontSize: 20, lineHeight: 1 }}>✳</span>
                  <span style={{ fontSize: 21, fontWeight: 600, color: 'var(--color-text-primary)', letterSpacing: -0.2 }}>
                    Welcome back{greetName ? `, ${greetName}` : ''}
                  </span>
                </div>
                {loading && rows.length === 0 ? (
                  <div className="empty-state"><Loader2 size={22} style={{ animation: 'spin 1s linear infinite' }} /><span style={{ fontSize: 12 }}>Loading sessions…</span></div>
                ) : (
                  <CcrSessionList rows={rows} view={view} onViewChange={setView} nodeNames={nodeNames} selfNode={selfNode} selectedId={selectedId} onSelect={(r) => selectSession(r.id)} rowActions={rowActions} nowMs={nowMs} />
                )}
              </div>
            </div>
            <div style={{ padding: '10px 20px 18px' }}>
              <CcrComposer apiFetch={apiFetch} onStarted={(sid) => { refresh(); selectSession(sid); }} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** A slim in-detail control bar for cloud/remote sessions — live model + permission (POST /control). */
function CloudControlBar({ row, apiFetch }: { row: CcrRow; apiFetch: ApiFetch }) {
  const [model, setModel] = useState(row.model || 'claude-opus-4-8');
  const [effort, setEffort] = useState('high');
  const [permission, setPermission] = useState('Accept edits');
  const [permOpen, setPermOpen] = useState(false);
  const [saving, setSaving] = useState<string | null>(null);
  const permRef = useRef<HTMLDivElement>(null);
  useEffect(() => { setModel(row.model || 'claude-opus-4-8'); }, [row.id, row.model]);
  useEffect(() => {
    if (!permOpen) return;
    const onDown = (e: MouseEvent) => { if (permRef.current && !permRef.current.contains(e.target as Node)) setPermOpen(false); };
    document.addEventListener('mousedown', onDown); return () => document.removeEventListener('mousedown', onDown);
  }, [permOpen]);

  const apply = useCallback(async (body: { model?: string; permissionMode?: string }, label: string) => {
    setSaving(label);
    try { await apiFetch(`/ccr/cloud/${encodeURIComponent(row.id)}/control`, { method: 'POST', body }); }
    catch { /* surfaced by the row poll; keep the bar quiet */ }
    finally { setSaving(null); }
  }, [apiFetch, row.id]);

  const PERMS = ['Manual', 'Accept edits', 'Plan', 'Auto'];
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 14px', borderBottom: '1px solid var(--color-border-subtle)', fontSize: 11.5 }}>
      <span style={{ color: 'var(--color-text-tertiary)' }}>Session:</span>
      <div ref={permRef} style={{ position: 'relative' }}>
        <button className="btn btn-ghost btn-sm" onClick={() => setPermOpen((v) => !v)} style={{ fontSize: 11.5, gap: 5 }}>
          <Settings2 size={12} /> {permission} <ChevronDown size={11} />
        </button>
        {permOpen && (
          <div style={{ position: 'absolute', top: 'calc(100% + 4px)', left: 0, minWidth: 150, background: 'var(--color-bg-elevated)', border: '1px solid var(--color-border-default)', borderRadius: 'var(--radius-md)', boxShadow: '0 8px 24px rgba(0,0,0,0.4)', zIndex: 60, padding: 4 }}>
            {PERMS.map((p) => (
              <button key={p} onClick={() => { setPermission(p); setPermOpen(false); apply({ permissionMode: p }, 'perm'); }}
                style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left', padding: '6px 8px', borderRadius: 'var(--radius-sm)', border: 'none', background: 'none', cursor: 'pointer', fontSize: 12, color: p === permission ? 'var(--color-accent)' : 'var(--color-text-secondary)' }}>
                {p} {p === permission && <Check size={13} style={{ marginLeft: 'auto' }} />}
              </button>
            ))}
          </div>
        )}
      </div>
      <ModelEffortSelector model={model} effort={effort} onChange={(m, e) => { setModel(m); setEffort(e); if (m !== model) apply({ model: m }, 'model'); }} />
      {saving && <Loader2 size={12} style={{ animation: 'spin 1s linear infinite', color: 'var(--color-text-tertiary)' }} />}
    </div>
  );
}
