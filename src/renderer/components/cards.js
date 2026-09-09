// PR row builders shared by the dashboard and the project page.
import { esc, escJs, jiraUrl, fmtDate, ghAvatarSrc } from '../lib/util.js';
import { ensureAvatar } from '../lib/avatars.js';
import { ICON } from '../lib/icons.js';

// CI shown as a bare colored dot (with a tooltip for the actual status). Always
// returns a dot — even with no CI — so the card footer is never empty.
export function ciInfo(ci) {
  let cls = 'ci-none', label = 'No checks';
  if (ci) {
    if (ci.status === 'in_progress' || ci.status === 'queued') { cls = 'ci-running'; label = 'Running'; }
    else if (ci.conclusion === 'success')   { cls = 'ci-success'; label = 'Passing'; }
    else if (ci.conclusion === 'failure')   { cls = 'ci-failure'; label = 'Failing'; }
    else if (ci.conclusion === 'cancelled') { cls = 'ci-none';    label = 'Cancelled'; }
  }
  return { cls, label };
}

export function ciDot(ci) {
  const { cls, label } = ciInfo(ci);
  return `<span class="ci-dot ${cls}" title="${label}"></span>`;
}

// GitHub's reviewDecision === 'APPROVED' → a green circle with a white check (used inside
// prState's Approved chip; approved-but-not-yet-merged). '' otherwise. reviewDecision comes
// from the poller's lean().
function approvedMark(pr) {
  if (pr?.reviewDecision !== 'APPROVED') return '';
  return `<svg class="pr-approved" viewBox="0 0 16 16" title="Approved" aria-label="Approved">
    <circle cx="8" cy="8" r="8" fill="currentColor"></circle>
    <path d="M4.5 8.3l2.2 2.2 4.8-5" fill="none" stroke="#fff" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"></path>
  </svg>`;
}

// GitHub PR labels as small chips. Each carries a color dot tinted with the label's own
// GitHub color; the name stays in the theme palette so the chips read cleanly in either
// theme. gh shape: [{ name, color (6-hex, no #), description }].
export function labelChips(labels) {
  return (labels || []).map(l => {
    const dot = /^[0-9a-fA-F]{6}$/.test(l.color || '') ? `#${l.color}` : 'var(--text-3)';
    return `<span class="pr-label" title="${esc(l.description || l.name)}"><span class="pr-label-dot" style="background:${dot}"></span>${esc(l.name)}</span>`;
  }).join('');
}

// Review state, shown after the title: Draft (outlined), Approved (green check), or Changes
// requested (amber). '' for a plain open PR — GitHub's reviewDecision is APPROVED /
// CHANGES_REQUESTED / REVIEW_REQUIRED, and only the first two say anything worth a glance.
export function prState(pr) {
  if (pr.isDraft) return `<span class="pr-state pr-state-draft">Draft</span>`;
  if (pr.reviewDecision === 'APPROVED') return `<span class="pr-state pr-state-approved" title="Approved">${approvedMark(pr)}Approved</span>`;
  if (pr.reviewDecision === 'CHANGES_REQUESTED') return `<span class="pr-state pr-state-changes" title="Changes requested">${ICON.warn}Changes requested</span>`;
  return '';
}

// One PR as a flat, whole-row-clickable line (dashboard + project PR list). The row opens the
// PR in the viewer; the Jira badge keeps its own link (stopPropagation in jiraClick so it
// doesn't also trigger the row). Left → right: CI dot · #num · title · state · labels + Jira ·
// repo/branch ref · author avatar · date.
export function prRow(pr) {
  const jiraHtml = (pr.jiraKeys||[]).map(k =>
    `<a href="${jiraUrl(k)}" target="_blank" rel="noopener" class="badge badge-jira" onclick="jiraClick(event, this.href, '${escJs(k)}')">${esc(k)}</a>`).join('');
  const login = pr.author?.login || '';
  // The avatar src prefers the shared cache (a data URI) and warms it on a miss; data-av lets
  // ensureAvatar swap the data URI in once it lands, so a later rebuild never re-fetches/flickers.
  if (login) ensureAvatar(login);
  const avatar = login ? `<img class="pr-avatar" src="${ghAvatarSrc(login)}" data-av="${esc(login)}" alt="" title="${esc(login)}" loading="lazy">` : '';
  const tags = labelChips(pr.labels) + jiraHtml;
  const branch = pr.headRefName || '';
  const ref = `<span class="pr-ref" title="${esc(pr.repo||'')}${branch ? ' · ' + esc(branch) : ''}"><span class="pr-ref-repo">${esc((pr.repo||'').split('/').pop())}</span>${branch ? `<span class="pr-ref-sep">·</span><span class="pr-ref-branch">${esc(branch)}</span>` : ''}</span>`;
  return `<div class="pr-row" onclick="openPrSplit('${escJs(pr.url)}','#${Number(pr.number)}','${escJs(pr.repo||'')}','${escJs(branch)}')" title="Open PR #${pr.number}">
    ${ciDot(pr.ci)}
    <span class="pr-num">#${pr.number}</span>
    <span class="pr-title" title="${esc(pr.title)}">${esc(pr.title)}</span>
    ${prState(pr)}
    ${tags ? `<span class="pr-tags">${tags}</span>` : ''}
    ${ref}
    ${avatar}
    <span class="pr-date">${fmtDate(pr.createdAt)}</span>
  </div>`;
}

export function prListHtml(prs, repo, state) {
  if (!repo) return `<div class="empty"><div class="empty-icon">${ICON.branch}</div><p>Set a repository in settings to track pull requests.</p></div>`;
  if (!prs.length) return `<div class="empty"><div class="empty-icon">${ICON.branch}</div><p>No ${state} pull requests.</p></div>`;
  return `<div class="pr-list">${prs.map(pr => prRow(pr)).join('')}</div>`;
}
