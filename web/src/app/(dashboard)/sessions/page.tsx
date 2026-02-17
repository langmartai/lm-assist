'use client';

import { Suspense } from 'react';
import { SessionBrowser } from '@/components/sessions/SessionBrowser';
import { Loader2 } from 'lucide-react';

export default function SessionsPage() {
  return (
    <Suspense fallback={
      <div className="empty-state" style={{ height: '100%' }}>
        <Loader2 size={24} style={{ animation: 'spin 1s linear infinite' }} />
        <span style={{ fontSize: 12 }}>Loading sessions...</span>
      </div>
    }>
      <SessionBrowser />
    </Suspense>
  );
}
