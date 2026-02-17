/**
 * Prompt Loader
 *
 * Loads tier prompts and instructions from external files.
 * Allows easy iteration on prompts without code changes.
 */

import * as fs from 'fs';
import * as path from 'path';

/**
 * Tier prompt configuration
 */
export interface TierPrompts {
  /** System prompt append (for SDK systemPrompt.append) */
  systemPrompt: string;
  /** Tier instructions (included in each execution prompt) */
  tierInstructions: string;
}

/**
 * Default prompts directory (relative to this file's compiled location)
 */
const DEFAULT_PROMPTS_DIR = path.join(__dirname, '..', 'prompts');

/**
 * Cache for loaded prompts
 */
const promptCache: Map<string, TierPrompts> = new Map();

/**
 * Load prompts for a specific tier
 *
 * @param tierName - Tier name (web, api, database, deploy)
 * @param promptsDir - Custom prompts directory (optional)
 * @param useCache - Whether to use cached prompts (default: true)
 * @returns TierPrompts object with system prompt and tier instructions
 */
export function loadTierPrompts(
  tierName: string,
  promptsDir?: string,
  useCache: boolean = true
): TierPrompts {
  const cacheKey = `${promptsDir || 'default'}:${tierName}`;

  // Return cached if available
  if (useCache && promptCache.has(cacheKey)) {
    return promptCache.get(cacheKey)!;
  }

  const dir = promptsDir || DEFAULT_PROMPTS_DIR;
  const tierDir = path.join(dir, tierName);

  // Load system prompt
  const systemPromptFile = path.join(tierDir, 'system-prompt.txt');
  let systemPrompt = getDefaultSystemPrompt(tierName);
  if (fs.existsSync(systemPromptFile)) {
    systemPrompt = fs.readFileSync(systemPromptFile, 'utf-8').trim();
  }

  // Load tier instructions
  const tierInstructionsFile = path.join(tierDir, 'tier-instructions.md');
  let tierInstructions = getDefaultTierInstructions(tierName);
  if (fs.existsSync(tierInstructionsFile)) {
    tierInstructions = fs.readFileSync(tierInstructionsFile, 'utf-8').trim();
  }

  const prompts: TierPrompts = { systemPrompt, tierInstructions };

  // Cache the result
  if (useCache) {
    promptCache.set(cacheKey, prompts);
  }

  return prompts;
}

/**
 * Load all tier prompts
 */
export function loadAllTierPrompts(
  promptsDir?: string,
  useCache: boolean = true
): Map<string, TierPrompts> {
  const tiers = ['web', 'api', 'database', 'deploy'];
  const allPrompts = new Map<string, TierPrompts>();

  for (const tier of tiers) {
    allPrompts.set(tier, loadTierPrompts(tier, promptsDir, useCache));
  }

  return allPrompts;
}

/**
 * Clear the prompt cache
 */
export function clearPromptCache(): void {
  promptCache.clear();
}

/**
 * Reload prompts for a tier (clears cache and reloads)
 */
export function reloadTierPrompts(tierName: string, promptsDir?: string): TierPrompts {
  const cacheKey = `${promptsDir || 'default'}:${tierName}`;
  promptCache.delete(cacheKey);
  return loadTierPrompts(tierName, promptsDir, true);
}

/**
 * Get the prompts directory path
 */
export function getPromptsDir(): string {
  return DEFAULT_PROMPTS_DIR;
}

/**
 * Check if custom prompts exist for a tier
 */
export function hasCustomPrompts(tierName: string, promptsDir?: string): boolean {
  const dir = promptsDir || DEFAULT_PROMPTS_DIR;
  const tierDir = path.join(dir, tierName);

  const systemPromptFile = path.join(tierDir, 'system-prompt.txt');
  const tierInstructionsFile = path.join(tierDir, 'tier-instructions.md');

  return fs.existsSync(systemPromptFile) || fs.existsSync(tierInstructionsFile);
}

// ============================================================================
// Default Fallback Prompts (used if files don't exist)
// ============================================================================

function getDefaultSystemPrompt(tierName: string): string {
  const defaults: Record<string, string> = {
    web: 'You are the WEB tier agent. Focus on UI components, styling, and frontend integration.',
    api: 'You are the API tier agent. Focus on REST endpoints, authentication, and business logic.',
    database: 'You are the DATABASE tier agent. Focus on schemas, migrations, and data modeling.',
    deploy: 'You are the DEPLOY tier agent. Focus on building, deploying, and managing infrastructure.',
  };
  return defaults[tierName] || `You are the ${tierName.toUpperCase()} tier agent.`;
}

function getDefaultTierInstructions(tierName: string): string {
  const defaults: Record<string, string> = {
    web: `You are the WEB TIER agent.

WRITE: Files in this folder (web/)
READ-ONLY: ../api/, ../database/

Responsibilities:
- UI components and pages
- Client-side state
- Styling and routing
- API integration

Do NOT modify files outside web/ folder.`,

    api: `You are the API TIER agent.

WRITE: Files in this folder (api/)
READ-ONLY: ../web/, ../database/

Responsibilities:
- REST/GraphQL endpoints
- Authentication & authorization
- Business logic
- Request validation

Do NOT modify files outside api/ folder.`,

    database: `You are the DATABASE TIER agent.

WRITE: Files in this folder (database/)
READ-ONLY: ../web/, ../api/

Responsibilities:
- Schema definitions
- Migrations
- Seed data
- Stored procedures

Do NOT modify files outside database/ folder.
For deployment/migration execution → request DEPLOY tier.`,

    deploy: `You are the DEPLOY TIER agent.

WRITE: Files in this folder (deploy/)
READ-ONLY: ../web/, ../api/, ../database/

Responsibilities:
- Build and deploy all services
- Manage infrastructure
- Run migrations
- Monitor service health

When errors occur, identify which tier can fix them and report clearly.`,
  };

  return defaults[tierName] || `You are the ${tierName.toUpperCase()} TIER agent.

WRITE: Files in this folder (${tierName}/)
READ-ONLY: Other tier folders

Do NOT modify files outside ${tierName}/ folder.`;
}
