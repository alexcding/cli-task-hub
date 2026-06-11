// Renders the Claude Session/Weekly usage panel to a single NativeImage so it can ride
// ONE native menu row — sidestepping the fixed per-row height of NSMenu. A hidden,
// transparent BrowserWindow draws the HTML (same bar model as the dashboard widget:
// fill = % left, green on-pace segment, 50%/75% gridmarks) and we capturePage() it.
// The window is created once and reused; everything is wrapped so a failure falls back
// to the plain text menu rows in menu.js (the menu must never break).
const { BrowserWindow, nativeImage, nativeTheme } = require('electron');
const fs = require('fs');
const path = require('path');

const SESSION_MS = 5 * 3600_000, WEEK_MS = 7 * 86_400_000;

// Per-agent display: accent color + label + the real app icon (served from /public/img,
// inlined as a data URI since the offscreen render loads a data: URL with no origin).
const AGENTS = {
  claude: { accent: '#d97757', name: 'Claude Code', img: 'claude.png' },
  codex:  { accent: '#717af0', name: 'Codex',       img: 'codex.png' },
};
const _iconCache = {};
function iconDataUri(file) {
  if (!(file in _iconCache)) {
    try { _iconCache[file] = 'data:image/png;base64,' + fs.readFileSync(path.join(__dirname, '..', 'public', 'img', file)).toString('base64'); }
    catch { _iconCache[file] = ''; }
  }
  return _iconCache[file];
}

// "1d 21h" / "1h 33m" / "12m" until an ISO reset time; null once it's passed.
const fmtUntil = (iso) => {
  const m = Math.floor((new Date(iso) - Date.now()) / 60000);
  if (m <= 0) return null;
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60;
  return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${String(mm).padStart(2, '0')}m` : `${mm}m`;
};

// Derived numbers for one plan-limit window, shared by the rendered panel (here) and
// the menu's text fallback (menu.js): bar fills to `left` (% remaining); the green tick
// sits at `paceLeft` (budget that should remain on an even pace); `reserve` = how far
// ahead of pace you are. Computed at call time so countdowns/pace stay live.
function limitStats(win, winMs) {
  const left = 100 - win.usedPct;
  const end = win.resetsAt ? new Date(win.resetsAt) : null;
  const elapsed = end ? Math.min(100, Math.max(0, 100 - (end - Date.now()) / winMs * 100)) : null;
  const paceLeft = elapsed != null ? 100 - elapsed : null;
  const reserve = paceLeft != null ? Math.round(left - paceLeft) : null;
  const reserveTxt = reserve == null ? '' : reserve >= 0 ? `${reserve}% in reserve` : `${-reserve}% over pace`;
  return { left, paceLeft, reserve, reserveTxt, until: win.resetsAt && fmtUntil(win.resetsAt) };
}

function groupHtml(label, win, winMs) {
  if (!win) return '';
  const { left, paceLeft, reserveTxt, until } = limitStats(win, winMs);
  return `
    <div class="grp">
      <div class="title">${label}</div>
      <div class="bar"><i style="width:${left}%"></i>${paceLeft != null ? `<s style="left:${paceLeft.toFixed(1)}%"></s>` : ''}</div>
      <div class="data">${left}% left${reserveTxt ? ` · ${reserveTxt}` : ''}${until ? ` <span class="muted">· resets in ${until}</span>` : ''}</div>
    </div>`;
}

function buildHtml(limits, agent) {
  // Theme-aware: the menu is light or dark, and the captured image is transparent, so
  // text/track/gridmark colors must follow the system appearance. The bar fill uses the
  // agent's accent so Claude (coral) and Codex (periwinkle) read distinctly.
  const dark = nativeTheme.shouldUseDarkColors;
  const text = dark ? '#e8e8e8' : '#16181d';
  const muted = dark ? '#8a8a8a' : '#9298a3';
  const track = dark ? 'rgba(255,255,255,.14)' : 'rgba(0,0,0,.10)';
  const mark = dark ? 'rgba(255,255,255,.20)' : 'rgba(0,0,0,.18)';
  const icon = iconDataUri(agent.img);
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    *{margin:0;padding:0;box-sizing:border-box;}
    body{background:transparent;font:13px/1.4 -apple-system,BlinkMacSystemFont,'Inter','Segoe UI',sans-serif;color:${text};
      width:310px;padding:0 2px;-webkit-font-smoothing:antialiased;}
    .hdr{display:flex;align-items:center;margin-bottom:11px;}
    .hdr img{width:20px;height:20px;border-radius:5px;}
    .grp{margin-bottom:13px;} .grp:last-child{margin-bottom:0;}
    .title{font-size:14px;font-weight:650;letter-spacing:-.2px;margin-bottom:7px;}
    .bar{position:relative;height:6px;border-radius:3px;background:${track};overflow:hidden;}
    .bar i{position:absolute;left:0;top:0;bottom:0;border-radius:3px;background:${agent.accent};}
    .bar::after{content:'';position:absolute;inset:0;background:
      linear-gradient(90deg,transparent calc(50% - .5px),${mark} calc(50% - .5px),${mark} calc(50% + .5px),transparent calc(50% + .5px)),
      linear-gradient(90deg,transparent calc(75% - .5px),${mark} calc(75% - .5px),${mark} calc(75% + .5px),transparent calc(75% + .5px));}
    .bar s{position:absolute;top:0;bottom:0;width:7px;margin-left:-3.5px;background:#16a34a;
      border-left:2px solid ${track};border-right:2px solid ${track};background-clip:padding-box;box-sizing:border-box;}
    .data{font-size:12px;margin-top:6px;white-space:nowrap;}
    .muted{color:${muted};}
  </style></head><body>
    ${icon ? `<div class="hdr"><img src="${icon}" alt=""></div>` : ''}
    ${groupHtml('Session', limits.session, SESSION_MS)}
    ${groupHtml('Weekly', limits.weekly, WEEK_MS)}
  </body></html>`;
}

let renderWin = null;

// Render the selected agent's panel to a NativeImage, or null when that agent has no
// limit data / the capture fails. agentKey is 'claude' (OAuth limits) or 'codex'
// (rollout-file limits) — matching the dashboard widget's selected tab.
async function renderUsageImage(usage, agentKey = 'claude') {
  const agent = AGENTS[agentKey] || AGENTS.claude;
  const limits = agentKey === 'codex' ? usage?.codexLimits : usage?.limits;
  if (!limits || (!limits.session && !limits.weekly)) return null;
  try {
    if (!renderWin || renderWin.isDestroyed()) {
      renderWin = new BrowserWindow({
        show: false, width: 320, height: 200, transparent: true, frame: false,
        backgroundColor: '#00000000', resizable: false, focusable: false, skipTaskbar: true,
        webPreferences: { offscreen: false, sandbox: true, contextIsolation: true, nodeIntegration: false },
      });
    }
    await renderWin.webContents.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(buildHtml(limits, agent)));
    // Size the window to the content so the capture has no empty margin, then give the
    // compositor a beat to paint the resized layout before grabbing it.
    const dims = await renderWin.webContents.executeJavaScript(
      '({ w: Math.ceil(document.body.scrollWidth), h: Math.ceil(document.body.scrollHeight) })'
    );
    renderWin.setContentSize(Math.max(1, dims.w), Math.max(1, dims.h));
    await new Promise(r => setTimeout(r, 50));
    const cap = await renderWin.webContents.capturePage();
    if (cap.isEmpty()) return null;
    // capturePage() returns a retina (2×) pixel buffer; handed to the menu as-is it's
    // read as points and shows up double-size. Re-wrap the PNG declaring its LOGICAL
    // size as dims (the CSS px we rendered at) with the matching scaleFactor, so the
    // menu draws it at true size and stays crisp. (cap.getSize() can't be trusted to
    // report DIPs vs px consistently, so anchor on the known logical width.)
    const png = cap.toPNG();
    const pxW = nativeImage.createFromBuffer(png).getSize().width;
    const scaleFactor = Math.max(1, Math.round(pxW / dims.w));
    return nativeImage.createFromBuffer(png, { width: dims.w, height: dims.h, scaleFactor });
  } catch (err) {
    console.error('[usage-image] render failed:', err.message);
    return null;
  }
}

module.exports = { renderUsageImage, limitStats, SESSION_MS, WEEK_MS };
