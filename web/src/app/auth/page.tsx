'use client';

import { Suspense, useEffect, useRef, useState } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { Shield, CheckCircle, XCircle, Loader2 } from 'lucide-react';
import { resetBrowserToken } from '@/lib/api-client';

function AuthContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const [status, setStatus] = useState<'validating' | 'success' | 'error'>('validating');
  const [message, setMessage] = useState('Validating access token...');
  // The scrub below rewrites the URL, which Next reflects into useSearchParams and so
  // re-runs this effect with no token. Handle the link exactly once.
  const handledRef = useRef(false);

  useEffect(() => {
    if (handledRef.current) return;
    handledRef.current = true;
    const token = searchParams.get('token');
    const rawRedirect = searchParams.get('redirect') || '/session-dashboard';
    // Prevent open redirect — only allow relative paths
    const redirect = rawRedirect.startsWith('/') && !rawRedirect.startsWith('//') ? rawRedirect : '/session-dashboard';
    // Legacy ?token= links only — nothing generates them any more, because a key in a
    // URL leaks into history, bookmarks and Referer. Scrub it from the address bar and
    // history before doing anything else with it.
    window.history.replaceState(null, '', '/auth');

    if (!token) {
      setStatus('error');
      setMessage('No access key provided. Sign in from this dashboard\'s access page instead.');
      return;
    }

    fetch('/api/auth/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    })
      .then((r) => r.json())
      .then((data) => {
        if (data.valid) {
          localStorage.setItem('assist_access_key', token);
          // Anything cached under the previous key (a token or a refusal) is stale now.
          resetBrowserToken();
          setStatus('success');
          setMessage('Access granted. Redirecting...');
          setTimeout(() => {
            router.replace(redirect);
          }, 500);
        } else {
          setStatus('error');
          setMessage('This access link is no longer valid. Sign in from this dashboard\'s access page instead.');
        }
      })
      .catch(() => {
        setStatus('error');
        setMessage('Failed to validate token. Please try again.');
      });
  }, [searchParams, router]);

  return (
    <div
      style={{
        maxWidth: 400,
        width: '100%',
        textAlign: 'center',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 16,
      }}
    >
      <div
        style={{
          width: 56,
          height: 56,
          borderRadius: '50%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background:
            status === 'validating'
              ? 'rgba(96, 165, 250, 0.1)'
              : status === 'success'
                ? 'rgba(74, 222, 128, 0.1)'
                : 'rgba(248, 113, 113, 0.1)',
          border: `1px solid ${
            status === 'validating'
              ? 'rgba(96, 165, 250, 0.2)'
              : status === 'success'
                ? 'rgba(74, 222, 128, 0.2)'
                : 'rgba(248, 113, 113, 0.2)'
          }`,
        }}
      >
        {status === 'validating' && (
          <Loader2 size={24} className="spin" style={{ color: 'rgba(96, 165, 250, 1)' }} />
        )}
        {status === 'success' && (
          <CheckCircle size={24} style={{ color: 'var(--color-status-green, #4ade80)' }} />
        )}
        {status === 'error' && (
          <XCircle size={24} style={{ color: 'var(--color-status-red, #f87171)' }} />
        )}
      </div>

      <div>
        <h1
          style={{
            fontSize: 18,
            fontWeight: 600,
            marginBottom: 8,
          }}
        >
          {status === 'validating'
            ? 'Authenticating...'
            : status === 'success'
              ? 'Access Granted'
              : 'Access Denied'}
        </h1>
        <p
          style={{
            fontSize: 13,
            color: 'var(--color-text-secondary, #999)',
            lineHeight: 1.6,
          }}
        >
          {message}
        </p>
      </div>

      {status === 'error' && (
        <div
          style={{
            marginTop: 8,
            padding: '12px 16px',
            background: 'var(--color-bg-secondary, #1a1a1a)',
            borderRadius: 8,
            fontSize: 12,
            color: 'var(--color-text-tertiary, #666)',
            lineHeight: 1.6,
          }}
        >
          <Shield
            size={14}
            style={{ display: 'inline', verticalAlign: 'middle', marginRight: 6 }}
          />
          To access this dashboard from the local network, open it and use
          &quot;Sign In&quot; with the cloud account that owns this device.
        </div>
      )}
    </div>
  );
}

export default function AuthPage() {
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
      <Suspense
        fallback={
          <div style={{ textAlign: 'center' }}>
            <Loader2 size={24} className="spin" style={{ color: 'rgba(96, 165, 250, 1)' }} />
          </div>
        }
      >
        <AuthContent />
      </Suspense>
    </div>
  );
}
