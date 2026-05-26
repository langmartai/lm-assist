/**
 * MCP Tool Definitions
 *
 * Static tool definition objects for the MCP tools exposed by lm-assist.
 * This file has ZERO data-store imports — safe to import from the MCP
 * server process without pulling in LMDB, LanceDB, embedder, etc.
 *
 * Description style: each tool answers "when should the model reach for
 * this?" not "what does it do mechanically". Param descriptions answer
 * "when do I set this?". The model picks tools by reading these.
 */

// ─── Search Tool ──────────────────────────────────────────────────

export const searchToolDef = {
  name: 'search',
  description:
    'Search the user\'s past Claude Code activity: their personal knowledge base ' +
    '(facts extracted from prior sessions, IDs like K001), their session transcripts ' +
    '(UUIDs), and the files they\'ve touched. Use when the user asks "did I work on X?", ' +
    '"what\'s my prior work on Y?", "where did I see Z before?". For natural-language ' +
    'queries this does vector + keyword search. For literal IDs (K001 or a session UUID), ' +
    'jumps straight to that item. Returns a ranked list — each result includes a hint ' +
    'like `→ detail("K001.2")` you can follow up with.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      query: {
        type: 'string',
        description:
          'Natural language ("brent oil regime change"), keywords ("backtest grid"), ' +
          'a file path ("scripts/oanda-api.js"), or an ID (K001, K001.2, a session UUID).',
      },
      scope: {
        type: 'string',
        enum: ['24h', '3d', '7d', '30d', 'all'],
        description:
          'How far back to look. Default 7d. Use "all" only when the user mentions ' +
          'something weeks or months old.',
      },
      project: {
        type: 'string',
        description:
          'Filter to a single project directory (e.g. "/home/ubuntu/lm-unified-trade"). ' +
          'Omit unless the user is clearly scoped to one repo.',
      },
      type: {
        type: 'string',
        enum: ['knowledge', 'all'],
        description:
          'Restrict to the knowledge base (extracted facts) vs all sources (default).',
      },
      limit: {
        type: 'number',
        description: 'Results per page (default 5, max 20). Lower for narrow questions.',
      },
      offset: {
        type: 'number',
        description: 'Pagination offset for follow-up calls (default 0).',
      },
    },
    required: ['query'],
  },
};

// ─── Detail Tool ──────────────────────────────────────────────────

export const detailToolDef = {
  name: 'detail',
  description:
    'Read the full content of a Claude Code session, a knowledge document, or a ' +
    'knowledge part — by the ID you got from `search`. Default response is a summary ' +
    '(project, model, turns, prompts, tasks for sessions; facts + files for knowledge). ' +
    'Pass `section` to drill into a specific part: "conversation" for full session turns, ' +
    '"facts" for extracted facts only, "files" for file history, "content" for raw text. ' +
    'Use this whenever `search` returned a hit you want to read in full.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      id: {
        type: 'string',
        description:
          'A knowledge ID (K001), knowledge part ID (K001.2), session UUID, or ' +
          'session:index reference (e.g. "abc123:5" for turn 5 of session abc123).',
      },
      section: {
        type: 'string',
        enum: ['facts', 'files', 'content', 'conversation'],
        description:
          'Which part to expand. Omit for summary. "conversation" returns full ' +
          'session turns (paginated). "facts" returns the extracted facts. "files" ' +
          'returns the file history. "content" returns raw stored content.',
      },
      offset: {
        type: 'number',
        description:
          'Pagination offset within a section (conversation turns, file lists).',
      },
      limit: {
        type: 'number',
        description: 'Items per page when paginating (default 10).',
      },
    },
    required: ['id'],
  },
};

// ─── Feedback Tool ──────────────────────────────────────────────────

export const feedbackToolDef = {
  name: 'feedback',
  description:
    'Record the user\'s feedback on a knowledge entry or session result you previously ' +
    'showed them. Use when the user says something like "that K001 fact is wrong", ' +
    '"that\'s outdated", "this is useful, save it", or "this was irrelevant". The ' +
    'feedback flows into the knowledge store and influences future search ranking. ' +
    'Pick `type` honestly — the model should not just say "useful" to seem helpful.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      id: {
        type: 'string',
        description:
          'The ID of the item the user is reacting to (K001.2, K001, session UUID, ' +
          'sessionId:index). Should come from a recent `search` or `detail` response.',
      },
      type: {
        type: 'string',
        enum: ['outdated', 'wrong', 'irrelevant', 'needs_update', 'useful'],
        description:
          'outdated = was correct, now stale | wrong = factually incorrect | ' +
          'irrelevant = not helpful in this context | needs_update = partially correct, ' +
          'edit needed | useful = surfaced the right thing.',
      },
      content: {
        type: 'string',
        description:
          'What specifically about it — quote the user when possible. "Says X but ' +
          'should be Y." Vague feedback like "good" is unhelpful.',
      },
    },
    required: ['id', 'type', 'content'],
  },
};

// ─── List Recent Sessions ──────────────────────────────────────────────

export const listRecentSessionsToolDef = {
  name: 'list_recent_sessions',
  description:
    'List the user\'s recent Claude Code sessions, most-recent first. Use when the ' +
    'user asks "what have I been working on?", "show my recent sessions", "what did ' +
    'I do yesterday?". Each entry includes session UUID, project path, last-activity ' +
    'time, turn count, and (if extracted) a one-line summary. Follow up with ' +
    '`detail(<session-uuid>)` to read any of them in full.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      scope: {
        type: 'string',
        enum: ['24h', '3d', '7d', '30d', 'all'],
        description: 'How far back to include sessions (default 7d).',
      },
      project: {
        type: 'string',
        description:
          'Filter to sessions in a specific project directory. Omit to see all projects.',
      },
      limit: {
        type: 'number',
        description: 'Max sessions to return (default 10, max 50).',
      },
    },
  },
};

// ─── List Projects ──────────────────────────────────────────────

export const listProjectsToolDef = {
  name: 'list_projects',
  description:
    'List the projects (codebases / directories) the user has Claude Code sessions ' +
    'in. Sorted by most-recent activity. Each entry shows the project path, total ' +
    'session count, last-activity time. Use when the user asks "what projects am I ' +
    'working on?", "what was the last thing I touched?", "list my repos". Follow up ' +
    'with `list_recent_sessions(project=…)` or `search(..., project=…)` to drill in.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      scope: {
        type: 'string',
        enum: ['24h', '3d', '7d', '30d', 'all'],
        description:
          'Only count projects with activity within this window (default 30d).',
      },
      limit: {
        type: 'number',
        description: 'Max projects to return (default 20, max 100).',
      },
    },
  },
};

// ─── Search Memory ──────────────────────────────────────────────

export const searchMemoryToolDef = {
  name: 'search_memory',
  description:
    'Search the user\'s curated Claude memory files for a project — the markdown ' +
    'files at `~/.claude/projects/<slug>/memory/` plus any host mirrors. These are ' +
    'the operator\'s own captured facts, feedback, references, and project notes ' +
    '(distinct from the knowledge store which is auto-extracted). Use when the user ' +
    'asks "what does my memory say about X?", "do I have notes on Y?". Returns ' +
    'matching files with short snippets; follow up with `read_memory_file(filename, project)`.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      query: {
        type: 'string',
        description: 'Keywords to grep for in memory file bodies + filenames.',
      },
      project: {
        type: 'string',
        description:
          'Project directory to scope the memory search to. If omitted, defaults to ' +
          'the user\'s current working project (~ on the server).',
      },
      include_repo_mirror: {
        type: 'boolean',
        description:
          'Also search repo-mirrored memory files from other hosts (default false ' +
          '— only the live local dir). Set true for cross-host queries.',
      },
      limit: {
        type: 'number',
        description: 'Max files to return (default 10, max 30).',
      },
    },
    required: ['query'],
  },
};

// ─── List claude.ai Conversations ──────────────────────────────────────

export const listClaudeaiConversationsToolDef = {
  name: 'list_claudeai_conversations',
  description:
    'List the user\'s claude.ai web-app conversations (the chats they have at ' +
    'claude.ai/chat/*), most-recent first. Use when the user asks "what claude.ai ' +
    'chats do I have?", "show my recent conversations", "find that chat about X". ' +
    'Each entry shows the conversation UUID, name, timestamps, and project (if any). ' +
    'Requires a configured claude.ai session — returns a clear error otherwise. ' +
    'NOTE: This is read-only against the user\'s own account; does not cost tokens.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      limit: {
        type: 'number',
        description: 'Max conversations to return (default 20, max 100).',
      },
      starred: {
        type: 'boolean',
        description: 'If true, only starred conversations.',
      },
      project_uuid: {
        type: 'string',
        description: 'Filter to a specific claude.ai project UUID.',
      },
    },
  },
};
