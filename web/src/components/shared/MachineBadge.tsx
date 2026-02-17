'use client';

import { getPlatformEmoji } from '@/lib/utils';

interface MachineBadgeProps {
  hostname: string;
  platform: string;
  status: 'online' | 'offline';
  hide?: boolean;
}

export function MachineBadge({ hostname, platform, status, hide }: MachineBadgeProps) {
  if (hide) return null;

  return (
    <span className="badge badge-default" style={{ gap: 4, fontSize: 11 }}>
      <span>{getPlatformEmoji(platform)}</span>
      <span style={{ fontFamily: 'var(--font-mono)' }}>{hostname}</span>
      <span className={`status-dot ${status === 'online' ? 'online' : 'offline'}`} />
    </span>
  );
}
