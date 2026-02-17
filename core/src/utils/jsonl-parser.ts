/**
 * JSONL Parser utilities for Claude session files
 */

import * as fs from 'fs';
import * as readline from 'readline';
import type { SessionMessage, TokenUsage, ContentBlock } from '../types';

/**
 * Parse a single JSONL line into a typed record
 */
export function parseJsonlLine<T>(line: string): T | null {
  try {
    const trimmed = line.trim();
    if (!trimmed) return null;
    return JSON.parse(trimmed) as T;
  } catch {
    return null;
  }
}

/**
 * Read all records from a JSONL file
 */
export async function readJsonlFile<T>(filePath: string): Promise<T[]> {
  const records: T[] = [];

  if (!fs.existsSync(filePath)) {
    return records;
  }

  const fileStream = fs.createReadStream(filePath);
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    const record = parseJsonlLine<T>(line);
    if (record) {
      records.push(record);
    }
  }

  return records;
}

/**
 * Stream JSONL records with a callback
 */
export async function streamJsonlFile<T>(
  filePath: string,
  callback: (record: T, lineNumber: number) => void | Promise<void>
): Promise<number> {
  if (!fs.existsSync(filePath)) {
    return 0;
  }

  const fileStream = fs.createReadStream(filePath);
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });

  let lineNumber = 0;
  for await (const line of rl) {
    const record = parseJsonlLine<T>(line);
    if (record) {
      await callback(record, lineNumber);
    }
    lineNumber++;
  }

  return lineNumber;
}

/**
 * Append a record to a JSONL file
 */
export function appendJsonlRecord<T>(filePath: string, record: T): void {
  const line = JSON.stringify(record) + '\n';
  fs.appendFileSync(filePath, line);
}

/**
 * Write multiple records to a JSONL file
 */
export function writeJsonlFile<T>(filePath: string, records: T[]): void {
  const content = records.map((r) => JSON.stringify(r)).join('\n') + '\n';
  fs.writeFileSync(filePath, content);
}

/**
 * Raw session record as stored in JSONL
 */
export interface RawSessionRecord {
  type: 'system' | 'user' | 'assistant' | 'result' | 'progress' | 'tool_result' | 'summary' | 'file-history-snapshot';
  uuid: string;
  parentUuid?: string;
  timestamp?: string;
  message?: {
    role?: string;
    content?: string | ContentBlock[];
    model?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation?: {
        ephemeral_5m_input_tokens?: number;
        ephemeral_1h_input_tokens?: number;
      };
    };
  };
  toolUseResult?: {
    tool_use_id: string;
    content: string;
    is_error?: boolean;
  };
  summary?: string;
  sessionId?: string;
  cwd?: string;
}

/**
 * Parse raw session record into typed SessionMessage
 */
export function parseSessionRecord(raw: RawSessionRecord): SessionMessage | null {
  if (!raw.uuid || !raw.type) {
    return null;
  }

  // Skip file-history-snapshot records
  if (raw.type === 'file-history-snapshot') {
    return null;
  }

  const message: SessionMessage = {
    uuid: raw.uuid,
    parentUuid: raw.parentUuid,
    type: raw.type as SessionMessage['type'],
    timestamp: raw.timestamp ? new Date(raw.timestamp) : new Date(),
    content: '',
  };

  // Parse content based on type
  if (raw.type === 'user' && raw.message?.content) {
    message.content = raw.message.content as string;
  } else if (raw.type === 'assistant' && raw.message?.content) {
    message.content = raw.message.content as ContentBlock[];

    // Parse usage
    if (raw.message.usage) {
      message.usage = parseTokenUsage(raw.message);
    }
  } else if (raw.type === 'tool_result' && raw.toolUseResult) {
    message.content = raw.toolUseResult.content;
    message.toolUse = {
      toolName: '',
      toolId: raw.toolUseResult.tool_use_id,
      input: {},
      result: raw.toolUseResult.content,
      isError: raw.toolUseResult.is_error,
    };
  } else if (raw.type === 'summary' && raw.summary) {
    message.content = raw.summary;
  }

  return message;
}

/**
 * Parse raw usage object into TokenUsage
 */
export function parseTokenUsage(raw: RawSessionRecord['message']): TokenUsage {
  const usage = raw?.usage;
  if (!usage) {
    return {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    };
  }

  return {
    inputTokens: usage.input_tokens || 0,
    outputTokens: usage.output_tokens || 0,
    cacheCreationInputTokens: usage.cache_creation_input_tokens || 0,
    cacheReadInputTokens: usage.cache_read_input_tokens || 0,
    cacheCreation: usage.cache_creation
      ? {
          ephemeral5mInputTokens: usage.cache_creation.ephemeral_5m_input_tokens || 0,
          ephemeral1hInputTokens: usage.cache_creation.ephemeral_1h_input_tokens || 0,
        }
      : undefined,
  };
}

/**
 * Extract text content from content blocks
 */
export function extractTextContent(content: string | ContentBlock[]): string {
  if (typeof content === 'string') {
    return content;
  }

  return content
    .filter((block) => block.type === 'text')
    .map((block) => block.text || '')
    .join('\n');
}

/**
 * Count tokens in a session file (with deduplication)
 */
export async function countSessionTokens(
  filePath: string,
  seenUuids?: Set<string>
): Promise<{ tokens: TokenUsage; messageCount: number; duplicateCount: number }> {
  const seen = seenUuids || new Set<string>();
  let duplicateCount = 0;

  const totals: TokenUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreation: {
      ephemeral5mInputTokens: 0,
      ephemeral1hInputTokens: 0,
    },
  };

  let messageCount = 0;

  await streamJsonlFile<RawSessionRecord>(filePath, (record) => {
    if (record.type !== 'assistant') return;
    if (!record.uuid) return;

    // Skip duplicates
    if (seen.has(record.uuid)) {
      duplicateCount++;
      return;
    }
    seen.add(record.uuid);

    const usage = record.message?.usage;
    if (!usage) return;

    messageCount++;
    totals.inputTokens += usage.input_tokens || 0;
    totals.outputTokens += usage.output_tokens || 0;
    totals.cacheReadInputTokens += usage.cache_read_input_tokens || 0;

    // Handle nested cache_creation
    if (usage.cache_creation) {
      const ephemeral5m = usage.cache_creation.ephemeral_5m_input_tokens || 0;
      const ephemeral1h = usage.cache_creation.ephemeral_1h_input_tokens || 0;
      totals.cacheCreationInputTokens += ephemeral5m + ephemeral1h;
      if (totals.cacheCreation) {
        totals.cacheCreation.ephemeral5mInputTokens += ephemeral5m;
        totals.cacheCreation.ephemeral1hInputTokens += ephemeral1h;
      }
    } else if (usage.cache_creation_input_tokens) {
      // Fallback for flat structure
      totals.cacheCreationInputTokens += usage.cache_creation_input_tokens;
    }
  });

  return { tokens: totals, messageCount, duplicateCount };
}
