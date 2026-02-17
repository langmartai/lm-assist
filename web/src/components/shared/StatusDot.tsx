'use client';

interface StatusDotProps {
  status: 'online' | 'offline' | 'running' | 'in-progress' | 'error';
  size?: number;
}

export function StatusDot({ status, size }: StatusDotProps) {
  return (
    <span
      className={`status-dot ${status}`}
      style={size ? { width: size, height: size } : undefined}
    />
  );
}
