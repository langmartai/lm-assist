'use client';

import { useRef, useState, useEffect } from 'react';

/**
 * Returns 'highlight-update' class for 5s when the watched value changes.
 * Skips the initial render so elements don't flash on page load.
 */
export function useHighlight(value: unknown): string {
  const prevRef = useRef(value);
  const mountedRef = useRef(false);
  const [active, setActive] = useState(false);
  const timerRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    // Skip initial mount
    if (!mountedRef.current) {
      mountedRef.current = true;
      prevRef.current = value;
      return;
    }

    if (value !== prevRef.current) {
      prevRef.current = value;
      setActive(true);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setActive(false), 5000);
    }
  }, [value]);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  return active ? 'highlight-update' : '';
}

/**
 * Returns 'highlight-value' class for 5s when the watched value changes.
 * For inline stat values (text glow effect).
 */
export function useHighlightValue(value: unknown): string {
  const prevRef = useRef(value);
  const mountedRef = useRef(false);
  const [active, setActive] = useState(false);
  const timerRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    if (!mountedRef.current) {
      mountedRef.current = true;
      prevRef.current = value;
      return;
    }

    if (value !== prevRef.current) {
      prevRef.current = value;
      setActive(true);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setActive(false), 5000);
    }
  }, [value]);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  return active ? 'highlight-value' : '';
}
