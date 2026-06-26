export interface AuthSnapshot {
  checkedAt: number;
  oauth: { present: boolean; expired: boolean; msUntilExpiry?: number; refreshedThisCheck: boolean; subscriptionType?: string; rateLimitTier?: string };
  cookie: { configured: boolean; ok: boolean; reason: string; hasSessionKey?: boolean; hasCfClearance?: boolean; hasCfBm?: boolean; identity?: string; hint?: string };
}

export interface AuthSnapshotDeps {
  refreshOAuth: () => Promise<{ refreshed: boolean }>;           // wraps getValidAccessToken()
  oauthStatus: () => { present: boolean; expired: boolean; msUntilExpiry?: number; subscriptionType?: string; rateLimitTier?: string }; // getOAuthStatus()
  cookieStatus: () => { present: boolean; hasSessionKey?: boolean; hasCfClearance?: boolean; hasCfBm?: boolean; identity?: string };     // getClaudeAISessionStatus()
  cookieProbe: () => Promise<{ ok: boolean; reason: string; hint?: string }>; // probeClaudeAISession()
  now: () => number;
}

export async function buildAuthSnapshot(deps: AuthSnapshotDeps): Promise<AuthSnapshot> {
  let refreshed = false;
  try { refreshed = (await deps.refreshOAuth()).refreshed; } catch { /* best-effort */ }

  let oauth: AuthSnapshot['oauth'] = { present: false, expired: false, refreshedThisCheck: refreshed };
  try {
    const o = deps.oauthStatus();
    oauth = { present: !!o.present, expired: !!o.expired, msUntilExpiry: o.msUntilExpiry, refreshedThisCheck: refreshed, subscriptionType: o.subscriptionType, rateLimitTier: o.rateLimitTier };
  } catch { /* degraded */ }

  let cookie: AuthSnapshot['cookie'] = { configured: false, ok: false, reason: 'unknown' };
  try {
    const cs = deps.cookieStatus();
    let probe: { ok: boolean; reason: string; hint?: string };
    try { probe = await deps.cookieProbe(); } catch { probe = { ok: false, reason: 'network_error' }; }
    cookie = {
      configured: !!cs.present, ok: !!probe.ok, reason: probe.ok ? 'ok' : (probe.reason || 'unknown'),
      hasSessionKey: cs.hasSessionKey, hasCfClearance: cs.hasCfClearance, hasCfBm: cs.hasCfBm,
      identity: cs.identity, hint: probe.hint,
    };
  } catch { /* degraded */ }

  return { checkedAt: deps.now(), oauth, cookie };
}

export function defaultDeps(): AuthSnapshotDeps {
  const oauth = require('../utils/claude-oauth') as typeof import('../utils/claude-oauth');
  const cookie = require('../utils/claudeai-session') as typeof import('../utils/claudeai-session');
  return {
    refreshOAuth: async () => {
      try {
        const { getProjectSettings } = require('../project-settings') as typeof import('../project-settings');
        const intervalMin = getProjectSettings().authMonitorIntervalMin ?? 15;
        const r = await oauth.ensureFreshAccessToken(oauth.renewBufferMs(intervalMin));
        return { refreshed: r.refreshed };
      } catch { return { refreshed: false }; }
    },
    oauthStatus: () => { const s = oauth.getOAuthStatus(); return { present: s.present, expired: !!s.expired, msUntilExpiry: s.msUntilExpiry, subscriptionType: s.subscriptionType, rateLimitTier: s.rateLimitTier }; },
    cookieStatus: () => { const s = cookie.getClaudeAISessionStatus(); const id = s.identity?.userId || s.identity?.orgUuid || s.identity?.anonymousId; return { present: s.present, hasSessionKey: s.hasSessionKey, hasCfClearance: s.hasCfClearance, hasCfBm: s.hasCfBm, identity: id }; },
    cookieProbe: async () => { const p = await cookie.probeClaudeAISession(); return { ok: p.ok, reason: p.reason, hint: p.hint }; },
    now: () => Date.now(),
  };
}

export function lightAuthSnapshot(): AuthSnapshot {
  const d = defaultDeps();
  let oauth: AuthSnapshot['oauth'] = { present: false, expired: false, refreshedThisCheck: false };
  try { const o = d.oauthStatus(); oauth = { present: o.present, expired: o.expired, msUntilExpiry: o.msUntilExpiry, refreshedThisCheck: false, subscriptionType: o.subscriptionType, rateLimitTier: o.rateLimitTier }; } catch { /* degraded */ }
  let cookie: AuthSnapshot['cookie'] = { configured: false, ok: false, reason: 'unprobed' };
  try { const cs = d.cookieStatus(); cookie = { configured: !!cs.present, ok: !!cs.hasSessionKey, reason: cs.present ? 'unprobed' : 'session_not_configured', hasSessionKey: cs.hasSessionKey, hasCfClearance: cs.hasCfClearance, hasCfBm: cs.hasCfBm, identity: cs.identity }; } catch { /* degraded */ }
  return { checkedAt: Date.now(), oauth, cookie };
}

export function registerAuthMonitor(jobs: { registerHandler: (t: string, fn: (config: any, ctx: any) => Promise<any>) => void }): void {
  jobs.registerHandler('auth-monitor', async () => {
    const { getProjectSettings } = require('../project-settings') as typeof import('../project-settings');
    if (!getProjectSettings().authMonitorEnabled) return { result: 'auth-monitor disabled', status: 'skipped' };
    const { saveAuthSnapshot } = require('./auth-store') as typeof import('./auth-store');
    const snap = await buildAuthSnapshot(defaultDeps());
    saveAuthSnapshot(snap);
    const o = snap.oauth.present ? (snap.oauth.expired ? 'expired' : 'ok') + (snap.oauth.refreshedThisCheck ? '(refreshed)' : '') : 'none';
    const c = snap.cookie.configured ? (snap.cookie.ok ? 'ok' : snap.cookie.reason) : 'none';
    return { result: `oauth=${o} cookie=${c}`, status: 'ok' };
  });
}
