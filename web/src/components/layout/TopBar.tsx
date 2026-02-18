'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import Link from 'next/link';
import { Search, Globe, Monitor, CloudOff, Maximize2, LogOut, Info } from 'lucide-react';
import { useAppMode } from '@/contexts/AppModeContext';
import { detectProxyInfo } from '@/lib/api-client';
import { useTheme } from '@/contexts/ThemeContext';
import { useSearch } from '@/contexts/SearchContext';
import { MachineDropdown } from './MachineDropdown';
import { BackgroundProgress } from './BackgroundProgress';


/** Extract initials from a display name or email */
function getInitials(name?: string, email?: string): string {
  if (name) {
    const parts = name.trim().split(/\s+/);
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
    return parts[0][0]?.toUpperCase() || 'U';
  }
  if (email) return email[0].toUpperCase();
  return 'U';
}

export function TopBar() {
  const pathname = usePathname();
  const router = useRouter();
  const { proxy, hubUser, localGatewayId } = useAppMode();
  const { theme, toggleTheme } = useTheme();
  const { open: openSearch } = useSearch();
  const [mounted, setMounted] = useState(false);
  const [inIframe, setInIframe] = useState(false);
  const [localIp, setLocalIp] = useState<string | null>(null);
  const [lanEnabled, setLanEnabled] = useState(false);
  const [lanAuthEnabled, setLanAuthEnabled] = useState(false);
  const [lanAccessToken, setLanAccessToken] = useState<string | null>(null);
  const [showUserMenu, setShowUserMenu] = useState(false);
  const userMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setMounted(true);
    try { setInIframe(window.self !== window.top); } catch { setInIframe(true); }
    const proxyInfo = detectProxyInfo();
    const apiBase = proxyInfo.isProxied ? proxyInfo.basePath : '';
    fetch(`${apiBase}/api/server`)
      .then(r => r.json())
      .then(d => {
        if (d.localIp) setLocalIp(d.localIp);
        if (typeof d.lanEnabled === 'boolean') setLanEnabled(d.lanEnabled);
        if (typeof d.lanAuthEnabled === 'boolean') setLanAuthEnabled(d.lanAuthEnabled);
      })
      .catch(() => {});
    // Fetch LAN access token for building Switch to Local URL (only served to localhost/proxy)
    fetch(`${apiBase}/api/auth/token`)
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        if (d?.lanAccessToken) setLanAccessToken(d.lanAccessToken);
      })
      .catch(() => {});
  }, []);

  const isLocalhost = typeof window !== 'undefined' && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1');

  // Close user menu on click outside
  useEffect(() => {
    if (!showUserMenu) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (userMenuRef.current && !userMenuRef.current.contains(e.target as Node)) {
        setShowUserMenu(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showUserMenu]);

  const handleLogout = useCallback(() => {
    localStorage.removeItem('assist_access_key');
    setShowUserMenu(false);
    router.push('/lan-blocked');
  }, [router]);

  const isCloud = proxy.isProxied;
  const gatewayId = proxy.machineId || localGatewayId;
  const hubName = typeof window !== 'undefined' && window.location.hostname.includes('langmart')
    ? 'langmart.ai'
    : 'xeenhub.com';
  const currentPage = pathname.replace(proxy.basePath, '') || '/session-dashboard';
  const cloudUrl = gatewayId ? `https://${hubName}/w/${gatewayId}/assist${currentPage}` : null;
  const localHost = localIp && localIp !== 'localhost' ? localIp : 'localhost';
  const localBaseUrl = `http://${localHost}:3848`;
  const localUrl = lanAuthEnabled && lanAccessToken
    ? `${localBaseUrl}/auth?token=${encodeURIComponent(lanAccessToken)}&redirect=${encodeURIComponent(currentPage)}`
    : `${localBaseUrl}${currentPage}`;

  return (
    <div className="topbar">

      {mounted && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <MachineDropdown />
          {isCloud ? (
            <>
              <div className="topbar-connection proxied">
                <Globe size={11} />
                <span>Cloud</span>
              </div>
              <a
                href={localUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="topbar-connection local"
                style={{ textDecoration: 'none', cursor: 'pointer', opacity: 0.6 }}
              >
                <Monitor size={11} />
                <span>Switch to Local</span>
              </a>
            </>
          ) : (
            <>
              {cloudUrl && (
                <a
                  href={cloudUrl}
                  className="topbar-connection proxied"
                  style={{ textDecoration: 'none', cursor: 'pointer', opacity: 0.6 }}
                >
                  <Globe size={11} />
                  <span>Cloud</span>
                </a>
              )}
              <div className="topbar-connection local">
                <Monitor size={11} />
                <span>Local</span>
              </div>
            </>
          )}
        </div>
      )}

      {/* Fullscreen: open in new tab when inside proxy iframe */}
      {mounted && isCloud && inIframe && (
        <button
          className="topbar-connection proxied"
          style={{ cursor: 'pointer', border: 'none', background: 'none' }}
          title="Open in new tab"
          onClick={() => window.open(window.location.href, '_blank')}
        >
          <Maximize2 size={11} />
          <span>Fullscreen</span>
        </button>
      )}

      <BackgroundProgress />

      <div style={{ flex: 1 }} />

      {/* Search trigger */}
      <div
        style={{ position: 'relative', cursor: 'pointer' }}
        onClick={() => openSearch()}
      >
        <Search
          size={14}
          style={{
            position: 'absolute',
            left: 8,
            top: '50%',
            transform: 'translateY(-50%)',
            color: 'var(--color-text-tertiary)',
          }}
        />
        <input
          className="input input-with-icon"
          placeholder="Search... ⌘K"
          style={{ width: 200, paddingLeft: 28, fontSize: 11, cursor: 'pointer' }}
          readOnly
          onClick={() => openSearch()}
        />
      </div>

      {/* Theme toggle */}
      {mounted && (
        <button
          className="topbar-theme-toggle"
          onClick={toggleTheme}
          title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
        >
          {theme === 'dark' ? (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="5" />
              <line x1="12" y1="1" x2="12" y2="3" />
              <line x1="12" y1="21" x2="12" y2="23" />
              <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
              <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
              <line x1="1" y1="12" x2="3" y2="12" />
              <line x1="21" y1="12" x2="23" y2="12" />
              <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
              <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
            </svg>
          ) : (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
            </svg>
          )}
        </button>
      )}

      {/* User area */}
      {mounted && hubUser ? (
        <div className="topbar-user-wrapper" ref={userMenuRef}>
          <div
            className="topbar-user"
            onClick={() => setShowUserMenu(v => !v)}
            style={{ cursor: 'pointer' }}
          >
            {hubUser.avatarUrl ? (
              <img
                src={hubUser.avatarUrl}
                alt={hubUser.displayName || hubUser.email}
                className="topbar-avatar"
                width={26}
                height={26}
                referrerPolicy="no-referrer"
              />
            ) : (
              <div className="topbar-avatar topbar-avatar-initials">
                {getInitials(hubUser.displayName, hubUser.email)}
              </div>
            )}
            <div className="topbar-user-info">
              <span className="topbar-user-name">
                {hubUser.displayName || hubUser.email.split('@')[0]}
              </span>
            </div>
          </div>
          {showUserMenu && (
            <div className="topbar-user-menu">
              <div className="topbar-user-menu-header">
                <span className="topbar-user-menu-name">{hubUser.displayName || hubUser.email.split('@')[0]}</span>
                <span className="topbar-user-menu-email">{hubUser.email}</span>
              </div>
              <div className="topbar-user-menu-divider" />
              {!isCloud && (
                <button
                  className="topbar-user-menu-item"
                  disabled={isLocalhost}
                  onClick={isLocalhost ? undefined : handleLogout}
                >
                  <LogOut size={14} />
                  <span>Sign Out</span>
                  {isLocalhost && (
                    <span className="topbar-user-menu-info-icon" title="Localhost always has access. Go to Settings to disconnect from cloud.">
                      <Info size={12} />
                    </span>
                  )}
                </button>
              )}
              {isLocalhost && (
                <div className="topbar-user-menu-info">
                  Localhost has permanent access.{' '}
                  <Link href="/settings" onClick={() => setShowUserMenu(false)}>Disconnect in Settings</Link>
                </div>
              )}
            </div>
          )}
        </div>
      ) : mounted && !isCloud ? (
        <Link href="/settings" style={{ textDecoration: 'none' }}>
          <div className="topbar-connect-cloud" title="Connect to cloud to access from anywhere">
            <CloudOff size={14} />
            <span>Connect to Cloud</span>
          </div>
        </Link>
      ) : (
        <div className="topbar-avatar topbar-avatar-initials">U</div>
      )}
    </div>
  );
}
