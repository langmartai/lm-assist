import fs from 'node:fs';

// Pure preflight gate for voice v2 (bidirectional, Chrome-relayed voice). Callers resolve
// the three preconditions (LM_HTTPS terminator up, a claude.ai cookie on this node, a
// system Chrome for puppeteer-core to drive) and pass them in — kept synchronous and
// side-effect-free beyond fs.existsSync so it stays trivially testable.

const CHROME_CANDIDATES =['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'];

export function resolveChromePath(): string | null {
  const envPath = process.env.PUPPETEER_EXECUTABLE_PATH;
  if (envPath && fs.existsSync(envPath)) return envPath;
  for (const p of CHROME_CANDIDATES) { try { if (fs.existsSync(p)) return p; } catch { /* noop */ } }
  return null;
}

export function voiceV2Capability(env: { httpsEnabled: boolean; cookiePresent: boolean; chromePath: string | null }): { available: boolean; reason: string } {
  if (!env.httpsEnabled) return { available: false, reason: 'LM_HTTPS is off — voice v2 needs a secure same-origin WSS' };
  if (!env.cookiePresent) return { available: false, reason: 'no claude.ai cookie on this node' };
  if (!env.chromePath) return { available: false, reason: 'no system Chrome found for the relay' };
  return { available: true, reason: 'ok' };
}
