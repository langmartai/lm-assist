'use client';

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  Search,
  RefreshCw,
  X,
  FileText,
  Database,
  BookOpen,
  Milestone,
  Cpu,
  FolderOpen,
  AlertCircle,
  ChevronDown,
} from 'lucide-react';

// ============================================================================
// API helpers
// ============================================================================

function getApiBase(): string {
  if (typeof window === 'undefined') return 'http://localhost:3100';
  const port = process.env.NEXT_PUBLIC_LOCAL_API_PORT || '3100';
  return `http://${window.location.hostname}:${port}`;
}

async function apiFetch<T>(path: string): Promise<T> {
  const res = await fetch(`${getApiBase()}${path}`);
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text().catch(() => res.statusText)}`);
  const json = await res.json();
  if (json && typeof json === 'object' && json.success === false) {
    throw new Error(json.error?.message || json.error || 'Request failed');
  }
  if (json && typeof json === 'object' && 'data' in json) return json.data as T;
  return json as T;
}

// ============================================================================
// Types
// ============================================================================

interface FileInfo {
  name: string;
  path: string;
  size: number;
  modified: string;
  type: string;
  category: string;
  isDirectory: boolean;
  fileCount?: number;
}

interface FilesResponse {
  files: FileInfo[];
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

const TYPE_COLORS: Record<string, string> = {
  log: '#e67e22',
  knowledge: '#3498db',
  milestone: '#9b59b6',
  store: '#1abc9c',
  cache: '#1abc9c',
  architecture: '#e74c3c',
  config: '#95a5a6',
};

const TYPE_ICONS: Record<string, typeof FileText> = {
  log: AlertCircle,
  knowledge: BookOpen,
  milestone: Milestone,
  store: Database,
  cache: Database,
  architecture: Cpu,
  config: FileText,
};

function isLogFile(file: FileInfo): boolean {
  return file.name.endsWith('.log') || file.name.endsWith('.jsonl');
}

// ============================================================================
// Component
// ============================================================================

export function AssistNaviPage() {
  // ── State ──
  const [files, setFiles] = useState<FileInfo[]>([]);
  const [totalSize, setTotalSize] = useState(0);
  const [lastActivity, setLastActivity] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<FileInfo | null>(null);
  const [content, setContent] = useState<FileContentResponse | LogResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [listLoading, setListLoading] = useState(true);
  const [filterCategory, setFilterCategory] = useState<string>('all');
  const [fileSearch, setFileSearch] = useState('');
  const [filterOpen, setFilterOpen] = useState(false);

  const contentEndRef = useRef<HTMLDivElement>(null);
  const searchTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const filterRef = useRef<HTMLDivElement>(null);

  // ── Category counts ──
  const categoryCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const f of files) {
      counts[f.category] = (counts[f.category] || 0) + 1;
    }
    return counts;
  }, [files]);

  const categories = useMemo(() => Object.keys(categoryCounts).sort(), [categoryCounts]);

  // ── Filtered file list ──
  const filteredFiles = useMemo(() => {
    let result = files;
    if (filterCategory !== 'all') {
      result = result.filter(f => f.category === filterCategory);
    }
    if (fileSearch) {
      const lower = fileSearch.toLowerCase();
      result = result.filter(f => f.name.toLowerCase().includes(lower) || f.category.toLowerCase().includes(lower));
    }
    return result;
  }, [files, filterCategory, fileSearch]);

  // ── Close dropdown on outside click ──
  useEffect(() => {
    if (!filterOpen) return;
    const handler = (e: MouseEvent) => {
      if (filterRef.current && !filterRef.current.contains(e.target as Node)) {
        setFilterOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [filterOpen]);

  // ── Load file list ──
  const initialSelectionDone = useRef(false);
  const loadFiles = useCallback(async () => {
    setListLoading(true);
    try {
      const data = await apiFetch<FilesResponse>('/assist-navi/files');
      setFiles(data.files);
      setTotalSize(data.totalSize);
      setLastActivity(data.lastActivity);
      // Auto-select context-inject-hook.log on first load
      if (!initialSelectionDone.current) {
        initialSelectionDone.current = true;
        const hookLog = data.files.find(f => f.name === 'context-inject-hook.log');
        if (hookLog) {
          setSelectedFile(hookLog);
          // Inline content load to avoid stale closure
          try {
            const logData = await apiFetch<LogResponse>('/assist-navi/log?file=context-inject-hook.log&limit=300');
            setContent(logData);
          } catch { /* ignore — user can click manually */ }
        }
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setListLoading(false);
    }
  }, []);

  useEffect(() => { loadFiles(); }, [loadFiles]);

  // ── Load file content ──
  const loadContent = useCallback(async (file: FileInfo, search?: string) => {
    setLoading(true);
    setError(null);
    try {
      if (isLogFile(file)) {
        const logName = file.name === 'mcp-calls.jsonl' ? 'mcp-calls.jsonl' : 'context-inject-hook.log';
        const searchParam = search ? `&search=${encodeURIComponent(search)}` : '';
        const data = await apiFetch<LogResponse>(`/assist-navi/log?file=${logName}&limit=300${searchParam}`);
        setContent(data);
      } else {
        const data = await apiFetch<FileContentResponse>(`/assist-navi/file?path=${encodeURIComponent(file.path)}&limit=500`);
        setContent(data);
      }
    } catch (e) {
      setError(String(e));
      setContent(null);
    } finally {
      setLoading(false);
    }
  }, []);

  // ── Auto-scroll to bottom for logs ──
  useEffect(() => {
    if (content && contentEndRef.current) {
      contentEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [content]);

  // ── File selection ──
  const handleFileSelect = useCallback((file: FileInfo) => {
    if (file.isDirectory) return;
    setSelectedFile(file);
    setSearchTerm('');
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
        width: 300,
        minWidth: 300,
        borderRight: '1px solid var(--color-border-default)',
        display: 'flex',
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
          <span>{filteredFiles.length}{filterCategory !== 'all' || fileSearch ? `/${files.length}` : ''} files</span>
          <span>{formatSize(totalSize)}</span>
          {lastActivity && <span>Active {formatRelativeTime(lastActivity)}</span>}
        </div>

        {/* Filter bar: search + category dropdown */}
        <div style={{
          padding: '6px 10px',
          borderBottom: '1px solid var(--color-border-default)',
          display: 'flex',
          gap: 6,
          alignItems: 'center',
        }}>
          {/* Quick search */}
          <div style={{
            flex: 1,
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

          {/* Category dropdown */}
          <div ref={filterRef} style={{ position: 'relative' }}>
            <button
              onClick={() => setFilterOpen(!filterOpen)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 4,
                background: filterCategory !== 'all' ? 'var(--color-accent)' : 'var(--color-bg-surface)',
                color: filterCategory !== 'all' ? '#fff' : 'var(--color-text-secondary)',
                border: `1px solid ${filterCategory !== 'all' ? 'var(--color-accent)' : 'var(--color-border-default)'}`,
                borderRadius: 5,
                padding: '3px 8px',
                fontSize: 11,
                cursor: 'pointer',
                fontFamily: "'DM Sans', sans-serif",
                whiteSpace: 'nowrap',
              }}
            >
              {filterCategory === 'all' ? 'All' : filterCategory}
              <ChevronDown size={11} />
            </button>

            {filterOpen && (
              <div style={{
                position: 'absolute',
                top: '100%',
                right: 0,
                marginTop: 4,
                background: 'var(--color-bg-primary)',
                border: '1px solid var(--color-border-default)',
                borderRadius: 6,
                boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
                zIndex: 100,
                minWidth: 180,
                overflow: 'hidden',
              }}>
                {/* All option */}
                <button
                  onClick={() => { setFilterCategory('all'); setFilterOpen(false); }}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    width: '100%',
                    padding: '6px 10px',
                    border: 'none',
                    background: filterCategory === 'all' ? 'var(--color-bg-surface)' : 'transparent',
                    cursor: 'pointer',
                    fontSize: 11,
                    color: 'var(--color-text-primary)',
                    fontFamily: "'DM Sans', sans-serif",
                    textAlign: 'left',
                  }}
                >
                  <span>All</span>
                  <span style={{
                    fontSize: 10,
                    color: 'var(--color-text-tertiary)',
                    background: 'var(--color-bg-surface)',
                    padding: '1px 6px',
                    borderRadius: 8,
                  }}>
                    {files.length}
                  </span>
                </button>

                {categories.map(cat => (
                  <button
                    key={cat}
                    onClick={() => { setFilterCategory(cat); setFilterOpen(false); }}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      width: '100%',
                      padding: '6px 10px',
                      border: 'none',
                      background: filterCategory === cat ? 'var(--color-bg-surface)' : 'transparent',
                      cursor: 'pointer',
                      fontSize: 11,
                      color: 'var(--color-text-primary)',
                      fontFamily: "'DM Sans', sans-serif",
                      textAlign: 'left',
                    }}
                  >
                    <span>{cat}</span>
                    <span style={{
                      fontSize: 10,
                      color: 'var(--color-text-tertiary)',
                      background: 'var(--color-bg-surface)',
                      padding: '1px 6px',
                      borderRadius: 8,
                    }}>
                      {categoryCounts[cat]}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* File list */}
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {listLoading ? (
            <div style={{ padding: 20, textAlign: 'center', color: 'var(--color-text-tertiary)', fontSize: 13 }}>
              Loading files...
            </div>
          ) : filteredFiles.length === 0 ? (
            <div style={{ padding: 20, textAlign: 'center', color: 'var(--color-text-tertiary)', fontSize: 13 }}>
              {files.length === 0 ? 'No assist files found' : 'No files match filter'}
            </div>
          ) : (
            filteredFiles.map((file, i) => {
              const isSelected = selectedFile?.path === file.path;
              const color = TYPE_COLORS[file.type] || '#95a5a6';
              const Icon = TYPE_ICONS[file.type] || FileText;
              return (
                <div
                  key={file.path + i}
                  onClick={() => handleFileSelect(file)}
                  style={{
                    padding: '8px 14px',
                    cursor: file.isDirectory ? 'default' : 'pointer',
                    borderLeft: isSelected ? `3px solid var(--color-accent)` : '3px solid transparent',
                    background: isSelected ? 'var(--color-bg-surface)' : 'transparent',
                    opacity: file.isDirectory ? 0.7 : 1,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    borderBottom: '1px solid var(--color-border-default)',
                  }}
                >
                  {/* Type dot */}
                  <Icon size={14} style={{ color, flexShrink: 0 }} />

                  {/* File info */}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{
                      fontSize: 12,
                      fontWeight: isSelected ? 600 : 400,
                      color: 'var(--color-text-primary)',
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    }}>
                      {file.name}
                    </div>
                    <div style={{
                      fontSize: 10,
                      color: 'var(--color-text-tertiary)',
                      marginTop: 1,
                    }}>
                      {file.category}
                    </div>
                  </div>

                  {/* Size / file count badge */}
                  <div style={{
                    fontSize: 10,
                    color: 'var(--color-text-tertiary)',
                    whiteSpace: 'nowrap',
                    textAlign: 'right',
                  }}>
                    <div>{file.isDirectory ? `${file.fileCount ?? 0} files` : formatSize(file.size)}</div>
                    <div style={{ marginTop: 1 }}>{formatRelativeTime(file.modified)}</div>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* ── Right Panel: Content Viewer ── */}
      <div style={{
        flex: 1,
        display: 'flex',
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
            }}>
              {/* Search (only for log files) */}
              {isLogFile(selectedFile) && (
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
                      style={{
                        background: 'none',
                        border: 'none',
                        cursor: 'pointer',
                        padding: 0,
                        display: 'flex',
                      }}
                    >
                      <X size={13} style={{ color: 'var(--color-text-tertiary)' }} />
                    </button>
                  )}
                </div>
              )}

              {!isLogFile(selectedFile) && (
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
                  {content.totalLines} lines
                </span>
              )}

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
// Content Viewer Sub-component
// ============================================================================

function ContentViewer({ content, selectedFile }: { content: FileContentResponse | LogResponse; selectedFile: FileInfo }) {
  // Log viewer mode (from /assist-navi/log)
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

    // Plain text log
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

  // File viewer mode (from /assist-navi/file)
  const fileContent = content as FileContentResponse;

  // Binary
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

  // JSON
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

  // JSONL (from file endpoint)
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

  // Markdown or text
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

function McpCallCard({ entry }: { entry: any }) {
  const [expanded, setExpanded] = useState(false);
  const isError = entry.error || entry.status === 'error';
  const tool = entry.tool || entry.name || entry.method || 'unknown';
  const duration = entry.durationMs || entry.duration;
  const timestamp = entry.timestamp || entry.ts;

  return (
    <div
      onClick={() => setExpanded(!expanded)}
      style={{
        margin: '2px 8px',
        padding: '6px 10px',
        borderLeft: `3px solid ${isError ? '#e74c3c' : '#2ecc71'}`,
        background: 'var(--color-bg-surface)',
        borderRadius: '0 6px 6px 0',
        cursor: 'pointer',
        fontSize: 12,
      }}
    >
      {/* Header row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {/* Tool badge */}
        <span style={{
          fontSize: 11,
          fontWeight: 600,
          fontFamily: "'JetBrains Mono', monospace",
          color: 'var(--color-text-primary)',
        }}>
          {tool}
        </span>

        {/* Duration */}
        {duration != null && (
          <span style={{ fontSize: 10, color: 'var(--color-text-tertiary)' }}>
            {duration}ms
          </span>
        )}

        <div style={{ flex: 1 }} />

        {/* Timestamp */}
        {timestamp && (
          <span style={{ fontSize: 10, color: 'var(--color-text-tertiary)' }}>
            {formatRelativeTime(timestamp)}
          </span>
        )}
      </div>

      {/* Args preview (collapsed) */}
      {!expanded && entry.args && (
        <div style={{
          marginTop: 3,
          fontSize: 10,
          color: 'var(--color-text-tertiary)',
          fontFamily: "'JetBrains Mono', monospace",
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}>
          {typeof entry.args === 'string' ? entry.args : JSON.stringify(entry.args)}
        </div>
      )}

      {/* Error message */}
      {isError && entry.error && !expanded && (
        <div style={{
          marginTop: 3,
          fontSize: 10,
          color: '#e74c3c',
          fontFamily: "'JetBrains Mono', monospace",
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}>
          {typeof entry.error === 'string' ? entry.error : JSON.stringify(entry.error)}
        </div>
      )}

      {/* Expanded detail */}
      {expanded && (
        <pre style={{
          marginTop: 6,
          fontSize: 10,
          fontFamily: "'JetBrains Mono', monospace",
          color: 'var(--color-text-secondary)',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-all',
          margin: '6px 0 0 0',
          padding: 0,
          background: 'transparent',
        }}>
          {JSON.stringify(entry, null, 2)}
        </pre>
      )}
    </div>
  );
}
