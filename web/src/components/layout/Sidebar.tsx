'use client';

import { usePathname } from 'next/navigation';
import Link from 'next/link';
import Image from 'next/image';
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

const navItems = [
  { href: '/terminal-dashboard', icon: Terminal, label: 'Terminal Dashboard' },
  { href: '/sessions', icon: MessageSquare, label: 'Sessions' },
  { href: '/terminals', icon: LayoutDashboard, label: 'Session Dashboard' },
  { href: '/process-dashboard', icon: Activity, label: 'Process Dashboard' },
  { href: '/search', icon: Search, label: 'Search' },
  { href: '/tasks', icon: CheckSquare, label: 'Tasks' },
  { href: '/projects', icon: FolderOpen, label: 'Projects' },
  { href: '/architecture', icon: Network, label: 'Architecture' },
  { href: '/knowledge', icon: BookOpen, label: 'Knowledge' },
  { href: '/assist-navi', icon: Compass, label: 'Assist Navi' },
  { href: '/machines', icon: Monitor, label: 'Machines' },
];

export function Sidebar() {
  const pathname = usePathname();

  return (
    <nav className="sidebar">
      {/* Logo */}
      <div className="sidebar-item" style={{ marginBottom: 8 }}>
        <Image
          src="/langmart-assist-icon.svg"
          alt="LangMart Assist"
          width={32}
          height={32}
          style={{ borderRadius: 8 }}
        />
      </div>

      {/* Nav items */}
      {navItems.map((item) => {
        const isActive = pathname === item.href || pathname.startsWith(item.href + '/');
        const Icon = item.icon;
        return (
          <Link key={item.href} href={item.href}>
            <div
              className={`sidebar-item ${isActive ? 'active' : ''}`}
              title={item.label}
            >
              <Icon size={18} strokeWidth={isActive ? 2 : 1.5} />
            </div>
          </Link>
        );
      })}

      {/* Spacer */}
      <div style={{ flex: 1 }} />

      {/* Separator + Settings */}
      <div className="sidebar-separator" />
      <Link href="/settings">
        <div
          className={`sidebar-item ${pathname === '/settings' || pathname.startsWith('/settings/') ? 'active' : ''}`}
          title="Settings"
        >
          <Settings size={18} strokeWidth={pathname.startsWith('/settings') ? 2 : 1.5} />
        </div>
      </Link>
    </nav>
  );
}
