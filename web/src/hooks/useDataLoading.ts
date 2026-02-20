'use client';

import { useState, useCallback, useEffect } from 'react';
import { detectAppMode, detectProxyInfo } from '@/lib/api-client';

// ─── Types ───────────────────────────────────────────────────

export type StepStatus = 'pending' | 'running' | 'complete' | 'error' | 'skipped';

export interface LoadingStep {
  id: string;
  label: string;
  description: string;
  status: StepStatus;
  detail?: string;
  enabledByDefault: boolean;
  /** Built-in steps always run — no checkbox, cannot be disabled */
  builtin?: boolean;
}

// ─── Storage keys ────────────────────────────────────────────

export const DATA_LOADED_KEY = 'lm-assist:data-loaded-v1';
const CONFIG_KEY = 'lm-assist:data-loading-config-v1';

// ─── Step definitions ─────────────────────────────────────────

const INITIAL_STEPS: LoadingStep[] = [
  {
    id: 'session-cache',
    label: 'Session Cache',
    description: 'Always loads automatically on server start',
    status: 'pending',
    enabledByDefault: true,
    builtin: true,
  },
  {
    id: 'knowledge-gen',
    label: 'Knowledge Generation',
    description: 'Generate knowledge documents and index them into the vector store',
    status: 'pending',
    enabledByDefault: true,
  },
  {
    id: 'milestone-phase1',
    label: 'Milestone Detection',
    description: 'Scan sessions from the past day to detect milestones',
    status: 'pending',
    enabledByDefault: false,
  },
  {
    id: 'milestone-enrich',
    label: 'Milestone Enrichment',
    description: 'Enrich detected milestones and index them into the vector store',
    status: 'pending',
    enabledByDefault: false,
  },
];

// ─── Config persistence ───────────────────────────────────────

function loadConfig(): { enabled: Record<string, boolean>; autoStart: boolean } {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return {
        enabled: parsed.enabled ?? Object.fromEntries(INITIAL_STEPS.map(s => [s.id, s.enabledByDefault])),
        autoStart: parsed.autoStart ?? false,
      };
    }
  } catch { /* ignore */ }
  return {
    enabled: Object.fromEntries(INITIAL_STEPS.map(s => [s.id, s.enabledByDefault])),
    autoStart: false,
  };
}

function saveConfig(enabled: Record<string, boolean>, autoStart: boolean) {
  try { localStorage.setItem(CONFIG_KEY, JSON.stringify({ enabled, autoStart })); } catch { /* ignore */ }
}

// ─── API helpers ─────────────────────────────────────────────

function getTierAgentBase(): string {
  if (typeof window === 'undefined') return 'http://localhost:3100';
  const proxyInfo = detectProxyInfo();
  if (proxyInfo.isProxied) return '/_coreapi';
  const { baseUrl } = detectAppMode();
  return baseUrl || 'http://localhost:3100';
}

async function apiGet<T>(path: string): Promise<T | null> {
  try {
    const base = getTierAgentBase();
    const res = await fetch(`${base}${path}`);
    if (!res.ok) return null;
    const json = await res.json();
    if (json && typeof json === 'object' && 'data' in json) return json.data as T;
    return json as T;
  } catch { return null; }
}

async function apiPost<T>(path: string, body?: Record<string, unknown>): Promise<T | null> {
  try {
    const base = getTierAgentBase();
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) return null;
    const json = await res.json();
    if (json && typeof json === 'object' && 'data' in json) return json.data as T;
    return json as T;
  } catch { return null; }
}

function sleep(ms: number) {
  return new Promise<void>(resolve => setTimeout(resolve, ms));
}

// ─── Step runners ─────────────────────────────────────────────

async function runSessionCache(): Promise<string> {
  const maxAttempts = 30;
  for (let i = 0; i < maxAttempts; i++) {
    const data = await apiGet<{ lmdb?: { sessionCount: number } }>('/session-cache/stats');
    const count = data?.lmdb?.sessionCount ?? 0;
    if (count > 0) return `${count} sessions loaded`;
    await sleep(2000);
  }
  return 'Cache ready';
}

async function runKnowledgeGen(): Promise<string> {
  await apiPost('/knowledge/generate/all');
  const maxAttempts = 120;
  for (let i = 0; i < maxAttempts; i++) {
    await sleep(3000);
    const data = await apiGet<{ status?: string }>('/knowledge/generate/status');
    if (!data || data.status === 'idle') {
      const stats = await apiGet<{ generated?: number }>('/knowledge/generate/stats');
      const gen = stats?.generated ?? 0;
      return gen > 0 ? `${gen} documents generated` : 'Complete';
    }
  }
  return 'Complete';
}

async function runMilestonePhase1(): Promise<string> {
  const data = await apiPost<{ milestonesExtracted?: number; sessionsProcessed?: number }>('/milestone-pipeline/extract');
  const milestones = data?.milestonesExtracted ?? 0;
  const sessions = data?.sessionsProcessed ?? 0;
  if (milestones > 0) return `${milestones} milestones from ${sessions} sessions`;
  return 'No new milestones detected';
}

async function runMilestoneEnrich(): Promise<string> {
  const data = await apiPost<{ milestonesEnriched?: number; vectorsIndexed?: number }>('/milestone-pipeline/enrich-phase1', { inRangeOnly: true });
  const enriched = data?.milestonesEnriched ?? 0;
  const vectors = data?.vectorsIndexed ?? 0;
  if (enriched > 0) return `${enriched} milestones enriched, ${vectors} vectors indexed`;
  return 'No new milestones to enrich';
}

const STEP_RUNNERS: Record<string, () => Promise<string>> = {
  'session-cache': runSessionCache,
  'knowledge-gen': runKnowledgeGen,
  'milestone-phase1': runMilestonePhase1,
  'milestone-enrich': runMilestoneEnrich,
};

// ─── Hook ─────────────────────────────────────────────────────

export function useDataLoading() {
  const [steps, setSteps] = useState<LoadingStep[]>(() => INITIAL_STEPS.map(s => ({ ...s })));
  const [enabled, setEnabled] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(INITIAL_STEPS.map(s => [s.id, s.enabledByDefault]))
  );
  const [autoStart, setAutoStartState] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const [isDone, setIsDone] = useState(false);
  const [configLoaded, setConfigLoaded] = useState(false);

  // Load config from localStorage on mount
  useEffect(() => {
    const cfg = loadConfig();
    setEnabled(cfg.enabled);
    setAutoStartState(cfg.autoStart);
    setConfigLoaded(true);
  }, []);

  // Persist config whenever it changes (after initial load)
  useEffect(() => {
    if (!configLoaded) return;
    saveConfig(enabled, autoStart);
  }, [enabled, autoStart, configLoaded]);

  const updateStep = useCallback((id: string, patch: Partial<LoadingStep>) => {
    setSteps(prev => prev.map(s => s.id === id ? { ...s, ...patch } : s));
  }, []);

  const toggleStep = useCallback((id: string) => {
    setEnabled(prev => ({ ...prev, [id]: !prev[id] }));
  }, []);

  const setAutoStart = useCallback((val: boolean) => {
    setAutoStartState(val);
  }, []);

  const startLoading = useCallback(async () => {
    if (isRunning) return;
    setIsRunning(true);
    setIsDone(false);

    // Reset all steps to pending
    setSteps(INITIAL_STEPS.map(s => ({ ...s })));

    let anyError = false;

    for (const step of INITIAL_STEPS) {
      const isEnabled = step.builtin || (enabled[step.id] ?? step.enabledByDefault);

      if (!isEnabled) {
        updateStep(step.id, { status: 'skipped' });
        continue;
      }

      const runner = STEP_RUNNERS[step.id];
      if (!runner) continue;

      updateStep(step.id, { status: 'running', detail: undefined });

      try {
        const detail = await runner();
        updateStep(step.id, { status: 'complete', detail });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'Failed';
        updateStep(step.id, { status: 'error', detail: msg });
        anyError = true;
      }
    }

    setIsRunning(false);
    setIsDone(true);

    if (!anyError) {
      try { localStorage.setItem(DATA_LOADED_KEY, 'true'); } catch { /* ignore */ }
    }
  }, [isRunning, enabled, updateStep]);

  const reset = useCallback(() => {
    setSteps(INITIAL_STEPS.map(s => ({ ...s })));
    setIsRunning(false);
    setIsDone(false);
  }, []);

  const anyEnabled = Object.values(enabled).some(Boolean);

  return {
    steps,
    enabled,
    autoStart,
    isRunning,
    isDone,
    anyEnabled,
    toggleStep,
    setAutoStart,
    startLoading,
    reset,
  };
}
