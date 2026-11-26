/**
 * Gemini Web (`https://gemini.google.com/`) "via-chrome" snippet generator.
 *
 * Mirrors `claudeai-via-chrome.ts`: produces self-contained JavaScript snippets
 * meant to run inside an authenticated `https://gemini.google.com/*` Chrome
 * tab (via `mcp__claude-in-chrome__javascript_tool` or `POST /browser/tabs/:id/eval`).
 *
 * Transport split (verified via `lm-proxy/docs/gemini-web-protocol.md`):
 *   1. Unary Boq RPCs (`POST /_/BardChatUi/data/batchexecute`) run directly via
 *      same-origin `fetch(..., { credentials: 'include' })` using session tokens
 *      from `window.WIZ_global_data` (`SNlM0e` -> `at`, `cfb2h` -> `bl`,
 *      `FdrFJe` -> `f.sid`, `eptZe` -> URL prefix).
 *   2. Chat generation (`geminiweb-pa.clients6.google.com/v1/processSession`) is
 *      cross-origin WebChannel v8 + Protobuf requiring `SAPISIDHASH`,
 *      `X-Server-Token`, and fresh WAA attestation (`waa-pa.clients6.google.com`).
 *      Therefore `snippetSendMessage` drives the authenticated Gemini SPA's own
 *      prompt editor + Send button so Chrome performs attestation natively, then
 *      reads back the completed turn via `hNvQHb`.
 */

const CONV_HEX_RE = /^[a-f0-9]{8,32}$/i;
const RPC_ID_RE = /^[A-Za-z0-9]{4,12}$/;

/** Known Gemini Web model IDs observed in `otAQ7b` (`neon_pro_policy`). */
export const GEMINI_MODEL_IDS: Record<string, string> = {
  '8c46e95b1a07cecc': 'Auto',
  'cf41b0e0dd7d53e5': 'Auto (signed-out)',
  '56fdd199312815e2': '4 Hydrogen',
  'e6fa609c3fa255c0': '4 Neon',
  '95a4c0abcba24364': '4 Carbon',
};

/** Thinking level codes observed in `otAQ7b` / `processSession`. */
export const GEMINI_THINKING_LEVELS: Record<number, string> = {
  1: 'Low/Standard',
  4: 'Medium',
  2: 'High',
};

export interface GeminiViaChromeSnippet {
  /** JS code suitable for `javascript_tool` or `POST /browser/tabs/:id/eval`. */
  snippet: string;
  /** Human-readable description of what the snippet does. */
  description: string;
  /** Expected endpoint URL. */
  url: string;
  /** HTTP method performed (`GET` or `POST`). */
  method: 'GET' | 'POST';
  /** Caller instructions. */
  instructions: string;
}

const INSTRUCTIONS =
  "Pass `snippet` verbatim as the `text` field to mcp__claude-in-chrome__javascript_tool " +
  "with action='javascript_exec' (or via POST /browser/tabs/:id/eval), targeting an authenticated " +
  "https://gemini.google.com/* tab. If you don't have a Gemini tab open, navigate to https://gemini.google.com/app first.";

/**
 * Normalize a Gemini conversation ID to `c_<hex>`.
 * Accepts either `c_<8..32 hex>` or `<8..32 hex>`.
 */
export function normalizeConvId(id: string): string {
  if (typeof id !== 'string') {
    throw new Error('Invalid Gemini conversation ID: expected string');
  }
  const trimmed = id.trim();
  const hex = trimmed.startsWith('c_') ? trimmed.slice(2) : trimmed;
  if (!CONV_HEX_RE.test(hex)) {
    throw new Error(`Invalid Gemini conversation ID: ${id}`);
  }
  return `c_${hex.toLowerCase()}`;
}

/** Return the bare `<hex>` conversation ID without the `c_` prefix. */
export function bareConvId(id: string): string {
  return normalizeConvId(id).slice(2);
}

/**
 * Normalize a Gemini response ID to `r_<hex>`.
 * Accepts either `r_<8..32 hex>` or `<8..32 hex>`.
 */
export function normalizeRespId(id: string): string {
  if (typeof id !== 'string') {
    throw new Error('Invalid Gemini response ID: expected string');
  }
  const trimmed = id.trim();
  const hex = trimmed.startsWith('r_') ? trimmed.slice(2) : trimmed;
  if (!CONV_HEX_RE.test(hex)) {
    throw new Error(`Invalid Gemini response ID: ${id}`);
  }
  return `r_${hex.toLowerCase()}`;
}

/** Validate a Boq `batchexecute` RPC identifier (e.g. `otAQ7b`, `MaZiqc`, `hNvQHb`). */
export function validateRpcId(rpcId: string): string {
  if (typeof rpcId !== 'string') {
    throw new Error('Invalid rpcId: expected string');
  }
  const trimmed = rpcId.trim();
  if (!RPC_ID_RE.test(trimmed)) {
    throw new Error(`Invalid batchexecute rpcId: ${rpcId}`);
  }
  return trimmed;
}

/**
 * Shared in-page `batchexecute` helper injected into generated snippets.
 * Uses `window.WIZ_global_data` + `fetch(..., { credentials: 'include' })`
 * and decodes Google's `)]}'` chunked Boq envelope (`wrb.fr`).
 */
export const GEMINI_BATCHEXECUTE_HELPER_JS = `
  async function callBatchExecute(rpcId, args, sourcePath = '/app', hl = 'en') {
    if (location.hostname !== 'gemini.google.com') {
      return {
        ok: false,
        error: 'wrong_tab',
        reason: 'wrong_tab',
        pageUrl: location.href,
        message: 'Active tab is not on https://gemini.google.com/',
      };
    }
    const wiz = (typeof window !== 'undefined' && window.WIZ_global_data) || null;
    if (!wiz || !wiz.SNlM0e || !wiz.cfb2h || !wiz.FdrFJe) {
      return {
        ok: false,
        error: 'not_logged_in',
        reason: 'not_logged_in',
        pageUrl: location.href,
        message: 'WIZ_global_data (SNlM0e/cfb2h/FdrFJe) missing — sign in to https://gemini.google.com/app first.',
      };
    }
    const prefix = String(wiz.eptZe || '/_/BardChatUi/').replace(/\\/?$/, '/');
    const qs = new URLSearchParams({
      rpcids: rpcId,
      'source-path': sourcePath,
      bl: String(wiz.cfb2h),
      'f.sid': String(wiz.FdrFJe),
      hl: String(hl || 'en'),
      _reqid: String(Math.floor(100000 + Math.random() * 899999)),
      rt: 'c',
    });
    const url = prefix + 'data/batchexecute?' + qs.toString();
    const form = new URLSearchParams({
      'f.req': JSON.stringify([[[rpcId, JSON.stringify(args), null, 'generic']]]),
      at: String(wiz.SNlM0e),
    });
    let r;
    try {
      r = await fetch(url, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8' },
        body: form.toString() + '&',
      });
    } catch (e) {
      return {
        ok: false,
        error: 'fetch_failed',
        reason: 'network_error',
        url,
        rpcId,
        message: String((e && e.message) || e),
      };
    }
    const rawText = await r.text();
    if (!r.ok) {
      const reason = (r.status === 401 || r.status === 403) ? 'session_expired' : 'upstream_error';
      return {
        ok: false,
        error: 'http_error',
        reason,
        status: r.status,
        statusText: r.statusText,
        url,
        rpcId,
        body: rawText,
      };
    }
    let body = null;
    let rpcError = null;
    const cleaned = rawText.replace(/^\\)\\]\\}'\\s*/, '');
    for (const line of cleaned.split('\\n')) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('[')) continue;
      let envelope;
      try { envelope = JSON.parse(trimmed); } catch { continue; }
      if (!Array.isArray(envelope)) continue;
      const hit = envelope.find((x) => Array.isArray(x) && x[0] === 'wrb.fr' && x[1] === rpcId);
      if (hit) {
        if (typeof hit[2] === 'string') {
          try { body = JSON.parse(hit[2]); } catch { body = hit[2]; }
        } else if (hit[2] !== undefined) {
          body = hit[2];
        }
        if (hit[5] !== undefined && hit[5] !== null) {
          rpcError = hit[5];
        }
        break;
      }
      const errItem = envelope.find((x) => Array.isArray(x) && x[0] === 'er' && x[1] === rpcId);
      if (errItem && errItem[5] !== undefined) {
        rpcError = errItem[5];
      }
    }
    return {
      ok: rpcError === null,
      status: r.status,
      statusText: r.statusText,
      url,
      rpcId,
      body,
      ...(rpcError !== null ? { rpcError } : {}),
    };
  }
`;

/** Shared in-page parser for `hNvQHb` turn lists. */
const GEMINI_PARSE_TURNS_JS = `
  function parseGeminiTurns(body) {
    if (!Array.isArray(body)) return [];
    const isTurn = (x) => Array.isArray(x) && Array.isArray(x[0]) && typeof x[0][0] === 'string' && x[0][0].startsWith('c_');
    const rawTurns = body.some(isTurn)
      ? body
      : (Array.isArray(body[0]) && body[0].some(isTurn) ? body[0] : []);
    return rawTurns.map((turn) => {
      const ids = Array.isArray(turn[0]) ? turn[0] : [];
      const prompt = Array.isArray(turn[2]) && Array.isArray(turn[2][0]) && typeof turn[2][0][0] === 'string'
        ? turn[2][0][0]
        : null;
      const cand0 = Array.isArray(turn[3]) && Array.isArray(turn[3][0]) && Array.isArray(turn[3][0][0])
        ? turn[3][0][0]
        : null;
      const candidateId = cand0 && typeof cand0[0] === 'string' ? cand0[0] : null;
      let text = null;
      if (cand0) {
        if (Array.isArray(cand0[1])) {
          text = cand0[1].filter((s) => typeof s === 'string').join('');
        } else if (typeof cand0[1] === 'string') {
          text = cand0[1];
        }
      }
      return {
        conversationId: typeof ids[0] === 'string' ? ids[0] : null,
        responseId: typeof ids[1] === 'string' ? ids[1] : null,
        prompt,
        candidateId,
        text,
      };
    });
  }
`;

function batchexecuteUrl(rpcId: string): string {
  return `https://gemini.google.com/_/BardChatUi/data/batchexecute?rpcids=${encodeURIComponent(rpcId)}`;
}

/**
 * Health check snippet — verifies:
 *   1. Active tab is `https://gemini.google.com/*` (`wrong_tab` if not)
 *   2. `window.WIZ_global_data` has `SNlM0e`, `cfb2h`, `FdrFJe` (`not_logged_in` if not)
 *   3. Live `otAQ7b` (`[1]`) call succeeds and policy is not signed-out (`not_logged_in`,
 *      `session_expired`, `network_error`, `upstream_error`, or `ok`)
 */
export function snippetHealthCheck(): GeminiViaChromeSnippet {
  const snippet = `(async () => {${GEMINI_BATCHEXECUTE_HELPER_JS}
  if (location.hostname !== 'gemini.google.com') {
    return {
      ok: false,
      reason: 'wrong_tab',
      pageUrl: location.href,
      hint: 'Open https://gemini.google.com/app in this tab before calling Gemini Web via-chrome endpoints.',
    };
  }
  const wiz = (typeof window !== 'undefined' && window.WIZ_global_data) || null;
  if (!wiz || !wiz.SNlM0e || !wiz.cfb2h || !wiz.FdrFJe) {
    return {
      ok: false,
      reason: 'not_logged_in',
      pageUrl: location.href,
      hint: 'WIZ_global_data session tokens are missing — sign in to https://gemini.google.com/app in this browser first.',
    };
  }
  const probe = await callBatchExecute('otAQ7b', [1], '/app');
  if (!probe.ok) {
    const reason = probe.reason || 'upstream_error';
    const hint = reason === 'network_error'
      ? 'Network error reaching gemini.google.com: ' + (probe.message || 'unknown')
      : reason === 'session_expired'
        ? 'Gemini Web session expired — reload or sign back in to https://gemini.google.com/app.'
        : 'gemini.google.com batchexecute failed' + (probe.status ? ' (' + probe.status + ')' : '');
    return {
      ok: false,
      reason,
      status: probe.status || 0,
      pageUrl: location.href,
      hint,
    };
  }
  const b = probe.body;
  const policyName = (Array.isArray(b) && Array.isArray(b[24]) && typeof b[24][0] === 'string') ? b[24][0] : null;
  if (policyName && /signed_out/i.test(policyName)) {
    return {
      ok: false,
      reason: 'not_logged_in',
      policyName,
      pageUrl: location.href,
      hint: 'Gemini Web reports signed-out policy (' + policyName + ') — sign in at https://gemini.google.com/app.',
    };
  }
  const models = Array.isArray(b && b[15]) ? b[15] : [];
  return {
    ok: true,
    reason: 'ok',
    pageUrl: location.href,
    identity: {
      authUser: wiz.QrtxK !== undefined ? String(wiz.QrtxK) : null,
      buildLabel: wiz.cfb2h ? String(wiz.cfb2h) : null,
      sessionId: wiz.FdrFJe ? String(wiz.FdrFJe) : null,
      hasEmail: !!wiz.oPEP7c,
    },
    policyName,
    modelCount: models.length,
    hint: 'gemini.google.com accessible and logged in; via-chrome routes are ready to use.',
  };
})()`;

  return {
    snippet,
    description: 'Health check: verify active tab is gemini.google.com, WIZ_global_data is populated, and otAQ7b succeeds.',
    url: batchexecuteUrl('otAQ7b'),
    method: 'POST',
    instructions:
      INSTRUCTIONS +
      ' Call this BEFORE any other Gemini Web via-chrome route to confirm the session is healthy. Branch on `ok`; if false, `reason` and `hint` describe what to do.',
  };
}

/**
 * Generic `batchexecute` RPC snippet generator.
 */
export function buildGeminiBatchExecuteSnippet(opts: {
  rpcId: string;
  args?: unknown[];
  sourcePath?: string;
  hl?: string;
  description?: string;
  write?: boolean;
  destructive?: boolean;
}): GeminiViaChromeSnippet {
  const rpcId = validateRpcId(opts.rpcId);
  const args = opts.args === undefined ? [] : opts.args;
  if (!Array.isArray(args)) {
    throw new Error('args must be an array');
  }
  const sourcePath = opts.sourcePath || '/app';
  const hl = opts.hl || 'en';
  const snippet = `(async () => {${GEMINI_BATCHEXECUTE_HELPER_JS}
  return await callBatchExecute(${JSON.stringify(rpcId)}, ${JSON.stringify(args)}, ${JSON.stringify(sourcePath)}, ${JSON.stringify(hl)});
})()`;

  let instructions = INSTRUCTIONS;
  if (opts.destructive) {
    instructions += ' WRITE (DESTRUCTIVE) — permanently mutates Gemini account state. Verify before running.';
  } else if (opts.write) {
    instructions += ' WRITE — modifies Gemini account state.';
  }

  return {
    snippet,
    description: opts.description || `Call Gemini batchexecute RPC ${rpcId}`,
    url: batchexecuteUrl(rpcId),
    method: 'POST',
    instructions,
  };
}

/** List available Gemini models, capabilities, and active tier policy (`otAQ7b`). */
export function snippetListModels(): GeminiViaChromeSnippet {
  const snippet = `(async () => {${GEMINI_BATCHEXECUTE_HELPER_JS}
  const res = await callBatchExecute('otAQ7b', [1], '/app');
  if (!res.ok || !Array.isArray(res.body)) return res;
  const rawModels = Array.isArray(res.body[15]) ? res.body[15] : [];
  const models = rawModels
    .filter((m) => Array.isArray(m))
    .map((m) => ({
      id: typeof m[0] === 'string' ? m[0] : null,
      name: typeof m[1] === 'string' ? m[1] : null,
      description: typeof m[2] === 'string' ? m[2] : null,
      capabilityIds: Array.isArray(m[3]) ? m[3] : [],
    }));
  const policyName = (Array.isArray(res.body[24]) && typeof res.body[24][0] === 'string') ? res.body[24][0] : null;
  return { ...res, models, policyName };
})()`;

  return {
    snippet,
    description: 'List Gemini Web models, capabilities, and active policy (otAQ7b)',
    url: batchexecuteUrl('otAQ7b'),
    method: 'POST',
    instructions: INSTRUCTIONS,
  };
}

/** List sidebar conversations (`MaZiqc`). */
export function snippetListConversations(opts: {
  limit?: number;
  cursor?: string | null;
} = {}): GeminiViaChromeSnippet {
  const limit = Math.min(Math.max(1, Math.floor(opts.limit ?? 31)), 200);
  const cursor = opts.cursor ?? null;
  const args = [limit, cursor, [null, null, 1, null, null, null, null, null, null, 1]];
  const snippet = `(async () => {${GEMINI_BATCHEXECUTE_HELPER_JS}
  const res = await callBatchExecute('MaZiqc', ${JSON.stringify(args)}, '/app');
  if (!res.ok || !Array.isArray(res.body)) return res;
  const nextCursor = typeof res.body[1] === 'string' ? res.body[1] : null;
  const rows = Array.isArray(res.body[2]) ? res.body[2] : [];
  const conversations = rows
    .filter((r) => Array.isArray(r))
    .map((r) => {
      const id = typeof r[0] === 'string' ? r[0] : null;
      return {
        id,
        bareId: id ? id.replace(/^c_/, '') : null,
        title: typeof r[1] === 'string' ? r[1] : null,
      };
    });
  return { ...res, conversations, nextCursor };
})()`;

  return {
    snippet,
    description: 'List Gemini Web conversations (MaZiqc)',
    url: batchexecuteUrl('MaZiqc'),
    method: 'POST',
    instructions: INSTRUCTIONS,
  };
}

/** Read conversation turns/history (`hNvQHb`). */
export function snippetReadConversation(
  convId: string,
  opts: { maxTurns?: number } = {},
): GeminiViaChromeSnippet {
  const cid = normalizeConvId(convId);
  const bare = cid.slice(2);
  const maxTurns = Math.min(Math.max(1, Math.floor(opts.maxTurns ?? 10)), 200);
  const args = [cid, maxTurns, null, 1, [0], [4, 12], null, 1];
  const snippet = `(async () => {${GEMINI_BATCHEXECUTE_HELPER_JS}${GEMINI_PARSE_TURNS_JS}
  const res = await callBatchExecute('hNvQHb', ${JSON.stringify(args)}, ${JSON.stringify(`/app/${bare}`)});
  if (!res.ok) return res;
  const turns = parseGeminiTurns(res.body);
  return { ...res, conversationId: ${JSON.stringify(cid)}, bareId: ${JSON.stringify(bare)}, turns };
})()`;

  return {
    snippet,
    description: `Read Gemini Web conversation ${cid} turns (hNvQHb)`,
    url: batchexecuteUrl('hNvQHb'),
    method: 'POST',
    instructions: INSTRUCTIONS,
  };
}

/** WRITE — Rename a Gemini Web conversation (`MUAZcd`). */
export function snippetRenameConversation(convId: string, title: string): GeminiViaChromeSnippet {
  const cid = normalizeConvId(convId);
  if (typeof title !== 'string' || !title.trim()) {
    throw new Error('title is required (non-empty string)');
  }
  const trimmedTitle = title.trim();
  const bare = cid.slice(2);
  return buildGeminiBatchExecuteSnippet({
    rpcId: 'MUAZcd',
    args: [null, [['title']], [cid, trimmedTitle]],
    sourcePath: `/app/${bare}`,
    description: `Rename Gemini Web conversation ${cid} to "${trimmedTitle}" (MUAZcd)`,
    write: true,
  });
}

/** WRITE (DESTRUCTIVE) — Delete a Gemini Web conversation (`GzXR5e`). */
export function snippetDeleteConversation(convId: string): GeminiViaChromeSnippet {
  const cid = normalizeConvId(convId);
  return buildGeminiBatchExecuteSnippet({
    rpcId: 'GzXR5e',
    args: [cid],
    sourcePath: '/app',
    description: `Delete Gemini Web conversation ${cid} (GzXR5e)`,
    write: true,
    destructive: true,
  });
}

/** Read feature usage / quota allowances (`MyzX6c`). */
export function snippetGetUsage(): GeminiViaChromeSnippet {
  const snippet = `(async () => {${GEMINI_BATCHEXECUTE_HELPER_JS}
  const res = await callBatchExecute('MyzX6c', [], '/app');
  if (!res.ok || !Array.isArray(res.body)) return res;
  const rows = Array.isArray(res.body[1]) ? res.body[1] : [];
  const features = rows
    .filter((r) => Array.isArray(r))
    .map((r) => ({
      featureId: r[0] ?? null,
      enabled: Boolean(r[1]),
      limit: r[2] ?? null,
      used: r[3] ?? null,
      resetAt: r[4] ?? null,
      status: r[5] ?? null,
    }));
  return { ...res, features };
})()`;

  return {
    snippet,
    description: 'Read Gemini Web feature usage and quotas (MyzX6c)',
    url: batchexecuteUrl('MyzX6c'),
    method: 'POST',
    instructions: INSTRUCTIONS,
  };
}

/** Read signed-in user profile (`o30O0e`). */
export function snippetUserProfile(): GeminiViaChromeSnippet {
  return buildGeminiBatchExecuteSnippet({
    rpcId: 'o30O0e',
    args: [['me'], [[['person.photo', 'person.name', 'person.email']], null, [1, 7]]],
    description: 'Read Gemini Web user profile (o30O0e)',
  });
}

/** List custom Gems / assistants (`Ub3MPb`). */
export function snippetListGems(): GeminiViaChromeSnippet {
  return buildGeminiBatchExecuteSnippet({
    rpcId: 'Ub3MPb',
    args: [],
    description: 'List Gemini Web custom Gems (Ub3MPb)',
  });
}

/** Read saved info / memory configuration (`VVSn5c`). */
export function snippetSavedInfo(): GeminiViaChromeSnippet {
  return buildGeminiBatchExecuteSnippet({
    rpcId: 'VVSn5c',
    args: [],
    description: 'Read Gemini Web saved info / memory entries (VVSn5c)',
  });
}

/** List scheduled actions / tasks (`I4z33b`). */
export function snippetScheduledTasks(): GeminiViaChromeSnippet {
  return buildGeminiBatchExecuteSnippet({
    rpcId: 'I4z33b',
    args: [],
    description: 'List Gemini Web scheduled tasks (I4z33b)',
  });
}

/** Read extensions / integrations config (`cCSu7`). */
export function snippetExtensions(): GeminiViaChromeSnippet {
  return buildGeminiBatchExecuteSnippet({
    rpcId: 'cCSu7',
    args: [],
    description: 'Read Gemini Web extensions / integrations config (cCSu7)',
  });
}

/** List notebooks / library metadata (`xsWV3`). */
export function snippetNotebooks(): GeminiViaChromeSnippet {
  return buildGeminiBatchExecuteSnippet({
    rpcId: 'xsWV3',
    args: [],
    description: 'Read Gemini Web notebooks / library metadata (xsWV3)',
  });
}

/** Read subscription / upgrade banner state (`sJBwce`). */
export function snippetSubscriptionBanner(): GeminiViaChromeSnippet {
  return buildGeminiBatchExecuteSnippet({
    rpcId: 'sJBwce',
    args: [[1, 2, 10, 11, 12, 13], [1]],
    description: 'Read Gemini Web subscription / upgrade banner state (sJBwce)',
  });
}

/** Read turn / response metadata (`PCck7e`). */
export function snippetTurnMetadata(responseId: string): GeminiViaChromeSnippet {
  const rid = normalizeRespId(responseId);
  return buildGeminiBatchExecuteSnippet({
    rpcId: 'PCck7e',
    args: [rid],
    description: `Read Gemini Web metadata for response ${rid} (PCck7e)`,
  });
}

/**
 * Identify the logged-in Google account in the active tab using
 * `WIZ_global_data.oPEP7c` + `o30O0e` so callers can match email -> Chrome profile.
 */
export function snippetIdentify(): GeminiViaChromeSnippet {
  const snippet = `(async () => {${GEMINI_BATCHEXECUTE_HELPER_JS}
  if (location.hostname !== 'gemini.google.com') {
    return { ok: false, reason: 'wrong_tab', pageUrl: location.href };
  }
  const wiz = (typeof window !== 'undefined' && window.WIZ_global_data) || null;
  if (!wiz || !wiz.SNlM0e) {
    return { ok: false, reason: 'not_logged_in', pageUrl: location.href };
  }
  const profile = await callBatchExecute('o30O0e', [['me'], [[['person.photo', 'person.name', 'person.email']], null, [1, 7]]], '/app');
  return {
    ok: true,
    email: typeof wiz.oPEP7c === 'string' ? wiz.oPEP7c : null,
    authUser: wiz.QrtxK !== undefined ? String(wiz.QrtxK) : null,
    profile: profile.ok ? profile.body : null,
  };
})()`;

  return {
    snippet,
    description: 'Identify the logged-in Google account in the active Gemini Web tab',
    url: batchexecuteUrl('o30O0e'),
    method: 'POST',
    instructions: INSTRUCTIONS,
  };
}

/**
 * WRITE snippet — send a prompt inside the authenticated `gemini.google.com` tab
 * by driving the SPA's own input box + Send button (so Chrome executes
 * `SAPISIDHASH`, `X-Server-Token`, and WAA attestation natively), polling until
 * the response finishes, and reading the completed turn via `hNvQHb`.
 *
 * If `opts.convId` is specified, the tab must already be on `/app/<bareId>`;
 * otherwise the snippet returns `{ ok: false, error: 'wrong_conversation', expectedUrl }`
 * without altering the current chat.
 */
export function snippetSendMessage(
  prompt: string,
  opts: {
    convId?: string;
    tool?: string;
    timeoutMs?: number;
    showOverlay?: boolean;
  } = {},
): GeminiViaChromeSnippet {
  if (typeof prompt !== 'string' || !prompt.trim()) {
    throw new Error('prompt is required (non-empty string)');
  }
  const cid = opts.convId ? normalizeConvId(opts.convId) : null;
  const expectedBare = cid ? cid.slice(2) : null;
  const toolLabel = opts.tool ? resolveGeminiToolLabel(opts.tool) : null;
  const timeoutMs =
    typeof opts.timeoutMs === 'number' && Number.isFinite(opts.timeoutMs)
      ? Math.min(Math.max(5000, Math.floor(opts.timeoutMs)), 300_000)
      : (toolLabel === 'Create video' ? 180_000 : 120_000);
  const ov = buildOverlayHelpers(!!opts.showOverlay);

  const snippet = `(async () => {${GEMINI_BATCHEXECUTE_HELPER_JS}${GEMINI_PARSE_TURNS_JS}${GEMINI_EXTRACT_ATTACHMENTS_JS}${GEMINI_SELECT_TOOL_JS}${GEMINI_SUBMIT_PROMPT_JS}
  if (location.hostname !== 'gemini.google.com') {
    return {
      ok: false,
      error: 'wrong_tab',
      reason: 'wrong_tab',
      pageUrl: location.href,
      hint: 'Open https://gemini.google.com/app in this tab before sending a prompt.',
    };
  }
  const wiz = (typeof window !== 'undefined' && window.WIZ_global_data) || null;
  if (!wiz || !wiz.SNlM0e || !wiz.cfb2h || !wiz.FdrFJe) {
    return {
      ok: false,
      error: 'not_logged_in',
      reason: 'not_logged_in',
      pageUrl: location.href,
      hint: 'WIZ_global_data session tokens missing — sign in to https://gemini.google.com/app first.',
    };
  }
  const expectedBare = ${JSON.stringify(expectedBare)};
  const readBareFromPath = () => {
    const m = location.pathname.match(/\\/app\\/([a-f0-9]{8,32})/i);
    return m ? m[1].toLowerCase() : null;
  };
  const initialBare = readBareFromPath();
  if (expectedBare && initialBare !== expectedBare) {
    return {
      ok: false,
      error: 'wrong_conversation',
      expectedUrl: 'https://gemini.google.com/app/' + expectedBare,
      currentUrl: location.href,
      hint: 'Navigate the tab to expectedUrl first, then re-run this snippet.',
    };
  }

  let toolSelect = null;
  const wantTool = ${JSON.stringify(toolLabel)};
  if (wantTool) {
    toolSelect = await selectGeminiTool(wantTool);
    if (!toolSelect.ok) return { ...toolSelect, stage: 'select_tool' };
  }

  ${ov.setup}
  const result = await submitAndPollGeminiPrompt(${JSON.stringify(prompt)}, ${timeoutMs}, {
    onSubmit: () => { ${ov.status('Submitting prompt in Gemini SPA…')} },
    onWait: () => { ${ov.status('Waiting for Gemini response…')} },
    onError: (msg) => { ${ov.statusRaw('msg', 'err')}${ov.abort} },
    onDone: () => { ${ov.status('Done.', 'ok')}${ov.finish} },
  });
  return toolSelect ? { ...result, toolSelect } : result;
})()`;

  return {
    snippet,
    description: cid
      ? `Send prompt to Gemini Web conversation ${cid} via SPA UI + read back hNvQHb (WRITE)`
      : 'Send prompt in active Gemini Web tab via SPA UI + read back hNvQHb (WRITE)',
    url: expectedBare
      ? `https://gemini.google.com/app/${expectedBare}`
      : 'https://gemini.google.com/app',
    method: 'POST',
    instructions:
      INSTRUCTIONS +
      ' WRITE — drives the Gemini Web SPA UI (so Chrome handles SAPISIDHASH + WAA attestation natively), creates real conversation history, and returns the completed turn.',
  };
}

function buildOverlayHelpers(showOverlay: boolean) {
  const setup = showOverlay
    ? `
  var __lmaBanner = window.__lmAssistBanners && window.__lmAssistBanners['lm-assist-gemini-idle'];
  var __lmaPreExistingOverlay = !!(
    (window.__lmAssistViaOverlay && window.__lmAssistViaOverlay.setStatus) ||
    (__lmaBanner && __lmaBanner.setStatus)
  );
  (function installOverlay() {
    if (window.__lmAssistViaOverlay && window.__lmAssistViaOverlay.setStatus) {
      window.__lmAssistViaOverlay.setStatus('Sending prompt to Gemini…');
      return;
    }
    if (__lmaBanner && __lmaBanner.setStatus) {
      __lmaBanner.setStatus('Sending prompt to Gemini…');
      return;
    }
    var prev = document.getElementById('__lm-assist-via-overlay');
    if (prev) prev.remove();
    var el = document.createElement('div');
    el.id = '__lm-assist-via-overlay';
    var styleEl = document.createElement('style');
    styleEl.textContent = ''
      + '#__lm-assist-via-overlay { position: fixed; top: 0; left: 0; right: 0; z-index: 2147483647;'
      + ' background: #1a1d29; color: #f8f9fb; padding: 10px 44px 10px 18px;'
      + ' font-family: ui-sans-serif, system-ui, -apple-system, sans-serif; font-size: 13px;'
      + ' line-height: 1.5; border-bottom: 2px solid #60a5fa; box-shadow: 0 4px 14px rgba(0,0,0,.35); }'
      + '#__lm-assist-via-overlay strong { color: #60a5fa; font-size: 14px; }'
      + '#__lm-assist-via-overlay p { margin: 2px 0; }'
      + '#__lm-assist-via-overlay .lm-small { color: #b8bcc7; font-size: 11.5px; }'
      + '#__lm-assist-via-overlay .lm-close { position: absolute; top: 6px; right: 12px;'
      + ' background: none; border: none; color: #f8f9fb; cursor: pointer; font-size: 18px; opacity: .7; }'
      + '#__lm-assist-via-overlay .lm-close:hover { opacity: 1; }'
      + '#__lm-assist-via-overlay .lm-ok { color: #4ade80; }'
      + '#__lm-assist-via-overlay .lm-err { color: #f87171; }';
    el.appendChild(styleEl);

    var btnClose = document.createElement('button');
    btnClose.className = 'lm-close';
    btnClose.textContent = '\\u00d7';
    btnClose.title = 'Dismiss banner (does NOT cancel the in-progress request)';
    btnClose.addEventListener('click', function() { if (window.__lmAssistViaOverlay) window.__lmAssistViaOverlay.tearDown(); });
    el.appendChild(btnClose);

    var title = document.createElement('strong');
    title.textContent = 'lm-assist · running Gemini Web prompt in this tab';
    el.appendChild(title);

    var statusP = document.createElement('p');
    statusP.id = '__lm-assist-via-status';
    statusP.textContent = 'Sending prompt to Gemini…';
    el.appendChild(statusP);

    var noteP = document.createElement('p');
    noteP.className = 'lm-small';
    noteP.textContent = "A Gemini prompt is running in this tab. Please don't navigate away or close this tab until it finishes.";
    el.appendChild(noteP);

    (document.body || document.documentElement).appendChild(el);

    function setStatus(text, kind) {
      var p = document.getElementById('__lm-assist-via-status');
      if (!p) return;
      p.textContent = text;
      p.className = kind === 'ok' ? 'lm-ok' : (kind === 'err' ? 'lm-err' : '');
    }
    function beforeUnloadHandler(e) {
      e.preventDefault();
      e.returnValue = 'lm-assist is still running a Gemini request in this tab.';
      return e.returnValue;
    }
    function clickGuard(e) {
      var a = e.target && e.target.closest && e.target.closest('a[href]');
      if (!a) return;
      try {
        var u = new URL(a.href, location.href);
        if (u.host !== location.host && !/(^|\\.)google\\.com$/i.test(u.host)) {
          e.preventDefault();
          e.stopPropagation();
          setStatus('Blocked navigation to ' + u.host + ' — lm-assist run in progress.', 'err');
        }
      } catch (_e) {}
    }
    window.addEventListener('beforeunload', beforeUnloadHandler);
    document.addEventListener('click', clickGuard, true);

    function tearDown() {
      window.removeEventListener('beforeunload', beforeUnloadHandler);
      document.removeEventListener('click', clickGuard, true);
      try { mo.disconnect(); } catch (_e) {}
      var n = document.getElementById('__lm-assist-via-overlay');
      if (n) n.remove();
      delete window.__lmAssistViaOverlay;
    }

    var mo = new MutationObserver(function() {
      if (!document.getElementById('__lm-assist-via-overlay')) {
        try { mo.disconnect(); } catch (_e) {}
        installOverlay();
      }
    });
    mo.observe(document.documentElement, { childList: true, subtree: true });

    window.__lmAssistViaOverlay = { setStatus: setStatus, tearDown: tearDown };
  })();`
    : '';

  const statusRaw = (expr: string, kind?: 'ok' | 'err') =>
    showOverlay
      ? `try {
    if (window.__lmAssistViaOverlay && window.__lmAssistViaOverlay.setStatus) window.__lmAssistViaOverlay.setStatus(${expr}${kind ? ', ' + JSON.stringify(kind) : ''});
    else if (window.__lmAssistBanners && window.__lmAssistBanners['lm-assist-gemini-idle']) window.__lmAssistBanners['lm-assist-gemini-idle'].setStatus(${expr}${kind ? ', ' + JSON.stringify(kind) : ''});
  } catch (_e) {}`
      : '';

  const status = (text: string, kind?: 'ok' | 'err') => statusRaw(JSON.stringify(text), kind);

  const finish = showOverlay
    ? `try {
    if (!__lmaPreExistingOverlay) {
      setTimeout(() => { try { window.__lmAssistViaOverlay && window.__lmAssistViaOverlay.tearDown(); } catch (_e) {} }, 2500);
    } else if (window.__lmAssistViaOverlay && window.__lmAssistViaOverlay.setStatus) {
      window.__lmAssistViaOverlay.setStatus('Idle. Waiting for next lm-assist request.', 'ok');
    } else if (window.__lmAssistBanners && window.__lmAssistBanners['lm-assist-gemini-idle']) {
      window.__lmAssistBanners['lm-assist-gemini-idle'].setStatus('Idle. Waiting for next lm-assist request.', 'ok');
    }
  } catch (_e) {}`
    : '';

  const abort = showOverlay
    ? `try {
    if (!__lmaPreExistingOverlay) { window.__lmAssistViaOverlay && window.__lmAssistViaOverlay.tearDown(); }
    else if (window.__lmAssistViaOverlay && window.__lmAssistViaOverlay.setStatus) { window.__lmAssistViaOverlay.setStatus('Idle. Waiting for next lm-assist request.', 'ok'); }
    else if (window.__lmAssistBanners && window.__lmAssistBanners['lm-assist-gemini-idle']) { window.__lmAssistBanners['lm-assist-gemini-idle'].setStatus('Idle. Waiting for next lm-assist request.', 'ok'); }
  } catch (_e) {}`
    : '';

  return { setup, status, statusRaw, finish, abort };
}

const GEMINI_EXTRACT_ATTACHMENTS_JS = `
  function extractGeminiAttachments(body) {
    const seen = new Set();
    const attachments = [];
    const URL_RE = /https:\\/\\/(?:contribution\\.usercontent\\.google\\.com\\/download\\?[^\\s"'<>]+|lh3\\.googleusercontent\\.com\\/(?:rd-)?gg\\/[^\\s"'<>]+)/gi;
    const walk = (node) => {
      if (typeof node === 'string') {
        const matches = node.match(URL_RE);
        if (matches) {
          for (const u of matches) {
            if (seen.has(u)) continue;
            seen.add(u);
            let host = '';
            try { host = new URL(u).hostname; } catch {}
            attachments.push({
              url: u,
              host,
              kind: host === 'contribution.usercontent.google.com' ? 'download' : 'image_preview',
            });
          }
        }
        return;
      }
      if (Array.isArray(node)) {
        for (const item of node) walk(item);
      } else if (node && typeof node === 'object') {
        for (const k of Object.keys(node)) walk(node[k]);
      }
    };
    walk(body);
    return attachments;
  }
`;

/**
 * Resolve friendly Gemini tool aliases (`image`, `picture`, `video`, `movie`, `music`, `canvas`)
 * to the canonical menu item labels in Gemini Web's `Upload & tools` menu.
 */
export function resolveGeminiToolLabel(tool: string): string {
  if (typeof tool !== 'string' || !tool.trim()) {
    throw new Error('tool is required (non-empty string)');
  }
  const raw = tool.trim();
  const lower = raw.toLowerCase();
  if (lower === 'image' || lower === 'picture' || lower === 'images' || lower === 'create image') {
    return 'Create image';
  }
  if (lower === 'video' || lower === 'movie' || lower === 'videos' || lower === 'create video') {
    return 'Create video';
  }
  if (lower === 'music' || lower === 'audio' || lower === 'create music') {
    return 'Create music';
  }
  if (lower === 'canvas') {
    return 'Canvas';
  }
  return raw;
}

const GEMINI_SELECT_TOOL_JS = `
  async function selectGeminiTool(toolLabel) {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const btn =
      document.querySelector('button[aria-label="Upload & tools"]') ||
      document.querySelector('button[aria-label*="tools" i]');
    if (!btn) {
      return { ok: false, error: 'tools_button_not_found', message: 'Could not locate Upload & tools button.' };
    }
    if (btn.focus) btn.focus();
    btn.click();

    const itemSel = '[role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], button.mat-mdc-menu-item, .mat-mdc-menu-content button';
    let items = [];
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      items = Array.from(document.querySelectorAll(itemSel));
      if (items.length > 0) break;
      await sleep(100);
    }
    const readTxt = (el) => String((el && (el.innerText || el.textContent)) || '').trim().replace(/\\s+/g, ' ');
    const availableTools = items.map(readTxt).filter(Boolean);
    const needle = String(toolLabel || '').trim().toLowerCase();
    const target = items.find((el) => {
      const t = readTxt(el).toLowerCase();
      return t === needle || t.includes(needle);
    });
    if (!target) {
      const bd = document.querySelector('.cdk-overlay-backdrop');
      if (bd && bd.click) bd.click();
      return { ok: false, error: 'tool_not_found', requestedTool: toolLabel, availableTools };
    }
    target.click();
    await sleep(400);

    const chipSel = 'button[aria-label^="Deselect " i], input-area-v2 button.mdc-button--outlined, input-area-v2 .mat-tonal-button, [data-test-id*="chip" i]';
    const activeChips = Array.from(document.querySelectorAll(chipSel))
      .map((el) => readTxt(el) || (el.getAttribute && el.getAttribute('aria-label')) || '')
      .filter(Boolean);
    return {
      ok: true,
      selected: readTxt(target) || toolLabel,
      activeChips,
      availableTools,
    };
  }
`;

/**
 * Select a tool mode from Gemini's `Upload & tools` menu (`Create image`, `Create video`, `Create music`, `Canvas`).
 */
export function snippetSelectTool(tool: string): GeminiViaChromeSnippet {
  const toolLabel = resolveGeminiToolLabel(tool);
  const snippet = `(async () => {${GEMINI_SELECT_TOOL_JS}
  if (location.hostname !== 'gemini.google.com') {
    return { ok: false, error: 'wrong_tab', reason: 'wrong_tab', pageUrl: location.href };
  }
  return await selectGeminiTool(${JSON.stringify(toolLabel)});
})()`;

  return {
    snippet,
    description: `Select Gemini Web tool "${toolLabel}" in composer`,
    url: 'https://gemini.google.com/app',
    method: 'POST',
    instructions: INSTRUCTIONS,
  };
}

const GEMINI_SUBMIT_PROMPT_JS = `
  async function submitAndPollGeminiPrompt(promptText, timeoutMs, hooks = {}) {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const readActiveMeta = () => {
      let convId = null;
      let respId = null;
      const resps = document.querySelectorAll('model-response');
      if (resps.length) {
        const last = resps[resps.length - 1];
        const rc = last.querySelector
          ? (last.querySelector('[jslog*="BardVeMetadataKey"]') || last)
          : null;
        const jslog = rc && rc.getAttribute ? (rc.getAttribute('jslog') || '') : '';
        const jm = jslog.match(/BardVeMetadataKey:([A-Za-z0-9+/=_-]+)/);
        if (jm) {
          try {
            const b64 = jm[1].replace(/-/g, '+').replace(/_/g, '/');
            const parsed = JSON.parse(atob(b64));
            if (Array.isArray(parsed) && Array.isArray(parsed[0])) {
              if (typeof parsed[0][0] === 'string' && parsed[0][0].startsWith('r_')) respId = parsed[0][0];
              if (typeof parsed[0][1] === 'string' && parsed[0][1].startsWith('c_')) convId = parsed[0][1];
            }
          } catch {}
        }
      }
      if (!convId) {
        const pm = location.pathname.match(/\\/app\\/([a-f0-9]{8,32})/i);
        if (pm) convId = 'c_' + pm[1].toLowerCase();
      }
      return {
        convId,
        bareId: convId ? convId.slice(2) : null,
        respId,
      };
    };
    const readDomMedia = () => {
      const resps = document.querySelectorAll('model-response');
      const scope = resps.length ? resps[resps.length - 1] : null;
      if (!scope || !scope.querySelectorAll) return { imgs: [], videos: [] };
      const imgs = Array.from(scope.querySelectorAll('img'))
        .map((i) => ({ src: i.currentSrc || i.src || '', alt: i.alt || '', w: i.naturalWidth || 0, h: i.naturalHeight || 0 }))
        .filter((x) => x.src && !x.src.startsWith('data:image/svg'));
      const videos = Array.from(scope.querySelectorAll('video, video source'))
        .map((v) => ({ tag: v.tagName, src: v.currentSrc || v.src || '', poster: v.poster || '' }))
        .filter((x) => x.src);
      return { imgs, videos };
    };

    const initialMeta = readActiveMeta();
    const initialBare = initialMeta.bareId;
    const prevRespIds = new Set();
    if (initialBare) {
      const snap = await callBatchExecute('hNvQHb', ['c_' + initialBare, 10, null, 1, [0], [4, 12], null, 1], '/app/' + initialBare);
      if (snap.ok) {
        for (const t of parseGeminiTurns(snap.body)) {
          if (t && t.responseId) prevRespIds.add(t.responseId);
        }
      }
    }
    const readLastDomText = () => {
      const nodes = document.querySelectorAll('model-response, message-content.model-response-text, .model-response-text');
      if (!nodes.length) return '';
      const last = nodes[nodes.length - 1];
      return String(last.innerText || last.textContent || '').trim();
    };
    const prevDomText = readLastDomText();

    const editorSelectors = [
      'rich-textarea .ql-editor[contenteditable="true"]',
      'div.ql-editor[contenteditable="true"]',
      'div[contenteditable="true"][role="textbox"]',
      'textarea',
    ];
    let editor = null;
    for (const sel of editorSelectors) {
      const cand = document.querySelector(sel);
      if (cand) { editor = cand; break; }
    }
    if (!editor) {
      if (hooks.onError) hooks.onError('Could not locate Gemini prompt input box.');
      return { ok: false, error: 'editor_not_found', message: 'Could not locate Gemini prompt input box in DOM.' };
    }

    editor.focus();
    if (editor.tagName === 'TEXTAREA') {
      const proto = Object.getPrototypeOf(editor);
      const desc = Object.getOwnPropertyDescriptor(proto, 'value');
      if (desc && desc.set) desc.set.call(editor, promptText);
      else editor.value = promptText;
      editor.dispatchEvent(new Event('input', { bubbles: true }));
      editor.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      editor.textContent = promptText;
      try {
        editor.dispatchEvent(new InputEvent('input', { bubbles: true, data: promptText, inputType: 'insertText' }));
      } catch (_e) {
        editor.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }

    if (hooks.onSubmit) hooks.onSubmit();
    const findSendBtn = () => {
      const selectors = [
        'button.send-button:not([disabled]):not([aria-disabled="true"])',
        'button[aria-label*="Send" i]:not([disabled]):not([aria-disabled="true"])',
        'button[mattooltip*="Send" i]:not([disabled]):not([aria-disabled="true"])',
      ];
      for (const sel of selectors) {
        const btn = document.querySelector(sel);
        if (btn) return btn;
      }
      return null;
    };
    let sendBtn = null;
    const btnDeadline = Date.now() + 3000;
    while (Date.now() < btnDeadline) {
      sendBtn = findSendBtn();
      if (sendBtn) break;
      await sleep(100);
    }
    if (sendBtn) {
      sendBtn.click();
    } else {
      editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
      editor.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
    }

    if (hooks.onWait) hooks.onWait();
    const pollStart = Date.now();
    let lastDomText = '';
    let stableTicks = 0;
    let lastRpcText = '';
    let rpcStableTicks = 0;
    let pollTick = 0;
    let timedOut = true;
    let turns = [];
    let latestTurn = null;
    let attachments = [];
    let activeMeta = readActiveMeta();
    let activeBare = activeMeta.bareId;

    const pickNewTurn = (list) => {
      if (!Array.isArray(list) || !list.length) return null;
      return list.find((t) => t && t.responseId && !prevRespIds.has(t.responseId)) || null;
    };
    const hasStopBtn = () => Boolean(
      document.querySelector('button[aria-label*="Stop" i], button.stop-button, mat-icon[fonticon="stop"]')
    );
    const hasSpinner = () => Boolean(
      document.querySelector('model-response mat-progress-spinner, model-response mat-progress-bar, .generating, [aria-busy="true"]')
    );

    while (Date.now() - pollStart < timeoutMs) {
      await sleep(500);
      pollTick++;
      activeMeta = readActiveMeta();
      activeBare = activeMeta.bareId;
      const stopActive = hasStopBtn();
      const spinActive = hasSpinner();
      const domText = readLastDomText();
      const domMedia = readDomMedia();
      const hasMedia = domMedia.imgs.length > 0 || domMedia.videos.length > 0;

      if (!stopActive && !spinActive && domText && domText !== prevDomText) {
        if (domText === lastDomText) stableTicks++;
        else { lastDomText = domText; stableTicks = 0; }
      } else {
        stableTicks = 0;
        lastDomText = domText;
      }

      const shouldProbeRpc =
        !stopActive &&
        !spinActive &&
        activeBare &&
        (hasMedia || stableTicks >= 2 || (pollTick % 4 === 0 && Date.now() - pollStart >= 1500));

      if (shouldProbeRpc) {
        const res = await callBatchExecute('hNvQHb', ['c_' + activeBare, 10, null, 1, [0], [4, 12], null, 1], '/app/' + activeBare);
        if (res.ok) {
          turns = parseGeminiTurns(res.body);
          latestTurn = pickNewTurn(turns);
          attachments = extractGeminiAttachments(res.body);
          const rText = (latestTurn && typeof latestTurn.text === 'string') ? latestTurn.text : '';
          if (rText && rText === lastRpcText) rpcStableTicks++;
          else { lastRpcText = rText; rpcStableTicks = rText ? 1 : 0; }
          if (latestTurn && (hasMedia || (rText && (stableTicks >= 2 || rpcStableTicks >= 2)))) {
            timedOut = false;
            break;
          }
        }
      }

      if (!stopActive && !spinActive && (hasMedia || (stableTicks >= 3 && domText && domText !== prevDomText))) {
        timedOut = false;
        break;
      }
    }

    activeMeta = readActiveMeta();
    activeBare = activeMeta.bareId || activeBare;
    if (activeBare && (!latestTurn || !attachments.length)) {
      const finalRes = await callBatchExecute('hNvQHb', ['c_' + activeBare, 10, null, 1, [0], [4, 12], null, 1], '/app/' + activeBare);
      if (finalRes.ok) {
        turns = parseGeminiTurns(finalRes.body);
        latestTurn = pickNewTurn(turns) || (turns.length ? turns[0] : null);
        attachments = extractGeminiAttachments(finalRes.body);
      }
    }

    const domMedia = readDomMedia();
    const domFallback = readLastDomText();
    const text = (latestTurn && typeof latestTurn.text === 'string' && latestTurn.text)
      || (domFallback && domFallback !== prevDomText ? domFallback : '');
    const responseId = (latestTurn && latestTurn.responseId) || activeMeta.respId || null;
    const conversationId = activeBare ? 'c_' + activeBare : null;

    if (hooks.onDone) hooks.onDone();
    return {
      ok: !timedOut || !!text || domMedia.imgs.length > 0 || domMedia.videos.length > 0,
      conversationId,
      bareId: activeBare,
      responseId,
      text,
      turns,
      attachments,
      domMedia,
      url: location.href,
      timedOut,
    };
  }
`;

function resolveGeminiModelAliases(model: string): string[] {
  const raw = String(model || '').trim();
  const lower = raw.toLowerCase();
  if (lower === '8c46e95b1a07cecc' || lower === 'cf41b0e0dd7d53e5' || lower === 'auto') {
    return ['Auto'];
  }
  if (lower === '56fdd199312815e2' || lower === '4 hydrogen' || lower === 'hydrogen') {
    return ['4 Hydrogen', 'Hydrogen'];
  }
  if (lower === 'e6fa609c3fa255c0' || lower === '4 neon' || lower === 'neon') {
    return ['Neon', '4 Neon'];
  }
  if (lower === '95a4c0abcba24364' || lower === '4 carbon' || lower === 'carbon') {
    return ['Carbon', '4 Carbon'];
  }
  return [raw];
}

function resolveGeminiThinkingAliases(level: string | number | undefined): string[] {
  if (level === undefined || level === null || level === '') return [];
  if (level === 1 || String(level).toLowerCase() === 'low' || String(level).toLowerCase() === 'standard') {
    return ['Low', 'Standard'];
  }
  if (level === 4 || String(level).toLowerCase() === 'medium') {
    return ['Medium'];
  }
  if (level === 2 || String(level).toLowerCase() === 'high') {
    return ['High'];
  }
  return [String(level).trim()];
}

const GEMINI_SWITCH_MODEL_JS = `
  async function switchGeminiModel(modelAliases, thinkingAliases = []) {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const btnSelectors = [
      '[data-test-id="bard-mode-menu-button"]',
      'button[aria-label*="mode picker" i]',
      'button[aria-label*="model" i]',
    ];
    let modeBtn = null;
    for (const sel of btnSelectors) {
      const cand = document.querySelector(sel);
      if (cand) { modeBtn = cand; break; }
    }
    if (!modeBtn) {
      return { ok: false, error: 'mode_button_not_found', message: 'Could not locate Gemini model picker button.' };
    }
    const readLabel = (el) => String((el && (el.innerText || el.textContent)) || '').trim().replace(/\\s+/g, ' ');
    const previousModel = readLabel(modeBtn);
    const openMenu = () => {
      if (modeBtn.focus) modeBtn.focus();
      if (!modeBtn.getAttribute || modeBtn.getAttribute('aria-expanded') !== 'true') {
        modeBtn.click();
      }
    };
    openMenu();

    const itemSelector = '[role="menuitem"], [role="menuitemradio"], [role="option"], button.mat-mdc-menu-item, .mat-mdc-menu-content button';
    let items = [];
    const deadline = Date.now() + 2500;
    let retriedOpen = false;
    while (Date.now() < deadline) {
      items = Array.from(document.querySelectorAll(itemSelector));
      if (items.length > 0) break;
      if (!retriedOpen && (deadline - Date.now()) < 1800) {
        retriedOpen = true;
        openMenu();
      }
      await sleep(100);
    }
    const availableOptions = items.map((el) => readLabel(el)).filter(Boolean);
    const matchesAlias = (text, aliases) => {
      const tl = text.toLowerCase();
      return aliases.some((a) => {
        const al = a.toLowerCase();
        return tl === al || tl.startsWith(al + ' ') || tl.includes(al);
      });
    };

    const targetItem = items.find((el) => matchesAlias(readLabel(el), modelAliases));
    if (!targetItem) {
      if (modeBtn.getAttribute && modeBtn.getAttribute('aria-expanded') === 'true') {
        try { modeBtn.click(); } catch (_e) {}
      }
      return {
        ok: false,
        error: 'model_not_found',
        previousModel,
        requestedModel: modelAliases[0] || null,
        availableOptions,
      };
    }
    targetItem.click();
    await sleep(350);

    let selectedThinking = null;
    if (Array.isArray(thinkingAliases) && thinkingAliases.length) {
      let subItems = Array.from(document.querySelectorAll(itemSelector));
      if (!subItems.some((el) => matchesAlias(readLabel(el), thinkingAliases))) {
        openMenu();
        const td = Date.now() + 2000;
        while (Date.now() < td) {
          subItems = Array.from(document.querySelectorAll(itemSelector));
          if (subItems.some((el) => matchesAlias(readLabel(el), thinkingAliases))) break;
          await sleep(100);
        }
      }
      const thinkEl = subItems.find((el) => matchesAlias(readLabel(el), thinkingAliases));
      if (thinkEl) {
        selectedThinking = readLabel(thinkEl);
        thinkEl.click();
        await sleep(300);
      }
    }

    await sleep(200);
    const currentModel = readLabel(modeBtn);
    return {
      ok: true,
      previousModel,
      currentModel,
      requestedModel: modelAliases[0] || null,
      thinkingLevel: selectedThinking,
      availableOptions,
    };
  }
`;

/**
 * Switch the active Gemini Web model (and optional thinking level) via the SPA's mode picker.
 * Accepts model IDs (`56fdd199312815e2`, `e6fa609c3fa255c0`, `95a4c0abcba24364`, `8c46e95b1a07cecc`)
 * or UI names/aliases (`Auto`, `4 Hydrogen`, `Neon`, `Carbon`).
 */
export function snippetSwitchModel(
  model: string,
  opts: { thinkingLevel?: string | number } = {},
): GeminiViaChromeSnippet {
  if (typeof model !== 'string' || !model.trim()) {
    throw new Error('model is required (non-empty string)');
  }
  const aliases = resolveGeminiModelAliases(model);
  const thinkingAliases = resolveGeminiThinkingAliases(opts.thinkingLevel);

  const snippet = `(async () => {${GEMINI_SWITCH_MODEL_JS}
  if (location.hostname !== 'gemini.google.com') {
    return { ok: false, error: 'wrong_tab', reason: 'wrong_tab', pageUrl: location.href };
  }
  return await switchGeminiModel(${JSON.stringify(aliases)}, ${JSON.stringify(thinkingAliases)});
})()`;

  return {
    snippet,
    description: `Switch Gemini Web model to "${aliases[0]}"${thinkingAliases.length ? ` (thinking: ${thinkingAliases[0]})` : ''}`,
    url: 'https://gemini.google.com/app',
    method: 'POST',
    instructions: INSTRUCTIONS,
  };
}

/**
 * Reset to a fresh Gemini Web conversation (and optionally switch model and submit an initial prompt).
 * Without `opts.prompt`: prepares a clean `/app` composer (`Gemini Web mints conversationId on first prompt`).
 * With `opts.prompt`: resets to new chat, submits the prompt, polls for completion, and returns the new `conversationId` + turns.
 */
export function snippetCreateConversation(opts: {
  prompt?: string;
  model?: string;
  thinkingLevel?: string | number;
  tool?: string;
  timeoutMs?: number;
  showOverlay?: boolean;
} = {}): GeminiViaChromeSnippet {
  if (opts.prompt !== undefined && (typeof opts.prompt !== 'string' || !opts.prompt.trim())) {
    throw new Error('prompt must be a non-empty string when provided');
  }
  const hasPrompt = typeof opts.prompt === 'string' && opts.prompt.trim().length > 0;
  const modelAliases = opts.model ? resolveGeminiModelAliases(opts.model) : null;
  const thinkingAliases = resolveGeminiThinkingAliases(opts.thinkingLevel);
  const toolLabel = opts.tool ? resolveGeminiToolLabel(opts.tool) : null;
  const timeoutMs =
    typeof opts.timeoutMs === 'number' && Number.isFinite(opts.timeoutMs)
      ? Math.min(Math.max(5000, Math.floor(opts.timeoutMs)), 300_000)
      : (toolLabel === 'Create video' ? 180_000 : 120_000);
  const ov = buildOverlayHelpers(hasPrompt && !!opts.showOverlay);

  const snippet = `(async () => {${GEMINI_BATCHEXECUTE_HELPER_JS}${GEMINI_PARSE_TURNS_JS}${GEMINI_EXTRACT_ATTACHMENTS_JS}${GEMINI_SWITCH_MODEL_JS}${GEMINI_SELECT_TOOL_JS}${GEMINI_SUBMIT_PROMPT_JS}
  if (location.hostname !== 'gemini.google.com') {
    return { ok: false, error: 'wrong_tab', reason: 'wrong_tab', pageUrl: location.href };
  }
  const wiz = (typeof window !== 'undefined' && window.WIZ_global_data) || null;
  if (!wiz || !wiz.SNlM0e || !wiz.cfb2h || !wiz.FdrFJe) {
    return { ok: false, error: 'not_logged_in', reason: 'not_logged_in', pageUrl: location.href };
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const isConvPath = () => /\\/app\\/[a-f0-9]{8,32}/i.test(location.pathname);

  if (isConvPath()) {
    const newChatSelectors = [
      '[data-test-id="new-chat-button"] button',
      '[data-test-id="new-chat-button"] a',
      '[data-test-id="new-chat-button"]',
      'a[data-test-id="side-nav-sparkle-button"]',
      'button[aria-label*="New chat" i]',
      'a[aria-label*="New chat" i]',
    ];
    let ncBtn = null;
    for (const sel of newChatSelectors) {
      const cand = document.querySelector(sel);
      if (cand) { ncBtn = cand; break; }
    }
    if (!ncBtn) {
      return { ok: false, error: 'new_chat_button_not_found', message: 'Could not locate New Chat control in Gemini UI.' };
    }
    ncBtn.click();
    const resetDeadline = Date.now() + 4000;
    while (Date.now() < resetDeadline) {
      if (!isConvPath()) break;
      await sleep(100);
    }
    await sleep(250);
  }

  let modelSwitch = null;
  const wantModel = ${JSON.stringify(modelAliases)};
  const wantThinking = ${JSON.stringify(thinkingAliases)};
  if (wantModel) {
    modelSwitch = await switchGeminiModel(wantModel, wantThinking);
    if (!modelSwitch.ok) return { ...modelSwitch, stage: 'switch_model' };
  }

  let toolSelect = null;
  const wantTool = ${JSON.stringify(toolLabel)};
  if (wantTool) {
    toolSelect = await selectGeminiTool(wantTool);
    if (!toolSelect.ok) return { ...toolSelect, stage: 'select_tool' };
  }

  const promptToSend = ${JSON.stringify(hasPrompt ? opts.prompt : null)};
  if (!promptToSend) {
    return {
      ok: true,
      ready: true,
      url: location.href,
      ...(modelSwitch ? { modelSwitch } : {}),
      ...(toolSelect ? { toolSelect } : {}),
      note: 'Gemini Web mints conversationId on first prompt.',
    };
  }

  ${ov.setup}
  const res = await submitAndPollGeminiPrompt(promptToSend, ${timeoutMs}, {
    onSubmit: () => { ${ov.status('Submitting initial prompt in new Gemini chat…')} },
    onWait: () => { ${ov.status('Waiting for Gemini response…')} },
    onError: (msg) => { ${ov.statusRaw('msg', 'err')}${ov.abort} },
    onDone: () => { ${ov.status('Done.', 'ok')}${ov.finish} },
  });
  return {
    ...res,
    ...(modelSwitch ? { modelSwitch } : {}),
    ...(toolSelect ? { toolSelect } : {}),
  };
})()`;

  return {
    snippet,
    description: hasPrompt
      ? 'Create a new Gemini Web conversation and send the initial prompt (WRITE)'
      : 'Reset Gemini Web tab to a fresh new-chat composer',
    url: 'https://gemini.google.com/app',
    method: 'POST',
    instructions:
      INSTRUCTIONS +
      (hasPrompt
        ? ' WRITE — opens a new chat, submits the prompt, and returns the minted conversationId + response.'
        : ' Resets the tab to a new chat; pass `prompt` to mint a conversationId immediately.'),
  };
}

const MAX_GEMINI_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const MAX_GEMINI_DOWNLOAD_BYTES = 20 * 1024 * 1024;

function guessMimeType(filename: string): string {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.gif')) return 'image/gif';
  if (lower.endsWith('.pdf')) return 'application/pdf';
  if (lower.endsWith('.txt') || lower.endsWith('.log')) return 'text/plain';
  if (lower.endsWith('.md')) return 'text/markdown';
  if (lower.endsWith('.json')) return 'application/json';
  if (lower.endsWith('.csv')) return 'text/csv';
  return 'application/octet-stream';
}

/**
 * WRITE snippet — attach a local file (supplied as base64) to the active Gemini Web composer
 * via clipboard paste / drag-drop / hidden `<input type="file">` so Chrome runs Scotty upload
 * (`push.clients6.google.com/upload/`) + `ProcessFile` natively.
 */
export function snippetUploadAttachment(opts: {
  filename: string;
  contentBase64: string;
  mimeType?: string;
}): GeminiViaChromeSnippet {
  if (typeof opts.filename !== 'string' || !opts.filename.trim()) {
    throw new Error('filename is required');
  }
  if (typeof opts.contentBase64 !== 'string' || !opts.contentBase64.trim()) {
    throw new Error('contentBase64 is required');
  }
  const approxBytes = Math.floor((opts.contentBase64.length * 3) / 4);
  if (approxBytes > MAX_GEMINI_ATTACHMENT_BYTES) {
    throw new Error(
      `Attachment is ~${approxBytes} bytes; max supported snippet upload is ${MAX_GEMINI_ATTACHMENT_BYTES} bytes (25 MiB).`,
    );
  }
  const filename = opts.filename.trim();
  const mimeType = (opts.mimeType && opts.mimeType.trim()) || guessMimeType(filename);

  const snippet = `(async () => {
  if (location.hostname !== 'gemini.google.com') {
    return { ok: false, error: 'wrong_tab', reason: 'wrong_tab', pageUrl: location.href };
  }
  const wiz = (typeof window !== 'undefined' && window.WIZ_global_data) || null;
  if (!wiz || !wiz.SNlM0e) {
    return { ok: false, error: 'not_logged_in', reason: 'not_logged_in', pageUrl: location.href };
  }
  const bin = atob(${JSON.stringify(opts.contentBase64)});
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const file = new File([bytes], ${JSON.stringify(filename)}, { type: ${JSON.stringify(mimeType)} });
  const dt = new DataTransfer();
  dt.items.add(file);

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const previewSel = '[data-test-id*="file" i], [data-test-id*="attachment" i], uploader-file-preview, .file-preview, img[src^="blob:"]';
  const countPreviews = () => document.querySelectorAll(previewSel).length;
  const beforeCount = countPreviews();

  const editorSelectors = [
    'rich-textarea .ql-editor[contenteditable="true"]',
    'div.ql-editor[contenteditable="true"]',
    'div[contenteditable="true"][role="textbox"]',
    'textarea',
  ];
  let editor = null;
  for (const sel of editorSelectors) {
    const cand = document.querySelector(sel);
    if (cand) { editor = cand; break; }
  }

  let method = null;
  const waitForPreview = async (ms) => {
    const d = Date.now() + ms;
    while (Date.now() < d) {
      if (countPreviews() > beforeCount) return true;
      await sleep(100);
    }
    return false;
  };

  if (editor && typeof ClipboardEvent !== 'undefined') {
    editor.focus();
    try {
      const pasteEv = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt });
      editor.dispatchEvent(pasteEv);
      if (await waitForPreview(1000)) method = 'paste';
    } catch (_e) {}
  }

  if (!method && typeof DragEvent !== 'undefined') {
    const dropTarget = document.querySelector('rich-textarea, input-area-v2, .input-area') || editor;
    if (dropTarget) {
      try {
        dropTarget.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: dt }));
        dropTarget.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
        dropTarget.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
        if (await waitForPreview(1000)) method = 'drop';
      } catch (_e) {}
    }
  }

  if (!method) {
    let input = document.querySelector('input[type="file"]');
    if (!input) {
      const upBtn = document.querySelector('button[aria-label*="Upload" i]');
      if (upBtn) {
        upBtn.click();
        const d = Date.now() + 1000;
        while (Date.now() < d) {
          input = document.querySelector('input[type="file"]');
          if (input) break;
          await sleep(100);
        }
      }
    }
    if (input) {
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await waitForPreview(1500);
      method = 'file_input';
    }
  }

  if (!method) {
    return { ok: false, error: 'upload_control_not_found', message: 'Could not attach file via paste, drop, or file input.' };
  }

  // Wait up to 12s for any upload spinner inside the composer to finish.
  const spinDeadline = Date.now() + 12000;
  while (Date.now() < spinDeadline) {
    const busy = document.querySelector('input-area-v2 mat-progress-spinner, uploader-file-preview mat-progress-spinner, [aria-busy="true"]');
    if (!busy) break;
    await sleep(250);
  }

  return {
    ok: true,
    filename: ${JSON.stringify(filename)},
    size: bytes.length,
    mimeType: ${JSON.stringify(mimeType)},
    method,
    previewCount: countPreviews(),
  };
})()`;

  return {
    snippet,
    description: `Attach "${filename}" (${mimeType}) into the active Gemini Web composer (WRITE)`,
    url: 'https://gemini.google.com/app',
    method: 'POST',
    instructions: INSTRUCTIONS + ' WRITE — attaches a file to the active Gemini composer so Chrome handles Scotty upload + ProcessFile natively.',
  };
}

/**
 * Same-origin `ProcessFile` RPC helper (`POST /_/BardChatUi/data/assistant.lamda.BardFrontendService/ProcessFile`).
 * Registers a Scotty `/contrib_service/ttl_1d/<blob_id>` blob and returns `processedFileUuid`.
 */
export function snippetProcessFile(opts: {
  blobPath: string;
  filename: string;
  mimeType: string;
}): GeminiViaChromeSnippet {
  if (typeof opts.blobPath !== 'string' || !opts.blobPath.startsWith('/contrib_service/')) {
    throw new Error('Invalid blobPath: must start with /contrib_service/');
  }
  if (typeof opts.filename !== 'string' || !opts.filename.trim()) {
    throw new Error('filename is required');
  }
  if (typeof opts.mimeType !== 'string' || !opts.mimeType.trim()) {
    throw new Error('mimeType is required');
  }

  const innerPayload = JSON.stringify([
    [[opts.blobPath, null, 1, opts.mimeType.trim()], opts.filename.trim(), null, null, null, null, null, null, [0]],
    null,
    1,
    ['en'],
  ]);
  const fReq = JSON.stringify([null, innerPayload]);

  const snippet = `(async () => {
  if (location.hostname !== 'gemini.google.com') {
    return { ok: false, error: 'wrong_tab', reason: 'wrong_tab', pageUrl: location.href };
  }
  const wiz = (typeof window !== 'undefined' && window.WIZ_global_data) || null;
  if (!wiz || !wiz.SNlM0e || !wiz.cfb2h || !wiz.FdrFJe) {
    return { ok: false, error: 'not_logged_in', reason: 'not_logged_in', pageUrl: location.href };
  }
  const prefix = String(wiz.eptZe || '/_/BardChatUi/').replace(/\\/?$/, '/');
  const qs = new URLSearchParams({
    bl: String(wiz.cfb2h),
    'f.sid': String(wiz.FdrFJe),
    hl: 'en',
    _reqid: String(Math.floor(100000 + Math.random() * 899999)),
    rt: 'c',
  });
  const url = prefix + 'data/assistant.lamda.BardFrontendService/ProcessFile?' + qs.toString();
  const form = new URLSearchParams({
    'f.req': ${JSON.stringify(fReq)},
    at: String(wiz.SNlM0e),
  });
  let r;
  try {
    r = await fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8' },
      body: form.toString() + '&',
    });
  } catch (e) {
    return { ok: false, error: 'fetch_failed', reason: 'network_error', url, message: String((e && e.message) || e) };
  }
  const rawText = await r.text();
  if (!r.ok) {
    return { ok: false, error: 'http_error', status: r.status, statusText: r.statusText, url, body: rawText };
  }
  let body = null;
  for (const line of rawText.replace(/^\\)\\]\\}'\\s*/, '').split('\\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('[')) continue;
    let envelope;
    try { envelope = JSON.parse(trimmed); } catch { continue; }
    if (!Array.isArray(envelope)) continue;
    const hit = envelope.find((x) => Array.isArray(x) && x[0] === 'wrb.fr');
    if (hit) {
      if (typeof hit[2] === 'string') {
        try { body = JSON.parse(hit[2]); } catch { body = hit[2]; }
      } else {
        body = hit[2] ?? null;
      }
      break;
    }
  }
  const processedFileUuid =
    Array.isArray(body) && Array.isArray(body[3]) && typeof body[3][0] === 'string'
      ? body[3][0]
      : null;
  return { ok: true, status: r.status, url, body, processedFileUuid };
})()`;

  return {
    snippet,
    description: `Register Scotty blob ${opts.blobPath} via ProcessFile`,
    url: 'https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/ProcessFile',
    method: 'POST',
    instructions: INSTRUCTIONS,
  };
}

/**
 * List downloadable attachment and generated-media URLs referenced inside a conversation (`hNvQHb`).
 */
export function snippetListAttachments(
  convId: string,
  opts: { maxTurns?: number } = {},
): GeminiViaChromeSnippet {
  const cid = normalizeConvId(convId);
  const bare = cid.slice(2);
  const maxTurns = Math.min(Math.max(1, Math.floor(opts.maxTurns ?? 20)), 200);
  const args = [cid, maxTurns, null, 1, [0], [4, 12], null, 1];

  const snippet = `(async () => {${GEMINI_BATCHEXECUTE_HELPER_JS}${GEMINI_EXTRACT_ATTACHMENTS_JS}
  const res = await callBatchExecute('hNvQHb', ${JSON.stringify(args)}, ${JSON.stringify(`/app/${bare}`)});
  if (!res.ok) return res;
  const attachments = extractGeminiAttachments(res.body);
  return { ...res, conversationId: ${JSON.stringify(cid)}, bareId: ${JSON.stringify(bare)}, attachments };
})()`;

  return {
    snippet,
    description: `List downloadable attachment & media URLs in Gemini conversation ${cid} (hNvQHb)`,
    url: batchexecuteUrl('hNvQHb'),
    method: 'POST',
    instructions: INSTRUCTIONS,
  };
}

const ALLOWED_DOWNLOAD_HOSTS = new Set([
  'contribution.usercontent.google.com',
  'lh3.googleusercontent.com',
  'gemini.google.com',
]);

/**
 * Download an attachment or generated media asset inside the authenticated Gemini tab
 * and return it as base64. Only Google attachment/CDN hosts are permitted.
 */
export function snippetDownloadAttachment(url: string): GeminiViaChromeSnippet {
  if (typeof url !== 'string' || !url.trim()) {
    throw new Error('url is required');
  }
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    throw new Error(`Invalid attachment URL: ${url}`);
  }
  if (parsed.protocol !== 'https:' || !ALLOWED_DOWNLOAD_HOSTS.has(parsed.hostname.toLowerCase())) {
    throw new Error(
      `Disallowed attachment host: ${parsed.hostname} (allowed: ${Array.from(ALLOWED_DOWNLOAD_HOSTS).join(', ')})`,
    );
  }
  const cleanUrl = parsed.toString();

  const snippet = `(async () => {
  if (location.hostname !== 'gemini.google.com') {
    return { ok: false, error: 'wrong_tab', reason: 'wrong_tab', pageUrl: location.href };
  }
  const targetUrl = ${JSON.stringify(cleanUrl)};
  let r;
  try {
    r = await fetch(targetUrl, { credentials: 'include' });
  } catch (e) {
    return { ok: false, error: 'fetch_failed', reason: 'network_error', url: targetUrl, message: String((e && e.message) || e) };
  }
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    return { ok: false, error: 'http_error', status: r.status, statusText: r.statusText, url: targetUrl, body };
  }
  const bytes = new Uint8Array(await r.arrayBuffer());
  if (bytes.length > ${MAX_GEMINI_DOWNLOAD_BYTES}) {
    return { ok: false, error: 'too_large', size: bytes.length, maxBytes: ${MAX_GEMINI_DOWNLOAD_BYTES}, url: targetUrl };
  }
  const CHUNK = 0x8000;
  let bin = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)));
  }
  const cd = r.headers.get('content-disposition') || '';
  const m = cd.match(/filename\\*?=(?:UTF-8''|")?([^";]+)/i);
  let filename = null;
  if (m && m[1]) {
    try { filename = decodeURIComponent(m[1].replace(/"$/, '')); }
    catch { filename = m[1].replace(/"$/, ''); }
  }
  return {
    ok: true,
    status: r.status,
    statusText: r.statusText,
    url: targetUrl,
    contentType: r.headers.get('content-type') || 'application/octet-stream',
    filename,
    size: bytes.length,
    base64: btoa(bin),
  };
})()`;

  return {
    snippet,
    description: `Download Gemini attachment/media from ${parsed.hostname} (base64)`,
    url: cleanUrl,
    method: 'GET',
    instructions: INSTRUCTIONS,
  };
}

