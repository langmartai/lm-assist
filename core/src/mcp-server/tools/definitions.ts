/**
 * MCP Tool Definitions
 *
 * Static tool definition objects for the 3 MCP tools.
 * This file has ZERO data-store imports — safe to import from the MCP
 * server process without pulling in LMDB, LanceDB, embedder, etc.
 *
 * This is the canonical source for tool definitions. The handler files
 * (search.ts, detail.ts, feedback.ts) re-export from here for
 * backward compatibility.
 */

// ─── Search Tool ──────────────────────────────────────────────────

export const searchToolDef = {
  name: 'search',
  description: `Unified search across knowledge and file history. Auto-detects query type: file paths, IDs (K001, sessionId, sessionId:index), or natural language. Params: query, scope (24h|3d|7d|30d|all), project, type (knowledge|all), limit, offset`,
  inputSchema: {
    type: 'object' as const,
    properties: {
      query: {
        type: 'string',
        description: 'Natural language, keywords, file paths, or IDs (K001, K001.2, sessionId, sessionId:index)',
      },
      scope: {
        type: 'string',
        enum: ['24h', '3d', '7d', '30d', 'all'],
        description: 'Time scope for search (default: 7d)',
      },
      project: {
        type: 'string',
        description: 'Filter to a specific project path',
      },
      type: {
        type: 'string',
        enum: ['knowledge', 'all'],
        description: 'Result type filter (default: all)',
      },
      limit: {
        type: 'number',
        description: 'Results per page (default: 5, max: 20)',
      },
      offset: {
        type: 'number',
        description: 'Pagination offset (default: 0)',
      },
    },
    required: ['query'],
  },
};

/** Full description used when experiment features (milestones/architecture) are enabled */
export const searchToolDefExperiment = {
  ...searchToolDef,
  description: `Unified search across knowledge, milestones, architecture, and file history. Auto-detects query type: file paths, IDs (K001, sessionId, sessionId:index), or natural language. Params: query, scope (24h|3d|7d|30d|all), project, type (knowledge|milestone|architecture|all), limit, offset`,
  inputSchema: {
    ...searchToolDef.inputSchema,
    properties: {
      ...searchToolDef.inputSchema.properties,
      type: {
        type: 'string',
        enum: ['knowledge', 'milestone', 'architecture', 'all'],
        description: 'Result type filter (default: all)',
      },
    },
  },
};

// ─── Detail Tool ──────────────────────────────────────────────────

export const detailToolDef = {
  name: 'detail',
  description: 'Get details for any item by ID — knowledge, session. Progressive disclosure: summary first, section parameter for specific parts.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      id: { type: 'string', description: 'K001, K001.2, sessionId:index, or sessionId' },
      section: { type: 'string', description: 'Expand specific section: facts, files, content, conversation' },
      offset: { type: 'number', description: 'For paginated content (conversation turns, file lists)' },
      limit: { type: 'number', description: 'Items per page (default: 10)' },
    },
    required: ['id'],
  },
};

/** Full description used when experiment features (milestones/architecture) are enabled */
export const detailToolDefExperiment = {
  ...detailToolDef,
  description: 'Get details for any item by ID — knowledge, milestone, session, or architecture component. Progressive disclosure: summary first, section parameter for specific parts.',
  inputSchema: {
    ...detailToolDef.inputSchema,
    properties: {
      id: { type: 'string', description: 'K001, K001.2, sessionId:index, sessionId, or arch:component-name' },
      section: { type: 'string', description: 'Expand specific section: facts, files, content, conversation, milestones, connections, diagram' },
      offset: { type: 'number', description: 'For paginated content (conversation turns, file lists)' },
      limit: { type: 'number', description: 'Items per page (default: 10)' },
    },
  },
};

// ─── Feedback Tool ──────────────────────────────────────────────────

export const feedbackToolDef = {
  name: 'feedback',
  description: `Provide quality feedback on any context you received — from search results, detail content, or hook-injected suggestions. Feedback improves future results. Params: id (source ID like K001.2, sessionId:index), type (outdated|wrong|irrelevant|needs_update|useful), content (specific feedback text)`,
  inputSchema: {
    type: 'object' as const,
    properties: {
      id: {
        type: 'string',
        description: 'Source ID from context (K001.2, K001, sessionId:index, etc.)',
      },
      type: {
        type: 'string',
        enum: ['outdated', 'wrong', 'irrelevant', 'needs_update', 'useful'],
        description: 'Feedback type: outdated (no longer accurate), wrong (factually incorrect), irrelevant (not helpful), needs_update (partially correct), useful (helpful context)',
      },
      content: {
        type: 'string',
        description: 'Specific feedback text. Be specific about what needs to change and why.',
      },
    },
    required: ['id', 'type', 'content'],
  },
};
