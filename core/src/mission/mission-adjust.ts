/** The Mission Controller's "adjust" reasoning step: one-shot, max-thinking LLM call. */
import type { Mission, ExecutorOutput, AdjustResult } from './mission-model';
import { ADJUST_SCHEMA, parseAdjustResult } from './mission-model';
import { createSdkRunner } from '../sdk-runner';

/** Minimal runner surface so tests can inject a fake (real impl = createSdkRunner). */
export interface AdjustRunner {
  execute(prompt: string, opts: Record<string, unknown>): Promise<{ result: string; success: boolean; error?: string }>;
}

export function buildAdjustPrompt(m: Mission, out: ExecutorOutput): string {
  return [
    `You are the Mission Controller's reasoning step. Read the mission and the executor's NEW output, then decide the next action as JSON.`,
    `# Mission objective\n${m.objective}`,
    m.plan ? `# Current plan\n${m.plan}` : '',
    m.nextSteps && m.nextSteps.length ? `# Next steps\n- ${m.nextSteps.join('\n- ')}` : '',
    `# NEW executor output since last check\n${out.messages.join('\n')}`,
    out.results.length ? `# New results\n${out.results.map((r) => `- ${r.ref}: ${r.summary ?? ''}`).join('\n')}` : '',
    [
      `# Decide — return ONLY JSON matching:`,
      `{ "verdict": "continue|revise|done|blocked|gate", "revisedObjective": string|null, "revisedNextSteps": string[]|null, "isMaterialPivot": boolean, "nextDirective": string, "reason": string }`,
      `- "done" ONLY if the objective is demonstrably met by the results.`,
      `- "revise" to refine the objective/plan; set isMaterialPivot=true ONLY for a direction change away from the original objective.`,
      `- "gate" if a human decision is required; "blocked" if stuck with no path forward.`,
      `- nextDirective: the exact instruction to send the executor next.`,
    ].join('\n'),
  ].filter(Boolean).join('\n\n');
}

export async function runAdjust(
  m: Mission,
  out: ExecutorOutput,
  model: string,
  runner?: AdjustRunner,
): Promise<AdjustResult> {
  const r: AdjustRunner = runner ?? (createSdkRunner({ trackChanges: false }) as unknown as AdjustRunner);
  try {
    const res = await r.execute(buildAdjustPrompt(m, out), {
      model,
      maxTurns: 1,
      extendedThinking: { enabled: true, type: 'adaptive' },
      outputConfig: { effort: 'high', format: { type: 'json_schema', schema: ADJUST_SCHEMA } },
    });
    if (!res.success) return parseAdjustResult('');
    return parseAdjustResult(res.result);
  } catch {
    return parseAdjustResult('');
  }
}
