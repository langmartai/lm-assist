/**
 * Tier Agent Stubs (lm-assist)
 *
 * Minimal type exports needed by the type system.
 * The full tier agent orchestration is not part of lm-assist.
 */

export type RunnerType = 'sdk' | 'cli';

export interface TierConfigExtended {
  tierName: string;
  tierPath?: string;
  projectPath: string;
  writePaths: string[];
  runnerType?: RunnerType;
  systemPromptAppend?: string;
}

export interface FactoryOptions {
  projectPath: string;
  runnerType?: RunnerType;
}

export interface TierAgentExecutionHandle {
  executionId: string;
  sessionId: string;
}

export class TierAgent {
  constructor(_config: any) {}
}

export function createTierAgent(_config: any): TierAgent {
  return new TierAgent(_config);
}

export class TierAgentFactory {
  constructor(_options?: any) {}
}
