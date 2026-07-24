'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { buildClaudeVoiceWsUrl } from '@/lib/voice-url';
import { buildApprovalFrame, buildDenyFrame } from '@/lib/claude-voice-approval';
import { demuxMessageSse, initialDemuxAcc, type ApprovalOption, type DemuxAcc, type VoiceState } from '@/lib/claude-voice-demux';

export type { ApprovalOption, ApprovalReq, McpAuthReq, ToolUseView, VoiceState } from '@/lib/claude-voice-demux';

/** The engine's own instance shape (web/public/voice/claude-voice-engine.js, Task 7) — a
 *  browser-only public static asset, dynamic-imported on demand (see `loadEngine` below),
 *  never bundled. */
interface ClaudeVoiceEngine {
  start(opts: { onFrame: (opus: Uint8Array) => void; onState?: (s: string) => void }): Promise<void>;
  playPcm(pcm: ArrayBuffer | Int16Array): void;
  clearPlayback(): void;
  stop(): void;
}

async function loadEngine(): Promise<ClaudeVoiceEngine> {
  // The engine ships as a public static asset (web/public/voice/claude-voice-engine.js), not
  // a bundled module: `webpackIgnore` keeps webpack/Turbopack from trying to resolve/bundle
  // the URL (a plain runtime fetch, like mic-worklet.js's `audioWorklet.addModule`), which
  // means tsc can't resolve it either (TS2307). An ambient `declare module` doesn't help for
  // an absolute path-like specifier (TS2664 — that escape hatch only covers bare/package-style
  // names), so `@ts-expect-error` is the correct one for a real runtime-only import path.
  // @ts-expect-error — see comment above; the module lives outside the TS program on purpose.
  const { createClaudeVoiceEngine } = await import(/* webpackIgnore: true */ '/voice/claude-voice-engine.js');
  return createClaudeVoiceEngine();
}

export interface UseClaudeVoiceOpts {
  conversationUuid: string;
  model: string;
  effort: string;
  thinkingMode?: string;
  /** Viewing a hub-proxied / other-machine node — same gate as buildClaudeVoiceWsUrl; the
   *  hub relay can't carry a WS upgrade (v1), so voice is unavailable there. */
  isRemoteNode: boolean;
}

/**
 * Bidirectional claude.ai voice v2: mic -> Core `/voice/claude/ws` relay (Chrome-bridged to
 * claude.ai's own voice WS) -> duplex Opus/PCM audio + the completion SSE re-mux, demuxed by
 * `demuxMessageSse` into transcript / assistantText / liveModel / state.
 *
 * Structured like the STT dictation hook (useDictation): refs for the WS/engine (always
 * current inside async callbacks — no stale-closure risk), a synchronous `stateRef` mirror
 * kept in lockstep with `acc.state` for start()/stop() re-entrancy guards, a pending-abort
 * flag for a stop() that lands mid-async-setup (mic permission prompt in flight), and a
 * ref-only unmount effect so a component unmounting mid-session can never leak the mic or
 * the socket.
 *
 * `start()` is a no-op when `buildClaudeVoiceWsUrl` returns null (remote/hub/insecure page —
 * the same degrade-silently rule as dictation); callers hide the mic UI on that same null.
 */
export function useClaudeVoice(opts: UseClaudeVoiceOpts) {
  const { conversationUuid, model, effort, thinkingMode, isRemoteNode } = opts;

  const [acc, setAcc] = useState<DemuxAcc>(initialDemuxAcc);
  const stateRef = useRef<VoiceState>('idle');

  const wsRef = useRef<WebSocket | null>(null);
  const engineRef = useRef<ClaudeVoiceEngine | null>(null);
  const startingEngineRef = useRef(false); // true while loadEngine()/engine.start() awaits mic permission
  const pendingAbortRef = useRef(false);   // stop() landed mid-async-setup -> tear down as soon as it resolves

  const wsUrl = useMemo(() => buildClaudeVoiceWsUrl({ isRemoteNode }), [isRemoteNode]);

  // Central acc-update point: keeps stateRef in lockstep with acc.state so the imperative
  // start()/stop()/interrupt() guards always see the CURRENT state, never a stale closure.
  const applyAcc = useCallback((updater: (prev: DemuxAcc) => DemuxAcc) => {
    setAcc((prev) => {
      const next = updater(prev);
      stateRef.current = next.state;
      return next;
    });
  }, []);

  const closeWs = useCallback(() => {
    const ws = wsRef.current;
    wsRef.current = null; // null it FIRST so the socket's own onclose self-check no-ops
    // Best-effort: let Core release the Chrome relay page now (claude-voice-relay.ts's
    // msg.type === 'close') instead of waiting on the close/error path to notice.
    try { ws?.send(JSON.stringify({ type: 'close' })); } catch { /* noop */ }
    try { ws?.close(); } catch { /* noop */ }
  }, []);

  const teardownEngine = useCallback(() => {
    try { engineRef.current?.stop(); } catch { /* noop */ }
    engineRef.current = null;
  }, []);

  const fail = useCallback((msg: string) => {
    // Not part of the returned state (the interface has no error-message field, only
    // `state`) — logged so a real failure (mic permission, Chrome relay, CF-gating, …) is
    // diagnosable in devtools instead of surfacing only as a silent 'error' state.
    try { console.error('[claude-voice]', msg); } catch { /* noop */ }
    startingEngineRef.current = false;
    pendingAbortRef.current = false;
    closeWs();
    teardownEngine();
    applyAcc((prev) => ({ ...prev, state: 'error' }));
  }, [closeWs, teardownEngine, applyAcc]);

  // Release the mic/engine/socket if the component unmounts mid-session. Refs only (always
  // current, no stale closure) — mirrors useDictation's unmount effect.
  useEffect(() => () => {
    try { wsRef.current?.close(); } catch { /* noop */ }
    wsRef.current = null;
    try { engineRef.current?.stop(); } catch { /* noop */ }
    engineRef.current = null;
  }, []);

  const bootEngine = useCallback(async (ws: WebSocket) => {
    // Optimistic: the connect handshake is live the instant the server says ready — the
    // mic-permission prompt below is the only thing that could still be pending.
    applyAcc((prev) => ({ ...prev, state: 'listening' }));
    startingEngineRef.current = true;
    try {
      const engine = await loadEngine();
      if (pendingAbortRef.current) { // stop() landed while the engine module was loading
        pendingAbortRef.current = false;
        startingEngineRef.current = false;
        try { engine.stop(); } catch { /* noop */ }
        return;
      }
      engineRef.current = engine;
      await engine.start({
        onFrame: (opusBytes) => { if (ws.readyState === WebSocket.OPEN) { try { ws.send(opusBytes); } catch { /* noop */ } } },
        onState: (s) => {
          if (s === 'capturing') applyAcc((prev) => ({ ...prev, state: 'listening' }));
          else if (s === 'error') fail('voice engine error');
        },
      });
      startingEngineRef.current = false;
      if (pendingAbortRef.current) { // stop() landed while engine.start() awaited mic permission
        pendingAbortRef.current = false;
        teardownEngine();
      }
    } catch (e) {
      startingEngineRef.current = false;
      pendingAbortRef.current = false;
      fail(e instanceof Error ? e.message : 'voice engine failed to start');
    }
  }, [applyAcc, fail, teardownEngine]);

  const start = useCallback(() => {
    if (!wsUrl) return; // mic can't work on this page — the caller should already be hiding the UI
    if (stateRef.current !== 'idle' && stateRef.current !== 'error') return; // already active

    applyAcc(() => ({ ...initialDemuxAcc, state: 'connecting' }));

    const ws = new WebSocket(wsUrl);
    ws.binaryType = 'arraybuffer';
    wsRef.current = ws;

    ws.onopen = () => {
      try {
        ws.send(JSON.stringify({ type: 'connect', conversationUuid, model, effort, thinkingMode }));
      } catch { /* noop */ }
    };
    ws.onerror = () => {
      // Same staleness guard as onclose below, and for the same reason it's load-bearing
      // here too: closing a still-CONNECTING socket is GUARANTEED to fire error (WebSocket
      // spec), and closeWs()/stop() call .close() unconditionally, including mid-handshake.
      // Without this check, start() -> stop() before onopen fires would flip the state BACK
      // to 'error' right after stop() set 'idle'; worse, start() -> stop() -> start() in
      // quick succession would let the FIRST (abandoned) socket's queued error land after the
      // second session is already live and tear it down via the shared refs.
      if (wsRef.current === ws) fail('voice connection error');
    };
    ws.onclose = () => {
      // A close with no prior ready/reconnect/error relay frame — e.g. the network dropped.
      // A clean stop() already nulled wsRef before closing, so this self-check skips that path.
      if (wsRef.current === ws) fail('voice connection closed');
    };
    ws.onmessage = (ev: MessageEvent) => {
      if (ev.data instanceof ArrayBuffer) {
        try { engineRef.current?.playPcm(ev.data); } catch { /* noop */ }
        return;
      }
      let frame: unknown;
      try { frame = JSON.parse(ev.data as string); } catch { return; }
      const f = frame as { type?: string; message?: string } | null;

      // Core's OWN relay-control frames (claude-voice-relay.ts's mapPageStatus) — these are
      // never routed through demuxMessageSse, which only ever sees claude.ai's own protocol.
      if (f?.type === 'ready') { void bootEngine(ws); return; }
      if (f?.type === 'reconnect') { applyAcc((prev) => ({ ...prev, state: 'reconnect' })); return; }
      if (f?.type === 'error') { fail(f.message || 'voice error'); return; }
      // Speculative (protocol name unconfirmed — see task report): a server-side barge-in
      // signal. Silences queued playback without touching the mic/WS, same as interrupt().
      if (f?.type === 'server_interrupt') { try { engineRef.current?.clearPlayback(); } catch { /* noop */ } return; }

      applyAcc((prev) => demuxMessageSse(frame, prev));
    };
  }, [wsUrl, conversationUuid, model, effort, thinkingMode, applyAcc, fail, bootEngine]);

  const stop = useCallback(() => {
    if (startingEngineRef.current) pendingAbortRef.current = true; // engine mid-setup -> release it once it lands
    closeWs();
    teardownEngine();
    applyAcc((prev) => ({ ...prev, state: 'idle' }));
  }, [closeWs, teardownEngine, applyAcc]);

  const interrupt = useCallback(() => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) { try { ws.send(JSON.stringify({ type: 'interrupt' })); } catch { /* noop */ } }
    try { engineRef.current?.clearPlayback(); } catch { /* noop */ }
  }, []);

  // Answer a pending in-band approval (Once / For this chat / Always) or deny it. Both look
  // up the matching ApprovalReq by toolUseId (for its approvalKey — the frame builders in
  // claude-voice-approval.ts need it, not the caller), best-effort send the reply frame
  // (same OPEN-guarded try/catch as interrupt() above), and drop the entry from
  // pendingApprovals regardless of send success: once the user has decided, the prompt
  // shouldn't linger in the UI, and a session too broken to deliver the frame is about to
  // surface via onclose/onerror -> fail() anyway. acc.pendingApprovals (not a ref) is the
  // right read here — these are plain synchronous click handlers, not long-lived async
  // work, so the closure captured on the render that produced the currently-visible prompt
  // is already current; unlike the ws/engine refs, there's no staleness risk to guard against.
  const respondToApproval = useCallback(
    (toolUseId: string, buildFrame: (approvalKey: string) => ReturnType<typeof buildApprovalFrame>) => {
      const req = acc.pendingApprovals.find((p) => p.toolUseId === toolUseId);
      if (!req) return;
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        try { ws.send(JSON.stringify(buildFrame(req.approvalKey))); } catch { /* noop */ }
      }
      applyAcc((prev) => ({ ...prev, pendingApprovals: prev.pendingApprovals.filter((p) => p.toolUseId !== toolUseId) }));
    },
    [acc.pendingApprovals, applyAcc],
  );

  const approve = useCallback(
    (toolUseId: string, option: ApprovalOption) => respondToApproval(toolUseId, (approvalKey) => buildApprovalFrame(toolUseId, approvalKey, option)),
    [respondToApproval],
  );

  const denyApproval = useCallback(
    (toolUseId: string) => respondToApproval(toolUseId, (approvalKey) => buildDenyFrame(toolUseId, approvalKey)),
    [respondToApproval],
  );

  return {
    state: acc.state,
    transcript: acc.transcript,
    assistantText: acc.assistantText,
    liveModel: acc.liveModel,
    tools: acc.tools,
    connectorTexts: acc.connectorTexts,
    pendingApprovals: acc.pendingApprovals,
    mcpAuth: acc.mcpAuth,
    start,
    stop,
    interrupt,
    approve,
    denyApproval,
  };
}
