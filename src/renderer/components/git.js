// Shared git rendering helpers used by the project Git tab + the inline Review history: the
// commit-graph SVG builder, ref chips, a date formatter, and the commit-list rows. The commit
// DIFFS render through diff.js's .diff-table renderer (one renderer app-wide) — not diff2html.
import { esc, fmtDate } from '../lib/util.js';

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

// ── Commit list rows (shared by the project Git tab + the inline Review history) ─────────
// A generated initials badge — instant, no network, colour hashed per author NAME so one person
// always gets the same initials + colour even across several commit emails — is the base; the
// real GitHub avatar is overlaid (avatarImg) when known, so a missing/failed image shows initials
// rather than a broken-image flash.
const _badges = new Map();
function authorBadge(name, email) {
  const key = String(name || email || '?').trim().toLowerCase();
  let b = _badges.get(key);
  if (b) return b;
  const words = String(name || email || '?').trim().split(/\s+/).filter(Boolean);
  const initials = (words.length >= 2 ? words[0][0] + words[1][0] : (words[0] || '?').slice(0, 1)).toUpperCase();
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0;
  b = { initials, hue: ((h % 360) + 360) % 360 };
  _badges.set(key, b);
  return b;
}
export function avatarImg(url) {
  return `<img class="pg-av-img" src="${esc(url)}" alt="" loading="lazy" onerror="this.remove()">`;
}

// Render the commit rows for a computed graph (the inner HTML of a `--pg-row-h` container).
// `onclick(sha)` builds each row's handler (callers differ — Git tab vs history), `selected`
// highlights the open commit, `avatarUrl(c)` resolves a real avatar (else the initials show).
// `lanes` draws the commit-graph column — off for a single-branch linear list (the inline
// history is base..HEAD, so the lanes would just be a straight line); `graph` may be null then.
export function renderCommitRows(commits, graph, { onclick, selected = '', avatarUrl = () => '', lanes = true } = {}) {
  const w = lanes ? Math.max(1, graph.laneCount) * LANE_W : 0;
  return commits.map((c, i) => {
    const { initials, hue } = authorBadge(c.author, c.email);
    const url = avatarUrl(c);
    const g = lanes ? graphSvg(graph.rows[i], graph.laneCount, w) : '';
    const av = `<span class="pg-av" data-sha="${c.sha}" data-name="${esc(c.author || '')}" style="background:hsl(${hue} 52% 47%)" title="${esc(c.author || c.email)}">${esc(initials)}${url ? avatarImg(url) : ''}</span>`;
    return `<div class="pg-crow${lanes ? '' : ' no-lanes'}${selected && c.sha === selected ? ' sel' : ''}" data-sha="${c.sha}" onclick="${onclick(c.sha)}" title="${esc(c.subject)}">
      ${g}${av}
      <div class="pg-crow-main">
        <div class="pg-crow-subj">${refChips(c.refs)}${esc(c.subject)}</div>
        <div class="pg-crow-meta">${esc(c.author)} · <span title="${esc(c.date)}">${esc(fmtDate(c.date))}</span> · <span class="pg-sha">${esc(c.short)}</span></div>
      </div>
    </div>`;
  }).join('');
}
