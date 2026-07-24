'use client';

import { ShieldQuestion } from 'lucide-react';
import type { ApprovalOption, ApprovalReq } from '@/hooks/useClaudeVoice';

const OPTION_LABEL: Record<ApprovalOption, string> = {
  once: 'Once',
  perChat: 'For this chat',
  always: 'Always',
};

// Fixed left-to-right button order regardless of the order the server listed
// `req.options` in — `.filter` below keeps only the options actually offered.
const OPTION_ORDER: ApprovalOption[] = ['once', 'perChat', 'always'];

/**
 * A pending in-band approval — `useClaudeVoice`'s `pendingApprovals`, one `ApprovalReq` per
 * `tool_use` block that carried `approval_key`/`approval_options` (`claude-voice-demux.ts`).
 * Visual idiom borrowed from `ApprovalWidget.tsx` (the AskUserQuestion prompt elsewhere in
 * the app): an accent-bordered box on `--color-bg-elevated`. Only the options the server
 * actually offered are rendered, in a fixed Once / For this chat / Always order; Deny is
 * always available (`buildDenyFrame` — a denial carries no `approval_option`, unlike an
 * approval, since "once/perChat/always" only scopes how an *approval* applies).
 */
export function ApprovalPrompt({
  req,
  onApprove,
  onDeny,
}: {
  req: ApprovalReq;
  onApprove: (option: ApprovalOption) => void;
  onDeny: () => void;
}) {
  const options = OPTION_ORDER.filter((o) => req.options.includes(o));

  return (
    <div
      style={{
        border: '1px solid var(--color-accent)',
        borderRadius: 'var(--radius-md)',
        background: 'var(--color-bg-elevated)',
        padding: 10,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <ShieldQuestion size={12} style={{ color: 'var(--color-accent)', flexShrink: 0 }} />
        <span style={{ fontSize: 10, fontWeight: 600, color: 'var(--color-text-tertiary)', textTransform: 'uppercase', letterSpacing: 0.5 }}>
          Approval requested
        </span>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-text-primary)' }}>{req.name || 'Tool call'}</span>
        {req.integrationName && <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>{req.integrationName}</span>}
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>
        {options.map((o) => (
          <button key={o} type="button" className="btn btn-secondary btn-sm" onClick={() => onApprove(o)}>
            {OPTION_LABEL[o]}
          </button>
        ))}
        <button type="button" className="btn btn-destructive btn-sm" onClick={onDeny} style={{ marginLeft: 'auto' }}>
          Deny
        </button>
      </div>
    </div>
  );
}
