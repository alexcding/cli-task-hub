// Dashboard (taskboard). Personal view: "Tasks" = PRs you authored, "Review" = PRs
// awaiting your review. Other people's PRs live under each project, not here.
import { ROUTES } from '/shared/routes.mjs';
import { state, prByUrl, prGroup, applyPendingMoves, reconcilePendingMoves } from '../stores/store.js';
import { PR_CATEGORY, PR_GROUP } from '/shared/constants.mjs';
import { api } from '../services/api.js';
import { esc, businessDaysUntil } from '../lib/util.js';
import { ICON } from '../lib/icons.js';
import { prCard } from '../components/cards.js';
import { jiraRowsHtml, rememberStatuses } from './jira.js';
import { renderTabs, renderProjectNav } from '../components/sidebar.js';
import { saveTabs } from '../components/viewer.js';
import { usageWidgetHtml } from '../components/usage-widget.js';

export async function loadDashboard() {
  // Reads the snapshot (instant) — no leading spinner so SSE refreshes are seamless.
  const [groups, sprintSnap, usage, whoami] = await Promise.all([
    api(ROUTES.DASHBOARD),
    api(ROUTES.JIRA_SPRINT).catch(() => ({ items: [] })),
    api(ROUTES.USAGE).catch(() => null),
    api(ROUTES.WHOAMI).catch(() => null),
  ]);
  state.projects = groups;
  reconcilePendingMoves(sprintSnap);
  state.sprintSnap = sprintSnap;
  rememberStatuses(sprintSnap.items);
  renderProjectNav(groups);

  // Flatten open PRs across all projects.
  const openPRs = groups.flatMap(g => (g.prs||[]).filter(p => !p.error && p.state==='OPEN'));
  const mine    = openPRs.filter(p => p.category === PR_CATEGORY.MINE);
  // "Review Requested" tracks PRs in my review orbit — kept while open if I'm requested OR
  // I've left any review (so a PR I've commented on, or approved but not yet merged, stays
  // instead of dropping off when GitHub removes me from reviewRequests). Falls back to
  // category for older snapshots written before awaitingMyReview existed. (Tray/sound still
  // use category.)
  const review  = openPRs.filter(p => prGroup(p) === PR_GROUP.REVIEW);
  const errors  = groups.flatMap(g => (g.prs||[]).filter(p => p.error));

  // Hero: greeting + date on the left, actionable counts as chips on the right.
  // Each chip jumps to the section (or page) it counts. No subtitle — the PR and
  // review sections right below already say what's waiting.
  const now = new Date();
  const hour = now.getHours();
  // First word of git's user.name, capitalized — "alexcding" → "Alexcding".
  const first = (whoami?.name || '').split(/\s+/)[0];
  const who = first ? `, ${esc(first[0].toUpperCase() + first.slice(1))}` : '';
  const hello = (hour < 5 ? 'Up late' : hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening') + who;
  const dateStr = now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  const chip = (val, label, icon, tint, onclick) => `
    <button class="stat-chip" onclick="${onclick}">
      <span class="stat-chip-icon tint-${tint}">${icon}</span>
      <span><div class="stat-chip-val">${val}</div><div class="stat-chip-label">${label}</div></span>
    </button>`;

  // AI usage widget (shared builder in usage-widget.js): full-width card below the
  // hero, compact variant (stat grid + histogram), Claude/Codex tabs top-right.
  state.usageSnap = usage;

  document.getElementById('stats').innerHTML = `
    <div class="dash-hero">
      <div>
        <div class="dash-date">${dateStr}</div>
        <div class="dash-hello">${hello}</div>
      </div>
      <div class="stat-chips">
        ${chip(mine.length, 'My PRs', ICON.branch, 'accent', "scrollDash('dash-mine')")}
        ${chip(review.length, 'To Review', ICON.eye, 'warn', "scrollDash('dash-review')")}
        ${chip((sprintSnap.items||[]).length, sprintLabel(sprintSnap), ICON.zap, 'merged', "scrollDash('dashboard-sprint')")}
      </div>
    </div>
    <div id="usage-widget" class="usage-row"></div>
  `;
  renderUsageWidget();
  restoreUsageTab();
  startUsageAutoRefresh();

  const section = (title, prs, emptyMsg, id) => `
    <div class="project-group" id="${id}">
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
      section('GitHub · My Pull Requests', mine, 'No open PRs you authored.', 'dash-mine') +
      section('Review Requested', review, 'Nothing awaiting your review.', 'dash-review')
    : `<div class="empty"><div class="empty-icon">${ICON.folder}</div><p>No projects yet. Create one to get started.</p><br><button class="btn btn-primary" onclick="openNewProjectModal()">${ICON.plus} New project</button></div>`;

  // Current Sprint (Jira) renders at the bottom, below the PR sections. It lives in
  // its own node so a status change can re-render just this section.
  document.getElementById('dashboard-groups').innerHTML = `${prHtml}<div id="dashboard-sprint"></div>`;
  renderDashboardSprint();

  // Refresh each open GitHub tab's saved group + author login from the freshly-loaded
  // snapshot, so a PR that moved mine↔review re-groups and legacy/tray-opened tabs (saved
  // with '') get backfilled. Store the sidebar GROUP ('mine'|'review') via prGroup — not the
  // raw category — so a commented PR (category 'other') stays under Review. Persist only if
  // something actually changed.
  let tabChanged = false;
  for (const t of state.tabs) {
    if (t.kind !== 'github') continue;
    const pr = prByUrl(t.url);
    if (!pr) continue;
    const group = prGroup(pr);
    if (group !== t.category) { t.category = group; tabChanged = true; }
    if (pr.author?.login && pr.author.login !== t.login) { t.login = pr.author.login; tabChanged = true; }
  }
  if (tabChanged) saveTabs();

  renderTabs(); // refresh CI dots on open GitHub tabs now that PR data (with CI) is loaded
}

// Smooth-scroll to a dashboard section (hero chips). No-op if the section isn't rendered.
export function scrollDash(id) {
  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// Active tab on the dashboard usage widget. Persisted to settings (key `usageAgent`)
// so it survives reloads AND so the tray menu can render the same selected agent.
let usageTab = 'claude';
let usageTabRestored = false;
export function setUsageTab(key) {
  usageTab = key;
  renderUsageWidget();
  // Persist first, THEN ask the tray to rebuild — so its menu re-reads the new agent
  // rather than racing the save and rendering the previous one.
  api(ROUTES.settingsKey('usageAgent'), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ value: key }) })
    .then(() => window.taskhub?.refreshTray?.())
    .catch(() => {});
}
// Restore the saved tab once per session (the in-session selection wins after that).
async function restoreUsageTab() {
  if (usageTabRestored) return;
  usageTabRestored = true;
  const settings = await api(ROUTES.SETTINGS).catch(() => null);
  if (settings?.usageAgent && settings.usageAgent !== usageTab) { usageTab = settings.usageAgent; renderUsageWidget(); }
}
function renderUsageWidget() {
  const el = document.getElementById('usage-widget');
  if (el) el.innerHTML = usageWidgetHtml(state.usageSnap, usageTab);
}

// The usage widget has no SSE trigger of its own — `sync` events track PR/Jira
// snapshots, not token usage — so its limit bars and "resets in…" countdown would
// freeze at page-load values until some unrelated sync re-ran loadDashboard. Poll
// /api/usage once a minute while the widget is on screen and re-render just it, so
// the bars/pace tick/countdown stay live. One timer, started lazily on first load.
let usageTimer = null;
async function refreshUsageWidget() {
  if (!document.getElementById('usage-widget')) return; // not on the dashboard right now
  const usage = await api(ROUTES.USAGE).catch(() => null);
  if (usage) state.usageSnap = usage;
  renderUsageWidget(); // always re-render so the countdown ticks even from cached data
}
function startUsageAutoRefresh() {
  if (!usageTimer) usageTimer = setInterval(refreshUsageWidget, 60_000);
}

// Chip/section label for the sprint snapshot: the active sprint's name (with days
// left when it has an end date), falling back to the generic title.
function sprintLabel(snap) {
  const s = snap?.sprint;
  if (!s?.name) return 'In Sprint';
  const days = s.endDate ? businessDaysUntil(s.endDate) : 0;
  return days > 0 ? `${esc(s.name)} · ${days}d left` : esc(s.name);
}

// Render the "Current Sprint" section from the cached snapshot (used on load and
// after a status change). Reuses the shared Jira table so the status menu works here.
export function renderDashboardSprint() {
  const el = document.getElementById('dashboard-sprint');
  if (!el) return;
  const items = applyPendingMoves(state.sprintSnap.items);  // overlay any sticky-optimistic status change
  const emptyMsg = state.sprintSnap.error ? esc(state.sprintSnap.error) : 'No open tickets in an active sprint.';
  el.innerHTML = `
    <div class="project-group">
      <div class="project-group-header">
        <span class="project-name">${state.sprintSnap.sprint?.name ? esc(state.sprintSnap.sprint.name) : 'Current Sprint'}</span>
        <span class="project-meta">${items.length}</span>
      </div>
      ${items.length
        ? `<div class="card"><div class="table-wrap"><table>
            <thead><tr><th>Key</th><th>Summary</th><th>Status</th><th>Type</th><th>Priority</th></tr></thead>
            <tbody>${jiraRowsHtml(items)}</tbody></table></div></div>`
        : `<div style="font-size:13px;color:var(--text-3);padding:12px 0">${emptyMsg}</div>`}
    </div>`;
}
