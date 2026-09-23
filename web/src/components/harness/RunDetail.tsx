'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ArrowLeft, Check, Copy, RefreshCw } from 'lucide-react';
import { ConfirmButton, timeAgo } from '@/components/memory/format';
import { TranscriptMessage } from '@/components/shared/TranscriptMessage';
import { useFullEvent, useHarnessDebug, useHarnessRun, useNow } from '@/hooks/useHarnessRuns';
import {
  collectRunFiles,
  compactNumber,
  eventAt,
  eventsToMessages,
  firstLine,
  formatCost,
  formatDuration,
  formatElapsed,
  RUN_LIMITS,
  runnerLabel,
  transcriptNotice,
  type DetailTab,
  type HarnessEvent,
  type TextEvent,
  type UserEvent,
} from '@/lib/harness-runs';
import { CoreCwdChip, RunnerBadge, SkeletonRows, StatusBadge, statusText, tint } from './RunList';
import { RunTimeline } from './RunTimeline';

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="btn btn-sm btn-ghost"
      title={value}
      onClick={() => {
        try {
          void navigator.clipboard?.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch { /* clipboard blocked */ }
      }}
    >
      {copied ? <Check size={12} /> : <Copy size={12} />} {copied ? 'Copied' : label}
    </button>
  );
}

function Meta({ label, children, title, mono = true }: { label: string; children: ReactNode; title?: string; mono?: boolean }) {
  return (
    <div style={{ minWidth: 0 }} title={title}>
      <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: 0.4, textTransform: 'uppercase', color: 'var(--color-text-tertiary)' }}>{label}</div>
      <div
        style={{
          fontSize: 11.5, color: 'var(--color-text-primary)', fontFamily: mono ? 'var(--font-mono)' : undefined,
          overflow: 'hidden', textOverflow: 'ellipsis', wordBreak: 'break-all', marginTop: 2,
        }}
      >
        {children}
      </div>
    </div>
  );
}

function Tile({ label, value, sub, accent }: { label: string; value: ReactNode; sub?: ReactNode; accent?: string }) {
  return (
    <div className={`stat-card${accent ? ` ${accent}` : ''}`} style={{ padding: '10px 12px' }}>
      <div className="stat-label" style={{ fontSize: 10 }}>{label}</div>
      <div className="stat-value" style={{ fontSize: 16 }}>{value}</div>
      {sub && <div style={{ fontSize: 10.5, color: 'var(--color-text-tertiary)', marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

const dash = <span style={{ color: 'var(--color-text-tertiary)' }}>—</span>;
const boxStyle: CSSProperties = { padding: '8px 12px', borderRadius: 'var(--radius-sm)', fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-word' };

function lastFinalTextEvent(events: HarnessEvent[]): TextEvent | null {
  const texts = events.filter((e): e is TextEvent => e.kind === 'text');
  return [...texts].reverse().find((t) => t.final) ?? texts[texts.length - 1] ?? null;
}

/**
 * The only thing that must change every second while a run is live. Kept in its own
 * component so the tick re-renders this text, not the whole pane and every timeline row.
 */
function LiveElapsed({ since }: { since: number }) {
  const now = useNow(true);
  return <>{formatElapsed(now - since)}</>;
}

const cutNote: CSSProperties = { fontSize: 10.5, color: 'var(--color-text-tertiary)', marginTop: 3 };

/**
 * The right pane for one run: header with Abort, a meta grid, usage tiles, and the
 * Timeline / Chat / Prompt & Result / Files / Debug tabs.
 */
export function RunDetail({
  runId,
  tab,
  onTabChange,
  onNotFound,
  onBack,
  backLabel = 'Back',
  onRunChanged,
  runnerNames,
}: {
  runId: string;
  tab: DetailTab;
  onTabChange: (t: DetailTab) => void;
  onNotFound: (id: string) => void;
  onBack?: () => void;
  backLabel?: string;
  /** Called after an abort so the list re-reads without waiting for its poll. */
  onRunChanged?: () => void;
  /** runner id → display name, from /harness/runners (the run record carries only the id). */
  runnerNames?: Record<string, string>;
}) {
  const h = useHarnessRun(runId);
  const { detail, transcript } = h;
  const run = detail?.run;
  const status = detail?.status ?? run?.status ?? 'unknown';
  const live = !!detail?.live;
  // The timeline's bar scale grows with the run, but a coarse clock is plenty for it: the
  // 1 s elapsed text lives in LiveElapsed and re-renders on its own.
  const spanNow = useNow(live, 15_000);
  const isQwen = run?.runner === 'qwen';
  const debug = useHarnessDebug(runId, tab === 'debug' && isQwen);
  const [abortMsg, setAbortMsg] = useState<string | null>(null);

  useEffect(() => { setAbortMsg(null); }, [runId]);
  useEffect(() => { if (h.notFound) onNotFound(runId); }, [h.notFound, runId, onNotFound]);
  // Debug exists only for qwen; a deep link to it on another runner lands on the timeline.
  useEffect(() => { if (run && !isQwen && tab === 'debug') onTabChange('timeline'); }, [run, isQwen, tab, onTabChange]);

  // "Following": keep the newest event in view while live, until the user scrolls up.
  const bodyRef = useRef<HTMLDivElement>(null);
  const [following, setFollowing] = useState(true);
  const events = useMemo(() => transcript?.events ?? [], [transcript]);
  useEffect(() => {
    if (!live || !following || tab !== 'timeline') return;
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [events, live, following, tab]);
  const onScroll = useCallback(() => {
    const el = bodyRef.current;
    if (!el || !live) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    setFollowing(atBottom);
  }, [live]);
  const onToggleFollow = useCallback(() => {
    setFollowing((was) => {
      const next = !was;
      if (next && bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
      return next;
    });
  }, []);

  const runnerName = runnerLabel(run?.runner, run ? runnerNames?.[run.runner] : undefined);
  const messages = useMemo(() => eventsToMessages(events), [events]);
  const files = useMemo(
    () => collectRunFiles([...(transcript?.filesTouched ?? []), ...(run?.filesTouched ?? [])], events, run?.cwd),
    [transcript?.filesTouched, run?.filesTouched, run?.cwd, events],
  );
  const notice = transcriptNotice(transcript, run?.runner ?? '');

  // Prompt & Result shows the FULL prompt and answer: an event cut at the page's 4,000-char
  // field cap is re-read on its own at the route's 65,536 cap while that tab is open.
  const firstUser = events.find((e): e is UserEvent => e.kind === 'user');
  const finalEv = lastFinalTextEvent(events);
  const fullUser = useFullEvent(runId, transcript, tab === 'prompt' ? firstUser : null);
  const fullFinal = useFullEvent(runId, transcript, tab === 'prompt' ? finalEv : null);

  if (h.loading && !detail) {
    return <div style={{ padding: 20 }}><SkeletonRows count={8} /></div>;
  }
  if (!run) {
    return (
      <div className="empty-state" style={{ flex: 1 }}>
        {h.error ? <span style={{ color: 'var(--color-status-red)', fontSize: 12 }}>{h.error}</span> : <span style={{ fontSize: 12 }}>Loading run…</span>}
        {h.error && <button type="button" className="btn btn-sm btn-secondary" onClick={h.refresh}>Retry</button>}
      </div>
    );
  }

  const u = run.usage;
  const reported = !!u?.reported;
  const duration = live
    ? <LiveElapsed since={run.startedAt} />
    : formatDuration(run.durationMs ?? (run.endedAt != null ? run.endedAt - run.startedAt : undefined));
  // Bars are proportional to the run: its duration, the elapsed time while live (on a 15 s
  // clock), or the last event when a backfilled record has no end time.
  const lastEventOffset = events.reduce((m, e) => Math.max(m, (eventAt(e) ?? run.startedAt) - run.startedAt), 0);
  const spanMs = Math.max(1, live ? spanNow - run.startedAt : run.durationMs ?? (run.endedAt != null ? run.endedAt - run.startedAt : 0), lastEventOffset);
  const shownUser = (fullUser?.kind === 'user' ? fullUser : null) ?? firstUser ?? null;
  const shownFinal = (fullFinal?.kind === 'text' ? fullFinal : null) ?? finalEv;
  const finalText = shownFinal?.text ?? run.resultPreview ?? null;
  const moreEvents = transcript && transcript.total > events.length ? transcript.total - events.length : 0;
  const isOpencode = run.runner === 'opencode';

  const tabs: Array<{ id: DetailTab; label: string; count?: number }> = [
    { id: 'timeline', label: 'Timeline', count: transcript?.total },
    { id: 'chat', label: 'Chat' },
    { id: 'prompt', label: 'Prompt & Result' },
    { id: 'files', label: 'Files', count: files.length },
    ...(isQwen ? [{ id: 'debug' as const, label: 'Debug' }] : []),
  ];

  const doAbort = async () => {
    setAbortMsg(null);
    const err = await h.abort();
    if (err) setAbortMsg(err);
    onRunChanged?.();
  };

  return (
    <div ref={bodyRef} onScroll={onScroll} style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
      {/* Header */}
      <div style={{ padding: '14px 20px 10px', borderBottom: '1px solid var(--color-border-default)', display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div className="flex flex-wrap items-center" style={{ gap: 8 }}>
          {onBack && (
            <button type="button" className="btn btn-sm btn-ghost" onClick={onBack}>
              <ArrowLeft size={12} /> {backLabel}
            </button>
          )}
          <StatusBadge status={status}>
            {live && <span style={{ fontFamily: 'var(--font-mono)', marginLeft: 2 }}><LiveElapsed since={run.startedAt} /></span>}
          </StatusBadge>
          <RunnerBadge runner={run.runner} displayName={runnerName} />
          {run.origin === 'backfill' && <span className="badge badge-outline" style={{ fontSize: 9.5 }}>legacy</span>}
          <div className="flex flex-wrap items-center" style={{ gap: 4, marginLeft: 'auto' }}>
            {detail.abortable && (
              <ConfirmButton
                label="Abort"
                confirmLabel="Abort this run?"
                onConfirm={doAbort}
                className="btn btn-sm btn-destructive"
              />
            )}
            <CopyButton value={run.id} label="Run id" />
            {run.sessionId && <CopyButton value={run.sessionId} label="Session id" />}
            <button type="button" className="btn btn-sm btn-ghost" onClick={h.refresh} title="Re-read this run">
              <RefreshCw size={12} className={h.transcriptLoading ? 'animate-spin' : undefined} />
            </button>
          </div>
        </div>
        <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--color-text-primary)', wordBreak: 'break-word' }} title={run.promptPreview}>
          {firstLine(run.promptPreview, 240) || <span style={{ color: 'var(--color-text-tertiary)' }}>(no prompt recorded)</span>}
        </div>
        {abortMsg && <div style={{ ...boxStyle, ...tint('var(--color-status-red)', 8) }}>Abort failed: {abortMsg}</div>}
        {h.error && <div style={{ ...boxStyle, ...tint('var(--color-status-red)', 8) }}>Refresh failed (showing the last read): {h.error}</div>}
      </div>

      <div style={{ padding: '12px 20px', display: 'flex', flexDirection: 'column', gap: 12 }}>
        {/* Meta grid */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '10px 16px' }}>
          <Meta label="Run id">{run.id}</Meta>
          <Meta label="Session id" title={isOpencode && run.sessionId ? "Stored in OpenCode's local DB" : undefined}>
            {run.sessionId ?? dash}
            {isOpencode && run.sessionId && <div style={{ fontSize: 10, color: 'var(--color-text-tertiary)', fontFamily: 'var(--font-sans)' }}>stored in OpenCode&apos;s local DB</div>}
          </Meta>
          <Meta label="Started" title={new Date(run.startedAt).toISOString()}>
            {new Date(run.startedAt).toLocaleString()} <span style={{ color: 'var(--color-text-tertiary)' }}>{timeAgo(run.startedAt)}</span>
          </Meta>
          <Meta label="Ended">{run.endedAt ? new Date(run.endedAt).toLocaleString() : live ? 'running' : dash}</Meta>
          <Meta label="Duration">{duration}</Meta>
          <Meta label="Model">{run.model ?? transcript?.model ?? dash}</Meta>
          <Meta label="Profile @ host">
            {run.providerProfile ?? dash}{run.baseUrlHost ? <span style={{ color: 'var(--color-text-tertiary)' }}> @ {run.baseUrlHost}</span> : null}
          </Meta>
          <Meta label="CWD" title={run.cwd ?? undefined}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>{run.cwd ?? dash}{run.cwdDefaulted && <CoreCwdChip />}</span>
          </Meta>
          <Meta label="Mode">{run.background == null ? dash : run.background ? 'background' : 'foreground'}</Meta>
          <Meta label="Timeout">{run.timeoutMs != null ? formatDuration(run.timeoutMs) : dash}</Meta>
          <Meta label="Max turns" title={run.maxTurnsEnforced === false ? 'This harness has no turn limit: the timeout is the only bound' : undefined}>
            {run.maxTurns ?? dash}
            {run.maxTurnsEnforced === false && <span style={{ color: statusText('var(--color-status-orange)') }}> (not enforced)</span>}
          </Meta>
          <Meta label="PID">{run.pid ?? dash}</Meta>
          <Meta label="Termination · exit · signal">
            {run.termination ?? '—'} · {run.exitCode ?? '—'} · {run.signal ?? '—'}
          </Meta>
          <Meta label="CLI version">{run.cliVersion ?? transcript?.cliVersion ?? dash}</Meta>
          <Meta label="Core">{run.core}{run.corePid ? <span style={{ color: 'var(--color-text-tertiary)' }}> · pid {run.corePid}</span> : null}</Meta>
          <Meta
            label="Origin"
            mono={false}
            title={run.origin === 'backfill'
              ? (isOpencode
                ? "Backfilled from OpenCode's DB: sessions whose provider id is 'lmharness' (the id the harness writes). An operator provider with the same name would match too."
                : 'Backfilled from a legacy qwen run directory; status and timings are inferred from its logs.')
              : 'Recorded by lm-assist while the run happened'}
          >
            {run.origin === 'backfill' ? 'legacy · inferred' : run.inferred ? 'recorded · inferred' : 'recorded'}
          </Meta>
        </div>

        {/* Usage */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(118px, 1fr))', gap: 8 }}>
          <Tile label="Turns" value={run.numTurns ?? '—'} />
          <Tile label="Tool calls" value={run.toolCalls ?? '—'} sub={run.toolErrors ? <span style={{ color: statusText('var(--color-status-red)') }}>{run.toolErrors} error{run.toolErrors === 1 ? '' : 's'}</span> : undefined} />
          <Tile label="Input" value={reported ? compactNumber(u!.inputTokens) : '—'} />
          <Tile label="Output" value={reported ? compactNumber(u!.outputTokens) : '—'} sub={reported && isOpencode ? 'includes reasoning' : undefined} />
          <Tile label="Reasoning" value={reported && u!.reasoningTokens != null ? compactNumber(u!.reasoningTokens) : '—'} />
          <Tile label="Cache r / w" value={reported ? `${compactNumber(u!.cacheReadTokens)} / ${compactNumber(u!.cacheWriteTokens)}` : '—'} />
          <Tile
            label="Cost"
            value={<span className="badge badge-outline" style={{ fontSize: 10.5 }} title="This harness cannot report cost: 0 means unknown, not free">{formatCost(run.costUsd)}</span>}
          />
        </div>
        {!reported && (run.status !== 'running') && (
          <div style={{ fontSize: 10.5, color: 'var(--color-text-tertiary)', marginTop: -6 }}>This run reported no usage — the dashes are unknown values, not zeros.</div>
        )}

        {run.error && (
          <div style={{ ...boxStyle, ...tint('var(--color-status-red)', 8), fontFamily: 'var(--font-mono)', fontSize: 11.5 }}>{run.error}</div>
        )}
        {status === 'interrupted' && (
          <div style={{ ...boxStyle, ...tint('var(--color-status-purple)', 8) }}>
            Core restarted while this run was in flight; child pid {run.pid ?? '?'} alive:{' '}
            {detail.childAlive === true ? 'yes' : detail.childAlive === false ? 'no' : 'unknown'}. lm-assist no longer tracks it.
          </div>
        )}
      </div>

      {/* Tabs — real buttons, so each is reachable and operable from the keyboard */}
      <div className="tab-bar" role="tablist" aria-label="Run detail" style={{ position: 'sticky', top: 0, background: 'var(--color-bg-root)', zIndex: 1, padding: '0 12px' }}>
        {tabs.map((t) => (
          <button type="button" key={t.id} className={`tab-item${tab === t.id ? ' active' : ''}`} onClick={() => onTabChange(t.id)} role="tab" aria-selected={tab === t.id}>
            {t.label}
            {t.count != null && t.count > 0 && <span className="tab-badge">{t.count}</span>}
          </button>
        ))}
      </div>

      <div style={{ padding: '12px 20px 24px' }}>
        {tab === 'timeline' && (
          <RunTimeline
            events={events}
            startedAt={run.startedAt}
            spanMs={spanMs}
            sources={transcript?.sources ?? detail.sources}
            source={h.source}
            servedSource={transcript?.source ?? null}
            onSourceChange={h.setSource}
            total={transcript?.total ?? 0}
            nextOffset={transcript?.nextOffset ?? null}
            onLoadMore={h.loadMore}
            loadingMore={h.loadingMore}
            live={live}
            following={following}
            onToggleFollow={onToggleFollow}
            notice={notice}
            loading={h.transcriptLoading}
            error={h.transcriptError}
            warnings={transcript?.warnings ?? []}
            cliVersion={run.cliVersion ?? transcript?.cliVersion}
          />
        )}

        {tab === 'chat' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 860 }}>
            {notice && <div style={{ fontSize: 11.5, color: 'var(--color-text-secondary)' }}>{notice.text}</div>}
            {messages.length === 0 ? (
              h.transcriptLoading ? <SkeletonRows count={4} /> : <div style={{ fontSize: 12, color: 'var(--color-text-tertiary)' }}>No conversation to show.</div>
            ) : (
              messages.map((m, i) => <TranscriptMessage key={i} m={m} compact assistantLabel={runnerName} />)
            )}
            {moreEvents > 0 && (
              <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>
                {moreEvents} more event{moreEvents === 1 ? '' : 's'} not loaded — use Load more on the Timeline tab.
              </div>
            )}
          </div>
        )}

        {tab === 'prompt' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 900 }}>
            <div>
              <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-text-secondary)', marginBottom: 4 }}>
                Prompt <span style={{ fontWeight: 400, color: 'var(--color-text-tertiary)' }}>· {run.promptChars.toLocaleString()} chars</span>
              </div>
              <pre style={{ ...boxStyle, margin: 0, fontFamily: 'var(--font-mono)', fontSize: 11.5, background: 'var(--color-bg-elevated)', border: '1px solid var(--color-border-default)', color: 'var(--color-text-primary)', maxHeight: 420, overflow: 'auto' }}>
                {shownUser?.text ?? run.promptPreview}
              </pre>
              {!shownUser && run.promptChars > run.promptPreview.length && (
                <div style={cutNote}>Showing the stored preview; the transcript carries no prompt event.</div>
              )}
              {/* Two different cuts, each named for what it is: the recorder's prompt.txt keeps
                  the first 64 K chars; the page cuts every field at 4,000 until the full one lands. */}
              {shownUser && run.promptChars > RUN_LIMITS.promptFileChars && transcript?.source === 'captured' ? (
                <div style={cutNote}>The run directory keeps the first {RUN_LIMITS.promptFileChars.toLocaleString()} chars of the prompt.</div>
              ) : shownUser?.truncated ? (
                <div style={cutNote}>Showing the first {shownUser.text.length.toLocaleString()} of {run.promptChars.toLocaleString()} chars.</div>
              ) : null}
            </div>
            <div>
              <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-text-secondary)', marginBottom: 4 }}>Result</div>
              {finalText ? (
                <>
                  <div className="prose" style={{ fontSize: 12.5, lineHeight: 1.55 }}>
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{finalText}</ReactMarkdown>
                  </div>
                  {shownFinal?.truncated && (
                    <div style={cutNote}>Showing the first {shownFinal.text.length.toLocaleString()} chars of the answer — the rest is in the {transcript?.source === 'captured' ? 'captured stream' : 'native transcript'}.</div>
                  )}
                </>
              ) : (
                <div style={{ fontSize: 12, color: 'var(--color-text-tertiary)' }}>{live ? 'No result yet.' : 'No result text was produced.'}</div>
              )}
            </div>
          </div>
        )}

        {tab === 'files' && (
          files.length === 0 ? (
            <div style={{ fontSize: 12, color: 'var(--color-text-tertiary)' }}>No file paths were recorded for this run.</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', border: '1px solid var(--color-border-default)', borderRadius: 'var(--radius-md)', overflow: 'hidden' }}>
              {files.map((f) => (
                <div key={f.path} className="flex flex-wrap items-center" style={{ gap: 6, padding: '6px 10px', borderBottom: '1px solid var(--color-border-subtle)' }}>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5, color: 'var(--color-text-primary)', wordBreak: 'break-all', flex: '1 1 260px', minWidth: 0 }}>{f.path}</span>
                  {f.ops.map((op) => (
                    <span key={op} className="badge badge-outline" style={{ fontSize: 9.5 }}>{op}</span>
                  ))}
                  {f.outsideCwd && (
                    <span className="badge" style={{ fontSize: 9.5, ...tint('var(--color-status-orange)') }} title={`Outside the run's cwd (${run.cwd})`}>outside cwd</span>
                  )}
                </div>
              ))}
            </div>
          )
        )}

        {tab === 'debug' && isQwen && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div className="flex items-center" style={{ gap: 8 }}>
              <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>
                Tail of qwen&apos;s own debug log (redacted){debug.tail ? ` · ${debug.tail.lines.length} of ${debug.tail.totalLines} lines` : ''}
              </span>
              <button type="button" className="btn btn-sm btn-ghost" style={{ marginLeft: 'auto' }} onClick={debug.refresh} disabled={debug.loading}>
                <RefreshCw size={12} className={debug.loading ? 'animate-spin' : undefined} /> Reload
              </button>
            </div>
            {debug.error ? (
              <div style={{ ...boxStyle, ...tint('var(--color-status-red)', 8) }}>{debug.error}</div>
            ) : debug.loading && !debug.tail ? (
              <SkeletonRows count={4} />
            ) : debug.tail && !debug.tail.available ? (
              <div style={{ fontSize: 12, color: 'var(--color-text-tertiary)' }}>No debug log: {debug.tail.reason ?? 'unavailable'}</div>
            ) : debug.tail ? (
              <pre style={{ ...boxStyle, margin: 0, fontFamily: 'var(--font-mono)', fontSize: 11, background: 'var(--color-bg-elevated)', border: '1px solid var(--color-border-default)', color: 'var(--color-text-secondary)', maxHeight: 560, overflow: 'auto', whiteSpace: 'pre' }}>
                {debug.tail.truncated ? '… (earlier lines not shown)\n' : ''}{debug.tail.lines.join('\n')}
              </pre>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}
