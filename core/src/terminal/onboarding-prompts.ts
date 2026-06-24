/** Decide keystrokes to clear a known Claude Code startup onboarding prompt. Pure. */
export function decideOnboardingKeys(screen: string): { keys: string; enter: boolean } | null {
  const s = screen || '';
  if (/fullscreen renderer\?/i.test(s) && /Not now/i.test(s)) return { keys: '2', enter: true }; // decline the renderer
  return null;
}
