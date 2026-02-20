'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { usePathname } from 'next/navigation';
import { ChevronDown, Monitor, Globe, ExternalLink } from 'lucide-react';
import { useMachineContext } from '@/contexts/MachineContext';
import { useAppMode } from '@/contexts/AppModeContext';
import { detectAppMode } from '@/lib/api-client';
import { getPlatformEmoji } from '@/lib/utils';

export function MachineDropdown() {
  const {
    machines,
    onlineMachines,
    selectedMachineId,
    setSelectedMachineId,
    selectedMachine,
    isSingleMachine,
  } = useMachineContext();
  const { hubConnected, mode, proxy } = useAppMode();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => { setMounted(true); }, []);

  // Close on click outside
  useEffect(() => {
    if (!open) return;
    function handleMouseDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleMouseDown);
    return () => document.removeEventListener('mousedown', handleMouseDown);
  }, [open]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [open]);

  if (!mounted) return null;

  // Single local machine, no hub — static label
  if (isSingleMachine && !hubConnected) {
    return (
      <span className="machine-dropdown-static">
        <Monitor size={13} /> Local
      </span>
    );
  }

  const triggerLabel = selectedMachine
    ? selectedMachine.hostname
    : 'All Machines';

  const triggerEmoji = selectedMachine
    ? getPlatformEmoji(selectedMachine.platform)
    : null;

  return (
    <div className="machine-dropdown" ref={ref}>
      <button
        className={`machine-dropdown-trigger${open ? ' open' : ''}`}
        onClick={() => setOpen(v => !v)}
        aria-expanded={open}
      >
        {triggerEmoji ? (
          <span className="machine-dropdown-emoji">{triggerEmoji}</span>
        ) : (
          <Globe size={13} />
        )}
        <span>{triggerLabel}</span>
        <ChevronDown
          size={12}
          className={`machine-dropdown-chevron${open ? ' open' : ''}`}
        />
      </button>

      {open && (
        <div className="machine-dropdown-panel">
          <button
            className={`machine-dropdown-item${selectedMachineId === null ? ' active' : ''}`}
            onClick={() => { setSelectedMachineId(null); setOpen(false); }}
          >
            <Globe size={13} />
            <span className="machine-dropdown-item-label">All Machines</span>
            <span className="machine-dropdown-item-meta">
              {onlineMachines.length} online
            </span>
          </button>

          <div className="machine-dropdown-divider" />

          {machines.map(m => {
            // In local/hybrid mode, clicking a non-local machine opens its cloud URL
            const isLocalMachine = m.isLocal || m.id === 'localhost';
            const isLocalOrHybrid = mode === 'local' || mode === 'hybrid';
            const shouldOpenCloud = isLocalOrHybrid && !isLocalMachine;

            const handleClick = async () => {
              setOpen(false);
              if (shouldOpenCloud) {
                const hubName = 'langmart.ai';
                const currentPage = pathname.replace(proxy.basePath, '') || '/session-dashboard';
                const remoteGatewayId = m.gatewayId || m.id;
                // Fetch a proxy token so the cloud URL authenticates automatically
                try {
                  const { baseUrl } = detectAppMode();
                  const res = await fetch(`${baseUrl}/hub/machines/${remoteGatewayId}/proxy-token`, { method: 'POST' });
                  const json = await res.json();
                  if (json.success && json.data?.token) {
                    window.open(`https://${hubName}/w/${remoteGatewayId}/assist${currentPage}?token=${json.data.token}`, '_blank');
                    return;
                  }
                } catch { /* fall through to URL without token */ }
                // Fallback: open without token (user will need to authenticate manually)
                window.open(`https://${hubName}/w/${remoteGatewayId}/assist${currentPage}`, '_blank');
              } else {
                setSelectedMachineId(m.id);
              }
            };

            return (
              <button
                key={m.id}
                className={`machine-dropdown-item${selectedMachineId === m.id ? ' active' : ''}`}
                onClick={handleClick}
              >
                <span className="machine-dropdown-emoji">
                  {getPlatformEmoji(m.platform)}
                </span>
                <span className="machine-dropdown-item-label">{m.hostname}</span>
                {shouldOpenCloud && <ExternalLink size={11} className="machine-dropdown-external" />}
                <span
                  className={`machine-dropdown-status ${m.status}`}
                  title={m.status}
                />
                {typeof m.sessionCount === 'number' && (
                  <span className="machine-dropdown-item-meta">
                    {m.sessionCount}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
