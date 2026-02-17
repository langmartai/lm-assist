/**
 * File Matcher
 *
 * Detects file-path queries and finds sessions that touched matching files.
 */

import type { SessionCacheData } from '../session-cache';

export function isFileQuery(query: string): boolean {
  // Auto-detect file queries: contains / or common file extensions
  return /\//.test(query) || /\.(ts|js|tsx|jsx|py|go|rs|json|md|yaml|yml|css|html|vue|svelte)$/i.test(query);
}

export interface FileMatchResult {
  sessionId: string;
  filePath: string;
  action: 'write' | 'edit' | 'read';
  turnIndex: number;
  timestamp?: string;
}

export function matchFiles(
  sessions: Array<{ sessionId: string; filePath: string; cacheData: SessionCacheData }>,
  queryPaths: string[],
  limit: number = 20
): FileMatchResult[] {
  const results: FileMatchResult[] = [];

  for (const { sessionId, cacheData } of sessions) {
    for (const tu of cacheData.toolUses) {
      const toolFilePath = tu.input?.file_path || tu.input?.path;
      if (!toolFilePath) continue;

      for (const qPath of queryPaths) {
        if (toolFilePath.endsWith(qPath) || toolFilePath.includes(qPath)) {
          let action: 'write' | 'edit' | 'read' = 'read';
          if (tu.name === 'Write') action = 'write';
          else if (tu.name === 'Edit') action = 'edit';

          // Find timestamp from nearest user prompt
          const nearestPrompt = cacheData.userPrompts
            .filter(p => p.turnIndex <= tu.turnIndex)
            .pop();

          results.push({
            sessionId,
            filePath: toolFilePath,
            action,
            turnIndex: tu.turnIndex,
            timestamp: nearestPrompt?.timestamp,
          });
        }
      }
    }
  }

  // Sort by timestamp descending (most recent first)
  results.sort((a, b) => {
    if (!a.timestamp || !b.timestamp) return 0;
    return new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime();
  });

  return results.slice(0, limit);
}
