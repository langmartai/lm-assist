/**
 * Terminal Input & Screen Read
 *
 * Hybrid approach for sending input to terminal sessions:
 * - tmux send-keys for tmux-managed sessions
 * - ttyd WebSocket for direct-mode sessions
 *
 * Also provides screen capture via tmux capture-pane.
 *
 * @packageDocumentation
 */

import { execFileSync } from './utils/exec';
import { normalizeTerminalText, extractFingerprints } from './session-identifier';

// ─── Types ──────────────────────────────────────────────────

export interface InputRequest {
  text?: string;        // literal text (newlines = newlines, not Enter)
  keys?: string[];      // tmux key names: "Enter", "C-c", "Up", etc.
  raw?: string;         // base64 raw bytes (WebSocket mode only)
}

export interface InputResult {
  success: boolean;
  method: 'tmux' | 'websocket';
  tmuxSession?: string;
  ttydPort?: number;
  error?: string;
}

export interface ScreenResult {
  raw: string;
  normalized: string;
  fingerprints: { userPrompts: string[]; filePaths: string[]; commitHashes: string[] };
  method: 'tmux' | 'websocket';
  tmuxSession?: string;
  ttydPort?: number;
  capturedAt: string;
}

interface SessionTarget {
  tmuxSessionName?: string;
  ttydPort?: number;
  method: 'tmux' | 'websocket' | 'none';
}

// ─── Key Maps ───────────────────────────────────────────────

/** Allowlist of valid tmux key names */
const TMUX_KEY_MAP = new Set([
  'Enter', 'Tab', 'Escape', 'Space', 'BSpace', 'Delete',
  'Up', 'Down', 'Left', 'Right',
  'Home', 'End', 'PageUp', 'PageDown',
  'F1', 'F2', 'F3', 'F4', 'F5', 'F6',
  'F7', 'F8', 'F9', 'F10', 'F11', 'F12',
  // Ctrl sequences: C-a through C-z
  ...Array.from({ length: 26 }, (_, i) => `C-${String.fromCharCode(97 + i)}`),
]);

/** ANSI escape sequences for WebSocket fallback */
const WS_KEY_MAP: Record<string, string> = {
  'Enter': '\r',
  'Tab': '\t',
  'Escape': '\x1b',
  'Space': ' ',
  'BSpace': '\x7f',
  'Delete': '\x1b[3~',
  'Up': '\x1b[A',
  'Down': '\x1b[B',
  'Right': '\x1b[C',
  'Left': '\x1b[D',
  'Home': '\x1b[H',
  'End': '\x1b[F',
  'PageUp': '\x1b[5~',
  'PageDown': '\x1b[6~',
  'F1': '\x1bOP', 'F2': '\x1bOQ', 'F3': '\x1bOR', 'F4': '\x1bOS',
  'F5': '\x1b[15~', 'F6': '\x1b[17~', 'F7': '\x1b[18~', 'F8': '\x1b[19~',
  'F9': '\x1b[20~', 'F10': '\x1b[21~', 'F11': '\x1b[23~', 'F12': '\x1b[24~',
  // Ctrl sequences
  ...Object.fromEntries(
    Array.from({ length: 26 }, (_, i) => [
      `C-${String.fromCharCode(97 + i)}`,
      String.fromCharCode(i + 1),
    ]),
  ),
};

// ─── Target Resolution ──────────────────────────────────────

/**
 * Resolve how to reach a session's terminal:
 * 1. Check ProcessStatusStore for tmuxSessionName
 * 2. Check TtydInstanceStore for an active instance (may have tmux or direct port)
 * 3. If neither → method 'none'
 */
export async function resolveSessionTarget(sessionId: string): Promise<SessionTarget> {
  const { getProcessStatusStore } = await import('./process-status-store');
  const { getTtydManager } = await import('./ttyd-manager');

  const processStore = getProcessStatusStore();
  const proc = processStore.getSessionProcess(sessionId);

  if (proc?.tmuxSessionName) {
    return { tmuxSessionName: proc.tmuxSessionName, method: 'tmux' };
  }

  const instanceStore = getTtydManager().getInstanceStore();
  const instance = instanceStore.getActiveBySessionId(sessionId);

  if (instance) {
    if (instance.tmuxSessionName) {
      return { tmuxSessionName: instance.tmuxSessionName, method: 'tmux' };
    }
    return { ttydPort: instance.port, method: 'websocket' };
  }

  return { method: 'none' };
}

// ─── tmux Input ─────────────────────────────────────────────

/**
 * Send input to a tmux session via tmux send-keys.
 * Uses execFileSync (no shell) to prevent injection.
 */
export function sendViaTmux(tmuxSessionName: string, input: InputRequest): InputResult {
  // Validate session exists
  try {
    execFileSync('tmux', ['has-session', '-t', tmuxSessionName], {
      encoding: 'utf-8',
      timeout: 2000,
    });
  } catch {
    return {
      success: false,
      method: 'tmux',
      tmuxSession: tmuxSessionName,
      error: `tmux session '${tmuxSessionName}' not found`,
    };
  }

  try {
    // Send literal text (with -l to prevent key name interpretation)
    if (input.text) {
      execFileSync('tmux', ['send-keys', '-t', tmuxSessionName, '-l', input.text], {
        encoding: 'utf-8',
        timeout: 5000,
      });
    }

    // Send named keys (without -l)
    if (input.keys) {
      for (const key of input.keys) {
        if (!TMUX_KEY_MAP.has(key)) {
          return {
            success: false,
            method: 'tmux',
            tmuxSession: tmuxSessionName,
            error: `Invalid key name: '${key}'`,
          };
        }
        execFileSync('tmux', ['send-keys', '-t', tmuxSessionName, key], {
          encoding: 'utf-8',
          timeout: 2000,
        });
      }
    }

    return { success: true, method: 'tmux', tmuxSession: tmuxSessionName };
  } catch (err: any) {
    return {
      success: false,
      method: 'tmux',
      tmuxSession: tmuxSessionName,
      error: err.message || 'tmux send-keys failed',
    };
  }
}

// ─── WebSocket Input ────────────────────────────────────────

/**
 * Send input to a ttyd instance via its WebSocket interface.
 * Uses the ttyd binary protocol: type byte 0x30 ('0') = client input.
 */
export async function sendViaWebSocket(port: number, input: InputRequest): Promise<InputResult> {
  const { default: WebSocket } = await import('ws');

  // Pre-validate keys before connecting
  if (input.keys) {
    for (const key of input.keys) {
      if (!WS_KEY_MAP[key]) {
        return {
          success: false,
          method: 'websocket',
          ttydPort: port,
          error: `Invalid key name: '${key}'`,
        };
      }
    }
  }

  // Build payload upfront
  const chunks: Buffer[] = [];
  if (input.text) chunks.push(Buffer.from(input.text, 'utf-8'));
  if (input.keys) {
    for (const key of input.keys) {
      chunks.push(Buffer.from(WS_KEY_MAP[key], 'binary'));
    }
  }
  if (input.raw) chunks.push(Buffer.from(input.raw, 'base64'));

  return new Promise((resolve) => {
    let settled = false;
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    let inputSent = false;

    const done = (result: InputResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(connectionTimeout);
      if (flushTimer) clearTimeout(flushTimer);
      resolve(result);
    };

    const sendPayload = () => {
      if (inputSent || settled) return;
      inputSent = true;
      try {
        if (chunks.length > 0) {
          const payload = Buffer.concat(chunks);
          const frame = Buffer.concat([Buffer.from([0x30]), payload]);
          ws.send(frame);
        }
        // Flush delay before closing
        flushTimer = setTimeout(() => {
          ws.close();
          done({ success: true, method: 'websocket', ttydPort: port });
        }, 100);
      } catch (err: any) {
        ws.close();
        done({
          success: false,
          method: 'websocket',
          ttydPort: port,
          error: err.message || 'WebSocket send failed',
        });
      }
    };

    const connectionTimeout = setTimeout(() => {
      ws.terminate();
      done({
        success: false,
        method: 'websocket',
        ttydPort: port,
        error: 'WebSocket connection timeout',
      });
    }, 5000);

    const ws = new WebSocket(`ws://localhost:${port}/ws`, ['tty']);

    ws.on('error', (err) => {
      ws.terminate();
      done({
        success: false,
        method: 'websocket',
        ttydPort: port,
        error: `WebSocket error: ${err.message}`,
      });
    });

    ws.on('open', () => {
      // Send init message — ttyd needs this to spawn/attach the process
      ws.send(JSON.stringify({ columns: 120, rows: 40 }));
    });

    ws.on('message', (data: Buffer) => {
      // Wait for first server output (type 0x30 = output data) before sending input.
      // This confirms ttyd has processed the init and the terminal is ready.
      if (!inputSent && data.length > 0 && data[0] === 0x30) {
        sendPayload();
      }
    });
  });
}

// ─── Public API ─────────────────────────────────────────────

/**
 * Send input to a session's terminal, auto-selecting tmux or WebSocket method.
 */
export async function sendInput(sessionId: string, input: InputRequest): Promise<InputResult> {
  const target = await resolveSessionTarget(sessionId);

  if (target.method === 'tmux' && target.tmuxSessionName) {
    return sendViaTmux(target.tmuxSessionName, input);
  }

  if (target.method === 'websocket' && target.ttydPort) {
    return sendViaWebSocket(target.ttydPort, input);
  }

  return {
    success: false,
    method: 'tmux',
    error: `No terminal found for session '${sessionId}'. Session may not be running or has no tmux/ttyd attachment.`,
  };
}

/**
 * Capture the current terminal screen from a tmux session.
 */
export function captureScreen(tmuxSessionName: string): ScreenResult {
  const raw = execFileSync('tmux', ['capture-pane', '-t', tmuxSessionName, '-p', '-S', '-'], {
    encoding: 'utf-8',
    timeout: 5000,
  }) as string;

  const normalized = normalizeTerminalText(raw);
  const fp = extractFingerprints(normalized);

  return {
    raw,
    normalized,
    fingerprints: {
      userPrompts: fp.userPrompts,
      filePaths: fp.filePaths,
      commitHashes: fp.commitHashes,
    },
    method: 'tmux',
    tmuxSession: tmuxSessionName,
    capturedAt: new Date().toISOString(),
  };
}

/**
 * Capture terminal screen via ttyd WebSocket.
 *
 * Connects to the ttyd instance, collects the initial output burst
 * (ttyd server→client type 0 = output data), then disconnects.
 *
 * Works reliably for tmux-mode ttyd instances (linked sessions share the
 * same pane). For direct-mode ttyd, this connects as a new client which
 * sees the spawned shell's initial output — useful but limited.
 */
export async function captureScreenViaWebSocket(port: number): Promise<ScreenResult> {
  const { default: WebSocket } = await import('ws');

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let settled = false;

    const connectionTimeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        ws.terminate();
        reject(new Error('WebSocket connection timeout'));
      }
    }, 5000);

    // After receiving the first output, wait for the burst to finish
    let collectTimeout: ReturnType<typeof setTimeout> | null = null;
    const scheduleCollect = () => {
      if (collectTimeout) clearTimeout(collectTimeout);
      collectTimeout = setTimeout(() => {
        if (!settled) {
          settled = true;
          clearTimeout(connectionTimeout);
          ws.close();
          finalize();
        }
      }, 300); // 300ms silence = burst done
    };

    const finalize = () => {
      const raw = Buffer.concat(chunks).toString('utf-8');
      const normalized = normalizeTerminalText(raw);
      const fp = extractFingerprints(normalized);
      resolve({
        raw,
        normalized,
        fingerprints: {
          userPrompts: fp.userPrompts,
          filePaths: fp.filePaths,
          commitHashes: fp.commitHashes,
        },
        method: 'websocket',
        ttydPort: port,
        capturedAt: new Date().toISOString(),
      });
    };

    const ws = new WebSocket(`ws://localhost:${port}/ws`, ['tty']);

    ws.on('error', (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(connectionTimeout);
        if (collectTimeout) clearTimeout(collectTimeout);
        reject(new Error(`WebSocket error: ${err.message}`));
      }
    });

    ws.on('open', () => {
      // Send init message — triggers ttyd to start streaming output
      ws.send(JSON.stringify({ columns: 200, rows: 50 }));
    });

    ws.on('message', (data: Buffer) => {
      if (settled) return;
      // ttyd server→client protocol: first byte is type
      // Type 0 = output data, Type 1 = window title, Type 2 = preferences
      if (data.length > 1 && data[0] === 0x30) {
        // Type '0' (0x30) = output data — collect the payload (skip type byte)
        chunks.push(data.subarray(1));
        scheduleCollect();
      }
    });

    ws.on('close', () => {
      if (!settled) {
        settled = true;
        clearTimeout(connectionTimeout);
        if (collectTimeout) clearTimeout(collectTimeout);
        if (chunks.length > 0) {
          finalize();
        } else {
          reject(new Error('WebSocket closed before receiving any output'));
        }
      }
    });
  });
}

/**
 * Capture screen for a session, auto-selecting tmux capture-pane or WebSocket.
 * Prefers tmux when available (full scrollback, no side effects).
 * Falls back to WebSocket for ttyd-only sessions.
 */
export async function captureScreenForSession(sessionId: string): Promise<ScreenResult> {
  const target = await resolveSessionTarget(sessionId);

  if (target.method === 'tmux' && target.tmuxSessionName) {
    return captureScreen(target.tmuxSessionName);
  }

  if (target.method === 'websocket' && target.ttydPort) {
    return captureScreenViaWebSocket(target.ttydPort);
  }

  throw new Error(`No terminal found for session '${sessionId}'. Session may not be running or has no tmux/ttyd attachment.`);
}
