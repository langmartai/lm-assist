'use client';

import { useMemo } from 'react';
import { usePathname } from 'next/navigation';
import Link from 'next/link';
import {
  Monitor,
  FolderOpen,
  MessageSquare,
  CheckSquare,
  LayoutDashboard,
  Activity,
  Settings,
  Terminal,
  Search,
  Network,
  BookOpen,
  Compass,
} from 'lucide-react';
import { useExperiment } from '@/hooks/useExperiment';
import { usePlatform } from '@/hooks/usePlatform';
import { detectProxyInfo } from '@/lib/api-client';

const baseNavItems = [
  { href: '/terminal-dashboard', icon: Terminal, label: 'Terminal Dashboard' },
  { href: '/sessions', icon: MessageSquare, label: 'Sessions' },
  { href: '/process-dashboard', icon: Activity, label: 'Process Dashboard' },
  { href: '/search', icon: Search, label: 'Search' },
  { href: '/tasks', icon: CheckSquare, label: 'Tasks' },
  { href: '/projects', icon: FolderOpen, label: 'Projects' },
  { href: '/knowledge', icon: BookOpen, label: 'Knowledge' },
  { href: '/assist-resources', icon: Compass, label: 'Assist Resources' },
  { href: '/machines', icon: Monitor, label: 'Machines' },
];

const experimentNavItems = [
  { href: '/session-dashboard', icon: LayoutDashboard, label: 'Session Dashboard' },
  { href: '/architecture', icon: Network, label: 'Architecture' },
];

/** In proxy mode, use <a> for full-page navigation (client-side nav is unreliable through the proxy shim). */
function NavItem({ href, basePath, children }: { href: string; basePath: string; children: React.ReactNode }) {
  if (basePath) {
    return <a href={`${basePath}${href}`}>{children}</a>;
  }
  return <Link href={href}>{children}</Link>;
}

export function Sidebar() {
  const pathname = usePathname();
  const { isExperiment } = useExperiment();
  const { isWindows } = usePlatform();

  const proxy = useMemo(() => {
    if (typeof window === 'undefined') return { isProxied: false, basePath: '', machineId: null };
    return detectProxyInfo();
  }, []);

  // Strip basePath prefix from pathname for active-state detection
  const effectivePath = proxy.isProxied
    ? (pathname.replace(proxy.basePath, '') || '/')
    : pathname;

  const filteredBaseNavItems = isWindows
    ? baseNavItems.filter(item => item.href !== '/terminal-dashboard' && item.href !== '/process-dashboard')
    : baseNavItems;

  const navItems = isExperiment
    ? [...filteredBaseNavItems.slice(0, isWindows ? 1 : 2), ...experimentNavItems, ...filteredBaseNavItems.slice(isWindows ? 1 : 2)]
    : filteredBaseNavItems;

  return (
    <nav className="sidebar">
      {/* Logo */}
      <div className="sidebar-item" style={{ marginBottom: 8 }}>
        <img
          src="/langmart-assist-icon.svg"
          alt="LangMart Assist"
          width={32}
          height={32}
          style={{ borderRadius: 8 }}
        />
      </div>

      {/* Nav items */}
      {navItems.map((item) => {
        const isActive = effectivePath === item.href || effectivePath.startsWith(item.href + '/');
        const Icon = item.icon;
        return (
          <NavItem key={item.href} href={item.href} basePath={proxy.basePath}>
            <div
              className={`sidebar-item ${isActive ? 'active' : ''}`}
              title={item.label}
            >
              <Icon size={18} strokeWidth={isActive ? 2 : 1.5} />
            </div>
          </NavItem>
        );
      })}

      {/* Spacer */}
      <div style={{ flex: 1 }} />

      {/* Separator + Settings */}
      <div className="sidebar-separator" />
      <NavItem href="/settings" basePath={proxy.basePath}>
        <div
          className={`sidebar-item ${effectivePath === '/settings' || effectivePath.startsWith('/settings/') ? 'active' : ''}`}
          title="Settings"
        >
          <Settings size={18} strokeWidth={effectivePath.startsWith('/settings') ? 2 : 1.5} />
        </div>
      </NavItem>
    </nav>
  );
}
