// Dashboard (taskboard). Personal view: "Tasks" = PRs you authored, "Review" = PRs
// awaiting your review. Other people's PRs live under each project, not here.
import { state, prByUrl } from '../store.js';
import { api } from '../api.js';
import { esc } from '../util.js';
import { ICON } from '../icons.js';
import { prCard } from './cards.js';
import { jiraRowsHtml, rememberStatuses } from './jira.js';
import { renderTabs, renderProjectNav } from '../sidebar.js';
import { saveTabs } from '../viewer.js';

export async function loadDashboard() {
  // Reads the snapshot (instant) — no leading spinner so SSE refreshes are seamless.
  const [groups, events, mineSnap, sprintSnap] = await Promise.all([
    api('/api/dashboard'),
    api('/api/events'),
    api('/api/jira/mine').catch(() => ({ items: [] })),
    api('/api/jira/sprint').catch(() => ({ items: [] })),
  ]);
  state.projects = groups;
  state.mineSnap = mineSnap;
  state.sprintSnap = sprintSnap;
  rememberStatuses(sprintSnap.items);
  renderProjectNav(groups);

  // Flatten open PRs across all projects.
  const openPRs = groups.flatMap(g => (g.prs||[]).filter(p => !p.error && p.state==='OPEN'));
  const mine    = openPRs.filter(p => p.category === 'mine');
  const review  = openPRs.filter(p => p.category === 'review');
  const errors  = groups.flatMap(g => (g.prs||[]).filter(p => p.error));

  document.getElementById('stats').innerHTML = `
    <div class="stat-card"><div class="stat-val">${groups.length}</div><div class="stat-label">Projects</div></div>
    <div class="stat-card"><div class="stat-val" style="color:var(--accent)">${mine.length}</div><div class="stat-label">My PRs</div></div>
    <div class="stat-card"><div class="stat-val" style="color:var(--warn)">${review.length}</div><div class="stat-label">To Review</div></div>
    <div class="stat-card"><div class="stat-val" style="color:var(--warn)">${(sprintSnap.items||[]).length}</div><div class="stat-label">In Sprint</div></div>
    <div class="stat-card" onclick="showPage('mytickets')" style="cursor:pointer"><div class="stat-val" style="color:var(--accent)">${(mineSnap.items||[]).length}</div><div class="stat-label">JIRA Tickets</div></div>
    <div class="stat-card"><div class="stat-val" style="color:var(--success)">${events.filter(e=>e.type==='jira_transitioned').length}</div><div class="stat-label">Auto-transitions</div></div>
  `;

  const section = (title, prs, emptyMsg) => `
    <div class="project-group">
      <div class="project-group-header">
        <span class="project-name">${title}</span>
        <span class="project-meta">${prs.length}</span>
      </div>
      ${prs.length
        ? `<div class="pr-grid">${prs.map(pr=>prCard(pr)).join('')}</div>`
        : `<div style="font-size:13px;color:var(--text-3);padding:12px 0">${emptyMsg}</div>`}
    </div>`;

  const prHtml = groups.length
    ? errors.map(e=>`<p style="font-size:12px;color:var(--danger);margin-bottom:8px;display:flex;align-items:center;gap:5px">${ICON.warn} ${esc(e.repo)}: ${esc(e.error)}</p>`).join('') +
      section('GitHub · My Pull Requests', mine, 'No open PRs you authored.') +
      section('Review Requested', review, 'Nothing awaiting your review.')
    : `<div class="empty"><div class="empty-icon">${ICON.folder}</div><p>No projects yet. Create one to get started.</p><br><button class="btn btn-primary" onclick="openNewProjectModal()">${ICON.plus} New project</button></div>`;

  // Current Sprint (Jira) renders at the bottom, below the PR sections. It lives in
  // its own node so a status change can re-render just this section.
  document.getElementById('dashboard-groups').innerHTML = `${prHtml}<div id="dashboard-sprint"></div>`;
  renderDashboardSprint();

  // Refresh each open GitHub tab's saved category from the freshly-loaded snapshot, so a
  // PR that moved mine↔review re-groups and legacy/tray-opened tabs (saved with '') get
  // backfilled. Persist only if something actually changed.
  let catChanged = false;
  for (const t of state.tabs) {
    if (t.kind !== 'github') continue;
    const live = prByUrl(t.url)?.category;
    if (live && live !== t.category) { t.category = live; catChanged = true; }
  }
  if (catChanged) saveTabs();

  renderTabs(); // refresh CI dots on open GitHub tabs now that PR data (with CI) is loaded
}

// Render the "Current Sprint" section from the cached snapshot (used on load and
// after a status change). Reuses the shared Jira table so the status menu works here.
export function renderDashboardSprint() {
  const el = document.getElementById('dashboard-sprint');
  if (!el) return;
  const items = state.sprintSnap.items || [];
  const emptyMsg = state.sprintSnap.error ? esc(state.sprintSnap.error) : 'No open tickets in an active sprint.';
  el.innerHTML = `
    <div class="project-group">
      <div class="project-group-header">
        <span class="project-name">Current Sprint</span>
        <span class="project-meta">${items.length}</span>
      </div>
      ${items.length
        ? `<div class="card"><div class="table-wrap"><table>
            <thead><tr><th>Key</th><th>Summary</th><th>Status</th><th>Type</th><th>Priority</th></tr></thead>
            <tbody>${jiraRowsHtml(items)}</tbody></table></div></div>`
        : `<div style="font-size:13px;color:var(--text-3);padding:12px 0">${emptyMsg}</div>`}
    </div>`;
}
