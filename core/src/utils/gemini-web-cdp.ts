/**
 * Core-side trusted CDP prompt execution for Gemini Web (`https://gemini.google.com/`).
 *
 * Live profiling showed that Gemini Web ignores synthetic DOM `.click()` and
 * `KeyboardEvent` (`isTrusted: false`) when submitting prompts, and keeps `location.href`
 * on `/app` briefly on new chats while embedding `[respId, convId]` in
 * `<response-container jslog="...BardVeMetadataKey:<b64>...">`.
 *
 * This helper executes trusted `Page.bringToFront` + `Input.dispatchKeyEvent` (`Enter`)
 * over CDP, polls for text or generated image/video media completion, and reads back
 * the completed turn + attachments via `hNvQHb`.
 */

import {
  CDPSession,
  evalInTab,
  listTargets,
  navigateTab,
} from './browser-control';
import { DEFAULT_GEMINI_CDP_PORT, geminiWebLoginStatus } from './gemini-web-login';
import {
  normalizeConvId,
  resolveGeminiToolLabel,
  snippetDeleteConversation,
  snippetGetUsage,
  snippetListAttachments,
  snippetListConversations,
  snippetListModels,
  snippetReadConversation,
  snippetSelectTool,
  snippetSwitchModel,
} from './gemini-web-via-chrome';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface GeminiCdpSendOptions {
  port?: number;
  convId?: string;
  createNew?: boolean;
  prompt: string;
  model?: string;
  thinkingLevel?: string | number;
  tool?: string;
  timeoutMs?: number;
}

export interface GeminiCdpSendResult {
  ok: true;
  conversationId: string | null;
  bareId: string | null;
  responseId: string | null;
  text: string;
  turns: unknown[];
  attachments: unknown[];
  domMedia: {
    imgs: Array<{ src: string; alt: string; w: number; h: number }>;
    videos: Array<{ tag: string; src: string; poster: string }>;
  };
  modelSwitch: unknown;
  toolSelect: unknown;
  url: string;
  timedOut: boolean;
}

export interface GeminiCdpSendError {
  ok: false;
  code: string;
  message: string;
  data?: unknown;
}

async function waitForGeminiReady(port: number, tabId: string, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await evalInTab(port, tabId, {
      expression: `(() => {
        const wiz = window.WIZ_global_data;
        const ed = document.querySelector('rich-textarea .ql-editor[contenteditable="true"], div[contenteditable="true"][role="textbox"], textarea');
        return Boolean(wiz && wiz.SNlM0e && ed);
      })()`,
      timeoutMs: 3000,
    });
    if (r.ok && r.result === true) return true;
    await sleep(300);
  }
  return false;
}

/**
 * Send a prompt inside the authenticated `gemini.google.com` tab on `opts.port`
 * using trusted CDP keyboard input (`Enter`) and wait for text or generated media.
 */
export async function geminiWebCdpSend(
  opts: GeminiCdpSendOptions,
): Promise<GeminiCdpSendResult | GeminiCdpSendError> {
  if (typeof opts.prompt !== 'string' || !opts.prompt.trim()) {
    return { ok: false, code: 'MISSING_PROMPT', message: 'prompt is required (non-empty string)' };
  }

  let cid: string | null = null;
  let bare: string | null = null;
  if (opts.convId) {
    try {
      cid = normalizeConvId(opts.convId);
      bare = cid.slice(2);
    } catch (e) {
      return { ok: false, code: 'INVALID_CONV_ID', message: (e as Error).message };
    }
  }

  let toolLabel: string | null = null;
  if (opts.tool) {
    try {
      toolLabel = resolveGeminiToolLabel(opts.tool);
    } catch (e) {
      return { ok: false, code: 'INVALID_TOOL', message: (e as Error).message };
    }
  }

  const port = opts.port ?? DEFAULT_GEMINI_CDP_PORT;
  const timeoutMs =
    typeof opts.timeoutMs === 'number' && Number.isFinite(opts.timeoutMs)
      ? Math.min(Math.max(5000, Math.floor(opts.timeoutMs)), 300_000)
      : (toolLabel === 'Create video' ? 180_000 : 120_000);

  let targets;
  try {
    targets = await listTargets(port);
  } catch (e) {
    return {
      ok: false,
      code: 'DEBUG_PORT_UNREACHABLE',
      message: `CDP port ${port} unreachable: ${(e as Error).message}`,
    };
  }

  const tab = targets.find((t) => t.type === 'page' && /^https?:\/\/([^/]+\.)?gemini\.google\.com(\/|$)/i.test(t.url || ''));
  if (!tab || !tab.webSocketDebuggerUrl) {
    return {
      ok: false,
      code: 'NO_GEMINI_TAB',
      message: `No gemini.google.com page tab found on CDP port ${port}.`,
    };
  }

  // Navigate to target conversation or reset to clean new chat if requested.
  if (bare) {
    const pathCheck = await evalInTab(port, tab.id, {
      expression: 'location.pathname',
      timeoutMs: 3000,
    });
    const curPath = pathCheck.ok && typeof pathCheck.result === 'string' ? pathCheck.result : '';
    if (!curPath.toLowerCase().includes(`/app/${bare}`)) {
      const nav = await navigateTab(port, tab.id, { url: `https://gemini.google.com/app/${bare}` });
      if (!nav.ok) {
        return { ok: false, code: 'NAVIGATE_FAILED', message: nav.error.message };
      }
      await waitForGeminiReady(port, tab.id, 10_000);
    }
  } else if (opts.createNew !== false) {
    const pre = await evalInTab(port, tab.id, {
      expression: `(() => ({
        isConvPath: /\\/app\\/[a-f0-9]{8,32}/i.test(location.pathname),
        respCount: document.querySelectorAll('model-response').length,
      }))()`,
      timeoutMs: 3000,
    });
    const st = pre.ok && pre.result && typeof pre.result === 'object'
      ? (pre.result as { isConvPath?: boolean; respCount?: number })
      : {};
    if (opts.createNew === true || st.isConvPath || (st.respCount || 0) > 0) {
      await evalInTab(port, tab.id, {
        expression: `(() => {
          const nc = document.querySelector('[data-test-id="new-chat-button"] button, [data-test-id="new-chat-button"] a, [data-test-id="new-chat-button"], a[data-test-id="side-nav-sparkle-button"]');
          if (nc && nc.click) nc.click();
          return !!nc;
        })()`,
        timeoutMs: 3000,
      });
      await sleep(700);
      await waitForGeminiReady(port, tab.id, 6000);
    }
  }

  const ready = await waitForGeminiReady(port, tab.id, 5000);
  if (!ready) {
    return {
      ok: false,
      code: 'NOT_LOGGED_IN',
      message: 'Gemini Web page tokens (WIZ_global_data.SNlM0e) or prompt editor not ready.',
    };
  }

  let modelSwitch: unknown = null;
  if (opts.model) {
    const ms = await evalInTab(port, tab.id, {
      expression: snippetSwitchModel(opts.model, { thinkingLevel: opts.thinkingLevel }).snippet,
      timeoutMs: 12_000,
    });
    modelSwitch = ms.ok ? ms.result : null;
    if (!ms.ok || !modelSwitch || !(modelSwitch as { ok?: boolean }).ok) {
      return {
        ok: false,
        code: 'MODEL_SWITCH_FAILED',
        message: 'Failed to switch Gemini model.',
        data: modelSwitch,
      };
    }
  }

  let toolSelect: unknown = null;
  if (toolLabel) {
    const ts = await evalInTab(port, tab.id, {
      expression: snippetSelectTool(toolLabel).snippet,
      timeoutMs: 12_000,
    });
    toolSelect = ts.ok ? ts.result : null;
    if (!ts.ok || !toolSelect || !(toolSelect as { ok?: boolean }).ok) {
      return {
        ok: false,
        code: 'TOOL_SELECT_FAILED',
        message: `Failed to select Gemini tool "${toolLabel}".`,
        data: toolSelect,
      };
    }
  }

  // Snapshot existing response count + responseIds so we detect the new turn cleanly.
  const snapEval = await evalInTab(port, tab.id, {
    expression: `(() => {
      const resps = document.querySelectorAll('model-response');
      const last = resps.length ? resps[resps.length - 1] : null;
      return {
        respCount: resps.length,
        lastText: last ? (last.innerText || '').trim() : '',
      };
    })()`,
    timeoutMs: 5000,
  });
  const snap = (snapEval.ok && snapEval.result && typeof snapEval.result === 'object'
    ? snapEval.result
    : { respCount: 0, lastText: '' }) as { respCount: number; lastText: string };

  const prevRespIds = new Set<string>();
  if (cid) {
    const h = await evalInTab(port, tab.id, {
      expression: snippetReadConversation(cid, { maxTurns: 10 }).snippet,
      timeoutMs: 10_000,
    });
    const hRes = h.ok && h.result && typeof h.result === 'object'
      ? (h.result as { ok?: boolean; turns?: Array<{ responseId?: string | null }> })
      : null;
    if (hRes?.ok && Array.isArray(hRes.turns)) {
      for (const t of hRes.turns) {
        if (t?.responseId) prevRespIds.add(t.responseId);
      }
    }
  }

  // Fill prompt editor, wait briefly for Angular/Quill, then send trusted Enter via CDP.
  const fillEval = await evalInTab(port, tab.id, {
    expression: `(async () => {
      const ed = document.querySelector('rich-textarea .ql-editor[contenteditable="true"], div.ql-editor[contenteditable="true"], div[contenteditable="true"][role="textbox"], textarea');
      if (!ed) return { ok: false, error: 'editor_not_found' };
      ed.focus();
      const text = ${JSON.stringify(opts.prompt)};
      if (ed.tagName === 'TEXTAREA') {
        const proto = Object.getPrototypeOf(ed);
        const desc = Object.getOwnPropertyDescriptor(proto, 'value');
        if (desc && desc.set) desc.set.call(ed, text);
        else ed.value = text;
        ed.dispatchEvent(new Event('input', { bubbles: true }));
      } else {
        ed.textContent = text;
        try { ed.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' })); }
        catch (_e) { ed.dispatchEvent(new Event('input', { bubbles: true })); }
      }
      await new Promise((r) => setTimeout(r, 250));
      ed.focus();
      return { ok: true };
    })()`,
    timeoutMs: 5000,
  });
  if (!fillEval.ok || !(fillEval.result as { ok?: boolean })?.ok) {
    return {
      ok: false,
      code: 'EDITOR_NOT_FOUND',
      message: 'Could not locate or populate Gemini prompt editor.',
    };
  }

  const sess = new CDPSession(tab.webSocketDebuggerUrl);
  try {
    await sess.ready();
    await sess.send('Page.bringToFront', {}, 5000);
    await sleep(100);
    await sess.send(
      'Input.dispatchKeyEvent',
      { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 },
      5000,
    );
    await sess.send(
      'Input.dispatchKeyEvent',
      { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 },
      5000,
    );
  } catch (e) {
    return {
      ok: false,
      code: 'CDP_INPUT_FAILED',
      message: `Failed sending trusted Enter key via CDP: ${(e as Error).message}`,
    };
  } finally {
    sess.close();
  }

  // Poll for response completion (text or media).
  interface PollState {
    url: string;
    stop: boolean;
    spin: boolean;
    respCount: number;
    convId: string | null;
    respId: string | null;
    imgs: Array<{ src: string; alt: string; w: number; h: number }>;
    videos: Array<{ tag: string; src: string; poster: string }>;
    lastText: string;
  }

  let state: PollState = {
    url: tab.url,
    stop: false,
    spin: false,
    respCount: snap.respCount,
    convId: cid,
    respId: null,
    imgs: [],
    videos: [],
    lastText: '',
  };
  let timedOut = true;
  let lastDomText = '';
  let stableTextTicks = 0;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    await sleep(2000);
    const ev = await evalInTab(port, tab.id, {
      expression: `(() => {
        const stop = Boolean(document.querySelector('button[aria-label*="Stop" i], button.stop-button, mat-icon[fonticon="stop"]'));
        const spin = Boolean(document.querySelector('model-response mat-progress-spinner, model-response mat-progress-bar, .generating, [aria-busy="true"]'));
        const resps = Array.from(document.querySelectorAll('model-response'));
        const last = resps.length ? resps[resps.length - 1] : null;
        let convId = null;
        let respId = null;
        if (last) {
          const rc = last.querySelector('[jslog*="BardVeMetadataKey"]') || last;
          const jslog = rc && rc.getAttribute ? (rc.getAttribute('jslog') || '') : '';
          const jm = jslog.match(/BardVeMetadataKey:([A-Za-z0-9+/=_-]+)/);
          if (jm) {
            try {
              const decoded = JSON.parse(atob(jm[1].replace(/-/g, '+').replace(/_/g, '/')));
              if (Array.isArray(decoded) && Array.isArray(decoded[0])) {
                if (typeof decoded[0][0] === 'string' && decoded[0][0].startsWith('r_')) respId = decoded[0][0];
                if (typeof decoded[0][1] === 'string' && decoded[0][1].startsWith('c_')) convId = decoded[0][1];
              }
            } catch {}
          }
        }
        if (!convId) {
          const pm = location.pathname.match(/\\/app\\/([a-f0-9]{8,32})/i);
          if (pm) convId = 'c_' + pm[1].toLowerCase();
        }
        const imgs = last
          ? Array.from(last.querySelectorAll('img')).map((i) => ({ src: i.currentSrc || i.src || '', alt: i.alt || '', w: i.naturalWidth || 0, h: i.naturalHeight || 0 })).filter((x) => x.src && !x.src.startsWith('data:image/svg'))
          : [];
        const videos = last
          ? Array.from(last.querySelectorAll('video, video source')).map((v) => ({ tag: v.tagName, src: v.currentSrc || v.src || '', poster: v.poster || '' })).filter((x) => x.src)
          : [];
        const lastText = last ? (last.innerText || '').trim() : '';
        return { url: location.href, stop, spin, respCount: resps.length, convId, respId, imgs, videos, lastText };
      })()`,
      timeoutMs: 8000,
    });
    if (!ev.ok || !ev.result || typeof ev.result !== 'object') continue;
    state = ev.result as PollState;

    const isNewTurn =
      state.respCount > snap.respCount ||
      (state.respId !== null && !prevRespIds.has(state.respId)) ||
      (state.convId !== null && cid === null);

    const hasMedia = state.imgs.length > 0 || state.videos.length > 0;
    const isTransientPlaceholder =
      !state.lastText ||
      state.lastText === 'Gemini said' ||
      /creating your|generating your|just a sec|working on it/i.test(state.lastText);

    if (isNewTurn && !state.stop && !state.spin) {
      if (hasMedia) {
        await sleep(1200);
        timedOut = false;
        break;
      }
      if (!isTransientPlaceholder && state.lastText !== snap.lastText) {
        if (state.lastText === lastDomText) stableTextTicks++;
        else {
          lastDomText = state.lastText;
          stableTextTicks = 1;
        }
        if (stableTextTicks >= 2) {
          timedOut = false;
          break;
        }
      }
    }
  }

  const resolvedConvId = state.convId || cid;
  const resolvedBare = resolvedConvId ? resolvedConvId.slice(2) : null;

  let turns: Array<{ responseId?: string | null; text?: string | null }> = [];
  let attachments: unknown[] = [];
  if (resolvedConvId) {
    const readEv = await evalInTab(port, tab.id, {
      expression: snippetReadConversation(resolvedConvId, { maxTurns: 5 }).snippet,
      timeoutMs: 12_000,
    });
    const readRes = readEv.ok && readEv.result && typeof readEv.result === 'object'
      ? (readEv.result as { ok?: boolean; turns?: Array<{ responseId?: string | null; text?: string | null }> })
      : null;
    if (readRes?.ok && Array.isArray(readRes.turns)) {
      turns = readRes.turns;
    }

    const attEv = await evalInTab(port, tab.id, {
      expression: snippetListAttachments(resolvedConvId, { maxTurns: 5 }).snippet,
      timeoutMs: 12_000,
    });
    const attRes = attEv.ok && attEv.result && typeof attEv.result === 'object'
      ? (attEv.result as { ok?: boolean; attachments?: unknown[] })
      : null;
    if (attRes?.ok && Array.isArray(attRes.attachments)) {
      attachments = attRes.attachments;
    }
  }

  const freshTurn = turns.find((t) => t?.responseId && !prevRespIds.has(t.responseId)) || turns[0] || null;
  const cleanedDomText = state.lastText.replace(/^Gemini said\s*/i, '').trim();
  const text = (freshTurn && typeof freshTurn.text === 'string' && freshTurn.text) || cleanedDomText;
  const responseId = (freshTurn && freshTurn.responseId) || state.respId || null;

  return {
    ok: true,
    conversationId: resolvedConvId,
    bareId: resolvedBare,
    responseId,
    text,
    turns,
    attachments,
    domMedia: { imgs: state.imgs, videos: state.videos },
    modelSwitch,
    toolSelect,
    url: state.url,
    timedOut,
  };
}

/**
 * Snapshot Gemini Web browser status plus signed-in models, conversations, and usage.
 */
export async function geminiWebCdpOverview(
  opts: { port?: number; limit?: number } = {},
): Promise<{
  ok: true;
  status: Awaited<ReturnType<typeof geminiWebLoginStatus>>;
  models: unknown[];
  conversations: unknown[];
  usage: unknown;
}> {
  const port = opts.port ?? DEFAULT_GEMINI_CDP_PORT;
  const limit =
    typeof opts.limit === 'number' && Number.isFinite(opts.limit)
      ? Math.min(Math.max(1, Math.floor(opts.limit)), 100)
      : 20;

  const status = await geminiWebLoginStatus(port);
  if (!status.ok || !status.loggedIn) {
    return { ok: true, status, models: [], conversations: [], usage: null };
  }

  let models: unknown[] = [];
  let conversations: unknown[] = [];
  let usage: unknown = null;

  try {
    const targets = await listTargets(port);
    const tab = targets.find(
      (t) => t.type === 'page' && /^https?:\/\/([^/]+\.)?gemini\.google\.com(\/|$)/i.test(t.url || ''),
    );
    if (tab) {
      const [mEv, cEv, uEv] = await Promise.all([
        evalInTab(port, tab.id, { expression: snippetListModels().snippet, timeoutMs: 8000 }),
        evalInTab(port, tab.id, { expression: snippetListConversations({ limit }).snippet, timeoutMs: 8000 }),
        evalInTab(port, tab.id, { expression: snippetGetUsage().snippet, timeoutMs: 8000 }),
      ]);
      const mRes = mEv.ok && mEv.result && typeof mEv.result === 'object' ? (mEv.result as { models?: unknown[] }) : null;
      const cRes =
        cEv.ok && cEv.result && typeof cEv.result === 'object' ? (cEv.result as { conversations?: unknown[] }) : null;
      const uRes =
        uEv.ok && uEv.result && typeof uEv.result === 'object'
          ? (uEv.result as { ok?: boolean; features?: unknown[] })
          : null;
      if (Array.isArray(mRes?.models)) models = mRes.models;
      if (Array.isArray(cRes?.conversations)) conversations = cRes.conversations;
      if (uRes?.ok) usage = { features: uRes.features ?? [] };
    }
  } catch {
    // non-fatal; caller still gets status
  }

  return { ok: true, status, models, conversations, usage };
}

/**
 * Delete a Gemini Web conversation inside the authenticated Chrome tab on `opts.port`.
 */
export async function geminiWebCdpDeleteConversation(opts: {
  port?: number;
  convId: string;
}): Promise<{ ok: true; conversationId: string } | GeminiCdpSendError> {
  let cid: string;
  try {
    cid = normalizeConvId(opts.convId);
  } catch (e) {
    return { ok: false, code: 'INVALID_CONV_ID', message: (e as Error).message };
  }

  const port = opts.port ?? DEFAULT_GEMINI_CDP_PORT;
  let targets;
  try {
    targets = await listTargets(port);
  } catch (e) {
    return {
      ok: false,
      code: 'DEBUG_PORT_UNREACHABLE',
      message: `CDP port ${port} unreachable: ${(e as Error).message}`,
    };
  }

  const tab = targets.find(
    (t) => t.type === 'page' && /^https?:\/\/([^/]+\.)?gemini\.google\.com(\/|$)/i.test(t.url || ''),
  );
  if (!tab) {
    return { ok: false, code: 'NO_GEMINI_TAB', message: `No gemini.google.com page tab found on CDP port ${port}.` };
  }

  const ev = await evalInTab(port, tab.id, {
    expression: snippetDeleteConversation(cid).snippet,
    timeoutMs: 10_000,
  });
  const resObj = ev.ok && ev.result && typeof ev.result === 'object' ? (ev.result as { ok?: boolean; error?: string }) : null;
  if (!ev.ok || !resObj?.ok) {
    return {
      ok: false,
      code: 'DELETE_FAILED',
      message: !ev.ok ? ev.error.message : (resObj?.error || `Failed to delete ${cid}`),
      data: resObj,
    };
  }
  return { ok: true, conversationId: cid };
}
