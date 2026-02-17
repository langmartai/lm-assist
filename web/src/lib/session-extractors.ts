import type { SessionMessage, FileChange, ThinkingBlock, GitOperation, SessionTask, FileAction, DbOperation, SubagentSession } from './types';

/**
 * Extract file changes from session messages.
 */
export function extractFileChanges(messages: SessionMessage[]): FileChange[] {
  const changes: FileChange[] = [];

  for (const msg of messages) {
    if (!msg.toolName) continue;

    const input = msg.toolInput || {};
    const filePath = String(input.file_path || input.path || input.notebook_path || '');
    if (!filePath) continue;

    let action: FileAction | null = null;
    switch (msg.toolName) {
      case 'Read': action = 'read'; break;
      case 'Edit': action = 'edited'; break;
      case 'Write': action = 'created'; break;
      case 'NotebookEdit': action = 'edited'; break;
    }

    if (action) {
      changes.push({
        filePath,
        action,
        turnIndex: msg.turnIndex,
      });
    }

    // Bash commands that modify files
    if (msg.toolName === 'Bash') {
      const cmd = String(input.command || '');
      if (cmd.match(/\brm\s+-/)) {
        const pathMatch = cmd.match(/\brm\s+(?:-\w+\s+)*(.+)/);
        if (pathMatch) {
          changes.push({ filePath: pathMatch[1].trim(), action: 'deleted', turnIndex: msg.turnIndex });
        }
      }
      if (cmd.match(/\bcp\s+/)) {
        changes.push({ filePath: cmd, action: 'copied', turnIndex: msg.turnIndex });
      }
      if (cmd.match(/\bmv\s+/)) {
        changes.push({ filePath: cmd, action: 'moved', turnIndex: msg.turnIndex });
      }
    }
  }

  return changes;
}

/**
 * Extract thinking blocks from session messages.
 */
export function extractThinkingBlocks(messages: SessionMessage[]): ThinkingBlock[] {
  const blocks: ThinkingBlock[] = [];

  for (const msg of messages) {
    if (msg.type !== 'thinking') continue;
    const content = typeof msg.content === 'string' ? msg.content : '';
    if (content) {
      blocks.push({
        content,
        turnIndex: msg.turnIndex || 0,
        charCount: content.length,
      });
    }
  }

  return blocks;
}

/**
 * Extract git operations from session messages.
 */
export function extractGitOperations(messages: SessionMessage[]): GitOperation[] {
  const ops: GitOperation[] = [];

  for (const msg of messages) {
    if (msg.toolName !== 'Bash') continue;
    const input = msg.toolInput || {};
    const cmd = String(input.command || '');
    if (!cmd.match(/\bgit\b|\bgh\b/)) continue;

    const op: Partial<GitOperation> = {
      command: cmd,
      turnIndex: msg.turnIndex,
    };

    if (cmd.match(/\bgit\s+commit/)) {
      op.type = 'commit';
      const msgMatch = cmd.match(/-m\s+["'](.+?)["']/);
      if (msgMatch) op.commitMessage = msgMatch[1];
    } else if (cmd.match(/\bgit\s+push/)) {
      op.type = 'push';
      const remoteMatch = cmd.match(/push\s+(\w+)/);
      if (remoteMatch) op.remote = remoteMatch[1];
    } else if (cmd.match(/\bgit\s+pull/)) {
      op.type = 'pull';
    } else if (cmd.match(/\bgit\s+fetch/)) {
      op.type = 'fetch';
    } else if (cmd.match(/\bgit\s+merge/)) {
      op.type = 'merge';
    } else if (cmd.match(/\bgit\s+branch/)) {
      op.type = 'branch';
      const branchMatch = cmd.match(/branch\s+(?:-\w+\s+)*(\S+)/);
      if (branchMatch) op.branch = branchMatch[1];
    } else if (cmd.match(/\bgit\s+rebase/)) {
      op.type = 'rebase';
    } else if (cmd.match(/\bgit\s+tag/)) {
      op.type = 'tag';
    } else if (cmd.match(/\bgit\s+stash/)) {
      op.type = 'stash';
    } else if (cmd.match(/\bgh\b/)) {
      op.type = 'gh-cli';
      const prMatch = cmd.match(/pr\s+\w+\s+(\d+)/);
      if (prMatch) op.prNumber = parseInt(prMatch[1], 10);
    } else {
      op.type = 'remote';
    }

    if (op.type) {
      ops.push(op as GitOperation);
    }
  }

  return ops;
}

/**
 * Extract tasks from session messages.
 */
export function extractTasks(messages: SessionMessage[]): SessionTask[] {
  const taskMap = new Map<string, SessionTask>();

  for (const msg of messages) {
    if (msg.toolName === 'TaskCreate' && msg.toolInput) {
      const input = msg.toolInput;
      const id = String(input.taskId || taskMap.size + 1);
      taskMap.set(id, {
        id,
        subject: String(input.subject || ''),
        description: String(input.description || ''),
        status: 'pending',
        activeForm: String(input.activeForm || ''),
        owner: String(input.owner || ''),
        blockedBy: input.blockedBy as string[] | undefined,
        blocks: input.blocks as string[] | undefined,
      });
    }

    if (msg.toolName === 'TaskUpdate' && msg.toolInput) {
      const input = msg.toolInput;
      const id = String(input.taskId || '');
      const existing = taskMap.get(id);
      if (existing) {
        if (input.status) existing.status = input.status as any;
        if (input.subject) existing.subject = String(input.subject);
        if (input.description) existing.description = String(input.description);
        if (input.activeForm) existing.activeForm = String(input.activeForm);
        if (input.owner) existing.owner = String(input.owner);
        if (input.addBlockedBy) {
          existing.blockedBy = [...(existing.blockedBy || []), ...(input.addBlockedBy as string[])];
        }
        if (input.addBlocks) {
          existing.blocks = [...(existing.blocks || []), ...(input.addBlocks as string[])];
        }
      }
    }

    // Also extract from task-typed messages
    if (msg.tasks) {
      for (const task of msg.tasks) {
        taskMap.set(task.id, task);
      }
    }
  }

  return Array.from(taskMap.values());
}

/**
 * Extract database operations from session messages.
 */
export function extractDbOperations(messages: SessionMessage[]): DbOperation[] {
  const ops: DbOperation[] = [];

  for (const msg of messages) {
    if (msg.toolName !== 'Bash') continue;
    const input = msg.toolInput || {};
    const cmd = String(input.command || '');

    // Match SQL-related commands
    if (!cmd.match(/\b(psql|mysql|sqlite3|pg_dump|pg_restore|prisma|drizzle|knex|sequelize|sql|CREATE\s+TABLE|ALTER\s+TABLE|DROP\s+TABLE|INSERT\s+INTO|SELECT\s+|UPDATE\s+|DELETE\s+FROM)\b/i)) continue;

    const op: Partial<DbOperation> = {
      sql: cmd,
      tool: 'Bash',
      turnIndex: msg.turnIndex,
      tables: [],
      columns: [],
    };

    // Detect operation type
    if (cmd.match(/\b(CREATE\s+TABLE|prisma\s+migrate|drizzle.*migrate|knex\s+migrate)/i)) {
      op.type = cmd.match(/CREATE\s+TABLE/i) ? 'create' : 'migrate';
    } else if (cmd.match(/\bDROP\s+TABLE/i)) {
      op.type = 'drop';
    } else if (cmd.match(/\b(pg_dump|pg_restore|backup)/i)) {
      op.type = 'backup';
    } else if (cmd.match(/\b(seed|INSERT\s+INTO)/i)) {
      op.type = 'seed';
    } else {
      op.type = 'query';
    }

    // Extract table names
    const tableMatches = cmd.matchAll(/(?:TABLE|FROM|INTO|UPDATE|JOIN)\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?["'`]?(\w+)["'`]?/gi);
    for (const m of tableMatches) {
      if (m[1] && !op.tables!.includes(m[1])) {
        op.tables!.push(m[1]);
      }
    }

    ops.push(op as DbOperation);
  }

  return ops;
}

/**
 * Enrich server-provided subagent data with completion status.
 *
 * The server returns subagents with correct identity (agentId, type, prompt)
 * but often reports status as "running" even after completion. We scan messages
 * for result messages following Task tool calls to determine actual status.
 */
export function enrichSubagentStatus(
  serverSubagents: SubagentSession[],
  messages: SessionMessage[],
): SubagentSession[] {
  if (serverSubagents.length === 0) return serverSubagents;

  // Build a set of tool use IDs that have a corresponding result message
  // (indicating the Task call completed)
  const completedToolUseIds = new Set<string>();
  const errorToolUseIds = new Set<string>();

  for (const msg of messages) {
    if (msg.type === 'result' && msg.id) {
      // Result messages reference the tool use they're responding to
      completedToolUseIds.add(msg.id);
    }
  }

  // Also detect completion by looking at message sequence:
  // A Task tool call followed later by more parent-level messages means
  // the agent finished. If the session is not active, all agents are done.
  const taskToolUseIds = new Set<string>();
  for (const msg of messages) {
    if (msg.toolName === 'Task' && msg.id) {
      taskToolUseIds.add(msg.id);
    }
  }

  return serverSubagents.map(agent => {
    // If server already says completed/error, trust it
    if (agent.status === 'completed' || agent.status === 'error') {
      return agent;
    }

    // Check if the toolUseId has a result (means it completed)
    const toolUseId = (agent as any).toolUseId;
    if (toolUseId && completedToolUseIds.has(toolUseId)) {
      return { ...agent, status: 'completed' as const };
    }

    // Heuristic: if there are messages with higher turnIndex after this agent
    // started, it likely completed (parent resumed)
    const agentTurnIndex = (agent as any).turnIndex;
    if (agentTurnIndex !== undefined) {
      const hasLaterParentMessage = messages.some(m =>
        m.type === 'human' &&
        m.turnIndex !== undefined &&
        m.turnIndex > agentTurnIndex
      );
      if (hasLaterParentMessage) {
        return { ...agent, status: 'completed' as const };
      }
    }

    return agent;
  });
}
