'use client';

import { useState, useEffect, useCallback, useRef, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  Search,
  RefreshCw,
  X,
  FileText,
  Database,
  BookOpen,
  FolderOpen,
  ChevronDown,
  ChevronRight,
  ArrowDownToLine,
  ArrowLeft,
} from 'lucide-react';
import { useAppMode } from '@/contexts/AppModeContext';
import { useMachineContext } from '@/contexts/MachineContext';
import { useDeviceInfo } from '@/hooks/useDeviceInfo';

// ============================================================================
// Types
// ============================================================================

interface FileInfo {
  name: string;
  path: string;
  size: number;
  modified: string;
  category: string;
  isDirectory: boolean;
  fileCount?: number;
  children?: FileInfo[];
}

interface FilesResponse {
  root: FileInfo;
  extras: FileInfo[];
  totalFiles: number;
  totalSize: number;
  lastActivity: string | null;
}

interface FileContentResponse {
  format: 'json' | 'jsonl' | 'text' | 'markdown' | 'binary';
  path: string;
  size: number;
  modified: string;
  content?: any;
  entries?: any[];
  totalLines?: number;
  truncated?: boolean;
  message?: string;
}

interface LogResponse {
  file: string;
  format: 'jsonl' | 'text';
  entries: any[];
  totalLines: number;
  matchCount: number;
}

interface FileStatResponse {
  path: string;
  size: number;
  modified: string;
}

// ============================================================================
// Helpers
// ============================================================================

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatRelativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

function isLogFile(file: FileInfo): boolean {
  return file.name.endsWith('.log') || file.name.endsWith('.jsonl');
}

function getFileIcon(file: FileInfo): typeof FileText {
  if (file.isDirectory) return FolderOpen;
  const ext = file.name.split('.').pop()?.toLowerCase();
  if (ext === 'md') return BookOpen;
  if (ext === 'json' || ext === 'jsonl') return FileText;
  if (ext === 'mdb' || ext === 'lock') return Database;
  return FileText;
}

function findInTree(node: FileInfo | null, predicate: (f: FileInfo) => boolean): FileInfo | null {
  if (!node) return null;
  if (predicate(node)) return node;
  if (node.children) {
    for (const child of node.children) {
      const found = findInTree(child, predicate);
      if (found) return found;
    }
  }
  return null;
}

function findInTreeWithAncestors(
  node: FileInfo | null,
  predicate: (f: FileInfo) => boolean,
  ancestors: string[] = [],
): { node: FileInfo; ancestors: string[] } | null {
  if (!node) return null;
  if (predicate(node)) return { node, ancestors };
  if (node.children) {
    for (const child of node.children) {
      const found = findInTreeWithAncestors(child, predicate, [...ancestors, node.path]);
      if (found) return found;
    }
  }
  return null;
}

function countFilesInTree(node: FileInfo | null): number {
  if (!node) return 0;
  if (!node.isDirectory) return 1;
  let count = 0;
  if (node.children) {
    for (const child of node.children) {
      count += countFilesInTree(child);
    }
  }
  return count;
}

function matchesSearch(node: FileInfo, search: string): boolean {
  const lower = search.toLowerCase();
  if (node.name.toLowerCase().includes(lower)) return true;
  if (node.children) {
    return node.children.some(c => matchesSearch(c, search));
  }
  return false;
}

// ============================================================================
// Component
// ============================================================================

export function AssistResourcesPage() {
  // ── Machine-aware API routing (same pattern as KnowledgePage / useSessions) ──
  // Uses apiClient.fetchPath which routes through the correct client (local/hub)
  // with proper auth headers for remote machine access.
  const { apiClient } = useAppMode();
  const { selectedMachineId } = useMachineContext();
  const { viewMode } = useDeviceInfo();
  const isMobile = viewMode === 'mobile';

  const machineIdRef = useRef(selectedMachineId);
  machineIdRef.current = selectedMachineId;
  const apiClientRef = useRef(apiClient);
  apiClientRef.current = apiClient;

  const apiFetch = useCallback(async <T,>(path: string): Promise<T> => {
    return apiClientRef.current.fetchPath<T>(path, {
      machineId: machineIdRef.current || undefined,
    });
  }, []);

  // ── State ──
  const [rootNode, setRootNode] = useState<FileInfo | null>(null);
  const [extras, setExtras] = useState<FileInfo[]>([]);
  const [totalSize, setTotalSize] = useState(0);
  const [lastActivity, setLastActivity] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<FileInfo | null>(null);
  const [content, setContent] = useState<FileContentResponse | LogResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [listLoading, setListLoading] = useState(true);
  const [fileSearch, setFileSearch] = useState('');
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());
  const [autoScroll, setAutoScroll] = useState(true);
  const [fileChanged, setFileChanged] = useState(false);

  const contentEndRef = useRef<HTMLDivElement>(null);
  const searchTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const watchIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const selectedFileRef = useRef<FileInfo | null>(null);
  const searchTermRef = useRef<string>('');
  const watchedModifiedRef = useRef<string | null>(null);
  const autoScrollRef = useRef(true);

  // Keep refs in sync for use inside intervals
  useEffect(() => { selectedFileRef.current = selectedFile; }, [selectedFile]);
  useEffect(() => { searchTermRef.current = searchTerm; }, [searchTerm]);
  useEffect(() => { autoScrollRef.current = autoScroll; }, [autoScroll]);

  // ── Load file list ──
  const initialSelectionDone = useRef(false);
  const loadFiles = useCallback(async () => {
    setListLoading(true);
    try {
      const data = await apiFetch<FilesResponse>('/assist-resources/files?depth=3');
      setRootNode(data.root);
      setExtras(data.extras);
      setTotalSize(data.totalSize);
      setLastActivity(data.lastActivity);
      // Auto-select context-inject-hook.log on first load, expanding its parent dirs
      if (!initialSelectionDone.current) {
        initialSelectionDone.current = true;
        const result = findInTreeWithAncestors(data.root, f => f.name === 'context-inject-hook.log');
        if (result) {
          setSelectedFile(result.node);
          setExpandedDirs(new Set([...(data.root?.children ? [data.root.path] : []), ...result.ancestors]));
          watchedModifiedRef.current = result.node.modified;
          try {
            const logData = await apiFetch<LogResponse>('/assist-resources/log?file=context-inject-hook.log&limit=1000');
            setContent(logData);
          } catch { /* ignore */ }
        } else if (data.root?.children) {
          setExpandedDirs(new Set([data.root.path]));
        }
      } else if (data.root?.children) {
        setExpandedDirs(new Set([data.root.path]));
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setListLoading(false);
    }
  }, []);

  useEffect(() => { loadFiles(); }, [loadFiles]);

  // Re-fetch when selected machine changes (hybrid mode machine switching)
  useEffect(() => {
    if (!selectedMachineId) return;
    setListLoading(true);
    setSelectedFile(null);
    setContent(null);
    initialSelectionDone.current = false; // re-enable auto-select
    loadFiles();
  }, [selectedMachineId]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Load file content ──
  const loadContent = useCallback(async (file: FileInfo, search?: string) => {
    setLoading(true);
    setError(null);
    setFileChanged(false);
    try {
      if (isLogFile(file)) {
        const logName = file.name === 'mcp-calls.jsonl' ? 'mcp-calls.jsonl' : 'context-inject-hook.log';
        const searchParam = search ? `&search=${encodeURIComponent(search)}` : '';
        const data = await apiFetch<LogResponse>(`/assist-resources/log?file=${logName}&limit=1000${searchParam}`);
        setContent(data);
      } else {
        const data = await apiFetch<FileContentResponse>(`/assist-resources/file?path=${encodeURIComponent(file.path)}&limit=500`);
        setContent(data);
        watchedModifiedRef.current = data.modified;
      }
    } catch (e) {
      setError(String(e));
      setContent(null);
    } finally {
      setLoading(false);
    }
  }, []);

  // ── Auto-scroll to bottom when content changes (if enabled) ──
  useEffect(() => {
    if (content && autoScroll && contentEndRef.current) {
      contentEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [content, autoScroll]);

  // ── OS file watching via polling (2s interval) ──
  useEffect(() => {
    if (watchIntervalRef.current) {
      clearInterval(watchIntervalRef.current);
      watchIntervalRef.current = null;
    }

    if (!selectedFile || selectedFile.isDirectory) return;

    watchIntervalRef.current = setInterval(async () => {
      const file = selectedFileRef.current;
      if (!file || file.isDirectory) return;

      try {
        const stat = await apiFetch<FileStatResponse>(
          `/assist-resources/file-stat?path=${encodeURIComponent(file.path)}`
        );

        const prev = watchedModifiedRef.current;
        if (!prev) {
          watchedModifiedRef.current = stat.modified;
          return;
        }

        if (stat.modified !== prev) {
          watchedModifiedRef.current = stat.modified;
          setFileChanged(true);

          // Reload content
          if (isLogFile(file)) {
            const logName = file.name === 'mcp-calls.jsonl' ? 'mcp-calls.jsonl' : 'context-inject-hook.log';
            const searchParam = searchTermRef.current
              ? `&search=${encodeURIComponent(searchTermRef.current)}`
              : '';
            const data = await apiFetch<LogResponse>(
              `/assist-resources/log?file=${logName}&limit=1000${searchParam}`
            );
            setContent(data);
          } else {
            const data = await apiFetch<FileContentResponse>(
              `/assist-resources/file?path=${encodeURIComponent(file.path)}&limit=500`
            );
            setContent(data);
          }
        }
      } catch {
        // Silently ignore poll errors
      }
    }, 2000);

    return () => {
      if (watchIntervalRef.current) {
        clearInterval(watchIntervalRef.current);
        watchIntervalRef.current = null;
      }
    };
  }, [selectedFile]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── File selection ──
  const handleFileSelect = useCallback((file: FileInfo) => {
    if (file.isDirectory) return;
    setSelectedFile(file);
    setSearchTerm('');
    setFileChanged(false);
    watchedModifiedRef.current = file.modified;
    loadContent(file);
  }, [loadContent]);

  // ── Debounced search ──
  const handleSearchChange = useCallback((value: string) => {
    setSearchTerm(value);
    if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);
    searchTimeoutRef.current = setTimeout(() => {
      if (selectedFile && isLogFile(selectedFile)) {
        loadContent(selectedFile, value);
      }
    }, 300);
  }, [selectedFile, loadContent]);

  // ── Refresh current view ──
  const handleRefresh = useCallback(() => {
    if (selectedFile) {
      loadContent(selectedFile, searchTerm || undefined);
    }
  }, [selectedFile, searchTerm, loadContent]);

  // ── Manual scroll to bottom ──
  const handleScrollToBottom = useCallback(() => {
    contentEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  // ── Render ──
  return (
    <div style={{
      display: 'flex',
      height: '100%',
      fontFamily: "'DM Sans', sans-serif",
      color: 'var(--color-text-primary)',
    }}>
      {/* ── Left Panel: File List ── */}
      <div style={{
        width: isMobile ? '100%' : 300,
        minWidth: isMobile ? 0 : 300,
        borderRight: isMobile ? 'none' : '1px solid var(--color-border-default)',
        display: (isMobile && selectedFile) ? 'none' : 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}>
        {/* Stats strip */}
        <div style={{
          padding: '10px 14px',
          borderBottom: '1px solid var(--color-border-default)',
          display: 'flex',
          gap: 12,
          fontSize: 11,
          color: 'var(--color-text-tertiary)',
        }}>
          <span>{rootNode ? countFilesInTree(rootNode) + extras.length : 0} files</span>
          <span>{formatSize(totalSize)}</span>
          {lastActivity && <span>Active {formatRelativeTime(lastActivity)}</span>}
        </div>

        {/* Search bar */}
        <div style={{
          padding: '6px 10px',
          borderBottom: '1px solid var(--color-border-default)',
        }}>
          <div style={{
            display: 'flex',
            alignItems: 'center',
            background: 'var(--color-bg-surface)',
            border: '1px solid var(--color-border-default)',
            borderRadius: 5,
            padding: '3px 6px',
            gap: 4,
          }}>
            <Search size={12} style={{ color: 'var(--color-text-tertiary)', flexShrink: 0 }} />
            <input
              type="text"
              value={fileSearch}
              onChange={e => setFileSearch(e.target.value)}
              placeholder="Filter files..."
              style={{
                flex: 1,
                border: 'none',
                background: 'transparent',
                outline: 'none',
                fontSize: 11,
                color: 'var(--color-text-primary)',
                fontFamily: "'DM Sans', sans-serif",
              }}
            />
            {fileSearch && (
              <button
                onClick={() => setFileSearch('')}
                style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, display: 'flex' }}
              >
                <X size={11} style={{ color: 'var(--color-text-tertiary)' }} />
              </button>
            )}
          </div>
        </div>

        {/* File tree */}
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {listLoading ? (
            <div style={{ padding: 20, textAlign: 'center', color: 'var(--color-text-tertiary)', fontSize: 13 }}>
              Loading files...
            </div>
          ) : !rootNode ? (
            <div style={{ padding: 20, textAlign: 'center', color: 'var(--color-text-tertiary)', fontSize: 13 }}>
              No assist files found
            </div>
          ) : (
            <>
              {(rootNode.children || [])
                .filter(child => !fileSearch || matchesSearch(child, fileSearch))
                .map(child => (
                  <TreeNode
                    key={child.path}
                    node={child}
                    depth={0}
                    selectedPath={selectedFile?.path || null}
                    expandedDirs={expandedDirs}
                    fileSearch={fileSearch}
                    onToggleDir={(p) => {
                      setExpandedDirs(prev => {
                        const next = new Set(prev);
                        if (next.has(p)) next.delete(p); else next.add(p);
                        return next;
                      });
                    }}
                    onSelectFile={handleFileSelect}
                  />
                ))
              }
              {extras.length > 0 && (
                <>
                  <div style={{
                    padding: '6px 14px',
                    fontSize: 10,
                    fontWeight: 600,
                    color: 'var(--color-text-tertiary)',
                    textTransform: 'uppercase',
                    letterSpacing: '0.05em',
                    borderTop: '1px solid var(--color-border-default)',
                    marginTop: 4,
                  }}>
                    External Files
                  </div>
                  {extras
                    .filter(f => !fileSearch || f.name.toLowerCase().includes(fileSearch.toLowerCase()))
                    .map(file => (
                      <TreeNode
                        key={file.path}
                        node={file}
                        depth={0}
                        selectedPath={selectedFile?.path || null}
                        expandedDirs={expandedDirs}
                        fileSearch={fileSearch}
                        onToggleDir={() => {}}
                        onSelectFile={handleFileSelect}
                      />
                    ))
                  }
                </>
              )}
            </>
          )}
        </div>
      </div>

      {/* ── Right Panel: Content Viewer ── */}
      <div style={{
        flex: 1,
        display: (isMobile && !selectedFile) ? 'none' : 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}>
        {selectedFile ? (
          <>
            {/* Toolbar */}
            <div style={{
              padding: '8px 14px',
              borderBottom: '1px solid var(--color-border-default)',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              flexWrap: isMobile ? 'wrap' : undefined,
            }}>
              {isMobile && (
                <button
                  onClick={() => { setSelectedFile(null); setContent(null); }}
                  style={{
                    background: 'none',
                    border: '1px solid var(--color-border-default)',
                    borderRadius: 6,
                    cursor: 'pointer',
                    padding: '4px 6px',
                    display: 'flex',
                    alignItems: 'center',
                    color: 'var(--color-text-secondary)',
                    flexShrink: 0,
                  }}
                  title="Back to file list"
                >
                  <ArrowLeft size={12} />
                </button>
              )}
              {isLogFile(selectedFile) ? (
                <div style={{
                  flex: 1,
                  display: 'flex',
                  alignItems: 'center',
                  background: 'var(--color-bg-surface)',
                  border: '1px solid var(--color-border-default)',
                  borderRadius: 6,
                  padding: '4px 8px',
                  gap: 6,
                }}>
                  <Search size={13} style={{ color: 'var(--color-text-tertiary)', flexShrink: 0 }} />
                  <input
                    type="text"
                    value={searchTerm}
                    onChange={e => handleSearchChange(e.target.value)}
                    placeholder="Search log entries..."
                    style={{
                      flex: 1,
                      border: 'none',
                      background: 'transparent',
                      outline: 'none',
                      fontSize: 12,
                      color: 'var(--color-text-primary)',
                      fontFamily: "'DM Sans', sans-serif",
                    }}
                  />
                  {searchTerm && (
                    <button
                      onClick={() => { setSearchTerm(''); if (selectedFile) loadContent(selectedFile); }}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, display: 'flex' }}
                    >
                      <X size={13} style={{ color: 'var(--color-text-tertiary)' }} />
                    </button>
                  )}
                </div>
              ) : (
                <div style={{ flex: 1, fontSize: 13, fontWeight: 500 }}>
                  {selectedFile.name}
                </div>
              )}

              {/* Stats */}
              {content && 'matchCount' in content && (
                <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>
                  {content.matchCount} match{content.matchCount !== 1 ? 'es' : ''} / {content.totalLines} lines
                </span>
              )}
              {content && 'totalLines' in content && !('matchCount' in content) && (
                <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>
                  {(content as any).totalLines} lines
                </span>
              )}

              {/* File changed badge */}
              {fileChanged && (
                <span style={{
                  fontSize: 10,
                  color: '#f39c12',
                  background: 'rgba(243,156,18,0.12)',
                  borderRadius: 4,
                  padding: '2px 6px',
                  fontWeight: 600,
                  whiteSpace: 'nowrap',
                }}>
                  updated
                </span>
              )}

              {/* Auto-scroll checkbox */}
              <label style={{
                display: 'flex',
                alignItems: 'center',
                gap: 4,
                fontSize: 11,
                color: autoScroll ? 'var(--color-text-primary)' : 'var(--color-text-tertiary)',
                cursor: 'pointer',
                userSelect: 'none',
                whiteSpace: 'nowrap',
              }}>
                <input
                  type="checkbox"
                  checked={autoScroll}
                  onChange={e => setAutoScroll(e.target.checked)}
                  style={{ width: 12, height: 12, cursor: 'pointer', accentColor: 'var(--color-accent)' }}
                />
                Auto-scroll
              </label>

              {/* Scroll-to-bottom button */}
              <button
                onClick={handleScrollToBottom}
                title="Scroll to bottom"
                style={{
                  background: 'none',
                  border: '1px solid var(--color-border-default)',
                  borderRadius: 6,
                  cursor: 'pointer',
                  padding: '4px 6px',
                  display: 'flex',
                  alignItems: 'center',
                  color: 'var(--color-text-secondary)',
                }}
              >
                <ArrowDownToLine size={12} />
              </button>

              {/* Refresh */}
              <button
                onClick={handleRefresh}
                style={{
                  background: 'none',
                  border: '1px solid var(--color-border-default)',
                  borderRadius: 6,
                  cursor: 'pointer',
                  padding: '4px 8px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 4,
                  fontSize: 11,
                  color: 'var(--color-text-secondary)',
                }}
              >
                <RefreshCw size={12} />
                Refresh
              </button>
            </div>

            {/* Content area */}
            <div style={{ flex: 1, overflowY: 'auto', padding: 0 }}>
              {loading ? (
                <div style={{ padding: 40, textAlign: 'center', color: 'var(--color-text-tertiary)', fontSize: 13 }}>
                  Loading...
                </div>
              ) : error ? (
                <div style={{ padding: 20, color: '#e74c3c', fontSize: 13 }}>{error}</div>
              ) : content ? (
                <ContentViewer content={content} selectedFile={selectedFile} />
              ) : null}
              <div ref={contentEndRef} />
            </div>
          </>
        ) : (
          <div style={{
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'var(--color-text-tertiary)',
            fontSize: 13,
          }}>
            <div style={{ textAlign: 'center' }}>
              <FolderOpen size={32} style={{ marginBottom: 8, opacity: 0.4 }} />
              <div>Select a file to view its contents</div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ============================================================================
// Tree Node Sub-component
// ============================================================================

function TreeNode({
  node,
  depth,
  selectedPath,
  expandedDirs,
  fileSearch,
  onToggleDir,
  onSelectFile,
}: {
  node: FileInfo;
  depth: number;
  selectedPath: string | null;
  expandedDirs: Set<string>;
  fileSearch: string;
  onToggleDir: (path: string) => void;
  onSelectFile: (file: FileInfo) => void;
}) {
  const isSelected = selectedPath === node.path;
  const isExpanded = expandedDirs.has(node.path);
  const Icon = getFileIcon(node);
  const indent = 14 + depth * 16;

  if (node.isDirectory) {
    const children = (node.children || []).filter(
      child => !fileSearch || matchesSearch(child, fileSearch)
    );
    return (
      <>
        <div
          onClick={() => onToggleDir(node.path)}
          style={{
            padding: '6px 14px',
            paddingLeft: indent,
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            borderBottom: '1px solid var(--color-border-default)',
          }}
        >
          {isExpanded
            ? <ChevronDown size={12} style={{ color: 'var(--color-text-tertiary)', flexShrink: 0 }} />
            : <ChevronRight size={12} style={{ color: 'var(--color-text-tertiary)', flexShrink: 0 }} />
          }
          <FolderOpen size={13} style={{ color: 'var(--color-text-secondary)', flexShrink: 0 }} />
          <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--color-text-primary)', flex: 1 }}>
            {node.name}
          </span>
          <span style={{ fontSize: 10, color: 'var(--color-text-tertiary)' }}>
            {node.fileCount ?? children.length}
          </span>
        </div>
        {isExpanded && children.map(child => (
          <TreeNode
            key={child.path}
            node={child}
            depth={depth + 1}
            selectedPath={selectedPath}
            expandedDirs={expandedDirs}
            fileSearch={fileSearch}
            onToggleDir={onToggleDir}
            onSelectFile={onSelectFile}
          />
        ))}
      </>
    );
  }

  return (
    <div
      onClick={() => onSelectFile(node)}
      style={{
        padding: '6px 14px',
        paddingLeft: indent + 18,
        cursor: 'pointer',
        borderLeft: isSelected ? '3px solid var(--color-accent)' : '3px solid transparent',
        background: isSelected ? 'var(--color-bg-surface)' : 'transparent',
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        borderBottom: '1px solid var(--color-border-default)',
      }}
    >
      <Icon size={13} style={{ color: 'var(--color-text-secondary)', flexShrink: 0 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          fontSize: 12,
          fontWeight: isSelected ? 600 : 400,
          color: 'var(--color-text-primary)',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}>
          {node.name}
        </div>
      </div>
      <div style={{
        fontSize: 10,
        color: 'var(--color-text-tertiary)',
        whiteSpace: 'nowrap',
        textAlign: 'right',
      }}>
        <div>{formatSize(node.size)}</div>
        <div style={{ marginTop: 1 }}>{formatRelativeTime(node.modified)}</div>
      </div>
    </div>
  );
}

// ============================================================================
// Content Viewer Sub-component
// ============================================================================

function ContentViewer({ content, selectedFile }: { content: FileContentResponse | LogResponse; selectedFile: FileInfo }) {
  if ('file' in content) {
    const logContent = content as LogResponse;

    if (logContent.format === 'jsonl') {
      return (
        <div style={{ padding: '4px 0' }}>
          {logContent.entries.length === 0 ? (
            <div style={{ padding: 20, textAlign: 'center', color: 'var(--color-text-tertiary)', fontSize: 13 }}>
              No entries found
            </div>
          ) : (
            logContent.entries.map((entry, i) => (
              <McpCallCard key={i} entry={entry} />
            ))
          )}
        </div>
      );
    }

    // Special rich rendering for context-inject-hook.log
    if (selectedFile.name === 'context-inject-hook.log') {
      return <ContextInjectLogViewer entries={logContent.entries.map(String)} />;
    }

    return (
      <div style={{ padding: '4px 0' }}>
        {logContent.entries.length === 0 ? (
          <div style={{ padding: 20, textAlign: 'center', color: 'var(--color-text-tertiary)', fontSize: 13 }}>
            No entries found
          </div>
        ) : (
          logContent.entries.map((line, i) => (
            <div
              key={i}
              style={{
                padding: '3px 14px',
                fontSize: 12,
                fontFamily: "'JetBrains Mono', monospace",
                color: 'var(--color-text-primary)',
                borderBottom: '1px solid var(--color-border-default)',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-all',
              }}
            >
              {String(line)}
            </div>
          ))
        )}
      </div>
    );
  }

  const fileContent = content as FileContentResponse;

  if (fileContent.format === 'binary') {
    return (
      <div style={{
        padding: 40,
        textAlign: 'center',
        color: 'var(--color-text-tertiary)',
        fontSize: 13,
      }}>
        <Database size={32} style={{ marginBottom: 8, opacity: 0.4 }} />
        <div>{fileContent.message}</div>
        <div style={{ marginTop: 4, fontSize: 11 }}>{formatSize(fileContent.size)}</div>
      </div>
    );
  }

  if (fileContent.format === 'json') {
    return (
      <pre style={{
        padding: 14,
        fontSize: 12,
        fontFamily: "'JetBrains Mono', monospace",
        color: 'var(--color-text-primary)',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-all',
        margin: 0,
      }}>
        {JSON.stringify(fileContent.content, null, 2)}
      </pre>
    );
  }

  if (fileContent.format === 'jsonl' && fileContent.entries) {
    return (
      <div style={{ padding: '4px 0' }}>
        {fileContent.entries.map((entry, i) => (
          <div
            key={i}
            style={{
              padding: '4px 14px',
              fontSize: 11,
              fontFamily: "'JetBrains Mono', monospace",
              color: 'var(--color-text-primary)',
              borderBottom: '1px solid var(--color-border-default)',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-all',
            }}
          >
            {JSON.stringify(entry, null, 2)}
          </div>
        ))}
      </div>
    );
  }

  return (
    <pre style={{
      padding: 14,
      fontSize: 12,
      fontFamily: "'JetBrains Mono', monospace",
      color: 'var(--color-text-primary)',
      whiteSpace: 'pre-wrap',
      wordBreak: 'break-all',
      margin: 0,
    }}>
      {fileContent.content}
      {fileContent.truncated && (
        <div style={{
          marginTop: 8,
          padding: '8px 12px',
          background: 'var(--color-bg-surface)',
          borderRadius: 6,
          color: 'var(--color-text-tertiary)',
          fontSize: 11,
          fontFamily: "'DM Sans', sans-serif",
        }}>
          File truncated at 1MB. Total size: {formatSize(fileContent.size)}
        </div>
      )}
    </pre>
  );
}

// ============================================================================
// MCP Call Card (for mcp-calls.jsonl entries)
// ============================================================================

const TOOL_COLORS: Record<string, string> = {
  search: '#3498db',
  detail: '#9b59b6',
  feedback: '#e67e22',
};

function McpCallCard({ entry }: { entry: any }) {
  const isError = entry.isError || !!entry.error;
  const tool = entry.tool || entry.name || entry.method || 'unknown';
  const toolColor = TOOL_COLORS[tool] || '#95a5a6';
  const query: string = entry.args?.query || entry.args?.id || entry.args?.content || '';
  const result: string = entry.result || entry.responsePreview || (isError ? entry.error : '') || '';

  return (
    <div style={{
      padding: '12px 14px',
      borderBottom: '1px solid var(--color-border-default)',
      borderLeft: `3px solid ${isError ? '#e74c3c' : toolColor}`,
    }}>
      {/* Query */}
      <div style={{
        fontSize: 12,
        fontWeight: 600,
        color: 'var(--color-text-primary)',
        marginBottom: result ? 8 : 0,
      }}>
        <span style={{
          fontSize: 10,
          fontWeight: 700,
          color: toolColor,
          marginRight: 6,
          textTransform: 'uppercase',
        }}>
          {tool}
        </span>
        {query || '(no input)'}
      </div>

      {/* Result — always shown, rendered as markdown */}
      {result && (
        isError ? (
          <div style={{
            fontSize: 11,
            color: '#e74c3c',
            fontFamily: "'JetBrains Mono', monospace",
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}>
            {result}
          </div>
        ) : (
          <div className="mcp-result-md">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{result}</ReactMarkdown>
          </div>
        )
      )}
    </div>
  );
}

// ============================================================================
// Context-Inject Log Viewer
// ============================================================================

const START_LOG_RE = /^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\] START session=([a-f0-9-]+) port=(\d+) prompt="(.*)"/;
const END_LOG_RE = /^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\] END session=([a-f0-9-]+) (.+)/;

interface HookBlock {
  timestamp: string;
  session: string;
  port: string;
  prompt: string;
  contextLines: string[];
  endStats?: string;
  endTimestamp?: string;
}

function parseHookBlocks(entries: string[]): { blocks: HookBlock[]; orphans: string[] } {
  const blocks: HookBlock[] = [];
  const orphans: string[] = [];
  let current: HookBlock | null = null;

  for (const line of entries) {
    const startM = line.match(START_LOG_RE);
    if (startM) {
      if (current) blocks.push(current);
      current = { timestamp: startM[1], session: startM[2], port: startM[3], prompt: startM[4], contextLines: [] };
      continue;
    }
    const endM = line.match(END_LOG_RE);
    if (endM && current) {
      current.endTimestamp = endM[1];
      current.endStats = endM[3];
      blocks.push(current);
      current = null;
      continue;
    }
    if (current) {
      current.contextLines.push(line);
    } else if (line.trim()) {
      orphans.push(line);
    }
  }
  if (current) blocks.push(current);
  return { blocks, orphans };
}

// Render text with clickable [KXXX.X] and [session-uuid:N] links
function renderWithLinks(text: string) {
  const LINK_RE = /\[(K\d+(?:\.\d+)?)\]|\[([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})(?::(\d+))?\]/g;
  const matches = Array.from(text.matchAll(LINK_RE));
  if (matches.length === 0) return <>{text}</>;
  const parts: ReactNode[] = [];
  let last = 0;

  for (const m of matches) {
    const idx = m.index!;
    if (idx > last) parts.push(text.slice(last, idx));
    if (m[1]) {
      const kid = m[1];
      parts.push(
        <a
          key={`k-${idx}`}
          href={`/knowledge?highlight=${encodeURIComponent(kid)}`}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          style={{
            color: '#e67e22',
            background: 'rgba(230,126,34,0.13)',
            padding: '0 4px',
            borderRadius: 3,
            textDecoration: 'none',
            fontWeight: 700,
            fontSize: '0.9em',
          }}
        >
          [{kid}]
        </a>
      );
    } else {
      const sid = m[2];
      const lineN = m[3];
      parts.push(
        <a
          key={`s-${idx}`}
          href={`/sessions/${sid}`}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          style={{
            color: '#5dade2',
            background: 'rgba(93,173,226,0.12)',
            padding: '0 4px',
            borderRadius: 3,
            textDecoration: 'none',
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: '0.85em',
          }}
        >
          [{sid.slice(0, 8)}&hellip;{lineN ? `:${lineN}` : ''}]
        </a>
      );
    }
    last = idx + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <>{parts}</>;
}

function ContextContent({ lines }: { lines: string[] }) {
  if (lines.length === 0) return null;
  return (
    <div style={{ padding: '6px 14px 10px' }}>
      {lines.map((line, i) => {
        // Section header: ## Relevant Context
        if (line.startsWith('## ')) {
          return (
            <div key={i} style={{
              fontWeight: 700,
              fontSize: 10,
              color: 'var(--color-text-tertiary)',
              margin: '10px 0 4px',
              paddingBottom: 3,
              borderBottom: '1px solid var(--color-border-default)',
              textTransform: 'uppercase',
              letterSpacing: '0.07em',
            }}>
              {line.replace(/^## /, '')}
            </div>
          );
        }

        // Sub-header: **Knowledge:** / **Recent work:**
        const boldMatch = line.match(/^\*\*([^*]+)\*\*/);
        if (boldMatch) {
          return (
            <div key={i} style={{
              fontWeight: 600,
              fontSize: 11,
              color: 'var(--color-text-primary)',
              margin: '7px 0 2px',
            }}>
              {boldMatch[1]}
            </div>
          );
        }

        // List items
        if (line.startsWith('- ')) {
          return (
            <div key={i} style={{ display: 'flex', gap: 5, padding: '2px 0', lineHeight: 1.5 }}>
              <span style={{ color: 'var(--color-text-tertiary)', flexShrink: 0, fontSize: 10, marginTop: 2 }}>▸</span>
              <span style={{ fontSize: 11, color: 'var(--color-text-secondary)', flex: 1, wordBreak: 'break-word' }}>
                {renderWithLinks(line.slice(2))}
              </span>
            </div>
          );
        }

        // Blank line
        if (line.trim() === '') return <div key={i} style={{ height: 3 }} />;

        // Continuation / table rows — very dimmed
        return (
          <div key={i} style={{
            fontSize: 10,
            color: 'var(--color-text-tertiary)',
            fontFamily: "'JetBrains Mono', monospace",
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-all',
            paddingLeft: 12,
            opacity: 0.65,
          }}>
            {renderWithLinks(line)}
          </div>
        );
      })}
    </div>
  );
}

function HookInvocationCard({ block, defaultExpanded }: { block: HookBlock; defaultExpanded: boolean }) {
  const [expanded, setExpanded] = useState(defaultExpanded);

  const statsMatch = block.endStats?.match(/durationMs=(\d+)\s+sources=(\d+)\s+tokens=(\d+)/);
  const duration = statsMatch?.[1];
  const sources = statsMatch?.[2];
  const tokens = statsMatch?.[3];
  const nonEmptyLines = block.contextLines.filter(l => l.trim()).length;

  return (
    <div style={{
      margin: '4px 8px',
      border: '1px solid var(--color-border-default)',
      borderRadius: 8,
      overflow: 'hidden',
    }}>
      {/* Header — click to expand/collapse */}
      <div
        onClick={() => setExpanded(!expanded)}
        style={{
          padding: '8px 12px',
          cursor: 'pointer',
          background: 'var(--color-bg-surface)',
          borderLeft: '3px solid var(--color-accent)',
        }}
      >
        {/* Meta row */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: block.prompt ? 5 : 0, flexWrap: 'wrap' }}>
          <span style={{
            fontSize: 10,
            color: 'var(--color-text-tertiary)',
            fontFamily: "'JetBrains Mono', monospace",
            flexShrink: 0,
          }}>
            {block.timestamp}
          </span>
          <a
            href={`/sessions/${block.session}`}
            target="_blank"
            rel="noopener noreferrer"
            onClick={e => e.stopPropagation()}
            style={{
              fontSize: 10,
              color: '#5dade2',
              fontFamily: "'JetBrains Mono', monospace",
              background: 'rgba(93,173,226,0.12)',
              padding: '1px 6px',
              borderRadius: 4,
              textDecoration: 'none',
              flexShrink: 0,
            }}
          >
            {block.session.slice(0, 8)}&hellip;
          </a>
          <span style={{ fontSize: 10, color: 'var(--color-text-tertiary)', opacity: 0.6 }}>
            :{block.port}
          </span>
          {sources && (
            <span style={{
              fontSize: 10,
              color: '#27ae60',
              background: 'rgba(39,174,96,0.1)',
              padding: '1px 5px',
              borderRadius: 3,
              flexShrink: 0,
            }}>
              {sources} sources
            </span>
          )}
          {tokens && (
            <span style={{ fontSize: 10, color: 'var(--color-text-tertiary)' }}>
              {tokens} tok
            </span>
          )}
          {duration && (
            <span style={{ fontSize: 10, color: 'var(--color-text-tertiary)' }}>
              {duration}ms
            </span>
          )}
          <div style={{ flex: 1 }} />
          <span style={{ fontSize: 10, color: 'var(--color-text-tertiary)' }}>
            {expanded ? '▲' : '▼'} {nonEmptyLines}
          </span>
        </div>

        {/* Prompt — the most important thing, prominent */}
        {block.prompt && (
          <div style={{
            fontSize: 12,
            color: 'var(--color-text-primary)',
            fontWeight: 500,
            lineHeight: 1.45,
            whiteSpace: expanded ? 'normal' : 'nowrap',
            overflow: expanded ? 'visible' : 'hidden',
            textOverflow: expanded ? 'clip' : 'ellipsis',
          }}>
            {block.prompt}
          </div>
        )}
      </div>

      {/* Injected context */}
      {expanded && block.contextLines.length > 0 && (
        <div style={{ borderTop: '1px solid var(--color-border-default)' }}>
          <ContextContent lines={block.contextLines} />
        </div>
      )}
    </div>
  );
}

function ContextInjectLogViewer({ entries }: { entries: string[] }) {
  const { blocks, orphans } = parseHookBlocks(entries);

  if (blocks.length === 0 && orphans.length === 0) {
    return (
      <div style={{ padding: 20, textAlign: 'center', color: 'var(--color-text-tertiary)', fontSize: 13 }}>
        No entries found
      </div>
    );
  }

  return (
    <div style={{ padding: '4px 0' }}>
      {orphans.map((line, i) => (
        <div key={`orphan-${i}`} style={{
          padding: '2px 14px',
          fontSize: 11,
          fontFamily: "'JetBrains Mono', monospace",
          color: 'var(--color-text-tertiary)',
        }}>
          {line}
        </div>
      ))}
      {blocks.map((block, i) => (
        <HookInvocationCard
          key={`block-${i}-${block.timestamp}`}
          block={block}
          defaultExpanded={i === blocks.length - 1}
        />
      ))}
    </div>
  );
}
