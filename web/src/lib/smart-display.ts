// ============================================
// Smart Display Utilities
// Ported from admin-web SessionDetailView.tsx
// ============================================

/**
 * Parse task notification XML from message content.
 */
export function parseTaskNotification(content: string): {
  taskId: string;
  outputFile: string;
  status: 'completed' | 'failed';
  summary: string;
} | null {
  if (!content || !content.includes('<task-notification>')) return null;

  const taskIdMatch = content.match(/<task-id>(.*?)<\/task-id>/s);
  const outputFileMatch = content.match(/<output-file>(.*?)<\/output-file>/s);
  const statusMatch = content.match(/<status>(.*?)<\/status>/s);
  const summaryMatch = content.match(/<summary>(.*?)<\/summary>/s);

  if (!taskIdMatch || !statusMatch) return null;

  return {
    taskId: taskIdMatch[1].trim(),
    outputFile: outputFileMatch ? outputFileMatch[1].trim() : '',
    status: statusMatch[1].trim() as 'completed' | 'failed',
    summary: summaryMatch ? summaryMatch[1].trim() : '',
  };
}

/**
 * Check if message ONLY contains task notification XML
 * (allows trailing "Read the output file..." text).
 */
export function isPureTaskNotification(content: string): boolean {
  if (!content) return false;
  const stripped = content
    .replace(/<task-notification>[\s\S]*?<\/task-notification>/g, '')
    .replace(/Read the output file[\s\S]*/i, '')
    .trim();
  return stripped.length === 0 && content.includes('<task-notification>');
}

/**
 * Check if message should be hidden in Smart Display mode.
 */
export function shouldHideInSmartDisplay(
  content: string,
  type?: string,
  subtype?: string,
): boolean {
  if (!content) return false;
  // Hide verbose suggestion/permission prompts
  if (content.includes('[SUGGESTION MODE:') || content.includes('SUGGESTION MODE:')) {
    return true;
  }
  // Hide system metadata noise (turn_duration, stop_hook_summary, init)
  // Keep: local_command, api_error, compact_boundary, microcompact_boundary
  if (type === 'system' && (subtype === 'turn_duration' || subtype === 'stop_hook_summary' || subtype === 'init')) {
    return true;
  }
  // Hide empty "(no content)" assistant messages (streaming preamble before tool calls)
  if (type === 'assistant' && content.trim() === '(no content)') {
    return true;
  }
  // Hide progress events (bash_progress, hook_progress, mcp_progress, agent_progress, etc.)
  if (type === 'progress') {
    return true;
  }
  // Hide queue-operation messages (internal enqueue/dequeue, content duplicated by actual messages)
  if (type === 'queue-operation') {
    return true;
  }
  return false;
}

/**
 * Transform content for Smart Display mode.
 * Returns transformed string or null if no transformation needed.
 */
export function smartTransformContent(
  content: string,
  type?: string,
  subtype?: string,
  agentId?: string,
): string | null {
  if (!content) return null;

  // Prompt suggestion agent responses → friendly suggestion display
  if (agentId?.includes('prompt_suggestion') && type === 'agent_assistant') {
    return `💡 Suggestion: ${content.trim()}`;
  }

  // Compact agent responses → friendly compact display
  if (agentId?.includes('compact') && type === 'agent_assistant') {
    return `📦 Compact summary`;
  }

  // Task notifications
  const notification = parseTaskNotification(content);
  if (notification) {
    const icon = notification.status === 'completed' ? '✅' : '❌';
    let shortSummary = notification.summary;
    // Extract description from "Background command ..." prefix
    shortSummary = shortSummary.replace(/^Background command\s*.*?:\s*/i, '');
    if (shortSummary.length > 60) {
      shortSummary = shortSummary.slice(0, 60) + '...';
    }
    return `${icon} Background task ${notification.status}: ${shortSummary}`;
  }

  // Session compaction
  if (content.includes('Your task is to create a detailed summary')) {
    return '📦 Session compacted (context summarized)';
  }

  // File history snapshots
  if (type === 'file-history-snapshot' || subtype === 'file-history-snapshot') {
    return '📁 File history snapshot';
  }

  return null;
}

/**
 * Format a tool call into a friendly { name, args } pair.
 * Complete switch statement covering all tool types.
 */
export function formatToolCall(
  toolName: string,
  input?: Record<string, unknown>,
): { name: string; args: string } {
  if (!toolName) return { name: 'Unknown', args: '' };

  const inp = input || {};

  switch (toolName) {
    // File operations
    case 'Read':
      return { name: 'Read', args: String(inp.file_path || inp.path || '') };
    case 'Edit':
      return { name: 'Update', args: String(inp.file_path || inp.path || '') };
    case 'Write':
      return { name: 'Write', args: String(inp.file_path || inp.path || '') };

    // Code search
    case 'Bash':
      return { name: 'Bash', args: truncateStr(String(inp.command || inp.cmd || ''), 100) };
    case 'Grep':
      return {
        name: 'Grep',
        args: `pattern="${inp.pattern || ''}"${inp.path ? `, path=${inp.path}` : ''}`,
      };
    case 'Glob':
      return {
        name: 'Glob',
        args: `${inp.pattern || ''}${inp.path ? `, path=${inp.path}` : ''}`,
      };

    // Task management
    case 'Task':
      return {
        name: `Task[${inp.subagent_type || 'agent'}]`,
        args: String(inp.description || ''),
      };
    case 'TaskCreate':
      return { name: 'TaskCreate', args: String(inp.subject || '') };
    case 'TaskUpdate':
      return {
        name: 'TaskUpdate',
        args: `#${inp.taskId || ''}${inp.status ? `, status=${inp.status}` : ''}`,
      };
    case 'TaskList':
      return { name: 'TaskList', args: '' };
    case 'TaskGet':
      return { name: 'TaskGet', args: `#${inp.taskId || ''}` };

    // Browser / MCP Chrome tools
    case 'computer':
    case 'mcp__claude-in-chrome__computer':
      return {
        name: `Browser.${inp.action || 'action'}`,
        args: inp.coordinate ? `at (${(inp.coordinate as number[]).join(',')})` : '',
      };
    case 'navigate':
    case 'mcp__claude-in-chrome__navigate':
      return {
        name: 'Browser.Navigate',
        args: truncateStr(String(inp.url || ''), 60),
      };
    case 'read_page':
    case 'mcp__claude-in-chrome__read_page':
      return { name: 'Browser.ReadPage', args: '' };
    case 'find':
    case 'mcp__claude-in-chrome__find':
      return { name: 'Browser.Find', args: `"${inp.query || ''}"` };
    case 'javascript_tool':
    case 'mcp__claude-in-chrome__javascript_tool':
      return {
        name: 'Browser.JavaScript',
        args: truncateStr(String(inp.text || inp.code || ''), 50),
      };
    case 'read_console_messages':
    case 'mcp__claude-in-chrome__read_console_messages':
      return {
        name: 'Browser.ReadConsole',
        args: inp.pattern ? `pattern=${inp.pattern}` : '',
      };
    case 'read_network_requests':
    case 'mcp__claude-in-chrome__read_network_requests':
      return {
        name: 'Browser.ReadNetwork',
        args: inp.urlPattern ? `url=${inp.urlPattern}` : '',
      };
    case 'tabs_context_mcp':
    case 'mcp__claude-in-chrome__tabs_context_mcp':
      return { name: 'Browser.GetTabs', args: '' };
    case 'tabs_create_mcp':
    case 'mcp__claude-in-chrome__tabs_create_mcp':
      return { name: 'Browser.CreateTab', args: '' };
    case 'form_input':
    case 'mcp__claude-in-chrome__form_input':
      return {
        name: 'Browser.FormInput',
        args: truncateStr(String(inp.value || ''), 30),
      };
    case 'gif_creator':
    case 'mcp__claude-in-chrome__gif_creator':
      return { name: 'Browser.GIF', args: String(inp.action || '') };
    case 'upload_image':
    case 'mcp__claude-in-chrome__upload_image':
      return { name: 'Browser.UploadImage', args: String(inp.filename || '') };
    case 'get_page_text':
    case 'mcp__claude-in-chrome__get_page_text':
      return { name: 'Browser.GetPageText', args: '' };

    // Web tools
    case 'WebFetch':
      return { name: 'WebFetch', args: truncateStr(String(inp.url || ''), 60) };
    case 'WebSearch':
      return { name: 'WebSearch', args: `"${inp.query || ''}"` };

    // Skill
    case 'Skill':
      return { name: 'Skill', args: String(inp.skill || '') };

    // AskUserQuestion
    case 'AskUserQuestion':
      return { name: 'AskUser', args: '' };

    // Team tools
    case 'Teammate': {
      const op = String(inp.operation || 'spawnTeam');
      const teamArgs = op === 'spawnTeam' ? `${inp.team_name || ''}${inp.description ? ` "${inp.description}"` : ''}` : '';
      return { name: `Team.${op}`, args: teamArgs };
    }
    case 'SendMessage': {
      const msgType = String(inp.type || 'message');
      const recipient = inp.recipient ? `→${inp.recipient}` : '';
      const summary = String(inp.summary || (typeof inp.content === 'string' ? (inp.content as string).slice(0, 60) : '') || '');
      return { name: `Team.${msgType}`, args: `${recipient} ${summary}`.trim() };
    }

    // EnterPlanMode / ExitPlanMode
    case 'EnterPlanMode':
      return { name: 'EnterPlan', args: '' };
    case 'ExitPlanMode':
      return { name: 'ExitPlan', args: '' };

    // NotebookEdit
    case 'NotebookEdit':
      return { name: 'NotebookEdit', args: String(inp.notebook_path || '') };

    // TodoWrite (legacy)
    case 'TodoWrite':
      return { name: 'TodoWrite', args: '' };

    default:
      break;
  }

  // Generic MCP fallback
  if (toolName.startsWith('mcp__')) {
    const parts = toolName.replace('mcp__', '').split('__');
    if (parts[0] === 'claude-in-chrome') {
      return { name: `Browser.${parts.slice(1).join('.')}`, args: '' };
    }
    return { name: parts.join('.'), args: '' };
  }

  return { name: toolName, args: '' };
}

/**
 * Format a tool call as a single string: "name(args)" or "name()"
 */
export function formatToolCallString(toolName: string, input?: Record<string, unknown>): string {
  const { name, args } = formatToolCall(toolName, input);
  return args ? `${name}(${args})` : `${name}()`;
}

/**
 * Parse an Anthropic API error message into structured fields.
 * Input: "API Error: 500 {"type":"error","error":{"type":"api_error","message":"Internal server error"},"request_id":"req_..."}"
 */
export function parseApiError(content: string): {
  statusCode: number;
  errorType: string;
  errorMessage: string;
  requestId: string;
} | null {
  if (!content) return null;
  const match = content.match(/^API Error:\s*(\d+)\s*(\{.+\})$/s);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[2]);
    return {
      statusCode: parseInt(match[1], 10),
      errorType: parsed?.error?.type || 'unknown',
      errorMessage: parsed?.error?.message || 'Unknown error',
      requestId: parsed?.request_id || '',
    };
  } catch {
    return {
      statusCode: parseInt(match[1], 10),
      errorType: 'unknown',
      errorMessage: match[2],
      requestId: '',
    };
  }
}

// ============================================
// Helper
// ============================================

function truncateStr(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + '...';
}
