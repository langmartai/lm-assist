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
