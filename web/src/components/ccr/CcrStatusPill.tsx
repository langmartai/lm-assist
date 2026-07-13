'use client';

import { ccrStatusPill, toneColor, type CcrStatusInput } from '@/lib/ccr-status';

/** claude.ai/code status pill: a coloured dot + label ("● Needs input"). */
export function CcrStatusPill({ status }: { status: CcrStatusInput }) {
  const { label, tone } = ccrStatusPill(status);
  const color = toneColor(tone);
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color, flexShrink: 0, whiteSpace: 'nowrap' }}>
      <span style={{ width: 7, height: 7, borderRadius: '50%', background: color, flexShrink: 0 }} />
      {label}
    </span>
  );
}
