'use client';

import { useEffect, useRef } from 'react';
import { Mic } from 'lucide-react';
import { useAppMode } from '@/contexts/AppModeContext';
import { buildVoiceWsUrl } from '@/lib/voice-url';
import { useDictation } from '@/hooks/useDictation';

/**
 * Self-contained voice DICTATION button. Drop it next to any text input:
 *   <MicButton value={prompt} onChange={setPrompt} />
 *
 * Click to start (it stays listening — no press-and-hold), speak, click again to stop. The live
 * transcript is mirrored into `value` via `onChange`, appended after whatever was already typed.
 * Computes its own relay URL from the page's app-mode/proxy state and renders NOTHING when voice
 * can't work here (insecure origin, hub-proxied/remote node) so callers never show a dead button.
 */
export function MicButton({ value, onChange, size = 14, className, disabled }: {
  value: string;
  onChange: (next: string) => void;
  size?: number;
  className?: string;
  disabled?: boolean;
}) {
  const { proxy } = useAppMode();
  const isRemoteNode = proxy.isProxied || !!proxy.machineId;
  let wsUrl: string | null = null;
  try { wsUrl = buildVoiceWsUrl({ isRemoteNode }); } catch { wsUrl = null; }

  const dict = useDictation({ wsUrl: wsUrl || '' });
  const baseRef = useRef<string | null>(null);

  // Mirror the growing transcript into the field while the mic is active, appended after any
  // typed text. Release the base once dictation ends so the inserted text persists.
  useEffect(() => {
    if (dict.state === 'listening' || dict.state === 'transcribing') {
      if (baseRef.current === null) baseRef.current = value;
      const base = baseRef.current;
      onChange((base.trim() ? base.trimEnd() + ' ' : '') + dict.text);
    } else if (dict.state === 'idle' || dict.state === 'error') {
      baseRef.current = null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dict.text, dict.state]);

  if (!wsUrl || !dict.supported) return null;
  const listening = dict.state === 'listening';
  return (
    <button
      type="button"
      className={className ?? 'btn btn-ghost btn-sm btn-icon'}
      disabled={disabled}
      title={dict.state === 'error' ? (dict.error || 'Voice error') : listening ? 'Click to stop' : 'Click to talk (dictate)'}
      onClick={() => { if (listening) void dict.stop(); else if (dict.state === 'idle' || dict.state === 'error') void dict.start(); }}
      style={{ color: listening ? 'var(--color-accent)' : undefined }}
    >
      <Mic size={size} />
    </button>
  );
}
