/**
 * Path utilities for Claude CLI Manager
 * Handles path encoding/decoding for session storage
 */

import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

/**
 * Encode a project path using Claude Code's legacy dash-replacement method.
 * Cross-platform: handles both / and \ separators, and removes colons.
 * Linux:   /home/user/project    -> -home-user-project
 * macOS:   /Users/admin/project  -> -Users-admin-project
 * Windows: C:\home\project       -> C--home-project  (colon and backslashes become dashes)
 */
export function legacyEncodeProjectPath(projectPath: string): string {
  return projectPath.replace(/[:\\/]/g, '-');
}

/**
 * Encode a path for use in Claude session storage
 * Uses URL-safe Base64 encoding to handle paths with dashes/special characters
 * Example: /home/ubuntu/my-project -> aG9tZS91YnVudHUvbXktcHJvamVjdA
 *
 * Note: This uses a different encoding than the legacy dash-replacement method
 * to avoid collisions where /home/my-project and /home/my/project would
 * both encode to the same string.
 */
export function encodePath(absolutePath: string): string {
  // Remove leading slash for encoding
  const pathWithoutLeadingSlash = absolutePath.replace(/^\//, '');
  // Use URL-safe Base64 encoding (replace +/ with -_)
  const base64 = Buffer.from(pathWithoutLeadingSlash, 'utf-8').toString('base64');
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Decode an encoded path back to absolute path
 * Supports both new Base64 encoding and legacy dash-replacement format
 * Example: aG9tZS91YnVudHUvbXktcHJvamVjdA -> /home/ubuntu/my-project
 * Example: -home-ubuntu-my-project -> /home/ubuntu/my-project (legacy)
 */
export function decodePath(encodedPath: string): string {
  // Check if this looks like legacy encoding:
  // Legacy format: -home-ubuntu-project (starts with dash, all lowercase, dashes as separators)
  // Base64 format: aG9tZS91YnVudHUvbXktcHJvamVjdA (mixed case, may contain underscores)
  //
  // Legacy format characteristics:
  // 1. Starts with '-' (representing root /)
  // 2. Contains only lowercase letters, numbers, and dashes
  // 3. No underscores (which are used in URL-safe Base64)
  // 4. No uppercase letters (which appear in Base64)
  const isLikelyLegacy = /^-[a-z0-9-]*$/.test(encodedPath) && !encodedPath.includes('_');

  // Windows legacy format: C--home-project (drive letter + -- for colon, dashes for backslashes)
  // Pattern: single uppercase letter followed by -- (from C:\ -> C--)
  // No underscore guard needed: ^[A-Z]-- is a sufficient discriminator — no valid
  // Base64-encoded printable-ASCII path can produce this pattern.
  const isWindowsLegacy = /^[A-Z]--/.test(encodedPath);

  if (isWindowsLegacy) {
    // Windows legacy decoding: C--home-lm-assist -> C:\home\lm-assist
    // The drive letter and colon come from the first char + '--' pattern
    const driveLetter = encodedPath[0];
    const rest = encodedPath.slice(2); // Skip drive letter and first dash (from colon)
    // rest starts with '-' (from backslash after colon), e.g., '-home-lm-assist'
    return decodeWindowsPathWithFilesystemCheck(driveLetter, rest);
  }

  if (isLikelyLegacy) {
    // Legacy decoding with filesystem verification
    // Problem: -home-ubuntu-sample-project could be:
    //   /home/ubuntu/sample-project or /home/ubuntu/sample/project
    // Solution: Try to find the actual path that exists on the filesystem
    return decodePathWithFilesystemCheck(encodedPath);
  }

  try {
    // Restore URL-safe Base64 to standard Base64
    let base64 = encodedPath.replace(/-/g, '+').replace(/_/g, '/');
    // Add padding if needed
    const padding = base64.length % 4;
    if (padding > 0) {
      base64 += '='.repeat(4 - padding);
    }
    const decoded = Buffer.from(base64, 'base64').toString('utf-8');
    // Validate the decoded result looks like a path (should contain valid path characters)
    if (decoded && !decoded.includes('\0') && decoded.length > 0 && /^[a-zA-Z0-9/_.-]+$/.test(decoded)) {
      return '/' + decoded;
    }
  } catch {
    // Fall through to legacy decoding
  }

  // Fallback to legacy decoding (handles edge cases)
  if (encodedPath.startsWith('-')) {
    return decodePathWithFilesystemCheck(encodedPath);
  }
  return '/' + encodedPath.replace(/-/g, '/');
}

/**
 * Decode a legacy dash-encoded path by checking which interpretation exists on disk
 * For -home-ubuntu-sample-project, tries paths in order:
 * 1. /home/ubuntu/sample-project (least slashes - most dashes preserved)
 * 2. /home/ubuntu/sample/project (more slashes)
 * Falls back to all-slashes interpretation if no path exists
 */
function decodePathWithFilesystemCheck(encodedPath: string): string {
  // Remove leading dash and split by dash
  const parts = encodedPath.replace(/^-/, '').split('-');

  // Build path progressively, checking filesystem at each level
  // We want to find the interpretation where the most dashes are preserved
  // (i.e., fewest directory levels that still exists on disk)

  // Start building from root
  let currentPath = '';
  let partIndex = 0;

  while (partIndex < parts.length) {
    const part = parts[partIndex];
    const testPath = currentPath + '/' + part;

    // Check if this path exists as a directory
    try {
      const stat = fs.statSync(testPath);
      if (stat.isDirectory()) {
        // This level exists, continue
        currentPath = testPath;
        partIndex++;
        continue;
      }
    } catch {
      // Path doesn't exist, try combining with remaining parts
    }

    // Current part doesn't exist as a directory
    // Try combining remaining parts with dashes to see if that exists
    if (partIndex < parts.length) {
      // Try progressively combining parts with dashes
      for (let endIndex = parts.length; endIndex > partIndex; endIndex--) {
        const combinedPart = parts.slice(partIndex, endIndex).join('-');
        const combinedPath = currentPath + '/' + combinedPart;

        try {
          const stat = fs.statSync(combinedPath);
          if (stat.isDirectory() || stat.isFile()) {
            // Found a valid path with dashes preserved
            currentPath = combinedPath;
            partIndex = endIndex;
            break;
          }
        } catch {
          // Continue trying shorter combinations
        }
      }

      // If no combination worked, just add this part and continue
      if (partIndex < parts.length && !currentPath.endsWith('/' + parts[partIndex])) {
        currentPath = currentPath + '/' + parts[partIndex];
        partIndex++;
      }
    }
  }

  // If we didn't build a valid path, fall back to all-slashes interpretation
  if (!currentPath || currentPath === '/') {
    return '/' + parts.join('/');
  }

  return currentPath;
}

/**
 * Decode a Windows legacy dash-encoded path by checking which interpretation exists on disk.
 * For C--home-lm-assist, the drive letter and rest are split by the caller.
 * rest = '-home-lm-assist' (leading dash from backslash after colon)
 * We reconstruct C:\ + path using filesystem checks to resolve dash ambiguity.
 */
function decodeWindowsPathWithFilesystemCheck(driveLetter: string, rest: string): string {
  // rest starts with '-' (from backslash), e.g., '-home-lm-assist'
  const parts = rest.replace(/^-/, '').split('-');
  const driveRoot = driveLetter + ':\\';

  // Build path progressively, checking filesystem at each level
  let currentPath = driveRoot;
  let partIndex = 0;

  while (partIndex < parts.length) {
    const part = parts[partIndex];
    const testPath = path.join(currentPath, part);

    // Check if this path exists as a directory
    try {
      const stat = fs.statSync(testPath);
      if (stat.isDirectory()) {
        currentPath = testPath;
        partIndex++;
        continue;
      }
    } catch {
      // Path doesn't exist, try combining with remaining parts
    }

    // Try combining remaining parts with dashes to see if that exists
    if (partIndex < parts.length) {
      let found = false;
      for (let endIndex = parts.length; endIndex > partIndex; endIndex--) {
        const combinedPart = parts.slice(partIndex, endIndex).join('-');
        const combinedPath = path.join(currentPath, combinedPart);

        try {
          const stat = fs.statSync(combinedPath);
          if (stat.isDirectory() || stat.isFile()) {
            currentPath = combinedPath;
            partIndex = endIndex;
            found = true;
            break;
          }
        } catch {
          // Continue trying shorter combinations
        }
      }

      if (!found) {
        currentPath = path.join(currentPath, parts[partIndex]);
        partIndex++;
      }
    }
  }

  return currentPath;
}

/**
 * Get the lm-assist data directory
 * Default: ~/.lm-assist
 * Can be overridden with LM_ASSIST_DATA_DIR env var
 * All lm-assist owned data lives here (knowledge, milestones, vectors, cache, etc.)
 */
export function getDataDir(): string {
  return process.env.LM_ASSIST_DATA_DIR || path.join(os.homedir(), '.lm-assist');
}

/**
 * Get the Claude config directory
 * Default: ~/.claude
 * Can be overridden with CLAUDE_CONFIG_DIR env var
 */
export function getClaudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

/**
 * Get the projects directory
 * Default: ~/.claude/projects
 */
export function getProjectsDir(configDir?: string): string {
  return path.join(configDir || getClaudeConfigDir(), 'projects');
}

/**
 * Get the session file path for a project and session ID
 */
export function getSessionFilePath(
  projectPath: string,
  sessionId: string,
  configDir?: string
): string {
  const projectsDir = getProjectsDir(configDir);
  const encodedProject = encodePath(projectPath);
  return path.join(projectsDir, encodedProject, `${sessionId}.jsonl`);
}

/**
 * Get the project directory in Claude storage
 */
export function getProjectStorageDir(
  projectPath: string,
  configDir?: string
): string {
  const projectsDir = getProjectsDir(configDir);
  const encodedProject = encodePath(projectPath);
  return path.join(projectsDir, encodedProject);
}

/**
 * Transform paths in content for migration
 * Example: Transform all /home/ubuntu to /home/opc
 */
export function transformPaths(
  content: string,
  transforms: Array<{ from: string; to: string }>
): string {
  let result = content;
  for (const { from, to } of transforms) {
    result = result.replace(new RegExp(escapeRegex(from), 'g'), to);
  }
  return result;
}

/**
 * Escape special regex characters
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Normalize a path (resolve ~, ., ..)
 */
export function normalizePath(inputPath: string): string {
  if (inputPath.startsWith('~')) {
    inputPath = path.join(os.homedir(), inputPath.slice(1));
  }
  return path.resolve(inputPath);
}

/**
 * Check if a path is absolute
 */
export function isAbsolutePath(inputPath: string): boolean {
  return path.isAbsolute(inputPath) || inputPath.startsWith('~');
}

/**
 * Get relative path from project root
 */
export function getRelativePath(absolutePath: string, projectRoot: string): string {
  return path.relative(projectRoot, absolutePath);
}

/**
 * Extract project path from encoded storage path
 */
export function extractProjectPath(storagePath: string): string | null {
  const projectsDir = getProjectsDir();
  if (!storagePath.startsWith(projectsDir)) {
    return null;
  }

  const relativePath = storagePath.substring(projectsDir.length + 1);
  const parts = relativePath.split(path.sep);
  if (parts.length === 0) {
    return null;
  }

  return decodePath(parts[0]);
}
