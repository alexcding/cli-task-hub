// PR card builders shared by the dashboard and the project page.
import { esc, jiraUrl, fmtDate, ghAvatarSrc } from '../lib/util.js';
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

// GitHub's reviewDecision === 'APPROVED' → a green circle with a white check, pinned to
// the card footer's bottom-right (approved-but-not-yet-merged, in both My PRs and Review
// Requested). '' otherwise. Shown via lib/poller lean() carrying reviewDecision.
export function approvedMark(pr) {
  if (pr?.reviewDecision !== 'APPROVED') return '';
  return `<svg class="pr-approved" viewBox="0 0 16 16" title="Approved" aria-label="Approved">
    <circle cx="8" cy="8" r="8" fill="currentColor"></circle>
    <path d="M4.5 8.3l2.2 2.2 4.8-5" fill="none" stroke="#fff" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"></path>
  </svg>`;
}

// A flat, whole-card-clickable PR card. The card opens the PR; the Jira badge keeps
// its own link to Jira (stopPropagation so it doesn't also trigger the card).
// Layout: header (num · repo · date + CI dot) on top, title fills the middle,
// footer holds the author's GitHub avatar (bottom-left) + optional Jira tag.
export function prCard(pr) {
  const jiraHtml = (pr.jiraKeys||[]).map(k =>
    `<a href="${jiraUrl(k)}" target="_blank" rel="noopener" class="badge badge-jira" onclick="jiraClick(event, this.href, '${esc(k)}')">${esc(k)}</a>`).join('');
  const login = pr.author?.login || '';
  // GitHub serves any user's avatar at github.com/<login>.png — no API call needed.
  const avatar = login ? `<img class="pr-avatar" src="${ghAvatarSrc(login)}" alt="" title="${esc(login)}" loading="lazy">` : '';
  const footLeft = avatar + jiraHtml;
  const approved = approvedMark(pr); // green check, pinned bottom-right (see .pr-foot-end)
  // Footer renders whenever there's a left item (avatar/Jira) OR an approved mark, so the
  // check shows even on a card with no avatar/Jira tags.
  const foot = (footLeft || approved)
    ? `<div class="pr-foot">${footLeft}${approved ? `<span class="pr-foot-end">${approved}</span>` : ''}</div>`
    : '';
  return `<div class="card clickable pr-card" onclick="openPrSplit('${pr.url}','#${pr.number}','${esc(pr.repo||'')}','${esc(pr.headRefName||'')}')" title="Open PR #${pr.number}">
    <div class="pr-head">
      <span class="pr-num">#${pr.number}</span>
      <span class="pr-repo">${esc(pr.repo)}</span>
      ${pr.isDraft ? `<span class="pr-draft">Draft</span>` : ''}
      <span class="pr-date">${fmtDate(pr.createdAt)}</span>
      ${ciDot(pr.ci)}
    </div>
    <div class="pr-body"><div class="pr-title">${esc(pr.title)}</div></div>
    ${foot}
  </div>`;
}

export function prListHtml(prs, repo, state) {
  if (!repo) return `<div class="empty"><div class="empty-icon">${ICON.branch}</div><p>Set a repository in settings to track pull requests.</p></div>`;
  if (!prs.length) return `<div class="empty"><div class="empty-icon">${ICON.branch}</div><p>No ${state} pull requests.</p></div>`;
  return `<div class="pr-grid">${prs.map(pr => prCard(pr)).join('')}</div>`;
}
