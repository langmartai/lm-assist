/**
 * Agent Teams Service Stub (lm-assist)
 *
 * Reads team config files from ~/.claude/teams/ for session DAG visualization.
 */

import * as fs from 'fs';
import * as path from 'path';
import { homedir } from 'os';

export interface TeamMember {
  name: string;
  agentId: string;
  agentType?: string;
  role?: string;
  status?: string;
}

export interface TeamConfig {
  name: string;
  members: TeamMember[];
  createdAt?: string;
}

export interface TeamResult {
  success: boolean;
  team?: TeamConfig;
  error?: string;
}

export class AgentTeamsService {
  private teamsDir: string;

  constructor() {
    this.teamsDir = path.join(homedir(), '.claude', 'teams');
  }

  getTeam(teamName: string): TeamResult {
    const configPath = path.join(this.teamsDir, teamName, 'config.json');
    try {
      if (!fs.existsSync(configPath)) {
        return { success: false, error: 'Team not found' };
      }
      const data = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      return { success: true, team: data };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  }

  listTeams(): TeamConfig[] {
    try {
      if (!fs.existsSync(this.teamsDir)) return [];
      return fs.readdirSync(this.teamsDir)
        .filter(d => fs.statSync(path.join(this.teamsDir, d)).isDirectory())
        .map(d => {
          const result = this.getTeam(d);
          return result.team;
        })
        .filter((t): t is TeamConfig => !!t);
    } catch {
      return [];
    }
  }
}

let instance: AgentTeamsService | null = null;

export function getAgentTeamsService(): AgentTeamsService {
  if (!instance) {
    instance = new AgentTeamsService();
  }
  return instance;
}

export function createAgentTeamsService(): AgentTeamsService {
  return new AgentTeamsService();
}
