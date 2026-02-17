/**
 * Session DAG Service
 *
 * Unified graph API for querying session conversations, subagent hierarchies,
 * resume branches, team relationships, and task dependencies as directed acyclic graphs.
 *
 * Two DAG layers:
 * - Message DAG (intra-session): nodes = JSONL messages, edges = parentUuid chains
 * - Session DAG (cross-session): nodes = sessions, edges = parent→child relationships
 *
 * Performance:
 * - Zero redundant I/O: raw messages from SessionCache memory cache
 * - Stat-based invalidation: fs.statSync checks file size+mtime
 * - LRU eviction: 100 message DAGs + 50 session DAGs
 * - Batch deduplication: shared cache across batch queries
 */

import * as fs from 'fs';
import * as path from 'path';
import { getSessionCache, type SessionCacheData, type CachedSubagent } from './session-cache';
import { getSessionReader } from './session-reader';
import { getTasksService } from './tasks-service';
import { getAgentTeamsService } from './agent-teams-service';
import type { ContentBlock } from './types';

// ============================================================================
// Types
// ============================================================================

export interface DagNode {
  id: string;
  type: string;
  label: string;
  metadata: Record<string, unknown>;
}

export interface DagEdge {
  from: string;
  to: string;
  type: string;
}

export interface DagGraph {
  nodes: DagNode[];
  edges: DagEdge[];
  rootId: string | null;
  stats: {
    nodeCount: number;
    edgeCount: number;
    maxDepth: number;
    branchCount: number;
  };
}

export type MessageNodeType =
  | 'user'
  | 'assistant'
  | 'tool_use'
  | 'tool_result'
  | 'queue_operation'
  | 'system'
  | 'result'
  | 'progress'
  | 'summary';

export interface MessageNode extends DagNode {
  type: MessageNodeType;
  metadata: {
    uuid: string;
    parentUuid: string | null;
    timestamp: string;
    lineIndex: number;
    slug?: string;
    isSidechain?: boolean;
    text?: string;
    toolName?: string;
    toolUseId?: string;
    agentId?: string;
    model?: string;
    inputTokens?: number;
    outputTokens?: number;
  };
}

export type SessionNodeType =
  | 'session'
  | 'subagent'
  | 'team_lead'
  | 'teammate'
  | 'fork';

export interface SessionNode extends DagNode {
  type: SessionNodeType;
  metadata: {
    sessionId: string;
    projectPath?: string;
    agentId?: string;
    agentType?: string;
    teamName?: string;
    model?: string;
    status: string;
    numTurns: number;
    totalCostUsd: number;
    durationMs: number;
    firstTimestamp?: string;
    lastTimestamp?: string;
    prompt?: string;
    parentToolUseId?: string;
    parentUuid?: string;
  };
}

export interface BranchInfo {
  slug?: string;
  rootUuid: string;
  messageCount: number;
}

export interface ForkPointInfo {
  forkNode: MessageNode;
  branches: Array<{
    slug?: string;
    firstNode: MessageNode;
    messageCount: number;
  }>;
}

export interface MessageNodeContext {
  node: MessageNode;
  parent: MessageNode | null;
  children: MessageNode[];
  siblings: MessageNode[];
  depth: number;
  branch: string | null;
}

export interface RelatedSessions {
  session: { sessionId: string; type: string };
  parent: { sessionId: string; type: string } | null;
  children: Array<{ sessionId: string; type: string; agentId?: string }>;
  siblings: Array<{ sessionId: string; type: string; agentId?: string }>;
  team: { name: string; members: Array<{ sessionId?: string; name: string }> } | null;
  forkedFrom?: { sessionId: string } | null;
  forkChildren?: Array<{ sessionId: string; userPromptCount: number }>;
}

export interface UnifiedDag {
  sessions: { nodes: DagNode[]; edges: DagEdge[] };
  tasks: { nodes: DagNode[]; edges: DagEdge[] };
  crossLinks: Array<{ sessionId: string; taskListId: string; taskCount: number }>;
}

export interface MessageDagOptions {
  maxDepth?: number;
  branch?: string;
  types?: string[];
  includeContent?: boolean;
  fromLine?: number;
  toLine?: number;
}

export interface SessionDagOptions {
  depth?: number;
  includeTeam?: boolean;
  includeSubagents?: boolean;
  includeForks?: boolean;
}

export interface BatchQuery {
  type: 'messageDag' | 'sessionDag' | 'unifiedDag' | 'node' | 'ancestors' | 'descendants' | 'branches' | 'related';
  sessionId: string;
  uuid?: string;
  options?: Record<string, unknown>;
}

export interface BatchResult {
  query: BatchQuery;
  success: boolean;
  data?: unknown;
  error?: string;
  durationMs: number;
}

export interface DagCacheStats {
  messageDagCount: number;
  sessionDagCount: number;
  messageDagHits: number;
  messageDagMisses: number;
  sessionDagHits: number;
  sessionDagMisses: number;
}

// ============================================================================
// Internal cache types
// ============================================================================

interface MessageDagCacheEntry {
  graph: DagGraph;
  nodeMap: Map<string, MessageNode>;
  childrenMap: Map<string, string[]>;
  parentMap: Map<string, string | null>;
  fileSize: number;
  fileMtime: number;
  lastAccessTime: number;
}

interface SessionDagCacheEntry {
  graph: DagGraph;
  team: { name: string; leadSessionId?: string; memberCount: number } | null;
  constituentMtimes: Map<string, number>;
  lastAccessTime: number;
}

// ============================================================================
// Constants
// ============================================================================

const MAX_MESSAGE_DAG_CACHE = 100;
const MAX_SESSION_DAG_CACHE = 50;
const MAX_BATCH_QUERIES = 50;
const TEXT_PREVIEW_LENGTH = 200;
const MAX_SUBAGENT_DEPTH = 5;

// ============================================================================
// SessionDagService
// ============================================================================

export class SessionDagService {
  private messageDagCache = new Map<string, MessageDagCacheEntry>();
  private sessionDagCache = new Map<string, SessionDagCacheEntry>();

  // Stats
  private messageDagHits = 0;
  private messageDagMisses = 0;
  private sessionDagHits = 0;
  private sessionDagMisses = 0;

  // ─── Session Resolution ─────────────────────────────────────────────

  /**
   * Resolve a sessionId to its JSONL file path.
   * Tries default project first, then scans all project dirs.
   */
  resolveSessionPath(sessionId: string): string | null {
    const reader = getSessionReader();

    // Try default project first
    const defaultPath = reader.getSessionFilePath(sessionId);
    if (fs.existsSync(defaultPath)) {
      return defaultPath;
    }

    // Scan all project directories
    const projects = reader.listProjects();
    for (const project of projects) {
      const projectDir = path.join(
        reader.getProjectsDir(),
        project.key
      );
      const sessionPath = path.join(projectDir, `${sessionId}.jsonl`);
      if (fs.existsSync(sessionPath)) {
        return sessionPath;
      }
    }

    return null;
  }

  // ─── Message DAG ────────────────────────────────────────────────────

  /**
   * Build or retrieve the full message DAG for a session.
   */
  async getMessageDag(sessionId: string, options?: MessageDagOptions): Promise<{ graph: DagGraph; branches: BranchInfo[] } | null> {
    const sessionPath = this.resolveSessionPath(sessionId);
    if (!sessionPath) return null;

    const cacheEntry = this.getOrBuildMessageDag(sessionPath, sessionId);
    if (!cacheEntry) return null;

    // Apply filters to a copy of the graph
    let graph = cacheEntry.graph;
    const { maxDepth, branch, types, fromLine, toLine } = options || {};

    if (maxDepth !== undefined || branch || types || fromLine !== undefined || toLine !== undefined) {
      graph = this.filterMessageDag(cacheEntry, { maxDepth, branch, types, fromLine, toLine });
    }

    const branches = this.computeBranches(cacheEntry);
    return { graph, branches };
  }

  /**
   * Get a specific node with context (parent, children, siblings, depth).
   */
  async getNode(sessionId: string, uuid: string): Promise<MessageNodeContext | null> {
    const sessionPath = this.resolveSessionPath(sessionId);
    if (!sessionPath) return null;

    const cacheEntry = this.getOrBuildMessageDag(sessionPath, sessionId);
    if (!cacheEntry) return null;

    const node = cacheEntry.nodeMap.get(uuid);
    if (!node) return null;

    const parentUuid = cacheEntry.parentMap.get(uuid);
    const parent = parentUuid ? cacheEntry.nodeMap.get(parentUuid) || null : null;
    const childUuids = cacheEntry.childrenMap.get(uuid) || [];
    const children = childUuids.map(id => cacheEntry.nodeMap.get(id)!).filter(Boolean);

    // Siblings: other children of same parent
    let siblings: MessageNode[] = [];
    if (parentUuid) {
      const siblingUuids = cacheEntry.childrenMap.get(parentUuid) || [];
      siblings = siblingUuids
        .filter(id => id !== uuid)
        .map(id => cacheEntry.nodeMap.get(id)!)
        .filter(Boolean);
    }

    // Compute depth by walking up (with cycle guard)
    let depth = 0;
    let current = parentUuid;
    const visited = new Set<string>();
    while (current && !visited.has(current)) {
      visited.add(current);
      depth++;
      current = cacheEntry.parentMap.get(current) || null;
    }

    // Determine branch from slug
    const branch = node.metadata.slug || null;

    return { node, parent, children, siblings, depth, branch };
  }

  /**
   * Walk up parentUuid chain to root.
   */
  async getAncestors(sessionId: string, uuid: string): Promise<{ path: MessageNode[]; depth: number } | null> {
    const sessionPath = this.resolveSessionPath(sessionId);
    if (!sessionPath) return null;

    const cacheEntry = this.getOrBuildMessageDag(sessionPath, sessionId);
    if (!cacheEntry) return null;

    if (!cacheEntry.nodeMap.has(uuid)) return null;

    const ancestors: MessageNode[] = [];
    const visited = new Set<string>();
    let current = cacheEntry.parentMap.get(uuid) || null;
    while (current && !visited.has(current)) {
      visited.add(current);
      const node = cacheEntry.nodeMap.get(current);
      if (!node) break;
      ancestors.push(node);
      current = cacheEntry.parentMap.get(current) || null;
    }

    return { path: ancestors, depth: ancestors.length };
  }

  /**
   * Get all descendants of a node (subtree).
   */
  async getDescendants(sessionId: string, uuid: string, maxDepth?: number, types?: string[]): Promise<{ subtree: DagGraph } | null> {
    const sessionPath = this.resolveSessionPath(sessionId);
    if (!sessionPath) return null;

    const cacheEntry = this.getOrBuildMessageDag(sessionPath, sessionId);
    if (!cacheEntry) return null;

    if (!cacheEntry.nodeMap.has(uuid)) return null;

    const nodes: MessageNode[] = [];
    const edges: DagEdge[] = [];
    let maxDepthSeen = 0;
    let branchCount = 0;

    // BFS
    const queue: Array<{ id: string; depth: number }> = [{ id: uuid, depth: 0 }];
    const visited = new Set<string>();
    const includedIds = new Set<string>();

    while (queue.length > 0) {
      const { id, depth } = queue.shift()!;
      if (visited.has(id)) continue;
      visited.add(id);

      if (maxDepth !== undefined && depth > maxDepth) continue;

      const node = cacheEntry.nodeMap.get(id);
      if (!node) continue;

      // Apply type filter (always include root node to anchor the subtree)
      const included = !(types && types.length > 0 && !types.includes(node.type) && id !== uuid);

      if (included) {
        nodes.push(node);
        includedIds.add(id);
        if (depth > maxDepthSeen) maxDepthSeen = depth;
      }

      // Always traverse children so the subtree is fully explored
      const childIds = cacheEntry.childrenMap.get(id) || [];
      if (included && childIds.length > 1) branchCount++;

      for (const childId of childIds) {
        queue.push({ id: childId, depth: depth + 1 });
      }
    }

    // Build edges only between included nodes
    for (const node of nodes) {
      const parentId = cacheEntry.parentMap.get(node.id);
      if (parentId && includedIds.has(parentId)) {
        edges.push({ from: parentId, to: node.id, type: 'parent' });
      }
    }

    return {
      subtree: {
        nodes,
        edges,
        rootId: uuid,
        stats: {
          nodeCount: nodes.length,
          edgeCount: edges.length,
          maxDepth: maxDepthSeen,
          branchCount,
        },
      },
    };
  }

  /**
   * List all branches (fork points with multiple children).
   */
  async getBranches(sessionId: string): Promise<{ forkPoints: ForkPointInfo[] } | null> {
    const sessionPath = this.resolveSessionPath(sessionId);
    if (!sessionPath) return null;

    const cacheEntry = this.getOrBuildMessageDag(sessionPath, sessionId);
    if (!cacheEntry) return null;

    const forkPoints: ForkPointInfo[] = [];

    for (const [parentId, childIds] of cacheEntry.childrenMap) {
      if (childIds.length <= 1) continue;

      const forkNode = cacheEntry.nodeMap.get(parentId);
      if (!forkNode) continue;

      const branches = childIds.map(childId => {
        const firstNode = cacheEntry.nodeMap.get(childId);
        if (!firstNode) return null;

        // Count descendants in this branch
        let messageCount = 0;
        const branchQueue = [childId];
        const branchVisited = new Set<string>();
        while (branchQueue.length > 0) {
          const id = branchQueue.shift()!;
          if (branchVisited.has(id)) continue;
          branchVisited.add(id);
          messageCount++;
          const children = cacheEntry.childrenMap.get(id) || [];
          branchQueue.push(...children);
        }

        return {
          slug: firstNode.metadata.slug,
          firstNode,
          messageCount,
        };
      }).filter((b): b is NonNullable<typeof b> => b !== null);

      forkPoints.push({ forkNode, branches });
    }

    return { forkPoints };
  }

  // ─── Session DAG ────────────────────────────────────────────────────

  /**
   * Build cross-session DAG (subagents, team members, forks).
   */
  async getSessionDag(sessionId: string, options?: SessionDagOptions): Promise<{
    graph: DagGraph;
    team: { name: string; leadSessionId?: string; memberCount: number } | null;
  } | null> {
    const sessionPath = this.resolveSessionPath(sessionId);
    if (!sessionPath) return null;

    // Check cache
    const cachedEntry = this.getValidSessionDagCache(sessionId, sessionPath);
    if (cachedEntry) {
      this.sessionDagHits++;
      cachedEntry.lastAccessTime = Date.now();
      return { graph: cachedEntry.graph, team: cachedEntry.team };
    }

    this.sessionDagMisses++;

    const sessionCache = getSessionCache();
    const cacheData = await sessionCache.getSessionData(sessionPath);
    if (!cacheData) return null;

    const depth = options?.depth ?? MAX_SUBAGENT_DEPTH;
    const includeTeam = options?.includeTeam ?? true;
    const includeSubagents = options?.includeSubagents ?? true;
    const includeForks = options?.includeForks ?? true;

    const nodes: DagNode[] = [];
    const edges: DagEdge[] = [];
    const constituentMtimes = new Map<string, number>();

    // Track file mtime for invalidation
    try {
      const stats = fs.statSync(sessionPath);
      constituentMtimes.set(sessionPath, stats.mtimeMs);
    } catch { /* ignore */ }

    // Root session node
    const rootNode = this.sessionCacheToNode(cacheData, sessionId, 'session');
    nodes.push(rootNode);

    // Add subagent nodes
    if (includeSubagents && cacheData.subagents) {
      await this.addSubagentNodes(sessionId, cacheData, nodes, edges, constituentMtimes, depth, 0);
    }

    // Add team member nodes from all teams in the session
    let teamInfo: { name: string; leadSessionId?: string; memberCount: number } | null = null;
    if (includeTeam) {
      const teams = cacheData.allTeams && cacheData.allTeams.length > 0
        ? cacheData.allTeams
        : cacheData.teamName ? [cacheData.teamName] : [];
      for (const team of teams) {
        const info = await this.addTeamNodes(team, sessionId, nodes, edges, cacheData);
        if (info && (!teamInfo || info.memberCount > teamInfo.memberCount)) {
          teamInfo = info;
        }
      }
    }

    // Add fork nodes
    if (includeForks) {
      this.addForkNodes(sessionId, cacheData, nodes, edges, constituentMtimes);
    }

    // Compute stats
    let maxDepthVal = 0;
    let branchCount = 0;
    const childCounts = new Map<string, number>();
    for (const edge of edges) {
      childCounts.set(edge.from, (childCounts.get(edge.from) || 0) + 1);
    }
    for (const count of childCounts.values()) {
      if (count > 1) branchCount++;
    }

    // BFS for depth
    const depthMap = new Map<string, number>();
    depthMap.set(rootNode.id, 0);
    const bfsQueue = [rootNode.id];
    while (bfsQueue.length > 0) {
      const id = bfsQueue.shift()!;
      const d = depthMap.get(id)!;
      for (const edge of edges) {
        if (edge.from === id && !depthMap.has(edge.to)) {
          depthMap.set(edge.to, d + 1);
          if (d + 1 > maxDepthVal) maxDepthVal = d + 1;
          bfsQueue.push(edge.to);
        }
      }
    }

    const graph: DagGraph = {
      nodes,
      edges,
      rootId: rootNode.id,
      stats: {
        nodeCount: nodes.length,
        edgeCount: edges.length,
        maxDepth: maxDepthVal,
        branchCount,
      },
    };

    // Cache the result
    this.sessionDagCache.set(sessionId, {
      graph,
      team: teamInfo,
      constituentMtimes,
      lastAccessTime: Date.now(),
    });
    this.evictSessionDagCache();

    return { graph, team: teamInfo };
  }

  /**
   * Find all sessions related to a given session.
   */
  async getRelatedSessions(sessionId: string): Promise<RelatedSessions | null> {
    const sessionPath = this.resolveSessionPath(sessionId);
    if (!sessionPath) return null;

    const sessionCache = getSessionCache();
    const cacheData = await sessionCache.getSessionData(sessionPath);
    if (!cacheData) return null;

    const reader = getSessionReader();

    // Determine session type
    const fileName = path.basename(sessionPath);
    const isAgent = fileName.startsWith('agent-');
    const sessionType = isAgent ? 'subagent' : 'session';

    // Find parent if this is a subagent
    let parent: { sessionId: string; type: string } | null = null;
    if (isAgent) {
      // Parent session is the directory name (parent session ID) or derive from path
      const parentDir = path.dirname(sessionPath);
      const parentDirName = path.basename(parentDir);

      // Check if parent dir is a session directory (UUID format)
      if (parentDirName.match(/^[0-9a-f-]{36}$/)) {
        parent = { sessionId: parentDirName, type: 'session' };
      } else {
        // The parent dir might be a subagents dir
        const subagentsParent = path.dirname(parentDir);
        const subagentsParentName = path.basename(subagentsParent);
        if (subagentsParentName.match(/^[0-9a-f-]{36}$/)) {
          parent = { sessionId: subagentsParentName, type: 'session' };
        }
      }
    }

    // Find children (subagents)
    const children: Array<{ sessionId: string; type: string; agentId?: string }> = [];
    if (cacheData.subagents) {
      for (const sub of cacheData.subagents) {
        children.push({
          sessionId: sessionId,
          type: 'subagent',
          agentId: sub.agentId,
        });
      }
    }

    // Find siblings (other subagents of same parent)
    const siblings: Array<{ sessionId: string; type: string; agentId?: string }> = [];
    if (parent && isAgent) {
      const agentIdMatch = fileName.match(/^agent-(.+)\.jsonl$/);
      const myAgentId = agentIdMatch ? agentIdMatch[1] : null;

      const subagentFiles = reader.listSubagentFiles(parent.sessionId);
      for (const file of subagentFiles) {
        if (file.agentId !== myAgentId) {
          siblings.push({
            sessionId: parent.sessionId,
            type: 'subagent',
            agentId: file.agentId,
          });
        }
      }
    }

    // Find team
    let team: RelatedSessions['team'] = null;
    if (cacheData.teamName) {
      const teamsService = getAgentTeamsService();
      const teamResult = teamsService.getTeam(cacheData.teamName);
      if (teamResult.success && teamResult.team) {
        team = {
          name: teamResult.team.name,
          members: teamResult.team.members.map(m => ({
            name: m.name,
          })),
        };
      }
    }

    // Find fork relationships
    const forkedFrom = cacheData.forkedFromSessionId
      ? { sessionId: cacheData.forkedFromSessionId }
      : null;

    const forkChildren: Array<{ sessionId: string; userPromptCount: number }> = [];
    if (cacheData.cwd) {
      const projectSessions = sessionCache.getProjectSessionsFromCache(cacheData.cwd);
      for (const { sessionId: childId, cacheData: childData } of projectSessions) {
        if (childData.forkedFromSessionId === sessionId) {
          forkChildren.push({
            sessionId: childId,
            userPromptCount: childData.numTurns,
          });
        }
      }
    }

    return {
      session: { sessionId, type: sessionType },
      parent,
      children,
      siblings,
      team,
      forkedFrom,
      forkChildren: forkChildren.length > 0 ? forkChildren : undefined,
    };
  }

  // ─── Unified DAG ────────────────────────────────────────────────────

  /**
   * Combined session DAG + task dependency graph.
   */
  async getUnifiedDag(sessionId: string): Promise<UnifiedDag | null> {
    const sessionDagResult = await this.getSessionDag(sessionId);
    if (!sessionDagResult) return null;

    const tasksService = getTasksService();
    const crossLinks: Array<{ sessionId: string; taskListId: string; taskCount: number }> = [];

    // Collect all session IDs from the session DAG
    const sessionIds = new Set<string>();
    for (const node of sessionDagResult.graph.nodes) {
      const sid = (node.metadata as any).sessionId;
      if (sid) sessionIds.add(sid);
    }

    // Also check team name as a task list ID
    if (sessionDagResult.team?.name) {
      sessionIds.add(sessionDagResult.team.name);
    }

    // Gather task graphs
    const allTaskNodes: DagNode[] = [];
    const allTaskEdges: DagEdge[] = [];
    const seenTaskIds = new Set<string>();

    for (const sid of sessionIds) {
      try {
        const depGraph = await tasksService.getDependencyGraph(sid);
        if (depGraph.nodes.length > 0) {
          const taskCount = depGraph.nodes.length;
          crossLinks.push({ sessionId: sid, taskListId: sid, taskCount });

          for (const tn of depGraph.nodes) {
            const taskNodeId = `task-${sid}-${tn.id}`;
            if (!seenTaskIds.has(taskNodeId)) {
              seenTaskIds.add(taskNodeId);
              allTaskNodes.push({
                id: taskNodeId,
                type: 'task',
                label: tn.subject,
                metadata: { status: tn.status, owner: (tn as any).owner, taskListId: sid },
              });
            }
          }

          for (const te of depGraph.edges) {
            allTaskEdges.push({
              from: `task-${sid}-${te.from}`,
              to: `task-${sid}-${te.to}`,
              type: 'blocks',
            });
          }
        }
      } catch {
        // Task list may not exist for this session
      }
    }

    return {
      sessions: {
        nodes: sessionDagResult.graph.nodes,
        edges: sessionDagResult.graph.edges,
      },
      tasks: {
        nodes: allTaskNodes,
        edges: allTaskEdges,
      },
      crossLinks,
    };
  }

  // ─── Batch API ──────────────────────────────────────────────────────

  /**
   * Execute multiple DAG queries in parallel.
   * Max 50 queries per batch. Shared cache benefits batch queries.
   */
  async executeBatch(queries: BatchQuery[]): Promise<BatchResult[]> {
    if (queries.length > MAX_BATCH_QUERIES) {
      return [{
        query: queries[0],
        success: false,
        error: `Batch exceeds maximum of ${MAX_BATCH_QUERIES} queries`,
        durationMs: 0,
      }];
    }

    const results = await Promise.allSettled(
      queries.map(async (query): Promise<BatchResult> => {
        const start = Date.now();
        try {
          const data = await this.executeSingleQuery(query);
          return {
            query,
            success: true,
            data,
            durationMs: Date.now() - start,
          };
        } catch (err: any) {
          return {
            query,
            success: false,
            error: err.message || 'Unknown error',
            durationMs: Date.now() - start,
          };
        }
      })
    );

    return results.map(r => r.status === 'fulfilled' ? r.value : {
      query: {} as BatchQuery,
      success: false,
      error: 'Promise rejected',
      durationMs: 0,
    });
  }

  // ─── Cache Management ───────────────────────────────────────────────

  getCacheStats(): DagCacheStats {
    return {
      messageDagCount: this.messageDagCache.size,
      sessionDagCount: this.sessionDagCache.size,
      messageDagHits: this.messageDagHits,
      messageDagMisses: this.messageDagMisses,
      sessionDagHits: this.sessionDagHits,
      sessionDagMisses: this.sessionDagMisses,
    };
  }

  clearCacheForSession(sessionId: string): void {
    // Clear from message DAG cache (keyed by path)
    const sessionPath = this.resolveSessionPath(sessionId);
    if (sessionPath) {
      this.messageDagCache.delete(sessionPath);
    }
    // Clear from session DAG cache (keyed by session ID)
    this.sessionDagCache.delete(sessionId);
  }

  clearAllCaches(): void {
    this.messageDagCache.clear();
    this.sessionDagCache.clear();
    this.messageDagHits = 0;
    this.messageDagMisses = 0;
    this.sessionDagHits = 0;
    this.sessionDagMisses = 0;
  }

  async warmDagCache(sessionIds: string[]): Promise<{ warmed: number; failed: number }> {
    let warmed = 0;
    let failed = 0;

    for (const sid of sessionIds) {
      try {
        const result = await this.getMessageDag(sid);
        if (result) {
          warmed++;
        } else {
          failed++;
        }
      } catch {
        failed++;
      }
    }

    return { warmed, failed };
  }

  async startBackgroundWarm(): Promise<{ started: boolean; sessionCount: number }> {
    const reader = getSessionReader();
    const projects = reader.listProjects();
    const sessionIds: string[] = [];

    for (const project of projects) {
      // Read session files directly from the project directory using key,
      // because project.path doesn't round-trip through cwdToProjectKey
      const projectDir = path.join(reader.getProjectsDir(), project.key);
      try {
        const files = fs.readdirSync(projectDir)
          .filter(f => f.endsWith('.jsonl') && !f.startsWith('agent-'))
          .slice(0, 20);
        for (const f of files) {
          sessionIds.push(f.replace('.jsonl', ''));
        }
      } catch { /* project dir may not be readable */ }
    }

    // Warm in background (don't await)
    if (sessionIds.length > 0) {
      this.warmDagCache(sessionIds).catch(() => {});
    }

    return { started: true, sessionCount: sessionIds.length };
  }

  // ============================================================================
  // Private Helpers
  // ============================================================================

  /**
   * Get or build the message DAG cache entry for a session path.
   */
  private getOrBuildMessageDag(sessionPath: string, sessionId: string): MessageDagCacheEntry | null {
    // Check cache validity
    let stats: fs.Stats;
    try {
      stats = fs.statSync(sessionPath);
    } catch {
      return null;
    }

    const cached = this.messageDagCache.get(sessionPath);
    if (cached && cached.fileSize === stats.size && cached.fileMtime === stats.mtimeMs) {
      this.messageDagHits++;
      cached.lastAccessTime = Date.now();
      return cached;
    }

    this.messageDagMisses++;

    // Build from session cache (sync for performance)
    const sessionCache = getSessionCache();
    const rawMessages = sessionCache.getRawMessagesSync(sessionPath);
    if (!rawMessages || rawMessages.length === 0) return null;

    const nodeMap = new Map<string, MessageNode>();
    const childrenMap = new Map<string, string[]>();
    const parentMap = new Map<string, string | null>();
    const nodes: MessageNode[] = [];
    const edges: DagEdge[] = [];
    let rootId: string | null = null;

    // Single pass to build maps
    for (const msg of rawMessages) {
      if (!msg.uuid) continue;

      const node = this.rawMessageToNode(msg);
      nodeMap.set(msg.uuid, node);
      nodes.push(node);

      const parentUuid = msg.parentUuid || null;
      parentMap.set(msg.uuid, parentUuid);

      if (parentUuid) {
        const children = childrenMap.get(parentUuid) || [];
        children.push(msg.uuid);
        childrenMap.set(parentUuid, children);
        edges.push({ from: parentUuid, to: msg.uuid, type: 'parent' });
      } else if (!rootId) {
        rootId = msg.uuid;
      }
    }

    // Compute stats via BFS from roots
    let maxDepth = 0;
    let branchCount = 0;
    const depthQueue: Array<{ id: string; depth: number }> = [];
    const visited = new Set<string>();

    // Find all roots
    for (const [id, parent] of parentMap) {
      if (!parent || !nodeMap.has(parent)) {
        depthQueue.push({ id, depth: 0 });
      }
    }

    while (depthQueue.length > 0) {
      const { id, depth } = depthQueue.shift()!;
      if (visited.has(id)) continue;
      visited.add(id);

      if (depth > maxDepth) maxDepth = depth;

      const children = childrenMap.get(id) || [];
      if (children.length > 1) branchCount++;

      for (const childId of children) {
        depthQueue.push({ id: childId, depth: depth + 1 });
      }
    }

    const graph: DagGraph = {
      nodes,
      edges,
      rootId,
      stats: {
        nodeCount: nodes.length,
        edgeCount: edges.length,
        maxDepth,
        branchCount,
      },
    };

    const entry: MessageDagCacheEntry = {
      graph,
      nodeMap,
      childrenMap,
      parentMap,
      fileSize: stats.size,
      fileMtime: stats.mtimeMs,
      lastAccessTime: Date.now(),
    };

    this.messageDagCache.set(sessionPath, entry);
    this.evictMessageDagCache();

    return entry;
  }

  /**
   * Convert a raw JSONL message to a MessageNode.
   */
  private rawMessageToNode(msg: any): MessageNode {
    const uuid = msg.uuid as string;
    const type = this.classifyMessageType(msg);
    const text = this.extractPreview(msg);
    const label = text ? text.slice(0, 80) : `[${type}]`;

    const metadata: MessageNode['metadata'] = {
      uuid,
      parentUuid: msg.parentUuid || null,
      timestamp: msg.timestamp || '',
      lineIndex: msg.lineIndex ?? -1,
      text,
    };

    // Type-specific fields
    if (msg.slug) metadata.slug = msg.slug;
    if (msg.isSidechain) metadata.isSidechain = true;

    if (type === 'assistant' && msg.message?.model) {
      metadata.model = msg.message.model;
    }

    if (msg.message?.usage) {
      metadata.inputTokens = msg.message.usage.input_tokens;
      metadata.outputTokens = msg.message.usage.output_tokens;
    }

    // Extract tool info from assistant content blocks
    if (type === 'assistant' && Array.isArray(msg.message?.content)) {
      const toolBlock = (msg.message.content as ContentBlock[]).find(
        (b: any) => b.type === 'tool_use'
      );
      if (toolBlock && (toolBlock as any).name) {
        metadata.toolName = (toolBlock as any).name;
        metadata.toolUseId = (toolBlock as any).id;
      }
    }

    // Tool result info
    if (type === 'tool_result' && msg.toolUseResult) {
      metadata.toolUseId = msg.toolUseResult.tool_use_id;
    }

    // Progress/agent info
    if (type === 'progress' && msg.agentId) {
      metadata.agentId = msg.agentId;
    }

    return { id: uuid, type, label, metadata };
  }

  /**
   * Classify a raw message into a MessageNodeType.
   */
  private classifyMessageType(msg: any): MessageNodeType {
    const rawType = msg.type as string;

    switch (rawType) {
      case 'user': return 'user';
      case 'assistant': return 'assistant';
      case 'tool_use': return 'tool_use';
      case 'tool_result': return 'tool_result';
      case 'queue_operation': return 'queue_operation';
      case 'result': return 'result';
      case 'progress': return 'progress';
      case 'summary': return 'summary';
      case 'system': return 'system';
      default: return 'system';
    }
  }

  /**
   * Extract a text preview from a raw message.
   */
  private extractPreview(msg: any): string | undefined {
    if (msg.type === 'user' && msg.message?.content) {
      const content = msg.message.content;
      if (typeof content === 'string') {
        return content.slice(0, TEXT_PREVIEW_LENGTH);
      }
      if (Array.isArray(content)) {
        const textBlock = content.find((b: any) => b.type === 'text');
        if (textBlock?.text) return textBlock.text.slice(0, TEXT_PREVIEW_LENGTH);
      }
    }

    if (msg.type === 'assistant' && msg.message?.content) {
      const content = msg.message.content;
      if (typeof content === 'string') {
        return content.slice(0, TEXT_PREVIEW_LENGTH);
      }
      if (Array.isArray(content)) {
        const textBlock = content.find((b: any) => b.type === 'text');
        if (textBlock?.text) return textBlock.text.slice(0, TEXT_PREVIEW_LENGTH);
      }
    }

    if (msg.type === 'tool_result' && msg.toolUseResult?.content) {
      return String(msg.toolUseResult.content).slice(0, TEXT_PREVIEW_LENGTH);
    }

    if (msg.type === 'summary' && msg.summary) {
      return String(msg.summary).slice(0, TEXT_PREVIEW_LENGTH);
    }

    return undefined;
  }

  /**
   * Filter a message DAG by options, returning a new DagGraph.
   */
  private filterMessageDag(
    entry: MessageDagCacheEntry,
    opts: { maxDepth?: number; branch?: string; types?: string[]; fromLine?: number; toLine?: number }
  ): DagGraph {
    const { maxDepth, branch, types, fromLine, toLine } = opts;
    const filteredNodes: MessageNode[] = [];
    const includedIds = new Set<string>();

    for (const [id, node] of entry.nodeMap) {
      const meta = node.metadata;

      // Line range filter
      if (fromLine !== undefined && meta.lineIndex < fromLine) continue;
      if (toLine !== undefined && meta.lineIndex > toLine) continue;

      // Type filter
      if (types && types.length > 0 && !types.includes(node.type)) continue;

      // Branch filter
      if (branch && meta.slug && meta.slug !== branch) continue;

      filteredNodes.push(node);
      includedIds.add(id);
    }

    // Depth filter via BFS
    if (maxDepth !== undefined) {
      const depthIncluded = new Set<string>();
      const queue: Array<{ id: string; depth: number }> = [];

      // Find roots in filtered set
      for (const node of filteredNodes) {
        const parentId = entry.parentMap.get(node.id);
        if (!parentId || !includedIds.has(parentId)) {
          queue.push({ id: node.id, depth: 0 });
        }
      }

      while (queue.length > 0) {
        const { id, depth } = queue.shift()!;
        if (depthIncluded.has(id)) continue;
        if (depth > maxDepth) continue;

        depthIncluded.add(id);
        const children = entry.childrenMap.get(id) || [];
        for (const childId of children) {
          if (includedIds.has(childId)) {
            queue.push({ id: childId, depth: depth + 1 });
          }
        }
      }

      // Prune nodes not within depth
      const prunedNodes = filteredNodes.filter(n => depthIncluded.has(n.id));
      includedIds.clear();
      for (const n of prunedNodes) includedIds.add(n.id);
      filteredNodes.length = 0;
      filteredNodes.push(...prunedNodes);
    }

    const filteredEdges = entry.graph.edges.filter(
      e => includedIds.has(e.from) && includedIds.has(e.to)
    );

    // Recompute stats
    let computedMaxDepth = 0;
    let branchCount = 0;
    const childCounts = new Map<string, number>();
    for (const e of filteredEdges) {
      childCounts.set(e.from, (childCounts.get(e.from) || 0) + 1);
    }
    for (const count of childCounts.values()) {
      if (count > 1) branchCount++;
    }

    // BFS depth
    const depthQueue: Array<{ id: string; depth: number }> = [];
    const visited = new Set<string>();
    for (const node of filteredNodes) {
      const parentId = entry.parentMap.get(node.id);
      if (!parentId || !includedIds.has(parentId)) {
        depthQueue.push({ id: node.id, depth: 0 });
      }
    }
    while (depthQueue.length > 0) {
      const { id, depth } = depthQueue.shift()!;
      if (visited.has(id)) continue;
      visited.add(id);
      if (depth > computedMaxDepth) computedMaxDepth = depth;
      const children = entry.childrenMap.get(id) || [];
      for (const childId of children) {
        if (includedIds.has(childId)) {
          depthQueue.push({ id: childId, depth: depth + 1 });
        }
      }
    }

    // Find root
    let rootId: string | null = null;
    for (const node of filteredNodes) {
      const parentId = entry.parentMap.get(node.id);
      if (!parentId || !includedIds.has(parentId)) {
        rootId = node.id;
        break;
      }
    }

    return {
      nodes: filteredNodes,
      edges: filteredEdges,
      rootId,
      stats: {
        nodeCount: filteredNodes.length,
        edgeCount: filteredEdges.length,
        maxDepth: computedMaxDepth,
        branchCount,
      },
    };
  }

  /**
   * Compute branch info from a cached message DAG.
   */
  private computeBranches(entry: MessageDagCacheEntry): BranchInfo[] {
    const branches: BranchInfo[] = [];
    const seen = new Set<string>();

    for (const [parentId, childIds] of entry.childrenMap) {
      if (childIds.length <= 1) continue;

      for (const childId of childIds) {
        if (seen.has(childId)) continue;
        seen.add(childId);

        const node = entry.nodeMap.get(childId);
        if (!node) continue;

        // Count messages in this branch
        let count = 0;
        const bfsQueue = [childId];
        const visited = new Set<string>();
        while (bfsQueue.length > 0) {
          const id = bfsQueue.shift()!;
          if (visited.has(id)) continue;
          visited.add(id);
          count++;
          const children = entry.childrenMap.get(id) || [];
          bfsQueue.push(...children);
        }

        branches.push({
          slug: node.metadata.slug,
          rootUuid: childId,
          messageCount: count,
        });
      }
    }

    return branches;
  }

  /**
   * Convert SessionCacheData to a SessionNode.
   */
  private sessionCacheToNode(
    data: SessionCacheData,
    sessionId: string,
    type: SessionNodeType
  ): SessionNode {
    const status = data.success ? 'completed' : (data.errors?.length ? 'error' : 'running');
    const label = type === 'session'
      ? 'Main session'
      : type === 'subagent'
        ? `Subagent: ${data.model || 'unknown'}`
        : `${type}: ${sessionId.slice(0, 8)}`;

    return {
      id: sessionId,
      type,
      label,
      metadata: {
        sessionId,
        model: data.model,
        status,
        numTurns: data.numTurns,
        totalCostUsd: data.totalCostUsd,
        durationMs: data.durationMs,
        firstTimestamp: data.firstTimestamp,
        lastTimestamp: data.lastTimestamp,
      },
    };
  }

  /**
   * Recursively add subagent nodes to the session DAG.
   */
  private async addSubagentNodes(
    parentSessionId: string,
    parentData: SessionCacheData,
    nodes: DagNode[],
    edges: DagEdge[],
    constituentMtimes: Map<string, number>,
    maxDepth: number,
    currentDepth: number
  ): Promise<void> {
    if (currentDepth >= maxDepth) return;

    const reader = getSessionReader();
    const sessionCache = getSessionCache();

    for (const sub of parentData.subagents || []) {
      // Use agentId if available, fall back to toolUseId for background agents
      // that never received agent_progress events
      const uniqueId = sub.agentId || sub.toolUseId;
      const agentNodeId = `agent-${uniqueId}`;

      // Build node from subagent metadata
      const subNode: SessionNode = {
        id: agentNodeId,
        type: 'subagent',
        label: `${sub.type || 'Subagent'}: ${(sub.description || sub.prompt || '').slice(0, 60)}`,
        metadata: {
          sessionId: parentSessionId,
          agentId: sub.agentId || undefined,
          agentType: sub.type,
          model: sub.model,
          status: sub.status || 'unknown',
          numTurns: 0,
          totalCostUsd: 0,
          durationMs: 0,
          prompt: sub.prompt ? sub.prompt.slice(0, TEXT_PREVIEW_LENGTH) : undefined,
          parentToolUseId: sub.toolUseId,
          parentUuid: sub.parentUuid,
          firstTimestamp: sub.startedAt,
          lastTimestamp: sub.completedAt,
        },
      };

      nodes.push(subNode);
      edges.push({ from: parentSessionId, to: agentNodeId, type: 'subagent' });

      // Try to read subagent session data for more details
      const subagentFiles = reader.listSubagentFiles(parentSessionId);
      const agentFile = sub.agentId
        ? subagentFiles.find(f => f.agentId === sub.agentId)
        : undefined;
      if (agentFile) {
        try {
          const stats = fs.statSync(agentFile.filePath);
          constituentMtimes.set(agentFile.filePath, stats.mtimeMs);

          const agentData = await sessionCache.getSessionData(agentFile.filePath);
          if (agentData) {
            // Update node with actual session data
            subNode.metadata.numTurns = agentData.numTurns;
            subNode.metadata.totalCostUsd = agentData.totalCostUsd;
            subNode.metadata.durationMs = agentData.durationMs;
            subNode.metadata.model = agentData.model || subNode.metadata.model;

            // Recurse into nested subagents
            if (agentData.subagents && agentData.subagents.length > 0) {
              await this.addSubagentNodes(
                agentNodeId, agentData, nodes, edges,
                constituentMtimes, maxDepth, currentDepth + 1
              );
            }
          }
        } catch { /* agent file may not be readable */ }
      }
    }
  }

  /**
   * Add team member nodes to the session DAG.
   * First tries live team config, then falls back to session cache data
   * (teamOperations + teamMessages + subagent prompts) for cleaned-up teams.
   */
  private async addTeamNodes(
    teamName: string,
    leadSessionId: string,
    nodes: DagNode[],
    edges: DagEdge[],
    cacheData?: SessionCacheData
  ): Promise<{ name: string; leadSessionId?: string; memberCount: number } | null> {
    // Try live team config first
    const teamsService = getAgentTeamsService();
    const teamResult = teamsService.getTeam(teamName);
    if (teamResult.success && teamResult.team) {
      const team = teamResult.team;
      for (const member of team.members) {
        if (member.role === 'lead') continue;
        const memberId = `team-${teamName}-${member.name}`;
        const memberNode: SessionNode = {
          id: memberId,
          type: 'teammate',
          label: `${member.name} (${member.agentType || 'agent'})`,
          metadata: {
            sessionId: member.agentId,
            agentType: member.agentType,
            teamName,
            status: member.status || 'unknown',
            numTurns: 0,
            totalCostUsd: 0,
            durationMs: 0,
          },
        };
        nodes.push(memberNode);
        edges.push({ from: leadSessionId, to: memberId, type: 'team_lead' });
      }
      return { name: team.name, leadSessionId, memberCount: team.members.length };
    }

    // Fallback: reconstruct team members from session cache data
    if (!cacheData) return null;

    // Extract member names from:
    // 1. SendMessage recipients (shutdown_request, message, etc.)
    // 2. Task tool calls with team-related prompts that mention the team name
    const memberNames = new Set<string>();

    // Find the turnIndex range for this team (between spawnTeam and cleanup)
    const teamOps = cacheData.teamOperations || [];
    let teamStartTurn = -1;
    let teamEndTurn = Infinity;
    for (const op of teamOps) {
      if (op.operation === 'spawnTeam' && op.teamName === teamName) {
        teamStartTurn = op.turnIndex;
      } else if (op.operation === 'cleanup' && teamStartTurn >= 0 && teamEndTurn === Infinity) {
        teamEndTurn = op.turnIndex;
      }
    }

    // Get member names from SendMessage recipients within the team's turn range
    for (const msg of cacheData.teamMessages || []) {
      if (msg.recipient && msg.turnIndex >= teamStartTurn && msg.turnIndex <= teamEndTurn) {
        memberNames.add(msg.recipient);
      }
    }

    // Get member names from Task tool calls that mention the team name in their prompt
    for (const sub of cacheData.subagents || []) {
      if (sub.turnIndex >= teamStartTurn && sub.turnIndex <= teamEndTurn) {
        // Extract name from prompt like: 'You are a code reviewer on team "dag-review"...(owner: "service-reviewer"'
        const nameMatch = sub.prompt?.match(/owner:\s*"([^"]+)"/);
        if (nameMatch) {
          memberNames.add(nameMatch[1]);
        }
      }
    }

    if (memberNames.size === 0) return null;

    // Create team member nodes
    for (const name of memberNames) {
      const memberId = `team-${teamName}-${name}`;
      // Check if already added (avoid duplicates from subagent nodes)
      if (nodes.some(n => n.id === memberId)) continue;

      const memberNode: SessionNode = {
        id: memberId,
        type: 'teammate',
        label: `${name} (${teamName})`,
        metadata: {
          sessionId: leadSessionId,
          agentType: 'general-purpose',
          teamName,
          status: 'completed',
          numTurns: 0,
          totalCostUsd: 0,
          durationMs: 0,
        },
      };
      nodes.push(memberNode);
      edges.push({ from: leadSessionId, to: memberId, type: 'team_lead' });
    }

    return { name: teamName, leadSessionId, memberCount: memberNames.size };
  }

  /**
   * Add fork relationship nodes to the session DAG.
   * Finds sessions forked from this session (children) and the parent session
   * this was forked from (if any).
   */
  private addForkNodes(
    sessionId: string,
    cacheData: SessionCacheData,
    nodes: DagNode[],
    edges: DagEdge[],
    constituentMtimes: Map<string, number>
  ): void {
    const sessionCache = getSessionCache();
    const existingIds = new Set(nodes.map(n => n.id));

    // 1. Find fork children: sessions in the same project where forkedFromSessionId === sessionId
    if (cacheData.cwd) {
      const projectSessions = sessionCache.getProjectSessionsFromCache(cacheData.cwd);
      for (const { sessionId: childSessionId, filePath: childFilePath, cacheData: childData } of projectSessions) {
        if (childData.forkedFromSessionId === sessionId && !existingIds.has(childSessionId)) {
          const forkNode = this.sessionCacheToNode(childData, childSessionId, 'fork');
          nodes.push(forkNode);
          edges.push({ from: sessionId, to: childSessionId, type: 'fork' });
          existingIds.add(childSessionId);

          // Track mtime for cache invalidation
          try {
            const stats = fs.statSync(childFilePath);
            constituentMtimes.set(childFilePath, stats.mtimeMs);
          } catch { /* ignore */ }
        }
      }
    }

    // 2. Add fork parent: if this session was forked from another session
    if (cacheData.forkedFromSessionId && !existingIds.has(cacheData.forkedFromSessionId)) {
      const parentPath = this.resolveSessionPath(cacheData.forkedFromSessionId);
      if (parentPath) {
        try {
          const parentData = sessionCache.getSessionDataSync(parentPath);
          if (parentData) {
            const parentNode = this.sessionCacheToNode(parentData, cacheData.forkedFromSessionId, 'fork');
            nodes.push(parentNode);
            edges.push({ from: cacheData.forkedFromSessionId, to: sessionId, type: 'fork' });
            existingIds.add(cacheData.forkedFromSessionId);

            // Track mtime for cache invalidation
            const stats = fs.statSync(parentPath);
            constituentMtimes.set(parentPath, stats.mtimeMs);
          }
        } catch { /* ignore */ }
      }
    }
  }

  /**
   * Check if a session DAG cache entry is still valid.
   */
  private getValidSessionDagCache(sessionId: string, sessionPath: string): SessionDagCacheEntry | null {
    const cached = this.sessionDagCache.get(sessionId);
    if (!cached) return null;

    // Check all constituent file mtimes
    for (const [filePath, expectedMtime] of cached.constituentMtimes) {
      try {
        const stats = fs.statSync(filePath);
        if (stats.mtimeMs !== expectedMtime) return null;
      } catch {
        return null;
      }
    }

    return cached;
  }

  /**
   * Execute a single batch query.
   */
  private async executeSingleQuery(query: BatchQuery): Promise<unknown> {
    switch (query.type) {
      case 'messageDag':
        return this.getMessageDag(query.sessionId, query.options as MessageDagOptions);
      case 'sessionDag':
        return this.getSessionDag(query.sessionId, query.options as SessionDagOptions);
      case 'unifiedDag':
        return this.getUnifiedDag(query.sessionId);
      case 'node':
        if (!query.uuid) throw new Error('uuid required for node query');
        return this.getNode(query.sessionId, query.uuid);
      case 'ancestors':
        if (!query.uuid) throw new Error('uuid required for ancestors query');
        return this.getAncestors(query.sessionId, query.uuid);
      case 'descendants':
        if (!query.uuid) throw new Error('uuid required for descendants query');
        return this.getDescendants(query.sessionId, query.uuid, (query.options as any)?.maxDepth, (query.options as any)?.types);
      case 'branches':
        return this.getBranches(query.sessionId);
      case 'related':
        return this.getRelatedSessions(query.sessionId);
      default:
        throw new Error(`Unknown query type: ${query.type}`);
    }
  }

  /**
   * LRU eviction for message DAG cache.
   */
  private evictMessageDagCache(): void {
    if (this.messageDagCache.size <= MAX_MESSAGE_DAG_CACHE) return;

    const entries = [...this.messageDagCache.entries()]
      .sort((a, b) => a[1].lastAccessTime - b[1].lastAccessTime);

    const toRemove = entries.slice(0, entries.length - MAX_MESSAGE_DAG_CACHE);
    for (const [key] of toRemove) {
      this.messageDagCache.delete(key);
    }
  }

  /**
   * LRU eviction for session DAG cache.
   */
  private evictSessionDagCache(): void {
    if (this.sessionDagCache.size <= MAX_SESSION_DAG_CACHE) return;

    const entries = [...this.sessionDagCache.entries()]
      .sort((a, b) => a[1].lastAccessTime - b[1].lastAccessTime);

    const toRemove = entries.slice(0, entries.length - MAX_SESSION_DAG_CACHE);
    for (const [key] of toRemove) {
      this.sessionDagCache.delete(key);
    }
  }
}

// ============================================================================
// Singleton
// ============================================================================

let _instance: SessionDagService | null = null;

export function getSessionDagService(): SessionDagService {
  if (!_instance) {
    _instance = new SessionDagService();
  }
  return _instance;
}
