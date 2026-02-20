// ============================================
// Machine types
// ============================================

export interface Machine {
  id: string;
  hostname: string;
  platform: string;
  status: 'online' | 'offline';
  lastHeartbeat?: string;
  connectedAt?: string;
  gatewayId?: string;
  osVersion?: string;
  /** True when this machine is the local machine in hybrid mode */
  isLocal?: boolean;
  /** Local LAN IP address (populated when available) */
  localIp?: string;
  // Cross-reference counts (enriched client-side)
  projectCount?: number;
  sessionCount?: number;
  runningSessionCount?: number;
  taskCounts?: TaskCounts;
  activeTerminalCount?: number;
  totalCost?: number;
}

// ============================================
// Session types
// ============================================

export interface ProcessRunningInfo {
  pid: number;
  source: string;
  managedBy: string;
  tmuxSessionName?: string;
  hasAttachedTtyd?: boolean;
}

/** Whether managedBy value indicates a managed (vs external) process */
export function isProcessManaged(managedBy: string): boolean {
  return managedBy === 'ttyd' || managedBy === 'ttyd-tmux' || managedBy === 'wrapper';
}

/** Short display label for managedBy value */
export function managedByLabel(managedBy: string): string {
  switch (managedBy) {
    case 'ttyd': return 'ttyd';
    case 'ttyd-tmux': return 'tmux';
    case 'wrapper': return 'managed';
    case 'unmanaged-terminal': return 'terminal';
    case 'unmanaged-tmux': return 'ext-tmux';
    default: return 'external';
  }
}

export interface Session {
  sessionId: string;
  projectPath: string;
  projectName: string;
  model?: string;
  lastModified: string;
  size?: number;
  messageCount?: number;
  summary?: string;
  isRunning?: boolean;
  isPaused?: boolean;
  totalCostUsd?: number;
  numTurns?: number;
  agentCount?: number;
  userPromptCount?: number;
  taskCount?: number;
  planCount?: number;
  teamName?: string;
  allTeams?: string[];
  lastUserMessage?: string;
  running?: ProcessRunningInfo;
  // Cross-reference
  machineId: string;
  machineHostname: string;
  machinePlatform: string;
  machineStatus: 'online' | 'offline';
  taskCounts?: TaskCounts;
  hasActiveTerminal?: boolean;
  forkedFromSessionId?: string;
}

export interface SessionDetail {
  sessionId: string;
  projectPath: string;
  model?: string;
  status?: string;
  isActive?: boolean;
  lastModified?: string;
  totalCostUsd?: number;
  numTurns?: number;
  messageCount?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  duration?: number;
  cwd?: string;
  claudeCodeVersion?: string;
  permissionMode?: string;
  messages: SessionMessage[];
  todos?: Todo[];
  tasks?: SessionTask[];
  plans?: CachedPlan[];
  fileChanges?: FileChange[];
  thinkingBlocks?: ThinkingBlock[];
  gitOperations?: GitOperation[];
  dbOperations?: DbOperation[];
  subagents?: SubagentSession[];
  teamName?: string;
  allTeams?: string[];
  taskSubjects?: Record<string, string>;
  lineCount?: number;
  toolUses?: any[];
  running?: ProcessRunningInfo;
  forkedFromSessionId?: string;
}

// ============================================
// Plan types
// ============================================

export interface CachedPlan {
  toolUseId: string;
  status: 'entering' | 'approved';
  planFile?: string;
  planTitle?: string;
  planSummary?: string;
  allowedPrompts?: Array<{ tool: string; prompt: string }>;
  turnIndex: number;
  lineIndex: number;
}

export interface SessionMessage {
  id?: string;
  type: MessageType;
  subtype?: string;
  content: string | ContentBlock[];
  timestamp?: string;
  turnIndex?: number;
  lineIndex?: number;
  // Tool call fields
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolResult?: string;
  // Task/Todo fields
  todos?: Todo[];
  tasks?: SessionTask[];
  // Agent fields
  agentId?: string;
  subagentType?: string;
  // Raw data for non-smart display (progress, system, etc.)
  rawData?: Record<string, unknown>;
}

export type MessageType =
  | 'human'
  | 'assistant'
  | 'thinking'
  | 'system'
  | 'result'
  | 'progress'
  | 'summary'
  | 'todo'
  | 'task'
  | 'error'
  | 'file-history-snapshot'
  | 'queue-operation'
  | 'agent_user'
  | 'agent_assistant'
  | 'plan'
  | 'lastHumanMessage'
  | 'compactMessage';

export interface ContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
}

// ============================================
// Task types
// ============================================

export interface TaskCounts {
  pending: number;
  inProgress: number;
  completed: number;
  total: number;
}

export interface SessionTask {
  id: string;
  subject: string;
  description?: string;
  status: 'pending' | 'in_progress' | 'completed';
  activeForm?: string;
  owner?: string;
  blockedBy?: string[];
  blocks?: string[];
  // Cross-reference
  sessionId?: string;
  projectPath?: string;
  projectName?: string;
  machineId?: string;
  machineHostname?: string;
  machinePlatform?: string;
  machineStatus?: 'online' | 'offline';
  hasActiveTerminal?: boolean;
}

export interface TaskList {
  listId: string;
  projectPath?: string;
  sessionId?: string;
  tasks: SessionTask[];
}

// ============================================
// File operations
// ============================================

export interface FileChange {
  filePath: string;
  action: FileAction;
  remote?: string;
  turnIndex?: number;
}

export type FileAction =
  | 'created'
  | 'edited'
  | 'read'
  | 'deleted'
  | 'copied'
  | 'moved'
  | 'downloaded'
  | 'archive'
  | 'extract'
  | 'permission'
  | 'link'
  | 'remote';

// ============================================
// Thinking blocks
// ============================================

export interface ThinkingBlock {
  content: string;
  turnIndex: number;
  charCount: number;
}

// ============================================
// Git operations
// ============================================

export interface GitOperation {
  type: GitOperationType;
  command?: string;
  branch?: string;
  remote?: string;
  remoteHost?: string;
  files?: string[];
  commitMessage?: string;
  repoUrl?: string;
  commitRef?: string;
  prNumber?: number;
  issueNumber?: number;
  tag?: string;
  turnIndex?: number;
}

export type GitOperationType =
  | 'commit'
  | 'push'
  | 'pull'
  | 'fetch'
  | 'merge'
  | 'branch'
  | 'rebase'
  | 'tag'
  | 'stash'
  | 'gh-cli'
  | 'remote';

// ============================================
// Database operations
// ============================================

export interface DbOperation {
  type: string;
  tables?: string[];
  columns?: string[];
  sql?: string;
  tool?: string;
  remote?: string;
  turnIndex?: number;
}

// ============================================
// Todo types
// ============================================

export interface Todo {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  lineIndex?: number;
}

// ============================================
// Subagent types
// ============================================

export interface SubagentSession {
  agentId: string;
  type?: string;
  model?: string;
  status: 'running' | 'completed' | 'error' | 'pending';
  prompt?: string;
  lastActivityAt?: string;
  turns?: number;
  toolUses?: number;
  tokensUsed?: number;
  toolSummary?: Record<string, number>;
  lastResponse?: string;
  fileSize?: number;
  // Positioning in parent session (from session endpoint's SubagentInvocation)
  turnIndex?: number;
  lineIndex?: number;
  // Full data from /subagents endpoint
  parentUuid?: string;
  parentSessionId?: string;
  cwd?: string;
  numTurns?: number;
  conversation?: SubagentConversationMessage[];
  responses?: { turnIndex: number; lineIndex: number; text: string }[];
  usage?: { inputTokens: number; outputTokens: number };
}

export interface SubagentConversationMessage {
  type: 'user' | 'assistant';
  turnIndex?: number;
  lineIndex?: number;
  content: string;
}

// ============================================
// Project types
// ============================================

export interface Project {
  projectPath: string;
  projectName: string;
  // Cross-reference
  machineId: string;
  machineHostname: string;
  machinePlatform: string;
  machineStatus: 'online' | 'offline';
  sessionCount: number;
  runningSessionCount: number;
  taskCounts?: TaskCounts;
  activeTerminalCount: number;
  totalCost: number;
  lastActivity?: string;
  storageSize?: number;
  lastUserMessage?: string;
  hasClaudeMd?: boolean;
  isGitProject?: boolean;
}

// ============================================
// Terminal types
// ============================================

export interface Terminal {
  sessionId: string;
  consoleUrl?: string;
  status: 'active' | 'available';
  duration?: number;
  // Cross-reference
  projectPath?: string;
  projectName?: string;
  machineId: string;
  machineHostname: string;
  machinePlatform: string;
  machineStatus: 'online' | 'offline';
  taskCounts?: TaskCounts;
}

// ============================================
// Indexed session (AI summary)
// ============================================

export interface IndexedSessionResult {
  sessionId: string;
  summary?: string;
  topics?: string[];
  technologies?: string[];
  actionsTaken?: string[];
  userPrompts?: string[];
  indexedAt?: string;
  status?: string;
  turns?: number;
  totalCost?: number;
  model?: string;
  duration?: number;
}

// ============================================
// Process Dashboard types
// ============================================

export type ProcessManagedBy = 'ttyd' | 'ttyd-tmux' | 'ttyd-shell' | 'wrapper' | 'unmanaged-terminal' | 'unmanaged-tmux' | 'unknown';
export type ProcessSource = 'console-tab' | 'full-window' | 'external-terminal' | 'unknown';

export interface ClaudeProcessInfo {
  pid: number;
  sessionId?: string;
  projectPath?: string;
  startedAt?: string;
  managedBy: ProcessManagedBy;
  tty?: string;
  source?: ProcessSource;
  externalTtydPort?: number;
  tmuxSessionName?: string;
  hasAttachedTtyd?: boolean;
  cpuPercent?: number;
  memoryRssKb?: number;
  // Multi-machine enrichment
  machineId?: string;
  machineHostname?: string;
}

export interface TtydManagedProcess {
  pid: number;
  port: number;
  sessionId: string;
  projectPath?: string;
  startedAt?: string;
  claudePid?: number;
  url?: string;
}

export interface ProcessSummary {
  totalManaged: number;
  totalClaude: number;
  unmanagedCount: number;
  byCategory: Record<string, number>;
}

export interface SystemStats {
  cpuCount: number;
  cpuModel: string;
  loadAvg1: number;
  loadAvg5: number;
  loadAvg15: number;
  cpuUsagePercent: number;
  totalMemoryMb: number;
  usedMemoryMb: number;
  freeMemoryMb: number;
  memoryUsagePercent: number;
  totalDiskGb: number;
  usedDiskGb: number;
  freeDiskGb: number;
  diskUsagePercent: number;
}

export interface RunningProcessesResponse {
  managed: TtydManagedProcess[];
  allClaudeProcesses: ClaudeProcessInfo[];
  summary: ProcessSummary;
  systemStats?: SystemStats;
  /** Server-side hash — pass back via checkRunningProcesses() for delta polling */
  hash?: string;
}

// ============================================
// Milestone types
// ============================================

export type MilestoneType = 'discovery' | 'implementation' | 'bugfix' | 'refactor' | 'decision' | 'configuration';

export interface Milestone {
  id: string;
  sessionId: string;
  index: number;
  startTurn: number;
  endTurn: number;
  startTimestamp: string;
  endTimestamp: string;
  userPrompts: string[];
  filesModified: string[];
  filesRead: string[];
  toolUseSummary: Record<string, number>;
  taskCompletions: string[];
  subagentCount: number;
  title: string | null;
  description: string | null;
  type: MilestoneType | null;
  outcome: string | null;
  facts: string[] | null;
  concepts: string[] | null;
  phase: 1 | 2;
  status: 'complete' | 'in_progress';
  generatedAt: number | null;
  modelUsed: string | null;
}

// ============================================
// App mode
// ============================================

export type AppMode = 'local' | 'hub' | 'hybrid';

/**
 * Proxy info — populated when the app is accessed through the hub web proxy
 * (e.g., langmart.ai/w/:machineId/assist/) rather than directly (localhost:3848).
 *
 * When proxied, some features need special handling:
 * - ttyd terminal: WebSocket URL must go through the proxy relay (not direct localhost)
 * - API calls: Already handled by hub mode API client + proxy shim
 * - Navigation: Already handled by proxy shim script injected by hub
 */
export interface ProxyInfo {
  /** Whether the app is running through the hub web proxy */
  isProxied: boolean;
  /** The proxy base path (e.g., "/w/gw4-xxx/assist") — empty string if not proxied */
  basePath: string;
  /** The machine/gateway ID extracted from proxy URL — null if not proxied */
  machineId: string | null;
}

export interface AppConfig {
  mode: AppMode;
  localApiUrl?: string;
  hubApiUrl?: string;
}

// ============================================
// User info (from hub /auth/validate)
// ============================================

export interface HubUserInfo {
  id: string;
  email: string;
  displayName?: string;
  avatarUrl?: string;
  oauthProvider?: string | null;
  organizationId?: string;
}

// ============================================
// Architecture types
// ============================================

export type Temperature = 'hot' | 'warm' | 'cold';

export interface ProjectArchitecture {
  project: string;
  milestoneCount: number;
  generatedAt: number;
  components: ArchitectureComponent[];
  keyFiles: ArchitectureKeyFile[];
  externalProjects?: ExternalProject[];
  resources?: ArchitectureResource[];
}

export interface ArchitectureComponent {
  directory: string;
  purpose: string;
  fileCount: number;
  milestoneCount: number;
  types: Record<string, number>;
  recentMilestones: string[];
  temperature?: Temperature;
  lastTouched?: string | null;
}

export interface ArchitectureKeyFile {
  filePath: string;
  modifyCount: number;
  readCount: number;
  lastMilestoneTitle: string | null;
  lastMilestoneId: string | null;
  lastTimestamp: string | null;
  temperature?: Temperature;
}

export interface ExternalProject {
  projectRoot: string;
  displayName: string;
  components: ArchitectureComponent[];
  keyFiles: ArchitectureKeyFile[];
  totalMilestones: number;
  totalFiles: number;
}

export type ResourceCategory = 'database' | 'ssh' | 'api' | 'docker' | 'service';
export type ResourceScope = 'internal' | 'external';

export interface ArchitectureResource {
  key: string;
  category: ResourceCategory;
  name: string;
  target: string;
  scope: ResourceScope;
  accessCount: number;
  commands: string[];
  firstSeen: string | null;
  lastSeen: string | null;
  executionContext?: string;
  dbSystem?: string;
  dbTables?: string[];
  dbOperations?: string[];
}

// ============================================
// LLM Architecture Model types
// ============================================

export interface ServiceNode {
  id: string;
  name: string;
  type: 'api-server' | 'web-app' | 'worker' | 'proxy' | 'database' | 'cache' | 'queue' | 'external';
  port?: number;
  description: string;
  technologies: string[];
  responsibilities: string[];
}

export interface ServiceConnection {
  from: string;
  to: string;
  type: 'http' | 'websocket' | 'tcp' | 'proxy' | 'docker' | 'ssh' | 'database';
  label: string;
  description?: string;
  port?: number;
}

export interface DatabaseNode {
  id: string;
  name: string;
  system: string;
  tables: string[];
  usedBy: string[];
}

export interface DataFlow {
  name: string;
  description: string;
  steps: string[];
}

export interface ArchitectureModel {
  summary: string;
  mermaidDiagram: string;
  services: ServiceNode[];
  connections: ServiceConnection[];
  databases: DatabaseNode[];
  dataFlows: DataFlow[];
}

export interface ArchitectureModelResponse {
  model: ArchitectureModel;
  stale: boolean;
  generatedAt: number;
  sessionId?: string;
}
