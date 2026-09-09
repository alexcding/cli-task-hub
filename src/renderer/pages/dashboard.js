// Dashboard (taskboard). Personal view: "Tasks" = PRs you authored, "Review" = PRs
// awaiting your review. Other people's PRs live under each project, not here.
import { ROUTES } from '/shared/routes.mjs';
import { state, prByUrl, prGroup } from '../stores/store.js';
import { PR_CATEGORY, PR_GROUP } from '/shared/constants.mjs';
import { api } from '../services/api.js';
import { esc, setHtmlIfChanged } from '../lib/util.js';
import { ICON } from '../lib/icons.js';
import { prRow } from '../components/cards.js';
import { renderTabs, renderProjectNav } from '../components/sidebar.js';
import { saveTabs } from '../components/viewer.js';
import { usageHero } from '../components/usage-widget.js';

export async function loadDashboard() {
  // Reads the snapshot (instant) — no leading spinner so SSE refreshes are seamless.
  const [groups, usage, whoami, settings] = await Promise.all([
    api(ROUTES.DASHBOARD),
    api(ROUTES.USAGE).catch(() => null),
    api(ROUTES.WHOAMI).catch(() => null),
    api(ROUTES.SETTINGS).catch(() => null),
  ]);
  // Which agent the hero shows: the dashboard's own `usageAgent` setting (the topbar picker),
  // falling back to the Default agent (Settings → CLIs). Re-read on every load — except while a
  // pick's save is still in flight, so an SSE refresh mid-PUT can't snap the hero back.
  if (!usageAgentSaving) usageAgent = settings?.usageAgent || settings?.defaultCli || state.defaultCli || 'claude';
  state.projects = groups;
  renderProjectNav(groups);

  // New project lives in the sidebar's app header row (index.html); the empty state below keeps its
  // own "New project" button for the zero case.

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

  // Hero: greeting + date on the left; the chosen agent's plan limits as ring chips on the right
  // (usage-widget.js). The Claude/Codex picker sits in the topbar. The PR sections below carry their
  // own counts, so the hero has no stat chips.
  const now = new Date();
  const hour = now.getHours();
  // First word of git's user.name, capitalized — "alexcding" → "Alexcding".
  const first = (whoami?.name || '').split(/\s+/)[0];
  const who = first ? `, ${esc(first[0].toUpperCase() + first.slice(1))}` : '';
  const hello = (hour < 5 ? 'Up late' : hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening') + who;
  const dateStr = now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  state.usageSnap = usage;

  document.getElementById('stats').innerHTML = `
    <div class="dash-hero">
      <div class="dash-greet">
        <div class="dash-date">${dateStr}</div>
        <div class="dash-hello">${hello}</div>
      </div>
      <div class="dash-usage" id="usage-figs"></div>
    </div>
  `;
  // The Claude/Codex picker lives in the topbar's action slot while the dashboard is showing
  // (showPage clears the slot on every navigation, so re-creating it here is safe).
  document.getElementById('topbar-actions').innerHTML = '<span id="usage-agent" class="dash-agent"></span>';
  renderUsageWidget();
  startUsageAutoRefresh();

  const section = (title, prs, emptyMsg, id) => `
    <div class="project-group" id="${id}">
      <div class="project-group-header">
        <span class="project-name">${title}</span>
        <span class="project-meta">${prs.length}</span>
      </div>
      ${prs.length
        ? `<div class="pr-list">${prs.map(pr=>prRow(pr)).join('')}</div>`
        : `<div class="project-group-empty">${emptyMsg}</div>`}
    </div>`;

  const prHtml = groups.length
    ? errors.map(e=>`<p style="font-size:12px;color:var(--danger);margin-bottom:8px;display:flex;align-items:center;gap:5px">${ICON.warn} ${esc(e.repo)}: ${esc(e.error)}</p>`).join('') +
      section('GitHub · My Pull Requests', mine, 'No open PRs you authored.', 'dash-mine') +
      section('Review Requested', review, 'Nothing awaiting your review.', 'dash-review')
    : `<div class="empty"><div class="empty-icon">${ICON.folder}</div><p>No projects yet. Create one to get started.</p><br><button class="btn btn-primary" onclick="openNewProjectModal()">${ICON.plus} New project</button></div>`;

  // Sprint work lives on each project's Board tab, not here — the dashboard is PRs only.
  // Skip the innerHTML churn when the rows are unchanged — refreshActivePage re-runs this on
  // every SSE sync, and rebuilding recreates each row's avatar <img> (a github.com URL, no
  // frozen data-URI), which flickers. The row markup is stable for stable data (fmtDate is
  // absolute, not a relative "ago"), so an equal-HTML guard holds across no-op syncs.
  setHtmlIfChanged(document.getElementById('dashboard-groups'), prHtml);

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

// Agent whose limits the hero shows (see loadDashboard for where it comes from).
let usageAgent = 'claude';
// Hero picker. Persisted as the `usageAgent` setting so it survives reloads AND so the tray menu
// can render the same agent — persist first, THEN ask the tray to rebuild, so its menu re-reads
// the new agent rather than racing the save.
let usageAgentSaving = false;
export function setUsageAgent(key) {
  usageAgent = key;
  usageAgentSaving = true;
  renderUsageWidget();
  api(ROUTES.settingsKey('usageAgent'), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ value: key }) })
    .then(() => window.taskhub?.refreshTray?.())
    .catch(() => {})
    .finally(() => { usageAgentSaving = false; });
}
function renderUsageWidget() {
  const { agentLine, figures } = usageHero(state.usageSnap, usageAgent);
  const a = document.getElementById('usage-agent'), f = document.getElementById('usage-figs');
  if (a) a.innerHTML = agentLine;
  if (f) f.innerHTML = figures;
}

// The hero figures have no SSE trigger of their own — `sync` events track PR/Jira
// snapshots, not token usage — so the percentages and "resets in…" countdown would
// freeze at page-load values until some unrelated sync re-ran loadDashboard. Poll
// /api/usage once a minute while the dashboard is on screen and re-render just them.
// One timer, started lazily on first load.
let usageTimer = null;
async function refreshUsageWidget() {
  // Not on the dashboard: stop polling until the next visit restarts it.
  if (!document.getElementById('usage-figs')) { clearInterval(usageTimer); usageTimer = null; return; }
  const usage = await api(ROUTES.USAGE).catch(() => null);
  if (usage) state.usageSnap = usage;
  renderUsageWidget(); // always re-render so the countdown ticks even from cached data
}
function startUsageAutoRefresh() {
  if (!usageTimer) usageTimer = setInterval(refreshUsageWidget, 60_000);
}
