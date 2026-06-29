import { normalizeTarget, applyLifecycle } from '../../lifecycle';

export const nodeLifecycleToolDef = {
  name: 'node_lifecycle',
  description:
    "GRACEFULLY exit or restart THIS node's lm-assist Core and/or Web — no force-kill / taskkill / " +
    'fuser -k needed. `action`: "exit" (clean shutdown; the process stays down until its supervisor — ' +
    'systemd / scheduled task / lm-assist start — brings it back) or "restart" (clean shutdown + a ' +
    'self-respawn of a fresh process). `target`: "core" (default), "web", or "both". Use `node:` to ' +
    'target a specific host. ADMIN. The response returns BEFORE the process exits (~0.5s later), so a ' +
    'node-targeted call still gets an answer. CAVEAT: a graceful exit only works on a HEALTHY process — ' +
    'a kernel-wedged process still needs a manual kill / reboot.',
  annotations: { readOnlyHint: false },
  inputSchema: {
    type: 'object' as const,
    properties: {
      action: { type: 'string', enum: ['exit', 'restart'], description: 'exit = clean shutdown; restart = shutdown + self-respawn.' },
      target: { type: 'string', enum: ['core', 'web', 'both'], description: 'What to cycle (default core).' },
    },
    required: ['action'],
  },
};

export async function handleNodeLifecycle(args: Record<string, unknown>): Promise<{ content: Array<{ type: string; text: string }> }> {
  const action = args.action === 'restart' ? 'restart' : args.action === 'exit' ? 'exit' : null;
  if (!action) return { content: [{ type: 'text', text: 'node_lifecycle: `action` must be "exit" or "restart".' }] };
  const target = normalizeTarget(args.target);
  const result = await applyLifecycle(action, target);
  return { content: [{ type: 'text', text: `node_lifecycle: ${action} ${target} — ${JSON.stringify(result)}` }] };
}
