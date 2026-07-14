'use client';

import { useEffect, useRef, useState } from 'react';

/** Pull the human message out of the api-client's `API 400: {json}` throw shape. */
export function errText(e: unknown): string {
  const s = String(e);
  const m = s.match(/API \d+:\s*(\{[\s\S]*\})/);
  if (m) { try { return JSON.parse(m[1])?.error?.message || s; } catch { /* fall through */ } }
  return s.replace(/^Error:\s*/, '');
}

/** Compact relative time for a millisecond timestamp: "just now" / "Nm ago" /
 *  "Nh ago" / "Nd ago" / else a locale date. Non-finite or non-positive input
 *  (missing/unknown timestamp) renders nothing rather than "NaNm ago". */
export function timeAgo(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const diff = Date.now() - ms;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(ms).toLocaleDateString();
}

/**
 * Two-step inline confirm — an in-page alternative to a native browser
 * confirm dialog. First click "arms" the button (shows confirmLabel with
 * amber/rose emphasis); a second click within 3s fires onConfirm. Arming
 * auto-disarms after 3s or on blur. Disables itself while onConfirm's
 * promise is in flight so a slow click can't
 * double-fire (e.g. a double-click DELETE).
 */
export function ConfirmButton({ label, confirmLabel, onConfirm, className }: {
  label: string;
  confirmLabel: string;
  onConfirm: () => void | Promise<void>;
  className?: string;
}) {
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => () => {
    mountedRef.current = false;
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  const disarm = () => {
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
    setArmed(false);
  };

  const handleClick = async () => {
    if (busy) return;
    if (!armed) {
      setArmed(true);
      timerRef.current = setTimeout(disarm, 3000);
      return;
    }
    disarm();
    setBusy(true);
    try {
      await onConfirm();
    } finally {
      // onConfirm's success path may unmount this button (e.g. delete → onClose)
      if (mountedRef.current) setBusy(false);
    }
  };

  return (
    <button
      type="button"
      onClick={() => void handleClick()}
      onBlur={disarm}
      disabled={busy}
      className={
        className ||
        (armed
          ? 'px-2 py-0.5 rounded bg-rose-700 text-rose-50 hover:bg-rose-600 text-xs disabled:opacity-50'
          : 'px-2 py-0.5 rounded bg-rose-900 text-rose-100 hover:bg-rose-800 text-xs disabled:opacity-50')
      }
    >
      {busy ? '…' : armed ? confirmLabel : label}
    </button>
  );
}
