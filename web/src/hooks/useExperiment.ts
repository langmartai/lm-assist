'use client';

import { useState, useEffect, useCallback } from 'react';

const EXPERIMENT_KEY = 'lm-assist:experiment-v1';
const CHANGE_EVENT = 'lm-assist:experiment-changed';

export function useExperiment() {
  const [isExperiment, setIsExperimentState] = useState(false);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    try {
      setIsExperimentState(localStorage.getItem(EXPERIMENT_KEY) === 'true');
    } catch { /* ignore */ }

    // Listen for changes from other useExperiment instances on the same page
    const handler = (e: Event) => {
      const val = (e as CustomEvent<{ value: boolean }>).detail?.value;
      if (typeof val === 'boolean') setIsExperimentState(val);
    };
    window.addEventListener(CHANGE_EVENT, handler);
    return () => window.removeEventListener(CHANGE_EVENT, handler);
  }, []);

  const setExperiment = useCallback((val: boolean) => {
    setIsExperimentState(val);
    try {
      localStorage.setItem(EXPERIMENT_KEY, val ? 'true' : 'false');
      // Notify all other useExperiment instances on this page
      window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: { value: val } }));
    } catch { /* ignore */ }
  }, []);

  return { isExperiment: mounted ? isExperiment : false, setExperiment, mounted };
}
