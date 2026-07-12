'use client';

import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Wrench, User, Cloud, Sparkles, ChevronRight, ChevronDown } from 'lucide-react';

export function TranscriptMessage({ m }: { m: { role: string; type: string; text: string; tools?: string[]; thinking?: string } }) {
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
      {m.tools && m.tools.length > 0 && (
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
          {m.tools.map((t, i) => (
            <span key={i} className="badge badge-outline" style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 10.5 }}>
              <Wrench size={10} /> {t}
            </span>
          ))}
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
