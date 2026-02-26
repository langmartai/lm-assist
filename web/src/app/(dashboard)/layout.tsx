'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Sidebar } from '@/components/layout/Sidebar';
import { TopBar } from '@/components/layout/TopBar';
import { MachineProvider } from '@/contexts/MachineContext';
import { SearchProvider, useSearch } from '@/contexts/SearchContext';
import { SearchOverlay } from '@/components/search/SearchOverlay';
import { DataLoadingModal } from '@/components/data-loading/DataLoadingModal';
import { DATA_LOADED_KEY } from '@/hooks/useDataLoading';
import { detectAppMode, detectProxyInfo } from '@/lib/api-client';
import { useExperiment } from '@/hooks/useExperiment';

function useLanAuthGuard() {
  const router = useRouter();
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    const controller = new AbortController();

    (async () => {
      const hostname = window.location.hostname;
      const isLocalhost = hostname === 'localhost' || hostname === '127.0.0.1';

      // Localhost always passes
      if (isLocalhost) { setChecked(true); return; }

      // Cloud proxy always passes — already authenticated by LangMartDesign
      const proxyInfo = detectProxyInfo();
      if (proxyInfo.isProxied) { setChecked(true); return; }

      // Non-localhost — check if this is actually a local request via LAN IP
      // by asking the Core API (which can check the TCP connection's remote address)
      try {
        const { baseUrl } = detectAppMode();
        const localRes = await fetch(`${baseUrl}/auth/is-local`, {
          signal: AbortSignal.timeout(2000),
        });
        const localData = await localRes.json();
        if (localData?.data?.isLocal === true) {
          setChecked(true);
          return;
        }
      } catch {
        // Core API unreachable — fall through to LAN auth check
      }

      // Truly remote — check if LAN auth is enabled
      try {
        const serverRes = await fetch('/api/server', { signal: controller.signal });
        const data = await serverRes.json();

        if (!data.lanAuthEnabled) { setChecked(true); return; }

        // Auth enabled — check localStorage for token
        const storedToken = localStorage.getItem('assist_access_key');
        if (!storedToken) { router.replace('/lan-blocked'); return; }

        // Validate the stored token
        const res = await fetch('/api/auth/validate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: storedToken }),
          signal: controller.signal,
        });
        const result = await res.json();
        if (result.valid) {
          setChecked(true);
        } else {
          localStorage.removeItem('assist_access_key');
          router.replace('/lan-blocked');
        }
      } catch {
        // Can't reach server config — allow through (fail open on network error)
        setChecked(true);
      }
    })();

    return () => controller.abort();
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
  const [showDataModal, setShowDataModal] = useState(false);
  const [autoRun, setAutoRun] = useState(false);
  const { isExperiment } = useExperiment();

  // Auto-open: only in experiment mode, if data not loaded or auto-start enabled
  useEffect(() => {
    try {
      const isExp = localStorage.getItem('lm-assist:experiment-v1') === 'true';
      if (!isExp) return;
      const dataLoaded = localStorage.getItem(DATA_LOADED_KEY) === 'true';
      const cfg = localStorage.getItem('lm-assist:data-loading-config-v1');
      const autoStart = cfg ? (JSON.parse(cfg).autoStart ?? false) : false;

      if (!dataLoaded || autoStart) {
        setShowDataModal(true);
        setAutoRun(autoStart);
      }
    } catch { /* ignore */ }
  }, []);

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
      {isExperiment && (
        <DataLoadingModal
          isOpen={showDataModal}
          autoRun={autoRun}
          onClose={() => { setShowDataModal(false); setAutoRun(false); }}
        />
      )}
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
