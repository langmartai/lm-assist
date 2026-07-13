'use client';

import { useState, type CSSProperties } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Wrench, User, Cloud, Sparkles, ChevronRight, ChevronDown, FileText, Terminal, Search, Globe, Plug } from 'lucide-react';
import { formatToolCall } from '@/lib/smart-display';
import { groupLabel } from '@/lib/tool-summary';

interface ToolCall { name: string; input?: unknown; result?: string; isError?: boolean }

/**
 * A transcript message. `compact` renders tool calls as claude.ai/code does — one grouped
 * summary line ("Ran 2 commands, read a file") that expands to the individual tool cards —
 * instead of one card per call. Opt-in so the cowork page (also a consumer) is unchanged.
 */
export function TranscriptMessage({ m, compact = false }: { m: { role: string; type: string; text: string; tools?: string[]; thinking?: string; toolCalls?: ToolCall[] }; compact?: boolean }) {
  const isUser = m.type === 'user';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, alignItems: isUser ? 'flex-end' : 'stretch' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10.5, color: 'var(--color-text-tertiary)', textTransform: 'uppercase', letterSpacing: 0.4 }}>
        {isUser ? <User size={11} /> : <Cloud size={11} />}{isUser ? 'you' : 'cloud claude'}
      </div>
      {!isUser && m.thinking ? <ThinkBlock text={m.thinking} /> : null}
      {m.text && (
        <div className="prose" style={{
          fontSize: 12.5, lineHeight: 1.55, maxWidth: isUser ? '85%' : '100%',
          background: isUser ? 'var(--color-bg-elevated)' : 'transparent',
          border: isUser ? '1px solid var(--color-border-default)' : 'none',
          borderRadius: isUser ? 'var(--radius-md)' : 0, padding: isUser ? '6px 10px' : 0,
        }}>
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.text}</ReactMarkdown>
        </div>
      )}
      {/* Tool calls: compact grouped summary line (claude.ai/code) when `compact`, else expandable
          cards. Falls back to plain name badges for callers that only supply `tools`. */}
      {m.toolCalls && m.toolCalls.length > 0 ? (
        compact ? (
          <ToolGroup toolCalls={m.toolCalls} />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            {m.toolCalls.map((t, i) => <ToolCard key={i} t={t} />)}
          </div>
        )
      ) : m.tools && m.tools.length > 0 ? (
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
          {m.tools.map((t, i) => (
            <span key={i} className="badge badge-outline" style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 10.5 }}>
              <Wrench size={10} /> {t}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function toolIcon(name: string) {
  const n = (name || '').toLowerCase();
  if (/read|write|edit|file|open/.test(n)) return FileText;
  if (/bash|command|terminal|exec|shell|run/.test(n)) return Terminal;
  if (/search|grep|glob|find|lookup/.test(n)) return Search;
  if (/web|fetch|http|url|browse/.test(n)) return Globe;
  if (/connector|mcp|gmail|drive|list|send|mail/.test(n)) return Plug;
  return Wrench;
}

/** Pretty-print a tool result: indent JSON when it parses, else leave the text as-is. */
function prettyResult(s: string): string {
  const t = s.trim();
  if (t.startsWith('{') || t.startsWith('[')) { try { return JSON.stringify(JSON.parse(t), null, 2); } catch { /* not json */ } }
  return s;
}

function truncate(s: string, n: number): string { return s.length > n ? s.slice(0, n) + '\n… (truncated)' : s; }

const preStyle: CSSProperties = { margin: 0, fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--color-text-secondary)', whiteSpace: 'pre-wrap', wordBreak: 'break-word', overflow: 'auto' };
const labelStyle: CSSProperties = { fontSize: 9.5, fontWeight: 700, letterSpacing: 0.5, color: 'var(--color-text-tertiary)', textTransform: 'uppercase', marginBottom: 3 };

/** Expandable, prettified tool-call card — readable header, then labelled Input / Result sections. */
function ToolCard({ t }: { t: ToolCall }) {
  const [open, setOpen] = useState(false);
  const { name, args } = formatToolCall(t.name || 'tool', (t.input && typeof t.input === 'object' ? t.input : {}) as Record<string, unknown>);
  const Icon = toolIcon(t.name || '');
  const result = (t.result || '').trim();
  const hasInput = !!(t.input && typeof t.input === 'object' && Object.keys(t.input as object).length > 0);
  const hasDetail = result.length > 0 || hasInput;
  return (
    <div style={{ border: `1px solid ${t.isError ? 'var(--color-status-red)' : 'var(--color-border-subtle)'}`, borderRadius: 'var(--radius-md)', background: 'var(--color-bg-elevated)', overflow: 'hidden' }}>
      <button onClick={() => setOpen((o) => !o)} disabled={!hasDetail}
        style={{ width: '100%', textAlign: 'left', background: 'none', border: 'none', cursor: hasDetail ? 'pointer' : 'default', padding: '7px 10px', display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--color-text-secondary)' }}>
        <Icon size={13} style={{ color: t.isError ? 'var(--color-status-red)' : 'var(--color-accent)', flexShrink: 0 }} />
        <span style={{ fontWeight: 600, flexShrink: 0 }}>{name}</span>
        {args && <span style={{ color: 'var(--color-text-tertiary)', fontFamily: 'var(--font-mono)', fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>{args}</span>}
        <span style={{ flex: 1 }} />
        {t.isError && <span className="badge badge-red" style={{ flexShrink: 0 }}>error</span>}
        {hasDetail && (open ? <ChevronDown size={13} style={{ color: 'var(--color-text-tertiary)', flexShrink: 0 }} /> : <ChevronRight size={13} style={{ color: 'var(--color-text-tertiary)', flexShrink: 0 }} />)}
      </button>
      {open && hasDetail && (
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {hasInput && (
            <div style={{ padding: '6px 10px', borderTop: '1px solid var(--color-border-subtle)' }}>
              <div style={labelStyle}>Input</div>
              <pre style={{ ...preStyle, maxHeight: 180 }}>{truncate(JSON.stringify(t.input, null, 2), 2000)}</pre>
            </div>
          )}
          {result.length > 0 && (
            <div style={{ padding: '6px 10px', borderTop: '1px solid var(--color-border-subtle)' }}>
              <div style={labelStyle}>{t.isError ? 'Error' : 'Result'}</div>
              <pre style={{ ...preStyle, maxHeight: 260 }}>{truncate(prettyResult(result), 3000)}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * claude.ai/code-style compact tool group: one summary line ("Ran 2 commands, read a file" or
 * "Edited App.tsx +4 -1") with a category icon + chevron; expands to the full per-tool cards.
 */
function ToolGroup({ toolCalls }: { toolCalls: ToolCall[] }) {
  const [open, setOpen] = useState(false);
  const label = groupLabel(toolCalls);
  const anyError = toolCalls.some((t) => t.isError);
  // Icon from the dominant tool (first non-trivial), else Wrench.
  const Icon = toolIcon(toolCalls[0]?.name || '');
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
      <button onClick={() => setOpen((o) => !o)}
        style={{ alignSelf: 'flex-start', maxWidth: '100%', textAlign: 'left', background: 'none', border: 'none', cursor: 'pointer', padding: '3px 4px', display: 'flex', alignItems: 'center', gap: 7, fontSize: 12, color: 'var(--color-text-tertiary)' }}>
        <Icon size={13} style={{ color: anyError ? 'var(--color-status-red)' : 'var(--color-text-tertiary)', flexShrink: 0 }} />
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>{label}</span>
        {anyError && <span className="badge badge-red" style={{ flexShrink: 0 }}>error</span>}
        {open ? <ChevronDown size={12} style={{ flexShrink: 0 }} /> : <ChevronRight size={12} style={{ flexShrink: 0 }} />}
      </button>
      {open && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5, paddingLeft: 4 }}>
          {toolCalls.map((t, i) => <ToolCard key={i} t={t} />)}
        </div>
      )}
    </div>
  );
}

/** Collapsible "thinking" block — Claude's reasoning, hidden by default (like claude.ai). */
function ThinkBlock({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ borderLeft: '2px solid var(--color-border-default)', paddingLeft: 8, marginBottom: 2 }}>
      <button onClick={() => setOpen((o) => !o)}
        style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, display: 'flex', alignItems: 'center', gap: 5, fontSize: 10, fontWeight: 700, letterSpacing: 0.4, color: 'var(--color-text-tertiary)' }}>
        <Sparkles size={11} /> THINKING {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
      </button>
      {open && (
        <div style={{ marginTop: 4, fontSize: 12, fontStyle: 'italic', color: 'var(--color-text-tertiary)', whiteSpace: 'pre-wrap', wordBreak: 'break-word', lineHeight: 1.5 }}>
          {text.length > 4000 ? text.slice(0, 4000) + ' …' : text}
        </div>
      )}
    </div>
  );
}
