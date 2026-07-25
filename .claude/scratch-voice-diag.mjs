// scratch-voice-diag.mjs — reproduce the prod voice-WS behavior on 117 and capture WHY it
// closes (variant A). Launches headless Chrome exactly like openVoicePage (cookie + goto +
// settle), opens claude.ai's voice WS in-page, and reports: opened? session_server_initialized?
// close CODE + wasClean? page title (CF interstitial indicator)?. SAFETY: prints cookie NAMES
// only, never values.
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire('/home/ubuntu/lm-assist/package.json');
const puppeteer = require('puppeteer-core');

const CONV = process.env.CONV; if (!CONV) { console.error('CONV required'); process.exit(2); }
const SETTLE = Number(process.env.SETTLE_MS ?? 12000);
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';
const j = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', 'claudeai-session.json'), 'utf8'));
const cookieStr = typeof j.cookie === 'string' ? j.cookie : Object.entries(j.cookie || {}).map(([k, v]) => `${k}=${v}`).join('; ');
const cmap = {}; for (const p of cookieStr.split(/;\s*/)) { const i = p.indexOf('='); if (i > 0) cmap[p.slice(0, i).trim()] = p.slice(i + 1); }
const ORG = process.env.ORG || cmap['lastActiveOrg'];
console.log(`[diag] cookie names: ${Object.keys(cmap).sort().join(',')}`);
console.log(`[diag] org=${ORG} conv=${CONV} settleMs=${SETTLE}`);
const voiceUrl = `wss://claude.ai/api/ws/voice/organizations/${ORG}/chat_conversations/${CONV}?` + new URLSearchParams({
  input_encoding: 'opus', input_sample_rate: '16000', input_channels: '1', output_format: 'pcm_16000',
  language: 'en', timezone: 'Asia/Singapore', tts_speed: '1.00', server_interrupt_enabled: 'true',
  voice: 'buttery', client_aec: 'true', client_platform: 'web_claude_ai', model: 'claude-sonnet-5',
}).toString();

const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: true,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', `--user-agent=${UA}`] });
try {
  const page = await browser.newPage();
  await page.setCookie(...Object.entries(cmap).map(([name, value]) => ({ name, value, url: 'https://claude.ai' })));
  const resp = await page.goto('https://claude.ai/', { waitUntil: 'domcontentloaded' });
  await new Promise((r) => setTimeout(r, SETTLE));
  const title = await page.title();
  const onCf = /just a moment|attention required|checking your browser/i.test(title);
  console.log(`[diag] nav status=${resp && resp.status()} title=${JSON.stringify(title)} onCF=${onCf}`);
  const v = await page.evaluate((url) => new Promise((resolve) => {
    const out = { opened: false, init: false, frames: [], closeCode: null, wasClean: null, err: false };
    let ws; try { ws = new WebSocket(url); } catch (e) { return resolve({ ...out, ctor: String(e && e.message) }); }
    ws.binaryType = 'arraybuffer';
    const done = () => { try { ws.close(); } catch {} resolve(out); };
    const t = setTimeout(done, 15000);
    ws.onopen = () => { out.opened = true; };
    ws.onmessage = (ev) => { if (typeof ev.data === 'string') { let ty = 'text'; try { ty = JSON.parse(ev.data).type || 'text'; } catch {} if (ty === 'session_server_initialized') out.init = true; if (out.frames.length < 8) out.frames.push(ty); } else if (out.frames.length < 8) out.frames.push('bin'); };
    ws.onerror = () => { out.err = true; };
    ws.onclose = (e) => { out.closeCode = e.code; out.wasClean = e.wasClean; clearTimeout(t); done(); };
  }), voiceUrl);
  console.log(`[diag] WS: opened=${v.opened} init=${v.init} err=${v.err} closeCode=${v.closeCode} wasClean=${v.wasClean} frames=[${(v.frames || []).join(' ')}] ${v.ctor ? 'ctor=' + v.ctor : ''}`);
  const verdict = v.init ? 'UP_OPEN+INIT (variant-B territory)' : v.opened ? 'opened-but-NO-init' : `NEVER-OPENED (up_error) closeCode=${v.closeCode}`;
  console.log(`[diag] VERDICT: ${verdict}${onCf ? ' | page stuck on CF interstitial' : ''}`);
} finally { try { await browser.close(); } catch {} setTimeout(() => process.exit(0), 200); }
