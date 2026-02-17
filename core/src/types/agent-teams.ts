/**
 * Agent Teams Types
 *
 * Types for the Opus 4.6 Agent Teams feature (Research Preview).
 * Agent teams allow multiple fully independent Claude Code sessions
 * to work as a coordinated team with shared task lists and messaging.
 *
 * Reference: docs/claude-opus-4-6-changes.md Section 3
 */

// ============================================================================
// Team Configuration
// ============================================================================

/**
 * Display mode for agent teams
 */
export type TeamDisplayMode = 'in-process' | 'tmux' | 'auto';

/**
 * Team member role
 */
export type TeamMemberRole = 'lead' | 'teammate';

/**
 * Team member status
 */
export type TeamMemberStatus = 'active' | 'idle' | 'stopped' | 'error';

/**
 * Team member info
 * Note: Claude Code config.json members have: name, agentId, agentType, model,
 * joinedAt (Unix ms), tmuxPaneId, cwd, subscriptions, backendType.
 * The status/role/lastActiveAt fields are inferred by our service, not stored on disk.
 */
export interface TeamMember {
  /** Human-readable name */
  name: string;
  /** Unique agent ID */
  agentId: string;
  /** Agent type/role description */
  agentType: string;
  /** Model used by the agent */
  model?: string;
  /** Inferred status (not stored in Claude Code config) */
  status?: TeamMemberStatus;
  /** Role in team */
  role?: TeamMemberRole;
  /** When the member joined (Unix ms or ISO string) */
  joinedAt: string | number;
  /** Last activity timestamp */
  lastActiveAt?: string | number;
  /** tmux pane ID (if using tmux display mode) */
  tmuxPaneId?: string;
  /** Working directory */
  cwd?: string;
  /** Backend type (in-process, tmux, etc.) */
  backendType?: string;
}

/**
 * Team configuration stored in ~/.claude/teams/{team-name}/config.json
 */
export interface TeamConfig {
  /** Team name (unique identifier) */
  name: string;
  /** Team description */
  description: string;
  /** Team members */
  members: TeamMember[];
  /** Display mode */
  displayMode: TeamDisplayMode;
  /** When team was created (Unix ms from Claude Code, or ISO string from our API) */
  createdAt: string | number;
  /** Lead agent ID */
  leadAgentId: string;
}

// ============================================================================
// API Request/Response Types
// ============================================================================

/**
 * POST /agent/team/create request body
 */
export interface CreateTeamRequest {
  /** Team name (must be unique, used as directory name) */
  name: string;
  /** Team description */
  description: string;
  /** Display mode for teammate terminals */
  displayMode?: TeamDisplayMode;
}

/**
 * POST /agent/team/create response
 */
export interface CreateTeamResponse {
  /** Whether creation succeeded */
  success: boolean;
  /** Team configuration */
  team?: TeamConfig;
  /** Config file path */
  configPath?: string;
  /** Task list directory path */
  taskListPath?: string;
  /** Error if failed */
  error?: string;
}

/**
 * GET /agent/team/:name response
 */
export interface GetTeamResponse {
  /** Whether lookup succeeded */
  success: boolean;
  /** Team configuration */
  team?: TeamConfig;
  /** Task list directory path */
  taskListPath?: string;
  /** Error if failed */
  error?: string;
}

/**
 * DELETE /agent/team/:name response
 */
export interface DeleteTeamResponse {
  /** Whether cleanup succeeded */
  success: boolean;
  /** Number of members that were active at cleanup */
  activeMemberCount?: number;
  /** Error if failed */
  error?: string;
}

/**
 * GET /agent/teams response
 */
export interface ListTeamsResponse {
  /** Whether listing succeeded */
  success: boolean;
  /** All discovered teams */
  teams: TeamConfig[];
  /** Error if failed */
  error?: string;
}

/**
 * Team environment settings for enabling agent teams
 */
export interface AgentTeamsEnvConfig {
  /** Enable agent teams feature */
  enabled: boolean;
  /** Environment variable name */
  envVar: 'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS';
  /** Environment variable value */
  envValue: '1' | '0';
}

// ============================================================================
// Team Task Types
// ============================================================================

/**
 * Summary of tasks for a team
 */
export interface TeamTaskSummary {
  /** Total number of tasks */
  total: number;
  /** Count by status */
  pending: number;
  inProgress: number;
  completed: number;
  /** Tasks grouped by owner */
  byOwner: Record<string, number>;
}

/**
 * A task within a team's task list
 */
export interface TeamTask {
  /** Task ID */
  id: string;
  /** Task subject */
  subject: string;
  /** Task description */
  description?: string;
  /** Active form text (shown in spinner) */
  activeForm?: string;
  /** Task status */
  status: 'pending' | 'in_progress' | 'completed';
  /** IDs of tasks this blocks */
  blocks: string[];
  /** IDs of tasks blocking this */
  blockedBy: string[];
  /** Owner agent name */
  owner?: string;
  /** Arbitrary metadata */
  metadata?: Record<string, unknown>;
}

// ============================================================================
// Team Message Types
// ============================================================================

/**
 * An inter-agent message extracted from session data
 */
export interface TeamMessage {
  /** Message type */
  type: 'message' | 'broadcast' | 'shutdown_request' | 'shutdown_response';
  /** Sender agent name (from session context) */
  sender?: string;
  /** Recipient agent name */
  recipient?: string;
  /** Message content */
  content: string;
  /** Short summary */
  summary?: string;
  /** Timestamp from the session */
  timestamp?: string;
  /** Session ID where this message was sent */
  sessionId?: string;
  /** Turn index in the session */
  turnIndex?: number;
}

// ============================================================================
// Team Activity Types
// ============================================================================

/**
 * Team operation extracted from session data
 */
export interface TeamOperation {
  /** Operation type */
  type: 'spawnTeam' | 'cleanup' | 'message' | 'broadcast' | 'shutdown_request' | 'shutdown_response';
  /** Team name */
  teamName?: string;
  /** Agent name involved */
  agentName?: string;
  /** Recipient for messages */
  recipient?: string;
  /** Content/description */
  content?: string;
  /** Session ID where operation occurred */
  sessionId?: string;
  /** Timestamp */
  timestamp?: string;
  /** Turn index */
  turnIndex?: number;
}

/**
 * Extended team info with activity data
 */
export interface TeamWithActivity extends TeamConfig {
  /** Task summary for this team */
  taskSummary?: TeamTaskSummary;
  /** Last activity timestamp across all members */
  lastActivity?: string;
}

// ============================================================================
// Enhanced API Response Types
// ============================================================================

/**
 * GET /agent/team/:name/tasks response
 */
export interface GetTeamTasksResponse {
  /** Whether lookup succeeded */
  success: boolean;
  /** Team name */
  teamName?: string;
  /** Task list */
  tasks?: TeamTask[];
  /** Task summary */
  summary?: TeamTaskSummary;
  /** Error if failed */
  error?: string;
}

/**
 * GET /agent/team/:name/messages response
 */
export interface GetTeamMessagesResponse {
  /** Whether lookup succeeded */
  success: boolean;
  /** Team name */
  teamName?: string;
  /** Messages */
  messages?: TeamMessage[];
  /** Error if failed */
  error?: string;
}

/**
 * GET /agent/teams (enhanced) response with activity
 */
export interface ListTeamsWithActivityResponse {
  /** Whether listing succeeded */
  success: boolean;
  /** All discovered teams with activity data */
  teams: TeamWithActivity[];
  /** Error if failed */
  error?: string;
}
