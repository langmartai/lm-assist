'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { Shield, Globe, LogIn, Loader2, CheckCircle, XCircle, Info } from 'lucide-react';
import { detectAppMode, detectProxyInfo, workerFetch } from '@/lib/api-client';

type VerifyStatus = 'idle' | 'waiting' | 'verifying' | 'success' | 'error';

export default function LanBlockedPage() {
  const router = useRouter();
  const [verifyStatus, setVerifyStatus] = useState<VerifyStatus>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [cloudBound, setCloudBound] = useState<boolean | null>(null);
  const [hubDomain, setHubDomain] = useState('langmart.ai');
  const [expired, setExpired] = useState(false);

  // If user is actually local (localhost or same-machine LAN IP), redirect to dashboard
  useEffect(() => {
    const hostname = window.location.hostname;
    const isLocalhost = hostname === 'localhost' || hostname === '127.0.0.1';
    if (isLocalhost) { router.replace('/'); return; }

    const proxyInfo = detectProxyInfo();
    if (proxyInfo.isProxied) { router.replace('/'); return; }

    // Check via Core API if the request originates from this machine
    const { baseUrl } = detectAppMode();
    workerFetch(`${baseUrl}/auth/is-local`, { signal: AbortSignal.timeout(2000) })
      .then(r => r.json())
      .then(data => {
        if (data?.data?.isLocal === true) {
          router.replace('/');
        }
      })
      .catch(() => { /* not local or API unreachable — stay on blocked page */ });
  }, [router]);

  // "Session expired" vs first-time visit — the dashboard guard appends
  // ?expired=1 when it removes a stale/invalid cached token.
  useEffect(() => {
    try {
      setExpired(new URLSearchParams(window.location.search).get('expired') === '1');
    } catch { /* ignore */ }
  }, []);

  // Is a cloud account bound to this device, and which hub to sign in against?
  // Read the web's OWN same-origin /api/server — reachable from a LAN browser
  // WITHOUT the worker token (unlike /hub/status, which 401s for the exact
  // audience of this page and used to hide the Sign In button entirely).
  useEffect(() => {
    fetch('/api/server')
      .then(r => r.json())
      .then(d => {
        setCloudBound(d.cloudBound === true);
        if (d.hubDomain) setHubDomain(d.hubDomain);
      })
      .catch(() => setCloudBound(false));
  }, []);

  // Listen for postMessage from the OAuth popup (verify mode)
  useEffect(() => {
    const handler = async (event: MessageEvent) => {
      // Validate origin: must be a known platform domain (not a subdomain spoof)
      let originHost: string;
      try { originHost = new URL(event.origin).hostname; } catch { return; }
      const isValid = originHost === hubDomain || originHost === `www.${hubDomain}`;
      if (!isValid) return;
      if (event.data?.type !== 'langmart-assist-verify') return;

      const receivedKey = event.data.apiKey;
      if (!receivedKey || typeof receivedKey !== 'string') return;

      // Got the OAuth user's API key — verify against device-bound user
      setVerifyStatus('verifying');
      setErrorMessage(null);

      try {
        const res = await fetch('/api/auth/cloud-verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ apiKey: receivedKey }),
        });

        const result = await res.json();

        if (result.valid && result.token) {
          // Store the LAN access token and redirect to dashboard
          localStorage.setItem('assist_access_key', result.token);
          setVerifyStatus('success');
          setTimeout(() => {
            router.replace('/');
          }, 1500);
        } else {
          setVerifyStatus('error');
          setErrorMessage(result.error || 'Verification failed');
        }
      } catch {
        setVerifyStatus('error');
        setErrorMessage('Could not reach the verification server');
      }
    };

    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
    // NOTE: must depend on hubDomain — the handler validates event.origin against
    // it, and hubDomain is set asynchronously from /hub/status (e.g. 'xeenhub.com'
    // for the dev hub). Without this dep the handler keeps the initial
    // 'langmart.ai' value, rejects the popup's postMessage from xeenhub.com, and
    // the page hangs on "Waiting for sign in...".
  }, [router, hubDomain]);

  // Open the OAuth popup in verify mode
  const handleSignIn = useCallback(() => {
    const origin = encodeURIComponent(window.location.origin);
    setVerifyStatus('waiting');
    setErrorMessage(null);
    window.open(
      `https://${hubDomain}/assist-connect?origin=${origin}&mode=verify`,
      'langmart-verify',
      'width=460,height=560,left=200,top=100',
    );
  }, [hubDomain]);

  const showSignIn = cloudBound === true;
  // Only when we KNOW no account is bound (explicit false, not while loading) —
  // avoids the manual-steps flashing before /api/server resolves.
  const showManualSteps = cloudBound === false;

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'var(--color-bg-primary, #0a0a0a)',
        color: 'var(--color-text-primary, #e5e5e5)',
        fontFamily: 'var(--font-sans, system-ui, sans-serif)',
        padding: 20,
      }}
    >
      <div
        style={{
          maxWidth: 420,
          width: '100%',
          textAlign: 'center',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 20,
        }}
      >
        {/* Icon */}
        <div
          style={{
            width: 64,
            height: 64,
            borderRadius: '50%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: verifyStatus === 'success'
              ? 'rgba(74, 222, 128, 0.1)'
              : 'rgba(248, 113, 113, 0.1)',
            border: verifyStatus === 'success'
              ? '1px solid rgba(74, 222, 128, 0.2)'
              : '1px solid rgba(248, 113, 113, 0.2)',
            transition: 'all 0.3s',
          }}
        >
          {verifyStatus === 'success' ? (
            <CheckCircle size={28} style={{ color: 'rgba(74, 222, 128, 0.9)' }} />
          ) : (
            <Shield size={28} style={{ color: 'var(--color-status-red, #f87171)' }} />
          )}
        </div>

        {/* Title */}
        <div>
          <h1 style={{ fontSize: 20, fontWeight: 600, marginBottom: 8 }}>
            {verifyStatus === 'success'
              ? 'Access Granted'
              : expired ? 'Session Expired' : 'Access Restricted'}
          </h1>
          <p
            style={{
              fontSize: 13,
              color: 'var(--color-text-secondary, #999)',
              lineHeight: 1.7,
              maxWidth: 340,
              margin: '0 auto',
            }}
          >
            {verifyStatus === 'success'
              ? 'Identity verified. Redirecting to dashboard...'
              : expired
                ? 'Your access expired or is no longer valid. Sign in again to continue.'
                : 'This dashboard requires authentication for local network access.'}
          </p>
        </div>

        {/* Sign In button (when hub is configured) */}
        {showSignIn && verifyStatus !== 'success' && (
          <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 12 }}>
            <button
              onClick={handleSignIn}
              disabled={verifyStatus === 'waiting' || verifyStatus === 'verifying'}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 8,
                width: '100%',
                padding: '12px 20px',
                borderRadius: 10,
                border: '1px solid rgba(96, 165, 250, 0.35)',
                background: 'rgba(96, 165, 250, 0.12)',
                color: 'rgba(96, 165, 250, 1)',
                fontSize: 14,
                fontWeight: 600,
                cursor: verifyStatus === 'waiting' || verifyStatus === 'verifying' ? 'wait' : 'pointer',
                transition: 'background 0.15s',
              }}
            >
              {verifyStatus === 'waiting' || verifyStatus === 'verifying' ? (
                <Loader2 size={16} style={{ animation: 'spin 1s linear infinite' }} />
              ) : (
                <LogIn size={16} />
              )}
              {verifyStatus === 'waiting'
                ? 'Waiting for sign in...'
                : verifyStatus === 'verifying'
                  ? 'Verifying identity...'
                  : 'Sign In'}
            </button>

            {verifyStatus === 'waiting' && (
              <p style={{ fontSize: 11, color: 'var(--color-text-tertiary, #666)', lineHeight: 1.5 }}>
                Complete sign in on the popup window.
              </p>
            )}
          </div>
        )}

        {/* Error message */}
        {verifyStatus === 'error' && errorMessage && (
          <div
            style={{
              width: '100%',
              padding: '10px 14px',
              background: 'rgba(248, 113, 113, 0.08)',
              border: '1px solid rgba(248, 113, 113, 0.2)',
              borderRadius: 8,
              fontSize: 12,
              color: 'rgba(248, 113, 113, 0.9)',
              lineHeight: 1.6,
              display: 'flex',
              alignItems: 'flex-start',
              gap: 8,
              textAlign: 'left',
            }}
          >
            <XCircle size={14} style={{ flexShrink: 0, marginTop: 1 }} />
            <span>{errorMessage}</span>
          </div>
        )}

        {/* Manual steps fallback */}
        {showManualSteps && verifyStatus !== 'success' && (
          <div
            style={{
              width: '100%',
              padding: '16px 20px',
              background: 'var(--color-bg-secondary, #1a1a1a)',
              borderRadius: 10,
              textAlign: 'left',
            }}
          >
            <div
              style={{
                fontSize: 12,
                fontWeight: 600,
                marginBottom: 12,
                color: 'var(--color-text-primary, #e5e5e5)',
              }}
            >
              How to get access:
            </div>
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 10,
                fontSize: 12,
                color: 'var(--color-text-secondary, #999)',
                lineHeight: 1.6,
              }}
            >
              <StepRow n={1} text="Open the cloud dashboard on localhost and sign in" />
              <StepRow n={2} text='Click "Sign In" in Settings to bind your account' />
              <StepRow n={3} text="Return here and sign in with the same cloud account" />
            </div>
          </div>
        )}

        {/* Console limitation note */}
        {verifyStatus !== 'success' && (
          <div
            style={{
              width: '100%',
              padding: '12px 16px',
              background: 'rgba(96, 165, 250, 0.06)',
              border: '1px solid rgba(96, 165, 250, 0.15)',
              borderRadius: 8,
              display: 'flex',
              alignItems: 'flex-start',
              gap: 8,
              textAlign: 'left',
              fontSize: 11,
              color: 'var(--color-text-secondary, #999)',
              lineHeight: 1.6,
            }}
          >
            <Info size={14} style={{ flexShrink: 0, marginTop: 1, color: 'rgba(96, 165, 250, 0.7)' }} />
            <span>
              Terminal access requires localhost or cloud dashboard access.
              Sessions and projects are viewable from any authorized device.
            </span>
          </div>
        )}

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            fontSize: 11,
            color: 'var(--color-text-tertiary, #666)',
          }}
        >
          <Globe size={12} />
          <span>Localhost access is always available without authentication</span>
        </div>
      </div>

      {/* Keyframe for spinner */}
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

function StepRow({ n, text }: { n: number; text: string }) {
  return (
    <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
      <span
        style={{
          flexShrink: 0,
          width: 20,
          height: 20,
          borderRadius: '50%',
          background: 'rgba(96, 165, 250, 0.15)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 11,
          fontWeight: 600,
          color: 'rgba(96, 165, 250, 1)',
        }}
      >
        {n}
      </span>
      <span>{text}</span>
    </div>
  );
}
