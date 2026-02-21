/**
 * Message Formatter
 *
 * Formats lm-assist events and API responses into chat-friendly messages.
 * Handles truncation, chunking, and platform-agnostic formatting.
 */

import type {
  SseExecutionStart,
  SseExecutionProgress,
  SseExecutionComplete,
  SseExecutionError,
  SseUserQuestion,
  SsePermissionRequest,
  SseToolUse,
  AgentSessionInfo,
  ConversationMessage,
  NotificationLevel,
} from './types';

/** Default max message length (safe for most platforms) */
const DEFAULT_MAX_LENGTH = 4000;

/**
 * Truncate text to max length with ellipsis
 */
function truncate(text: string, maxLength: number = DEFAULT_MAX_LENGTH): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 3) + '...';
}

/**
 * Simple text progress bar
 */
function progressBar(percent: number, width: number = 20): string {
  const filled = Math.round((percent / 100) * width);
  const empty = width - filled;
  return '[' + '\u2588'.repeat(filled) + '\u2591'.repeat(empty) + '] ' + percent + '%';
}

/**
 * Format duration in human-readable form
 */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainSeconds = seconds % 60;
  return `${minutes}m ${remainSeconds}s`;
}

/**
 * Format cost in USD
 */
function formatCost(usd: number): string {
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

// ============================================================================
// Event Formatters
// ============================================================================

export function formatExecutionStart(
  event: SseExecutionStart,
  _level: NotificationLevel = 'normal'
): string {
  const prompt = truncate(event.prompt, 200);
  return `*Starting task...*\n> ${prompt}`;
}

export function formatExecutionProgress(
  event: SseExecutionProgress,
  level: NotificationLevel = 'normal'
): string {
  if (level === 'minimal') {
    return `${progressBar(event.progressPercent)}`;
  }

  const lines: string[] = [];
  lines.push(progressBar(event.progressPercent));

  if (event.vibeMessage) {
    lines.push(event.vibeMessage);
  } else if (event.stepDescription) {
    lines.push(event.stepDescription);
  }

  if (level === 'verbose' && event.estimatedRemainingSeconds > 0) {
    lines.push(`ETA: ~${Math.ceil(event.estimatedRemainingSeconds)}s remaining`);
  }

  return lines.join('\n');
}

export function formatExecutionComplete(
  event: SseExecutionComplete,
  level: NotificationLevel = 'normal'
): string {
  const lines: string[] = [];

  if (event.success) {
    lines.push('*Task completed*');
  } else {
    lines.push('*Task failed*');
  }

  if (event.result) {
    const maxResultLen = level === 'verbose' ? 3000 : 1500;
    lines.push('');
    lines.push(truncate(event.result, maxResultLen));
  }

  // Stats line
  const stats: string[] = [];
  if (event.durationMs) stats.push(formatDuration(event.durationMs));
  if (event.numTurns) stats.push(`${event.numTurns} turns`);
  if (event.costUsd) stats.push(formatCost(event.costUsd));
  if (stats.length > 0) {
    lines.push('');
    lines.push(`_${stats.join(' | ')}_`);
  }

  return lines.join('\n');
}

export function formatExecutionError(event: SseExecutionError): string {
  return `*Error:* ${truncate(event.error, 500)}`;
}

export function formatUserQuestion(event: SseUserQuestion): string {
  const lines: string[] = [];
  lines.push('*Claude is asking:*');

  for (const q of event.questions) {
    lines.push('');
    lines.push(q.question);

    if (q.options.length > 0) {
      lines.push('');
      for (let i = 0; i < q.options.length; i++) {
        const opt = q.options[i];
        lines.push(`  ${i + 1}) *${opt.label}*`);
        if (opt.description) {
          lines.push(`     ${truncate(opt.description, 200)}`);
        }
      }
    }

    if (q.multiSelect) {
      lines.push('');
      lines.push('_Reply with numbers (e.g. "1,3") or type your own answer_');
    } else {
      lines.push('');
      lines.push('_Reply with a number or type your own answer_');
    }
  }

  return lines.join('\n');
}

export function formatPermissionRequest(event: SsePermissionRequest): string {
  const lines: string[] = [];
  lines.push('*Permission needed:*');
  lines.push('');
  lines.push(`Tool: \`${event.toolName}\``);

  // Show relevant tool input (summarized)
  const input = event.toolInput;
  if (input) {
    if (typeof input.command === 'string') {
      lines.push(`Command: \`${truncate(input.command as string, 200)}\``);
    } else if (typeof input.file_path === 'string') {
      lines.push(`File: \`${input.file_path}\``);
    } else if (typeof input.pattern === 'string') {
      lines.push(`Pattern: \`${input.pattern}\``);
    }
  }

  lines.push('');
  lines.push('_Reply /allow or /deny_');

  return lines.join('\n');
}

export function formatToolUse(event: SseToolUse): string {
  return `_Using: ${event.toolName}_`;
}

// ============================================================================
// Session & History Formatters
// ============================================================================

export function formatSessionList(sessions: AgentSessionInfo[]): string {
  if (sessions.length === 0) {
    return 'No active sessions.';
  }

  const lines: string[] = [];
  lines.push(`*Active Sessions (${sessions.length}):*`);

  for (const s of sessions.slice(0, 10)) {
    const statusIcon = s.status === 'running' ? '\u25B6' : s.status === 'waiting' ? '\u23F8' : '\u2713';
    lines.push(
      `${statusIcon} \`${s.sessionId.slice(0, 8)}\` - ${s.status} (${s.turnCount} turns, ${formatCost(s.costUsd)})`
    );
  }

  if (sessions.length > 10) {
    lines.push(`_...and ${sessions.length - 10} more_`);
  }

  return lines.join('\n');
}

export function formatConversationHistory(
  messages: ConversationMessage[],
  lastN: number = 5
): string {
  const recent = messages.slice(-lastN);
  if (recent.length === 0) {
    return 'No conversation history.';
  }

  const lines: string[] = [];
  lines.push('*Recent Conversation:*');

  for (const msg of recent) {
    const role = msg.role === 'user' ? '\uD83D\uDC64' : '\uD83E\uDD16';
    const content = truncate(msg.content, 300);
    lines.push('');
    lines.push(`${role} ${content}`);
  }

  return lines.join('\n');
}

export function formatStatusSummary(
  apiHealthy: boolean,
  activeSessions: number,
  currentSession?: { sessionId: string; state: string; project: string }
): string {
  const lines: string[] = [];
  lines.push('*lm-assist Status:*');
  lines.push(`API: ${apiHealthy ? 'Connected' : 'Disconnected'}`);
  lines.push(`Active sessions: ${activeSessions}`);

  if (currentSession) {
    lines.push('');
    lines.push('*Current Session:*');
    lines.push(`ID: \`${currentSession.sessionId.slice(0, 8)}\``);
    lines.push(`State: ${currentSession.state}`);
    lines.push(`Project: ${currentSession.project}`);
  }

  return lines.join('\n');
}

export function formatHelp(): string {
  return [
    '*lm-assist Commands:*',
    '',
    '/status - Show connection and session status',
    '/sessions - List active Claude Code sessions',
    '/abort - Abort current execution',
    '/project <path> - Set active project',
    '/history - Show recent conversation',
    '/tasks - Show task list',
    '/allow - Allow pending permission request',
    '/deny - Deny pending permission request',
    '/help - Show this help',
    '',
    '_Or just type a message to send as a Claude Code prompt._',
  ].join('\n');
}

// ============================================================================
// Message Chunking
// ============================================================================

/**
 * Split a long message into chunks that fit within platform limits.
 * Splits at paragraph boundaries, then sentence boundaries, then word boundaries.
 */
export function chunkMessage(
  text: string,
  maxLength: number = DEFAULT_MAX_LENGTH
): string[] {
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    // Try to split at paragraph boundary
    let splitIdx = remaining.lastIndexOf('\n\n', maxLength);

    // Fall back to newline
    if (splitIdx <= 0) {
      splitIdx = remaining.lastIndexOf('\n', maxLength);
    }

    // Fall back to sentence boundary
    if (splitIdx <= 0) {
      splitIdx = remaining.lastIndexOf('. ', maxLength);
      if (splitIdx > 0) splitIdx += 1; // Include the period
    }

    // Fall back to space
    if (splitIdx <= 0) {
      splitIdx = remaining.lastIndexOf(' ', maxLength);
    }

    // Hard split as last resort
    if (splitIdx <= 0) {
      splitIdx = maxLength;
    }

    chunks.push(remaining.slice(0, splitIdx).trimEnd());
    remaining = remaining.slice(splitIdx).trimStart();
  }

  return chunks;
}
