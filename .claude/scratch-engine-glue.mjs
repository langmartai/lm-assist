import http from 'node:http'; import fs from 'node:fs'; import { createRequire } from 'node:module';
const require = createRequire('/home/ubuntu/lm-assist/package.json');
const puppeteer = require('puppeteer-core');
const ENGINE = fs.readFileSync('/home/ubuntu/lm-assist/web/public/voice/claude-voice-engine.js', 'utf8');
const PAGE = `<!doctype html><html><body><script type="module">
  window.__r = { n: 0, states: [], err: null, supported: null };
  (async () => {
    try {
      const m = await import('/engine.js');
      window.__r.imported = typeof m.createClaudeVoiceEngine;
      const e = m.createClaudeVoiceEngine();
      await e.start({ onFrame: () => { window.__r.n++; }, onState: (s) => { window.__r.states.push(s); } });
    } catch (err) { window.__r.err = String((err && err.message) || err); }
  })();
</script></body></html>`;
const server = http.createServer((req, res) => {
  if (req.url.startsWith('/engine.js')) { res.setHeader('content-type', 'application/javascript'); res.end(ENGINE); }
  else { res.setHeader('content-type', 'text/html'); res.end(PAGE); }
});
server.listen(0, '127.0.0.1', async () => {
  const port = server.address().port;
  const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: true,
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream'] });
  try {
    const page = await browser.newPage();
    page.on('console', (mm) => { const t = mm.text(); if (t && !/Autofill|devtools|Download the/i.test(t)) console.log('[page]', mm.type(), t.slice(0, 150)); });
    page.on('pageerror', (e) => console.log('[page ERROR]', String(e).slice(0, 150)));
    await page.goto('http://127.0.0.1:' + port + '/', { waitUntil: 'load' });
    await new Promise((r) => setTimeout(r, 5000));
    const r = await page.evaluate(() => window.__r);
    console.log('[engine-glue] imported=' + r.imported + ' frames(onFrame)=' + r.n + ' states=[' + r.states.join(',') + '] err=' + r.err);
    console.log(r.n > 0 ? 'PASS — import + engine.start({onFrame}) EMITS frames (uplink engine glue OK; look downstream: ws.send / relay)' : 'FAIL — import+start+onFrame produced ZERO frames — THIS is the variant-B root');
  } finally { await browser.close(); server.close(); setTimeout(() => process.exit(0), 200); }
});
