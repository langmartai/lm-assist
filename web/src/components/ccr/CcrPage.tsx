'use client';

import { useState, useEffect, useCallback } from 'react';
import {
  MonitorPlay, RefreshCw, Loader2, Eye, Radio, Cast, Square, ExternalLink, X, AlertTriangle, Copy, Check, Maximize2, Cloud,
} from 'lucide-react';
import { useAppMode } from '@/contexts/AppModeContext';
import { CcrSessionView } from './CcrSessionView';
import { CcrCloudView } from './CcrCloudView';

type Mode = 'load' | 'mirror' | 'connect';

interface Verdict {
  live: boolean;
  allowedModes: Mode[];
  connectStrategy: 'attach-existing' | 'create-tmux' | 'refuse' | 'none';
  safeToCreateTmux: boolean;
  reason?: string;
}
interface CcSession {
  sessionId: string;
  jsonl?: string;
  owner?: { cwd?: string; status?: string; kind?: string } | null;
  inTmux?: boolean;
  tmuxSession?: string;
  driveable?: boolean;
  verdict?: Verdict;
}
interface Remote {
  id: string;
  mode: 'load' | 'mirror' | 'connected';
  sessionId: string | null;
  webUrl: string | null;
  live?: boolean;
  strategy?: string;
}
interface CloudSession {
  sid: string;
  title: string;
  model: string;
  repo: string | null;
  cwd: string | null;
  webUrl: string;
  createdAt: string;
}
interface GitHubRepo {
  repo: string;          // owner/name
  isPrivate: boolean;
  pushedAt: string;
}

const short = (id: string | null | undefined) => (id ? id.slice(0, 8) : '—');
const base = (p?: string) => (p ? p.split('/').filter(Boolean).pop() || p : '');

const MODE_META: Record<Mode, { label: string; icon: typeof Eye; hint: string }> = {
  load: { label: 'Load', icon: Eye, hint: 'Read-only replay into claude.ai/code (safe, any session)' },
  mirror: { label: 'Mirror', icon: Radio, hint: 'One-way live view of a running session' },
  connect: { label: 'Connect', icon: Cast, hint: 'Two-way control — drive it from claude.ai/code' },
};

/** Pull the structured {code,message} out of an apiFetch error (it throws "API <status>: <body>"). */
function parseCcrError(e: unknown): { code?: string; message: string } {
  const raw = e instanceof Error ? e.message : String(e);
  const m = raw.match(/\{[\s\S]*\}/);
  if (m) { try { const j = JSON.parse(m[0]); if (j?.error?.code || j?.error?.message) return { code: j.error.code, message: j.error.message || raw }; } catch { /* not json */ } }
  return { message: raw };
}

/** Turn a CCR failure into a clear, actionable line for the operator. */
function friendlyCcrError(mode: Mode, e: unknown): string {
  const { code, message } = parseCcrError(e);
  switch (code) {
    case 'CONFLICT':
      return `Can't ${mode}: a live process already owns this session — connecting would corrupt its append-only transcript. Use Load (read-only) or Mirror (live view) instead.`;
    case 'SESSION_NOT_FOUND':
      return `Can't ${mode}: this session isn't on this host. CCR runs on the session's OWN machine — open this page on (or node-target) that host to bridge it; a remote session can't be connected from here.`;
    case 'TIMEOUT':
      return `${mode} timed out — the bridge couldn't reach claude.ai/code. Check the claude.ai session (cookie) is valid and retry.`;
    case 'TMUX_NOT_INSTALLED':
      return `Can't ${mode}: tmux isn't installed on this host (needed to back the session).`;
    case 'PLATFORM_UNSUPPORTED':
      return `${mode} isn't supported on this platform.`;
    case 'INVALID_INPUT':
      return `Can't ${mode}: ${message}`;
    default:
      return `${mode} failed: ${message}`;
  }
}

export function CcrPage() {
  const { apiClient, proxy } = useAppMode();
  const apiFetch = useCallback(
    async <T,>(path: string, opts?: { method?: string; body?: unknown }): Promise<T> =>
      apiClient.fetchPath<T>(path, { method: opts?.method, body: opts?.body, machineId: proxy.machineId || undefined }),
    [apiClient, proxy.machineId],
  );

  const [remotes, setRemotes] = useState<Remote[]>([]);
  const [sessions, setSessions] = useState<CcSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [confirmConnect, setConfirmConnect] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [viewing, setViewing] = useState<string | null>(null); // sessionId whose embedded view is open
  const [sessionErr, setSessionErr] = useState<Record<string, string>>({}); // per-session CCR failure
  const [cloudSessions, setCloudSessions] = useState<CloudSession[]>([]);
  const [cloudPrompt, setCloudPrompt] = useState('');
  const [cloudRepo, setCloudRepo] = useState('');
  const [cloudBranch, setCloudBranch] = useState('');
  const [cloudViewing, setCloudViewing] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [cloudErr, setCloudErr] = useState<string | null>(null);
  const [repos, setRepos] = useState<GitHubRepo[]>([]);
  const [branchOptions, setBranchOptions] = useState<string[]>([]);
  const [branchesLoading, setBranchesLoading] = useState(false);
  const setBusyFor = (k: string, on: boolean) => setBusy((p) => { const n = new Set(p); on ? n.add(k) : n.delete(k); return n; });
  const copyUrl = useCallback(async (url: string) => {
    try { await navigator.clipboard.writeText(url); setCopied(url); setTimeout(() => setCopied((c) => (c === url ? null : c)), 1500); } catch { /* clipboard blocked */ }
  }, []);

  const fetchAll = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const [r, s, c, p] = await Promise.all([
        apiFetch<{ remotes: Remote[] }>('/ccr/remote').catch(() => ({ remotes: [] })),
        apiFetch<CcSession[] | { sessions: CcSession[] }>('/terminal/cc-sessions').catch(() => [] as CcSession[]),
        apiFetch<{ sessions: CloudSession[] }>('/ccr/cloud').catch(() => ({ sessions: [] })),
        apiFetch<{ repos: GitHubRepo[] }>('/ccr/cloud/repos').catch(() => ({ repos: [] })),
      ]);
      setRemotes(r.remotes || []);
      setSessions(Array.isArray(s) ? s : (s.sessions || []));
      setCloudSessions(c.sessions || []);
      setRepos(p.repos || []); // already sorted most-recent-first by the backend
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setLoading(false); }
  }, [apiFetch]);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  // Load the selected repo's branches for the branch picker (debounced).
  useEffect(() => {
    const repo = cloudRepo.trim();
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) { setBranchOptions([]); setBranchesLoading(false); return; }
    let cancelled = false;
    setBranchesLoading(true);
    const t = setTimeout(async () => {
      try {
        const r = await apiFetch<{ branches: string[] }>(`/ccr/cloud/branches?repo=${encodeURIComponent(repo)}`);
        if (!cancelled) setBranchOptions(r.branches || []);
      } catch { if (!cancelled) setBranchOptions([]); }
      finally { if (!cancelled) setBranchesLoading(false); }
    }, 450);
    return () => { cancelled = true; clearTimeout(t); };
  }, [cloudRepo, apiFetch]);

  const startMode = useCallback(async (sid: string, mode: Mode) => {
    setBusyFor(sid, true); setConfirmConnect(null);
    setSessionErr((p) => { const n = { ...p }; delete n[sid]; return n; }); // clear prior error for this session
    try {
      await apiFetch<Remote>(`/ccr/${mode}`, { method: 'POST', body: { sessionId: sid } });
      await fetchAll();
    } catch (e) {
      setSessionErr((p) => ({ ...p, [sid]: friendlyCcrError(mode, e) }));
    } finally { setBusyFor(sid, false); }
  }, [apiFetch, fetchAll]);

  const stop = useCallback(async (id: string) => {
    setBusyFor(id, true); setError(null);
    try { await apiFetch(`/ccr/remote/${encodeURIComponent(id)}/stop`, { method: 'POST', body: {} }); await fetchAll(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusyFor(id, false); }
  }, [apiFetch, fetchAll]);

  const startCloud = useCallback(async () => {
    const repo = cloudRepo.trim();
    const p = cloudPrompt.trim();
    if (!p && !repo) return; // a prompt is optional, but start needs at least a repo or a prompt
    setStarting(true); setCloudErr(null);
    try {
      const body: Record<string, unknown> = {};
      if (p) body.prompt = p;
      if (repo) body.repo = repo;
      if (cloudBranch.trim()) body.branch = cloudBranch.trim();
      const r = await apiFetch<{ sid: string }>('/ccr/cloud/start', { method: 'POST', body });
      setCloudPrompt(''); setCloudRepo(''); setCloudBranch(''); setBranchOptions([]);
      await fetchAll();
      if (r?.sid) setCloudViewing(r.sid); // open the new session's view to watch it boot
    } catch (e) { setCloudErr(parseCcrError(e).message); }
    finally { setStarting(false); }
  }, [apiFetch, cloudPrompt, cloudRepo, cloudBranch, fetchAll]);

  const stopCloud = useCallback(async (sid: string) => {
    setBusyFor(sid, true); setCloudErr(null);
    try {
      await apiFetch(`/ccr/cloud/${encodeURIComponent(sid)}/stop`, { method: 'POST', body: {} });
      if (cloudViewing === sid) setCloudViewing(null);
      await fetchAll();
    } catch (e) { setCloudErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusyFor(sid, false); }
  }, [apiFetch, fetchAll, cloudViewing]);

  const sorted = [...sessions].sort((a, b) => Number(!!b.verdict?.live) - Number(!!a.verdict?.live));
  const shown = showAll ? sorted : sorted.filter((s) => s.verdict?.live || s.driveable).slice(0, 12);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden', background: 'var(--color-bg-root)' }}>
      <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--color-border-default)', display: 'flex', alignItems: 'center', gap: 12 }}>
        <MonitorPlay size={20} style={{ color: 'var(--color-accent)' }} />
        <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--color-text-primary)' }}>CCR — Remote Control</div>
        <span style={{ fontSize: 12, color: 'var(--color-text-tertiary)' }}>view or drive a Claude Code session from claude.ai/code</span>
        <div style={{ flex: 1 }} />
        <button className="btn btn-ghost btn-sm" onClick={fetchAll} disabled={loading} title="Refresh">
          <RefreshCw size={14} style={loading ? { animation: 'spin 1s linear infinite' } : undefined} />
        </button>
      </div>

      {error && (
        <div style={{ margin: '12px 20px 0', padding: '8px 12px', borderRadius: 'var(--radius-md)', background: 'var(--color-bg-elevated)', border: '1px solid var(--color-status-red)', color: 'var(--color-status-red)', fontSize: 12, display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ flex: 1 }}>{error}</span>
          <button className="btn btn-ghost btn-sm" onClick={() => setError(null)}><X size={12} /></button>
        </div>
      )}

      <div style={{ flex: 1, overflow: 'auto', padding: 20 }}>
        {/* Embedded session view (claude.ai can't be iframed, so we render it natively) */}
        {viewing && (
          <div style={{ marginBottom: 18 }}>
            <CcrSessionView
              sessionId={viewing}
              driveable={!!sessions.find((s) => s.sessionId === viewing)?.driveable || !!sessions.find((s) => s.sessionId === viewing)?.verdict?.live}
              tmuxSession={sessions.find((s) => s.sessionId === viewing)?.tmuxSession}
              apiFetch={apiFetch}
              onClose={() => setViewing(null)}
            />
          </div>
        )}

        {/* Active remotes */}
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-text-secondary)', marginBottom: 8 }}>
          Active remotes {remotes.length ? `(${remotes.length})` : ''}
        </div>
        {remotes.length === 0 ? (
          <div style={{ fontSize: 12, color: 'var(--color-text-tertiary)', marginBottom: 18 }}>No active CCR bridges. Start one from a session below.</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 18 }}>
            {remotes.map((r) => {
              const isBusy = busy.has(r.id);
              return (
                <div key={r.id} className="card" style={{ display: 'flex', alignItems: 'center', gap: 10, padding: 12, flexWrap: 'wrap' }}>
                  <span className={`badge ${r.mode === 'connected' ? 'badge-red' : r.mode === 'mirror' ? 'badge-blue' : 'badge-green'}`}>{r.mode}</span>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--color-text-tertiary)' }}>{short(r.sessionId)}</span>
                  {r.live === false && <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>(bridge idle)</span>}
                  {r.webUrl && <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--color-text-tertiary)', maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.webUrl}>{r.webUrl.replace('https://', '')}</span>}
                  {!r.webUrl && <span style={{ fontSize: 11, color: 'var(--color-status-orange)', display: 'flex', alignItems: 'center', gap: 4 }} title="The bridge started but never returned a claude.ai/code URL — it likely couldn't reach claude.ai (check the session cookie). Stop and retry."><AlertTriangle size={12} /> couldn’t reach claude.ai/code — Stop &amp; retry</span>}
                  <div style={{ flex: 1 }} />
                  {r.webUrl && (
                    <button className="btn btn-ghost btn-sm" onClick={() => copyUrl(r.webUrl!)} title="Copy URL (paste into a browser if the link opens the Claude app)">
                      {copied === r.webUrl ? <><Check size={13} /> Copied</> : <><Copy size={13} /> Copy URL</>}
                    </button>
                  )}
                  {r.sessionId && <button className={`btn btn-sm ${viewing === r.sessionId ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setViewing(viewing === r.sessionId ? null : r.sessionId)} title="View the session here (embedded)"><Maximize2 size={13} /> View</button>}
                  {r.webUrl && <a className="btn btn-ghost btn-sm" href={r.webUrl} target="_blank" rel="noreferrer" title="Open (may launch the Claude app via the claude.ai/code deep-link handler)"><ExternalLink size={13} /> Open</a>}
                  <button className="btn btn-ghost btn-sm" disabled={isBusy} onClick={() => stop(r.id)} title="Stop bridge">
                    {isBusy ? <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} /> : <><Square size={12} /> Stop</>}
                  </button>
                </div>
              );
            })}
          </div>
        )}

        {/* Cloud CCR — claude runs in an Anthropic-cloud container (no local machine) */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          <Cloud size={15} style={{ color: 'var(--color-accent)' }} />
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-text-secondary)' }}>Cloud sessions</div>
          <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>claude runs in an Anthropic-cloud container — no local machine needed</span>
        </div>
        <div className="card" style={{ padding: 12, marginBottom: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <textarea className="input" rows={2} value={cloudPrompt} placeholder="Optional prompt for the cloud claude — leave empty to just clone the repo and drive it after it boots…"
            style={{ resize: 'none', fontSize: 12.5 }} onChange={(e) => setCloudPrompt(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); startCloud(); } }} />
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <input className="input" list="ccr-repo-list" value={cloudRepo} onChange={(e) => setCloudRepo(e.target.value)}
              placeholder="GitHub repo to clone — pick or type owner/name (empty = scratch workspace)"
              spellCheck={false} autoComplete="off"
              style={{ flex: 2, minWidth: 260, fontSize: 12 }}
              title="The cloud container clones this GitHub repo (public or the org's private repos). Leave empty for an empty scratch workspace." />
            <input className="input" list="ccr-branch-list" value={cloudBranch} onChange={(e) => setCloudBranch(e.target.value)}
              placeholder={branchesLoading ? 'loading branches…' : branchOptions.length ? 'branch (pick / default)' : 'branch (optional)'}
              spellCheck={false} autoComplete="off"
              style={{ flex: 1, minWidth: 150, fontSize: 12 }}
              title="Branch to clone — pick from the repo's branches or type one (default: the repo's default branch)" />
          </div>
          <datalist id="ccr-repo-list">
            {repos.map((r) => (<option key={r.repo} value={r.repo}>{r.isPrivate ? 'private' : 'public'}</option>))}
          </datalist>
          <datalist id="ccr-branch-list">
            {branchOptions.map((b) => (<option key={b} value={b} />))}
          </datalist>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {!cloudPrompt.trim() && !cloudRepo.trim()
              ? <span style={{ fontSize: 11, color: 'var(--color-status-orange)' }}>pick a repo (or type a prompt) to start</span>
              : cloudRepo.trim()
                ? <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>clones <code>{cloudRepo.trim()}</code>{cloudBranch.trim() ? <> @ <code>{cloudBranch.trim()}</code></> : ' (default branch)'}{!cloudPrompt.trim() ? ' · no prompt — drive it after it boots' : ''}</span>
                : <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>empty scratch workspace (no repo)</span>}
            <div style={{ flex: 1 }} />
            <button className="btn btn-primary btn-sm" disabled={starting || (!cloudPrompt.trim() && !cloudRepo.trim())} onClick={startCloud} title="Boot a cloud-run claude (spends cloud quota)">
              {starting ? <><Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} /> Starting…</> : <><Cloud size={13} /> Start cloud</>}
            </button>
          </div>
          {cloudErr && <div style={{ fontSize: 11, color: 'var(--color-status-red)', display: 'flex', alignItems: 'center', gap: 6 }}><AlertTriangle size={12} /> {cloudErr}</div>}
        </div>

        {cloudViewing && (
          <div style={{ marginBottom: 12 }}>
            <CcrCloudView sid={cloudViewing} webUrl={cloudSessions.find((c) => c.sid === cloudViewing)?.webUrl} apiFetch={apiFetch} onClose={() => setCloudViewing(null)} />
          </div>
        )}

        {cloudSessions.length === 0 ? (
          <div style={{ fontSize: 12, color: 'var(--color-text-tertiary)', marginBottom: 18 }}>No cloud sessions. Start one above.</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 18 }}>
            {cloudSessions.map((c) => {
              const isBusy = busy.has(c.sid);
              return (
                <div key={c.sid} className="card" style={{ display: 'flex', alignItems: 'center', gap: 10, padding: 12, flexWrap: 'wrap' }}>
                  <span className="badge badge-blue" style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}><Cloud size={11} /> cloud</span>
                  <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-text-primary)' }}>{c.title}</span>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--color-text-tertiary)' }} title={c.sid}>{c.sid.replace('session_', '').slice(0, 8)}</span>
                  {c.repo ? <span className="badge badge-outline" title={`GitHub: ${c.repo}`}>{c.repo}</span> : c.cwd ? <span className="badge badge-outline" title={c.cwd}>{base(c.cwd)}</span> : <span className="badge badge-outline" title="empty scratch workspace">scratch</span>}
                  <div style={{ flex: 1 }} />
                  <button className="btn btn-ghost btn-sm" onClick={() => copyUrl(c.webUrl)} title="Copy claude.ai/code URL">
                    {copied === c.webUrl ? <><Check size={13} /> Copied</> : <><Copy size={13} /> Copy URL</>}
                  </button>
                  <button className={`btn btn-sm ${cloudViewing === c.sid ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setCloudViewing(cloudViewing === c.sid ? null : c.sid)} title="Watch + drive here">
                    <Maximize2 size={13} /> View
                  </button>
                  <a className="btn btn-ghost btn-sm" href={c.webUrl} target="_blank" rel="noreferrer" title="Open on claude.ai/code"><ExternalLink size={13} /> Open</a>
                  <button className="btn btn-ghost btn-sm" disabled={isBusy} onClick={() => stopCloud(c.sid)} title="Stop + delete the cloud session">
                    {isBusy ? <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} /> : <><Square size={12} /> Stop</>}
                  </button>
                </div>
              );
            })}
          </div>
        )}

        {/* Sessions */}
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 8 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-text-secondary)' }}>Claude Code sessions</div>
          <div style={{ flex: 1 }} />
          <button className="btn btn-ghost btn-sm" onClick={() => setShowAll((v) => !v)}>{showAll ? 'live only' : `show all (${sessions.length})`}</button>
        </div>

        {loading ? (
          <div className="empty-state"><Loader2 size={24} style={{ animation: 'spin 1s linear infinite' }} /><span style={{ fontSize: 12 }}>Loading…</span></div>
        ) : shown.length === 0 ? (
          <div className="empty-state"><MonitorPlay size={32} className="empty-state-icon" /><div>No sessions</div></div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {shown.map((s) => {
              const v = s.verdict;
              const isBusy = busy.has(s.sessionId);
              const allowed = (m: Mode) => v?.allowedModes?.includes(m);
              const refuse = v?.connectStrategy === 'refuse';
              return (
                <div key={s.sessionId} className="card" style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-text-primary)' }}>{base(s.owner?.cwd) || base(s.jsonl) || 'session'}</span>
                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--color-text-tertiary)' }}>{short(s.sessionId)}</span>
                    {v?.live ? <span className="badge badge-green">{s.owner?.status || 'live'}</span> : <span className="badge badge-default">finished</span>}
                    {s.inTmux && <span className="badge badge-outline">tmux</span>}
                    {v?.connectStrategy && v.connectStrategy !== 'none' && (
                      <span className="badge badge-outline" title={v.reason}>{v.connectStrategy}</span>
                    )}
                    {isBusy && <Loader2 size={14} style={{ animation: 'spin 1s linear infinite', color: 'var(--color-text-tertiary)' }} />}
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <button className={`btn btn-sm ${viewing === s.sessionId ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setViewing(viewing === s.sessionId ? null : s.sessionId)} title="View this session here (embedded) — read + drive">
                      <Maximize2 size={13} /> View here
                    </button>
                    {(['load', 'mirror'] as Mode[]).map((m) => {
                      const M = MODE_META[m]; const Icon = M.icon; const can = allowed(m);
                      return (
                        <button key={m} className="btn btn-ghost btn-sm" disabled={isBusy || !can} title={can ? M.hint : `not available (${m})`} onClick={() => startMode(s.sessionId, m)}>
                          <Icon size={13} /> {M.label}
                        </button>
                      );
                    })}
                    {/* Connect — two-way, confirm-gated; respects the refuse verdict */}
                    {allowed('connect') && (
                      confirmConnect === s.sessionId ? (
                        <>
                          <button className="btn btn-destructive btn-sm" disabled={isBusy} onClick={() => startMode(s.sessionId, 'connect')}>
                            Confirm connect ({v?.connectStrategy})
                          </button>
                          <button className="btn btn-ghost btn-sm" onClick={() => setConfirmConnect(null)}>Cancel</button>
                        </>
                      ) : (
                        <button className="btn btn-ghost btn-sm" disabled={isBusy} title={MODE_META.connect.hint} onClick={() => setConfirmConnect(s.sessionId)}>
                          <Cast size={13} /> Connect
                        </button>
                      )
                    )}
                    {refuse && <span style={{ fontSize: 11, color: 'var(--color-status-orange)', display: 'flex', alignItems: 'center', gap: 4 }}><AlertTriangle size={12} /> connect refused — a live process owns it; load/mirror instead</span>}
                  </div>
                  {/* Per-session CCR failure — clear + actionable */}
                  {sessionErr[s.sessionId] && (
                    <div style={{ marginTop: 4, padding: '6px 8px', borderRadius: 'var(--radius-sm)', background: 'var(--color-bg-elevated)', border: '1px solid var(--color-status-red)', fontSize: 11.5, color: 'var(--color-status-red)', display: 'flex', alignItems: 'flex-start', gap: 6 }}>
                      <AlertTriangle size={13} style={{ flexShrink: 0, marginTop: 1 }} />
                      <span style={{ flex: 1 }}>{sessionErr[s.sessionId]}</span>
                      <button className="btn btn-ghost btn-sm" style={{ padding: 0, color: 'var(--color-text-tertiary)' }} onClick={() => setSessionErr((p) => { const n = { ...p }; delete n[s.sessionId]; return n; })}><X size={12} /></button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        <div style={{ marginTop: 16, fontSize: 11, color: 'var(--color-text-tertiary)', lineHeight: 1.6 }}>
          <strong>Load</strong> = read-only replay (safe, any session). <strong>Mirror</strong> = one-way live view of a running
          session. <strong>Connect</strong> = two-way control — it attaches an existing tmux, or spawns a fresh
          <code> claude --resume</code> tmux only when no live process owns the session; it refuses otherwise to avoid
          corrupting the append-only transcript. Each opens a <code>claude.ai/code</code> URL above.
          <br />
          <strong>Note:</strong> the session renders in the <strong>claude.ai web UI</strong>. If <em>Open</em> launches the
          Claude desktop/mobile <strong>app</strong> instead of a browser tab, that's your OS routing the
          <code> claude.ai/code</code> deep-link to the app — use <strong>Copy URL</strong> and paste it into a browser to
          force the web view (or just use the app; it's the same cloud session).
        </div>
      </div>
    </div>
  );
}
