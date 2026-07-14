'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Loader2, Eye, Radio, Cast, Square, ExternalLink, ChevronDown, Check, Settings2 } from 'lucide-react';
import { useAppMode } from '@/contexts/AppModeContext';
import { CcrSessionView } from './CcrSessionView';
import { CcrCloudView } from './CcrCloudView';
import { CcrComposer } from './CcrComposer';
import { CcrSessionList } from './CcrSessionList';
import { CcrSidebar } from './CcrSidebar';
import { CcrSearchModal } from './CcrSearchModal';
import { CcrDetailHeader } from './CcrDetailHeader';
import { ModelEffortSelector } from '@/components/cowork/ModelEffortSelector';
import type { ApiFetch, CloudSessionInfo, Remote, RcData, CcSession, CcrRow } from './ccrTypes';

type Mode = 'load' | 'mirror' | 'connect';

const base = (p?: string | null) => (p ? p.split('/').filter(Boolean).pop() || p : '');

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

/** Normalize the four data sources into one claude.ai/code-style session list. */
function buildRows(cloud: CloudSessionInfo[], remotes: Remote[], rc: RcData, locals: CcSession[]): CcrRow[] {
  const rows: CcrRow[] = [];
  const titleByCse = new Map<string, string>();
  if (rc.controller?.cse) titleByCse.set(rc.controller.cse, rc.controller.title || 'Mission Controller');
  for (const ex of rc.executors) if (ex.cse) titleByCse.set(ex.cse, ex.title || ex.sid);

  const seenCse = new Set<string>();
  for (const c of cloud) {
    seenCse.add(c.sid);
    // Registry-fallback items (core offline / OAuth down) carry no kind — normalize so the
    // list, filter counts, and icons never see undefined.
    const kind: CcrRow['kind'] = c.kind === 'remote' ? 'remote' : 'cloud';
    rows.push({
      key: `cloud:${c.sid}`, kind, id: c.sid,
      title: titleByCse.get(c.sid) || c.title,
      repo: c.repo, branch: c.branch, model: c.model,
      status: { statusBucket: c.statusBucket, workerStatus: c.workerStatus, statusCategory: c.statusCategory, connectionStatus: c.connectionStatus },
      statusDetail: c.statusDetail || c.needsAction || null,
      time: c.lastEventAt || c.createdAt, webUrl: c.webUrl, unread: c.unread, cloud: c,
    });
  }
  // RC controller/executors not already in the cloud list (by cse) → remote rows.
  const rcExtra = [
    ...(rc.controller?.cse ? [{ sid: rc.controller.cse, title: rc.controller.title || 'Mission Controller' }] : []),
    ...rc.executors.filter((e) => e.cse).map((e) => ({ sid: e.cse as string, title: e.title || e.sid })),
  ];
  for (const x of rcExtra) {
    if (seenCse.has(x.sid)) continue;
    seenCse.add(x.sid);
    rows.push({ key: `rc:${x.sid}`, kind: 'remote', id: x.sid, title: x.title, status: { connectionStatus: 'connected' }, statusDetail: 'remote-control', time: null, webUrl: `https://claude.ai/code/${x.sid}` });
  }

  const bridgeBySession = new Map<string, Remote>();
  for (const r of remotes) if (r.sessionId) bridgeBySession.set(r.sessionId, r);

  const liveFirst = [...locals].sort((a, b) => Number(!!b.verdict?.live) - Number(!!a.verdict?.live));
  for (const s of liveFirst) {
    const bridge = bridgeBySession.get(s.sessionId);
    rows.push({
      key: `local:${s.sessionId}`, kind: 'local', id: s.sessionId,
      title: base(s.owner?.cwd) || base(s.jsonl) || 'session',
      repo: null, branch: null,
      status: { live: !!s.verdict?.live, connectionStatus: bridge ? 'connected' : null },
      statusDetail: bridge ? `bridged · ${bridge.mode}` : (s.owner?.status || null),
      time: null, webUrl: bridge?.webUrl || null,
      driveable: !!s.driveable || !!s.verdict?.live,
      local: s, remoteBridge: bridge,
    });
  }
  return rows;
}

export function CcrPage() {
  const { apiClient, proxy, hubUser } = useAppMode();
  const apiFetch = useCallback<ApiFetch>(
    (path, opts) => apiClient.fetchPath(path, { method: opts?.method, body: opts?.body, machineId: proxy.machineId || undefined }),
    [apiClient, proxy.machineId],
  );

  const [cloud, setCloud] = useState<CloudSessionInfo[]>([]);
  const [remotes, setRemotes] = useState<Remote[]>([]);
  const [rcData, setRcData] = useState<RcData>({ controller: null, executors: [], accountRc: [] });
  const [locals, setLocals] = useState<CcSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState<number>(0);
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

  const fetchAll = useCallback(async () => {
    setError(null);
    try {
      const [c, r, rc, s] = await Promise.all([
        apiFetch<{ sessions: CloudSessionInfo[] }>('/ccr/cloud').catch(() => ({ sessions: [] as CloudSessionInfo[] })),
        apiFetch<{ remotes: Remote[] }>('/ccr/remote').catch(() => ({ remotes: [] as Remote[] })),
        apiFetch<RcData>('/ccr/remote-control').catch(() => ({ controller: null, executors: [], accountRc: [] } as RcData)),
        apiFetch<CcSession[] | { sessions: CcSession[] }>('/terminal/cc-sessions').catch(() => [] as CcSession[]),
      ]);
      setCloud(c.sessions || []);
      setRemotes(r.remotes || []);
      setRcData({ controller: rc.controller ?? null, executors: rc.executors ?? [], accountRc: rc.accountRc ?? [] });
      setLocals(Array.isArray(s) ? s : (s.sessions || []));
      setNowMs(Date.now());
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  }, [apiFetch]);

  // Stable 5s poll (decoupled from apiFetch identity churn in hybrid/proxy mode).
  const fetchRef = useRef(fetchAll);
  useEffect(() => { fetchRef.current = fetchAll; }, [fetchAll]);
  useEffect(() => { fetchRef.current(); const t = setInterval(() => fetchRef.current(), 5000); return () => clearInterval(t); }, []);

  const rows = useMemo(() => buildRows(cloud, remotes, rcData, locals), [cloud, remotes, rcData, locals]);
  const selected = useMemo(() => rows.find((r) => r.id === selectedId) || null, [rows, selectedId]);

  const startMode = useCallback(async (sid: string, mode: Mode) => {
    setBusyFor(sid, true); setConfirmConnect(null);
    setSessionErr((p) => { const n = { ...p }; delete n[sid]; return n; });
    try { await apiFetch(`/ccr/${mode}`, { method: 'POST', body: { sessionId: sid } }); await fetchAll(); }
    catch (e) { setSessionErr((p) => ({ ...p, [sid]: friendlyCcrError(mode, e) })); }
    finally { setBusyFor(sid, false); }
  }, [apiFetch, fetchAll]);

  const stopBridge = useCallback(async (id: string) => {
    setBusyFor(id, true);
    try { await apiFetch(`/ccr/remote/${encodeURIComponent(id)}/stop`, { method: 'POST', body: {} }); await fetchAll(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusyFor(id, false); }
  }, [apiFetch, fetchAll]);

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
        {bridge && <button className="btn btn-ghost btn-sm" disabled={isBusy} onClick={() => stopBridge(bridge.id)} title="Stop bridge">{isBusy ? <Loader2 size={12} style={{ animation: 'spin 1s linear infinite' }} /> : <Square size={12} />}</button>}
        {!bridge && (['load', 'mirror'] as Mode[]).map((m) => {
          const M = MODE_META[m]; const Icon = M.icon; const can = allowed(m);
          return <button key={m} className="btn btn-ghost btn-sm" disabled={isBusy || !can} title={can ? M.hint : `${m} unavailable`} onClick={() => startMode(row.id, m)}><Icon size={13} /></button>;
        })}
        {!bridge && allowed('connect') && (confirmConnect === row.id
          ? <><button className="btn btn-destructive btn-sm" disabled={isBusy} onClick={() => startMode(row.id, 'connect')}>Confirm</button><button className="btn btn-ghost btn-sm" onClick={() => setConfirmConnect(null)}>✕</button></>
          : <button className="btn btn-ghost btn-sm" disabled={isBusy} title={MODE_META.connect.hint} onClick={() => setConfirmConnect(row.id)}><Cast size={13} /></button>)}
      </>
    );
  }, [busy, confirmConnect, startMode, stopBridge]);

  const detailBody = (row: CcrRow) => (
    row.kind === 'local'
      ? <CcrSessionView sessionId={row.id} driveable={!!row.driveable} tmuxSession={row.local?.tmuxSession} apiFetch={apiFetch} onClose={() => selectSession(null)} fill hideHeader />
      : <CcrCloudView sid={row.id} webUrl={row.webUrl || undefined} apiFetch={apiFetch} onClose={() => selectSession(null)} fill hideHeader />
  );

  const greetName = hubUser?.displayName || hubUser?.email?.split('@')[0] || '';

  return (
    // ── Full-bleed claude.ai/code layout: own sidebar + main, no app shell ──
    <div style={{ display: 'flex', height: '100%', overflow: 'hidden', background: 'var(--color-bg-root)' }}>
      <CcrSidebar
        rows={rows}
        selectedId={selectedId}
        onSelect={(r) => selectSession(r.id)}
        onNewSession={() => selectSession(null)}
        onRefresh={fetchAll}
        onOpenSearch={() => setSearchOpen(true)}
        loading={loading}
        apiFetch={apiFetch}
        onChanged={fetchAll}
      />
      {searchOpen && (
        <CcrSearchModal rows={rows} nowMs={nowMs || Date.now()} onClose={() => setSearchOpen(false)} onSelect={(r) => selectSession(r.id)} />
      )}

      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {error && (
          <div style={{ margin: '12px 20px 0', padding: '8px 12px', borderRadius: 'var(--radius-md)', background: 'var(--color-bg-elevated)', border: '1px solid var(--color-status-red)', color: 'var(--color-status-red)', fontSize: 12 }}>{error}</div>
        )}

        {selected ? (
          // ── Detail view (claude.ai/code session) ──
          <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
            <CcrDetailHeader row={selected} apiFetch={apiFetch} onClose={() => selectSession(null)} onChanged={fetchAll} onDeleted={() => { selectSession(null); fetchAll(); }} />
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
                  <CcrSessionList rows={rows} selectedId={selectedId} onSelect={(r) => selectSession(r.id)} rowActions={rowActions} nowMs={nowMs} />
                )}
              </div>
            </div>
            <div style={{ padding: '10px 20px 18px' }}>
              <CcrComposer apiFetch={apiFetch} onStarted={(sid) => { fetchAll(); selectSession(sid); }} />
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
