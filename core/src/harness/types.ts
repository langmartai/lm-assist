/**
 * Harness types — the contract a non-Claude agent CLI must satisfy to run
 * behind POST /agent/execute.
 *
 * Background: lm-assist already had three ways to run an agent (the in-process
 * Agent SDK, a detached `claude -p` child, and a warm tmux CC TUI), selected by
 * `AgentExecuteRequest.runner`. That selector was a two-line `if`, so every new
 * way to run an agent meant another branch. This module turns it into a registry.
 *
 * The important idea here is CAPABILITIES. The three original runners disagree
 * about what they can report — the tmux runner, for instance, hardcodes
 * `totalCostUsd: 0` because it genuinely cannot know. `0` is therefore already a
 * legitimate value and is useless as a "this harness is broken" signal. So a
 * harness DECLARES what it can honestly produce instead of leaving callers to
 * guess from the shape of the response.
 */

import type {
  AgentExecuteRequest,
  AgentExecuteResponse,
  AgentResumeRequest,
} from '../types/agent-api';

/** How trustworthy a harness's cost reporting is. */
export type CostFidelity =
  /** The harness reports a real figure from the provider (Claude Agent SDK). */
  | 'reported'
  /** lm-assist derives it from token counts and a pricing table. */
  | 'computed'
  /** The harness cannot know. Callers must NOT read 0 as "free". */
  | 'unavailable';

export interface HarnessCapabilities {
  cost: CostFidelity;
  /** Can continue a prior session by id. */
  sessionResume: boolean;
  /** Can be given MCP servers. */
  mcp: boolean;
  /** Can broker interactive permission / question prompts back to the caller. */
  permissionBroker: boolean;
  /** Survives a Core restart (i.e. its work is reattachable, not in-memory). */
  durableBackground: boolean;
  /** Talks to a model gateway rather than to Anthropic via ambient OAuth. */
  usesProviderProfile: boolean;
}

export interface AgentHarness {
  /** Stable id, used as the `runner` value on the wire. */
  id: string;
  /** Human label for status surfaces. */
  displayName: string;
  capabilities: HarnessCapabilities;
  /**
   * Run to completion and return a fully-formed response. Implementations own
   * their own timeout policy and MUST populate `runner` on the response so a
   * caller can tell what actually served the request.
   */
  execute(request: AgentExecuteRequest, executionId: string): Promise<AgentExecuteResponse>;
  /** Optional; harnesses without it must be refused rather than silently served by another runner. */
  resume?(request: AgentResumeRequest): Promise<AgentExecuteResponse>;
  /** Preflight — is the underlying binary present and configured? */
  probe?(): Promise<HarnessProbe>;
}

export interface HarnessProbe {
  available: boolean;
  /** Version string when resolvable. */
  version?: string;
  /** Why it is unavailable, in terms the operator can act on. */
  reason?: string;
  /** Resolved binary path, when found. */
  binary?: string;
}

export interface HarnessError {
  code: string;
  message: string;
}
