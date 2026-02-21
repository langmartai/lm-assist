'use client';

import { useEffect, useCallback } from 'react';
import { useSearch } from '@/contexts/SearchContext';
import { useDeviceInfo } from '@/hooks/useDeviceInfo';
import { SessionSearch } from './SessionSearch';

export function SearchOverlay() {
  const { isOpen, close, initialQuery, directory, projectPath } = useSearch();
  const { viewMode } = useDeviceInfo();
  const isMobile = viewMode === 'mobile';

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape') close();
  }, [close]);

  useEffect(() => {
    if (!isOpen) return;
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, handleKeyDown]);

  if (!isOpen) return null;

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9000,
        display: 'flex',
        alignItems: isMobile ? 'stretch' : 'flex-start',
        justifyContent: 'center',
        paddingTop: isMobile ? 0 : '5vh',
        paddingLeft: isMobile ? 'var(--size-sidebar)' : 0,
        backgroundColor: isMobile ? 'transparent' : 'rgba(0, 0, 0, 0.6)',
        backdropFilter: isMobile ? 'none' : 'blur(4px)',
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        style={{
          width: isMobile ? '100%' : '90%',
          maxWidth: isMobile ? undefined : 1100,
          height: isMobile ? '100%' : '80vh',
          background: 'var(--color-bg-surface)',
          border: isMobile ? 'none' : '1px solid var(--color-border-default)',
          borderRadius: isMobile ? 0 : 'var(--radius-xl)',
          overflow: 'hidden',
          animation: isMobile ? undefined : 'dropdown-appear 150ms ease',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <SessionSearch
          mode="popup"
          initialQuery={initialQuery}
          directory={directory}
          projectPath={projectPath}
          onClose={close}
        />
      </div>
    </div>
  );
}
