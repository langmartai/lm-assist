'use client';

import { useState } from 'react';
import { Loader2, HelpCircle } from 'lucide-react';

interface QOption { label: string; description?: string }
interface PendingQuestion { toolUseId: string; requestId?: string; questions: Array<{ header?: string; question?: string; multiSelect?: boolean; options?: QOption[] }> }

export function ApprovalWidget({ pending, answering, onAnswer, who }: {
  pending: PendingQuestion; answering: boolean; onAnswer: (text: string) => void;
  /** Who is waiting — defaults to the original cloud phrasing. */
  who?: string;
}) {
  const [customAnswer, setCustomAnswer] = useState('');

  if (!pending || !pending.questions[0]) return null;

  return (
    <div style={{ border: '1px solid var(--color-accent)', borderRadius: 'var(--radius-md)', padding: 8, marginBottom: 4, background: 'var(--color-bg-elevated)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 600, color: 'var(--color-text-primary)', marginBottom: 6 }}>
        <HelpCircle size={13} style={{ color: 'var(--color-accent)' }} /> {pending.questions[0].header || 'Question'} — {who || 'the cloud claude'} is waiting on you
      </div>
      {pending.questions[0].question && <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginBottom: 8 }}>{pending.questions[0].question}</div>}
      {(pending.questions[0].options || []).length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5, marginBottom: 8 }}>
          {(pending.questions[0].options || []).map((o) => (
            <button key={o.label} className="btn btn-ghost btn-sm" disabled={answering} onClick={() => onAnswer(o.label)}
              style={{ justifyContent: 'flex-start', textAlign: 'left', height: 'auto', padding: '6px 10px', whiteSpace: 'normal' }} title={o.description}>
              <span style={{ fontWeight: 600 }}>{o.label}</span>{o.description ? <span style={{ color: 'var(--color-text-tertiary)', fontSize: 11 }}> — {o.description}</span> : null}
            </button>
          ))}
        </div>
      )}
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <input className="input" value={customAnswer} placeholder="…or type your own answer" disabled={answering}
          style={{ flex: 1, fontSize: 12 }} onChange={(e) => setCustomAnswer(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); onAnswer(customAnswer); } }} />
        <button className="btn btn-primary btn-sm" disabled={answering || !customAnswer.trim()} onClick={() => onAnswer(customAnswer)} title="Send custom answer">
          {answering ? <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} /> : 'Send'}
        </button>
      </div>
    </div>
  );
}
