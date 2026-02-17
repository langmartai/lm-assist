'use client';

import { useState, useEffect, useMemo, useCallback } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import { useAppMode } from '@/contexts/AppModeContext';
import { useSearch } from '@/contexts/SearchContext';
import { useProjects } from '@/hooks/useProjects';
import type { ProjectArchitecture, ExternalProject, ArchitectureModelResponse } from '@/lib/types';
import { ArchitectureHeader } from './ArchitectureHeader';
import { DirectoryTree } from './DirectoryTree';
import { OverviewTab } from './OverviewTab';
import { KeyFilesTab } from './KeyFilesTab';
import { ResourcesTab } from './ResourcesTab';
import { SystemTab } from './SystemTab';

type Tab = 'system' | 'overview' | 'files' | 'resources';

/** Parse ext: prefix selection → { extProject, subDir } or null for internal */
function parseExtSelection(selectedDir: string | null, externalProjects: ExternalProject[]): {
  extProject: ExternalProject; subDir: string | null;
} | null {
  if (!selectedDir || !selectedDir.startsWith('ext:')) return null;
  // ext:langmart-assistant or ext:langmart-assistant/src/lib
  const afterExt = selectedDir.slice(4);
  const slashIdx = afterExt.indexOf('/');
  const displayName = slashIdx >= 0 ? afterExt.slice(0, slashIdx) : afterExt;
  const subDir = slashIdx >= 0 ? afterExt.slice(slashIdx + 1) : null;
  const extProject = externalProjects.find(e => e.displayName === displayName);
  if (!extProject) return null;
  return { extProject, subDir };
}

export function ArchitecturePage() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const paramProject = searchParams.get('project') || undefined;
  const machineId = searchParams.get('machine') || undefined;
  const { apiClient } = useAppMode();
  const search = useSearch();
  const { projects: availableProjects } = useProjects();

  // Default to URL param, or best available git project (prefer hasClaudeMd, then most sessions)
  const defaultProject = useMemo(() => {
    const gitProjects = availableProjects.filter(p => p.isGitProject !== false);
    // Prefer projects with CLAUDE.md (real projects, not sample), then by session count
    const withClaudeMd = gitProjects.filter(p => p.hasClaudeMd);
    const candidates = withClaudeMd.length > 0 ? withClaudeMd : gitProjects;
    return candidates.sort((a, b) => (b.sessionCount || 0) - (a.sessionCount || 0))[0]?.projectPath;
  }, [availableProjects]);
  const [selectedProject, setSelectedProject] = useState<string | undefined>(paramProject);
  const projectPath = selectedProject || paramProject || defaultProject;

  // Pin selectedProject once we resolve a default (prevents losing it on re-renders)
  useEffect(() => {
    if (paramProject) {
      setSelectedProject(paramProject);
    } else if (!selectedProject && defaultProject) {
      setSelectedProject(defaultProject);
    }
  }, [paramProject, defaultProject, selectedProject]);

  const handleProjectChange = useCallback((newPath: string) => {
    setSelectedProject(newPath);
    const params = new URLSearchParams(searchParams.toString());
    params.set('project', newPath);
    router.replace(`/architecture?${params.toString()}`);
  }, [router, searchParams]);

  const handleMilestoneClick = useCallback((directory: string) => {
    search.open('', { directory, projectPath });
  }, [search, projectPath]);

  const [data, setData] = useState<ProjectArchitecture | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedDir, setSelectedDir] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<Tab>('system');

  // Architecture model state
  const [modelResp, setModelResp] = useState<ArchitectureModelResponse | null>(null);
  const [modelLoading, setModelLoading] = useState(true);
  const [generating, setGenerating] = useState(false);

  useEffect(() => {
    if (!projectPath) return;           // Wait until we have a project
    let cancelled = false;
    setLoading(true);
    setError(null);

    apiClient.getProjectArchitecture(projectPath, machineId)
      .then(result => {
        if (cancelled) return;
        if (result) {
          setData(result);
        } else {
          setError('No architecture data available for this project');
        }
      })
      .catch(err => {
        if (cancelled) return;
        setError(err.message || 'Failed to load architecture data');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, [apiClient, projectPath, machineId]);

  // Fetch architecture model
  useEffect(() => {
    if (!projectPath) return;           // Wait until we have a project
    let cancelled = false;
    setModelLoading(true);

    apiClient.getArchitectureModel(projectPath, machineId)
      .then(result => {
        if (cancelled) return;
        setModelResp(result || null);
      })
      .catch(() => {
        // Non-fatal — model is optional
      })
      .finally(() => {
        if (!cancelled) setModelLoading(false);
      });

    return () => { cancelled = true; };
  }, [apiClient, projectPath, machineId]);

  const handleGenerate = useCallback(async () => {
    setGenerating(true);
    try {
      const result = await apiClient.generateArchitectureModel(projectPath, machineId);
      if (result) {
        setModelResp({
          model: result.model,
          stale: false,
          generatedAt: result.generatedAt,
          sessionId: result.sessionId,
        });
      }
    } catch {
      // Generation failed — no action needed
    } finally {
      setGenerating(false);
    }
  }, [apiClient, projectPath, machineId]);

  const externalProjects = useMemo(() => data?.externalProjects || [], [data]);

  const extParsed = useMemo(
    () => parseExtSelection(selectedDir, externalProjects),
    [selectedDir, externalProjects]
  );

  // Filter components/files by selectedDir
  const filteredComponents = useMemo(() => {
    if (!data) return [];
    if (extParsed) {
      const { extProject, subDir } = extParsed;
      if (!subDir) return extProject.components;
      return extProject.components.filter(c => {
        const d = c.directory === '(project root)' ? '' : c.directory;
        return d === subDir || d.startsWith(subDir + '/');
      });
    }
    if (!selectedDir) return data.components;
    return data.components.filter(c => {
      const d = c.directory === '(project root)' ? '' : c.directory;
      return d === selectedDir || d.startsWith(selectedDir + '/');
    });
  }, [data, selectedDir, extParsed]);

  const filteredKeyFiles = useMemo(() => {
    if (!data) return [];
    if (extParsed) {
      const { extProject, subDir } = extParsed;
      if (!subDir) return extProject.keyFiles;
      return extProject.keyFiles.filter(f =>
        f.filePath.startsWith(subDir + '/') || f.filePath.split('/').slice(0, -1).join('/') === subDir
      );
    }
    if (!selectedDir) return data.keyFiles;
    return data.keyFiles.filter(f =>
      f.filePath.startsWith(selectedDir + '/') || f.filePath.split('/').slice(0, -1).join('/') === selectedDir
    );
  }, [data, selectedDir, extParsed]);

  const handleSelectDir = useCallback((dir: string | null) => {
    setSelectedDir(dir);
  }, []);

  const projectName = useMemo(() => {
    if (!data?.project) return projectPath?.split('/').pop() || 'Project';
    return data.project.split('/').pop() || data.project;
  }, [data, projectPath]);

  // Label for the selected directory badge
  const selectedLabel = useMemo(() => {
    if (!selectedDir) return null;
    if (extParsed) {
      const { extProject, subDir } = extParsed;
      return subDir ? `${extProject.displayName}/${subDir}/` : `${extProject.displayName}/`;
    }
    return `${selectedDir}/`;
  }, [selectedDir, extParsed]);

  if (loading || !projectPath) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', gap: 8 }}>
        <Loader2 size={20} style={{ animation: 'spin 1s linear infinite' }} />
        <span style={{ fontSize: 13, color: 'var(--color-text-secondary)' }}>Loading architecture...</span>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 14, color: 'var(--color-status-red)', marginBottom: 8 }}>
            {error || 'No data available'}
          </div>
          <div style={{ fontSize: 12, color: 'var(--color-text-tertiary)', marginBottom: 12 }}>
            Architecture is generated from milestone history. Make sure the project has indexed sessions with milestones.
          </div>
          {availableProjects.filter(p => p.isGitProject !== false).length > 1 && (
            <select
              value={projectPath || ''}
              onChange={(e) => handleProjectChange(e.target.value)}
              style={{
                fontSize: 13,
                background: 'var(--color-bg-secondary)',
                color: 'var(--color-text-primary)',
                border: '1px solid var(--color-border-default)',
                borderRadius: 'var(--radius-sm)',
                padding: '4px 8px',
                cursor: 'pointer',
              }}
            >
              {availableProjects.filter(p => p.isGitProject !== false).map(p => (
                <option key={p.projectPath} value={p.projectPath}>{p.projectName}</option>
              ))}
            </select>
          )}
        </div>
      </div>
    );
  }

  const serviceCount = modelResp?.model?.services?.length || 0;

  const tabs: Array<{ key: Tab; label: string; count: number }> = [
    { key: 'system', label: 'System', count: serviceCount },
    { key: 'overview', label: 'Overview', count: filteredComponents.length },
    { key: 'files', label: 'Key Files', count: filteredKeyFiles.length },
    ...((data.resources || []).length > 0 ? [{ key: 'resources' as Tab, label: 'Resources', count: (data.resources || []).length }] : []),
  ];

  return (
    <div style={{ padding: 20, height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <ArchitectureHeader
        projectName={projectName}
        milestoneCount={data.milestoneCount}
        componentCount={data.components.length}
        keyFileCount={data.keyFiles.length}
        externalProjectCount={externalProjects.length}
        resourceCount={(data.resources || []).length}
        headerSlot={
          availableProjects.length > 1 ? (
            <select
              value={projectPath || ''}
              onChange={(e) => handleProjectChange(e.target.value)}
              style={{
                fontSize: 14, fontWeight: 600,
                background: 'var(--color-bg-secondary)',
                color: 'var(--color-text-primary)',
                border: '1px solid var(--color-border-default)',
                borderRadius: 'var(--radius-sm)',
                padding: '4px 8px',
                cursor: 'pointer',
                maxWidth: 300,
              }}
            >
              {availableProjects.filter(p => p.isGitProject !== false).map(p => (
                <option key={p.projectPath} value={p.projectPath}>
                  {p.projectName}
                </option>
              ))}
            </select>
          ) : undefined
        }
      />

      <div style={{ flex: 1, display: 'flex', overflow: 'hidden', gap: 16 }}>
        <DirectoryTree
          components={data.components}
          externalProjects={externalProjects}
          selectedDir={selectedDir}
          onSelectDir={handleSelectDir}
          onMilestoneClick={handleMilestoneClick}
        />

        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          {/* Tab bar */}
          <div style={{
            display: 'flex', gap: 2, marginBottom: 14,
            borderBottom: '1px solid var(--color-border-default)',
          }}>
            {tabs.map(tab => (
              <button
                key={tab.key}
                onClick={() => setActiveTab(tab.key)}
                style={{
                  padding: '6px 14px',
                  fontSize: 12,
                  fontWeight: activeTab === tab.key ? 600 : 400,
                  color: activeTab === tab.key ? 'var(--color-text-primary)' : 'var(--color-text-tertiary)',
                  background: 'transparent',
                  border: 'none',
                  borderBottom: activeTab === tab.key ? '2px solid var(--color-accent)' : '2px solid transparent',
                  cursor: 'pointer',
                  marginBottom: -1,
                  transition: 'all 0.15s',
                }}
              >
                {tab.label}
                <span style={{
                  marginLeft: 4, fontSize: 10,
                  color: 'var(--color-text-tertiary)',
                  fontFamily: 'var(--font-mono)',
                }}>
                  {tab.count}
                </span>
              </button>
            ))}
            {selectedLabel && (
              <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'flex-end', paddingRight: 8 }}>
                <span style={{
                  fontSize: 11, color: extParsed ? '#a78bfa' : 'var(--color-text-tertiary)',
                  fontFamily: 'var(--font-mono)',
                  background: 'var(--color-bg-secondary)',
                  padding: '2px 8px',
                  borderRadius: 'var(--radius-sm)',
                }}>
                  {selectedLabel}
                </span>
              </div>
            )}
          </div>

          {/* Tab content */}
          <div style={{ flex: 1, overflowY: 'auto' }} className="scrollbar-thin">
            {activeTab === 'system' && (
              <SystemTab
                model={modelResp}
                loading={modelLoading}
                generating={generating}
                onGenerate={handleGenerate}
                machineId={machineId}
              />
            )}
            {activeTab === 'overview' && (
              <OverviewTab components={filteredComponents} onSelectDir={handleSelectDir} />
            )}
            {activeTab === 'files' && (
              <KeyFilesTab
                keyFiles={filteredKeyFiles}
                externalProjects={!selectedDir ? externalProjects : undefined}
              />
            )}
            {activeTab === 'resources' && (
              <ResourcesTab resources={data.resources || []} />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
