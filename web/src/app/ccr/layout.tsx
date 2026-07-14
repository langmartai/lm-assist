'use client';

import { MachineProvider } from '@/contexts/MachineContext';
import { useLanAuthGuard } from '@/hooks/useLanAuthGuard';

/**
 * Full-bleed layout for the Code page (/ccr) — a claude.ai/code-style experience with its
 * OWN sidebar, so it deliberately omits the dashboard shell (icon rail + top bar). Keeps the
 * same LAN auth gate as the dashboard and provides MachineContext for the machine picker.
 */
export default function CcrLayout({ children }: { children: React.ReactNode }) {
  const authPassed = useLanAuthGuard();
  if (!authPassed) return null;

  return (
    <MachineProvider>
      <div style={{ height: '100vh', width: '100vw', overflow: 'hidden', background: 'var(--color-bg-root)' }}>
        {children}
      </div>
    </MachineProvider>
  );
}
