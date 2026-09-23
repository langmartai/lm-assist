'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Bot, Check, ChevronDown, Copy, RefreshCw, Search, X } from 'lucide-react';
import { useAppMode } from '@/contexts/AppModeContext';
import { timeAgo } from '@/components/memory/format';
import {
  useAgentExecutions,
  useHarnessApi,
  useHarnessRuns,
  useHarnessStatus,
  useNarrow,
  useNow,
} from '@/hooks/useHarnessRuns';
import {
  HARNESS_RUN_STATUSES,
  SINCE_OPTIONS,
  buildDeepLink,
  isClaudeRunner,
  parseDeepLink,
  recordedRunnerTabs,
  runnerLabel,
  statusMeta,
  tabBadgeCounts,
  type DetailTab,
  type HarnessRunStatus,
  type HarnessStatusResponse,
  type SinceOption,
} from '@/lib/harness-runs';
import { HARNESS_TEXT_CSS, RunList, StatusDot, statusText, tint } from './RunList';
import { RunDetail } from './RunDetail';
import { ClaudeRunnersOverview, RunnerCard, RunnerOverview } from './RunnerOverview';

const DEFAULT_SINCE: SinceOption = '30d';
const SINCE_LABEL: Record<SinceOption, string> = { '24h': 'Last 24h', '7d': 'Last 7 days', '30d': 'Last 30 days', all: 'All time' };

function UpdatedAgo({ at, stale }: { at: number | null; stale: boolean }) {
  const now = useNow(at != null, 5000);
  if (at == null) return null;
  const s = Math.max(0, Math.round((now - at) / 1000));
  return (
    <span style={{ fontSize: 11, color: stale ? statusText('var(--color-status-orange)') : 'var(--color-text-tertiary)' }} title={new Date(at).toLocaleString()}>
      {stale ? 'stale · ' : ''}updated {s < 60 ? `${s}s ago` : timeAgo(at)}
    </span>
  );
}

function StatusFilter({ value, onChange }: { value: HarnessRunStatus[]; onChange: (v: HarnessRunStatus[]) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);
  const toggle = (s: HarnessRunStatus) => onChange(value.includes(s) ? value.filter((x) => x !== s) : [...value, s]);
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        type="button"
        className={`btn btn-sm ${value.length ? 'btn-secondary' : 'btn-ghost'}`}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        Status: {value.length === 0 ? 'all' : value.length === 1 ? statusMeta(value[0]).label : `${value.length} selected`}
        <ChevronDown size={11} />
      </button>
      {open && (
        <div
          style={{
            position: 'absolute', top: 'calc(100% + 4px)', right: 0, zIndex: 20, minWidth: 180, padding: 6,
            background: 'var(--color-bg-surface)', border: '1px solid var(--color-border-strong)', borderRadius: 'var(--radius-md)',
            boxShadow: '0 8px 24px rgba(0,0,0,0.25)', display: 'flex', flexDirection: 'column', gap: 1,
          }}
        >
          {HARNESS_RUN_STATUSES.map((s) => {
            const on = value.includes(s);
            return (
              <button
                key={s}
                type="button"
                onClick={() => toggle(s)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8, padding: '4px 8px', fontSize: 12, textAlign: 'left', border: 'none', cursor: 'pointer',
                  borderRadius: 'var(--radius-sm)', background: on ? 'var(--color-bg-hover)' : 'transparent', color: 'var(--color-text-primary)',
                }}
              >
                <span style={{ width: 12, display: 'inline-flex' }}>{on && <Check size={12} style={{ color: 'var(--color-accent)' }} />}</span>
                <StatusDot status={s} />
                {statusMeta(s).label}
              </button>
            );
          })}
          {value.length > 0 && (
            <button type="button" className="btn btn-sm btn-ghost" style={{ marginTop: 4 }} onClick={() => onChange([])}>Clear</button>
          )}
        </div>
      )}
    </div>
  );
}

function CopyBlock({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div style={{ position: 'relative', textAlign: 'left', width: '100%' }}>
      <pre
        style={{
          margin: 0, padding: '8px 36px 8px 10px', fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--color-text-secondary)',
          background: 'var(--color-bg-elevated)', border: '1px solid var(--color-border-default)', borderRadius: 'var(--radius-md)',
          whiteSpace: 'pre-wrap', wordBreak: 'break-all',
        }}
      >
        {text}
      </pre>
      <button
        type="button"
        className="btn btn-sm btn-ghost"
        style={{ position: 'absolute', top: 4, right: 4, padding: '2px 5px' }}
        title="Copy"
        onClick={() => {
          try {
            void navigator.clipboard?.writeText(text);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          } catch { /* clipboard blocked */ }
        }}
      >
        {copied ? <Check size={12} /> : <Copy size={12} />}
      </button>
    </div>
  );
}

function ReadinessRow({ ok, label, detail }: { ok: boolean | null; label: string; detail: string }) {
  const color = ok === null ? 'var(--color-text-tertiary)' : ok ? 'var(--color-status-green)' : 'var(--color-status-red)';
  return (
    <div className="flex items-center" style={{ gap: 8, fontSize: 12, textAlign: 'left' }}>
      <span style={{ width: 8, height: 8, borderRadius: '50%', background: color, flexShrink: 0 }} />
      <span style={{ color: 'var(--color-text-secondary)', minWidth: 150 }}>{label}</span>
      <span style={{ color: 'var(--color-text-tertiary)' }}>{detail}</span>
    </div>
  );
}

/** "No harness runs on this node yet" — with what is missing before one can run, and how to start one. */
function NoRunsYet({ status, statusLoading }: { status: HarnessStatusResponse | null; statusLoading: boolean }) {
  const pluggable = (status?.harnesses ?? []).filter((h) => h.pluggable || h.probe != null);
  const profiles = status?.providers.profiles ?? [];
  const def = profiles.find((p) => p.name === status?.providers.defaultProfile) ?? profiles[0];
  // The Core port this page's build talks to; never a hardcoded default.
  const port = typeof window !== 'undefined' ? (window as unknown as { __LM_LOCAL_API_PORT__?: string | number }).__LM_LOCAL_API_PORT__ : undefined;
  const base = port ? `http://127.0.0.1:${port}` : 'http://127.0.0.1:<core-port>';
  return (
    <div className="empty-state" style={{ flex: 1, gap: 12 }}>
      <Bot size={36} className="empty-state-icon" />
      <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--color-text-secondary)' }}>No harness runs on this node yet</div>
      <div style={{ fontSize: 12, maxWidth: 560 }}>
        A run is recorded here whenever <code style={{ fontFamily: 'var(--font-mono)' }}>agent_execute</code> or <code style={{ fontFamily: 'var(--font-mono)' }}>POST /agent/execute</code> uses a pluggable runner (qwen, opencode).
      </div>
      <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: 12, width: '100%', maxWidth: 560 }}>
        {status ? (
          <>
            {pluggable.map((h) => (
              <ReadinessRow
                key={h.id}
                ok={h.probe ? h.probe.available : null}
                label={`${runnerLabel(h.id, h.displayName)} installed`}
                detail={h.probe ? (h.probe.available ? h.probe.version ?? 'available' : h.probe.reason ?? 'unavailable') : 'not probeable'}
              />
            ))}
            <ReadinessRow
              ok={profiles.length > 0}
              label="Provider profile configured"
              detail={def ? `'${def.name}' · ${def.model}${def.hasKey ? '' : ' · no key'}` : 'none — PUT /harness/provider/:name at the console'}
            />
          </>
        ) : (
          <div style={{ fontSize: 12, color: 'var(--color-text-tertiary)' }}>{statusLoading ? 'Checking harnesses…' : 'Harness status not loaded — Refresh to probe.'}</div>
        )}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, width: '100%', maxWidth: 560 }}>
        <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)', textAlign: 'left' }}>From a Claude session (MCP):</div>
        <CopyBlock text={`agent_execute({ runner: 'qwen', cwd: '/path/to/project', prompt: 'Summarize README.md' })`} />
        <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)', textAlign: 'left' }}>On this host ($TOKEN is the Core API token):</div>
        <CopyBlock
          text={`curl -s -X POST ${base}/agent/execute \\\n  -H "x-api-key: $TOKEN" -H 'content-type: application/json' \\\n  -d '{"runner":"qwen","cwd":"/path/to/project","prompt":"Summarize README.md"}'`}
        />
      </div>
    </div>
  );
}

function FullNotice({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty-state" style={{ flex: 1 }}>
      <Bot size={36} className="empty-state-icon" />
      <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--color-text-secondary)' }}>{title}</div>
      {children && <div style={{ fontSize: 12, maxWidth: 520 }}>{children}</div>}
    </div>
  );
}

/**
 * /harness — every recorded qwen/opencode run on this node, per runner type: a day-grouped
 * list, a per-type overview, and a run detail with a live timeline, chat, prompt/result,
 * files and qwen's debug tail. Node-local like /mcp-tools: it reads the Core it is served by.
 */
export function HarnessPage() {
  const { proxy } = useAppMode();
  const { needsNode } = useHarnessApi();
  const narrow = useNarrow(900);

  // ── URL state: ?runner=<id|all|claude>&run=<id>&tab=<tab> ──
  const [runnerTab, setRunnerTab] = useState('all');
  const [selected, setSelected] = useState<string | null>(null);
  const [detailTab, setDetailTab] = useState<DetailTab>('timeline');
  const [linkRead, setLinkRead] = useState(false);
  useEffect(() => {
    const l = parseDeepLink(window.location.search);
    setRunnerTab(l.runner);
    setSelected(l.run);
    setDetailTab(l.tab);
    setLinkRead(true);
  }, []);
  useEffect(() => {
    if (!linkRead) return;
    const search = buildDeepLink({ runner: runnerTab, run: selected, tab: detailTab }, window.location.search);
    const url = `${window.location.pathname}${search}${window.location.hash}`;
    if (url !== `${window.location.pathname}${window.location.search}${window.location.hash}`) {
      window.history.replaceState(window.history.state, '', url);
    }
  }, [linkRead, runnerTab, selected, detailTab]);

  // ── Filters ──
  const [qInput, setQInput] = useState('');
  const [q, setQ] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setQ(qInput.trim()), 300);
    return () => clearTimeout(t);
  }, [qInput]);
  const [statuses, setStatuses] = useState<HarnessRunStatus[]>([]);
  const [since, setSince] = useState<SinceOption>(DEFAULT_SINCE);
  const [includeBackfill, setIncludeBackfill] = useState(true);
  const filtersActive = !!q || statuses.length > 0 || since !== DEFAULT_SINCE || !includeBackfill;
  const clearFilters = () => { setQInput(''); setQ(''); setStatuses([]); setSince(DEFAULT_SINCE); setIncludeBackfill(true); };

  const isRunnerTab = runnerTab !== 'all' && runnerTab !== 'claude';
  const runs = useHarnessRuns(
    { runner: isRunnerTab ? runnerTab : undefined, statuses, q, since, includeBackfill },
    { enabled: linkRead && !needsNode },
  );
  const status = useHarnessStatus(linkRead && !needsNode);
  const execs = useAgentExecutions(runnerTab === 'claude' && !needsNode);

  // Tab badges come from the list's byRunner FACET, which skips the runner filter — so EVERY
  // response carries valid counts for every tab under the current search/status/window,
  // narrowed to one runner or not. Cached because a runner switch nulls the list while the
  // new one loads; before the first list lands the runner summaries' window totals stand in.
  const [tabCounts, setTabCounts] = useState<Record<string, number> | null>(null);
  useEffect(() => {
    if (runs.list) setTabCounts(runs.list.counts.byRunner ?? {});
  }, [runs.list]);
  const badges = tabCounts ? tabBadgeCounts(tabCounts) : null;

  const runnerSummaries = runs.runners?.runners ?? [];
  const tabs = recordedRunnerTabs(runnerSummaries);
  const runnerNames = useMemo(() => {
    const m: Record<string, string> = {};
    for (const h of status.status?.harnesses ?? []) if (h.displayName) m[h.id] = h.displayName;
    for (const r of runnerSummaries) if (r.displayName) m[r.id] = r.displayName;
    return m;
  }, [status.status, runnerSummaries]);
  const probeOf = (id: string) => {
    if (!status.status) return undefined;
    return status.status.harnesses.find((h) => h.id === id)?.probe ?? null;
  };
  const claudeRunners = useMemo(() => {
    const fromSummary = runnerSummaries.filter((r) => isClaudeRunner(r.id) || !r.recorded);
    if (fromSummary.length) return fromSummary;
    return (status.status?.harnesses ?? [])
      .filter((h) => isClaudeRunner(h.id))
      .map((h) => ({ id: h.id, displayName: runnerLabel(h.id, h.displayName), capabilities: h.capabilities }));
  }, [runnerSummaries, status.status]);

  // ── Selection ──
  const missingRef = useRef(new Set<string>());
  const [notice, setNotice] = useState<string | null>(null);
  const [narrowOverview, setNarrowOverview] = useState(false);
  const selectRun = useCallback((id: string | null) => {
    setSelected(id);
    setNotice(null);
  }, []);
  const switchTab = (id: string) => {
    setRunnerTab(id);
    setSelected(null);
    setNarrowOverview(false);
  };
  const onNotFound = useCallback((id: string) => {
    missingRef.current.add(id);
    setNotice(`Run ${id} not found — pruned by retention or recorded by the other (dev/prod) Core.`);
    setSelected((cur) => (cur === id ? null : cur));
  }, []);
  const onTabChange = useCallback((t: DetailTab) => setDetailTab(t), []);

  // All tab, wide layout, nothing selected: open the newest run rather than an empty pane.
  useEffect(() => {
    if (!linkRead || narrow || runnerTab !== 'all' || selected) return;
    const first = runs.rows.find((r) => !missingRef.current.has(r.id));
    if (first) setSelected(first.id);
  }, [linkRead, narrow, runnerTab, selected, runs.rows]);

  const refreshAll = () => {
    runs.refresh();
    void status.refresh();
    if (runnerTab === 'claude') void execs.refresh();
  };

  const counts = runs.list?.counts;
  const running = counts?.running ?? 0;
  const activeSummary = isRunnerTab ? runnerSummaries.find((r) => r.id === runnerTab) : undefined;
  // `counts.total` is the whole index, unfiltered, in every response.
  const noRunsAtAll = !!runs.list && runs.rows.length === 0 && !filtersActive && (counts?.total ?? 0) === 0;
  // The first list request failed: nothing is known about this node's runs, so say that —
  // not "no runs", and not "Loading…" forever.
  const loadFailed = !runs.list && !!runs.error;

  // ── Pieces ──
  const header = (
    <div className="flex flex-wrap items-center" style={{ padding: '14px 20px', borderBottom: '1px solid var(--color-border-default)', gap: 10 }}>
      <Bot size={20} style={{ color: 'var(--color-accent)' }} />
      <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--color-text-primary)' }}>Harness Runs</div>
      {runs.list && (
        <span className="badge badge-outline" style={{ fontSize: 10 }} title="The Core serving this page — dev and prod keep separate run records">
          {runs.list.core} core
        </span>
      )}
      {counts && (
        <span className="flex items-center" style={{ gap: 6, fontSize: 11.5, color: 'var(--color-text-secondary)' }}>
          {running > 0 && <span className="status-dot in-progress" />}
          {counts.total.toLocaleString()} run{counts.total === 1 ? '' : 's'} · {running} running
          {filtersActive && <span style={{ color: 'var(--color-text-tertiary)' }}>· {counts.matched} match</span>}
        </span>
      )}
      <UpdatedAgo at={runs.updatedAt} stale={runs.stale} />
      <div className="flex flex-wrap items-center" style={{ gap: 6, marginLeft: 'auto' }}>
        <div style={{ position: 'relative', width: narrow ? '100%' : 220 }}>
          <Search size={12} style={{ position: 'absolute', left: 9, top: '50%', transform: 'translateY(-50%)', color: 'var(--color-text-tertiary)', pointerEvents: 'none' }} />
          <input
            className="input"
            value={qInput}
            onChange={(e) => setQInput(e.target.value.slice(0, 100))}
            onKeyDown={(e) => { if (e.key === 'Escape' && qInput) { e.stopPropagation(); setQInput(''); } }}
            placeholder="Search prompt, cwd, model, id…"
            style={{ paddingLeft: 26, paddingRight: qInput ? 26 : 10, paddingTop: 4, paddingBottom: 4 }}
            aria-label="Search runs"
          />
          {qInput && (
            <button type="button" onClick={() => setQInput('')} aria-label="Clear search"
              style={{ position: 'absolute', right: 6, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-text-tertiary)', display: 'flex' }}>
              <X size={12} />
            </button>
          )}
        </div>
        <StatusFilter value={statuses} onChange={setStatuses} />
        <select className="input" style={{ width: 'auto', padding: '3px 8px' }} value={since} onChange={(e) => setSince(e.target.value as SinceOption)} aria-label="Time window">
          {SINCE_OPTIONS.map((s) => <option key={s} value={s}>{SINCE_LABEL[s]}</option>)}
        </select>
        <label
          className="flex items-center"
          style={{ gap: 5, fontSize: 11.5, color: 'var(--color-text-secondary)', cursor: 'pointer' }}
          title="Include runs backfilled from disk (qwen run dirs and OpenCode sessions that predate recording)"
        >
          <input type="checkbox" checked={includeBackfill} onChange={(e) => setIncludeBackfill(e.target.checked)} /> legacy
        </label>
        <button className="btn btn-sm btn-ghost" onClick={refreshAll} disabled={runs.loading && status.loading} title="Reload runs and re-probe the harnesses">
          <RefreshCw size={12} className={runs.loading || status.loading ? 'animate-spin' : undefined} /> Refresh
        </button>
      </div>
    </div>
  );

  const banners = (
    <>
      {runs.error && (
        <div
          className="flex flex-wrap items-center"
          style={{ margin: '10px 20px 0', padding: '8px 12px', borderRadius: 'var(--radius-sm)', gap: 10, fontSize: 12, ...tint('var(--color-status-red)', 8) }}
        >
          <span style={{ flex: 1, minWidth: 0 }}>{runs.error}{runs.stale ? ' — showing the last good data.' : ''}</span>
          <button type="button" className="btn btn-sm btn-secondary" onClick={runs.refresh}>Retry</button>
        </div>
      )}
      {notice && (
        <div
          className="flex items-center"
          style={{ margin: '10px 20px 0', padding: '8px 12px', borderRadius: 'var(--radius-sm)', gap: 10, fontSize: 12, ...tint('var(--color-status-orange)', 8) }}
        >
          <span style={{ flex: 1 }}>{notice}</span>
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => setNotice(null)} aria-label="Dismiss"><X size={12} /></button>
        </div>
      )}
      {runs.runnersError && !runs.error && (
        <div style={{ margin: '8px 20px 0', fontSize: 11, color: statusText('var(--color-status-orange)') }}>Runner summary unavailable: {runs.runnersError}</div>
      )}
    </>
  );

  // Real buttons (as DataPage's tab-items are), so every tab is reachable from the keyboard.
  const tabBar = (
    <div className="tab-bar" role="tablist" aria-label="Runner" style={{ marginTop: 6 }}>
      <button type="button" className={`tab-item${runnerTab === 'all' ? ' active' : ''}`} onClick={() => switchTab('all')} role="tab" aria-selected={runnerTab === 'all'}>
        All <span className="tab-badge">{badges ? badges.all : '…'}</span>
      </button>
      {tabs.map((r) => {
        const n = badges ? badges.of(r.id) : r.stats?.total;
        return (
          <button type="button" key={r.id} className={`tab-item${runnerTab === r.id ? ' active' : ''}`} onClick={() => switchTab(r.id)} role="tab" aria-selected={runnerTab === r.id}>
            {runnerLabel(r.id, r.displayName)}
            {n != null && <span className="tab-badge">{n}</span>}
            {(r.stats?.running ?? 0) > 0 && <span className="status-dot in-progress" />}
          </button>
        );
      })}
      {/* A deep link to a runner this Core no longer reports still gets a tab, so it is not a dead end. */}
      {isRunnerTab && !tabs.some((t) => t.id === runnerTab) && runs.runners && (
        <button type="button" className="tab-item active" role="tab" aria-selected>{runnerLabel(runnerTab, runnerNames[runnerTab])}</button>
      )}
      <button type="button" className={`tab-item${runnerTab === 'claude' ? ' active' : ''}`} onClick={() => switchTab('claude')} role="tab" aria-selected={runnerTab === 'claude'}>
        Claude runners
      </button>
    </div>
  );

  const listEmpty = loadFailed ? (
    <div className="empty-state" style={{ padding: '32px 16px' }}>
      <span style={{ fontSize: 12 }}>Could not load runs</span>
      <button type="button" className="btn btn-sm btn-secondary" onClick={runs.refresh}>Retry</button>
    </div>
  ) : filtersActive ? (
    <div className="empty-state" style={{ padding: '32px 16px' }}>
      <span style={{ fontSize: 12 }}>No runs match</span>
      <button type="button" className="btn btn-sm btn-secondary" onClick={clearFilters}>Clear filters</button>
    </div>
  ) : since !== 'all' && (counts?.total ?? 0) > 0 ? (
    // The default window hides older runs without counting as a filter — say so.
    <div className="empty-state" style={{ padding: '32px 16px' }}>
      <span style={{ fontSize: 12 }}>No runs in the {SINCE_LABEL[since].toLowerCase()}</span>
      <button type="button" className="btn btn-sm btn-secondary" onClick={() => setSince('all')}>Show all time</button>
    </div>
  ) : (
    <div className="empty-state" style={{ padding: '32px 16px' }}>
      <span style={{ fontSize: 12 }}>
        {isRunnerTab ? `No ${runnerLabel(runnerTab, runnerNames[runnerTab])} runs on this node yet` : 'No harness runs on this node yet'}
      </span>
    </div>
  );

  const list = (
    <RunList
      rows={runs.rows}
      selectedId={selected}
      onSelect={selectRun}
      initialLoading={!runs.list && !runs.error}
      hasMore={runs.hasMore}
      loadingMore={runs.loadingMore}
      onLoadMore={runs.loadMore}
      empty={listEmpty}
      header={narrow && activeSummary ? (
        <div style={{ padding: '4px 14px 8px' }}>
          <button type="button" className="btn btn-sm btn-secondary" style={{ width: '100%' }} onClick={() => setNarrowOverview(true)}>
            {runnerLabel(activeSummary.id, activeSummary.displayName)} overview
          </button>
        </div>
      ) : undefined}
    />
  );

  const detail = selected ? (
    <RunDetail
      key={selected}
      runId={selected}
      tab={detailTab}
      onTabChange={onTabChange}
      onNotFound={onNotFound}
      // Wide + runner tab: the overview sits behind the detail, so offer the way back to it.
      onBack={narrow || isRunnerTab ? () => selectRun(null) : undefined}
      backLabel={narrow ? 'Back' : `${runnerLabel(runnerTab, runnerNames[runnerTab])} overview`}
      onRunChanged={runs.refresh}
      runnerNames={runnerNames}
    />
  ) : null;

  const overview = activeSummary ? (
    <RunnerOverview
      runner={activeSummary}
      probe={probeOf(activeSummary.id)}
      statusLoading={status.loading}
      recentRuns={runs.rows}
      onSelectRun={selectRun}
      onBack={narrow ? () => setNarrowOverview(false) : undefined}
    />
  ) : null;

  let body: ReactNode;
  if (needsNode) {
    body = <FullNotice title="Open this page through a node">Harness runs live on the node that ran them. Open this page from a node (the machine&apos;s own web UI or its hub link) — the bare hub view has no node to ask.</FullNotice>;
  } else if (runs.notSupported) {
    body = <FullNotice title="This node's Core predates the Harness Runs API — upgrade lm-assist">GET /harness/runs answered 404: the Core serving this page does not record harness runs yet.</FullNotice>;
  } else if (runnerTab === 'claude') {
    body = (
      <ClaudeRunnersOverview
        runners={claudeRunners}
        executions={execs.items}
        loading={execs.loading}
        error={execs.error}
        onRefresh={() => void execs.refresh()}
        basePath={proxy.basePath}
      />
    );
  } else if (noRunsAtAll && runnerTab === 'all') {
    body = <NoRunsYet status={status.status} statusLoading={status.loading} />;
  } else if (narrow) {
    body = selected ? detail : narrowOverview && overview ? overview : list;
  } else {
    body = (
      <>
        <div style={{ width: 340, flexShrink: 0, display: 'flex', flexDirection: 'column', borderRight: '1px solid var(--color-border-default)', minHeight: 0 }}>
          {list}
        </div>
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          {detail ?? overview ?? (
            <div className="empty-state" style={{ flex: 1 }}>
              <span style={{ fontSize: 13 }}>
                {runs.rows.length ? 'Select a run to inspect it.' : runs.list ? 'Nothing to show.' : loadFailed ? 'Could not load runs — see the error above.' : 'Loading…'}
              </span>
            </div>
          )}
        </div>
      </>
    );
  }

  const showStrip = runnerTab === 'all' && !needsNode && !runs.notSupported && tabs.length > 0 && !(narrow && selected);

  return (
    <div className="harness-root h-full flex flex-col overflow-hidden" style={{ background: 'var(--color-bg-root)' }}>
      <style>{HARNESS_TEXT_CSS}</style>
      {header}
      {banners}
      {!needsNode && !runs.notSupported && tabBar}
      {showStrip && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, padding: '10px 20px', borderBottom: '1px solid var(--color-border-default)' }}>
          {tabs.map((r) => (
            <RunnerCard key={r.id} runner={r} probe={probeOf(r.id)} statusLoading={status.loading} onOpen={() => switchTab(r.id)} />
          ))}
        </div>
      )}
      <div style={{ flex: 1, display: 'flex', flexDirection: narrow ? 'column' : 'row', overflow: 'hidden', minHeight: 0 }}>
        {body}
      </div>
    </div>
  );
}
