import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatTimeAgo(date: Date | string | number): string {
  const now = Date.now();
  const then = new Date(date).getTime();
  const seconds = Math.floor((now - then) / 1000);

  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(date).toLocaleDateString();
}

export function formatRelativeTime(date: Date | string | number): string {
  const now = Date.now();
  const then = new Date(date).getTime();
  const seconds = Math.floor((now - then) / 1000);

  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;
  return new Date(date).toLocaleDateString();
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

export function formatCost(cost: number): string {
  return `$${cost.toFixed(2)}`;
}

export function formatCostPrecise(cost: number): string {
  return `$${cost.toFixed(4)}`;
}

export function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen) + '...';
}

export function getModelShortName(model: string): string {
  if (!model) return 'claude';
  const m = model.toLowerCase();
  if (m.includes('opus-4-5')) return 'Opus 4.5';
  if (m.includes('opus-4')) return 'Opus 4';
  if (m.includes('sonnet-4')) return 'Sonnet 4';
  if (m.includes('sonnet-3-5') || m.includes('sonnet-3.5')) return 'Sonnet 3.5';
  if (m.includes('sonnet')) return 'Sonnet';
  if (m.includes('haiku-3-5') || m.includes('haiku-3.5')) return 'Haiku 3.5';
  if (m.includes('haiku')) return 'Haiku';
  if (m.includes('opus')) return 'Opus';
  // Fallback: strip date suffix and "claude-" prefix
  return model.replace(/[-_]\d{8}$/, '').replace(/^claude-/, '');
}

export function getPlatformEmoji(platform: string): string {
  const p = platform?.toLowerCase() || '';
  if (p.includes('darwin') || p.includes('mac')) return '🍎';
  if (p.includes('win')) return '🪟';
  return '🐧';
}

export function getSessionIdShort(sessionId: string): string {
  return sessionId?.slice(0, 8) || '';
}
