'use client';

import { createContext, useContext, useState, useCallback, type ReactNode } from 'react';

interface SearchScope {
  directory?: string;
  projectPath?: string;
}

interface SearchContextValue {
  isOpen: boolean;
  initialQuery: string;
  directory: string | undefined;
  projectPath: string | undefined;
  open: (initialQuery?: string, opts?: SearchScope) => void;
  close: () => void;
}

const SearchContext = createContext<SearchContextValue | null>(null);

export function SearchProvider({ children }: { children: ReactNode }) {
  const [isOpen, setIsOpen] = useState(false);
  const [initialQuery, setInitialQuery] = useState('');
  const [directory, setDirectory] = useState<string | undefined>();
  const [projectPath, setProjectPath] = useState<string | undefined>();

  const open = useCallback((query?: string, opts?: SearchScope) => {
    setInitialQuery(query || '');
    setDirectory(opts?.directory);
    setProjectPath(opts?.projectPath);
    setIsOpen(true);
  }, []);

  const close = useCallback(() => {
    setIsOpen(false);
    setInitialQuery('');
    setDirectory(undefined);
    setProjectPath(undefined);
  }, []);

  return (
    <SearchContext.Provider value={{ isOpen, initialQuery, directory, projectPath, open, close }}>
      {children}
    </SearchContext.Provider>
  );
}

export function useSearch(): SearchContextValue {
  const ctx = useContext(SearchContext);
  if (!ctx) throw new Error('useSearch must be used within SearchProvider');
  return ctx;
}
