'use client';

import { useState, useRef, useEffect } from 'react';
import { ChevronDown, Monitor, Globe } from 'lucide-react';
import { useMachineContext } from '@/contexts/MachineContext';
import { useAppMode } from '@/contexts/AppModeContext';
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
  const { hubConnected } = useAppMode();
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

          {machines.map(m => (
            <button
              key={m.id}
              className={`machine-dropdown-item${selectedMachineId === m.id ? ' active' : ''}`}
              onClick={() => { setSelectedMachineId(m.id); setOpen(false); }}
            >
              <span className="machine-dropdown-emoji">
                {getPlatformEmoji(m.platform)}
              </span>
              <span className="machine-dropdown-item-label">{m.hostname}</span>
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
          ))}
        </div>
      )}
    </div>
  );
}
