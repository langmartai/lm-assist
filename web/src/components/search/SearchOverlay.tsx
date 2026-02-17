'use client';

import { useEffect, useCallback } from 'react';
import { useSearch } from '@/contexts/SearchContext';
import { SessionSearch } from './SessionSearch';

export function SearchOverlay() {
  const { isOpen, close, initialQuery, directory, projectPath } = useSearch();

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
        alignItems: 'flex-start',
        justifyContent: 'center',
        paddingTop: '5vh',
        backgroundColor: 'rgba(0, 0, 0, 0.6)',
        backdropFilter: 'blur(4px)',
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        style={{
          width: '90%',
          maxWidth: 1100,
          height: '80vh',
          background: 'var(--color-bg-surface)',
          border: '1px solid var(--color-border-default)',
          borderRadius: 'var(--radius-xl)',
          overflow: 'hidden',
          animation: 'dropdown-appear 150ms ease',
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
