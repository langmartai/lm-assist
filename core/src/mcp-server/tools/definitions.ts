/**
 * MCP Tool Definitions
 *
 * Two terminology groups — KEEP THEM DISJOINT in descriptions:
 *
 *   "code session" / "local session" / "Claude Code session"
 *      = a Claude Code terminal/CLI session on the user's machine.
 *        Identified by a UUID. Lives in the session cache (LMDB).
 *        Has cwd, model, turns, tasks.
 *
 *   "conversation" / "claude.ai conversation" / "web conversation"
 *      = a chat at claude.ai/chat/<uuid> (the web app).
 *        Identified by a UUID. Lives in the user's claude.ai account.
 *        Has chat_messages, project_uuid, model, name.
 *
 * Both use UUIDs but they index different stores. The trigger words in
 * the user's prompt are what disambiguates. Tool descriptions should
 * use the group's vocabulary heavily and explicitly say "not the
 * other one" so the model picks the right tool when a user says
 * "show me my X from yesterday".
 */

// ─── search ──────────────────────────────────────────────────

export const searchToolDef = {
  name: 'search',
  description:
    'Search the user\'s past CODE SESSIONS (Claude Code terminal sessions on their machine) ' +
    'and their personal knowledge entries (facts extracted from prior code sessions, IDs ' +
    'like K001 / K001.2). Trigger words: "session", "code session", "local session", ' +
    '"my past work on X", "did I work on Y", "find K001". For natural-language queries, ' +
    'this does vector + keyword search over knowledge + session transcripts. For literal ' +
    'IDs, jumps straight to the item. Returns ranked results with `→ detail(id)` hints.\n\n' +
    'Does NOT search claude.ai web conversations — for those, use ' +
    '`list_claudeai_conversations` then `read_conversation`.',
  annotations: { readOnlyHint: true },
  inputSchema: {
    type: 'object' as const,
    properties: {
      query: {
        type: 'string',
        description:
          'Natural language ("brent oil regime change"), keywords, a file path, or an ID ' +
          '(K001, K001.2, or a code session UUID).',
      },
      scope: {
        type: 'string',
        enum: ['24h', '3d', '7d', '30d', 'all'],
        description: 'How far back. Default 7d. Use "all" only for weeks/months-old work.',
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
        description: 'Restrict to knowledge entries vs all sources (default).',
      },
      limit: {
        type: 'number',
        description: 'Results per page (default 5, max 20).',
      },
      offset: { type: 'number', description: 'Pagination offset (default 0).' },
    },
    required: ['query'],
  },
};

// ─── detail ──────────────────────────────────────────────────

export const detailToolDef = {
  name: 'detail',
  description:
    'Read the full content of a CODE SESSION (Claude Code, local terminal session), a ' +
    'knowledge document, or a knowledge part — by the ID you got from `search`. Trigger ' +
    'words: "show me the code session", "open session X", "read knowledge K001", ' +
    '"details of that session". Default response is a summary (project, model, turn ' +
    'count, prompts, tasks for sessions; facts + files for knowledge). Pass `section` ' +
    'to drill into a part.\n\n' +
    'Does NOT read claude.ai web conversations — for those, use `read_conversation` ' +
    '(which expects a claude.ai conversation UUID, not a code session UUID).',
  annotations: { readOnlyHint: true },
  inputSchema: {
    type: 'object' as const,
    properties: {
      id: {
        type: 'string',
        description:
          'A knowledge ID (K001), knowledge part ID (K001.2), code session UUID, or ' +
          'sessionId:index reference (e.g. "abc123:5" for turn 5 of code session abc123).',
      },
      section: {
        type: 'string',
        enum: ['facts', 'files', 'content', 'conversation'],
        description:
          'Which part to expand. Omit for summary. NOTE: section="conversation" returns ' +
          'the turns of a CODE SESSION (Claude Code turns) — NOT a claude.ai conversation. ' +
          'For a claude.ai conversation, use `read_conversation` instead.',
      },
      offset: {
        type: 'number',
        description: 'Pagination offset within a section (e.g. session turns).',
      },
      limit: { type: 'number', description: 'Items per page (default 10).' },
    },
    required: ['id'],
  },
};

// ─── feedback ──────────────────────────────────────────────────

export const feedbackToolDef = {
  name: 'feedback',
  description:
    'Record the user\'s feedback on a knowledge entry or code-session result you ' +
    'previously surfaced to them. Trigger words: "K001 is wrong", "that was outdated", ' +
    '"useful, save it", "irrelevant". The feedback flows into the knowledge store and ' +
    'influences future ranking.\n\n' +
    'Does NOT apply to claude.ai conversations.',
  annotations: { readOnlyHint: false },
  inputSchema: {
    type: 'object' as const,
    properties: {
      id: {
        type: 'string',
        description:
          'The ID of the item the user is reacting to (K001.2, K001, code session UUID, ' +
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
          'What specifically about it — quote the user when possible. Vague feedback like ' +
          '"good" is unhelpful.',
      },
    },
    required: ['id', 'type', 'content'],
  },
};

// ─── list_recent_sessions ──────────────────────────────────────────

export const listRecentSessionsToolDef = {
  name: 'list_recent_sessions',
  description:
    'List the user\'s recent CODE SESSIONS (Claude Code terminal sessions on their ' +
    'machine), most-recent first. For each session returns the UUID + last-activity ' +
    'time + the LAST ~20 real user prompts so you have enough context to know what ' +
    'each session is about. Trigger words: "recent sessions", "recent code sessions", ' +
    '"what code sessions did I have", "what local sessions", "what was I working on ' +
    'in Claude Code", "yesterday\'s sessions". Follow up with `detail(<uuid>)` for the ' +
    'full transcript.\n\n' +
    'For claude.ai web conversations (chats at claude.ai/chat/*), use ' +
    '`list_claudeai_conversations` instead.',
  annotations: { readOnlyHint: true },
  inputSchema: {
    type: 'object' as const,
    properties: {
      scope: {
        type: 'string',
        enum: ['24h', '3d', '7d', '30d', 'all'],
        description: 'How far back (default 7d).',
      },
      project: {
        type: 'string',
        description:
          'Filter to code sessions in a specific project directory. Omit to see all projects.',
      },
      limit: {
        type: 'number',
        description: 'Max sessions to return (default 5, max 20). Each session can be sizeable.',
      },
      prompts_per_session: {
        type: 'number',
        description:
          'How many of the most-recent user prompts to include per session ' +
          '(default 20, max 50). Lower if you want a tighter overview.',
      },
      prompt_char_limit: {
        type: 'number',
        description: 'Truncate each prompt at this many characters (default 120, max 500).',
      },
    },
  },
};

// ─── list_projects ──────────────────────────────────────────

export const listProjectsToolDef = {
  name: 'list_projects',
  description:
    'List the projects (codebases / repos / directories) the user has CODE SESSIONS in. ' +
    'Sorted by most-recent activity. Trigger words: "what projects", "what repos am I ' +
    'working on", "list my projects", "last project I touched". Each entry shows the ' +
    'project path, total code-session count, last-activity time. Follow up with ' +
    '`list_recent_sessions(project="...")` or `search(..., project="...")`.\n\n' +
    'Aggregates only LOCAL code sessions. claude.ai web conversations have their own ' +
    'project concept; use `list_claudeai_conversations` for those.',
  annotations: { readOnlyHint: true },
  inputSchema: {
    type: 'object' as const,
    properties: {
      scope: {
        type: 'string',
        enum: ['24h', '3d', '7d', '30d', 'all'],
        description: 'Only count projects with activity within this window (default 30d).',
      },
      limit: { type: 'number', description: 'Max projects to return (default 20, max 100).' },
    },
  },
};

// ─── search_memory ──────────────────────────────────────────

export const searchMemoryToolDef = {
  name: 'search_memory',
  description:
    'Search the user\'s curated Claude memory files for a project — the markdown files ' +
    'at `~/.claude/projects/<slug>/memory/` plus any host mirrors. Trigger words: ' +
    '"my memory", "do I have notes on X", "memory says", "what did I save about Y", ' +
    '"check memory". These are the operator\'s OWN captured facts, feedback, references, ' +
    'and project notes — distinct from the knowledge store (which `search` covers, ' +
    'auto-extracted from code sessions) and distinct from claude.ai conversations.\n\n' +
    'Returns matching files with title, description, and a snippet around the match.',
  annotations: { readOnlyHint: true },
  inputSchema: {
    type: 'object' as const,
    properties: {
      query: {
        type: 'string',
        description: 'Keywords to grep for in memory file bodies + filenames + frontmatter.',
      },
      project: {
        type: 'string',
        description:
          'Project directory to scope the memory search to. If omitted, defaults to the ' +
          'lm-assist server\'s current working directory.',
      },
      include_repo_mirror: {
        type: 'boolean',
        description:
          'Also search repo-mirrored memory files from other hosts (default false — only ' +
          'the live local dir). Set true for cross-host queries.',
      },
      limit: { type: 'number', description: 'Max files to return (default 10, max 30).' },
    },
    required: ['query'],
  },
};

// ─── list_claudeai_conversations ──────────────────────────────────────

export const listClaudeaiConversationsToolDef = {
  name: 'list_claudeai_conversations',
  description:
    'List the user\'s claude.ai web CONVERSATIONS (chats at claude.ai/chat/*), ' +
    'most-recent first. For each conversation returns the UUID + name + summary + ' +
    'the LAST ~20 user/assistant messages so you have context to know what each chat ' +
    'is about. Trigger words: "my conversations", "claude.ai conversations", "my web ' +
    'chats", "recent conversations", "find that chat about X", "what conversations ' +
    'did I have". Follow up with `read_conversation(conversation_uuid=...)` for full ' +
    'message history.\n\n' +
    'Does NOT list Claude Code terminal sessions — use `list_recent_sessions` for those. ' +
    'Different store, different UUID space, different verb.\n\n' +
    'Default limit is 5 (low because each conversation costs a per-item read against ' +
    'claude.ai). Set `include_messages: false` for a fast metadata-only list.\n\n' +
    'Requires a configured claude.ai session — returns a clear error otherwise. Read-only.',
  annotations: { readOnlyHint: true },
  inputSchema: {
    type: 'object' as const,
    properties: {
      limit: {
        type: 'number',
        description:
          'Max conversations (default 5, max 20). Keep low when including messages — each ' +
          'item requires a separate API call to fetch its message tail.',
      },
      starred: { type: 'boolean', description: 'If true, only starred conversations.' },
      project_uuid: { type: 'string', description: 'Filter to a specific claude.ai project UUID.' },
      include_messages: {
        type: 'boolean',
        description:
          'Include the last few messages of each conversation (default true). Set false ' +
          'for a fast metadata-only listing.',
      },
      messages_per_conv: {
        type: 'number',
        description:
          'How many of the most-recent messages to include per conversation (default 20, ' +
          'max 50). Ignored when include_messages is false.',
      },
      message_char_limit: {
        type: 'number',
        description: 'Truncate each message body at this many characters (default 120, max 500).',
      },
    },
  },
};

// ─── read_conversation ──────────────────────────────────────

export const readConversationToolDef = {
  name: 'read_conversation',
  description:
    'Read a single claude.ai web CONVERSATION in full — the message tree of a chat at ' +
    'claude.ai/chat/<uuid>. Trigger words: "show me conversation X", "open chat", ' +
    '"read that conversation", "details of conversation Y", "what did I say in that ' +
    'chat". Pass the conversation_uuid you got from `list_claudeai_conversations`. ' +
    'Returns the conversation header (name, model, timestamps) plus paginated messages, ' +
    'each with sender + content blocks (text, tool_use, tool_result).\n\n' +
    'Does NOT read Claude Code sessions — `detail(<code-session-uuid>)` is for those. ' +
    'Even though both use UUIDs, they index different stores; passing a code session UUID ' +
    'here will fail at claude.ai\'s API.\n\n' +
    'Read-only. Does NOT cost tokens (it just fetches stored message history).',
  annotations: { readOnlyHint: true },
  inputSchema: {
    type: 'object' as const,
    properties: {
      conversation_uuid: {
        type: 'string',
        description:
          'The UUID of the claude.ai conversation (from `list_claudeai_conversations`). ' +
          'Standard v4 UUID format.',
      },
      limit: {
        type: 'number',
        description:
          'Max messages to include in this response (default 20, max 200). Long ' +
          'conversations should be paginated via offset.',
      },
      offset: {
        type: 'number',
        description:
          'Start at the Nth message (default 0). For pagination through a long thread.',
      },
      max_chars_per_message: {
        type: 'number',
        description:
          'Truncate each message body at this many characters (default 600, max 4000). ' +
          'Increase for messages where the user wants the full text.',
      },
    },
    required: ['conversation_uuid'],
  },
};
