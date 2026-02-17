'use client';

import { useMemo } from 'react';
import { FileCode, ExternalLink } from 'lucide-react';
import type { ArchitectureKeyFile, ExternalProject } from '@/lib/types';

interface Props {
  keyFiles: ArchitectureKeyFile[];
  externalProjects?: ExternalProject[];
}

interface DisplayKeyFile extends ArchitectureKeyFile {
  externalProject?: string;
}

export function KeyFilesTab({ keyFiles, externalProjects }: Props) {
  // Merge external key files when showing "All" (externalProjects is passed)
  const allFiles = useMemo(() => {
    const files: DisplayKeyFile[] = keyFiles.map(f => ({ ...f }));
    if (externalProjects && externalProjects.length > 0) {
      for (const ext of externalProjects) {
        for (const f of ext.keyFiles.slice(0, 10)) {
          files.push({ ...f, externalProject: ext.displayName });
        }
      }
      files.sort((a, b) => (b.modifyCount + b.readCount) - (a.modifyCount + a.readCount));
    }
    return files;
  }, [keyFiles, externalProjects]);

  if (allFiles.length === 0) {
    return (
      <div style={{ padding: 40, textAlign: 'center', color: 'var(--color-text-tertiary)', fontSize: 13 }}>
        No key files in this directory
      </div>
    );
  }

  const maxWrites = Math.max(...allFiles.map(f => f.modifyCount), 1);
  const maxReads = Math.max(...allFiles.map(f => f.readCount), 1);
  const maxTotal = Math.max(maxWrites, maxReads);

  return (
    <div>
      <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-text-tertiary)', marginBottom: 10, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
        Most Active Files
      </div>
      <div style={{ display: 'flex', gap: 16, fontSize: 10, color: 'var(--color-text-tertiary)', marginBottom: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <div style={{ width: 10, height: 10, borderRadius: 2, background: '#fbbf24', opacity: 0.8 }} />
          Writes
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <div style={{ width: 10, height: 10, borderRadius: 2, background: '#60a5fa', opacity: 0.8 }} />
          Reads
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {allFiles.map((file, i) => (
          <div
            key={file.externalProject ? `${file.externalProject}:${file.filePath}` : file.filePath}
            style={{
              padding: '10px 12px',
              borderRadius: 'var(--radius-sm)',
              background: 'var(--color-bg-secondary)',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
              <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-text-tertiary)', fontFamily: 'var(--font-mono)', width: 20, flexShrink: 0 }}>
                {i + 1}
              </span>
              {file.externalProject ? (
                <ExternalLink size={12} style={{ color: '#a78bfa', flexShrink: 0 }} />
              ) : (
                <FileCode size={12} style={{ color: 'var(--color-text-tertiary)', flexShrink: 0 }} />
              )}
              <span style={{
                fontSize: 12, fontFamily: 'var(--font-mono)', color: 'var(--color-text-primary)',
                flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}>
                {file.externalProject && (
                  <span style={{
                    fontSize: 10, color: '#a78bfa', fontWeight: 500,
                    background: 'rgba(167, 139, 250, 0.1)',
                    padding: '1px 5px', borderRadius: 3, marginRight: 5,
                  }}>
                    {file.externalProject}
                  </span>
                )}
                {file.filePath}
              </span>
              <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)', fontFamily: 'var(--font-mono)', flexShrink: 0 }}>
                {file.modifyCount}W {file.readCount}R
              </span>
            </div>

            {/* Heat bars */}
            <div style={{ position: 'relative', height: 6, marginLeft: 26 }}>
              {/* Writes bar */}
              <div style={{
                position: 'absolute', top: 0, left: 0, height: 3,
                width: `${(file.modifyCount / maxTotal) * 100}%`,
                background: '#fbbf24', opacity: 0.8,
                borderRadius: 2, minWidth: file.modifyCount > 0 ? 3 : 0,
              }} />
              {/* Reads bar */}
              <div style={{
                position: 'absolute', top: 3, left: 0, height: 3,
                width: `${(file.readCount / maxTotal) * 100}%`,
                background: '#60a5fa', opacity: 0.8,
                borderRadius: 2, minWidth: file.readCount > 0 ? 3 : 0,
              }} />
            </div>

            {file.lastMilestoneTitle && (
              <div style={{
                fontSize: 10, color: 'var(--color-text-tertiary)', marginTop: 4, marginLeft: 26,
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}>
                Last: {file.lastMilestoneTitle}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
