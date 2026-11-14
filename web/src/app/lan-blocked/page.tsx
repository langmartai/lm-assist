'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { Shield, Globe, LogIn, Loader2, CheckCircle, XCircle, Info, RefreshCw } from 'lucide-react';
import { bootstrapBrowserAuth, detectProxyInfo, resetBrowserToken } from '@/lib/api-client';

type VerifyStatus = 'idle' | 'waiting' | 'verifying' | 'success' | 'error';

const UNREACHABLE_MESSAGE = "Can't reach this device's API right now. Try again.";

export default function LanBlockedPage() {
  const router = useRouter();
  const [verifyStatus, setVerifyStatus] = useState<VerifyStatus>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [cloudBound, setCloudBound] = useState<boolean | null>(null);
  const [expired, setExpired] = useState(false);
  const [unreachable, setUnreachable] = useState(false);
  const [probing, setProbing] = useState(false);
  // Set when this load carries an OIDC grant; the access probe then stays out of the
  // way so it cannot race the grant's own redirect to returnTo.
  const grantedRef = useRef(false);

  // Fragment grant handoff from /api/auth/oidc-callback (#granted=<token>&returnTo=<path>).
  // Runs first, before any other mount effect, so the token is captured and the
  // hash scrubbed from the URL/history before anything else can act on the page.
  useEffect(() => {
    const h = new URLSearchParams(window.location.hash.replace(/^#/, ''));
    const granted = h.get('granted');
    if (!granted) return;
    grantedRef.current = true;
    localStorage.setItem('assist_access_key', granted);
    // A token cached (or a refusal cached) under the previous key must not outlive it.
    resetBrowserToken();
    const rt = h.get('returnTo') || '/';
    // Same-origin relative path only — mirrors oidc-start/oidc-callback's safeReturnTo guard.
    const dest = /^\/(?![/\\])[^\x00-\x1f\x7f]*$/.test(rt) ? rt : '/';
    window.history.replaceState({}, '', '/lan-blocked'); // scrub the token from the URL/history
    setVerifyStatus('success');
    setTimeout(() => router.replace(dest), 800);
  }, [router]);

  // Already allowed in (this machine's own browser, or a LAN key Core accepts)?
  // Ask Core directly — it judges the real socket peer — and go to the dashboard
  // only on a grant. No blanket localhost redirect: when Core refuses a localhost
  // page (e.g. an origin it does not recognise), bouncing to / would loop with the
  // dashboard guard, which sends that page right back here.
  const probeAccess = useCallback(async () => {
    setProbing(true);
    try {
      const { status } = await bootstrapBrowserAuth({ force: true });
      if (grantedRef.current) return;
      if (status === 'ok' || status === 'not-needed') { router.replace('/'); return; }
      if (status === 'unreachable') {
        setUnreachable(true);
        setErrorMessage(UNREACHABLE_MESSAGE);
      } else {
        // Core answered (with a refusal), so a stale "can't reach" notice is wrong now.
        setUnreachable(false);
        setErrorMessage((m) => (m === UNREACHABLE_MESSAGE ? null : m));
      }
    } finally {
      setProbing(false);
    }
  }, [router]);

  useEffect(() => {
    if (grantedRef.current) return;
    if (detectProxyInfo().isProxied) { router.replace('/'); return; }
    void probeAccess();
  }, [router, probeAccess]);

  // "Session expired" vs first-time visit — the dashboard guard appends
  // ?expired=1 when it removes a stale/invalid cached token.
  useEffect(() => {
    try {
      setExpired(new URLSearchParams(window.location.search).get('expired') === '1');
    } catch { /* ignore */ }
  }, []);

  // Sign-in failure — /api/auth/oidc-callback (and oidc-start, on misconfiguration)
  // redirects here with ?error=<code>. Surfaced via errorMessage alone; verifyStatus
  // stays idle so the Sign In button is immediately available again for a retry.
  useEffect(() => {
    const code = new URLSearchParams(window.location.search).get('error');
    if (!code) return;
    if (code === 'unreachable') setUnreachable(true);
    setErrorMessage(
      code === 'owner_mismatch'
        ? "This account is not the owner bound to this device. Sign in with the device owner's account."
        : code === 'no_hub'
          ? 'This device is not connected to a cloud account. Connect it on localhost first.'
          : code === 'unreachable'
            ? UNREACHABLE_MESSAGE
            : code === 'lan_disabled'
              ? 'LAN access is turned off on this device. Turn on "Allow LAN devices" in Settings on the device itself.'
              : 'Sign-in failed. Try again.',
    );
  }, []);

  // Is a cloud account bound to this device? Read the web's OWN same-origin
  // /api/server — reachable from a LAN browser WITHOUT the worker token (unlike
  // /hub/status, which 401s for the exact audience of this page and used to hide
  // the Sign In button entirely).
  useEffect(() => {
    fetch('/api/server')
      .then(r => r.json())
      .then(d => setCloudBound(d.cloudBound === true))
      .catch(() => setCloudBound(false));
  }, []);

  // Same-tab redirect into the OIDC code+PKCE flow (oidc-start mints the
  // verifier/state/nonce cookie and 302s to the platform's authorize endpoint).
  const handleSignIn = useCallback(() => {
    setVerifyStatus('waiting');
    window.location.href = '/api/auth/oidc-start?returnTo=%2F';
  }, []);

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
                ? 'Redirecting to sign in...'
                : verifyStatus === 'verifying'
                  ? 'Verifying identity...'
                  : 'Sign In'}
            </button>

            {verifyStatus === 'waiting' && (
              <p style={{ fontSize: 11, color: 'var(--color-text-tertiary, #666)', lineHeight: 1.5 }}>
                Taking you to your cloud account to sign in.
              </p>
            )}
          </div>
        )}

        {/* Error message */}
        {errorMessage && (
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

        {/* Core unreachable: the guard failed closed. Let the user re-ask Core. */}
        {unreachable && verifyStatus !== 'success' && (
          <button
            onClick={() => { void probeAccess(); }}
            disabled={probing}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 8,
              padding: '8px 16px',
              borderRadius: 8,
              border: '1px solid rgba(255, 255, 255, 0.12)',
              background: 'transparent',
              color: 'var(--color-text-secondary, #999)',
              fontSize: 12,
              cursor: probing ? 'wait' : 'pointer',
            }}
          >
            {probing
              ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} />
              : <RefreshCw size={14} />}
            Try again
          </button>
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
