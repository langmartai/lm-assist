'use client';

import { useEffect, useState } from 'react';
import { Sidebar } from '@/components/layout/Sidebar';
import { TopBar } from '@/components/layout/TopBar';
import { MachineProvider } from '@/contexts/MachineContext';
import { SearchProvider, useSearch } from '@/contexts/SearchContext';
import { SearchOverlay } from '@/components/search/SearchOverlay';
import { DataLoadingModal } from '@/components/data-loading/DataLoadingModal';
import { DATA_LOADED_KEY } from '@/hooks/useDataLoading';
import { useExperiment } from '@/hooks/useExperiment';
import { useLanAuthGuard } from '@/hooks/useLanAuthGuard';

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
