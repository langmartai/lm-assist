'use client';

import { memo, useMemo, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import {
  AlertTriangle, ChevronDown, ChevronRight, CornerDownRight, FileText, Globe, Info, MessageSquare,
  Search, Sparkles, Terminal, User, Wrench,
} from 'lucide-react';
import {
  TIMELINE_FILTERS,
  barGeometry,
  canonicalTool,
  diffLines,
  eventAt,
  eventDurationMs,
  eventMatchesFilters,
  firstLine,
  formatDuration,
  lifecycleLabel,
  nativeReasonText,
  offsetLabel,
  toolSummaryLabel,
  turnLabel,
  type HarnessEvent,
  type TimelineFilter,
  type ToolEvent,
  type TranscriptNotice,
  type TranscriptSource,
  type TranscriptSources,
} from '@/lib/harness-runs';
import type { TranscriptChoice } from '@/hooks/useHarnessRuns';
import { SkeletonRows, statusText, tint } from './RunList';

const FILTER_LABEL: Record<TimelineFilter, string> = {
  tools: 'Tools', reasoning: 'Reasoning', text: 'Text', errors: 'Errors', turns: 'Turns',
};

const SOURCE_LABEL: Record<TranscriptSource, string> = {
  captured: 'captured stream', 'qwen-chat': 'qwen chat log', 'opencode-db': 'OpenCode DB', none: 'nothing readable',
};

const TOOL_STATUS_COLOR: Record<ToolEvent['status'], string> = {
  completed: 'var(--color-status-green)',
  error: 'var(--color-status-red)',
  pending: 'var(--color-status-blue)',
  running: 'var(--color-status-blue)',
  unknown: 'var(--color-text-tertiary)',
};

const preStyle: CSSProperties = {
  margin: 0, padding: '6px 8px', fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--color-text-secondary)',
  whiteSpace: 'pre-wrap', wordBreak: 'break-word', overflow: 'auto',
  background: 'var(--color-bg-root)', border: '1px solid var(--color-border-subtle)', borderRadius: 'var(--radius-sm)',
};
const sectionLabel: CSSProperties = {
  fontSize: 9.5, fontWeight: 700, letterSpacing: 0.5, color: 'var(--color-text-tertiary)', textTransform: 'uppercase', margin: '6px 0 3px',
};

function toolIcon(canonical: string) {
  if (/^(Read|Write|Edit|MultiEdit|LS)$/.test(canonical)) return FileText;
  if (canonical === 'Bash') return Terminal;
  if (/^(Grep|Glob|WebSearch)$/.test(canonical)) return Search;
  if (canonical === 'WebFetch') return Globe;
  return Wrench;
}

function kindIcon(ev: HarnessEvent) {
  switch (ev.kind) {
    case 'tool': return toolIcon(canonicalTool(ev.name, ev.input).name);
    case 'reasoning': return Sparkles;
    case 'text': return MessageSquare;
    case 'user': return User;
    case 'turn': return CornerDownRight;
    case 'api_error': return AlertTriangle;
    default: return Info;
  }
}

function Bar({ ev, startedAt, spanMs, color }: { ev: HarnessEvent; startedAt: number; spanMs: number; color: string }) {
  const g = barGeometry(ev, startedAt, spanMs);
  const dur = eventDurationMs(ev);
  return (
    <div
      style={{ position: 'relative', height: 4, borderRadius: 2, background: 'var(--color-bg-elevated)', alignSelf: 'center' }}
      title={dur != null ? formatDuration(dur) : undefined}
    >
      {g && (
        <div style={{ position: 'absolute', top: 0, bottom: 0, left: `${g.left}%`, width: `${g.width}%`, minWidth: 2, borderRadius: 2, background: color }} />
      )}
    </div>
  );
}

const GREEN_TEXT = statusText('var(--color-status-green)');
const RED_TEXT = statusText('var(--color-status-red)');

/** Marks a field the server cut at the page's 4,000-char cap. */
function CutMark() {
  return (
    <span
      style={{ color: 'var(--color-text-tertiary)', fontStyle: 'normal', fontSize: 10.5 }}
      title="The server cut this field at 4,000 chars for the timeline. Prompt & Result loads the full prompt and answer; the source holds the rest."
    >
      {' '}· truncated
    </span>
  );
}

function DiffView({ patch }: { patch: string }) {
  return (
    <pre style={{ ...preStyle, maxHeight: 320, padding: 0 }}>
      {diffLines(patch).map((l, i) => (
        <div
          key={i}
          style={{
            padding: '0 8px',
            // Text through statusText: the raw status tokens are ~1.6:1 on the light theme.
            color: l.kind === 'add' ? GREEN_TEXT
              : l.kind === 'del' ? RED_TEXT
              : l.kind === 'hunk' ? statusText('var(--color-status-cyan)')
              : l.kind === 'meta' ? 'var(--color-text-tertiary)'
              : 'var(--color-text-secondary)',
            background: l.kind === 'add' ? 'color-mix(in srgb, var(--color-status-green) 8%, transparent)'
              : l.kind === 'del' ? 'color-mix(in srgb, var(--color-status-red) 8%, transparent)'
              : undefined,
          }}
        >
          {l.text || ' '}
        </div>
      ))}
    </pre>
  );
}

function ToolDetail({ ev }: { ev: ToolEvent }) {
  const input = ev.input === undefined ? null : JSON.stringify(ev.input, null, 2);
  const body = ev.error ?? ev.output;
  return (
    <div style={{ padding: '2px 0 8px' }}>
      {ev.title && <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>{ev.title}</div>}
      {input && input !== '{}' && (
        <>
          <div style={sectionLabel}>Input</div>
          <pre style={{ ...preStyle, maxHeight: 240 }}>{input}</pre>
        </>
      )}
      {body != null && body !== '' && (
        <>
          <div style={{ ...sectionLabel, color: ev.error ? RED_TEXT : sectionLabel.color }}>{ev.error ? 'Error' : 'Output'}</div>
          <pre style={{ ...preStyle, maxHeight: 320, color: ev.error ? RED_TEXT : preStyle.color }}>{body}</pre>
        </>
      )}
      {ev.error && ev.output && (
        <>
          <div style={sectionLabel}>Output</div>
          <pre style={{ ...preStyle, maxHeight: 320 }}>{ev.output}</pre>
        </>
      )}
      {ev.diff?.patch && (
        <>
          <div style={sectionLabel}>
            Diff{ev.diff.file ? ` · ${ev.diff.file}` : ''}
            {(ev.diff.added != null || ev.diff.removed != null) && (
              <span style={{ fontFamily: 'var(--font-mono)', marginLeft: 6, textTransform: 'none' }}>
                <span style={{ color: GREEN_TEXT }}>+{ev.diff.added ?? 0}</span>{' '}
                <span style={{ color: RED_TEXT }}>-{ev.diff.removed ?? 0}</span>
              </span>
            )}
          </div>
          <DiffView patch={ev.diff.patch} />
        </>
      )}
      {ev.truncated && (
        <div style={{ fontSize: 10.5, color: statusText('var(--color-status-orange)'), marginTop: 4 }}>truncated by server — raise maxField or read the source directly</div>
      )}
      {!input && body == null && !ev.diff && (
        <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>The source recorded no input or output for this call.</div>
      )}
    </div>
  );
}

const GRID: CSSProperties = {
  display: 'grid', gridTemplateColumns: '66px 16px minmax(0, 1fr) minmax(48px, 110px)', columnGap: 8, alignItems: 'start',
};

/**
 * One timeline row. Memoized: a live run re-renders its pane on every poll, and with up to
 * a thousand rows each recomputing its label and bar that blocked the main thread. A row
 * re-renders only when its event object (mergeTranscript keeps unchanged ones by identity)
 * or the coarse bar scale changes.
 */
const EventRow = memo(function EventRow({ ev, startedAt, spanMs }: { ev: HarnessEvent; startedAt: number; spanMs: number }) {
  const [open, setOpen] = useState(false);
  const Icon = kindIcon(ev);
  const off = offsetLabel(eventAt(ev), startedAt);

  if (ev.kind === 'turn') {
    return (
      <div style={{ ...GRID, padding: '3px 0' }}>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--color-text-tertiary)' }}>{off}</span>
        <Icon size={11} style={{ color: 'var(--color-text-tertiary)', marginTop: 1 }} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          <span style={{ fontSize: 10.5, color: 'var(--color-text-tertiary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{turnLabel(ev)}</span>
          <span style={{ flex: 1, borderTop: '1px dashed var(--color-border-default)', minWidth: 16 }} />
        </div>
        <Bar ev={ev} startedAt={startedAt} spanMs={spanMs} color="var(--color-status-blue)" />
      </div>
    );
  }

  if (ev.kind === 'lifecycle') {
    return (
      <div style={{ ...GRID, padding: '3px 0', opacity: 0.8 }}>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--color-text-tertiary)' }}>{off}</span>
        <Icon size={11} style={{ color: 'var(--color-text-tertiary)', marginTop: 1 }} />
        <span style={{ fontSize: 10.5, color: 'var(--color-text-tertiary)', fontStyle: 'italic' }}>{lifecycleLabel(ev)}</span>
        <span />
      </div>
    );
  }

  if (ev.kind === 'api_error') {
    const head = [ev.statusCode, ev.errorType].filter((x) => x !== undefined && x !== '').join(' · ');
    return (
      <div style={{ ...GRID, padding: '5px 0' }}>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, color: RED_TEXT }}>{off}</span>
        <Icon size={13} style={{ color: 'var(--color-status-red)' }} />
        <div style={{ fontSize: 12, color: RED_TEXT, minWidth: 0, wordBreak: 'break-word' }}>
          <b>API error{head ? ` ${head}` : ''}</b> — {ev.message}
          {ev.retryable && <span className="badge" style={{ fontSize: 9, marginLeft: 6, padding: '0 5px', ...tint('var(--color-status-orange)') }}>retryable</span>}
        </div>
        <Bar ev={ev} startedAt={startedAt} spanMs={spanMs} color="var(--color-status-red)" />
      </div>
    );
  }

  let label: ReactNode;
  let expandable = false;
  let barColor = 'var(--color-accent)';
  let body: ReactNode = null;
  let color = 'var(--color-text-secondary)';

  if (ev.kind === 'tool') {
    expandable = true;
    const isErr = ev.status === 'error';
    barColor = isErr ? 'var(--color-status-red)' : 'var(--color-accent)';
    color = isErr ? RED_TEXT : 'var(--color-text-primary)';
    label = (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0, maxWidth: '100%', flexWrap: 'wrap' }}>
        <span style={{ fontWeight: 500 }}>{toolSummaryLabel(ev)}</span>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--color-text-tertiary)' }}>{ev.name}</span>
        <span className="badge" style={{ fontSize: 9, padding: '0 5px', ...tint(TOOL_STATUS_COLOR[ev.status] ?? TOOL_STATUS_COLOR.unknown) }} title={ev.nativeStatus ? `native status: ${ev.nativeStatus}` : undefined}>
          {ev.status}
        </span>
      </span>
    );
    body = open ? <ToolDetail ev={ev} /> : null;
  } else if (ev.kind === 'reasoning') {
    expandable = true;
    barColor = 'var(--color-status-purple)';
    color = 'var(--color-text-tertiary)';
    label = (
      <span style={{ fontStyle: 'italic' }}>
        Reasoning{!open && ev.text ? <> — {firstLine(ev.text, 120)}</> : null}
        {ev.truncated && <CutMark />}
      </span>
    );
    body = open ? <div style={{ fontSize: 12, fontStyle: 'italic', color: 'var(--color-text-tertiary)', whiteSpace: 'pre-wrap', wordBreak: 'break-word', padding: '2px 0 6px' }}>{ev.text}</div> : null;
  } else {
    // text / user
    expandable = ev.text.length > 180 || ev.text.includes('\n');
    color = ev.kind === 'user' ? 'var(--color-text-secondary)' : 'var(--color-text-primary)';
    const head = ev.kind === 'user' ? 'Prompt' : ev.final ? 'Final answer' : null;
    label = (
      <span style={{ whiteSpace: open ? 'pre-wrap' : undefined, wordBreak: 'break-word' }}>
        {head && <b style={{ marginRight: 6, color: ev.kind === 'text' && ev.final ? GREEN_TEXT : undefined }}>{head}</b>}
        {open ? ev.text : firstLine(ev.text, 180)}
        {ev.truncated && <CutMark />}
      </span>
    );
  }

  const toggle = () => setOpen((o) => !o);
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      toggle();
    }
  };
  return (
    <div style={{ padding: '4px 0', borderBottom: '1px solid var(--color-border-subtle)' }}>
      {/* A div (it holds grid cells a <button> may not), made a keyboard-operable button when it expands. */}
      <div
        style={{ ...GRID, cursor: expandable ? 'pointer' : 'default' }}
        role={expandable ? 'button' : undefined}
        tabIndex={expandable ? 0 : undefined}
        aria-expanded={expandable ? open : undefined}
        onClick={expandable ? toggle : undefined}
        onKeyDown={expandable ? onKey : undefined}
      >
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--color-text-tertiary)', paddingTop: 1 }}>{off}</span>
        <Icon size={13} style={{ color: ev.kind === 'tool' && ev.status === 'error' ? 'var(--color-status-red)' : 'var(--color-accent)', marginTop: 1 }} />
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 4, fontSize: 12, color, minWidth: 0 }}>
          {expandable && (open ? <ChevronDown size={12} style={{ flexShrink: 0, marginTop: 2 }} /> : <ChevronRight size={12} style={{ flexShrink: 0, marginTop: 2 }} />)}
          <div style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</div>
        </div>
        <Bar ev={ev} startedAt={startedAt} spanMs={spanMs} color={barColor} />
      </div>
      {/* Indented to the label column: offset (66) + icon (16) + two 8px column gaps. */}
      {body && <div style={{ paddingLeft: 98, minWidth: 0 }}>{body}</div>}
    </div>
  );
});

/**
 * The Timeline tab: every normalized event with its offset from run start, a kind icon,
 * a label and a duration bar proportional to the run. Tool rows expand to input, output
 * and diff; reasoning starts collapsed; turns are thin separators.
 */
export function RunTimeline({
  events,
  startedAt,
  spanMs,
  sources,
  source,
  servedSource,
  onSourceChange,
  total,
  nextOffset,
  onLoadMore,
  loadingMore,
  live,
  following,
  onToggleFollow,
  notice,
  loading,
  error,
  warnings,
  cliVersion,
}: {
  events: HarnessEvent[];
  startedAt: number;
  spanMs: number;
  sources: TranscriptSources | null;
  source: TranscriptChoice;
  servedSource: TranscriptSource | null;
  onSourceChange: (s: TranscriptChoice) => void;
  total: number;
  nextOffset: number | null;
  onLoadMore: () => void;
  loadingMore: boolean;
  live: boolean;
  following: boolean;
  onToggleFollow: () => void;
  notice: TranscriptNotice | null;
  loading: boolean;
  error: string | null;
  warnings: string[];
  cliVersion?: string;
}) {
  const [filters, setFilters] = useState<Set<TimelineFilter>>(() => new Set(TIMELINE_FILTERS));
  const shown = useMemo(() => events.filter((e) => eventMatchesFilters(e, filters)), [events, filters]);
  const toggle = (f: TimelineFilter) =>
    setFilters((prev) => {
      const next = new Set(prev);
      if (next.has(f)) next.delete(f); else next.add(f);
      return next;
    });

  const nativeReason = sources && !sources.native.available ? sources.native.reason : undefined;
  const nativeTitle = sources?.native.available
    ? `Read ${sources.native.kind === 'opencode-db' ? "OpenCode's local DB (read-only)" : "qwen's own chat log"}`
    : (nativeReasonText(nativeReason, cliVersion) ?? nativeReason ?? 'no native transcript for this runner');
  const capturedTitle = !sources?.captured.available
    ? 'No captured stream (backfilled or never produced output)'
    : sources.captured.truncated
      ? 'The redacted stdout lm-assist captured — it stopped at the 8 MB capture cap, so the tail is missing'
      : 'The redacted stdout lm-assist captured';
  const options: Array<{ id: TranscriptChoice; label: string; disabled: boolean; title: string }> = [
    { id: 'auto', label: 'Auto', disabled: false, title: 'Captured stream while live, the harness’s own transcript once it ends' },
    { id: 'captured', label: sources?.captured.truncated ? 'Captured (partial)' : 'Captured', disabled: !sources?.captured.available, title: capturedTitle },
    { id: 'native', label: 'Native', disabled: !sources?.native.available, title: nativeTitle },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div className="flex flex-wrap items-center" style={{ gap: 8 }}>
        <div style={{ display: 'inline-flex', border: '1px solid var(--color-border-default)', borderRadius: 'var(--radius-md)', overflow: 'hidden' }}>
          {options.map((o) => (
            <button
              key={o.id}
              type="button"
              disabled={o.disabled}
              title={o.title}
              onClick={() => onSourceChange(o.id)}
              style={{
                padding: '3px 10px', fontSize: 11, border: 'none', cursor: o.disabled ? 'not-allowed' : 'pointer',
                background: source === o.id ? 'var(--color-accent-glow)' : 'transparent',
                color: o.disabled ? 'var(--color-text-tertiary)' : source === o.id ? 'var(--color-accent)' : 'var(--color-text-secondary)',
                opacity: o.disabled ? 0.55 : 1,
              }}
            >
              {o.label}
            </button>
          ))}
        </div>
        {servedSource && (
          <span style={{ fontSize: 10.5, color: 'var(--color-text-tertiary)' }}>showing {SOURCE_LABEL[servedSource]}</span>
        )}
        <div className="flex flex-wrap items-center" style={{ gap: 4, marginLeft: 'auto' }}>
          {TIMELINE_FILTERS.map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => toggle(f)}
              className="badge"
              style={{
                cursor: 'pointer', fontSize: 10.5,
                ...(filters.has(f)
                  ? tint(f === 'errors' ? 'var(--color-status-red)' : 'var(--color-accent)')
                  : { background: 'transparent', color: 'var(--color-text-tertiary)', border: '1px solid var(--color-border-default)' }),
              }}
            >
              {FILTER_LABEL[f]}
            </button>
          ))}
          {live && (
            <button
              type="button"
              className={`btn btn-sm ${following ? 'btn-primary' : 'btn-ghost'}`}
              onClick={onToggleFollow}
              title={following ? 'Auto-scrolling to new events — click to stop' : 'Scroll to the newest event and keep following'}
            >
              {following ? 'Following' : 'Follow'}
            </button>
          )}
        </div>
      </div>

      {notice && (
        <div
          style={{
            padding: '6px 10px', fontSize: 11.5, borderRadius: 'var(--radius-sm)',
            ...(notice.tone === 'warn' ? tint('var(--color-status-orange)', 8) : { background: 'var(--color-bg-elevated)', color: 'var(--color-text-secondary)', border: '1px solid var(--color-border-default)' }),
          }}
        >
          {notice.text}
        </div>
      )}
      {error && (
        <div style={{ padding: '6px 10px', fontSize: 11.5, borderRadius: 'var(--radius-sm)', ...tint('var(--color-status-red)', 8) }}>{error}</div>
      )}
      {warnings.length > 0 && (
        <div style={{ fontSize: 10.5, color: 'var(--color-text-tertiary)' }}>
          {warnings.map((w, i) => <div key={i}>{w}</div>)}
        </div>
      )}

      {loading && events.length === 0 ? (
        <SkeletonRows count={5} />
      ) : events.length === 0 ? (
        !notice && !error ? <div style={{ fontSize: 12, color: 'var(--color-text-tertiary)', padding: '8px 0' }}>No events yet.</div> : null
      ) : shown.length === 0 ? (
        <div style={{ fontSize: 12, color: 'var(--color-text-tertiary)', padding: '8px 0' }}>Every event is hidden by the filters above.</div>
      ) : (
        <div>
          {shown.map((ev) => <EventRow key={ev.seq} ev={ev} startedAt={startedAt} spanMs={spanMs} />)}
        </div>
      )}

      {nextOffset != null && (
        <button type="button" className="btn btn-sm btn-ghost" style={{ alignSelf: 'center' }} onClick={onLoadMore} disabled={loadingMore}>
          {loadingMore ? 'Loading…' : `Load more (${Math.max(0, total - events.length)} more event${total - events.length === 1 ? '' : 's'})`}
        </button>
      )}
    </div>
  );
}
