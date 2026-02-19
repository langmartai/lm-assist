'use client';

import { useEffect, useState, useCallback } from 'react';
import { useAppMode } from '@/contexts/AppModeContext';

const REDIRECT_DELAY_SECONDS = 5;
const REDIRECT_URL = 'https://langmart.ai';

/**
 * Full-screen overlay shown when the proxy session cookie expires.
 * Displays a countdown timer and redirects to langmart.ai to re-authenticate.
 */
export function SessionExpiredOverlay() {
  const { proxySessionExpired, proxy } = useAppMode();
  const [countdown, setCountdown] = useState(REDIRECT_DELAY_SECONDS);

  const redirectNow = useCallback(() => {
    window.location.href = REDIRECT_URL;
  }, []);

  useEffect(() => {
    if (!proxySessionExpired) return;

    const interval = setInterval(() => {
      setCountdown((prev) => {
        if (prev <= 1) {
          clearInterval(interval);
          redirectNow();
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(interval);
  }, [proxySessionExpired, redirectNow]);

  // Only show when in proxy mode and session has expired
  if (!proxySessionExpired || !proxy.isProxied) return null;

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9999,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: 'rgba(0, 0, 0, 0.75)',
        backdropFilter: 'blur(4px)',
      }}
    >
      <div
        style={{
          backgroundColor: '#1e293b',
          borderRadius: '12px',
          padding: '32px 40px',
          maxWidth: '420px',
          width: '90%',
          textAlign: 'center',
          boxShadow: '0 25px 50px rgba(0, 0, 0, 0.5)',
          border: '1px solid #334155',
        }}
      >
        <div
          style={{
            width: '48px',
            height: '48px',
            borderRadius: '50%',
            backgroundColor: '#7c3aed',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            margin: '0 auto 16px',
            fontSize: '24px',
          }}
        >
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <polyline points="12 6 12 12 16 14" />
          </svg>
        </div>

        <h2
          style={{
            color: '#f1f5f9',
            fontSize: '20px',
            fontWeight: 600,
            margin: '0 0 8px',
          }}
        >
          Session Expired
        </h2>

        <p
          style={{
            color: '#94a3b8',
            fontSize: '14px',
            margin: '0 0 24px',
            lineHeight: 1.5,
          }}
        >
          Your proxy session has expired. Redirecting to sign in again...
        </p>

        <div
          style={{
            color: '#e2e8f0',
            fontSize: '32px',
            fontWeight: 700,
            fontVariantNumeric: 'tabular-nums',
            margin: '0 0 24px',
          }}
        >
          {countdown}
        </div>

        <button
          onClick={redirectNow}
          style={{
            backgroundColor: '#7c3aed',
            color: 'white',
            border: 'none',
            borderRadius: '8px',
            padding: '10px 24px',
            fontSize: '14px',
            fontWeight: 500,
            cursor: 'pointer',
            transition: 'background-color 0.15s',
          }}
          onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = '#6d28d9')}
          onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = '#7c3aed')}
        >
          Go Now
        </button>
      </div>
    </div>
  );
}
