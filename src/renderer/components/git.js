// Shared git rendering helpers for the session's inline Review history: ref chips, a date
// formatter, and the commit-list rows. The commit DIFFS render through diff.js's .diff-table
// renderer (one renderer app-wide) — not diff2html.
//
// There is no commit-graph here: the history list is a single branch (base..HEAD), so lanes would
// only ever draw a straight line. The lane layout + SVG builder lived here for the project Git
// tab, which is gone.
import { esc, fmtDate } from '../lib/util.js';

export const ROW_H = 44; // must drive .pg-crow height — history sets --pg-row-h from this

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

// ── Commit list rows (the session's inline Review history) ───────────────────────────────
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

// Render the commit rows (the inner HTML of a `--pg-row-h` container). `onclick(sha)` builds each
// row's handler, `selected` highlights the open commit, `avatarUrl(c)` resolves a real avatar
// (else the initials show).
export function renderCommitRows(commits, { onclick, selected = '', avatarUrl = () => '' } = {}) {
  return commits.map(c => {
    const { initials, hue } = authorBadge(c.author, c.email);
    const url = avatarUrl(c);
    const av = `<span class="pg-av" data-sha="${c.sha}" data-name="${esc(c.author || '')}" style="background:hsl(${hue} 52% 47%)" title="${esc(c.author || c.email)}">${esc(initials)}${url ? avatarImg(url) : ''}</span>`;
    return `<div class="pg-crow${selected && c.sha === selected ? ' sel' : ''}" data-sha="${c.sha}" onclick="${onclick(c.sha)}" title="${esc(c.subject)}">
      ${av}
      <div class="pg-crow-main">
        <div class="pg-crow-subj">${refChips(c.refs)}${esc(c.subject)}</div>
        <div class="pg-crow-meta">${esc(c.author)} · <span title="${esc(c.date)}">${esc(fmtDate(c.date))}</span> · <span class="pg-sha">${esc(c.short)}</span></div>
      </div>
    </div>`;
  }).join('');
}
