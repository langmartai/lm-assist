/**
 * Harness registry — the allowlist and lookup for `AgentExecuteRequest.runner`.
 *
 * 🔴 The allowlist is the SAFETY half of this module, and it is why the file
 * exists at all. Before it, `runner` was never validated: the route checked only
 * `prompt`, and `agent-api.execute()` tested `=== 'tmux'` with everything else
 * falling through to the Claude Agent SDK. So a typo'd or not-yet-deployed runner
 * value did not fail — it silently ran a REAL Claude agent with the caller's
 * prompt and cwd, potentially under `bypassPermissions`. An unknown id must be a
 * loud refusal that echoes what was sent, never a fallback.
 *
 * Registration is deliberately lazy: `sdk` and `tmux` are served by pre-existing
 * code paths inside agent-api.ts rather than by AgentHarness objects, so they are
 * declared here as ids + capabilities only. Genuinely pluggable harnesses (qwen)
 * register themselves as objects.
 */

import type { AgentHarness, HarnessCapabilities, HarnessError } from './types';

/**
 * Runners implemented directly inside agent-api.ts. They are legal `runner`
 * values but have no AgentHarness object to dispatch to — the existing branches
 * handle them.
 */
const BUILTIN_CAPABILITIES: Record<string, HarnessCapabilities> = {
  sdk: {
    cost: 'reported',
    sessionResume: true,
    mcp: true,
    permissionBroker: true,
    // The detached (`background: true`) variant persists; the in-process one does not.
    durableBackground: true,
    usesProviderProfile: false,
    // AbortController on the in-process query; sdkRunner.kill() on the detached one.
    abortable: true,
  },
  tmux: {
    // tmux-runner hardcodes totalCostUsd: 0 — it parses a TUI and cannot know.
    cost: 'unavailable',
    sessionResume: true,
    mcp: true,
    // Blocking prompts are driven through /terminal/cc/:session/*, not this API.
    permissionBroker: false,
    // Lives in an in-memory map; a Core restart orphans the CC process.
    durableBackground: false,
    usesProviderProfile: false,
    // Cooperative: Ctrl+C into the CC TUI, which settles the runner's wait.
    abortable: true,
  },
};

const registry = new Map<string, AgentHarness>();

/** Register a pluggable harness. Later registrations replace earlier ones by id. */
export function registerHarness(harness: AgentHarness): void {
  registry.set(harness.id, harness);
}

/** The AgentHarness for an id, or undefined for builtins and unknown ids. */
export function getHarness(id: string): AgentHarness | undefined {
  return registry.get(id);
}

/** Every legal `runner` value, builtins first. */
export function listHarnessIds(): string[] {
  return [...Object.keys(BUILTIN_CAPABILITIES), ...registry.keys()];
}

export function isKnownHarness(id: unknown): boolean {
  if (typeof id !== 'string' || id.length === 0) return false;
  return id in BUILTIN_CAPABILITIES || registry.has(id);
}

export function getCapabilities(id: string): HarnessCapabilities | undefined {
  return BUILTIN_CAPABILITIES[id] ?? registry.get(id)?.capabilities;
}

/**
 * Validate a caller-supplied `runner`.
 *
 * Returns null when it is absent (meaning "the default") or known, and a
 * HarnessError echoing the rejected value otherwise. Echoing matters: the
 * caller's own typo is the fastest thing to act on, and a bare
 * "unsupported runner" tells them nothing.
 */
export function assertKnownHarness(id: unknown): HarnessError | null {
  if (id === undefined || id === null) return null;
  if (isKnownHarness(id)) return null;
  return {
    code: 'UNSUPPORTED_RUNNER',
    message:
      `Unsupported runner ${JSON.stringify(id)}. ` +
      `Supported runners: ${listHarnessIds().join(', ')}.`,
  };
}

/** Capability summary for status/diagnostic surfaces. */
export function describeHarnesses(): Array<{ id: string; capabilities: HarnessCapabilities; pluggable: boolean }> {
  return listHarnessIds().map((id) => ({
    id,
    capabilities: getCapabilities(id)!,
    pluggable: registry.has(id),
  }));
}
