/**
 * Claude CLI Runner
 * Executes Claude Code CLI commands and captures output
 */

import { spawn, ChildProcess, SpawnOptions } from 'child_process';
import { EventEmitter } from 'events';
import type {
  ClaudeCliOptions,
  ClaudeCliResult,
  ClaudeCliStreamEvent,
  SystemInitEvent,
  AssistantMessageEvent,
  ResultEvent,
  TokenUsage,
} from './types';

/**
 * Default timeout for CLI execution (5 minutes)
 */
const DEFAULT_TIMEOUT = 5 * 60 * 1000;

/**
 * Claude CLI Runner class
 */
export class ClaudeCliRunner extends EventEmitter {
  private defaultTimeout: number;
  private runningProcesses: Map<string, ChildProcess> = new Map();

  constructor(options?: { defaultTimeout?: number }) {
    super();
    this.defaultTimeout = options?.defaultTimeout || DEFAULT_TIMEOUT;
  }

  /**
   * Execute a prompt using Claude CLI
   */
  async execute(prompt: string, options: ClaudeCliOptions): Promise<ClaudeCliResult> {
    const args = this.buildArgs(prompt, options);
    const timeout = options.timeout || this.defaultTimeout;

    return new Promise((resolve, reject) => {
      const startTime = Date.now();
      let stdout = '';
      let stderr = '';
      let result: ClaudeCliResult | null = null;
      let resolved = false;

      // Build shell command with properly escaped arguments
      const command = this.buildShellCommand(args);

      const spawnOptions: SpawnOptions = {
        cwd: options.cwd,
        env: { ...process.env, FORCE_COLOR: '0' },
        shell: true,
        // IMPORTANT: inherit stdin, pipe stdout/stderr
        // Claude CLI needs stdin connected to work properly
        stdio: ['inherit', 'pipe', 'pipe'],
      };

      const proc = spawn(command, [], spawnOptions);
      const sessionId = options.sessionId || `proc-${proc.pid}`;
      this.runningProcesses.set(sessionId, proc);

      // Set up timeout
      const timeoutHandle = setTimeout(() => {
        proc.kill('SIGTERM');
        reject(new Error(`CLI execution timed out after ${timeout}ms`));
      }, timeout);

      proc.stdout?.on('data', (data: Buffer) => {
        const chunk = data.toString();
        stdout += chunk;

        // Parse streaming JSON if verbose mode
        if (options.verbose && options.outputFormat === 'stream-json') {
          this.parseStreamingOutput(chunk);

          // Check for result message - complete early if found
          if (!resolved && chunk.includes('"type":"result"')) {
            resolved = true;
            clearTimeout(timeoutHandle);
            this.runningProcesses.delete(sessionId);
            proc.kill();

            result = this.parseVerboseResult(stdout);
            if (result) {
              resolve(result);
            }
          }
        }
      });

      proc.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString();
      });

      proc.on('close', (code) => {
        clearTimeout(timeoutHandle);
        this.runningProcesses.delete(sessionId);

        // Skip if already resolved (early detection)
        if (resolved) {
          return;
        }

        const duration = Date.now() - startTime;

        if (code !== 0 && code !== null) {
          resolve({
            success: false,
            result: '',
            sessionId: sessionId,
            durationMs: duration,
            durationApiMs: 0,
            numTurns: 0,
            totalCostUsd: 0,
            usage: this.emptyUsage(),
            modelUsage: {},
            error: stderr || `Process exited with code ${code}`,
          });
          return;
        }

        // Parse result from verbose JSON output
        if (options.verbose && options.outputFormat === 'stream-json') {
          result = this.parseVerboseResult(stdout);
        }

        if (result) {
          resolve(result);
        } else {
          // Plain text output
          resolve({
            success: true,
            result: stdout.trim(),
            sessionId: sessionId,
            durationMs: duration,
            durationApiMs: duration,
            numTurns: 1,
            totalCostUsd: 0,
            usage: this.emptyUsage(),
            modelUsage: {},
          });
        }
      });

      proc.on('error', (err) => {
        clearTimeout(timeoutHandle);
        this.runningProcesses.delete(sessionId);
        reject(err);
      });
    });
  }

  /**
   * Execute with full verbose output and return structured result
   */
  async executeVerbose(
    prompt: string,
    options: Omit<ClaudeCliOptions, 'verbose' | 'outputFormat'>
  ): Promise<ClaudeCliResult> {
    return this.execute(prompt, {
      ...options,
      verbose: true,
      outputFormat: 'stream-json',
    });
  }

  /**
   * Check if a session/process is running
   */
  isRunning(sessionId: string): boolean {
    return this.runningProcesses.has(sessionId);
  }

  /**
   * Get all running session IDs
   */
  getRunningSessionIds(): string[] {
    return Array.from(this.runningProcesses.keys());
  }

  /**
   * Kill a running process
   */
  kill(sessionId: string, signal: NodeJS.Signals = 'SIGTERM'): boolean {
    const proc = this.runningProcesses.get(sessionId);
    if (proc) {
      proc.kill(signal);
      this.runningProcesses.delete(sessionId);
      return true;
    }
    return false;
  }

  /**
   * Kill all running processes
   */
  killAll(signal: NodeJS.Signals = 'SIGTERM'): number {
    let killed = 0;
    for (const [sessionId, proc] of this.runningProcesses) {
      proc.kill(signal);
      this.runningProcesses.delete(sessionId);
      killed++;
    }
    return killed;
  }

  /**
   * Build CLI arguments
   */
  private buildArgs(prompt: string, options: ClaudeCliOptions): string[] {
    // No shell quoting needed - spawn passes args directly when shell: false
    const args: string[] = ['-p', prompt];

    if (options.sessionId) {
      if (options.resume) {
        args.push('--resume', options.sessionId);
      } else {
        args.push('--session-id', options.sessionId);
      }
    }

    if (options.verbose) {
      args.push('--verbose');
    }

    if (options.outputFormat) {
      args.push('--output-format', options.outputFormat);
    }

    if (options.allowedTools && options.allowedTools.length > 0) {
      args.push('--allowedTools', options.allowedTools.join(','));
    }

    if (options.debug) {
      args.push('--debug', options.debug);
    }

    if (options.model) {
      args.push('--model', options.model);
    }

    return args;
  }

  /**
   * Parse streaming JSON output and emit events
   */
  private parseStreamingOutput(chunk: string): void {
    const lines = chunk.split('\n').filter((line) => line.trim());

    for (const line of lines) {
      try {
        const data = JSON.parse(line);
        const event: ClaudeCliStreamEvent = {
          type: data.type,
          subtype: data.subtype,
          data: data,
        };
        this.emit('stream', event);

        // Emit specific event types
        if (data.type === 'system') {
          this.emit('system', this.parseSystemInit(data));
        } else if (data.type === 'assistant') {
          this.emit('assistant', this.parseAssistantMessage(data));
        } else if (data.type === 'result') {
          this.emit('result', this.parseResultEvent(data));
        }
      } catch {
        // Not JSON, ignore
      }
    }
  }

  /**
   * Parse verbose result from stdout
   */
  private parseVerboseResult(stdout: string): ClaudeCliResult | null {
    const lines = stdout.split('\n').filter((line) => line.trim());

    for (const line of lines) {
      try {
        const data = JSON.parse(line);
        if (data.type === 'result') {
          return {
            success: data.subtype === 'success',
            result: data.result || '',
            sessionId: data.session_id || '',
            durationMs: data.duration_ms || 0,
            durationApiMs: data.duration_api_ms || 0,
            numTurns: data.num_turns || 1,
            totalCostUsd: data.total_cost_usd || 0,
            usage: this.parseUsage(data.usage),
            modelUsage: data.modelUsage || {},
            error: data.is_error ? data.result : undefined,
          };
        }
      } catch {
        // Not JSON, continue
      }
    }

    return null;
  }

  /**
   * Parse system init event
   */
  private parseSystemInit(data: Record<string, unknown>): SystemInitEvent {
    return {
      cwd: data.cwd as string,
      sessionId: data.session_id as string,
      tools: (data.tools as string[]) || [],
      mcpServers: (data.mcp_servers as string[]) || [],
      model: data.model as string,
      permissionMode: data.permissionMode as string,
      slashCommands: (data.slash_commands as string[]) || [],
      claudeCodeVersion: data.claude_code_version as string,
      outputStyle: data.output_style as string,
      agents: (data.agents as string[]) || [],
      plugins: (data.plugins as SystemInitEvent['plugins']) || [],
    };
  }

  /**
   * Parse assistant message event
   */
  private parseAssistantMessage(data: Record<string, unknown>): AssistantMessageEvent {
    const message = data.message as Record<string, unknown>;
    return {
      model: message?.model as string,
      id: message?.id as string,
      content: (message?.content as AssistantMessageEvent['content']) || [],
      usage: this.parseUsage(message?.usage as Record<string, unknown>),
    };
  }

  /**
   * Parse result event
   */
  private parseResultEvent(data: Record<string, unknown>): ResultEvent {
    return {
      success: data.subtype === 'success',
      isError: data.is_error as boolean,
      durationMs: data.duration_ms as number,
      durationApiMs: data.duration_api_ms as number,
      numTurns: data.num_turns as number,
      result: data.result as string,
      sessionId: data.session_id as string,
      totalCostUsd: data.total_cost_usd as number,
      usage: this.parseUsage(data.usage as Record<string, unknown>),
      modelUsage: (data.modelUsage as Record<string, ResultEvent['modelUsage'][string]>) || {},
    };
  }

  /**
   * Parse usage object
   */
  private parseUsage(usage: Record<string, unknown> | undefined): TokenUsage {
    if (!usage) {
      return this.emptyUsage();
    }

    const cacheCreation = usage.cache_creation as Record<string, number> | undefined;

    return {
      inputTokens: (usage.input_tokens as number) || 0,
      outputTokens: (usage.output_tokens as number) || 0,
      cacheCreationInputTokens: (usage.cache_creation_input_tokens as number) || 0,
      cacheReadInputTokens: (usage.cache_read_input_tokens as number) || 0,
      cacheCreation: cacheCreation
        ? {
            ephemeral5mInputTokens: cacheCreation.ephemeral_5m_input_tokens || 0,
            ephemeral1hInputTokens: cacheCreation.ephemeral_1h_input_tokens || 0,
          }
        : undefined,
    };
  }

  /**
   * Create empty usage object
   */
  private emptyUsage(): TokenUsage {
    return {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    };
  }

  /**
   * Build shell command string with properly escaped arguments
   */
  private buildShellCommand(args: string[]): string {
    const escapedArgs = args.map(arg => this.shellQuote(arg));
    return `claude ${escapedArgs.join(' ')}`;
  }

  /**
   * Shell-escape a string for safe use in shell commands
   * Uses single quotes and escapes embedded single quotes
   */
  private shellQuote(str: string): string {
    // Use single quotes - they prevent all interpretation except for single quotes themselves
    // Escape embedded single quotes by ending the quote, adding escaped quote, and restarting
    return `'${str.replace(/'/g, "'\\''")}'`;
  }
}

/**
 * Create a new CLI runner instance
 */
export function createCliRunner(options?: { defaultTimeout?: number }): ClaudeCliRunner {
  return new ClaudeCliRunner(options);
}
