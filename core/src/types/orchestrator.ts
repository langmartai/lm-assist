/**
 * Orchestrator Type Definitions
 *
 * Hierarchy:
 * - Orchestrator: FULL CONTROL over tier config/metadata, READ-ONLY on tier assets
 * - Sub-tier agents: WRITE own assets, READ-ONLY other tier assets and own config
 */

// ============================================================================
// Tier Registry (Orchestrator-owned)
// ============================================================================

export interface TierRegistry {
  version: string;
  lastUpdated: Date;
  tiers: Record<string, TierEntry>;
}

export interface TierEntry {
  // Identity (orchestrator-managed)
  name: string;                      // "web" | "api" | "database"
  description: string;
  rootPath: string;                  // "web/" | "api/" | "database/"

  // Configuration (orchestrator-managed)
  config: TierConfig;

  // Runtime state (orchestrator-managed)
  state: TierState;

  // Exports (updated by orchestrator after agent execution)
  exports: TierExports;
}

// ============================================================================
// Tier Configuration (Orchestrator writes, Agent reads)
// ============================================================================

export interface TierConfig {
  // Framework selection
  framework: FrameworkChoice | null;
  language: Language | null;
  initialized: boolean;

  // Available options (for UI/CLI selection)
  frameworkOptions: FrameworkOption[];

  // Path configuration
  paths: TierPaths;

  // Agent instructions (injected into CLAUDE.md)
  instructions: string;

  // Bash command permissions
  allowedBashPatterns: string[];
  disallowedBashPatterns: string[];
}

export interface FrameworkChoice {
  id: string;                        // "nextjs" | "hono" | "postgresql"
  name: string;                      // "Next.js" | "Hono" | "PostgreSQL"
  version?: string;                  // "14.0" | "4.0" | "16"
}

export interface FrameworkOption {
  id: string;
  name: string;
  language: Language;
  description?: string;
}

export type Language =
  | "typescript"
  | "javascript"
  | "python"
  | "go"
  | "rust"
  | "sql"
  | null;

export interface TierPaths {
  // Paths agent can write to (relative to tier root)
  write: string[];

  // Paths agent can read from other tiers
  readFrom: Record<string, string[]>;  // { "api": ["src/**"], "database": ["schemas/**"] }
}

// ============================================================================
// Tier State (Orchestrator-managed runtime state)
// ============================================================================

export interface TierState {
  // Process status
  status: TierStatus;

  // Session management
  sessionId: string | null;
  sessionPath: string | null;

  // Execution history
  lastExecution: ExecutionRecord | null;
  executionHistory: ExecutionRecord[];  // Last N executions

  // Cumulative stats
  totalExecutions: number;
  totalCostUsd: number;
  totalTokens: number;
}

export type TierStatus =
  | "uninitialized"    // Framework not selected
  | "idle"             // Ready for tasks
  | "busy"             // Currently executing
  | "error"            // Last execution failed
  | "stopped";         // Manually stopped

export interface ExecutionRecord {
  id: string;
  timestamp: Date;
  prompt: string;
  success: boolean;
  error?: string;
  durationMs: number;
  costUsd: number;
  tokensUsed: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  filesChanged: string[];
  exportsUpdated: boolean;
}

// ============================================================================
// Tier Exports (Orchestrator tracks what each tier provides)
// ============================================================================

export interface TierExports {
  lastScanned: Date | null;

  // Database tier exports
  schemas?: SchemaExport[];

  // API tier exports
  endpoints?: EndpointExport[];

  // Web tier exports
  pages?: PageExport[];
  components?: ComponentExport[];

  // Shared types (any tier can export)
  types?: TypeExport[];
}

export interface SchemaExport {
  name: string;                      // "users" | "preferences"
  type: "table" | "view" | "function";
  path: string;                      // "database/schemas/users.sql"
  columns?: string[];                // ["id", "email", "created_at"]
}

export interface EndpointExport {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;                      // "/api/users/:id"
  handler: string;                   // "api/src/routes/users.ts"
  auth?: boolean;
}

export interface PageExport {
  route: string;                     // "/dashboard"
  component: string;                 // "web/src/pages/dashboard.tsx"
}

export interface ComponentExport {
  name: string;                      // "UserCard"
  path: string;                      // "web/src/components/UserCard.tsx"
  props?: string[];                  // ["userId", "onEdit"]
}

export interface TypeExport {
  name: string;                      // "User"
  path: string;                      // "api/src/types/user.ts"
  tier: string;                      // "api"
}

// ============================================================================
// Orchestrator Request/Response
// ============================================================================

export interface OrchestratorRequest {
  id: string;
  prompt: string;
  timestamp: Date;
  options?: {
    targetTiers?: string[];          // Limit to specific tiers
    dryRun?: boolean;                // Plan only, don't execute
    parallel?: boolean;              // Allow parallel execution where possible
  };
}

export interface OrchestratorResponse {
  requestId: string;
  success: boolean;

  // Planning phase
  plan: TaskPlan;

  // Execution phase
  executions: TierExecution[];

  // Summary
  summary: string;
  totalDurationMs: number;
  totalCostUsd: number;

  // Follow-up suggestions
  suggestions?: string[];
}

export interface TaskPlan {
  reasoning: string;
  tasks: PlannedTask[];
  executionOrder: string[];          // Tier names in execution order
  canParallelize: string[][];        // Groups that can run in parallel
}

export interface PlannedTask {
  tier: string;
  prompt: string;
  priority: number;
  dependsOn: string[];               // Tier names this depends on
  estimatedScope: "small" | "medium" | "large";
}

export interface TierExecution {
  tier: string;
  task: PlannedTask;
  result: ExecutionRecord;
  output: string;                    // Agent's response
  filesChanged: FileChange[];
}

export interface FileChange {
  path: string;
  action: "created" | "modified" | "deleted";
  tier: string;
}

// ============================================================================
// Orchestrator Control Commands
// ============================================================================

export type OrchestratorCommand =
  | { type: "configure"; tier: string; config: Partial<TierConfig> }
  | { type: "initialize"; tier: string; framework: string }
  | { type: "execute"; tier: string; prompt: string }
  | { type: "stop"; tier: string }
  | { type: "stopAll" }
  | { type: "scanExports"; tier: string }
  | { type: "scanAllExports" }
  | { type: "getState"; tier?: string }
  | { type: "resetState"; tier: string };

// ============================================================================
// Inter-Agent Communication
// ============================================================================

/**
 * Request from one tier agent to another
 * Routed through orchestrator
 */
export interface InterAgentRequest {
  id: string;
  timestamp: Date;
  sourceTier: string;           // "web" | "api" | "database" | "deploy"
  targetTier: string;           // "web" | "api" | "database" | "deploy"
  requestType: InterAgentRequestType;
  payload: InterAgentPayload;
  priority: "low" | "normal" | "high";
  status: "pending" | "approved" | "rejected" | "completed" | "failed";
}

export type InterAgentRequestType =
  | "deploy"                    // Request deployment
  | "build"                     // Request build only
  | "migrate"                   // Request database migration
  | "schema_change"             // Request schema modification
  | "endpoint_change"           // Request API endpoint change
  | "ui_change"                 // Request UI modification
  | "info"                      // Request information
  | "custom";

export type InterAgentPayload =
  | DeployRequestPayload
  | BuildRequestPayload
  | MigrateRequestPayload
  | SchemaChangePayload
  | EndpointChangePayload
  | InfoRequestPayload
  | CustomPayload;

export interface DeployRequestPayload {
  type: "deploy";
  target: "web" | "api" | "database" | "all";
  environment: "dev" | "staging" | "prod";
  version?: string;
  message?: string;
}

export interface BuildRequestPayload {
  type: "build";
  target: "web" | "api" | "database" | "all";
  mode?: "development" | "production";
}

export interface MigrateRequestPayload {
  type: "migrate";
  environment: "dev" | "staging" | "prod";
  migrationId?: string;         // Specific migration or "latest"
  direction?: "up" | "down";
}

export interface SchemaChangePayload {
  type: "schema_change";
  description: string;
  tables?: string[];
  breaking?: boolean;
}

export interface EndpointChangePayload {
  type: "endpoint_change";
  description: string;
  endpoints?: Array<{
    method: string;
    path: string;
  }>;
}

export interface InfoRequestPayload {
  type: "info";
  query: string;
}

export interface CustomPayload {
  type: "custom";
  action: string;
  data?: Record<string, unknown>;
}

/**
 * Inter-agent request queue managed by orchestrator
 */
export interface RequestQueue {
  pending: InterAgentRequest[];
  processing: InterAgentRequest | null;
  completed: InterAgentRequest[];
  failed: InterAgentRequest[];
}

/**
 * Agent capabilities for routing
 */
export interface AgentCapabilities {
  tier: string;
  canHandle: InterAgentRequestType[];
  canRequest: InterAgentRequestType[];
}

export const DEFAULT_AGENT_CAPABILITIES: Record<string, AgentCapabilities> = {
  web: {
    tier: "web",
    canHandle: ["ui_change", "info"],
    canRequest: ["deploy", "build", "endpoint_change", "schema_change", "info"],
  },
  api: {
    tier: "api",
    canHandle: ["endpoint_change", "info"],
    canRequest: ["deploy", "build", "schema_change", "ui_change", "info"],
  },
  database: {
    tier: "database",
    canHandle: ["schema_change", "info"],
    canRequest: ["migrate", "endpoint_change", "ui_change", "info"],
  },
  deploy: {
    tier: "deploy",
    canHandle: ["deploy", "build", "migrate"],
    canRequest: ["info"],
  },
};
