'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Sidebar } from '@/components/layout/Sidebar';
import { TopBar } from '@/components/layout/TopBar';
import { MachineProvider } from '@/contexts/MachineContext';
import { SearchProvider, useSearch } from '@/contexts/SearchContext';
import { SearchOverlay } from '@/components/search/SearchOverlay';
import { detectProxyInfo } from '@/lib/api-client';

function useLanAuthGuard() {
  const router = useRouter();
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    const hostname = window.location.hostname;
    const isLocalhost = hostname === 'localhost' || hostname === '127.0.0.1';

    // Localhost always passes
    if (isLocalhost) {
      setChecked(true);
      return;
    }

    // Cloud proxy always passes — already authenticated by LangMartDesign
    const proxyInfo = detectProxyInfo();
    if (proxyInfo.isProxied) {
      setChecked(true);
      return;
    }

    // Non-localhost — check if LAN auth is enabled
    fetch('/api/server')
      .then((r) => r.json())
      .then(async (data) => {
        if (!data.lanAuthEnabled) {
          // Auth not enabled, pass through
          setChecked(true);
          return;
        }

        // Auth enabled — check localStorage for token
        const storedToken = localStorage.getItem('assist_access_key');
        if (!storedToken) {
          router.replace('/lan-blocked');
          return;
        }

        // Validate the stored token
        try {
          const res = await fetch('/api/auth/validate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: storedToken }),
          });
          const result = await res.json();
          if (result.valid) {
            setChecked(true);
          } else {
            localStorage.removeItem('assist_access_key');
            router.replace('/lan-blocked');
          }
        } catch {
          // Validation failed — allow through (fail open on network error)
          setChecked(true);
        }
      })
      .catch(() => {
        // Can't reach server config — allow through
        setChecked(true);
      });
  }, [router]);

  return checked;
}

function CmdKListener() {
  const { open, isOpen, close } = useSearch();

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        if (isOpen) close();
        else open();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [open, close, isOpen]);

  return null;
}

function DashboardShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="shell">
      <div className="shell-sidebar">
        <Sidebar />
      </div>
      <div className="shell-topbar">
        <TopBar />
      </div>
      <div className="shell-main">
        {children}
      </div>
      <CmdKListener />
      <SearchOverlay />
    </div>
  );
}

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const authPassed = useLanAuthGuard();

  // Don't render dashboard until auth check completes
  if (!authPassed) {
    return null;
  }

  return (
    <MachineProvider>
      <SearchProvider>
        <DashboardShell>{children}</DashboardShell>
      </SearchProvider>
    </MachineProvider>
  );
}
