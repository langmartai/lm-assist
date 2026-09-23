'use client';

import type { CSSProperties, ReactNode } from 'react';
import { ArrowLeft, Check, ExternalLink, RefreshCw, X } from 'lucide-react';
import { timeAgo } from '@/components/memory/format';
import {
  canonicalTool,
  compactNumber,
  firstLine,
  formatDuration,
  isClaudeRunner,
  runnerLabel,
  statusBarSegments,
  statusMeta,
  successRateLabel,
  type AgentExecutionItem,
  type HarnessCapabilities,
  type HarnessProbe,
  type HarnessRunRow,
  type HarnessRunStatus,
  type HarnessRunnerSummary,
} from '@/lib/harness-runs';
import { StatusDot, statusText, tint } from './RunList';

/** undefined = /harness/status not loaded yet; null = the harness exposes no probe. */
type ProbeState = HarnessProbe | null | undefined;

function ProbeLine({ probe, loading }: { probe: ProbeState; loading?: boolean }) {
  if (probe === undefined) {
    return <span style={{ color: 'var(--color-text-tertiary)' }}>{loading ? 'probing…' : 'probe not loaded'}</span>;
  }
  if (probe === null) return <span style={{ color: 'var(--color-text-tertiary)' }}>not probeable</span>;
  if (probe.available) {
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, color: statusText('var(--color-status-green)') }} title={probe.binary}>
        <span className="status-dot online" /> available{probe.version ? ` · ${probe.version}` : ''}
      </span>
    );
  }
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, color: statusText('var(--color-status-red)') }}>
      <span className="status-dot error" /> {probe.reason || 'unavailable'}
    </span>
  );
}

function YesNo({ ok }: { ok: boolean }) {
  return ok ? <Check size={11} style={{ color: 'var(--color-status-green)' }} /> : <X size={11} style={{ color: 'var(--color-text-tertiary)' }} />;
}

function ProfileLine({ profile }: { profile: HarnessRunnerSummary['profile'] }) {
  if (!profile) {
    return (
      <span style={{ color: statusText('var(--color-status-orange)') }}>
        No provider profile — configure at the console with <code style={{ fontFamily: 'var(--font-mono)' }}>PUT /harness/provider/:name</code>
      </span>
    );
  }
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
      Profile &apos;{profile.name}&apos; · <span style={{ fontFamily: 'var(--font-mono)' }}>{profile.model}</span> · {profile.baseUrlHost} · key <YesNo ok={profile.hasKey} />
    </span>
  );
}

function CapBadge({ label, ok, title }: { label: string; ok: boolean; title?: string }) {
  return (
    <span
      className="badge"
      title={title}
      style={{
        fontSize: 10.5,
        ...(ok ? tint('var(--color-status-green)', 10) : { background: 'transparent', color: 'var(--color-text-tertiary)', border: '1px solid var(--color-border-default)' }),
      }}
    >
      {label} <YesNo ok={ok} />
    </span>
  );
}

export function CapabilityBadges({ caps, maxTurnsEnforced }: { caps: HarnessCapabilities; maxTurnsEnforced?: boolean | null }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, alignItems: 'center' }}>
      <span
        className="badge"
        style={{ fontSize: 10.5, ...(caps.cost === 'unavailable' ? tint('var(--color-status-orange)', 10) : tint('var(--color-status-green)', 10)) }}
        title={caps.cost === 'unavailable' ? '0 means unknown, not free' : `cost is ${caps.cost}`}
      >
        cost {caps.cost}
      </span>
      <CapBadge label="resume" ok={caps.sessionResume} />
      <CapBadge label="MCP" ok={caps.mcp} />
      <CapBadge label="abortable" ok={caps.abortable} />
      <CapBadge label="durable background" ok={caps.durableBackground} title="Survives a Core restart" />
      {maxTurnsEnforced != null && (
        <CapBadge
          label="max turns enforced"
          ok={maxTurnsEnforced}
          title={maxTurnsEnforced ? undefined : 'This harness has no turn limit — the timeout is the only bound'}
        />
      )}
      {maxTurnsEnforced === false && <span style={{ fontSize: 10.5, color: 'var(--color-text-tertiary)' }}>timeout is the only bound</span>}
    </div>
  );
}

function StatTile({ label, value, sub, color }: { label: string; value: ReactNode; sub?: ReactNode; color?: string }) {
  return (
    <div className={`stat-card${color ? ` ${color}` : ''}`} style={{ padding: '10px 12px', minWidth: 0 }}>
      <div className="stat-label" style={{ fontSize: 10 }}>{label}</div>
      {/* Wraps rather than ellipsizing: a three-part value like tokens in/out/reasoning must stay whole. */}
      <div className="stat-value" style={{ fontSize: 18, overflowWrap: 'anywhere', lineHeight: 1.25 }}>{value}</div>
      {sub && <div style={{ fontSize: 10.5, color: 'var(--color-text-tertiary)', marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

export function StatusBar({ byStatus, height = 8 }: { byStatus: Partial<Record<HarnessRunStatus, number>>; height?: number }) {
  const segs = statusBarSegments(byStatus);
  if (!segs.length) return null;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', height, borderRadius: height / 2, overflow: 'hidden', background: 'var(--color-bg-elevated)' }}>
        {segs.map((s) => (
          <div key={s.status} style={{ width: `${s.pct}%`, background: statusMeta(s.status).colorVar }} title={`${statusMeta(s.status).label}: ${s.count}`} />
        ))}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 12px', fontSize: 10.5, color: 'var(--color-text-secondary)' }}>
        {segs.map((s) => (
          <span key={s.status} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <StatusDot status={s.status} size={7} /> {statusMeta(s.status).label} <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--color-text-tertiary)' }}>{s.count}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

const cardTitle: CSSProperties = { fontSize: 11, fontWeight: 600, letterSpacing: 0.4, textTransform: 'uppercase', color: 'var(--color-text-tertiary)', marginBottom: 8 };
const listBtn: CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 6, width: '100%', textAlign: 'left', padding: '4px 0', background: 'none', border: 'none',
  cursor: 'pointer', fontSize: 11.5, color: 'var(--color-text-secondary)', minWidth: 0,
};

function CountList({ title, items, render }: { title: string; items: Array<{ key: string; count: number }>; render: (key: string) => ReactNode }) {
  const max = Math.max(1, ...items.map((i) => i.count));
  return (
    <div className="card" style={{ padding: 12 }}>
      <div style={cardTitle}>{title}</div>
      {items.length === 0 ? (
        <div style={{ fontSize: 11.5, color: 'var(--color-text-tertiary)' }}>none</div>
      ) : items.map((i) => (
        <div key={i.key} style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 60px 28px', gap: 8, alignItems: 'center', padding: '3px 0' }}>
          <div style={{ fontSize: 11.5, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{render(i.key)}</div>
          <div style={{ height: 4, borderRadius: 2, background: 'var(--color-bg-elevated)' }}>
            <div style={{ height: 4, borderRadius: 2, width: `${(i.count / max) * 100}%`, background: 'var(--color-accent)' }} />
          </div>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--color-text-tertiary)', textAlign: 'right' }}>{i.count}</span>
        </div>
      ))}
    </div>
  );
}

/**
 * The per-type view: readiness (probe + provider profile), capabilities, window stats,
 * a status bar, and the runner's top tools / models / profiles / failures / recent runs.
 */
export function RunnerOverview({
  runner,
  probe,
  statusLoading,
  recentRuns,
  onSelectRun,
  onBack,
}: {
  runner: HarnessRunnerSummary;
  probe: ProbeState;
  statusLoading: boolean;
  recentRuns: HarnessRunRow[];
  onSelectRun: (id: string) => void;
  onBack?: () => void;
}) {
  const s = runner.stats;
  const unreported = s ? Math.max(0, s.total - s.running - s.tokens.reportedRuns) : 0;
  return (
    // A grid, not a flex column: flex items shrink below their content inside a fixed-height
    // scroller (the Status card lost its legend at 900px tall); auto grid rows never do.
    <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '16px 20px 24px', display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', alignContent: 'start', gap: 14 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div className="flex flex-wrap items-center" style={{ gap: 10 }}>
          {onBack && (
            <button type="button" className="btn btn-sm btn-ghost" onClick={onBack}><ArrowLeft size={12} /> Back</button>
          )}
          <span style={{ fontSize: 16, fontWeight: 600, color: 'var(--color-text-primary)' }}>{runnerLabel(runner.id, runner.displayName)}</span>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--color-text-tertiary)' }}>{runner.id}</span>
          <span style={{ fontSize: 12 }}><ProbeLine probe={probe} loading={statusLoading} /></span>
        </div>
        <div style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}><ProfileLine profile={runner.profile} /></div>
        <CapabilityBadges caps={runner.capabilities} maxTurnsEnforced={runner.maxTurnsEnforced} />
        {runner.isolation && (
          <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>Isolation: {runner.isolation}</div>
        )}
      </div>

      {!s ? (
        <div className="empty-state" style={{ padding: 24 }}>
          <span style={{ fontSize: 12 }}>No statistics for this runner.</span>
        </div>
      ) : (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 8 }}>
            <StatTile label={`Runs (${s.windowDays}d)`} value={s.total} color="amber" sub={s.lastRunAt ? `last ${timeAgo(s.lastRunAt)}${s.lastStatus ? ` · ${statusMeta(s.lastStatus).label}` : ''}` : 'no runs'} />
            <StatTile label="Running now" value={s.running} color={s.running > 0 ? 'blue' : undefined} />
            <StatTile label="Success rate" value={successRateLabel(s)} color="green" sub="aborted, timed out and interrupted count as not successful" />
            <StatTile label="p50 / p95" value={`${formatDuration(s.p50DurationMs)} / ${formatDuration(s.p95DurationMs)}`} />
            <StatTile
              label="Tokens in / out / reasoning"
              value={`${compactNumber(s.tokens.input)} / ${compactNumber(s.tokens.output)} / ${compactNumber(s.tokens.reasoning)}`}
              sub={`${s.tokens.reportedRuns} run${s.tokens.reportedRuns === 1 ? '' : 's'} reported usage`}
            />
            <StatTile
              label="Tool calls"
              value={s.toolCalls}
              sub={s.toolErrors ? <span style={{ color: statusText('var(--color-status-red)') }}>{s.toolErrors} error{s.toolErrors === 1 ? '' : 's'}</span> : 'no errors'}
            />
          </div>
          <div style={{ fontSize: 10.5, color: 'var(--color-text-tertiary)', display: 'flex', flexDirection: 'column', gap: 2, marginTop: -6 }}>
            {runner.id === 'opencode' && <span>opencode output includes reasoning — the two are not added.</span>}
            {unreported > 0 && <span>{unreported} run{unreported === 1 ? '' : 's'} reported no usage; their tokens are unknown, not zero.</span>}
          </div>

          <div className="card" style={{ padding: 12 }}>
            <div style={cardTitle}>Status</div>
            {s.total ? <StatusBar byStatus={s.byStatus} /> : <div style={{ fontSize: 11.5, color: 'var(--color-text-tertiary)' }}>No runs in the window.</div>}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 10 }}>
            <CountList
              title="Top tools"
              items={s.topTools.map((t) => ({ key: t.name, count: t.count }))}
              render={(name) => {
                const canon = canonicalTool(name).name;
                return (
                  <>
                    <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--color-text-primary)' }}>{name}</span>
                    {canon !== name && <span style={{ color: 'var(--color-text-tertiary)' }}> · {canon}</span>}
                  </>
                );
              }}
            />
            <CountList
              title="Models"
              items={s.models.map((m) => ({ key: m.model, count: m.count }))}
              render={(m) => <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--color-text-primary)' }} title={m}>{m}</span>}
            />
            <CountList
              title="Profiles"
              items={s.profiles.map((p) => ({ key: p.name, count: p.count }))}
              render={(p) => <span style={{ color: 'var(--color-text-primary)' }}>{p}</span>}
            />
            <div className="card" style={{ padding: 12 }}>
              <div style={cardTitle}>Recent failures</div>
              {s.recentFailures.length === 0 ? (
                <div style={{ fontSize: 11.5, color: 'var(--color-text-tertiary)' }}>none</div>
              ) : s.recentFailures.map((f) => (
                <button key={f.id} type="button" style={listBtn} onClick={() => onSelectRun(f.id)} title={f.error}>
                  <StatusDot status={f.status} />
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--color-text-tertiary)', flexShrink: 0 }}>{timeAgo(f.at)}</span>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0, color: statusText('var(--color-status-red)') }}>{firstLine(f.error, 160) || statusMeta(f.status).label}</span>
                </button>
              ))}
            </div>
          </div>
        </>
      )}

      <div className="card" style={{ padding: 12 }}>
        <div style={cardTitle}>Recent runs</div>
        {recentRuns.length === 0 ? (
          <div style={{ fontSize: 11.5, color: 'var(--color-text-tertiary)' }}>No runs match the current filters.</div>
        ) : recentRuns.slice(0, 10).map((r) => (
          <button key={r.id} type="button" style={listBtn} onClick={() => onSelectRun(r.id)}>
            <StatusDot status={r.status} />
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--color-text-tertiary)', flexShrink: 0, width: 58 }}>{timeAgo(r.startedAt)}</span>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0, color: 'var(--color-text-primary)' }}>{firstLine(r.promptPreview, 160)}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/** Compact card per pluggable runner on the All tab; clicking it opens that runner's tab. */
export function RunnerCard({ runner, probe, statusLoading, onOpen }: { runner: HarnessRunnerSummary; probe: ProbeState; statusLoading: boolean; onOpen: () => void }) {
  const s = runner.stats;
  const rate = s?.successRate;
  return (
    <button
      type="button"
      className="card"
      onClick={onOpen}
      style={{ flex: '1 1 260px', minWidth: 0, maxWidth: 520, padding: '10px 12px', textAlign: 'left', cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 5 }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-text-primary)' }}>{runnerLabel(runner.id, runner.displayName)}</span>
        <span style={{ fontSize: 11 }}><ProbeLine probe={probe} loading={statusLoading} /></span>
        <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--color-text-tertiary)', fontFamily: 'var(--font-mono)', flexShrink: 0 }}>
          {s ? `${s.total} run${s.total === 1 ? '' : 's'}${s.running ? ` · ${s.running} live` : ''}` : '—'}
        </span>
      </div>
      <div style={{ fontSize: 11, color: 'var(--color-text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {runner.profile
          ? <>{runner.profile.name} · <span style={{ fontFamily: 'var(--font-mono)' }}>{runner.profile.model}</span> · {runner.profile.baseUrlHost} · key <YesNo ok={runner.profile.hasKey} /></>
          : <span style={{ color: statusText('var(--color-status-orange)') }}>no provider profile</span>}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: 'var(--color-text-tertiary)' }}>
        <div style={{ width: 64, height: 4, borderRadius: 2, background: 'var(--color-bg-elevated)', flexShrink: 0 }} title="success rate">
          {rate != null && <div style={{ height: 4, borderRadius: 2, width: `${Math.round(rate * 100)}%`, background: 'var(--color-status-green)' }} />}
        </div>
        <span>{successRateLabel(s)} ok</span>
        <span>· p50 {formatDuration(s?.p50DurationMs)}</span>
      </div>
      <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>
        {s?.lastRunAt ? <>last run {timeAgo(s.lastRunAt)}{s.lastStatus ? <> · <span style={{ color: statusText(statusMeta(s.lastStatus).colorVar) }}>{statusMeta(s.lastStatus).label}</span></> : null}</> : 'no runs in the window'}
      </div>
    </button>
  );
}

/**
 * The Claude runners tab. sdk/tmux are not recorded here: they run Claude Code itself, so
 * their transcripts are ordinary Claude Code sessions. What Core does know about them is
 * the in-memory background map behind /agent/executions.
 */
export function ClaudeRunnersOverview({
  runners,
  executions,
  loading,
  error,
  onRefresh,
  basePath,
}: {
  runners: Array<{ id: string; displayName: string; capabilities: HarnessCapabilities; note?: string }>;
  executions: AgentExecutionItem[] | null;
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
  basePath: string;
}) {
  const claudeRuns = (executions ?? []).filter((e) => isClaudeRunner(e.runner));
  const ts = (v: string | number | undefined) => (v == null ? NaN : typeof v === 'number' ? v : Date.parse(v));
  return (
    // A grid, not a flex column: flex items shrink below their content inside a fixed-height
    // scroller (the Status card lost its legend at 900px tall); auto grid rows never do.
    <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '16px 20px 24px', display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', alignContent: 'start', gap: 14 }}>
      <div style={{ fontSize: 12.5, color: 'var(--color-text-secondary)', lineHeight: 1.5 }}>
        sdk and tmux run Claude Code itself; their transcripts are ordinary Claude Code sessions.
        <div className="flex flex-wrap" style={{ gap: 6, marginTop: 8 }}>
          <a className="btn btn-sm btn-secondary" href={`${basePath}/sessions`}><ExternalLink size={12} /> Sessions</a>
          <a className="btn btn-sm btn-secondary" href={`${basePath}/process-dashboard`}><ExternalLink size={12} /> Process Dashboard</a>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 10 }}>
        {runners.map((r) => (
          <div key={r.id} className="card" style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div className="flex items-center" style={{ gap: 8 }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-text-primary)' }}>{runnerLabel(r.id, r.displayName)}</span>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--color-text-tertiary)' }}>{r.id}</span>
            </div>
            {r.note && <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>{r.note}</div>}
            <CapabilityBadges caps={r.capabilities} />
          </div>
        ))}
      </div>

      <div className="card" style={{ padding: 12 }}>
        <div className="flex items-center" style={{ gap: 8, marginBottom: 8 }}>
          <span style={{ ...cardTitle, marginBottom: 0 }}>Background executions</span>
          <span style={{ fontSize: 10.5, color: 'var(--color-text-tertiary)' }}>in memory; lost on a Core restart</span>
          <button type="button" className="btn btn-sm btn-ghost" style={{ marginLeft: 'auto' }} onClick={onRefresh} disabled={loading}>
            <RefreshCw size={12} className={loading ? 'animate-spin' : undefined} /> Refresh
          </button>
        </div>
        {error ? (
          <div style={{ fontSize: 11.5, color: statusText('var(--color-status-red)') }}>{error}</div>
        ) : executions === null ? (
          <div style={{ fontSize: 11.5, color: 'var(--color-text-tertiary)' }}>{loading ? 'Loading…' : 'Not loaded.'}</div>
        ) : claudeRuns.length === 0 ? (
          <div style={{ fontSize: 11.5, color: 'var(--color-text-tertiary)' }}>No Claude background executions since Core started.</div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11.5 }}>
              <thead>
                <tr style={{ color: 'var(--color-text-tertiary)', textAlign: 'left' }}>
                  <th style={{ padding: '4px 8px 4px 0', fontWeight: 500 }}>Execution</th>
                  <th style={{ padding: '4px 8px', fontWeight: 500 }}>Runner</th>
                  <th style={{ padding: '4px 8px', fontWeight: 500 }}>Status</th>
                  <th style={{ padding: '4px 8px', fontWeight: 500 }}>Started</th>
                  <th style={{ padding: '4px 0 4px 8px', fontWeight: 500 }} />
                </tr>
              </thead>
              <tbody>
                {claudeRuns.map((e) => {
                  const started = ts(e.startedAt);
                  const color = e.status === 'running' ? 'var(--color-status-blue)' : e.status === 'completed' ? 'var(--color-status-green)' : e.status === 'aborted' ? 'var(--color-status-yellow)' : 'var(--color-status-red)';
                  return (
                    <tr key={e.executionId} style={{ borderTop: '1px solid var(--color-border-subtle)' }}>
                      <td style={{ padding: '5px 8px 5px 0', fontFamily: 'var(--font-mono)', color: 'var(--color-text-primary)', wordBreak: 'break-all' }}>{e.executionId}</td>
                      <td style={{ padding: '5px 8px', color: 'var(--color-text-secondary)' }}>{runnerLabel(e.runner ?? 'sdk')}</td>
                      <td style={{ padding: '5px 8px' }}>
                        <span className="badge" style={{ fontSize: 10, ...tint(color) }}>{e.status}</span>
                      </td>
                      <td style={{ padding: '5px 8px', color: 'var(--color-text-tertiary)', whiteSpace: 'nowrap' }} title={Number.isFinite(started) ? new Date(started).toLocaleString() : undefined}>
                        {Number.isFinite(started) ? timeAgo(started) : '—'}
                      </td>
                      <td style={{ padding: '5px 0 5px 8px', textAlign: 'right' }}>
                        {e.sessionId && (
                          <a className="btn btn-sm btn-ghost" href={`${basePath}/sessions?session=${encodeURIComponent(e.sessionId)}`}>Open session</a>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
