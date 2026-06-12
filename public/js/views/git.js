// Shared git rendering helpers used by the full-width Git tab (views/git-tab.js): the lazy
// diff2html bundle loader + theme sync, a diff renderer, the commit-graph SVG builder, ref
// chips, and a date formatter. (TaskHub's older right-hand "glance" panel was removed in
// favour of the Git tab; these helpers outlived it.)
import { esc } from '../util.js';

// ── Lazy bundle load (mirrors terminal.js's xterm loader) ───────────────────────────
// The diff2html UI bundle is ~1 MB (it embeds highlight.js), so it loads on first use, never
// on app start. A single hljs <link> is injected and its href swapped to match the app theme
// — both themes style bare `.hljs`, so loading both and toggling `link.disabled` is unreliable
// (the property doesn't stick before the sheet loads, leaving black backgrounds in light mode).
let _loaded;
export function ensureDiff2Html() {
  if (_loaded) return _loaded;
  _loaded = new Promise((resolve, reject) => {
    const css = (id, href) => { const l = document.createElement('link'); l.id = id; l.rel = 'stylesheet'; l.href = href; document.head.appendChild(l); };
    css('d2h-css', '/vendor/diff2html.min.css');
    css('hljs-theme', '');
    syncHljsTheme();
    new MutationObserver(syncHljsTheme).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    const s = document.createElement('script');
    s.src = '/vendor/diff2html-ui.min.js';
    s.onload = resolve;
    s.onerror = () => reject(new Error('diff2html failed to load'));
    document.head.appendChild(s);
  });
  return _loaded;
}

// Point the single hljs <link> at the theme matching the current app theme.
function syncHljsTheme() {
  const link = document.getElementById('hljs-theme');
  if (!link) return;
  const dark = document.documentElement.dataset.theme === 'dark';
  const href = dark ? '/vendor/hljs-github-dark.min.css' : '/vendor/hljs-github.min.css';
  if (link.getAttribute('href') !== href) link.href = href;
}

// Render a diff string into a container with diff2html, using TaskHub's narrow-pane settings.
export function drawDiff(el, diff) {
  const ui = new window.Diff2HtmlUI(el, diff, {
    outputFormat: 'line-by-line', // the column is narrow — side-by-side would be cramped
    drawFileList: false,
    matching: 'lines',
    highlight: true,
    fileContentToggle: false,
  });
  ui.draw();
  ui.highlightCode();
}

// ── Commit-graph SVG (per row) ───────────────────────────────────────────────────────
// Graph geometry (lane/row units → px). ROW_H must match .pg-crow height in index.html so
// per-row SVG segments meet at row boundaries (bottom of row i == top of row i+1).
export const LANE_W = 14;
export const ROW_H = 44; // must drive .pg-crow height — the tab sets --pg-row-h from this
const NODE_R = 4;

// One row's graph cell: passthrough/branch/merge segments + the commit node, in a fixed-
// height SVG. Diagonals are smoothed with a vertical-tangent cubic so merges curve like Fork.
export function graphSvg(row, laneCount, width) {
  const cx = col => col * LANE_W + LANE_W / 2;
  const cy = f => f * ROW_H;
  const seg = s => {
    const x1 = cx(s.x1), y1 = cy(s.y1), x2 = cx(s.x2), y2 = cy(s.y2);
    const d = x1 === x2
      ? `M${x1} ${y1}L${x2} ${y2}`
      : `M${x1} ${y1}C${x1} ${(y1 + y2) / 2} ${x2} ${(y1 + y2) / 2} ${x2} ${y2}`;
    return `<path d="${d}" stroke="var(--g${s.color})" stroke-width="1.75" fill="none"/>`;
  };
  return `<svg class="pg-graph" width="${width}" height="${ROW_H}" viewBox="0 0 ${width} ${ROW_H}" aria-hidden="true">`
    + row.segments.map(seg).join('')
    + `<circle cx="${cx(row.col)}" cy="${cy(0.5)}" r="${NODE_R}" fill="var(--g${row.color})" stroke="var(--surface)" stroke-width="1.5"/></svg>`;
}

// Ref decorations (%D) as small inline chips before a commit subject.
export function refChips(refs) {
  return (refs || []).map(r => `<span class="pg-ref pg-ref-${r.type}" title="${esc(r.name)}">${esc(r.name)}</span>`).join('');
}

// Date helper for the commit detail (util.timeAgo only spans hours; commits span months).
export function fmtDateTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}
