'use client';

import { useState, useEffect, useCallback } from 'react';
import { useAppMode } from '@/contexts/AppModeContext';
import { detectAppMode } from '@/lib/api-client';
import { useExperiment } from '@/hooks/useExperiment';
import { usePlatform } from '@/hooks/usePlatform';
import {
  Settings,
  Globe,
  Monitor,
  CheckCircle,
  XCircle,
  RefreshCw,
  ExternalLink,
  User,
  Shield,
  Copy,
  Eye,
  EyeOff,
  Key,
  Pencil,
  Plug,
  Unplug,
  Trash2,
  Loader2,
  Info,
  Terminal,
  Download,
  X,
  AlertTriangle,
  Play,
  Wifi,
  Cloud,
  LogIn,
  Code2,
  Layers,
  Plus,
  FolderPlus,
  ChevronRight,
  GitBranch,
  Square,
  ChevronDown,
  Zap,
  Wrench,
  Activity,
  BookOpen,
  FlaskConical,
} from 'lucide-react';

// ============================================
// Types
// ============================================

type SettingsTab = 'connection' | 'terminal' | 'claude-code' | 'data-loading' | 'experiment';

interface MilestoneSettingsData {
  enabled: boolean;
  autoEnrich: boolean;
  autoKnowledge: boolean;
  scanRangeDays: number | null;
  phase2Model: 'haiku' | 'sonnet' | 'opus';
  architectureModel: 'haiku' | 'sonnet' | 'opus';
  excludedPaths: string[];
}

interface PipelineStatusData {
  sessions: { total: number; phase1: number; phase2: number; inRange: number; inRangePhase1: number; inRangePhase2: number };
  milestones: { total: number; phase1: number; phase2: number; inRange: number; inRangePhase1: number; inRangePhase2: number };
  vectors: { total: number; session: number; milestone: number; isInitialized: boolean };
  pipeline: {
    status: 'idle' | 'processing' | 'stopping' | 'unavailable';
    queueSize: number; processed: number; errors: number;
    lastProcessedAt: string | null; startedAt: string | null;
    currentBatch: { batchNumber: number; milestoneCount: number } | null;
    throughput: { milestonesPerMinute: number; batchesCompleted: number } | null;
    currentModel: string | null;
    vectorsIndexed?: number; vectorErrors?: number;
    mergesApplied?: number; milestonesAbsorbed?: number;
  };
  scanRangeDays: number | null;
}

interface VerificationData {
  summary: {
    sessionsScanned: number; sessionsWithProblems: number;
    problemCounts: Record<string, number>;
    milestonesByProblem: Record<string, number>;
  };
}

interface HubStatusData {
  configured: boolean;
  connected: boolean;
  authenticated: boolean;
  gatewayId: string | null;
  hubUrl: string | null;
  apiKeyConfigured: boolean;
  apiKeyPrefix: string | null;
  reconnectAttempts: number;
  lastConnected: string | null;
}

interface LocalStatus {
  healthy: boolean;
  version?: string;
  uptime?: number;
  port?: number;
  hubConnected?: boolean;
  hubAuthenticated?: boolean;
  hubGatewayId?: string;
}

interface TmuxConfig {
  statusBar: boolean;
  destroyUnattached: boolean;
}

interface TmuxStatus {
  installed: boolean;
  version: string | null;
  tmuxConfConfigured: boolean;
  bashrcConfigured: boolean;
  inTmuxSession: boolean;
  fullyConfigured: boolean;
  features: string[];
  config: TmuxConfig;
}

interface ClaudeCodeStatus {
  installed: boolean;
  binaryPath: string | null;
  binaryType: 'claude' | 'claude-native' | null;
  version: string | null;
}

interface ClaudeCodeConfig {
  skipDangerPermission: boolean;
  enableChrome: boolean;
  contextInjectDisplay: boolean;
  contextInjectMode: 'mcp' | 'suggest' | 'both' | 'off';
  contextInjectKnowledge: boolean;
  contextInjectMilestones: boolean;
  contextInjectKnowledgeCount: number;
  contextInjectMilestoneCount: number;
  searchIncludeKnowledge: boolean;
  searchIncludeMilestones: boolean;
}

interface McpStatus {
  installed: boolean;
  source?: 'plugin' | 'manual' | null;
  status?: string;
  scope?: string;
  command?: string;
  args?: string;
  tools?: string[];
}

interface ContextHookStatus {
  installed: boolean;
  source?: 'plugin' | 'manual' | null;
  scriptPath: string | null;
}

interface StatuslineStatus {
  installed: boolean;
  scriptPath: string | null;
  features: string[];
}

// ============================================
// Hub URL auto-detection
// ============================================

/** Dev uses local WS, prod uses wss via Cloudflare */
function getDefaultHubUrl(): string {
  if (typeof window === 'undefined') return 'wss://api.langmart.ai';
  return 'wss://api.langmart.ai';
}

// ============================================
// Settings Page
// ============================================

export default function SettingsPage() {
  const { mode, proxy, hubUser, hubConnected, isHybrid, localGatewayId, refreshHubConnection } = useAppMode();
  const [mounted, setMounted] = useState(false);
  const [activeTab, setActiveTab] = useState<SettingsTab>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('settings-active-tab');
      if (saved === 'connection' || saved === 'terminal' || saved === 'claude-code' || saved === 'data-loading' || saved === 'experiment') return saved;
      if (saved === 'milestones') return 'experiment'; // migrate old tab name
    }
    return 'connection';
  });
  const { isExperiment, setExperiment: handleSetExperiment } = useExperiment();
  const { isWindows } = usePlatform();
  // Redirect away from terminal tab on Windows
  useEffect(() => {
    if (isWindows && activeTab === 'terminal') {
      handleSetActiveTab('connection');
    }
  }, [isWindows, activeTab]); // eslint-disable-line react-hooks/exhaustive-deps
  const handleSetActiveTab = (tab: SettingsTab) => {
    setActiveTab(tab);
    localStorage.setItem('settings-active-tab', tab);
  };
  const [localStatus, setLocalStatus] = useState<LocalStatus | null>(null);
  const [hubStatus, setHubStatus] = useState<HubStatusData | null>(null);
  const [isLoadingStatus, setIsLoadingStatus] = useState(true);
  const [statusError, setStatusError] = useState<string | null>(null);

  // API key input
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [showApiKey, setShowApiKey] = useState(false);
  const [isAuthenticating, setIsAuthenticating] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [isDisconnecting, setIsDisconnecting] = useState(false);
  const [isRemoving, setIsRemoving] = useState(false);
  const [showApiKeyCard, setShowApiKeyCard] = useState(false);
  const [actionMessage, setActionMessage] = useState<{ text: string; type: 'ok' | 'error' } | null>(null);

  // server start
  const [isStartingServer, setIsStartingServer] = useState(false);
  const [startServerOutput, setStartServerOutput] = useState<{ text: string; type: 'ok' | 'error' } | null>(null);

  // tmux state
  const [isTmuxConfigSaving, setIsTmuxConfigSaving] = useState(false);
  const [tmuxStatus, setTmuxStatus] = useState<TmuxStatus | null>(null);
  const [isTmuxLoading, setIsTmuxLoading] = useState(false);
  const [isTmuxInstalling, setIsTmuxInstalling] = useState(false);
  const [isTmuxUninstalling, setIsTmuxUninstalling] = useState(false);
  const [tmuxMessage, setTmuxMessage] = useState<{ text: string; type: 'ok' | 'error' } | null>(null);

  // claude code state
  const [claudeCodeStatus, setClaudeCodeStatus] = useState<ClaudeCodeStatus | null>(null);
  const [claudeCodeConfig, setClaudeCodeConfig] = useState<ClaudeCodeConfig | null>(null);
  const [statuslineStatus, setStatuslineStatus] = useState<StatuslineStatus | null>(null);
  const [isClaudeCodeLoading, setIsClaudeCodeLoading] = useState(false);
  const [isClaudeCodeConfigSaving, setIsClaudeCodeConfigSaving] = useState(false);
  const [isStatuslineInstalling, setIsStatuslineInstalling] = useState(false);
  const [isStatuslineUninstalling, setIsStatuslineUninstalling] = useState(false);
  const [mcpStatus, setMcpStatus] = useState<McpStatus | null>(null);
  const [isMcpInstalling, setIsMcpInstalling] = useState(false);
  const [isMcpUninstalling, setIsMcpUninstalling] = useState(false);
  const [contextHookStatus, setContextHookStatus] = useState<ContextHookStatus | null>(null);
  const [isContextHookInstalling, setIsContextHookInstalling] = useState(false);
  const [isContextHookUninstalling, setIsContextHookUninstalling] = useState(false);
  const [claudeCodeMessage, setClaudeCodeMessage] = useState<{ text: string; type: 'ok' | 'error' } | null>(null);

  // milestone settings state
  const [milestoneSettings, setMilestoneSettings] = useState<MilestoneSettingsData | null>(null);
  const [isMilestoneLoading, setIsMilestoneLoading] = useState(false);
  const [isMilestoneSaving, setIsMilestoneSaving] = useState(false);
  const [milestoneMessage, setMilestoneMessage] = useState<{ text: string; type: 'ok' | 'error' } | null>(null);
  const [newExcludedPath, setNewExcludedPath] = useState('');
  const [showProjectPicker, setShowProjectPicker] = useState(false);
  const [availableProjects, setAvailableProjects] = useState<string[]>([]);
  const [projectPickerLoading, setProjectPickerLoading] = useState(false);

  // pipeline status state
  const [pipelineStatus, setPipelineStatus] = useState<PipelineStatusData | null>(null);
  const [isPipelineLoading, setIsPipelineLoading] = useState(false);
  const [isPipelineActionLoading, setIsPipelineActionLoading] = useState(false);
  const [pipelineMessage, setPipelineMessage] = useState<{ text: string; type: 'ok' | 'error' } | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [isVerifying, setIsVerifying] = useState(false);
  const [verificationResult, setVerificationResult] = useState<VerificationData | null>(null);
  const [isExtracting, setIsExtracting] = useState(false);
  const [isRebuilding, setIsRebuilding] = useState(false);
  const [isFixingIndex, setIsFixingIndex] = useState(false);

  // knowledge processing state
  const [knowledgeStats, setKnowledgeStats] = useState<{ candidates: number; generated: number } | null>(null);
  const [knowledgeGenStatus, setKnowledgeGenStatus] = useState<{ status: string; processed?: number; total?: number; errors?: number } | null>(null);
  const [isKnowledgeGenerating, setIsKnowledgeGenerating] = useState(false);
  const [knowledgeMessage, setKnowledgeMessage] = useState<{ text: string; type: 'ok' | 'error' } | null>(null);

  // LAN access state
  const [lanEnabled, setLanEnabled] = useState(false);
  const [lanAuthEnabled, setLanAuthEnabled] = useState(true);
  const [lanLoading, setLanLoading] = useState(false);
  const [lanMessage, setLanMessage] = useState<{ text: string; type: 'ok' | 'error' } | null>(null);
  const [localIp, setLocalIp] = useState<string | null>(null);

  // Cloud OAuth sign-in state
  const [isCloudSigningIn, setIsCloudSigningIn] = useState(false);
  const [cloudSignInMessage, setCloudSignInMessage] = useState<{ text: string; type: 'ok' | 'error' } | null>(null);

  const tierAgentUrl = typeof window !== 'undefined'
    ? detectAppMode().baseUrl || `http://${window.location.hostname}:3100`
    : 'http://localhost:3100';

  useEffect(() => { setMounted(true); }, []);

  // Fetch status (local mode only)
  const fetchStatus = useCallback(async () => {
    if (proxy.isProxied) {
      setLocalStatus(null);
      setHubStatus(null);
      setIsLoadingStatus(false);
      return;
    }
    setIsLoadingStatus(true);
    setStatusError(null);
    try {
      const [healthRes, hubRes] = await Promise.all([
        fetch(tierAgentUrl + '/health').catch(() => null),
        fetch(tierAgentUrl + '/hub/status').catch(() => null),
      ]);

      if (healthRes?.ok) {
        const json = await healthRes.json();
        const d = json.data || json;
        setLocalStatus({
          healthy: true,
          version: d.version,
          uptime: d.uptime,
          port: d.port,
          hubConnected: d.hub?.connected,
          hubAuthenticated: d.hub?.authenticated,
          hubGatewayId: d.hub?.gatewayId,
        });
      } else {
        setLocalStatus({ healthy: false });
        setStatusError('Cannot reach tier-agent. Is it running?');
      }

      if (hubRes?.ok) {
        const hubJson = await hubRes.json();
        const hubData: HubStatusData = hubJson.data || hubJson;
        setHubStatus(hubData);
      }
    } catch {
      setLocalStatus({ healthy: false });
      setStatusError('Cannot reach tier-agent. Is it running?');
    } finally {
      setIsLoadingStatus(false);
    }
  }, [tierAgentUrl, proxy.isProxied]);

  useEffect(() => {
    fetchStatus();
    if (!proxy.isProxied) {
      const interval = setInterval(fetchStatus, 30000);
      return () => clearInterval(interval);
    }
  }, [fetchStatus, proxy.isProxied]);

  // Fetch LAN config from local Next.js API
  const fetchLanConfig = useCallback(async () => {
    try {
      const res = await fetch('/api/server');
      if (res.ok) {
        const data = await res.json();
        setLanEnabled(data.lanEnabled ?? false);
        setLanAuthEnabled(data.lanAuthEnabled ?? true);
        if (data.localIp) setLocalIp(data.localIp);
      }
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { fetchLanConfig(); }, [fetchLanConfig]);

  // Listen for postMessage from Cloud OAuth popup
  useEffect(() => {
    const handler = async (event: MessageEvent) => {
      // Validate origin: must be exactly langmart.ai (not a subdomain spoof)
      let originHost: string;
      try { originHost = new URL(event.origin).hostname; } catch { return; }
      const isValid = originHost === 'langmart.ai' || originHost === 'www.langmart.ai';
      if (!isValid) return;
      if (event.data?.type !== 'langmart-assist-connect') return;
      const receivedKey = event.data.apiKey;
      if (!receivedKey || typeof receivedKey !== 'string') return;

      setIsCloudSigningIn(true);
      setCloudSignInMessage(null);
      try {
        const hubUrl = getDefaultHubUrl();
        const res = await fetch(tierAgentUrl + '/hub/config', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ apiKey: receivedKey, hubUrl, reconnect: true }),
        });
        const json = await res.json();
        if (json.success) {
          // Poll for authentication to complete
          if (!json.data?.authenticated) {
            for (let i = 0; i < 5; i++) {
              await new Promise(r => setTimeout(r, 1000));
              const statusRes = await fetch(tierAgentUrl + '/hub/status').catch(() => null);
              if (statusRes?.ok) {
                const s = (await statusRes.json()).data;
                if (s?.authenticated) break;
              }
            }
          }
          setCloudSignInMessage({ text: 'Connected to cloud!', type: 'ok' });
          await fetchStatus();
          await refreshHubConnection();
        } else {
          setCloudSignInMessage({ text: json.error || 'Failed to save API key', type: 'error' });
        }
      } catch {
        setCloudSignInMessage({ text: 'Failed to reach tier-agent', type: 'error' });
      } finally {
        setIsCloudSigningIn(false);
      }
    };

    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [tierAgentUrl, fetchStatus, refreshHubConnection]);

  // Open Cloud OAuth popup
  const handleCloudSignIn = useCallback(() => {
    const origin = encodeURIComponent(window.location.origin);
    window.open(
      `https://langmart.ai/assist-connect?origin=${origin}`,
      'langmart-connect',
      'width=460,height=560,left=200,top=100',
    );
  }, []);

  const handleLanToggle = useCallback(async (value: boolean) => {
    setLanLoading(true);
    setLanMessage(null);
    try {
      const res = await fetch('/api/server', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lanEnabled: value }),
      });
      const json = await res.json();
      if (json.success) {
        setLanEnabled(json.config.lanEnabled);
        if (json.restartRequired) {
          setLanMessage({ text: 'Restart required. Run ./core.sh restart to apply.', type: 'ok' });
        }
      } else {
        setLanMessage({ text: 'Failed to save setting', type: 'error' });
      }
    } catch {
      setLanMessage({ text: 'Failed to save setting', type: 'error' });
    } finally {
      setLanLoading(false);
    }
  }, []);

  const handleLanAuthToggle = useCallback(async (value: boolean) => {
    setLanLoading(true);
    setLanMessage(null);
    try {
      const res = await fetch('/api/server', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lanAuthEnabled: value }),
      });
      const json = await res.json();
      if (json.success) {
        setLanAuthEnabled(json.config.lanAuthEnabled);
      } else {
        setLanMessage({ text: 'Failed to save setting', type: 'error' });
      }
    } catch {
      setLanMessage({ text: 'Failed to save setting', type: 'error' });
    } finally {
      setLanLoading(false);
    }
  }, []);

  // Show temporary action message
  const showMessage = (text: string, type: 'ok' | 'error') => {
    setActionMessage({ text, type });
    setTimeout(() => setActionMessage(null), 4000);
  };

  // Authenticate: save API key + hub URL, then connect
  const handleAuthenticate = useCallback(async () => {
    if (!apiKeyInput.trim()) {
      showMessage('Enter an API key', 'error');
      return;
    }
    setIsAuthenticating(true);
    setActionMessage(null);
    try {
      const hubUrl = getDefaultHubUrl();
      const res = await fetch(tierAgentUrl + '/hub/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey: apiKeyInput.trim(), hubUrl, reconnect: true }),
      });
      const json = await res.json();
      if (json.success) {
        setApiKeyInput('');
        setShowApiKeyCard(false);
        // Server waits 1.5s but auth may still be in progress — poll briefly
        if (!json.data?.authenticated) {
          showMessage('Connecting...', 'ok');
          for (let i = 0; i < 3; i++) {
            await new Promise(r => setTimeout(r, 1000));
            const statusRes = await fetch(tierAgentUrl + '/hub/status').catch(() => null);
            if (statusRes?.ok) {
              const s = (await statusRes.json()).data;
              if (s?.authenticated) break;
            }
          }
        }
        showMessage(json.data?.message || 'Authenticated', 'ok');
        await fetchStatus();
        await refreshHubConnection();
      } else {
        showMessage(json.error || 'Failed to authenticate', 'error');
      }
    } catch {
      showMessage('Failed to reach tier-agent', 'error');
    } finally {
      setIsAuthenticating(false);
    }
  }, [apiKeyInput, tierAgentUrl, fetchStatus, refreshHubConnection]);

  // Disconnect from hub
  const handleDisconnect = useCallback(async () => {
    setIsDisconnecting(true);
    setActionMessage(null);
    try {
      const res = await fetch(tierAgentUrl + '/hub/disconnect', { method: 'POST' });
      const json = await res.json();
      if (json.success) {
        showMessage('Disconnected from hub', 'ok');
        await fetchStatus();
        await refreshHubConnection();
      } else {
        showMessage(json.error || 'Failed to disconnect', 'error');
      }
    } catch {
      showMessage('Failed to reach tier-agent', 'error');
    } finally {
      setIsDisconnecting(false);
    }
  }, [tierAgentUrl, fetchStatus, refreshHubConnection]);

  // Connect to hub (when disconnected but key exists)
  const handleConnect = useCallback(async () => {
    setIsConnecting(true);
    setActionMessage(null);
    try {
      const res = await fetch(tierAgentUrl + '/hub/connect', { method: 'POST' });
      const json = await res.json();
      if (json.success) {
        showMessage('Connecting to hub...', 'ok');
        // Auth completes asynchronously after WS connect — poll until authenticated or timeout
        for (let i = 0; i < 5; i++) {
          await new Promise(r => setTimeout(r, 1000));
          const statusRes = await fetch(tierAgentUrl + '/hub/status').catch(() => null);
          if (statusRes?.ok) {
            const statusJson = await statusRes.json();
            const s = statusJson.data || statusJson;
            if (s.authenticated) {
              showMessage('Connected & Authenticated', 'ok');
              break;
            }
          }
        }
        await fetchStatus();
        await refreshHubConnection();
      } else {
        showMessage(json.error || 'Failed to connect', 'error');
      }
    } catch {
      showMessage('Failed to reach tier-agent', 'error');
    } finally {
      setIsConnecting(false);
    }
  }, [tierAgentUrl, fetchStatus, refreshHubConnection]);

  // Remove API key: clears key from .env, disconnects
  const handleRemoveApiKey = useCallback(async () => {
    setIsRemoving(true);
    setActionMessage(null);
    try {
      const res = await fetch(tierAgentUrl + '/hub/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey: '' }),
      });
      const json = await res.json();
      if (json.success) {
        showMessage('API key removed. Disconnected.', 'ok');
        await fetchStatus();
        await refreshHubConnection();
      } else {
        showMessage(json.error || 'Failed to remove key', 'error');
      }
    } catch {
      showMessage('Failed to reach tier-agent', 'error');
    } finally {
      setIsRemoving(false);
    }
  }, [tierAgentUrl, fetchStatus, refreshHubConnection]);

  // ──────── tmux status & actions ────────

  const fetchTmuxStatus = useCallback(async () => {
    if (proxy.isProxied) return;
    setIsTmuxLoading(true);
    try {
      const res = await fetch(tierAgentUrl + '/tmux/status').catch(() => null);
      if (res?.ok) {
        const json = await res.json();
        setTmuxStatus(json.data || null);
      }
    } catch {
      // silently fail
    } finally {
      setIsTmuxLoading(false);
    }
  }, [tierAgentUrl, proxy.isProxied]);

  useEffect(() => {
    if (!proxy.isProxied && localStatus?.healthy) {
      fetchTmuxStatus();
    }
  }, [fetchTmuxStatus, proxy.isProxied, localStatus?.healthy]);

  const showTmuxMessage = (text: string, type: 'ok' | 'error') => {
    setTmuxMessage({ text, type });
    setTimeout(() => setTmuxMessage(null), 4000);
  };

  const handleTmuxInstall = useCallback(async () => {
    setIsTmuxInstalling(true);
    setTmuxMessage(null);
    try {
      const res = await fetch(tierAgentUrl + '/tmux/install', { method: 'POST' });
      const json = await res.json();
      if (json.success) {
        setTmuxStatus(json.data);
        showTmuxMessage('tmux configured successfully', 'ok');
      } else {
        showTmuxMessage(json.data?.output || 'Failed to install', 'error');
      }
    } catch {
      showTmuxMessage('Failed to reach tier-agent', 'error');
    } finally {
      setIsTmuxInstalling(false);
    }
  }, [tierAgentUrl]);

  const handleTmuxUninstall = useCallback(async () => {
    setIsTmuxUninstalling(true);
    setTmuxMessage(null);
    try {
      const res = await fetch(tierAgentUrl + '/tmux/uninstall', { method: 'POST' });
      const json = await res.json();
      if (json.success) {
        setTmuxStatus(json.data);
        showTmuxMessage('tmux configuration removed', 'ok');
      } else {
        showTmuxMessage(json.data?.output || 'Failed to uninstall', 'error');
      }
    } catch {
      showTmuxMessage('Failed to reach tier-agent', 'error');
    } finally {
      setIsTmuxUninstalling(false);
    }
  }, [tierAgentUrl]);

  const handleTmuxConfigChange = useCallback(async (key: keyof TmuxConfig, value: boolean) => {
    if (isTmuxConfigSaving) return;
    setIsTmuxConfigSaving(true);
    try {
      const res = await fetch(tierAgentUrl + '/tmux/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [key]: value }),
      });
      const json = await res.json();
      if (json.success) {
        setTmuxStatus(json.data);
      } else {
        showTmuxMessage('Failed to update setting', 'error');
      }
    } catch {
      showTmuxMessage('Failed to reach tier-agent', 'error');
    } finally {
      setIsTmuxConfigSaving(false);
    }
  }, [tierAgentUrl, isTmuxConfigSaving]);

  // ──────── Claude Code status & actions ────────

  const fetchClaudeCodeStatus = useCallback(async () => {
    if (proxy.isProxied) return;
    setIsClaudeCodeLoading(true);
    try {
      const [statusRes, configRes, slRes, mcpRes, hookRes] = await Promise.all([
        fetch(tierAgentUrl + '/claude-code/status').catch(() => null),
        fetch(tierAgentUrl + '/claude-code/config').catch(() => null),
        fetch(tierAgentUrl + '/claude-code/statusline').catch(() => null),
        fetch(tierAgentUrl + '/claude-code/mcp').catch(() => null),
        fetch(tierAgentUrl + '/claude-code/context-hook').catch(() => null),
      ]);
      if (statusRes?.ok) {
        const json = await statusRes.json();
        setClaudeCodeStatus(json.data || null);
      }
      if (configRes?.ok) {
        const json = await configRes.json();
        setClaudeCodeConfig(json.data || null);
      }
      if (slRes?.ok) {
        const json = await slRes.json();
        setStatuslineStatus(json.data || null);
      }
      if (mcpRes?.ok) {
        const json = await mcpRes.json();
        setMcpStatus(json.data || null);
      }
      if (hookRes?.ok) {
        const json = await hookRes.json();
        setContextHookStatus(json.data || null);
      }
    } catch {
      // silently fail
    } finally {
      setIsClaudeCodeLoading(false);
    }
  }, [tierAgentUrl, proxy.isProxied]);

  useEffect(() => {
    if (!proxy.isProxied && localStatus?.healthy && activeTab === 'claude-code') {
      fetchClaudeCodeStatus();
    }
  }, [fetchClaudeCodeStatus, proxy.isProxied, localStatus?.healthy, activeTab]);

  // Fetch milestone settings when tab activates
  const fetchMilestoneSettings = useCallback(async () => {
    setIsMilestoneLoading(true);
    try {
      // Auto-exclude non-git projects first, then fetch the updated settings
      const autoRes = await fetch(tierAgentUrl + '/milestone-settings/auto-exclude', { method: 'POST' }).catch(() => null);
      if (autoRes?.ok) {
        const autoJson = await autoRes.json();
        if (autoJson.success) {
          setMilestoneSettings(autoJson.data || null);
          setIsMilestoneLoading(false);
          return;
        }
      }
      // Fallback: just fetch settings directly
      const res = await fetch(tierAgentUrl + '/milestone-settings');
      if (res.ok) {
        const json = await res.json();
        setMilestoneSettings(json.data || null);
      }
    } catch {
      // silently fail
    } finally {
      setIsMilestoneLoading(false);
    }
  }, [tierAgentUrl]);

  useEffect(() => {
    if (!proxy.isProxied && localStatus?.healthy && (activeTab === 'data-loading' || activeTab === 'experiment')) {
      fetchMilestoneSettings();
    }
  }, [fetchMilestoneSettings, proxy.isProxied, localStatus?.healthy, activeTab]);

  const saveMilestoneSettings = useCallback(async (partial: Partial<MilestoneSettingsData>) => {
    setIsMilestoneSaving(true);
    try {
      const res = await fetch(tierAgentUrl + '/milestone-settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(partial),
      });
      const json = await res.json();
      if (json.success) {
        setMilestoneSettings(json.data);
        setMilestoneMessage({ text: 'Settings saved', type: 'ok' });
      } else {
        setMilestoneMessage({ text: json.error || 'Failed to save', type: 'error' });
      }
    } catch {
      setMilestoneMessage({ text: 'Failed to reach API', type: 'error' });
    } finally {
      setIsMilestoneSaving(false);
      setTimeout(() => setMilestoneMessage(null), 3000);
    }
  }, [tierAgentUrl]);

  // ──────── Pipeline status & actions ────────

  const fetchPipelineStatus = useCallback(async () => {
    if (proxy.isProxied || !localStatus?.healthy) return;
    setIsPipelineLoading(true);
    try {
      const res = await fetch(tierAgentUrl + '/milestone-pipeline/status');
      if (res.ok) {
        const json = await res.json();
        setPipelineStatus(json.data || null);
      }
    } catch {
      // silently fail
    } finally {
      setIsPipelineLoading(false);
    }
  }, [tierAgentUrl, proxy.isProxied, localStatus?.healthy]);

  // Fetch on milestones tab activation
  useEffect(() => {
    if (!proxy.isProxied && localStatus?.healthy && activeTab === 'milestones') {
      fetchPipelineStatus();
    }
  }, [fetchPipelineStatus, proxy.isProxied, localStatus?.healthy, activeTab]);

  // Poll: 5s when processing, 30s when idle
  useEffect(() => {
    if (!proxy.isProxied && localStatus?.healthy && activeTab === 'milestones') {
      const interval = pipelineStatus?.pipeline?.status === 'processing' ? 5000 : 30000;
      const timer = setInterval(fetchPipelineStatus, interval);
      return () => clearInterval(timer);
    }
  }, [fetchPipelineStatus, proxy.isProxied, localStatus?.healthy, activeTab, pipelineStatus?.pipeline?.status]);

  const showPipelineMessage = (text: string, type: 'ok' | 'error') => {
    setPipelineMessage({ text, type });
    setTimeout(() => setPipelineMessage(null), 4000);
  };

  const handleStartEnrichment = useCallback(async () => {
    setIsPipelineActionLoading(true);
    setPipelineMessage(null);
    try {
      const model = milestoneSettings?.phase2Model || 'haiku';
      const res = await fetch(tierAgentUrl + '/milestone-pipeline/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model }),
      });
      const json = await res.json();
      if (json.success) {
        showPipelineMessage('Enrichment started', 'ok');
        await fetchPipelineStatus();
      } else {
        showPipelineMessage(json.error || 'Failed to start', 'error');
      }
    } catch {
      showPipelineMessage('Failed to reach API', 'error');
    } finally {
      setIsPipelineActionLoading(false);
    }
  }, [tierAgentUrl, milestoneSettings?.phase2Model, fetchPipelineStatus]);

  const handleStopEnrichment = useCallback(async () => {
    setIsPipelineActionLoading(true);
    setPipelineMessage(null);
    try {
      const res = await fetch(tierAgentUrl + '/milestone-pipeline/stop', { method: 'POST' });
      const json = await res.json();
      if (json.success) {
        showPipelineMessage('Enrichment stopping...', 'ok');
        await fetchPipelineStatus();
      } else {
        showPipelineMessage(json.error || 'Failed to stop', 'error');
      }
    } catch {
      showPipelineMessage('Failed to reach API', 'error');
    } finally {
      setIsPipelineActionLoading(false);
    }
  }, [tierAgentUrl, fetchPipelineStatus]);

  const handleExtract = useCallback(async () => {
    setIsExtracting(true);
    setPipelineMessage(null);
    try {
      const res = await fetch(tierAgentUrl + '/milestone-pipeline/extract', { method: 'POST' });
      const json = await res.json();
      if (json.success) {
        showPipelineMessage(`Extraction complete: ${json.data?.extracted ?? 0} milestones`, 'ok');
        await fetchPipelineStatus();
      } else {
        showPipelineMessage(json.error || 'Extraction failed', 'error');
      }
    } catch {
      showPipelineMessage('Failed to reach API', 'error');
    } finally {
      setIsExtracting(false);
    }
  }, [tierAgentUrl, fetchPipelineStatus]);

  const handleVerify = useCallback(async () => {
    setIsVerifying(true);
    setVerificationResult(null);
    setPipelineMessage(null);
    try {
      const res = await fetch(tierAgentUrl + '/milestone-pipeline/verify');
      const json = await res.json();
      if (json.success) {
        setVerificationResult(json.data || null);
      } else {
        showPipelineMessage(json.error || 'Verification failed', 'error');
      }
    } catch {
      showPipelineMessage('Failed to reach API', 'error');
    } finally {
      setIsVerifying(false);
    }
  }, [tierAgentUrl]);

  const handleRebuild = useCallback(async () => {
    setIsRebuilding(true);
    setPipelineMessage(null);
    try {
      const model = milestoneSettings?.phase2Model || 'haiku';
      const res = await fetch(tierAgentUrl + '/milestone-pipeline/reprocess', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'all', model }),
      });
      const json = await res.json();
      if (json.success) {
        showPipelineMessage('Rebuild started', 'ok');
        await fetchPipelineStatus();
      } else {
        showPipelineMessage(json.error || 'Rebuild failed', 'error');
      }
    } catch {
      showPipelineMessage('Failed to reach API', 'error');
    } finally {
      setIsRebuilding(false);
    }
  }, [tierAgentUrl, milestoneSettings?.phase2Model, fetchPipelineStatus]);

  const handleFixIndex = useCallback(async () => {
    setIsFixingIndex(true);
    setPipelineMessage(null);
    try {
      const res = await fetch(tierAgentUrl + '/milestone-pipeline/fix-index', { method: 'POST' });
      const json = await res.json();
      if (json.success) {
        showPipelineMessage('Index fixed', 'ok');
        await fetchPipelineStatus();
      } else {
        showPipelineMessage(json.error || 'Fix failed', 'error');
      }
    } catch {
      showPipelineMessage('Failed to reach API', 'error');
    } finally {
      setIsFixingIndex(false);
    }
  }, [tierAgentUrl, fetchPipelineStatus]);

  // ──────── Knowledge processing ────────

  const fetchKnowledgeStats = useCallback(async () => {
    if (proxy.isProxied || !localStatus?.healthy) return;
    try {
      const [statsRes, statusRes] = await Promise.all([
        fetch(tierAgentUrl + '/knowledge/generate/stats').catch(() => null),
        fetch(tierAgentUrl + '/knowledge/generate/status').catch(() => null),
      ]);
      if (statsRes?.ok) {
        const json = await statsRes.json();
        setKnowledgeStats(json.data || null);
      }
      if (statusRes?.ok) {
        const json = await statusRes.json();
        setKnowledgeGenStatus(json.data || null);
        setIsKnowledgeGenerating(json.data?.status === 'generating');
      }
    } catch { /* silently fail */ }
  }, [tierAgentUrl, proxy.isProxied, localStatus?.healthy]);

  useEffect(() => {
    if (!proxy.isProxied && localStatus?.healthy && activeTab === 'milestones') {
      fetchKnowledgeStats();
    }
  }, [fetchKnowledgeStats, proxy.isProxied, localStatus?.healthy, activeTab]);

  // Poll knowledge status when generating
  useEffect(() => {
    if (!proxy.isProxied && localStatus?.healthy && activeTab === 'milestones' && isKnowledgeGenerating) {
      const timer = setInterval(fetchKnowledgeStats, 3000);
      return () => clearInterval(timer);
    }
  }, [fetchKnowledgeStats, proxy.isProxied, localStatus?.healthy, activeTab, isKnowledgeGenerating]);

  const handleStartKnowledgeGeneration = useCallback(async () => {
    setIsKnowledgeGenerating(true);
    setKnowledgeMessage(null);
    try {
      const res = await fetch(tierAgentUrl + '/knowledge/generate/all', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const json = await res.json();
      if (json.success) {
        const { generated, errors, stopped } = json.data;
        const msg = stopped ? `Stopped after ${generated} generated` : `${generated} generated`;
        setKnowledgeMessage({ text: errors > 0 ? `${msg}, ${errors} errors` : msg, type: 'ok' });
        setTimeout(() => setKnowledgeMessage(null), 4000);
        await fetchKnowledgeStats();
      } else {
        setKnowledgeMessage({ text: json.error || 'Generation failed', type: 'error' });
        setTimeout(() => setKnowledgeMessage(null), 4000);
      }
    } catch {
      setKnowledgeMessage({ text: 'Failed to reach API', type: 'error' });
      setTimeout(() => setKnowledgeMessage(null), 4000);
    } finally {
      setIsKnowledgeGenerating(false);
    }
  }, [tierAgentUrl, fetchKnowledgeStats]);

  const handleStopKnowledgeGeneration = useCallback(async () => {
    try {
      await fetch(tierAgentUrl + '/knowledge/generate/stop', { method: 'POST' });
    } catch { /* best effort */ }
  }, [tierAgentUrl]);

  const showClaudeCodeMessage = (text: string, type: 'ok' | 'error') => {
    setClaudeCodeMessage({ text, type });
    setTimeout(() => setClaudeCodeMessage(null), 4000);
  };

  const handleClaudeCodeConfigChange = useCallback(async (key: keyof ClaudeCodeConfig, value: boolean | string | number) => {
    if (isClaudeCodeConfigSaving) return;
    setIsClaudeCodeConfigSaving(true);
    try {
      const res = await fetch(tierAgentUrl + '/claude-code/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [key]: value }),
      });
      const json = await res.json();
      if (json.success) {
        setClaudeCodeConfig(json.data || null);
      } else {
        showClaudeCodeMessage('Failed to update setting', 'error');
      }
    } catch {
      showClaudeCodeMessage('Failed to reach tier-agent', 'error');
    } finally {
      setIsClaudeCodeConfigSaving(false);
    }
  }, [tierAgentUrl, isClaudeCodeConfigSaving]);

  const handleStatuslineInstall = useCallback(async () => {
    setIsStatuslineInstalling(true);
    setClaudeCodeMessage(null);
    try {
      const res = await fetch(tierAgentUrl + '/claude-code/statusline/install', { method: 'POST' });
      const json = await res.json();
      if (json.success) {
        setStatuslineStatus(json.data || null);
        showClaudeCodeMessage('Status line installed', 'ok');
      } else {
        showClaudeCodeMessage(json.error || 'Failed to install', 'error');
      }
    } catch {
      showClaudeCodeMessage('Failed to reach tier-agent', 'error');
    } finally {
      setIsStatuslineInstalling(false);
    }
  }, [tierAgentUrl]);

  const handleStatuslineUninstall = useCallback(async () => {
    setIsStatuslineUninstalling(true);
    setClaudeCodeMessage(null);
    try {
      const res = await fetch(tierAgentUrl + '/claude-code/statusline/uninstall', { method: 'POST' });
      const json = await res.json();
      if (json.success) {
        setStatuslineStatus(json.data || null);
        showClaudeCodeMessage('Status line removed', 'ok');
      } else {
        showClaudeCodeMessage(json.error || 'Failed to uninstall', 'error');
      }
    } catch {
      showClaudeCodeMessage('Failed to reach tier-agent', 'error');
    } finally {
      setIsStatuslineUninstalling(false);
    }
  }, [tierAgentUrl]);

  const handleMcpInstall = useCallback(async () => {
    setIsMcpInstalling(true);
    setClaudeCodeMessage(null);
    try {
      const res = await fetch(tierAgentUrl + '/claude-code/mcp/install', { method: 'POST' });
      const json = await res.json();
      if (json.success) {
        setMcpStatus(json.data || null);
        showClaudeCodeMessage('MCP server installed', 'ok');
      } else {
        showClaudeCodeMessage(json.error || 'Failed to install MCP server', 'error');
      }
    } catch {
      showClaudeCodeMessage('Failed to reach tier-agent', 'error');
    } finally {
      setIsMcpInstalling(false);
    }
  }, [tierAgentUrl]);

  const handleMcpUninstall = useCallback(async () => {
    setIsMcpUninstalling(true);
    setClaudeCodeMessage(null);
    try {
      const res = await fetch(tierAgentUrl + '/claude-code/mcp/uninstall', { method: 'POST' });
      const json = await res.json();
      if (json.success) {
        setMcpStatus(json.data || null);
        showClaudeCodeMessage('MCP server removed', 'ok');
      } else {
        showClaudeCodeMessage(json.error || 'Failed to remove MCP server', 'error');
      }
    } catch {
      showClaudeCodeMessage('Failed to reach tier-agent', 'error');
    } finally {
      setIsMcpUninstalling(false);
    }
  }, [tierAgentUrl]);

  const handleContextHookInstall = useCallback(async () => {
    setIsContextHookInstalling(true);
    setClaudeCodeMessage(null);
    try {
      const res = await fetch(tierAgentUrl + '/claude-code/context-hook/install', { method: 'POST' });
      const json = await res.json();
      if (json.success) {
        setContextHookStatus(json.data || null);
        showClaudeCodeMessage('Context inject hook installed', 'ok');
      } else {
        showClaudeCodeMessage(json.error || 'Failed to install hook', 'error');
      }
    } catch {
      showClaudeCodeMessage('Failed to reach tier-agent', 'error');
    } finally {
      setIsContextHookInstalling(false);
    }
  }, [tierAgentUrl]);

  const handleContextHookUninstall = useCallback(async () => {
    setIsContextHookUninstalling(true);
    setClaudeCodeMessage(null);
    try {
      const res = await fetch(tierAgentUrl + '/claude-code/context-hook/uninstall', { method: 'POST' });
      const json = await res.json();
      if (json.success) {
        setContextHookStatus(json.data || null);
        showClaudeCodeMessage('Context inject hook removed', 'ok');
      } else {
        showClaudeCodeMessage(json.error || 'Failed to remove hook', 'error');
      }
    } catch {
      showClaudeCodeMessage('Failed to reach tier-agent', 'error');
    } finally {
      setIsContextHookUninstalling(false);
    }
  }, [tierAgentUrl]);

  // Start tier-agent API server via local Next.js API route
  const handleStartServer = useCallback(async () => {
    setIsStartingServer(true);
    setStartServerOutput(null);
    setStatusError(null);
    try {
      const res = await fetch('/api/server', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'start' }),
      });
      const json = await res.json();
      if (json.success) {
        setStartServerOutput({ text: 'Server started. Verifying...', type: 'ok' });
        // Poll health until reachable or timeout
        for (let i = 0; i < 10; i++) {
          await new Promise(r => setTimeout(r, 1500));
          const healthRes = await fetch(tierAgentUrl + '/health').catch(() => null);
          if (healthRes?.ok) {
            setStartServerOutput({ text: 'API server is running', type: 'ok' });
            await fetchStatus();
            await refreshHubConnection();
            return;
          }
        }
        setStartServerOutput({ text: 'Server started but not yet reachable. Try refreshing.', type: 'ok' });
        await fetchStatus();
      } else {
        setStartServerOutput({ text: json.message || 'Failed to start server', type: 'error' });
      }
    } catch {
      setStartServerOutput({ text: 'Failed to call start API', type: 'error' });
    } finally {
      setIsStartingServer(false);
    }
  }, [tierAgentUrl, fetchStatus, refreshHubConnection]);

  if (!mounted) return null;

  const isProxied = proxy.isProxied;
  const hubName = 'langmart.ai';

  const isHubConnected = hubStatus?.connected ?? localStatus?.hubConnected ?? false;
  const isAuthenticated = hubStatus?.authenticated ?? localStatus?.hubAuthenticated ?? false;
  const gatewayId = hubStatus?.gatewayId ?? localStatus?.hubGatewayId ?? null;
  const hasApiKey = hubStatus?.apiKeyConfigured ?? false;

  // tmux warning: show badge when loaded and not fully configured
  const tmuxNeedsAttention = tmuxStatus != null && !tmuxStatus.fullyConfigured;

  return (
    <div style={{ padding: 20, overflowY: 'auto', height: '100%' }} className="scrollbar-thin">
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
        <Settings size={18} style={{ color: 'var(--color-text-secondary)' }} />
        <h2 style={{ fontSize: 16, fontWeight: 600 }}>Settings</h2>
      </div>

      {/* ──────────── Tab Bar ──────────── */}
      <div style={{
        display: 'flex',
        gap: 0,
        marginBottom: 16,
        maxWidth: 640,
        borderBottom: '1px solid var(--color-border)',
      }}>
        <TabButton
          active={activeTab === 'connection'}
          onClick={() => handleSetActiveTab('connection')}
          icon={<Monitor size={13} />}
          label="Connection"
        />
        {!isWindows && (
          <TabButton
            active={activeTab === 'terminal'}
            onClick={() => handleSetActiveTab('terminal')}
            icon={<Terminal size={13} />}
            label="Terminal"
            badge={tmuxNeedsAttention ? 'warning' : undefined}
          />
        )}
        <TabButton
          active={activeTab === 'claude-code'}
          onClick={() => handleSetActiveTab('claude-code')}
          icon={<Code2 size={13} />}
          label="Claude Code"
        />
        <TabButton
          active={activeTab === 'data-loading'}
          onClick={() => handleSetActiveTab('data-loading')}
          icon={<BookOpen size={13} />}
          label="Data Loading"
        />
        <TabButton
          active={activeTab === 'experiment'}
          onClick={() => handleSetActiveTab('experiment')}
          icon={<FlaskConical size={13} />}
          label="Experiment"
        />
      </div>

      {/* ──────────── Tab Content ──────────── */}
      <div style={{ maxWidth: 640 }}>

        {/* ═══════════════ CONNECTION TAB ═══════════════ */}
        {activeTab === 'connection' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

            {/* Connect to Cloud Card (local, no API key) */}
            {!isProxied && localStatus?.healthy && !hasApiKey && (
              <SectionCard title="Connect to Cloud" icon={Cloud}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  <p style={{ fontSize: 12, color: 'var(--color-text-secondary)', lineHeight: 1.6 }}>
                    Enable <strong style={{ color: 'var(--color-text-primary)' }}>safe access across all your devices</strong> — over the internet,
                    LAN, WiFi, or any network. View and manage your sessions from any browser, anywhere.
                  </p>

                  {/* Sign In button with OAuth provider icons — all on one line */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    <button
                      className="btn btn-sm"
                      onClick={handleCloudSignIn}
                      disabled={isCloudSigningIn}
                      style={{
                        gap: 8,
                        padding: '10px 20px',
                        background: 'rgba(96, 165, 250, 0.12)',
                        border: '1px solid rgba(96, 165, 250, 0.35)',
                        color: 'rgba(96, 165, 250, 1)',
                        fontSize: 13,
                        fontWeight: 600,
                        flexShrink: 0,
                      }}
                    >
                      {isCloudSigningIn ? <Loader2 size={14} className="spin" /> : <LogIn size={14} />}
                      Sign In
                    </button>

                    <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)', flexShrink: 0 }}>via</span>

                    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                      <span title="Google" style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '5px 10px', borderRadius: 6, background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', fontSize: 11, color: 'var(--color-text-secondary)' }}>
                        <svg width="13" height="13" viewBox="0 0 24 24"><path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/><path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/><path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/><path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/></svg>
                        Google
                      </span>
                      <span title="GitHub" style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '5px 10px', borderRadius: 6, background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', fontSize: 11, color: 'var(--color-text-secondary)' }}>
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.43 9.8 8.21 11.39.6.11.79-.26.79-.58v-2.23c-3.34.73-4.03-1.41-4.03-1.41-.55-1.39-1.33-1.76-1.33-1.76-1.09-.74.08-.73.08-.73 1.2.09 1.84 1.24 1.84 1.24 1.07 1.83 2.81 1.3 3.5 1 .1-.78.42-1.3.76-1.6-2.67-.3-5.47-1.33-5.47-5.93 0-1.31.47-2.38 1.24-3.22-.13-.3-.54-1.52.12-3.18 0 0 1.01-.32 3.3 1.23a11.5 11.5 0 0 1 6.02 0c2.28-1.55 3.29-1.23 3.29-1.23.66 1.66.25 2.88.12 3.18.77.84 1.24 1.91 1.24 3.22 0 4.61-2.81 5.63-5.48 5.92.43.37.81 1.1.81 2.22v3.29c0 .32.19.69.8.58C20.57 21.8 24 17.31 24 12c0-6.63-5.37-12-12-12z"/></svg>
                        GitHub
                      </span>
                      <span title="Microsoft" style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '5px 10px', borderRadius: 6, background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', fontSize: 11, color: 'var(--color-text-secondary)' }}>
                        <svg width="13" height="13" viewBox="0 0 24 24"><rect x="1" y="1" width="10" height="10" fill="#F25022"/><rect x="13" y="1" width="10" height="10" fill="#7FBA00"/><rect x="1" y="13" width="10" height="10" fill="#00A4EF"/><rect x="13" y="13" width="10" height="10" fill="#FFB900"/></svg>
                        Microsoft
                      </span>
                    </div>
                  </div>

                  {cloudSignInMessage && (
                    <div style={{
                      padding: '6px 10px',
                      background: cloudSignInMessage.type === 'ok'
                        ? 'rgba(74, 222, 128, 0.08)' : 'rgba(248, 113, 113, 0.08)',
                      border: `1px solid ${cloudSignInMessage.type === 'ok'
                        ? 'rgba(74, 222, 128, 0.2)' : 'rgba(248, 113, 113, 0.2)'}`,
                      borderRadius: 'var(--radius-sm)',
                      fontSize: 11,
                      color: cloudSignInMessage.type === 'ok'
                        ? 'var(--color-status-green)' : 'var(--color-status-red)',
                      display: 'flex', alignItems: 'center', gap: 6,
                    }}>
                      {cloudSignInMessage.type === 'ok' ? <CheckCircle size={12} /> : <XCircle size={12} />}
                      {cloudSignInMessage.text}
                    </div>
                  )}

                  <div style={{ borderTop: '1px solid var(--color-border)', margin: '4px 0' }} />

                  {/* Fallback: Manual key entry */}
                  <button
                    className="btn btn-sm btn-ghost"
                    onClick={() => setShowApiKeyCard(true)}
                    style={{ gap: 4, alignSelf: 'flex-start', fontSize: 11 }}
                  >
                    <Key size={12} />
                    I already have a key
                  </button>
                </div>
              </SectionCard>
            )}

            {/* Connection Status Card */}
            <SectionCard title="Connection Status" icon={isProxied ? Globe : Monitor}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {/* Mode badge + Cloud/Local buttons */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)', width: 80 }}>Mode</span>
                  <span
                    className={`topbar-connection ${isProxied ? 'proxied' : 'local'}`}
                    style={{ fontSize: 10 }}
                  >
                    {isProxied ? (
                      <><Globe size={10} /> connected to cloud</>
                    ) : isHybrid ? (
                      <><Globe size={10} /> hybrid (local + cloud)</>
                    ) : (
                      <><Monitor size={10} /> local{isHubConnected ? ' (connected)' : ''}</>
                    )}
                  </span>

                  {/* Cloud / Local open buttons */}
                  {(isAuthenticated && gatewayId) && (
                    <a
                      href={`https://${hubName}/w/${gatewayId}/assist/settings`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="btn btn-sm btn-ghost"
                      style={{
                        gap: 3, textDecoration: 'none', display: 'inline-flex',
                        alignItems: 'center', fontSize: 10, padding: '2px 7px',
                        height: 22, lineHeight: 1,
                      }}
                    >
                      <Globe size={10} />
                      Cloud
                    </a>
                  )}
                  <a
                    href={`http://${lanEnabled && localIp ? localIp : 'localhost'}:3848/settings`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="btn btn-sm btn-ghost"
                    style={{
                      gap: 3, textDecoration: 'none', display: 'inline-flex',
                      alignItems: 'center', fontSize: 10, padding: '2px 7px',
                      height: 22, lineHeight: 1,
                    }}
                  >
                    <Monitor size={10} />
                    Local
                  </a>
                  <AccessModeInfo />
                </div>

                {/* Proxied mode */}
                {isProxied && (
                  <>
                    {proxy.machineId && (
                      <InfoRow label="Machine ID" value={proxy.machineId} mono copyable />
                    )}
                    <InfoRow label="Hub Link" value="Connected via proxy" status="ok" />
                    <div style={{
                      padding: '6px 10px',
                      background: 'rgba(74, 222, 128, 0.08)',
                      border: '1px solid rgba(74, 222, 128, 0.2)',
                      borderRadius: 'var(--radius-sm)',
                      fontSize: 11,
                      color: 'var(--color-status-green)',
                      lineHeight: 1.5,
                    }}>
                      Machine is online and connected through cloud.
                    </div>
                  </>
                )}

                {/* Local mode */}
                {!isProxied && (
                  <>
                    <InfoRow
                      label="Local API"
                      value={tierAgentUrl}
                      status={localStatus?.healthy ? 'ok' : localStatus === null ? 'loading' : 'error'}
                    />

                    {localStatus && (
                      <>
                        <InfoRow
                          label="Hub Link"
                          value={isHubConnected
                            ? (isAuthenticated ? 'Connected & Authenticated' : 'Connected (auth pending...)')
                            : (hasApiKey ? 'Disconnected' : 'Not configured')}
                          status={isAuthenticated ? 'ok' : isHubConnected ? 'loading' : (hasApiKey ? 'error' : undefined)}
                        />
                        {isAuthenticated && gatewayId && (
                          <InfoRow label="Gateway ID" value={gatewayId} mono copyable />
                        )}
                        {isHybrid && (
                          <div style={{
                            padding: '6px 10px',
                            background: 'rgba(96, 165, 250, 0.08)',
                            border: '1px solid rgba(96, 165, 250, 0.2)',
                            borderRadius: 'var(--radius-sm)',
                            fontSize: 11,
                            color: 'rgba(96, 165, 250, 1)',
                            lineHeight: 1.5,
                          }}>
                            Hybrid mode active. Local sessions use direct API, remote machines route through hub.
                          </div>
                        )}
                        {hasApiKey && hubStatus?.apiKeyPrefix && (
                          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                            <div style={{ flex: 1 }}>
                              <InfoRow label="API Key" value={hubStatus.apiKeyPrefix} mono />
                            </div>
                            <button
                              className="btn-icon"
                              onClick={() => setShowApiKeyCard(v => !v)}
                              title="Update API Key"
                              style={{ flexShrink: 0 }}
                            >
                              <Pencil size={11} />
                            </button>
                          </div>
                        )}
                      </>
                    )}

                    {statusError && (
                      <div style={{
                        padding: '10px 12px',
                        background: 'rgba(248, 113, 113, 0.06)',
                        border: '1px solid rgba(248, 113, 113, 0.2)',
                        borderRadius: 'var(--radius-sm)',
                        display: 'flex', flexDirection: 'column', gap: 10,
                      }}>
                        <div style={{ fontSize: 11, color: 'var(--color-status-red)', display: 'flex', alignItems: 'center', gap: 6 }}>
                          <XCircle size={12} />
                          {statusError}
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <button
                            className="btn btn-sm"
                            onClick={handleStartServer}
                            disabled={isStartingServer}
                            style={{
                              gap: 5,
                              background: 'rgba(74, 222, 128, 0.1)',
                              border: '1px solid rgba(74, 222, 128, 0.3)',
                              color: 'var(--color-status-green)',
                            }}
                          >
                            {isStartingServer ? <Loader2 size={12} className="spin" /> : <Play size={12} />}
                            {isStartingServer ? 'Starting...' : 'Start Server'}
                          </button>
                          {isStartingServer && (
                            <span style={{ fontSize: 10, color: 'var(--color-text-tertiary)' }}>
                              Running core.sh start...
                            </span>
                          )}
                        </div>
                        {startServerOutput && (
                          <div style={{
                            padding: '6px 10px',
                            background: startServerOutput.type === 'ok'
                              ? 'rgba(74, 222, 128, 0.08)' : 'rgba(248, 113, 113, 0.08)',
                            border: `1px solid ${startServerOutput.type === 'ok'
                              ? 'rgba(74, 222, 128, 0.2)' : 'rgba(248, 113, 113, 0.2)'}`,
                            borderRadius: 'var(--radius-sm)',
                            fontSize: 11,
                            color: startServerOutput.type === 'ok'
                              ? 'var(--color-status-green)' : 'var(--color-status-red)',
                            display: 'flex', alignItems: 'center', gap: 6,
                          }}>
                            {startServerOutput.type === 'ok' ? <CheckCircle size={12} /> : <XCircle size={12} />}
                            {startServerOutput.text}
                          </div>
                        )}
                      </div>
                    )}

                    {/* Action buttons */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      {localStatus?.healthy && isHubConnected && (
                        <>
                          <button
                            className="btn btn-sm"
                            onClick={handleDisconnect}
                            disabled={isDisconnecting}
                            style={{
                              gap: 4,
                              background: 'rgba(248, 113, 113, 0.1)',
                              border: '1px solid rgba(248, 113, 113, 0.3)',
                              color: 'var(--color-status-red)',
                            }}
                          >
                            {isDisconnecting ? <Loader2 size={12} className="spin" /> : <Unplug size={12} />}
                            Disconnect
                          </button>
                          <a
                            href={`https://${hubName}/api-keys?langmart-application-scope=langmart-assist`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="btn btn-sm"
                            style={{
                              gap: 4, textDecoration: 'none',
                              background: 'rgba(96, 165, 250, 0.1)',
                              border: '1px solid rgba(96, 165, 250, 0.3)',
                              color: 'rgba(96, 165, 250, 1)',
                            }}
                          >
                            <Globe size={12} />
                            Manage API Keys on Cloud
                          </a>
                        </>
                      )}


                      {localStatus?.healthy && hasApiKey && !isHubConnected && (
                        <button
                          className="btn btn-sm"
                          onClick={handleConnect}
                          disabled={isConnecting}
                          style={{
                            gap: 4,
                            background: 'rgba(74, 222, 128, 0.1)',
                            border: '1px solid rgba(74, 222, 128, 0.3)',
                            color: 'var(--color-status-green)',
                          }}
                        >
                          {isConnecting ? <Loader2 size={12} className="spin" /> : <Plug size={12} />}
                          Connect
                        </button>
                      )}

                      {localStatus?.healthy && hasApiKey && !isHubConnected && (
                        <button
                          className="btn btn-sm"
                          onClick={handleRemoveApiKey}
                          disabled={isRemoving}
                          style={{
                            gap: 4,
                            background: 'rgba(248, 113, 113, 0.06)',
                            border: '1px solid rgba(248, 113, 113, 0.2)',
                            color: 'var(--color-status-red)',
                          }}
                        >
                          {isRemoving ? <Loader2 size={12} className="spin" /> : <Trash2 size={12} />}
                          Remove API Key
                        </button>
                      )}

                      <div style={{ flex: 1 }} />

                      <button
                        className="btn btn-sm btn-ghost"
                        onClick={fetchStatus}
                        disabled={isLoadingStatus}
                        style={{ gap: 4 }}
                      >
                        <RefreshCw size={12} className={isLoadingStatus ? 'spin' : ''} />
                        Refresh
                      </button>
                    </div>
                  </>
                )}
              </div>
            </SectionCard>

            {/* LAN Access Card (local mode only) */}
            {!isProxied && (
              <SectionCard title="Local Network Access" icon={Wifi}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  <ToggleRow
                    label="Enable LAN access"
                    description="Allow other devices on your local network (Wi-Fi, LAN) to access this dashboard using the machine's IP address."
                    checked={lanEnabled}
                    onChange={handleLanToggle}
                  />
                  {lanEnabled && localIp && (
                    <div style={{
                      padding: '8px 12px',
                      background: 'rgba(74, 222, 128, 0.06)',
                      border: '1px solid rgba(74, 222, 128, 0.15)',
                      borderRadius: 'var(--radius-sm)',
                      fontSize: 11,
                      lineHeight: 1.6,
                    }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--color-status-green)', marginBottom: 4 }}>
                        <Wifi size={11} />
                        <span style={{ fontWeight: 600 }}>Accessible on your network</span>
                      </div>
                      <span style={{ color: 'var(--color-text-secondary)' }}>
                        Open{' '}
                        <a
                          href={`http://${localIp}:${typeof window !== 'undefined' ? window.location.port || '3848' : '3848'}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          style={{ fontFamily: 'var(--font-mono)', color: 'var(--color-text-primary)', background: 'rgba(255,255,255,0.06)', padding: '1px 4px', borderRadius: 3, textDecoration: 'none', borderBottom: '1px solid var(--color-text-tertiary)' }}
                        >
                          http://{localIp}:{typeof window !== 'undefined' ? window.location.port || '3848' : '3848'}
                        </a>
                        {' '}from any phone, tablet, or computer on the same Wi-Fi network.
                      </span>
                      <div style={{ marginTop: 6, color: 'var(--color-text-tertiary)', display: 'flex', alignItems: 'center', gap: 5 }}>
                        <Monitor size={10} style={{ flexShrink: 0 }} />
                        <span>Localhost access always bypasses authentication.</span>
                      </div>
                    </div>
                  )}
                  {!lanEnabled && (
                    <div style={{
                      padding: '6px 10px',
                      background: 'var(--color-bg-secondary)',
                      borderRadius: 'var(--radius-sm)',
                      fontSize: 11,
                      color: 'var(--color-text-tertiary)',
                      lineHeight: 1.6,
                      display: 'flex',
                      gap: 8,
                      alignItems: 'flex-start',
                    }}>
                      <Info size={12} style={{ flexShrink: 0, marginTop: 2 }} />
                      <span>
                        When enabled, the dashboard binds to all network interfaces instead of just localhost.
                        This lets any device on the same Wi-Fi or LAN access the dashboard — useful for monitoring from your phone, tablet, or another computer.
                        Requires a restart to take effect.
                      </span>
                    </div>
                  )}
                  {lanEnabled && (
                    <>
                      <div style={{ borderTop: '1px solid var(--color-border)', margin: '4px 0' }} />
                      <ToggleRow
                        label="Require authentication"
                        description="Devices on your local network must first authenticate through the cloud dashboard. Use 'Switch to Local' from the cloud to authorize a device — access is permanent once granted."
                        checked={lanAuthEnabled}
                        onChange={handleLanAuthToggle}
                      />
                      {lanAuthEnabled && (
                        <div style={{
                          padding: '6px 10px',
                          background: 'var(--color-bg-secondary)',
                          borderRadius: 'var(--radius-sm)',
                          fontSize: 11,
                          color: 'var(--color-text-tertiary)',
                          lineHeight: 1.6,
                          display: 'flex',
                          gap: 8,
                          alignItems: 'flex-start',
                        }}>
                          <Shield size={12} style={{ flexShrink: 0, marginTop: 2, color: 'var(--color-status-green)' }} />
                          <span>
                            LAN access is secured. Devices must authenticate via the cloud &quot;Switch to Local&quot; link before accessing the dashboard on the local network.
                          </span>
                        </div>
                      )}
                    </>
                  )}
                  {lanMessage && (
                    <div style={{
                      padding: '6px 10px',
                      background: lanMessage.type === 'ok'
                        ? 'rgba(232, 190, 100, 0.08)' : 'rgba(248, 113, 113, 0.08)',
                      border: `1px solid ${lanMessage.type === 'ok'
                        ? 'rgba(232, 190, 100, 0.2)' : 'rgba(248, 113, 113, 0.2)'}`,
                      borderRadius: 'var(--radius-sm)',
                      fontSize: 11,
                      color: lanMessage.type === 'ok'
                        ? 'var(--color-accent)' : 'var(--color-status-red)',
                      display: 'flex', alignItems: 'center', gap: 6,
                    }}>
                      {lanMessage.type === 'ok' ? <AlertTriangle size={12} /> : <XCircle size={12} />}
                      {lanMessage.text}
                    </div>
                  )}
                </div>
              </SectionCard>
            )}

            {/* User Info Card (local mode, authenticated) */}
            {!isProxied && isAuthenticated && hubUser && (
              <SectionCard title="Authenticated User" icon={User}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
                  {hubUser.avatarUrl ? (
                    <img
                      src={hubUser.avatarUrl}
                      alt={hubUser.displayName || hubUser.email}
                      style={{ width: 40, height: 40, borderRadius: '50%', objectFit: 'cover' }}
                      referrerPolicy="no-referrer"
                    />
                  ) : (
                    <div style={{
                      width: 40, height: 40, borderRadius: '50%',
                      background: 'var(--color-bg-active)',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      fontSize: 16, fontWeight: 600, color: 'var(--color-accent)',
                    }}>
                      {(hubUser.displayName || hubUser.email)[0]?.toUpperCase()}
                    </div>
                  )}
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 600 }}>
                      {hubUser.displayName || hubUser.email.split('@')[0]}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>
                      {hubUser.email}
                    </div>
                  </div>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <InfoRow label="User ID" value={hubUser.id} mono copyable />
                  {hubUser.oauthProvider && (
                    <InfoRow label="Auth Provider" value={hubUser.oauthProvider} />
                  )}
                  {hubUser.organizationId && (
                    <InfoRow label="Org ID" value={hubUser.organizationId} mono copyable />
                  )}
                </div>
              </SectionCard>
            )}

            {/* User Info Card (proxied) */}
            {isProxied && hubUser && (
              <SectionCard title="Authenticated User" icon={User}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
                  {hubUser.avatarUrl ? (
                    <img
                      src={hubUser.avatarUrl}
                      alt={hubUser.displayName || hubUser.email}
                      style={{ width: 40, height: 40, borderRadius: '50%', objectFit: 'cover' }}
                      referrerPolicy="no-referrer"
                    />
                  ) : (
                    <div style={{
                      width: 40, height: 40, borderRadius: '50%',
                      background: 'var(--color-bg-active)',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      fontSize: 16, fontWeight: 600, color: 'var(--color-accent)',
                    }}>
                      {(hubUser.displayName || hubUser.email)[0]?.toUpperCase()}
                    </div>
                  )}
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 600 }}>
                      {hubUser.displayName || hubUser.email.split('@')[0]}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>
                      {hubUser.email}
                    </div>
                  </div>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <InfoRow label="User ID" value={hubUser.id} mono copyable />
                  {hubUser.oauthProvider && (
                    <InfoRow label="Auth Provider" value={hubUser.oauthProvider} />
                  )}
                  {hubUser.organizationId && (
                    <InfoRow label="Org ID" value={hubUser.organizationId} mono copyable />
                  )}
                </div>
              </SectionCard>
            )}


            {/* API Key Card (local mode only) */}
            {!isProxied && localStatus?.healthy && showApiKeyCard && (
              <SectionCard title={hasApiKey ? 'Change API Key' : 'Enter API Key'} icon={Key}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  <p style={{ fontSize: 11, color: 'var(--color-text-tertiary)', lineHeight: 1.5 }}>
                    {hasApiKey
                      ? 'Enter a new API key to re-authenticate with the hub.'
                      : 'Paste your API key from the cloud dashboard to connect this machine.'
                    }
                  </p>

                  <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    <div style={{ position: 'relative', flex: 1 }}>
                      <input
                        className="input"
                        style={{ width: '100%', fontSize: 12, fontFamily: 'var(--font-mono)', paddingRight: 32 }}
                        type={showApiKey ? 'text' : 'password'}
                        placeholder="sk-langmart-..."
                        value={apiKeyInput}
                        onChange={(e) => setApiKeyInput(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') handleAuthenticate(); }}
                      />
                      <button
                        className="btn-icon"
                        style={{ position: 'absolute', right: 4, top: '50%', transform: 'translateY(-50%)' }}
                        onClick={() => setShowApiKey(!showApiKey)}
                        title={showApiKey ? 'Hide' : 'Show'}
                      >
                        {showApiKey ? <EyeOff size={12} /> : <Eye size={12} />}
                      </button>
                    </div>

                    <button
                      className="btn btn-sm"
                      onClick={handleAuthenticate}
                      disabled={isAuthenticating || !apiKeyInput.trim()}
                      style={{
                        gap: 4, whiteSpace: 'nowrap',
                        background: 'rgba(74, 222, 128, 0.1)',
                        border: '1px solid rgba(74, 222, 128, 0.3)',
                        color: 'var(--color-status-green)',
                      }}
                    >
                      {isAuthenticating ? <Loader2 size={12} className="spin" /> : <Key size={12} />}
                      {hasApiKey ? 'Re-authenticate' : 'Authenticate'}
                    </button>
                  </div>

                  {actionMessage && (
                    <div style={{
                      padding: '6px 10px',
                      background: actionMessage.type === 'ok'
                        ? 'rgba(74, 222, 128, 0.08)' : 'rgba(248, 113, 113, 0.08)',
                      border: `1px solid ${actionMessage.type === 'ok'
                        ? 'rgba(74, 222, 128, 0.2)' : 'rgba(248, 113, 113, 0.2)'}`,
                      borderRadius: 'var(--radius-sm)',
                      fontSize: 11,
                      color: actionMessage.type === 'ok'
                        ? 'var(--color-status-green)' : 'var(--color-status-red)',
                      display: 'flex', alignItems: 'center', gap: 6,
                    }}>
                      {actionMessage.type === 'ok' ? <CheckCircle size={12} /> : <XCircle size={12} />}
                      {actionMessage.text}
                    </div>
                  )}
                </div>
              </SectionCard>
            )}

            {/* Local Agent Info Card */}
            {localStatus?.healthy && (
              <SectionCard title="Local Agent" icon={Shield}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {localStatus.version && (
                    <InfoRow label="Version" value={localStatus.version} />
                  )}
                  {localStatus.uptime != null && (
                    <InfoRow label="Uptime" value={formatUptime(localStatus.uptime)} />
                  )}
                  {localStatus.port && (
                    <InfoRow label="Port" value={String(localStatus.port)} />
                  )}
                </div>
              </SectionCard>
            )}
          </div>
        )}

        {/* ═══════════════ TERMINAL TAB ═══════════════ */}
        {activeTab === 'terminal' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

            {/* tmux not available in proxied mode */}
            {isProxied && (
              <div style={{
                padding: '16px 20px',
                background: 'var(--color-bg-secondary)',
                borderRadius: 'var(--radius-md)',
                fontSize: 12,
                color: 'var(--color-text-tertiary)',
                textAlign: 'center',
              }}>
                Terminal configuration is only available in local mode.
              </div>
            )}

            {/* API not reachable */}
            {!isProxied && !localStatus?.healthy && (
              <div style={{
                padding: '16px 20px',
                background: 'rgba(248, 113, 113, 0.06)',
                border: '1px solid rgba(248, 113, 113, 0.15)',
                borderRadius: 'var(--radius-md)',
                display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12,
              }}>
                <div style={{ fontSize: 12, color: 'var(--color-status-red)' }}>
                  Cannot reach tier-agent. Start the server to manage terminal configuration.
                </div>
                <button
                  className="btn btn-sm"
                  onClick={handleStartServer}
                  disabled={isStartingServer}
                  style={{
                    gap: 5,
                    background: 'rgba(74, 222, 128, 0.1)',
                    border: '1px solid rgba(74, 222, 128, 0.3)',
                    color: 'var(--color-status-green)',
                  }}
                >
                  {isStartingServer ? <Loader2 size={12} className="spin" /> : <Play size={12} />}
                  {isStartingServer ? 'Starting...' : 'Start Server'}
                </button>
                {startServerOutput && (
                  <div style={{
                    padding: '6px 10px',
                    fontSize: 11,
                    color: startServerOutput.type === 'ok'
                      ? 'var(--color-status-green)' : 'var(--color-status-red)',
                    display: 'flex', alignItems: 'center', gap: 6,
                  }}>
                    {startServerOutput.type === 'ok' ? <CheckCircle size={12} /> : <XCircle size={12} />}
                    {startServerOutput.text}
                  </div>
                )}
              </div>
            )}

            {/* tmux section */}
            {!isProxied && localStatus?.healthy && (
              <>
                {/* Why tmux — always-visible explainer when not configured */}
                {tmuxNeedsAttention && (
                  <div style={{
                    padding: '14px 16px',
                    background: 'rgba(232, 190, 100, 0.06)',
                    border: '1px solid rgba(232, 190, 100, 0.2)',
                    borderRadius: 'var(--radius-md)',
                    display: 'flex',
                    gap: 12,
                    alignItems: 'flex-start',
                  }}>
                    <AlertTriangle size={16} style={{ color: 'var(--color-accent)', flexShrink: 0, marginTop: 1 }} />
                    <div style={{ fontSize: 12, lineHeight: 1.6, color: 'var(--color-text-secondary)' }}>
                      <span style={{ fontWeight: 600, color: 'var(--color-text-primary)' }}>tmux is not enabled</span>
                      <br />
                      Without tmux, terminal sessions cannot be shared across browser tabs or persist in the background.
                      Configure tmux below to enable shared and background-running Claude Code sessions.
                    </div>
                  </div>
                )}

                <SectionCard title="tmux Configuration" icon={Terminal}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>

                    {/* Loading state */}
                    {isTmuxLoading && !tmuxStatus && (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: 'var(--color-text-tertiary)' }}>
                        <Loader2 size={12} className="spin" />
                        Checking tmux status...
                      </div>
                    )}

                    {/* Status rows */}
                    {tmuxStatus && (
                      <>
                        <InfoRow
                          label="tmux"
                          value={tmuxStatus.installed ? (tmuxStatus.version || 'Installed') : 'Not installed'}
                          status={tmuxStatus.installed ? 'ok' : 'error'}
                        />
                        <InfoRow
                          label="Config"
                          value={tmuxStatus.tmuxConfConfigured ? tmuxStatus.features.join(', ') : 'Not configured'}
                          status={tmuxStatus.tmuxConfConfigured ? 'ok' : 'error'}
                        />
                        <InfoRow
                          label="Auto-start"
                          value={tmuxStatus.bashrcConfigured ? 'Enabled' : 'Disabled'}
                          status={tmuxStatus.bashrcConfigured ? 'ok' : 'error'}
                        />

                        {/* Settings toggles — only when configured */}
                        {tmuxStatus.fullyConfigured && tmuxStatus.config && (
                          <div style={{
                            display: 'flex',
                            flexDirection: 'column',
                            gap: 10,
                            padding: '10px 12px',
                            background: 'var(--color-bg-secondary)',
                            borderRadius: 'var(--radius-sm)',
                          }}>
                            <ToggleRow
                              label="Show status bar"
                              description="Display the tmux status bar at the bottom of the terminal"
                              checked={tmuxStatus.config.statusBar}
                              onChange={(v) => handleTmuxConfigChange('statusBar', v)}
                            />
                            <div style={{ borderTop: '1px solid var(--color-border)', margin: '0' }} />
                            <ToggleRow
                              label="Close session on terminal exit"
                              description="Automatically kill the tmux session when the terminal disconnects. When off, sessions persist in the background."
                              checked={tmuxStatus.config.destroyUnattached}
                              onChange={(v) => handleTmuxConfigChange('destroyUnattached', v)}
                            />
                          </div>
                        )}

                        {/* Fully configured — success banner */}
                        {tmuxStatus.fullyConfigured && (
                          <div style={{
                            padding: '6px 10px',
                            background: 'rgba(74, 222, 128, 0.08)',
                            border: '1px solid rgba(74, 222, 128, 0.2)',
                            borderRadius: 'var(--radius-sm)',
                            fontSize: 11,
                            color: 'var(--color-status-green)',
                            lineHeight: 1.5,
                          }}>
                            tmux is fully configured. New terminal sessions will auto-start with optimized settings.
                          </div>
                        )}

                        {/* Not fully configured — specific guidance */}
                        {!tmuxStatus.fullyConfigured && (
                          <>
                            {!tmuxStatus.installed && (
                              <div style={{
                                padding: '6px 10px',
                                background: 'rgba(248, 113, 113, 0.08)',
                                border: '1px solid rgba(248, 113, 113, 0.2)',
                                borderRadius: 'var(--radius-sm)',
                                fontSize: 11,
                                color: 'var(--color-status-red)',
                                lineHeight: 1.5,
                              }}>
                                tmux is not installed. Install it first with: <code style={{ fontFamily: 'var(--font-mono)', background: 'rgba(255,255,255,0.06)', padding: '1px 4px', borderRadius: 3 }}>sudo apt install tmux</code>
                              </div>
                            )}
                            {tmuxStatus.installed && (!tmuxStatus.tmuxConfConfigured || !tmuxStatus.bashrcConfigured) && (
                              <div style={{
                                padding: '8px 10px',
                                background: 'rgba(232, 190, 100, 0.08)',
                                border: '1px solid rgba(232, 190, 100, 0.2)',
                                borderRadius: 'var(--radius-sm)',
                                fontSize: 11,
                                color: 'var(--color-accent)',
                                lineHeight: 1.5,
                              }}>
                                tmux is installed but not configured. Click &quot;Install Configuration&quot; to enable shared and background terminal sessions.
                              </div>
                            )}
                          </>
                        )}

                        {/* Action buttons */}
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                          {tmuxStatus.installed && !tmuxStatus.fullyConfigured && (
                            <button
                              className="btn btn-sm"
                              onClick={handleTmuxInstall}
                              disabled={isTmuxInstalling}
                              style={{
                                gap: 4,
                                background: 'rgba(74, 222, 128, 0.1)',
                                border: '1px solid rgba(74, 222, 128, 0.3)',
                                color: 'var(--color-status-green)',
                              }}
                            >
                              {isTmuxInstalling ? <Loader2 size={12} className="spin" /> : <Download size={12} />}
                              Install Configuration
                            </button>
                          )}

                          {(tmuxStatus.tmuxConfConfigured || tmuxStatus.bashrcConfigured) && (
                            <button
                              className="btn btn-sm"
                              onClick={handleTmuxUninstall}
                              disabled={isTmuxUninstalling}
                              style={{
                                gap: 4,
                                background: 'rgba(248, 113, 113, 0.06)',
                                border: '1px solid rgba(248, 113, 113, 0.2)',
                                color: 'var(--color-status-red)',
                              }}
                            >
                              {isTmuxUninstalling ? <Loader2 size={12} className="spin" /> : <Trash2 size={12} />}
                              Remove Configuration
                            </button>
                          )}

                          <div style={{ flex: 1 }} />

                          <button
                            className="btn btn-sm btn-ghost"
                            onClick={fetchTmuxStatus}
                            disabled={isTmuxLoading}
                            style={{ gap: 4 }}
                          >
                            <RefreshCw size={12} className={isTmuxLoading ? 'spin' : ''} />
                            Refresh
                          </button>
                        </div>

                        {/* Action message */}
                        {tmuxMessage && (
                          <div style={{
                            padding: '6px 10px',
                            background: tmuxMessage.type === 'ok'
                              ? 'rgba(74, 222, 128, 0.08)' : 'rgba(248, 113, 113, 0.08)',
                            border: `1px solid ${tmuxMessage.type === 'ok'
                              ? 'rgba(74, 222, 128, 0.2)' : 'rgba(248, 113, 113, 0.2)'}`,
                            borderRadius: 'var(--radius-sm)',
                            fontSize: 11,
                            color: tmuxMessage.type === 'ok'
                              ? 'var(--color-status-green)' : 'var(--color-status-red)',
                            display: 'flex', alignItems: 'center', gap: 6,
                          }}>
                            {tmuxMessage.type === 'ok' ? <CheckCircle size={12} /> : <XCircle size={12} />}
                            {tmuxMessage.text}
                          </div>
                        )}
                      </>
                    )}
                  </div>
                </SectionCard>

                {/* What tmux provides — always visible */}
                <SectionCard title="Why tmux?" icon={Info}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    <FeatureRow
                      title="Shared terminal sessions"
                      description="Multiple browser tabs can view the same Claude Code session simultaneously for real-time collaboration and monitoring."
                    />
                    <FeatureRow
                      title="Background persistence"
                      description="Sessions continue running when you close your browser or disconnect. Reconnect anytime to pick up where you left off."
                    />
                    <FeatureRow
                      title="Optimized scrolling"
                      description="1M line scrollback buffer, mouse scroll support, and seamless copy mode exit when typing — tuned for long Claude Code output."
                    />
                  </div>
                </SectionCard>

                {/* Shell Configuration */}
                <ShellConfigSection tierAgentUrl={tierAgentUrl} />
              </>
            )}
          </div>
        )}

        {/* ═══════════════ CLAUDE CODE TAB ═══════════════ */}
        {activeTab === 'claude-code' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

            {/* Proxied mode */}
            {isProxied && (
              <div style={{
                padding: '16px 20px',
                background: 'var(--color-bg-secondary)',
                borderRadius: 'var(--radius-md)',
                fontSize: 12,
                color: 'var(--color-text-tertiary)',
                textAlign: 'center',
              }}>
                Claude Code configuration is only available in local mode.
              </div>
            )}

            {/* API not reachable */}
            {!isProxied && !localStatus?.healthy && (
              <div style={{
                padding: '16px 20px',
                background: 'rgba(248, 113, 113, 0.06)',
                border: '1px solid rgba(248, 113, 113, 0.15)',
                borderRadius: 'var(--radius-md)',
                display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12,
              }}>
                <div style={{ fontSize: 12, color: 'var(--color-status-red)' }}>
                  Cannot reach tier-agent. Start the server to manage Claude Code configuration.
                </div>
                <button
                  className="btn btn-sm"
                  onClick={handleStartServer}
                  disabled={isStartingServer}
                  style={{
                    gap: 5,
                    background: 'rgba(74, 222, 128, 0.1)',
                    border: '1px solid rgba(74, 222, 128, 0.3)',
                    color: 'var(--color-status-green)',
                  }}
                >
                  {isStartingServer ? <Loader2 size={12} className="spin" /> : <Play size={12} />}
                  {isStartingServer ? 'Starting...' : 'Start Server'}
                </button>
              </div>
            )}

            {/* Main content */}
            {!isProxied && localStatus?.healthy && (
              <>
                {/* Installation Card */}
                <SectionCard title="Installation" icon={Monitor}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                    {isClaudeCodeLoading && !claudeCodeStatus && (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: 'var(--color-text-tertiary)' }}>
                        <Loader2 size={12} className="spin" />
                        Detecting Claude Code...
                      </div>
                    )}

                    {claudeCodeStatus && (
                      <>
                        <InfoRow
                          label="Status"
                          value={claudeCodeStatus.installed ? 'Installed' : 'Not installed'}
                          status={claudeCodeStatus.installed ? 'ok' : 'error'}
                        />
                        {claudeCodeStatus.installed && (
                          <>
                            <InfoRow
                              label="Binary"
                              value={claudeCodeStatus.binaryType === 'claude-native' ? 'claude-native (native binary)' : 'claude (Node wrapper)'}
                            />
                            {claudeCodeStatus.version && (
                              <InfoRow label="Version" value={claudeCodeStatus.version} />
                            )}
                            {claudeCodeStatus.binaryPath && (
                              <InfoRow label="Path" value={claudeCodeStatus.binaryPath} mono copyable />
                            )}
                          </>
                        )}
                        {!claudeCodeStatus.installed && (
                          <div style={{
                            padding: '6px 10px',
                            background: 'rgba(248, 113, 113, 0.08)',
                            border: '1px solid rgba(248, 113, 113, 0.2)',
                            borderRadius: 'var(--radius-sm)',
                            fontSize: 11,
                            color: 'var(--color-status-red)',
                            lineHeight: 1.5,
                          }}>
                            Claude Code is not installed. Install it from{' '}
                            <a href="https://docs.anthropic.com/en/docs/claude-code" target="_blank" rel="noopener noreferrer"
                              style={{ color: 'inherit', textDecoration: 'underline' }}>
                              docs.anthropic.com
                            </a>
                          </div>
                        )}
                      </>
                    )}

                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <div style={{ flex: 1 }} />
                      <button
                        className="btn btn-sm btn-ghost"
                        onClick={fetchClaudeCodeStatus}
                        disabled={isClaudeCodeLoading}
                        style={{ gap: 4 }}
                      >
                        <RefreshCw size={12} className={isClaudeCodeLoading ? 'spin' : ''} />
                        Refresh
                      </button>
                    </div>
                  </div>
                </SectionCard>

                {/* Session Defaults Card */}
                <SectionCard title="Session Defaults" icon={Settings}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                    {claudeCodeConfig ? (
                      <div style={{
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 10,
                        padding: '10px 12px',
                        background: 'var(--color-bg-secondary)',
                        borderRadius: 'var(--radius-sm)',
                      }}>
                        <ToggleRow
                          label="Skip permission prompts"
                          description="Use --dangerously-skip-permissions flag. Allows Claude to execute tools without asking for permission. Use with caution."
                          checked={claudeCodeConfig.skipDangerPermission}
                          onChange={(v) => handleClaudeCodeConfigChange('skipDangerPermission', v)}
                        />
                        <div style={{ borderTop: '1px solid var(--color-border)', margin: '0' }} />
                        <ToggleRow
                          label="Enable Chrome mode"
                          description="Use --chrome flag to enable MCP and browser integration. Only works in direct mode (non-tmux sessions)."
                          checked={claudeCodeConfig.enableChrome}
                          onChange={(v) => handleClaudeCodeConfigChange('enableChrome', v)}
                        />
                        <div style={{ borderTop: '1px solid var(--color-border)', margin: '0' }} />
                        <ToggleRow
                          label="Show context injection"
                          description="Display injected context from the knowledge base in the Claude Code transcript. When off, context is injected silently."
                          checked={claudeCodeConfig.contextInjectDisplay}
                          onChange={(v) => handleClaudeCodeConfigChange('contextInjectDisplay', v)}
                        />
                        <div style={{ borderTop: '1px solid var(--color-border)', margin: '0' }} />
                        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontSize: 11, fontWeight: 500, color: 'var(--color-text-primary)', lineHeight: 1.4 }}>
                              Context injection mode
                            </div>
                            <div style={{ fontSize: 10, color: 'var(--color-text-tertiary)', lineHeight: 1.5, marginTop: 2 }}>
                              MCP: instruct LLM to retrieve context via MCP tools. Suggest: inject pre-fetched context from knowledge base. Off: disable context injection.
                            </div>
                          </div>
                          <div style={{ display: 'flex', gap: 4, flexShrink: 0, marginTop: 1 }}>
                            {(['mcp', 'suggest', 'both', 'off'] as const).map((mode) => (
                              <button
                                key={mode}
                                onClick={() => handleClaudeCodeConfigChange('contextInjectMode', mode)}
                                style={{
                                  padding: '3px 8px',
                                  fontSize: 10,
                                  fontWeight: 500,
                                  borderRadius: 4,
                                  border: 'none',
                                  cursor: 'pointer',
                                  background: claudeCodeConfig.contextInjectMode === mode ? 'var(--color-status-green)' : 'rgba(255,255,255,0.08)',
                                  color: claudeCodeConfig.contextInjectMode === mode ? '#fff' : 'var(--color-text-secondary)',
                                  transition: 'all 0.15s',
                                  textTransform: 'uppercase',
                                  letterSpacing: '0.5px',
                                }}
                              >
                                {mode}
                              </button>
                            ))}
                          </div>
                        </div>
                        <div style={{ borderTop: '1px solid var(--color-border)', margin: '0' }} />
                        <ToggleRow
                          label="Include knowledge"
                          description="Include knowledge entries (verified facts from past sessions) in context injection."
                          checked={claudeCodeConfig.contextInjectKnowledge}
                          onChange={(v) => handleClaudeCodeConfigChange('contextInjectKnowledge', v)}
                        />
                        {claudeCodeConfig.contextInjectKnowledge && (
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingLeft: 4 }}>
                            <span style={{ fontSize: 10, color: 'var(--color-text-tertiary)', minWidth: 60 }}>Max results</span>
                            <input
                              type="number"
                              min={1}
                              max={20}
                              value={claudeCodeConfig.contextInjectKnowledgeCount ?? 3}
                              onChange={(e) => {
                                const v = Math.max(1, Math.min(20, parseInt(e.target.value) || 3));
                                handleClaudeCodeConfigChange('contextInjectKnowledgeCount', v);
                              }}
                              style={{
                                width: 48,
                                padding: '2px 6px',
                                fontSize: 11,
                                fontFamily: 'var(--font-mono)',
                                background: 'var(--color-bg-primary)',
                                border: '1px solid var(--color-border)',
                                borderRadius: 4,
                                color: 'var(--color-text-primary)',
                                textAlign: 'center',
                              }}
                            />
                            <span style={{ fontSize: 10, color: 'var(--color-text-tertiary)' }}>
                              ~{(claudeCodeConfig.contextInjectKnowledgeCount ?? 3) * 80} tokens
                            </span>
                          </div>
                        )}
                        {isExperiment && (<>
                        <div style={{ borderTop: '1px solid var(--color-border)', margin: '0' }} />
                        <ToggleRow
                          label="Include milestones"
                          description="Include milestone entries (recent work summaries) in context injection."
                          checked={claudeCodeConfig.contextInjectMilestones}
                          onChange={(v) => handleClaudeCodeConfigChange('contextInjectMilestones', v)}
                        />
                        {claudeCodeConfig.contextInjectMilestones && (
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingLeft: 4 }}>
                            <span style={{ fontSize: 10, color: 'var(--color-text-tertiary)', minWidth: 60 }}>Max results</span>
                            <input
                              type="number"
                              min={1}
                              max={10}
                              value={claudeCodeConfig.contextInjectMilestoneCount ?? 2}
                              onChange={(e) => {
                                const v = Math.max(1, Math.min(10, parseInt(e.target.value) || 2));
                                handleClaudeCodeConfigChange('contextInjectMilestoneCount', v);
                              }}
                              style={{
                                width: 48,
                                padding: '2px 6px',
                                fontSize: 11,
                                fontFamily: 'var(--font-mono)',
                                background: 'var(--color-bg-primary)',
                                border: '1px solid var(--color-border)',
                                borderRadius: 4,
                                color: 'var(--color-text-primary)',
                                textAlign: 'center',
                              }}
                            />
                            <span style={{ fontSize: 10, color: 'var(--color-text-tertiary)' }}>
                              ~{(claudeCodeConfig.contextInjectMilestoneCount ?? 2) * 40} tokens
                            </span>
                          </div>
                        )}
                        </>)}
                      </div>
                    ) : (
                      <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>
                        Loading configuration...
                      </div>
                    )}
                    <div style={{
                      padding: '6px 10px',
                      background: 'var(--color-bg-secondary)',
                      borderRadius: 'var(--radius-sm)',
                      fontSize: 11,
                      color: 'var(--color-text-tertiary)',
                      lineHeight: 1.6,
                      display: 'flex',
                      gap: 8,
                      alignItems: 'flex-start',
                    }}>
                      <Info size={12} style={{ flexShrink: 0, marginTop: 2 }} />
                      <div>
                        <div style={{ marginBottom: 4 }}>Context injection prepends relevant knowledge/milestones to each prompt before Claude processes it. Token estimates:</div>
                        <div style={{ paddingLeft: 8 }}>
                          <div>Knowledge: ~80 tokens/entry (title + summary). 3 entries &#8776; 240 tokens.</div>
                          <div>Milestones: ~40 tokens/entry (title only). 2 entries &#8776; 80 tokens.</div>
                          <div style={{ marginTop: 4 }}>Best practice: start with 3 knowledge + 2 milestones (~320 tokens). Increase if Claude lacks context; decrease if prompts are long to save context window.</div>
                        </div>
                      </div>
                    </div>
                  </div>
                </SectionCard>

                {/* Search Results Card */}
                <SectionCard title="Search Results" icon={Code2}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                    {claudeCodeConfig ? (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                        <ToggleRow
                          label="Include knowledge"
                          description="Show knowledge entries (verified facts from past sessions) in search results."
                          checked={claudeCodeConfig.searchIncludeKnowledge !== false}
                          onChange={(v) => handleClaudeCodeConfigChange('searchIncludeKnowledge', v)}
                        />
                        {isExperiment && (<>
                        <div style={{ borderTop: '1px solid var(--color-border)', margin: '0' }} />
                        <ToggleRow
                          label="Include milestones"
                          description="Show milestone entries (recent work summaries) in search results."
                          checked={claudeCodeConfig.searchIncludeMilestones === true}
                          onChange={(v) => handleClaudeCodeConfigChange('searchIncludeMilestones', v)}
                        />
                        </>)}
                      </div>
                    ) : (
                      <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>
                        Loading configuration...
                      </div>
                    )}
                    <div style={{
                      padding: '6px 10px',
                      background: 'var(--color-bg-secondary)',
                      borderRadius: 'var(--radius-sm)',
                      fontSize: 11,
                      color: 'var(--color-text-tertiary)',
                      lineHeight: 1.6,
                      display: 'flex',
                      gap: 8,
                      alignItems: 'flex-start',
                    }}>
                      <Info size={12} style={{ flexShrink: 0, marginTop: 2 }} />
                      <span>Controls which result types appear in the title bar search and the search page.</span>
                    </div>
                  </div>
                </SectionCard>

                {/* Context Inject Hook Card */}
                <SectionCard title="Context Inject Hook" icon={Zap}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                    {contextHookStatus && (
                      <>
                        <InfoRow
                          label="Status"
                          value={
                            contextHookStatus.installed
                              ? contextHookStatus.source === 'plugin'
                                ? 'Installed (via plugin)'
                                : 'Installed'
                              : 'Not installed'
                          }
                          status={contextHookStatus.installed ? 'ok' : 'error'}
                        />
                        {contextHookStatus.installed && contextHookStatus.scriptPath && (
                          <InfoRow label="Hook" value="UserPromptSubmit → context-inject-hook.js" />
                        )}

                        {/* Action buttons — only show for manual installs, not plugin-managed */}
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                          {!contextHookStatus.installed && (
                            <button
                              className="btn btn-sm"
                              onClick={handleContextHookInstall}
                              disabled={isContextHookInstalling}
                              style={{
                                gap: 4,
                                background: 'rgba(74, 222, 128, 0.1)',
                                border: '1px solid rgba(74, 222, 128, 0.3)',
                                color: 'var(--color-status-green)',
                              }}
                            >
                              {isContextHookInstalling ? <Loader2 size={12} className="spin" /> : <Download size={12} />}
                              Install Hook
                            </button>
                          )}

                          {contextHookStatus.installed && contextHookStatus.source !== 'plugin' && (
                            <button
                              className="btn btn-sm"
                              onClick={handleContextHookUninstall}
                              disabled={isContextHookUninstalling}
                              style={{
                                gap: 4,
                                background: 'rgba(248, 113, 113, 0.06)',
                                border: '1px solid rgba(248, 113, 113, 0.2)',
                                color: 'var(--color-status-red)',
                              }}
                            >
                              {isContextHookUninstalling ? <Loader2 size={12} className="spin" /> : <Trash2 size={12} />}
                              Remove Hook
                            </button>
                          )}
                        </div>
                      </>
                    )}

                    <div style={{
                      padding: '6px 10px',
                      background: 'var(--color-bg-secondary)',
                      borderRadius: 'var(--radius-sm)',
                      fontSize: 11,
                      color: 'var(--color-text-tertiary)',
                      lineHeight: 1.6,
                      display: 'flex',
                      gap: 8,
                      alignItems: 'flex-start',
                    }}>
                      <Info size={12} style={{ flexShrink: 0, marginTop: 2 }} />
                      <span>
                        {contextHookStatus?.source === 'plugin'
                          ? <>Registered via <code>claude plugin install</code>. The <code>context-inject-hook.js</code> hook runs on each <code>UserPromptSubmit</code>, injecting relevant knowledge and milestones before each Claude Code prompt.</>
                          : <>Registers <code>context-inject-hook.js</code> as a <code>UserPromptSubmit</code> hook in <code>~/.claude/settings.json</code>. Injects relevant knowledge and milestones before each Claude Code prompt.</>
                        }
                      </span>
                    </div>
                  </div>
                </SectionCard>

                {/* Status Line Card */}
                <SectionCard title="Status Line" icon={Terminal}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                    {statuslineStatus && (
                      <>
                        <InfoRow
                          label="Status"
                          value={statuslineStatus.installed ? 'Installed' : 'Not installed'}
                          status={statuslineStatus.installed ? 'ok' : 'error'}
                        />
                        {statuslineStatus.installed && statuslineStatus.features.length > 0 && (
                          <InfoRow
                            label="Features"
                            value={statuslineStatus.features.join(', ')}
                          />
                        )}

                        {/* Action buttons */}
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                          {!statuslineStatus.installed && (
                            <button
                              className="btn btn-sm"
                              onClick={handleStatuslineInstall}
                              disabled={isStatuslineInstalling}
                              style={{
                                gap: 4,
                                background: 'rgba(74, 222, 128, 0.1)',
                                border: '1px solid rgba(74, 222, 128, 0.3)',
                                color: 'var(--color-status-green)',
                              }}
                            >
                              {isStatuslineInstalling ? <Loader2 size={12} className="spin" /> : <Download size={12} />}
                              Install Status Line
                            </button>
                          )}

                          {statuslineStatus.installed && (
                            <button
                              className="btn btn-sm"
                              onClick={handleStatuslineUninstall}
                              disabled={isStatuslineUninstalling}
                              style={{
                                gap: 4,
                                background: 'rgba(248, 113, 113, 0.06)',
                                border: '1px solid rgba(248, 113, 113, 0.2)',
                                color: 'var(--color-status-red)',
                              }}
                            >
                              {isStatuslineUninstalling ? <Loader2 size={12} className="spin" /> : <Trash2 size={12} />}
                              Remove Status Line
                            </button>
                          )}
                        </div>
                      </>
                    )}

                    {/* Action message */}
                    {claudeCodeMessage && (
                      <div style={{
                        padding: '6px 10px',
                        background: claudeCodeMessage.type === 'ok'
                          ? 'rgba(74, 222, 128, 0.08)' : 'rgba(248, 113, 113, 0.08)',
                        border: `1px solid ${claudeCodeMessage.type === 'ok'
                          ? 'rgba(74, 222, 128, 0.2)' : 'rgba(248, 113, 113, 0.2)'}`,
                        borderRadius: 'var(--radius-sm)',
                        fontSize: 11,
                        color: claudeCodeMessage.type === 'ok'
                          ? 'var(--color-status-green)' : 'var(--color-status-red)',
                        display: 'flex', alignItems: 'center', gap: 6,
                      }}>
                        {claudeCodeMessage.type === 'ok' ? <CheckCircle size={12} /> : <XCircle size={12} />}
                        {claudeCodeMessage.text}
                      </div>
                    )}
                  </div>
                </SectionCard>

                {/* MCP Server Card */}
                <SectionCard title="MCP Server" icon={Layers}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                    {mcpStatus && (
                      <>
                        <InfoRow
                          label="Status"
                          value={
                            mcpStatus.installed
                              ? mcpStatus.source === 'plugin'
                                ? 'Active (via plugin)'
                                : (mcpStatus.status || 'Connected')
                              : 'Not installed'
                          }
                          status={mcpStatus.installed ? 'ok' : 'error'}
                        />
                        {mcpStatus.installed && mcpStatus.tools && mcpStatus.tools.length > 0 && (
                          <InfoRow
                            label="Tools"
                            value={mcpStatus.tools.join(', ')}
                          />
                        )}

                        {/* Action buttons — only show for manual installs, not plugin-managed */}
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                          {!mcpStatus.installed && (
                            <button
                              className="btn btn-sm"
                              onClick={handleMcpInstall}
                              disabled={isMcpInstalling}
                              style={{
                                gap: 4,
                                background: 'rgba(74, 222, 128, 0.1)',
                                border: '1px solid rgba(74, 222, 128, 0.3)',
                                color: 'var(--color-status-green)',
                              }}
                            >
                              {isMcpInstalling ? <Loader2 size={12} className="spin" /> : <Download size={12} />}
                              Install MCP Server
                            </button>
                          )}

                          {mcpStatus.installed && mcpStatus.source !== 'plugin' && (
                            <button
                              className="btn btn-sm"
                              onClick={handleMcpUninstall}
                              disabled={isMcpUninstalling}
                              style={{
                                gap: 4,
                                background: 'rgba(248, 113, 113, 0.06)',
                                border: '1px solid rgba(248, 113, 113, 0.2)',
                                color: 'var(--color-status-red)',
                              }}
                            >
                              {isMcpUninstalling ? <Loader2 size={12} className="spin" /> : <Trash2 size={12} />}
                              Remove MCP Server
                            </button>
                          )}
                        </div>
                      </>
                    )}

                    <div style={{
                      padding: '6px 10px',
                      background: 'var(--color-bg-secondary)',
                      borderRadius: 'var(--radius-sm)',
                      fontSize: 11,
                      color: 'var(--color-text-tertiary)',
                      lineHeight: 1.6,
                      display: 'flex',
                      gap: 8,
                      alignItems: 'flex-start',
                    }}>
                      <Info size={12} style={{ flexShrink: 0, marginTop: 2 }} />
                      <span>
                        {mcpStatus?.source === 'plugin'
                          ? <>Registered via <code>claude plugin install</code>. Provides <code>search</code>, <code>detail</code>, and <code>feedback</code> tools to Claude Code. Managed by the plugin system.</>
                          : <>Provides <code>search</code>, <code>detail</code>, and <code>feedback</code> MCP tools to Claude Code for knowledge and milestone context.</>
                        }
                      </span>
                    </div>
                  </div>
                </SectionCard>

                {/* What the status line shows */}
                <SectionCard title="What the Status Line Shows" icon={Info}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    <FeatureRow
                      title="Context window usage"
                      description="Color-coded percentage showing how much of the context window is used (green < 50%, yellow < 80%, red >= 80%)."
                    />
                    <FeatureRow
                      title="Process information"
                      description="Session RAM usage, system free memory, Claude process PID, TTY, and process uptime."
                    />
                    <FeatureRow
                      title="Worktree detection"
                      description="Automatically detects which worktree the session is working in by analyzing file path references in the transcript."
                    />
                    <FeatureRow
                      title="Recent prompts"
                      description="Shows the last 4 user prompts from the session transcript, with the most recent highlighted."
                    />
                  </div>
                </SectionCard>
              </>
            )}
          </div>
        )}
        {/* ═══════════════ DATA LOADING / EXPERIMENT TABS ═══════════════ */}
        {(activeTab === 'data-loading' || activeTab === 'experiment') && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

            {/* Experiment disclaimer + master toggle — only on experiment tab */}
            {activeTab === 'experiment' && (
              <SectionCard title="Experiment Features" icon={FlaskConical}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  <div style={{
                    padding: '10px 14px',
                    borderRadius: 6,
                    background: 'rgba(251,146,60,0.08)',
                    border: '1px solid rgba(251,146,60,0.25)',
                    fontSize: 11,
                    color: 'var(--color-text-secondary)',
                    lineHeight: 1.6,
                  }}>
                    <div style={{ fontWeight: 600, color: 'rgba(251,146,60,0.9)', marginBottom: 4 }}>⚠ Rabbit Hole Warning</div>
                    Trying experiment features may cost lots of token usage from your plan and may not achieve ideal results.
                    It can also downgrade system performance due to background processing overhead.
                    Unless you know what you are doing, do not enable this.
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <input
                      type="checkbox"
                      id="experiment-toggle"
                      checked={isExperiment}
                      onChange={e => handleSetExperiment(e.target.checked)}
                      style={{ cursor: 'pointer', width: 14, height: 14 }}
                    />
                    <label
                      htmlFor="experiment-toggle"
                      style={{ fontSize: 12, fontWeight: 500, color: 'var(--color-text-primary)', cursor: 'pointer', userSelect: 'none' }}
                    >
                      Enable experiment features
                    </label>
                    {isExperiment && (
                      <span style={{
                        fontSize: 10, padding: '1px 6px', borderRadius: 4,
                        background: 'rgba(251,146,60,0.15)', color: 'rgba(251,146,60,0.9)',
                        border: '1px solid rgba(251,146,60,0.3)',
                      }}>ON</span>
                    )}
                  </div>
                  <p style={{ fontSize: 10, color: 'var(--color-text-tertiary)', margin: 0, lineHeight: 1.5 }}>
                    Controls visibility of: Session Dashboard nav, Architecture nav, milestone status bar, milestone search filters, FlowGraph tab in session detail, and milestone/architecture settings below.
                  </p>
                </div>
              </SectionCard>
            )}

            {isProxied ? (
              <SectionCard title="Settings" icon={Layers}>
                <p style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>
                  These settings are only available in local mode.
                </p>
              </SectionCard>
            ) : !localStatus?.healthy ? (
              <SectionCard title="Settings" icon={Layers}>
                <p style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>
                  Cannot reach tier-agent. Start the server to configure settings.
                </p>
              </SectionCard>
            ) : isMilestoneLoading ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: 20 }}>
                <Loader2 size={14} className="spin" />
                <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>Loading milestone settings...</span>
              </div>
            ) : milestoneSettings ? (
              <>
                {milestoneMessage && (
                  <div style={{
                    padding: '8px 12px',
                    borderRadius: 6,
                    fontSize: 11,
                    background: milestoneMessage.type === 'ok' ? 'rgba(52,199,89,0.1)' : 'rgba(255,69,58,0.1)',
                    color: milestoneMessage.type === 'ok' ? 'var(--color-status-green)' : 'var(--color-status-red)',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                  }}>
                    {milestoneMessage.type === 'ok' ? <CheckCircle size={12} /> : <AlertTriangle size={12} />}
                    {milestoneMessage.text}
                  </div>
                )}

                {/* Experiment-only: Milestone Processing, Phase 2 Model, Architecture Model */}
                {activeTab === 'experiment' && isExperiment && (<>
                {/* Milestone Processing */}
                <SectionCard title="Milestone Processing" icon={Activity}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    {isPipelineLoading && !pipelineStatus ? (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <Loader2 size={12} className="spin" />
                        <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>Loading status...</span>
                      </div>
                    ) : pipelineStatus ? (
                      <>
                        {/* Status indicator */}
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <div style={{
                            width: 8, height: 8, borderRadius: '50%',
                            background: pipelineStatus.pipeline.status === 'processing'
                              ? 'var(--color-status-green)'
                              : pipelineStatus.pipeline.status === 'stopping'
                                ? '#f59e0b'
                                : 'var(--color-text-tertiary)',
                            boxShadow: pipelineStatus.pipeline.status === 'processing'
                              ? '0 0 6px rgba(52,199,89,0.5)' : 'none',
                          }} />
                          <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--color-text-primary)' }}>
                            {pipelineStatus.pipeline.status === 'processing' ? 'Processing'
                              : pipelineStatus.pipeline.status === 'stopping' ? 'Stopping...'
                              : pipelineStatus.pipeline.status === 'unavailable' ? 'Unavailable'
                              : 'Idle'}
                          </span>
                          {pipelineStatus.pipeline.status === 'processing' && pipelineStatus.pipeline.currentModel && (
                            <span style={{
                              fontSize: 10, padding: '1px 6px', borderRadius: 4,
                              background: 'rgba(var(--color-accent-rgb, 59,130,246), 0.1)',
                              color: 'var(--color-accent)',
                            }}>
                              using {pipelineStatus.pipeline.currentModel}
                            </span>
                          )}
                        </div>

                        {/* Progress — scoped to scan range */}
                        {(() => {
                          const hasRange = pipelineStatus.scanRangeDays !== null;
                          const enriched = hasRange ? pipelineStatus.milestones.inRangePhase2 : pipelineStatus.milestones.phase2;
                          const total = hasRange ? pipelineStatus.milestones.inRange : pipelineStatus.milestones.total;
                          const pending = total - enriched;
                          const pct = total > 0 ? Math.round((enriched / total) * 100) : 0;
                          const outOfRange = pipelineStatus.milestones.total - (hasRange ? pipelineStatus.milestones.inRange : pipelineStatus.milestones.total);
                          return (
                            <>
                              <div style={{ fontSize: 11, color: 'var(--color-text-secondary)', display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center' }}>
                                <span>{total} detected</span>
                                <span style={{ color: 'var(--color-text-tertiary)' }}>·</span>
                                <span style={{ color: 'var(--color-status-green)' }}>{enriched} enriched</span>
                                {total > 0 && <span style={{ color: 'var(--color-text-tertiary)' }}>({pct}%)</span>}
                                {pending > 0 && (
                                  <><span style={{ color: 'var(--color-text-tertiary)' }}>·</span>
                                  <span style={{ color: 'var(--color-text-tertiary)' }}>{pending} pending</span></>
                                )}
                              </div>
                              <div style={{
                                height: 4, borderRadius: 2, overflow: 'hidden',
                                background: 'rgba(255,255,255,0.06)',
                              }}>
                                <div style={{
                                  height: '100%', borderRadius: 2,
                                  background: 'var(--color-status-green)',
                                  width: `${pct}%`,
                                  transition: 'width 0.3s ease',
                                }} />
                              </div>
                              {hasRange && outOfRange > 0 && (
                                <div style={{ fontSize: 10, color: 'var(--color-text-tertiary)' }}>
                                  {outOfRange} milestones outside scan range ({pipelineStatus.milestones.total} total)
                                </div>
                              )}
                            </>
                          );
                        })()}

                        {/* Throughput when processing */}
                        {pipelineStatus.pipeline.status === 'processing' && pipelineStatus.pipeline.throughput && (
                          <div style={{ fontSize: 10, color: 'var(--color-text-tertiary)', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                            <span>{pipelineStatus.pipeline.throughput.milestonesPerMinute.toFixed(1)}/min</span>
                            <span>{pipelineStatus.pipeline.queueSize} remaining</span>
                            {pipelineStatus.pipeline.errors > 0 && (
                              <span style={{ color: 'var(--color-status-red)' }}>{pipelineStatus.pipeline.errors} errors</span>
                            )}
                          </div>
                        )}

                        {/* Pipeline message */}
                        {pipelineMessage && (
                          <div style={{
                            padding: '6px 10px', borderRadius: 4, fontSize: 10,
                            background: pipelineMessage.type === 'ok' ? 'rgba(52,199,89,0.1)' : 'rgba(255,69,58,0.1)',
                            color: pipelineMessage.type === 'ok' ? 'var(--color-status-green)' : 'var(--color-status-red)',
                            display: 'flex', alignItems: 'center', gap: 4,
                          }}>
                            {pipelineMessage.type === 'ok' ? <CheckCircle size={10} /> : <AlertTriangle size={10} />}
                            {pipelineMessage.text}
                          </div>
                        )}

                        {/* Auto Processing Toggles */}
                        <div style={{ borderTop: '1px solid var(--color-border)', paddingTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
                          <ToggleRow
                            label="Auto detection"
                            description="Automatically detect milestones when sessions change."
                            checked={milestoneSettings.enabled !== false}
                            onChange={(checked) => {
                              setMilestoneSettings({ ...milestoneSettings, enabled: checked });
                              saveMilestoneSettings({ enabled: checked });
                            }}
                          />
                          <ToggleRow
                            label="Auto enrichment"
                            description="Use AI to enrich detected milestones and add to vector search (only for sessions in scan range)."
                            checked={milestoneSettings.autoEnrich === true}
                            onChange={(checked) => {
                              setMilestoneSettings({ ...milestoneSettings, autoEnrich: checked });
                              saveMilestoneSettings({ autoEnrich: checked });
                            }}
                          />
                        </div>

                        {/* Scan Range */}
                        <div style={{ borderTop: '1px solid var(--color-border)', paddingTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
                          <ToggleRow
                            label="Process all sessions"
                            description="When disabled, only recent sessions are processed."
                            checked={milestoneSettings.scanRangeDays === null}
                            onChange={(checked) => {
                              const newVal = checked ? null : 90;
                              setMilestoneSettings({ ...milestoneSettings, scanRangeDays: newVal });
                              saveMilestoneSettings({ scanRangeDays: newVal }).then(() => fetchPipelineStatus());
                            }}
                          />
                          {milestoneSettings.scanRangeDays !== null && (
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingLeft: 4 }}>
                              <span style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}>Scan last</span>
                              <input
                                type="number"
                                min={1}
                                max={365}
                                value={milestoneSettings.scanRangeDays}
                                onChange={(e) => {
                                  const days = parseInt(e.target.value, 10);
                                  if (!isNaN(days) && days > 0) {
                                    setMilestoneSettings({ ...milestoneSettings, scanRangeDays: days });
                                  }
                                }}
                                onBlur={() => {
                                  if (milestoneSettings.scanRangeDays !== null && milestoneSettings.scanRangeDays > 0) {
                                    saveMilestoneSettings({ scanRangeDays: milestoneSettings.scanRangeDays }).then(() => fetchPipelineStatus());
                                  }
                                }}
                                style={{
                                  width: 60,
                                  padding: '4px 8px',
                                  fontSize: 11,
                                  borderRadius: 4,
                                  border: '1px solid var(--color-border)',
                                  background: 'var(--color-bg-secondary)',
                                  color: 'var(--color-text-primary)',
                                  textAlign: 'center',
                                }}
                              />
                              <span style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}>days</span>
                            </div>
                          )}
                        </div>

                        {/* Action buttons */}
                        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                          {(() => {
                            const hasRange = pipelineStatus.scanRangeDays !== null;
                            const pending = hasRange
                              ? (pipelineStatus.milestones.inRange - pipelineStatus.milestones.inRangePhase2)
                              : (pipelineStatus.milestones.total - pipelineStatus.milestones.phase2);
                            return (pipelineStatus.pipeline.status === 'processing' || pipelineStatus.pipeline.status === 'stopping') ? (
                              <button
                                className="btn btn-secondary"
                                onClick={handleStopEnrichment}
                                disabled={isPipelineActionLoading || pipelineStatus.pipeline.status === 'stopping'}
                                style={{ padding: '6px 12px', fontSize: 11, gap: 4 }}
                              >
                                {(isPipelineActionLoading || pipelineStatus.pipeline.status === 'stopping') ? <Loader2 size={11} className="spin" /> : <Square size={11} />}
                                {pipelineStatus.pipeline.status === 'stopping' ? 'Stopping...' : 'Stop'}
                              </button>
                            ) : (
                              <button
                                className="btn btn-primary"
                                onClick={handleStartEnrichment}
                                disabled={isPipelineActionLoading || pending === 0}
                                style={{ padding: '6px 12px', fontSize: 11, gap: 4 }}
                              >
                                {isPipelineActionLoading ? <Loader2 size={11} className="spin" /> : <Play size={11} />}
                                Start Enrichment
                                {pending > 0 && (
                                  <span style={{ opacity: 0.7 }}>({pending})</span>
                                )}
                              </button>
                            );
                          })()}
                          <button
                            className="btn btn-secondary"
                            onClick={handleExtract}
                            disabled={isExtracting}
                            style={{ padding: '6px 10px', fontSize: 11, gap: 4 }}
                          >
                            {isExtracting ? <Loader2 size={11} className="spin" /> : <Zap size={11} />}
                            Scan
                          </button>
                          <button
                            className="btn btn-secondary"
                            onClick={fetchPipelineStatus}
                            disabled={isPipelineLoading}
                            style={{ padding: '6px 10px', fontSize: 11, gap: 4 }}
                          >
                            <RefreshCw size={11} className={isPipelineLoading ? 'spin' : ''} />
                            Refresh
                          </button>
                        </div>

                        {/* Footer */}
                        <div style={{ fontSize: 10, color: 'var(--color-text-tertiary)', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                          <span>
                            {pipelineStatus.scanRangeDays !== null
                              ? `${pipelineStatus.sessions.inRange} of ${pipelineStatus.sessions.total} sessions in range`
                              : `${pipelineStatus.sessions.total} sessions tracked`
                            }
                          </span>
                          {pipelineStatus.pipeline.lastProcessedAt && (
                            <span>Last run {new Date(pipelineStatus.pipeline.lastProcessedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span>
                          )}
                        </div>
                      </>
                    ) : (
                      <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>
                        Pipeline status unavailable
                      </span>
                    )}

                    {/* Enrichment Model */}
                    {milestoneSettings && (
                    <div style={{ borderTop: '1px solid var(--color-border)', paddingTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
                      <div style={{ fontSize: 11, fontWeight: 500, color: 'var(--color-text-secondary)' }}>Enrichment Model</div>
                    {([
                      { value: 'haiku' as const, label: 'Haiku', desc: 'Fast and cost-effective. Good for most milestone summaries.' },
                      { value: 'sonnet' as const, label: 'Sonnet', desc: 'Balanced quality and speed. Better for nuanced summaries.' },
                      { value: 'opus' as const, label: 'Opus', desc: 'Highest quality. Best for complex, multi-faceted milestones.' },
                    ]).map((opt) => (
                      <button
                        key={opt.value}
                        onClick={() => {
                          setMilestoneSettings({ ...milestoneSettings, phase2Model: opt.value });
                          saveMilestoneSettings({ phase2Model: opt.value });
                        }}
                        disabled={isMilestoneSaving}
                        style={{
                          display: 'flex',
                          alignItems: 'flex-start',
                          gap: 10,
                          padding: '8px 10px',
                          borderRadius: 6,
                          border: milestoneSettings.phase2Model === opt.value
                            ? '1px solid var(--color-accent)'
                            : '1px solid var(--color-border)',
                          background: milestoneSettings.phase2Model === opt.value
                            ? 'rgba(var(--color-accent-rgb, 59,130,246), 0.08)'
                            : 'transparent',
                          cursor: 'pointer',
                          textAlign: 'left',
                        }}
                      >
                        <div style={{
                          width: 14,
                          height: 14,
                          borderRadius: '50%',
                          border: milestoneSettings.phase2Model === opt.value
                            ? '4px solid var(--color-accent)'
                            : '2px solid var(--color-text-tertiary)',
                          flexShrink: 0,
                          marginTop: 1,
                        }} />
                        <div style={{ flex: 1 }}>
                          <div style={{ fontSize: 11, fontWeight: 500, color: 'var(--color-text-primary)' }}>
                            {opt.label}
                          </div>
                          <div style={{ fontSize: 10, color: 'var(--color-text-tertiary)', marginTop: 2 }}>
                            {opt.desc}
                          </div>
                        </div>
                      </button>
                    ))}
                    <p style={{ fontSize: 10, color: 'var(--color-text-tertiary)', lineHeight: 1.5, margin: 0 }}>
                      Model used for LLM enrichment. Higher-quality models produce better summaries but cost more and are slower.
                    </p>
                    </div>
                    )}
                  </div>
                </SectionCard>

                {/* Architecture Model */}
                <SectionCard title="Architecture Model" icon={Layers}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {([
                      { value: 'haiku' as const, label: 'Haiku', desc: 'Fastest. Basic architecture analysis for simple projects.' },
                      { value: 'sonnet' as const, label: 'Sonnet', desc: 'Recommended. Good balance of quality and speed for architecture.' },
                      { value: 'opus' as const, label: 'Opus', desc: 'Highest quality. Best for complex multi-service architectures.' },
                    ]).map((opt) => (
                      <button
                        key={opt.value}
                        onClick={() => {
                          setMilestoneSettings({ ...milestoneSettings, architectureModel: opt.value });
                          saveMilestoneSettings({ architectureModel: opt.value });
                        }}
                        disabled={isMilestoneSaving}
                        style={{
                          display: 'flex',
                          alignItems: 'flex-start',
                          gap: 10,
                          padding: '8px 10px',
                          borderRadius: 6,
                          border: milestoneSettings.architectureModel === opt.value
                            ? '1px solid var(--color-accent)'
                            : '1px solid var(--color-border)',
                          background: milestoneSettings.architectureModel === opt.value
                            ? 'rgba(var(--color-accent-rgb, 59,130,246), 0.08)'
                            : 'transparent',
                          cursor: 'pointer',
                          textAlign: 'left',
                        }}
                      >
                        <div style={{
                          width: 14,
                          height: 14,
                          borderRadius: '50%',
                          border: milestoneSettings.architectureModel === opt.value
                            ? '4px solid var(--color-accent)'
                            : '2px solid var(--color-text-tertiary)',
                          flexShrink: 0,
                          marginTop: 1,
                        }} />
                        <div style={{ flex: 1 }}>
                          <div style={{ fontSize: 11, fontWeight: 500, color: 'var(--color-text-primary)' }}>
                            {opt.label}
                          </div>
                          <div style={{ fontSize: 10, color: 'var(--color-text-tertiary)', marginTop: 2 }}>
                            {opt.desc}
                          </div>
                        </div>
                      </button>
                    ))}
                    <p style={{ fontSize: 10, color: 'var(--color-text-tertiary)', lineHeight: 1.5, margin: 0 }}>
                      Model used for AI-powered architecture generation. Independent from the enrichment model.
                    </p>
                  </div>
                </SectionCard>

                {/* End of experiment-only milestone sections */}
                </>)}

                {/* Data Loading tab: Knowledge Processing */}
                {activeTab === 'data-loading' && (
                <SectionCard title="Knowledge Processing" icon={Code2}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    {/* Auto Processing Toggle */}
                    {milestoneSettings && (
                      <ToggleRow
                        label="Auto knowledge processing"
                        description="Automatically generate knowledge from completed explore agents."
                        checked={milestoneSettings.autoKnowledge === true}
                        onChange={(checked) => {
                          setMilestoneSettings({ ...milestoneSettings, autoKnowledge: checked });
                          saveMilestoneSettings({ autoKnowledge: checked });
                        }}
                      />
                    )}

                    {knowledgeStats ? (
                      <>
                        {/* Progress */}
                        {(() => {
                          const total = knowledgeStats.generated + knowledgeStats.candidates;
                          const pct = total > 0 ? Math.round((knowledgeStats.generated / total) * 100) : 0;
                          return (
                            <>
                              <div style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}>
                                {knowledgeStats.generated} generated
                                {knowledgeStats.candidates > 0 && (
                                  <span style={{ color: 'var(--color-text-tertiary)' }}> · {knowledgeStats.candidates} candidates</span>
                                )}
                              </div>
                              {total > 0 && (
                                <div style={{
                                  height: 4, borderRadius: 2, overflow: 'hidden',
                                  background: 'rgba(255,255,255,0.06)',
                                }}>
                                  <div style={{
                                    height: '100%', borderRadius: 2,
                                    background: knowledgeStats.candidates === 0 ? 'var(--color-status-green)' : 'var(--color-accent)',
                                    width: `${pct}%`,
                                    transition: 'width 0.3s ease',
                                  }} />
                                </div>
                              )}
                            </>
                          );
                        })()}

                        {/* Generation status when running */}
                        {isKnowledgeGenerating && knowledgeGenStatus && (
                          <div style={{ fontSize: 10, color: 'var(--color-text-tertiary)', display: 'flex', gap: 8, alignItems: 'center' }}>
                            <Loader2 size={10} className="spin" />
                            <span>
                              Processing{knowledgeGenStatus.total ? ` ${knowledgeGenStatus.processed || 0}/${knowledgeGenStatus.total}` : '...'}
                              {(knowledgeGenStatus.errors ?? 0) > 0 && (
                                <span style={{ color: 'var(--color-status-red)' }}> · {knowledgeGenStatus.errors} errors</span>
                              )}
                            </span>
                          </div>
                        )}

                        {/* Message */}
                        {knowledgeMessage && (
                          <div style={{
                            padding: '6px 10px', borderRadius: 4, fontSize: 10,
                            background: knowledgeMessage.type === 'ok' ? 'rgba(52,199,89,0.1)' : 'rgba(255,69,58,0.1)',
                            color: knowledgeMessage.type === 'ok' ? 'var(--color-status-green)' : 'var(--color-status-red)',
                            display: 'flex', alignItems: 'center', gap: 4,
                          }}>
                            {knowledgeMessage.type === 'ok' ? <CheckCircle size={10} /> : <AlertTriangle size={10} />}
                            {knowledgeMessage.text}
                          </div>
                        )}

                        {/* Action buttons */}
                        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                          {isKnowledgeGenerating ? (
                            <button
                              className="btn btn-secondary"
                              onClick={handleStopKnowledgeGeneration}
                              style={{ padding: '6px 12px', fontSize: 11, gap: 4 }}
                            >
                              <Square size={11} />
                              Stop
                            </button>
                          ) : (
                            <button
                              className="btn btn-primary"
                              onClick={handleStartKnowledgeGeneration}
                              disabled={knowledgeStats.candidates === 0}
                              style={{ padding: '6px 12px', fontSize: 11, gap: 4 }}
                            >
                              <Play size={11} />
                              Generate All
                              {knowledgeStats.candidates > 0 && (
                                <span style={{ opacity: 0.7 }}>({knowledgeStats.candidates})</span>
                              )}
                            </button>
                          )}
                          <button
                            className="btn btn-secondary"
                            onClick={fetchKnowledgeStats}
                            style={{ padding: '6px 10px', fontSize: 11, gap: 4 }}
                          >
                            <RefreshCw size={11} />
                            Refresh
                          </button>
                        </div>

                        <p style={{ fontSize: 10, color: 'var(--color-text-tertiary)', lineHeight: 1.5, margin: 0 }}>
                          Converts explore agent research into structured knowledge documents. Candidates are discovered from completed explore sessions.
                        </p>
                      </>
                    ) : (
                      <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>
                        Knowledge stats unavailable
                      </span>
                    )}
                  </div>
                </SectionCard>

                )}

                {/* Experiment-only: Excluded Projects + Advanced */}
                {activeTab === 'experiment' && isExperiment && (<>
                {/* Excluded Projects */}
                <SectionCard title="Excluded Projects" icon={Shield}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {milestoneSettings.excludedPaths.length > 0 ? (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                        {milestoneSettings.excludedPaths.map((p, i) => (
                          <div
                            key={i}
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: 8,
                              padding: '4px 8px',
                              borderRadius: 4,
                              background: 'var(--color-bg-secondary)',
                              fontSize: 11,
                              fontFamily: 'var(--font-mono)',
                              color: 'var(--color-text-primary)',
                            }}
                          >
                            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p}</span>
                            {p.endsWith('/.milestone') ? (
                              <span style={{ fontSize: 9, color: 'var(--color-text-tertiary)', flexShrink: 0 }}>built-in</span>
                            ) : (
                              <button
                                className="btn-icon"
                                onClick={() => {
                                  const updated = milestoneSettings.excludedPaths.filter((_, idx) => idx !== i);
                                  setMilestoneSettings({ ...milestoneSettings, excludedPaths: updated });
                                  saveMilestoneSettings({ excludedPaths: updated });
                                }}
                                title="Remove"
                                style={{ flexShrink: 0 }}
                              >
                                <X size={11} />
                              </button>
                            )}
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p style={{ fontSize: 11, color: 'var(--color-text-tertiary)', margin: 0 }}>
                        No excluded projects. All sessions will be processed.
                      </p>
                    )}
                    <div style={{ display: 'flex', gap: 6, position: 'relative' }}>
                      <button
                        className="btn btn-secondary"
                        onClick={async () => {
                          if (showProjectPicker) {
                            setShowProjectPicker(false);
                            return;
                          }
                          setProjectPickerLoading(true);
                          setShowProjectPicker(true);
                          try {
                            const res = await fetch(tierAgentUrl + '/projects');
                            const json = await res.json();
                            const paths: string[] = (json.data?.projects || []).map((p: any) => p.path);
                            setAvailableProjects(paths);
                          } catch {
                            setAvailableProjects([]);
                          } finally {
                            setProjectPickerLoading(false);
                          }
                        }}
                        style={{ padding: '6px 10px', fontSize: 11 }}
                      >
                        <FolderPlus size={11} />
                        Add Project
                      </button>
                      <button
                        className="btn btn-secondary"
                        onClick={async () => {
                          try {
                            const res = await fetch(tierAgentUrl + '/milestone-settings/auto-exclude', { method: 'POST' });
                            const json = await res.json();
                            if (json.success) {
                              setMilestoneSettings({ ...milestoneSettings, excludedPaths: json.data.excludedPaths });
                              const count = json.added?.length || 0;
                              setMilestoneMessage({ text: count > 0 ? `Auto-excluded ${count} non-git project${count > 1 ? 's' : ''}` : 'No new projects to exclude', type: 'ok' });
                              setTimeout(() => setMilestoneMessage(null), 3000);
                            }
                          } catch {
                            setMilestoneMessage({ text: 'Failed to auto-exclude', type: 'error' });
                            setTimeout(() => setMilestoneMessage(null), 3000);
                          }
                        }}
                        style={{ padding: '6px 10px', fontSize: 11 }}
                      >
                        <GitBranch size={11} />
                        Auto-exclude non-git
                      </button>
                      {showProjectPicker && (
                        <div style={{
                          position: 'absolute',
                          bottom: '100%',
                          left: 0,
                          right: 0,
                          marginBottom: 4,
                          background: 'var(--color-bg-elevated)',
                          border: '1px solid var(--color-border)',
                          borderRadius: 6,
                          maxHeight: 240,
                          overflowY: 'auto',
                          zIndex: 100,
                          boxShadow: '0 4px 16px rgba(0,0,0,0.3)',
                        }}>
                          <div style={{ padding: '6px 8px', borderBottom: '1px solid var(--color-border)', display: 'flex', alignItems: 'center', gap: 6 }}>
                            <input
                              type="text"
                              value={newExcludedPath}
                              onChange={(e) => setNewExcludedPath(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter' && newExcludedPath.trim()) {
                                  const updated = [...milestoneSettings.excludedPaths, newExcludedPath.trim()];
                                  setMilestoneSettings({ ...milestoneSettings, excludedPaths: updated });
                                  saveMilestoneSettings({ excludedPaths: updated });
                                  setNewExcludedPath('');
                                  setShowProjectPicker(false);
                                }
                                if (e.key === 'Escape') setShowProjectPicker(false);
                              }}
                              placeholder="Custom path or select below..."
                              autoFocus
                              style={{
                                flex: 1,
                                padding: '4px 6px',
                                fontSize: 11,
                                borderRadius: 4,
                                border: '1px solid var(--color-border)',
                                background: 'var(--color-bg-secondary)',
                                color: 'var(--color-text-primary)',
                                fontFamily: 'var(--font-mono)',
                              }}
                            />
                          </div>
                          {projectPickerLoading ? (
                            <div style={{ padding: '12px', textAlign: 'center', fontSize: 11, color: 'var(--color-text-tertiary)' }}>
                              Loading projects...
                            </div>
                          ) : (
                            <>
                              {availableProjects
                                .filter(p => !milestoneSettings.excludedPaths.includes(p))
                                .filter(p => !newExcludedPath || p.toLowerCase().includes(newExcludedPath.toLowerCase()))
                                .map(p => (
                                  <button
                                    key={p}
                                    onClick={() => {
                                      const updated = [...milestoneSettings.excludedPaths, p];
                                      setMilestoneSettings({ ...milestoneSettings, excludedPaths: updated });
                                      saveMilestoneSettings({ excludedPaths: updated });
                                      setShowProjectPicker(false);
                                      setNewExcludedPath('');
                                    }}
                                    style={{
                                      display: 'flex',
                                      alignItems: 'center',
                                      gap: 6,
                                      width: '100%',
                                      padding: '6px 10px',
                                      border: 'none',
                                      background: 'transparent',
                                      color: 'var(--color-text-primary)',
                                      fontSize: 11,
                                      fontFamily: 'var(--font-mono)',
                                      cursor: 'pointer',
                                      textAlign: 'left',
                                    }}
                                    onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--color-bg-hover)')}
                                    onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                                  >
                                    <ChevronRight size={10} style={{ color: 'var(--color-text-tertiary)', flexShrink: 0 }} />
                                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p}</span>
                                  </button>
                                ))}
                              {availableProjects.filter(p => !milestoneSettings.excludedPaths.includes(p)).length === 0 && (
                                <div style={{ padding: '12px', textAlign: 'center', fontSize: 11, color: 'var(--color-text-tertiary)' }}>
                                  All projects already excluded
                                </div>
                              )}
                            </>
                          )}
                        </div>
                      )}
                    </div>
                    <p style={{ fontSize: 10, color: 'var(--color-text-tertiary)', lineHeight: 1.5, margin: 0 }}>
                      Project paths to exclude from milestone processing. Supports trailing glob (*) for prefix matching.
                    </p>
                  </div>
                </SectionCard>

                {/* Advanced Section */}
                <button
                  onClick={() => setShowAdvanced(!showAdvanced)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 6,
                    background: 'none', border: 'none', cursor: 'pointer',
                    fontSize: 12, fontWeight: 500, color: 'var(--color-text-secondary)',
                    padding: '4px 0',
                  }}
                >
                  <ChevronDown
                    size={12}
                    style={{
                      transition: 'transform 0.15s',
                      transform: showAdvanced ? 'rotate(0deg)' : 'rotate(-90deg)',
                    }}
                  />
                  Advanced
                </button>

                {showAdvanced && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                    {/* Button row */}
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      <button
                        className="btn btn-secondary"
                        onClick={handleExtract}
                        disabled={isExtracting}
                        style={{ padding: '6px 10px', fontSize: 11, gap: 4 }}
                      >
                        {isExtracting ? <Loader2 size={11} className="spin" /> : <Zap size={11} />}
                        Extract
                      </button>
                      <button
                        className="btn btn-secondary"
                        onClick={handleVerify}
                        disabled={isVerifying}
                        style={{ padding: '6px 10px', fontSize: 11, gap: 4 }}
                      >
                        {isVerifying ? <Loader2 size={11} className="spin" /> : <CheckCircle size={11} />}
                        Verify
                      </button>
                      <button
                        className="btn btn-secondary"
                        onClick={handleRebuild}
                        disabled={isRebuilding}
                        style={{ padding: '6px 10px', fontSize: 11, gap: 4 }}
                      >
                        {isRebuilding ? <Loader2 size={11} className="spin" /> : <RefreshCw size={11} />}
                        Rebuild
                      </button>
                      <button
                        className="btn btn-secondary"
                        onClick={handleFixIndex}
                        disabled={isFixingIndex}
                        style={{ padding: '6px 10px', fontSize: 11, gap: 4 }}
                      >
                        {isFixingIndex ? <Loader2 size={11} className="spin" /> : <Wrench size={11} />}
                        Fix Index
                      </button>
                    </div>
                    <div style={{ fontSize: 10, color: 'var(--color-text-tertiary)', lineHeight: 1.6 }}>
                      <strong>Extract</strong> — Scan sessions for raw milestones.{' '}
                      <strong>Verify</strong> — Check for data quality issues.{' '}
                      <strong>Rebuild</strong> — Re-enrich all milestones from scratch.{' '}
                      <strong>Fix Index</strong> — Repair vector search index.
                    </div>

                    {/* Verification results */}
                    {verificationResult && (
                      <div className="card" style={{ padding: 12 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10 }}>
                          {verificationResult.summary.sessionsWithProblems === 0
                            ? <CheckCircle size={12} style={{ color: 'var(--color-status-green)' }} />
                            : <AlertTriangle size={12} style={{ color: 'var(--color-status-red)' }} />}
                          <span style={{ fontSize: 12, fontWeight: 600 }}>Verification Results</span>
                        </div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                          <InfoRow label="Scanned" value={`${verificationResult.summary.sessionsScanned} sessions`} />
                          <InfoRow
                            label="Problems"
                            value={verificationResult.summary.sessionsWithProblems > 0
                              ? `${verificationResult.summary.sessionsWithProblems} sessions`
                              : 'None found'}
                            status={verificationResult.summary.sessionsWithProblems === 0 ? 'ok' : 'error'}
                          />
                          {(verificationResult.summary.problemCounts['stuck_phase1'] ?? 0) > 0 && (
                            <InfoRow label="Unenriched" value={`${verificationResult.summary.milestonesByProblem['stuck_phase1'] ?? 0} milestones`} />
                          )}
                          {(verificationResult.summary.problemCounts['incomplete_phase2'] ?? 0) > 0 && (
                            <InfoRow label="Incomplete" value={`${verificationResult.summary.milestonesByProblem['incomplete_phase2'] ?? 0} milestones`} />
                          )}
                          {(verificationResult.summary.problemCounts['bad_data'] ?? 0) > 0 && (
                            <InfoRow label="Low quality" value={`${verificationResult.summary.milestonesByProblem['bad_data'] ?? 0} milestones`} />
                          )}
                        </div>
                      </div>
                    )}

                    {/* Detailed Stats */}
                    {pipelineStatus && (
                      <div className="card" style={{ padding: 12 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10 }}>
                          <Info size={12} />
                          <span style={{ fontSize: 12, fontWeight: 600 }}>Detailed Stats</span>
                        </div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                          <InfoRow
                            label="Sessions"
                            value={pipelineStatus.scanRangeDays !== null
                              ? `${pipelineStatus.sessions.inRange} in range (${pipelineStatus.sessions.inRangePhase2} enriched, ${pipelineStatus.sessions.inRange - pipelineStatus.sessions.inRangePhase2} pending) · ${pipelineStatus.sessions.total} total`
                              : `${pipelineStatus.sessions.total} total (${pipelineStatus.sessions.phase2} enriched, ${pipelineStatus.sessions.total - pipelineStatus.sessions.phase2} pending)`}
                          />
                          <InfoRow
                            label="Vectors"
                            value={`${pipelineStatus.vectors.total} total (${pipelineStatus.vectors.session} session, ${pipelineStatus.vectors.milestone} milestone)`}
                          />
                          <InfoRow
                            label="Vector DB"
                            value={pipelineStatus.vectors.isInitialized ? 'Initialized' : 'Not initialized'}
                            status={pipelineStatus.vectors.isInitialized ? 'ok' : 'error'}
                          />
                          {pipelineStatus.pipeline.errors > 0 && (
                            <InfoRow
                              label="Errors"
                              value={`${pipelineStatus.pipeline.errors}`}
                              status="error"
                            />
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                )}
                </>)} {/* End experiment-only: Excluded Projects + Advanced */}
              </>
            ) : (
              <SectionCard title="Settings" icon={Layers}>
                <p style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>
                  Failed to load settings. Check that the API server is running.
                </p>
              </SectionCard>
            )}

          </div>
        )}

      </div>
    </div>
  );
}

// ============================================
// Shell Configuration Section
// ============================================

function ShellConfigSection({ tierAgentUrl }: { tierAgentUrl: string }) {
  const [shellPath, setShellPath] = useState('');
  const [savedShell, setSavedShell] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ text: string; type: 'ok' | 'error' } | null>(null);

  useEffect(() => {
    async function fetchConfig() {
      try {
        const res = await fetch(tierAgentUrl + '/shell/config');
        if (res.ok) {
          const json = await res.json();
          const shell = json.data?.shell || json.shell || '/bin/bash';
          setShellPath(shell);
          setSavedShell(shell);
        }
      } catch {
        // Ignore
      } finally {
        setLoading(false);
      }
    }
    fetchConfig();
  }, [tierAgentUrl]);

  const handleSave = async () => {
    if (!shellPath.trim()) return;
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch(tierAgentUrl + '/shell/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shell: shellPath.trim() }),
      });
      const json = await res.json();
      if (json.success) {
        setSavedShell(shellPath.trim());
        setMessage({ text: 'Shell configuration saved', type: 'ok' });
      } else {
        setMessage({ text: json.error || 'Failed to save', type: 'error' });
      }
    } catch {
      setMessage({ text: 'Failed to save shell configuration', type: 'error' });
    } finally {
      setSaving(false);
    }
  };

  const handleDetect = async () => {
    try {
      const res = await fetch(tierAgentUrl + '/shell/config');
      if (res.ok) {
        const json = await res.json();
        const shell = json.data?.shell || '/bin/bash';
        setShellPath(shell);
      }
    } catch {
      // Ignore
    }
  };

  const isDirty = shellPath.trim() !== savedShell;

  return (
    <SectionCard title="Shell Configuration" icon={Terminal}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {loading ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: 'var(--color-text-tertiary)' }}>
            <Loader2 size={12} className="spin" />
            Loading shell config...
          </div>
        ) : (
          <>
            <div style={{ fontSize: 11, color: 'var(--color-text-secondary)', lineHeight: 1.5 }}>
              Shell used for plain shell terminals (New Shell button). Does not affect Claude Code sessions.
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input
                type="text"
                value={shellPath}
                onChange={(e) => setShellPath(e.target.value)}
                placeholder="/bin/bash"
                style={{
                  flex: 1,
                  padding: '5px 8px',
                  fontSize: 12,
                  fontFamily: 'var(--font-mono)',
                  background: 'var(--color-bg-secondary)',
                  border: '1px solid var(--color-border)',
                  borderRadius: 'var(--radius-sm)',
                  color: 'var(--color-text-primary)',
                  outline: 'none',
                }}
              />
              <button
                className="btn btn-sm"
                onClick={handleDetect}
                title="Auto-detect from $SHELL"
                style={{ fontSize: 10, padding: '4px 8px' }}
              >
                Detect
              </button>
              <button
                className="btn btn-sm"
                onClick={handleSave}
                disabled={saving || !isDirty}
                style={{ fontSize: 10, padding: '4px 8px' }}
              >
                {saving ? 'Saving...' : 'Save'}
              </button>
            </div>
            {message && (
              <div style={{
                padding: '6px 10px',
                background: message.type === 'ok' ? 'rgba(74, 222, 128, 0.08)' : 'rgba(248, 113, 113, 0.08)',
                border: `1px solid ${message.type === 'ok' ? 'rgba(74, 222, 128, 0.2)' : 'rgba(248, 113, 113, 0.2)'}`,
                borderRadius: 'var(--radius-sm)',
                fontSize: 11,
                color: message.type === 'ok' ? 'var(--color-status-green)' : 'var(--color-status-red)',
              }}>
                {message.text}
              </div>
            )}
          </>
        )}
      </div>
    </SectionCard>
  );
}

// ============================================
// Sub-components
// ============================================

function TabButton({ active, onClick, icon, label, badge }: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  badge?: 'warning';
}) {
  return (
    <button
      onClick={onClick}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '8px 16px',
        fontSize: 12,
        fontWeight: active ? 600 : 400,
        color: active ? 'var(--color-text-primary)' : 'var(--color-text-tertiary)',
        background: 'transparent',
        border: 'none',
        borderBottom: active ? '2px solid var(--color-accent)' : '2px solid transparent',
        cursor: 'pointer',
        transition: 'color 0.15s, border-color 0.15s',
        position: 'relative',
      }}
    >
      {icon}
      {label}
      {badge === 'warning' && (
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 16,
            height: 16,
            borderRadius: '50%',
            background: 'rgba(248, 113, 113, 0.15)',
            border: '1px solid rgba(248, 113, 113, 0.4)',
            fontSize: 10,
            fontWeight: 700,
            color: 'var(--color-status-red)',
            lineHeight: 1,
          }}
          title="Action required"
        >
          !
        </span>
      )}
    </button>
  );
}

function SectionCard({ title, icon: Icon, children }: {
  title: string;
  icon: React.ComponentType<{ size?: number }>;
  children: React.ReactNode;
}) {
  return (
    <div className="card" style={{ padding: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
        <Icon size={14} />
        <h3 style={{ fontSize: 13, fontWeight: 600 }}>{title}</h3>
      </div>
      {children}
    </div>
  );
}

function InfoRow({ label, value, mono, copyable, status }: {
  label: string;
  value: string;
  mono?: boolean;
  copyable?: boolean;
  status?: 'ok' | 'error' | 'warning' | 'loading';
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)', width: 80, flexShrink: 0 }}>
        {label}
      </span>
      <span
        style={{
          fontSize: 11,
          color: 'var(--color-text-primary)',
          fontFamily: mono ? 'var(--font-mono)' : undefined,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          flex: 1,
        }}
        title={value}
      >
        {value}
      </span>
      {status && (
        <span style={{ flexShrink: 0 }}>
          {status === 'ok' && <CheckCircle size={12} style={{ color: 'var(--color-status-green)' }} />}
          {status === 'error' && <XCircle size={12} style={{ color: 'var(--color-status-red)' }} />}
          {status === 'warning' && <AlertTriangle size={12} style={{ color: 'rgb(251, 146, 60)' }} />}
          {status === 'loading' && <RefreshCw size={12} className="spin" style={{ color: 'var(--color-text-tertiary)' }} />}
        </span>
      )}
      {copyable && (
        <button
          className="btn-icon"
          onClick={handleCopy}
          title={copied ? 'Copied!' : 'Copy'}
          style={{ flexShrink: 0 }}
        >
          {copied ? <CheckCircle size={11} style={{ color: 'var(--color-status-green)' }} /> : <Copy size={11} />}
        </button>
      )}
    </div>
  );
}

function ToggleRow({ label, description, checked, onChange }: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 11, fontWeight: 500, color: 'var(--color-text-primary)', lineHeight: 1.4 }}>
          {label}
        </div>
        <div style={{ fontSize: 10, color: 'var(--color-text-tertiary)', lineHeight: 1.5, marginTop: 2 }}>
          {description}
        </div>
      </div>
      <button
        onClick={() => onChange(!checked)}
        style={{
          flexShrink: 0,
          marginTop: 1,
          width: 32,
          height: 18,
          borderRadius: 9,
          border: 'none',
          padding: 2,
          cursor: 'pointer',
          background: checked ? 'var(--color-status-green)' : 'rgba(255,255,255,0.12)',
          transition: 'background 0.15s',
          display: 'flex',
          alignItems: 'center',
        }}
      >
        <div style={{
          width: 14,
          height: 14,
          borderRadius: '50%',
          background: '#fff',
          boxShadow: '0 1px 3px rgba(0,0,0,0.3)',
          transition: 'transform 0.15s',
          transform: checked ? 'translateX(14px)' : 'translateX(0)',
        }} />
      </button>
    </div>
  );
}

function FeatureRow({ title, description }: { title: string; description: string }) {
  return (
    <div style={{ fontSize: 11, lineHeight: 1.5, color: 'var(--color-text-secondary)' }}>
      <span style={{ fontWeight: 600, color: 'var(--color-text-primary)' }}>{title}</span>
      <br />
      {description}
    </div>
  );
}

/** Info popover explaining Cloud vs Local access */
function AccessModeInfo() {
  const [open, setOpen] = useState(false);

  return (
    <div style={{ position: 'relative', display: 'inline-flex' }}>
      <button
        className="btn-icon"
        onClick={() => setOpen(v => !v)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        title="What's the difference?"
        style={{ width: 20, height: 20, flexShrink: 0 }}
      >
        <Info size={12} style={{ color: 'var(--color-text-tertiary)' }} />
      </button>
      {open && (
        <div
          style={{
            position: 'absolute',
            top: '100%',
            left: '50%',
            transform: 'translateX(-50%)',
            marginTop: 6,
            width: 280,
            padding: '12px 14px',
            background: 'var(--color-bg-elevated, var(--color-bg-secondary))',
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius-md, 8px)',
            boxShadow: '0 8px 24px rgba(0,0,0,0.25)',
            zIndex: 50,
            fontSize: 11,
            lineHeight: 1.6,
            color: 'var(--color-text-secondary)',
          }}
        >
          <div style={{ fontWeight: 600, marginBottom: 8, color: 'var(--color-text-primary)', fontSize: 12 }}>
            Cloud vs Local Access
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 2 }}>
                <Globe size={10} style={{ color: 'var(--color-accent)' }} />
                <span style={{ fontWeight: 600, color: 'var(--color-text-primary)' }}>Cloud</span>
              </div>
              <span>
                Access from anywhere via the internet. Requests are proxied through the hub to your machine.
              </span>
            </div>
            <div style={{ borderTop: '1px solid var(--color-border)', paddingTop: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 2 }}>
                <Monitor size={10} style={{ color: 'var(--color-text-secondary)' }} />
                <span style={{ fontWeight: 600, color: 'var(--color-text-primary)' }}>Local</span>
              </div>
              <span>
                Direct connection on localhost. Only accessible from the machine where Claude Code is running.
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ============================================
// Utilities
// ============================================

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  return `${Math.floor(seconds / 86400)}d ${Math.floor((seconds % 86400) / 3600)}h`;
}
