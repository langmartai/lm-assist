const sharp = require('sharp');
const path = require('path');

const docsDir = __dirname;

// Shared defs block for all 3 SVGs
const DEFS = `
  <defs>
    <linearGradient id="bgGrad" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#0f172a"/>
      <stop offset="100%" stop-color="#1e293b"/>
    </linearGradient>
    <linearGradient id="coreGrad" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#7c3aed"/>
      <stop offset="100%" stop-color="#6d28d9"/>
    </linearGradient>
    <linearGradient id="webGrad" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#2563eb"/>
      <stop offset="100%" stop-color="#1d4ed8"/>
    </linearGradient>
    <linearGradient id="claudeGrad" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#d97706"/>
      <stop offset="100%" stop-color="#b45309"/>
    </linearGradient>
    <linearGradient id="hubGrad" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#059669"/>
      <stop offset="100%" stop-color="#047857"/>
    </linearGradient>
    <linearGradient id="storageGrad" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#475569"/>
      <stop offset="100%" stop-color="#334155"/>
    </linearGradient>
    <linearGradient id="machineGrad" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#1e293b"/>
      <stop offset="100%" stop-color="#0f172a"/>
    </linearGradient>
    <filter id="shadow" x="-4%" y="-4%" width="108%" height="112%">
      <feDropShadow dx="0" dy="2" stdDeviation="4" flood-color="#000" flood-opacity="0.3"/>
    </filter>
  </defs>`;

// Brand bar at top of every image
function brandBar(w, y) {
  const cx = w / 2;
  return `
  <rect x="0" y="${y}" width="${w}" height="28" fill="#0f172a" opacity="0.8"/>
  <text x="${cx}" y="${y + 18}" text-anchor="middle" fill="#7c3aed" font-size="11" font-weight="700" letter-spacing="1.5">lm-assist</text>`;
}

// Shared install + GitHub footer block
function installFooter(x, y, w) {
  return `
  <rect x="${x}" y="${y}" width="${w}" height="82" rx="8" fill="#1e293b" stroke="#475569" stroke-width="1" opacity="0.6"/>
  <text x="${x+20}" y="${y+16}" fill="#94a3b8" font-size="7.5" font-weight="600">INSTALL</text>
  <text x="${x+20}" y="${y+32}" fill="#fbbf24" font-size="9">/plugin marketplace add langmartai/lm-assist</text>
  <text x="${x+20}" y="${y+46}" fill="#fbbf24" font-size="9">/plugin install lm-assist</text>
  <text x="${x+20}" y="${y+60}" fill="#94a3b8" font-size="9">/assist-setup</text>
  <text x="${x+20}" y="${y+76}" fill="#64748b" font-size="8">github.com/langmartai/lm-assist  ·  Core :3100  ·  Web :3848  ·  ttyd :5900+</text>`;
}

async function renderSvgToPng(svgString, outPath) {
  const buf = await sharp(Buffer.from(svgString), { density: 300 })
    .flatten({ background: '#0f172a' })
    .png()
    .toBuffer();
  await sharp(buf).png().toFile(outPath);
  const m = await sharp(buf).metadata();
  console.log('wrote', outPath, `(${m.width} x ${m.height})`);
}

async function main() {
  const topLeftOut = path.join(docsDir, 'architecture-diagram-top-left.png');
  const topRightOut = path.join(docsDir, 'architecture-diagram-top-right.png');
  const bottomOut = path.join(docsDir, 'architecture-diagram-bottom.png');

  await renderSvgToPng(buildTopLeftSvg(), topLeftOut);
  await renderSvgToPng(buildTopRightSvg(), topRightOut);
  await renderSvgToPng(buildBottomSvg(), bottomOut);
}

// ============================================================
// SVG 1: IDE → MCP → Knowledge Pipeline
// ============================================================
function buildTopLeftSvg() {
  const W = 500, H = 580;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" font-family="'Segoe UI', system-ui, -apple-system, sans-serif">
  ${DEFS}
  <rect width="${W}" height="${H}" fill="url(#bgGrad)" rx="12"/>
  ${brandBar(W, 0)}

  <!-- Title -->
  <text x="${W/2}" y="50" text-anchor="middle" fill="#fbbf24" font-size="14" font-weight="700">Turn Claude Code Sessions Into Reusable Knowledge</text>
  <text x="${W/2}" y="66" text-anchor="middle" fill="#94a3b8" font-size="8">Extracts what Claude Code already knows from past sessions · serves it to any MCP-compatible IDE</text>

  <!-- Step 1: You → Your IDE -->
  <circle cx="90" cy="96" r="16" fill="#38bdf8" opacity="0.12"/>
  <circle cx="90" cy="90" r="6" fill="none" stroke="#38bdf8" stroke-width="1.8"/>
  <path d="M79 104 a12 10 0 0 1 22 0" fill="none" stroke="#38bdf8" stroke-width="1.8" stroke-linecap="round"/>
  <text x="90" y="122" text-anchor="middle" fill="#e2e8f0" font-size="11" font-weight="600">You</text>
  <circle cx="130" cy="88" r="11" fill="#d97706" opacity="0.5"/>
  <text x="130" y="92" text-anchor="middle" fill="#fde68a" font-size="9" font-weight="700">1</text>

  <!-- Arrow: You → IDE Grid -->
  <line x1="90" y1="128" x2="90" y2="142" stroke="#fbbf24" stroke-width="1.5" opacity="0.6"/>
  <polygon points="90,142 86,134 94,134" fill="#fbbf24" opacity="0.6"/>

  <!-- IDE Grid box -->
  <rect x="20" y="144" width="460" height="82" rx="10" fill="#1e293b" stroke="#d97706" stroke-width="1.5" filter="url(#shadow)"/>
  <text x="40" y="160" fill="#fbbf24" font-size="7.5" font-weight="600">YOUR IDE — ALL ACCESS KNOWLEDGE VIA MCP</text>
  <rect x="34" y="168" width="135" height="22" rx="5" fill="url(#claudeGrad)" opacity="0.7"/>
  <text x="46" y="183" fill="#fde68a" font-size="8.5" font-weight="600">>_ Claude Code</text>
  <rect x="177" y="168" width="135" height="22" rx="5" fill="#1e3a5f" opacity="0.8"/>
  <text x="189" y="183" fill="#60a5fa" font-size="8.5" font-weight="600">{ } VS Code</text>
  <rect x="320" y="168" width="135" height="22" rx="5" fill="#1e3a5f" opacity="0.8"/>
  <text x="332" y="183" fill="#60a5fa" font-size="8.5" font-weight="600">▸ Cursor</text>
  <rect x="34" y="196" width="135" height="22" rx="5" fill="#1e3a5f" opacity="0.8"/>
  <text x="46" y="211" fill="#60a5fa" font-size="8.5" font-weight="600">$ Codex CLI</text>
  <rect x="177" y="196" width="135" height="22" rx="5" fill="#1e3a5f" opacity="0.8"/>
  <text x="189" y="211" fill="#60a5fa" font-size="8.5" font-weight="600">✦ Gemini CLI</text>
  <rect x="320" y="196" width="135" height="22" rx="5" fill="#1e3a5f" opacity="0.8"/>
  <text x="332" y="211" fill="#60a5fa" font-size="8.5" font-weight="600">△ Antigravity</text>

  <!-- Arrow: IDE → MCP/Hook -->
  <line x1="250" y1="226" x2="250" y2="242" stroke="#a78bfa" stroke-width="1.5" opacity="0.6"/>
  <polygon points="250,242 246,234 254,234" fill="#a78bfa" opacity="0.6"/>

  <!-- Step 2: MCP Server + Context Hook -->
  <rect x="20" y="244" width="460" height="72" rx="10" fill="#1e293b" stroke="#a78bfa" stroke-width="1.5" filter="url(#shadow)"/>
  <text x="40" y="260" fill="#c4b5fd" font-size="7.5" font-weight="600" opacity="0.8">STEP 2 — KNOWLEDGE RETRIEVAL</text>
  <circle cx="440" cy="258" r="11" fill="#4c1d95" opacity="0.7"/>
  <text x="440" y="262" text-anchor="middle" fill="#c4b5fd" font-size="9" font-weight="700">2</text>
  <rect x="34" y="270" width="260" height="36" rx="6" fill="#4c1d95" opacity="0.5"/>
  <text x="164" y="285" text-anchor="middle" fill="#c4b5fd" font-size="9" font-weight="600">MCP Server</text>
  <text x="164" y="298" text-anchor="middle" fill="#a78bfa" font-size="7.5" opacity="0.8">All IDEs · search() · detail() · feedback()</text>
  <rect x="302" y="270" width="148" height="36" rx="6" fill="#4c1d95" opacity="0.35"/>
  <text x="376" y="285" text-anchor="middle" fill="#c4b5fd" font-size="9" font-weight="600">Context Hook</text>
  <text x="376" y="298" text-anchor="middle" fill="#a78bfa" font-size="7.5" opacity="0.6">Claude Code only</text>

  <!-- Arrow: MCP/Hook → Knowledge -->
  <line x1="250" y1="316" x2="250" y2="332" stroke="#f59e0b" stroke-width="1.5" opacity="0.6"/>
  <polygon points="250,332 246,324 254,324" fill="#f59e0b" opacity="0.6"/>

  <!-- Step 3: Knowledge / Vector DB -->
  <rect x="20" y="334" width="460" height="70" rx="10" fill="#1e293b" stroke="#f59e0b" stroke-width="1.5" filter="url(#shadow)"/>
  <text x="40" y="350" fill="#f59e0b" font-size="7.5" font-weight="600">STEP 3 — SEARCHES KNOWLEDGE BASE</text>
  <circle cx="440" cy="348" r="11" fill="#92400e" opacity="0.7"/>
  <text x="440" y="352" text-anchor="middle" fill="#fcd34d" font-size="9" font-weight="700">3</text>
  <text x="250" y="370" text-anchor="middle" fill="#fcd34d" font-size="12" font-weight="700">LanceDB + LMDB</text>
  <text x="250" y="384" text-anchor="middle" fill="#94a3b8" font-size="8.5">~/.lm-assist/knowledge/ · Semantic + BM25 full-text search</text>
  <text x="250" y="398" text-anchor="middle" fill="#fbbf24" font-size="8" font-weight="600">Results available to any MCP-connected IDE</text>

  <!-- Extraction pipeline -->
  <rect x="20" y="416" width="460" height="54" rx="8" fill="url(#coreGrad)" filter="url(#shadow)" opacity="0.65"/>
  <text x="40" y="432" fill="#c4b5fd" font-size="7.5" font-weight="600" opacity="0.8">HOW KNOWLEDGE IS BUILT — CORE API :3100</text>
  <rect x="34" y="440" width="125" height="22" rx="5" fill="url(#storageGrad)" opacity="0.7"/>
  <text x="96" y="455" text-anchor="middle" fill="#e2e8f0" font-size="7.5">sessions/*.jsonl</text>
  <text x="167" y="455" fill="#c4b5fd" font-size="10">→</text>
  <rect x="180" y="440" width="110" height="22" rx="5" fill="#4c1d95" opacity="0.5"/>
  <text x="235" y="455" text-anchor="middle" fill="#ddd6fe" font-size="7.5">Parse + Embed</text>
  <text x="298" y="455" fill="#c4b5fd" font-size="10">→</text>
  <rect x="310" y="440" width="145" height="22" rx="5" fill="#92400e" opacity="0.5"/>
  <text x="382" y="455" text-anchor="middle" fill="#fcd34d" font-size="7.5">Vector DB (feeds Step 3)</text>

  <!-- Cycle arrow -->
  <path d="M20 466 Q2 466 2 310 Q2 162 20 162" fill="none" stroke="#94a3b8" stroke-width="1" stroke-dasharray="4 3" opacity="0.35"/>
  <polygon points="20,162 12,168 16,160" fill="#94a3b8" opacity="0.35"/>
  <text x="-2" y="310" fill="#94a3b8" font-size="7" opacity="0.5" transform="rotate(-90,-2,310)">new sessions feed back</text>

  <!-- Install + GitHub -->
  ${installFooter(20, 480, 460)}
</svg>`;
}

// ============================================================
// SVG 2: Access Claude Code Anywhere
// ============================================================
function buildTopRightSvg() {
  const W = 500, H = 560;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" font-family="'Segoe UI', system-ui, -apple-system, sans-serif">
  ${DEFS}
  <rect width="${W}" height="${H}" fill="url(#bgGrad)" rx="12"/>
  ${brandBar(W, 0)}

  <!-- Title -->
  <text x="${W/2}" y="50" text-anchor="middle" fill="#60a5fa" font-size="14" font-weight="700">Access Claude Code Anywhere</text>
  <text x="${W/2}" y="66" text-anchor="middle" fill="#94a3b8" font-size="8">Desktop · laptop · phone · iPad · any browser with internet</text>

  <!-- User icon -->
  <circle cx="250" cy="100" r="18" fill="#38bdf8" opacity="0.12"/>
  <circle cx="250" cy="93" r="7" fill="none" stroke="#38bdf8" stroke-width="1.8"/>
  <path d="M238 108 a13 11 0 0 1 24 0" fill="none" stroke="#38bdf8" stroke-width="1.8" stroke-linecap="round"/>
  <text x="250" y="130" text-anchor="middle" fill="#e2e8f0" font-size="11" font-weight="600">You</text>

  <!-- Three access methods -->
  <line x1="200" y1="125" x2="100" y2="167" stroke="#38bdf8" stroke-width="1.3" stroke-dasharray="5 3" opacity="0.6"/>
  <polygon points="100,167 108,161 105,170" fill="#38bdf8" opacity="0.6"/>
  <text x="140" y="142" text-anchor="middle" fill="#38bdf8" font-size="8" opacity="0.8">localhost</text>

  <line x1="250" y1="135" x2="250" y2="167" stroke="#818cf8" stroke-width="1.3" stroke-dasharray="5 3" opacity="0.6"/>
  <polygon points="250,167 246,159 254,159" fill="#818cf8" opacity="0.6"/>
  <text x="275" y="155" fill="#818cf8" font-size="8" opacity="0.8">LAN/WiFi</text>

  <line x1="300" y1="125" x2="400" y2="167" stroke="#34d399" stroke-width="1.3" stroke-dasharray="5 3" opacity="0.6"/>
  <polygon points="400,167 392,161 395,170" fill="#34d399" opacity="0.6"/>
  <text x="360" y="142" text-anchor="middle" fill="#34d399" font-size="8" opacity="0.8">langmart.ai</text>

  <!-- Web UI box -->
  <rect x="30" y="170" width="440" height="72" rx="10" fill="url(#webGrad)" filter="url(#shadow)" opacity="0.95"/>
  <rect x="410" y="175" width="50" height="16" rx="8" fill="#1e40af" opacity="0.8"/>
  <text x="435" y="186" text-anchor="middle" fill="#93c5fd" font-size="7" font-weight="600">:3848</text>
  <text x="50" y="190" fill="#bfdbfe" font-size="7.5" font-weight="600" opacity="0.8">WEB UI — YOUR DASHBOARD</text>
  <text x="230" y="209" text-anchor="middle" fill="#fff" font-size="13" font-weight="700">lm-assist Web UI</text>
  <text x="230" y="227" text-anchor="middle" fill="#bfdbfe" font-size="9">Terminal (ttyd)  ·  Sessions  ·  Tasks  ·  Knowledge  ·  Settings</text>

  <!-- Arrow: Web UI → Core API -->
  <line x1="250" y1="242" x2="250" y2="262" stroke="#60a5fa" stroke-width="1.3" opacity="0.5"/>
  <polygon points="250,262 246,254 254,254" fill="#60a5fa" opacity="0.5"/>

  <!-- Core API -->
  <rect x="80" y="264" width="340" height="52" rx="8" fill="url(#coreGrad)" filter="url(#shadow)" opacity="0.8"/>
  <text x="100" y="282" fill="#c4b5fd" font-size="7.5" font-weight="600" opacity="0.8">CORE API</text>
  <rect x="360" y="269" width="50" height="16" rx="8" fill="#4c1d95" opacity="0.8"/>
  <text x="385" y="280" text-anchor="middle" fill="#c4b5fd" font-size="7" font-weight="600">:3100</text>
  <text x="250" y="298" text-anchor="middle" fill="#ddd6fe" font-size="8.5">REST API  ·  ttyd manager  ·  session cache  ·  Hub client</text>

  <!-- Feature boxes — 2x2 grid -->
  <rect x="30" y="330" width="215" height="56" rx="8" fill="#1e293b" stroke="#38bdf8" stroke-width="1" opacity="0.8"/>
  <text x="45" y="348" fill="#38bdf8" font-size="9" font-weight="700">Live Terminal</text>
  <text x="45" y="362" fill="#94a3b8" font-size="8">Open Claude Code in browser</text>
  <text x="45" y="374" fill="#94a3b8" font-size="8">Monitor output · resume work</text>

  <rect x="255" y="330" width="215" height="56" rx="8" fill="#1e293b" stroke="#818cf8" stroke-width="1" opacity="0.8"/>
  <text x="270" y="348" fill="#818cf8" font-size="9" font-weight="700">Session Inspector</text>
  <text x="270" y="362" fill="#94a3b8" font-size="8">Browse all sessions · agent trees</text>
  <text x="270" y="374" fill="#94a3b8" font-size="8">Tool calls · thinking · token costs</text>

  <rect x="30" y="396" width="215" height="56" rx="8" fill="#1e293b" stroke="#34d399" stroke-width="1" opacity="0.8"/>
  <text x="45" y="414" fill="#34d399" font-size="9" font-weight="700">Remote Access</text>
  <text x="45" y="428" fill="#94a3b8" font-size="8">Via langmart.ai cloud proxy</text>
  <text x="45" y="440" fill="#94a3b8" font-size="8">From phone, iPad, any browser</text>

  <rect x="255" y="396" width="215" height="56" rx="8" fill="#1e293b" stroke="#f59e0b" stroke-width="1" opacity="0.8"/>
  <text x="270" y="414" fill="#f59e0b" font-size="9" font-weight="700">Knowledge + Tasks</text>
  <text x="270" y="428" fill="#94a3b8" font-size="8">Browse knowledge base</text>
  <text x="270" y="440" fill="#94a3b8" font-size="8">Task kanban across all sessions</text>

  <!-- Install + GitHub -->
  ${installFooter(30, 466, 440)}
</svg>`;
}

// ============================================================
// SVG 3: Knowledge Sync Across Machines (2 hosts)
// ============================================================
function buildBottomSvg() {
  const W = 960, H = 530;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" font-family="'Segoe UI', system-ui, -apple-system, sans-serif">
  ${DEFS}
  <rect width="${W}" height="${H}" fill="url(#bgGrad)" rx="12"/>
  ${brandBar(W, 0)}

  <!-- Title -->
  <text x="${W/2}" y="48" text-anchor="middle" fill="#e2e8f0" font-size="16" font-weight="700">Knowledge Sync Across Machines</text>
  <text x="${W/2}" y="66" text-anchor="middle" fill="#94a3b8" font-size="10">Each machine extracts knowledge locally. Hub relays queries so any MCP-compatible IDE sees knowledge from all hosts.</text>

  <!-- HUB (center) -->
  <rect x="260" y="80" width="440" height="52" rx="10" fill="url(#hubGrad)" filter="url(#shadow)"/>
  <text x="480" y="101" text-anchor="middle" fill="#fff" font-size="13" font-weight="700">LangMart Hub</text>
  <text x="480" y="118" text-anchor="middle" fill="#a7f3d0" font-size="9">Knowledge relay · session sync · no data stored</text>

  <!-- Hub to Machine A -->
  <line x1="380" y1="132" x2="250" y2="180" stroke="#34d399" stroke-width="1.5" stroke-dasharray="5 3" opacity="0.5"/>
  <polygon points="250,180 258,173 255,182" fill="#34d399" opacity="0.5"/>
  <polygon points="380,132 372,139 375,130" fill="#34d399" opacity="0.5"/>
  <!-- Hub to Machine B -->
  <line x1="580" y1="132" x2="710" y2="180" stroke="#34d399" stroke-width="1.5" stroke-dasharray="5 3" opacity="0.5"/>
  <polygon points="710,180 702,173 705,182" fill="#34d399" opacity="0.5"/>
  <polygon points="580,132 588,139 585,130" fill="#34d399" opacity="0.5"/>

  <!-- Machine A (left) -->
  <rect x="80" y="182" width="310" height="110" rx="10" fill="url(#machineGrad)" stroke="#475569" stroke-width="1" filter="url(#shadow)"/>
  <rect x="94" y="189" width="28" height="20" rx="3" fill="none" stroke="#d97706" stroke-width="1.2" opacity="0.7"/>
  <text x="130" y="202" fill="#fbbf24" font-size="10" font-weight="700">Machine A</text>
  <text x="130" y="214" fill="#94a3b8" font-size="8">Desktop — Office network</text>
  <rect x="94" y="224" width="105" height="20" rx="5" fill="url(#coreGrad)" opacity="0.7"/>
  <text x="146" y="238" text-anchor="middle" fill="#ddd6fe" font-size="8">Core API</text>
  <rect x="207" y="224" width="55" height="20" rx="5" fill="url(#claudeGrad)" opacity="0.5"/>
  <text x="234" y="238" text-anchor="middle" fill="#fde68a" font-size="8">IDEs</text>
  <rect x="270" y="224" width="62" height="20" rx="5" fill="url(#webGrad)" opacity="0.6"/>
  <text x="301" y="238" text-anchor="middle" fill="#bfdbfe" font-size="8">Web UI</text>
  <rect x="94" y="250" width="118" height="20" rx="5" fill="#1e293b" stroke="#a78bfa" stroke-width="1" opacity="0.8"/>
  <text x="153" y="264" text-anchor="middle" fill="#c4b5fd" font-size="7.5">42 sessions</text>
  <rect x="220" y="250" width="112" height="20" rx="5" fill="#1e293b" stroke="#f59e0b" stroke-width="1" opacity="0.8"/>
  <text x="276" y="264" text-anchor="middle" fill="#fcd34d" font-size="7.5">128 knowledge entries</text>
  <rect x="94" y="276" width="238" height="14" rx="4" fill="#f59e0b" opacity="0.15"/>
  <text x="213" y="286" text-anchor="middle" fill="#f59e0b" font-size="7" font-weight="600">Extracts locally → syncs via Hub</text>

  <!-- Machine B (right) — YOU ARE HERE -->
  <rect x="570" y="182" width="310" height="110" rx="10" fill="url(#machineGrad)" stroke="#fbbf24" stroke-width="2" filter="url(#shadow)"/>
  <rect x="570" y="182" width="310" height="110" rx="10" fill="none" stroke="#fbbf24" stroke-width="1" opacity="0.3"/>
  <rect x="584" y="189" width="28" height="20" rx="3" fill="none" stroke="#d97706" stroke-width="1.2" opacity="0.7"/>
  <text x="620" y="202" fill="#fbbf24" font-size="10" font-weight="700">Machine B</text>
  <text x="735" y="202" fill="#fbbf24" font-size="8" font-weight="600" opacity="0.8">YOU ARE HERE</text>
  <text x="620" y="214" fill="#94a3b8" font-size="8">Laptop — Coffee shop WiFi</text>
  <rect x="584" y="224" width="105" height="20" rx="5" fill="url(#coreGrad)" opacity="0.7"/>
  <text x="636" y="238" text-anchor="middle" fill="#ddd6fe" font-size="8">Core API</text>
  <rect x="697" y="224" width="55" height="20" rx="5" fill="url(#claudeGrad)" opacity="0.9"/>
  <text x="724" y="238" text-anchor="middle" fill="#fde68a" font-size="8" font-weight="700">IDEs</text>
  <rect x="760" y="224" width="62" height="20" rx="5" fill="url(#webGrad)" opacity="0.6"/>
  <text x="791" y="238" text-anchor="middle" fill="#bfdbfe" font-size="8">Web UI</text>
  <rect x="584" y="250" width="118" height="20" rx="5" fill="#1e293b" stroke="#a78bfa" stroke-width="1" opacity="0.8"/>
  <text x="643" y="264" text-anchor="middle" fill="#c4b5fd" font-size="7.5">18 sessions</text>
  <rect x="710" y="250" width="112" height="20" rx="5" fill="#1e293b" stroke="#f59e0b" stroke-width="1" opacity="0.8"/>
  <text x="766" y="264" text-anchor="middle" fill="#fcd34d" font-size="7.5">64 knowledge entries</text>
  <rect x="584" y="276" width="238" height="14" rx="4" fill="#fbbf24" opacity="0.2"/>
  <text x="703" y="286" text-anchor="middle" fill="#fbbf24" font-size="7" font-weight="600">Any IDE sees knowledge from A + B via MCP</text>

  <!-- Knowledge flow A → B -->
  <path d="M332 265 Q430 240 584 238" fill="none" stroke="#f59e0b" stroke-width="2" opacity="0.6"/>
  <polygon points="584,238 575,234 575,242" fill="#f59e0b" opacity="0.7"/>
  <text x="460" y="253" text-anchor="middle" fill="#f59e0b" font-size="7" opacity="0.8" font-weight="600">knowledge syncs in</text>

  <!-- Flow steps -->
  <rect x="38" y="310" width="884" height="56" rx="8" fill="#1e293b" stroke="#475569" stroke-width="1" opacity="0.7"/>
  <circle cx="70" cy="326" r="10" fill="#d97706" opacity="0.3"/>
  <text x="70" y="330" text-anchor="middle" fill="#fbbf24" font-size="9" font-weight="700">1</text>
  <text x="88" y="326" fill="#e2e8f0" font-size="8.5" font-weight="600">You type a prompt</text>
  <text x="88" y="338" fill="#94a3b8" font-size="7.5">in any IDE on Machine B</text>
  <circle cx="300" cy="326" r="10" fill="#7c3aed" opacity="0.3"/>
  <text x="300" y="330" text-anchor="middle" fill="#c4b5fd" font-size="9" font-weight="700">2</text>
  <text x="318" y="326" fill="#e2e8f0" font-size="8.5" font-weight="600">MCP search()</text>
  <text x="318" y="338" fill="#94a3b8" font-size="7.5">queries local + Hub knowledge</text>
  <circle cx="530" cy="326" r="10" fill="#059669" opacity="0.3"/>
  <text x="530" y="330" text-anchor="middle" fill="#34d399" font-size="9" font-weight="700">3</text>
  <text x="548" y="326" fill="#e2e8f0" font-size="8.5" font-weight="600">Hub relays to A</text>
  <text x="548" y="338" fill="#94a3b8" font-size="7.5">queries its knowledge store</text>
  <circle cx="750" cy="326" r="10" fill="#f59e0b" opacity="0.3"/>
  <text x="750" y="330" text-anchor="middle" fill="#fcd34d" font-size="9" font-weight="700">4</text>
  <text x="768" y="326" fill="#e2e8f0" font-size="8.5" font-weight="600">Merged results injected</text>
  <text x="768" y="338" fill="#94a3b8" font-size="7.5">into any IDE's context</text>

  <!-- Summary -->
  <text x="480" y="385" text-anchor="middle" fill="#f59e0b" font-size="9" font-weight="600">Any MCP-compatible IDE on any machine sees knowledge extracted from sessions on every connected machine.</text>

  <!-- Legend -->
  <rect x="30" y="398" width="900" height="36" rx="8" fill="#0f172a" opacity="0.6"/>
  <circle cx="60" cy="416" r="5" fill="#2563eb"/>
  <text x="72" y="420" fill="#94a3b8" font-size="9">Local access</text>
  <circle cx="170" cy="416" r="5" fill="#059669"/>
  <text x="182" y="420" fill="#94a3b8" font-size="9">Cloud relay</text>
  <circle cx="280" cy="416" r="5" fill="#d97706"/>
  <text x="292" y="420" fill="#94a3b8" font-size="9">IDE / MCP</text>
  <circle cx="395" cy="416" r="5" fill="#7c3aed"/>
  <text x="407" y="420" fill="#94a3b8" font-size="9">Core API</text>
  <line x1="480" y1="411" x2="510" y2="411" stroke="#f59e0b" stroke-width="2"/>
  <polygon points="510,411 504,407 504,415" fill="#f59e0b"/>
  <text x="518" y="415" fill="#94a3b8" font-size="9">Knowledge sync</text>
  <text x="660" y="420" fill="#64748b" font-size="9">Ports: Core 3100 · Web 3848 · ttyd 5900+</text>

  <!-- Install + GitHub -->
  ${installFooter(30, 442, 900)}
</svg>`;
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});