/**
 * Tier Manager Stub (lm-assist)
 *
 * Minimal stub for control-api.ts and rest-server.ts compatibility.
 * The full tier orchestration is not part of lm-assist.
 */

export interface TierManagerConfigExtended {
  projectPath: string;
}

export interface ExecuteTierDirectOptions {
  tier: string;
  prompt: string;
}

export class TierManagerProtocolResult {
  success = false;
  message = 'Tier orchestration not available in lm-assist';
}

export class TierManager {
  private projectPath: string;

  constructor(options: { projectPath: string }) {
    this.projectPath = options.projectPath;
  }

  getProjectPath(): string {
    return this.projectPath;
  }
}

export function createTierManager(opts: { projectPath: string }): TierManager {
  return new TierManager(opts);
}
