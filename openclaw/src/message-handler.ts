/**
 * Message Handler
 *
 * Processes inbound messages from chat users via OpenClaw.
 * Routes messages to the appropriate action:
 * - Commands (/status, /abort, etc.)
 * - Quick replies (1, 2, 3 for question options)
 * - Permission responses (yes/no/allow/deny)
 * - Default: execute as Claude Code prompt
 */

import type {
  InboundMessage,
  OutboundMessage,
  ChatCommand,
  ChatCommandType,
  SseUserQuestion,
  SsePermissionRequest,
} from './types';
import type { LmAssistClient } from './api-client';
import type { SessionMap } from './session-map';
import type { EventBridge } from './event-bridge';
import {
  formatSessionList,
  formatConversationHistory,
  formatStatusSummary,
  formatHelp,
} from './formatter';

/**
 * Callback to send a message to a chat user
 */
export type SendFn = (message: OutboundMessage) => Promise<void>;

/**
 * Stores pending blocking events for quick-reply resolution
 */
interface PendingBlockingEvent {
  type: 'question' | 'permission';
  event: SseUserQuestion | SsePermissionRequest;
  peerId: string;
  receivedAt: number;
}

export class MessageHandler {
  private client: LmAssistClient;
  private sessionMap: SessionMap;
  private eventBridge: EventBridge;
  private sendFn: SendFn;
  private defaultProject: string;

  /** Pending blocking events keyed by peerId */
  private pendingEvents = new Map<string, PendingBlockingEvent>();

  constructor(options: {
    client: LmAssistClient;
    sessionMap: SessionMap;
    eventBridge: EventBridge;
    sendFn: SendFn;
    defaultProject?: string;
  }) {
    this.client = options.client;
    this.sessionMap = options.sessionMap;
    this.eventBridge = options.eventBridge;
    this.sendFn = options.sendFn;
    this.defaultProject = options.defaultProject || process.cwd();
  }

  // ============================================================================
  // Main Entry Point
  // ============================================================================

  /**
   * Handle an inbound message from a chat user
   */
  async handle(message: InboundMessage): Promise<void> {
    const text = message.text.trim();
    if (!text) return;

    // Check for commands first
    const command = this.parseCommand(text);
    if (command) {
      await this.handleCommand(command, message);
      return;
    }

    // Check for quick replies to blocking events
    const pending = this.pendingEvents.get(message.peerId);
    if (pending) {
      if (pending.type === 'question') {
        await this.handleQuestionReply(text, message.peerId, pending.event as SseUserQuestion);
        return;
      }
      if (pending.type === 'permission') {
        await this.handlePermissionReply(text, message.peerId, pending.event as SsePermissionRequest);
        return;
      }
    }

    // Default: send as Claude Code prompt
    await this.handlePrompt(text, message.peerId);
  }

  /**
   * Register a pending blocking event (called by EventBridge)
   */
  registerBlockingEvent(
    peerId: string,
    event: SseUserQuestion | SsePermissionRequest
  ): void {
    this.pendingEvents.set(peerId, {
      type: event.type === 'sdk_user_question' ? 'question' : 'permission',
      event,
      peerId,
      receivedAt: Date.now(),
    });
  }

  // ============================================================================
  // Command Parsing
  // ============================================================================

  private parseCommand(text: string): ChatCommand | null {
    if (!text.startsWith('/')) return null;

    const parts = text.slice(1).split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const args = parts.slice(1);

    const validCommands: ChatCommandType[] = [
      'status', 'sessions', 'abort', 'project',
      'history', 'tasks', 'allow', 'deny', 'help',
    ];

    if (validCommands.includes(cmd as ChatCommandType)) {
      return { type: cmd as ChatCommandType, args, raw: text };
    }

    return null;
  }

  // ============================================================================
  // Command Handlers
  // ============================================================================

  private async handleCommand(command: ChatCommand, message: InboundMessage): Promise<void> {
    switch (command.type) {
      case 'status':
        await this.cmdStatus(message.peerId);
        break;
      case 'sessions':
        await this.cmdSessions(message.peerId);
        break;
      case 'abort':
        await this.cmdAbort(message.peerId);
        break;
      case 'project':
        await this.cmdProject(message.peerId, command.args);
        break;
      case 'history':
        await this.cmdHistory(message.peerId);
        break;
      case 'allow':
        await this.handlePermissionReply('allow', message.peerId);
        break;
      case 'deny':
        await this.handlePermissionReply('deny', message.peerId);
        break;
      case 'help':
        await this.reply(message.peerId, formatHelp());
        break;
    }
  }

  private async cmdStatus(peerId: string): Promise<void> {
    const healthy = await this.client.healthCheck();
    const sessions = await this.client.listSessions();
    const current = this.sessionMap.get(peerId);

    const text = formatStatusSummary(
      healthy,
      sessions.length,
      current ? {
        sessionId: current.sessionId,
        state: current.state,
        project: current.project,
      } : undefined
    );
    await this.reply(peerId, text);
  }

  private async cmdSessions(peerId: string): Promise<void> {
    const sessions = await this.client.listSessions();
    await this.reply(peerId, formatSessionList(sessions));
  }

  private async cmdAbort(peerId: string): Promise<void> {
    const mapping = this.sessionMap.get(peerId);
    if (!mapping || mapping.state === 'idle') {
      await this.reply(peerId, 'No active execution to abort.');
      return;
    }

    const success = await this.client.abortSession(mapping.sessionId);
    if (success) {
      this.eventBridge.unsubscribe(mapping.executionId);
      this.sessionMap.complete(peerId);
      this.pendingEvents.delete(peerId);
      await this.reply(peerId, 'Execution aborted.');
    } else {
      await this.reply(peerId, 'Failed to abort execution.');
    }
  }

  private async cmdProject(peerId: string, args: string[]): Promise<void> {
    if (args.length === 0) {
      const mapping = this.sessionMap.get(peerId);
      const project = mapping?.project || this.defaultProject;
      await this.reply(peerId, `Current project: \`${project}\``);
      return;
    }

    const newProject = args.join(' ');
    // Update default project for this peer's next execution
    const mapping = this.sessionMap.get(peerId);
    if (mapping) {
      // Can't change project mid-execution
      await this.reply(peerId, `Project for next execution: \`${newProject}\``);
    } else {
      await this.reply(peerId, `Project set to: \`${newProject}\``);
    }
    // Store as metadata (the actual project is passed at execute time)
    this.defaultProject = newProject;
  }

  private async cmdHistory(peerId: string): Promise<void> {
    const mapping = this.sessionMap.get(peerId);
    if (!mapping) {
      await this.reply(peerId, 'No active session. Send a message to start one.');
      return;
    }

    const conv = await this.client.getConversation(mapping.sessionId, {
      lastN: 5,
      toolDetail: 'none',
    });

    if (!conv || conv.messages.length === 0) {
      await this.reply(peerId, 'No conversation history yet.');
      return;
    }

    await this.reply(peerId, formatConversationHistory(conv.messages));
  }

  // ============================================================================
  // Prompt Execution
  // ============================================================================

  private async handlePrompt(prompt: string, peerId: string): Promise<void> {
    // Check if there's an existing session to resume
    const mapping = this.sessionMap.get(peerId);

    try {
      let response;

      if (mapping && mapping.state === 'idle' && mapping.sessionId) {
        // Resume existing session
        response = await this.client.resume(mapping.sessionId, prompt, {
          cwd: mapping.project,
        });
      } else if (mapping && mapping.state !== 'idle') {
        // Active execution — queue message or warn
        await this.reply(peerId, 'An execution is already in progress. Use /abort to cancel it, or wait for it to finish.');
        return;
      } else {
        // New execution
        response = await this.client.execute(prompt, {
          cwd: this.defaultProject,
        });
      }

      // Track the execution
      this.sessionMap.set(
        peerId,
        response.sessionId || '',
        response.executionId,
        this.defaultProject
      );

      // Subscribe to events
      this.eventBridge.subscribe(response.executionId, peerId);

    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      await this.reply(peerId, `Failed to start execution: ${msg}`);
    }
  }

  // ============================================================================
  // Blocking Event Replies
  // ============================================================================

  private async handleQuestionReply(
    text: string,
    peerId: string,
    event?: SseUserQuestion
  ): Promise<void> {
    if (!event) {
      const pending = this.pendingEvents.get(peerId);
      if (!pending || pending.type !== 'question') {
        await this.reply(peerId, 'No pending question to answer.');
        return;
      }
      event = pending.event as SseUserQuestion;
    }

    const mapping = this.sessionMap.get(peerId);
    if (!mapping) return;

    // Build answers from user reply
    const answers: Record<string, string | string[]> = {};

    for (const q of event.questions) {
      // Check if the reply is a numeric option selection
      const numMatch = text.match(/^(\d+(?:\s*,\s*\d+)*)$/);
      if (numMatch && q.options.length > 0) {
        const nums = numMatch[1].split(',').map(n => parseInt(n.trim(), 10));
        const selected = nums
          .filter(n => n >= 1 && n <= q.options.length)
          .map(n => q.options[n - 1].label);

        if (selected.length > 0) {
          answers[q.question] = q.multiSelect ? selected : selected[0];
          continue;
        }
      }

      // Free-text answer
      answers[q.question] = text;
    }

    const success = await this.client.answerQuestion(
      mapping.sessionId,
      event.requestId,
      answers
    );

    if (success) {
      this.pendingEvents.delete(peerId);
      this.sessionMap.setState(peerId, 'executing');
      await this.reply(peerId, 'Answer sent. Continuing...');
    } else {
      await this.reply(peerId, 'Failed to send answer. Try again.');
    }
  }

  private async handlePermissionReply(
    text: string,
    peerId: string,
    event?: SsePermissionRequest
  ): Promise<void> {
    if (!event) {
      const pending = this.pendingEvents.get(peerId);
      if (!pending || pending.type !== 'permission') {
        await this.reply(peerId, 'No pending permission request.');
        return;
      }
      event = pending.event as SsePermissionRequest;
    }

    const mapping = this.sessionMap.get(peerId);
    if (!mapping) return;

    const normalized = text.toLowerCase().trim();
    const isAllow = ['allow', 'yes', 'y', 'ok', 'approve', '1'].includes(normalized);
    const isDeny = ['deny', 'no', 'n', 'reject', 'block', '0'].includes(normalized);

    if (!isAllow && !isDeny) {
      await this.reply(peerId, 'Reply /allow or /deny (or yes/no).');
      return;
    }

    const behavior = isAllow ? 'allow' : 'deny';
    const success = await this.client.respondToPermission(
      mapping.sessionId,
      event.requestId,
      behavior
    );

    if (success) {
      this.pendingEvents.delete(peerId);
      this.sessionMap.setState(peerId, 'executing');
      const label = isAllow ? 'Allowed' : 'Denied';
      await this.reply(peerId, `${label}. Continuing...`);
    } else {
      await this.reply(peerId, 'Failed to send response. Try again.');
    }
  }

  // ============================================================================
  // Utilities
  // ============================================================================

  private async reply(peerId: string, text: string): Promise<void> {
    await this.sendFn({ peerId, text });
  }
}
