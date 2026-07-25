import { workerFetch, detectAppMode, detectProxyInfo } from '@/lib/api-client';

/**
 * Send a voice failure to Core so it lands in `core-prod.log`.
 *
 * This exists because a voice failure on someone else's device is otherwise visible only in a
 * devtools console we cannot reach — which is how several wrong diagnoses got made and one
 * shipped as a regression.
 *
 * HTTP rather than the voice WebSocket, deliberately. Reporting over the socket silently
 * dropped the most valuable cases: when the engine fails fast (unsupported API, instantly
 * denied mic) the socket is still CONNECTING, so `readyState !== OPEN` and nothing was sent.
 * That is exactly the signature of the failure we could not explain — `up=0 ... 1ms`.
 *
 * Never throws and never blocks the caller: a failure to report must not mask the failure
 * being reported.
 */
export function reportVoiceFailure(payload: {
  message: string;
  ua?: string;
  stage?: string;
  caps?: Record<string, unknown>;
}): void {
  try {
    const proxy = detectProxyInfo();
    const base = proxy.isProxied ? `${proxy.basePath}/_coreapi` : detectAppMode().baseUrl;
    void workerFetch(`${base}/voice/claude/client-error`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    }).catch(() => { /* best-effort */ });
  } catch {
    /* best-effort */
  }
}
