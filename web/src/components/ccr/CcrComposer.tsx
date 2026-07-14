'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { Cloud, Cast, Monitor, GitBranch, Code2, ChevronDown, Loader2, ArrowUp, Check, AlertTriangle, Settings2 } from 'lucide-react';
import { ModelEffortSelector } from '@/components/cowork/ModelEffortSelector';
import type { ApiFetch, EnvChoice } from './ccrTypes';

/** A small popover anchored above a pill button. Closes on outside-click / Escape. */
function Popover({ open, onClose, children, align = 'left' }: { open: boolean; onClose: () => void; children: React.ReactNode; align?: 'left' | 'right' }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div ref={ref} style={{ position: 'absolute', bottom: 'calc(100% + 6px)', [align]: 0, minWidth: 220, maxWidth: 360, background: 'var(--color-bg-elevated)', border: '1px solid var(--color-border-default)', borderRadius: 'var(--radius-md)', boxShadow: '0 8px 24px rgba(0,0,0,0.4)', zIndex: 60, padding: 4, maxHeight: 340, overflow: 'auto' }}>
      {children}
    </div>
  );
}

function Pill({ icon: Icon, label, onClick, active }: { icon: React.ComponentType<{ size?: number }>; label: string; onClick: () => void; active?: boolean }) {
  return (
    <button type="button" onClick={onClick} className="btn btn-ghost btn-sm"
      style={{ fontSize: 11.5, color: active ? 'var(--color-accent)' : 'var(--color-text-secondary)', gap: 5, padding: '3px 8px' }}>
      <Icon size={13} /><span style={{ maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
      <ChevronDown size={11} style={{ color: 'var(--color-text-tertiary)' }} />
    </button>
  );
}

const menuItem: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left', padding: '6px 8px', borderRadius: 'var(--radius-sm)', border: 'none', background: 'none', color: 'var(--color-text-secondary)', fontSize: 12, cursor: 'pointer' };
const menuHead: React.CSSProperties = { padding: '4px 8px 2px', fontSize: 10, fontWeight: 600, color: 'var(--color-text-tertiary)', textTransform: 'uppercase', letterSpacing: 0.5 };

const PERMISSIONS = ['Manual', 'Accept edits', 'Plan', 'Auto'];

/** claude.ai/code-style composer: environment / project / branch pills + input + permission / model / effort. */
export function CcrComposer({ apiFetch, onStarted }: { apiFetch: ApiFetch; onStarted: (sid: string) => void }) {
  const [env, setEnv] = useState<EnvChoice>('cloud');
  const [repo, setRepo] = useState('');
  const [branch, setBranch] = useState('');
  const [prompt, setPrompt] = useState('');
  const [permission, setPermission] = useState('Accept edits');
  const [model, setModel] = useState('claude-opus-4-8');
  const [effort, setEffort] = useState('high');
  const [starting, setStarting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const [repos, setRepos] = useState<Array<{ repo: string; isPrivate: boolean }>>([]);
  const [branchOptions, setBranchOptions] = useState<string[]>([]);
  const [branchesLoading, setBranchesLoading] = useState(false);
  const [repoFilter, setRepoFilter] = useState('');
  const [branchFilter, setBranchFilter] = useState('');

  const [openMenu, setOpenMenu] = useState<null | 'env' | 'repo' | 'branch' | 'perm'>(null);
  const close = useCallback(() => setOpenMenu(null), []);

  // Load repos once.
  useEffect(() => {
    apiFetch<{ repos: Array<{ repo: string; isPrivate: boolean }> }>('/ccr/cloud/repos')
      .then((r) => setRepos(r.repos || [])).catch(() => setRepos([]));
  }, [apiFetch]);

  // Load branches when the repo changes (debounced).
  useEffect(() => {
    const r = repo.trim();
    if (!/^[\w.-]+\/[\w.-]+$/.test(r)) { setBranchOptions([]); return; }
    let cancelled = false;
    setBranchesLoading(true);
    const t = setTimeout(async () => {
      try {
        const res = await apiFetch<{ branches: string[] }>(`/ccr/cloud/branches?repo=${encodeURIComponent(r)}`);
        if (!cancelled) setBranchOptions(res.branches || []);
      } catch { if (!cancelled) setBranchOptions([]); }
      finally { if (!cancelled) setBranchesLoading(false); }
    }, 400);
    return () => { cancelled = true; clearTimeout(t); };
  }, [repo, apiFetch]);

  const start = useCallback(async () => {
    if (env !== 'cloud') return; // only cloud creates; local/RC use the list's Connect actions
    const p = prompt.trim();
    const r = repo.trim();
    if (!p && !r) { setErr('Enter a task, or pick a repo to clone.'); return; }
    setStarting(true); setErr(null);
    try {
      const body: Record<string, unknown> = { model, effort, permissionMode: permission };
      if (p) body.prompt = p;
      if (r) body.repo = r;
      if (branch.trim()) body.branch = branch.trim();
      const res = await apiFetch<{ sid: string }>('/ccr/cloud/start', { method: 'POST', body });
      setPrompt(''); setErr(null);
      if (res?.sid) onStarted(res.sid);
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e);
      const m = raw.match(/\{[\s\S]*\}/);
      let msg = raw;
      if (m) { try { const j = JSON.parse(m[0]); msg = j?.error?.message || raw; } catch { /* keep raw */ } }
      setErr(msg);
    } finally { setStarting(false); }
  }, [env, prompt, repo, branch, model, effort, permission, apiFetch, onStarted]);

  const envMeta: Record<EnvChoice, { icon: React.ComponentType<{ size?: number }>; label: string }> = {
    cloud: { icon: Cloud, label: 'Default' },
    'remote-control': { icon: Cast, label: 'Remote Control' },
    local: { icon: Monitor, label: 'Local' },
  };
  const EnvIcon = envMeta[env].icon;
  const repoShort = repo ? repo.split('/').pop() || repo : 'Project';
  const filteredRepos = repos.filter((r) => !repoFilter || r.repo.toLowerCase().includes(repoFilter.toLowerCase()));
  const filteredBranches = branchOptions.filter((b) => !branchFilter || b.toLowerCase().includes(branchFilter.toLowerCase()));

  return (
    <div className="card" style={{ padding: 0, borderRadius: 'var(--radius-lg)', overflow: 'visible', maxWidth: 720, margin: '0 auto', width: '100%' }}>
      {/* pill row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 2, padding: '8px 10px 0', flexWrap: 'wrap' }}>
        <div style={{ position: 'relative' }}>
          <Pill icon={EnvIcon} label={envMeta[env].label} active={openMenu === 'env'} onClick={() => setOpenMenu(openMenu === 'env' ? null : 'env')} />
          <Popover open={openMenu === 'env'} onClose={close}>
            <div style={menuHead}>Local</div>
            <button style={{ ...menuItem, opacity: 0.55, cursor: 'default' }} disabled><Monitor size={14} /> Local <span style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--color-text-tertiary)' }}>Desktop only</span></button>
            <div style={menuHead}>Cloud</div>
            <button style={{ ...menuItem, color: env === 'cloud' ? 'var(--color-accent)' : undefined }} onClick={() => { setEnv('cloud'); close(); }}>
              <Cloud size={14} /> Default {env === 'cloud' && <Check size={13} style={{ marginLeft: 'auto' }} />}
            </button>
            <div style={menuHead}>Remote Control</div>
            <button style={{ ...menuItem, color: env === 'remote-control' ? 'var(--color-accent)' : undefined }} onClick={() => { setEnv('remote-control'); close(); }}>
              <Cast size={14} /> <span>Connect a local session</span>
            </button>
            <div style={{ padding: '2px 8px 6px', fontSize: 10.5, color: 'var(--color-text-tertiary)', lineHeight: 1.4 }}>
              Pick a live session in the list below → <strong>Connect</strong> to drive it from claude.ai/code.
            </div>
          </Popover>
        </div>

        <div style={{ position: 'relative' }}>
          <Pill icon={Code2} label={repoShort} active={openMenu === 'repo'} onClick={() => setOpenMenu(openMenu === 'repo' ? null : 'repo')} />
          <Popover open={openMenu === 'repo'} onClose={close}>
            <input autoFocus className="input" placeholder="Search repos…" value={repoFilter} onChange={(e) => setRepoFilter(e.target.value)}
              style={{ width: '100%', fontSize: 12, marginBottom: 4 }} />
            <button style={menuItem} onClick={() => { setRepo(''); setBranch(''); close(); }}>
              <span style={{ color: 'var(--color-text-tertiary)' }}>No repo (scratch)</span>{!repo && <Check size={13} style={{ marginLeft: 'auto' }} />}
            </button>
            {filteredRepos.slice(0, 40).map((r) => (
              <button key={r.repo} style={{ ...menuItem, color: r.repo === repo ? 'var(--color-accent)' : undefined }} onClick={() => { setRepo(r.repo); setBranch(''); setRepoFilter(''); close(); }}>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.repo}</span>
                <span style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--color-text-tertiary)' }}>{r.isPrivate ? 'private' : 'public'}</span>
              </button>
            ))}
          </Popover>
        </div>

        <div style={{ position: 'relative' }}>
          <Pill icon={GitBranch} label={branch || 'branch'} active={openMenu === 'branch'} onClick={() => setOpenMenu(openMenu === 'branch' ? null : 'branch')} />
          <Popover open={openMenu === 'branch'} onClose={close}>
            <input autoFocus className="input" placeholder={branchesLoading ? 'loading…' : 'Search branches…'} value={branchFilter} onChange={(e) => setBranchFilter(e.target.value)}
              style={{ width: '100%', fontSize: 12, marginBottom: 4 }} />
            <button style={menuItem} onClick={() => { setBranch(''); close(); }}>
              <span style={{ color: 'var(--color-text-tertiary)' }}>Default branch</span>{!branch && <Check size={13} style={{ marginLeft: 'auto' }} />}
            </button>
            {filteredBranches.slice(0, 40).map((b) => (
              <button key={b} style={{ ...menuItem, color: b === branch ? 'var(--color-accent)' : undefined }} onClick={() => { setBranch(b); setBranchFilter(''); close(); }}>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{b}</span>
              </button>
            ))}
            {!filteredBranches.length && !branchesLoading && <div style={{ padding: '4px 8px', fontSize: 11, color: 'var(--color-text-tertiary)' }}>type a branch name in the field, or leave default</div>}
          </Popover>
        </div>
      </div>

      {/* input */}
      <textarea className="input" rows={2} value={prompt} onChange={(e) => setPrompt(e.target.value)}
        placeholder={env === 'cloud' ? 'Describe a task or ask a question…' : 'Select Cloud to start here, or Connect a session below'}
        disabled={env !== 'cloud'}
        onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); start(); } }}
        style={{ border: 'none', background: 'transparent', resize: 'none', fontSize: 13.5, padding: '8px 12px', width: '100%', outline: 'none' }} />

      {/* control row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '4px 8px 8px', flexWrap: 'wrap' }}>
        <div style={{ position: 'relative' }}>
          <Pill icon={Settings2} label={permission} active={openMenu === 'perm'} onClick={() => setOpenMenu(openMenu === 'perm' ? null : 'perm')} />
          <Popover open={openMenu === 'perm'} onClose={close}>
            <div style={menuHead}>Mode</div>
            {PERMISSIONS.map((p, i) => (
              <button key={p} style={{ ...menuItem, color: p === permission ? 'var(--color-accent)' : undefined }} onClick={() => { setPermission(p); close(); }}>
                {p} <span style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--color-text-tertiary)' }}>{i + 1}</span>
                {p === permission && <Check size={13} />}
              </button>
            ))}
          </Popover>
        </div>
        <div style={{ flex: 1 }} />
        <ModelEffortSelector model={model} effort={effort} onChange={(m, e) => { setModel(m); setEffort(e); }} />
        <button className="btn btn-primary btn-sm" onClick={start} disabled={starting || env !== 'cloud' || (!prompt.trim() && !repo.trim())} title="Start (Enter)"
          style={{ borderRadius: 'var(--radius-md)', width: 32, height: 32, padding: 0, justifyContent: 'center' }}>
          {starting ? <Loader2 size={15} style={{ animation: 'spin 1s linear infinite' }} /> : <ArrowUp size={15} />}
        </button>
      </div>
      {err && <div style={{ padding: '0 12px 8px', fontSize: 11, color: 'var(--color-status-red)', display: 'flex', alignItems: 'center', gap: 5 }}><AlertTriangle size={12} /> {err}</div>}
    </div>
  );
}
