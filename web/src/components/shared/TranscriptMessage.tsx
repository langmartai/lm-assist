'use client';

import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Wrench, User, Cloud, Sparkles, ChevronRight, ChevronDown } from 'lucide-react';
import { formatToolCallString } from '@/lib/smart-display';

interface ToolCall { name: string; input?: unknown; result?: string; isError?: boolean }

export function TranscriptMessage({ m }: { m: { role: string; type: string; text: string; tools?: string[]; thinking?: string; toolCalls?: ToolCall[] } }) {
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
      {/* Tool calls: expandable cards with input + output (like claude.ai). Falls back to plain
          name badges for callers that only supply `tools` (e.g. the CCR viewer). */}
      {m.toolCalls && m.toolCalls.length > 0 ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {m.toolCalls.map((t, i) => <ToolCard key={i} t={t} />)}
        </div>
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

/** Expandable tool-call card — click the header to reveal the input args and the result. */
function ToolCard({ t }: { t: ToolCall }) {
  const [open, setOpen] = useState(false);
  const header = formatToolCallString(t.name || 'tool', (t.input && typeof t.input === 'object' ? t.input : {}) as Record<string, unknown>);
  const result = (t.result || '').trim();
  const hasInput = !!(t.input && typeof t.input === 'object' && Object.keys(t.input as object).length > 0);
  const hasDetail = result.length > 0 || hasInput;
  return (
    <div style={{ border: `1px solid ${t.isError ? 'var(--color-status-red)' : 'var(--color-border-subtle)'}`, borderRadius: 'var(--radius-sm)', background: 'var(--color-bg-elevated)', overflow: 'hidden' }}>
      <button onClick={() => setOpen((o) => !o)} disabled={!hasDetail}
        style={{ width: '100%', textAlign: 'left', background: 'none', border: 'none', cursor: hasDetail ? 'pointer' : 'default', padding: '6px 8px', display: 'flex', alignItems: 'center', gap: 6, fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--color-text-secondary)' }}>
        <Wrench size={11} style={{ color: t.isError ? 'var(--color-status-red)' : 'var(--color-accent)', flexShrink: 0 }} />
        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{header}</span>
        {t.isError && <span className="badge badge-red" style={{ flexShrink: 0 }}>error</span>}
        {hasDetail && (open ? <ChevronDown size={12} /> : <ChevronRight size={12} />)}
      </button>
      {open && hasDetail && (
        <div style={{ borderTop: '1px solid var(--color-border-subtle)' }}>
          {hasInput && (
            <pre style={{ margin: 0, padding: '6px 8px', fontSize: 11, color: 'var(--color-text-tertiary)', whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: 180, overflow: 'auto' }}>
              {truncate(JSON.stringify(t.input, null, 2), 2000)}
            </pre>
          )}
          {result.length > 0 && (
            <pre style={{ margin: 0, padding: '6px 8px', borderTop: '1px solid var(--color-border-subtle)', fontSize: 11, color: 'var(--color-text-tertiary)', whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: 260, overflow: 'auto' }}>
              {truncate(result, 3000)}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

function truncate(s: string, n: number): string { return s.length > n ? s.slice(0, n) + '\n… (truncated)' : s; }

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
