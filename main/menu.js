// Builds the tray context menu. The menu LIST mirrors the app's open tabs (same
// /api/tabs source as the sidebar), grouped exactly like the sidebar, plus the
// "Review requested" master list.
const { Menu } = require('electron');
const { fetchJSON, postJSON } = require('./server-supervisor');
const { openWindow, openLinkInApp, runInApp, quitApp } = require('./window');
const { trayIcon, avatarIcon, loadAvatar, jiraIcon } = require('./icons');
const { detectReviewChanges } = require('./notifications');
const { renderUsageImage } = require('./usage-image');

// Build a labeled section of open-tab menu items. Each item maps 1:1 to a sidebar row
// and clicking it focuses that exact tab. Titles are the ones saved on the tab
// (produced by the renderer's prTabTitle/jiraTabTitle at open time), so they read
// identically in both places. GitHub tabs show the PR author's avatar with a CI badge
// (looked up in prByUrl); Jira tabs show Jira's blue diamond mark.
// Truncate long titles so the menu doesn't stretch wide; trimEnd() drops a trailing
// space that would otherwise leave a visible gap before the ellipsis.
const menuLabel = s => s.length > 40 ? s.slice(0, 40).trimEnd() + '…' : s;

// Sidebar GROUP for a PR — mirrors the renderer's store.prGroup (kept local since main is
// CommonJS, not ESM). 'review' when it's awaiting my review (falling back to category for
// snapshots predating awaitingMyReview), else 'mine'. A PR I've only commented on is
// category:'other' but belongs under Review — grouping on raw category sends it to Mine.
const prGroup = pr => ((pr?.awaitingMyReview ?? (pr?.category === 'review')) ? 'review' : 'mine');
// Group an open GitHub tab: prefer the live snapshot PR (source of truth, same as the
// sidebar); fall back to the group persisted on the tab (renderer backfills it via prGroup).
const tabGroup = (t, prByUrl) => { const pr = prByUrl[t.url]; return pr ? prGroup(pr) : (t.category === 'review' ? 'review' : 'mine'); };

function tabSection(label, tabs, prByUrl) {
  if (!tabs.length) return [];
  const items = [{ label, enabled: false }];
  for (const t of tabs) {
    const title = t.title || t.url;
    const item = {
      label: menuLabel(title),
      click: () => openLinkInApp(t.url, title, t.kind, t.category),
    };
    if (t.kind === 'github') { const pr = prByUrl[t.url]; item.icon = avatarIcon(pr?.author?.login, pr?.ci, pr?.reviewDecision === 'APPROVED'); }
    else if (t.kind === 'jira') { item.icon = jiraIcon(); }
    items.push(item);
  }
  return items;
}

// Build a section from PR snapshot objects (not open tabs) — used for "Review
// requested": pending reviews you haven't opened yet. Title matches the renderer's
// prTabTitle() so it reads identically once clicked (which opens it as a tab).
function prMenuItems(label, prs, refreshMenu) {
  if (!prs.length) return [];
  const items = [{ label, enabled: false }];
  for (const pr of prs) {
    const full = `PR #${pr.number} ${pr.title}`;
    items.push({
      label: menuLabel(full),
      icon: avatarIcon(pr.author?.login, pr.ci, pr.reviewDecision === 'APPROVED'),
      // Opening records a durable "viewed" on the server (hides it from "Review requested"
      // until a newer request), then opens it as a tab. Await the record before rebuilding
      // so the next menu read already reflects it and the item doesn't flash back.
      click: async () => {
        openLinkInApp(pr.url, full, 'github', prGroup(pr));
        await postJSON('/api/prs/viewed', { repo: pr.repo, number: pr.number });
        refreshMenu();
      },
    });
  }
  return items;
}

// The fetched menu body (tab + review sections) is cached here so the tray can build a
// menu synchronously when it (re-)arms the context menu: refreshMenuData() renews it on
// the 60s tick / window blur, and buildMenuNow() assembles the full menu from it. (A menu
// must stay set via setContextMenu; popping one from a tray 'click' handler doesn't
// display on macOS — see tray.js.)
let _body = null;
// Claude's Session/Weekly plan limits, rendered to one NativeImage (main/usage-image.js)
// and shown as a single row above Quit. Same data the dashboard usage widget reads
// (/api/usage → lib/usage.js). null when there's no limit data (e.g. not signed in) or a
// render fails, in which case the section is simply omitted. Cached for sync rebuilds.
let _usageImg = null;

// Refresh the cached menu body + tray icon color + review notifications. `tray` is the
// Tray instance (recolored by state); `refreshMenu` re-invokes the caller so a click can
// rebuild the data.
async function refreshMenuData(tray, refreshMenu) {
  // The PR snapshot (/api/prs/tray) is read alongside the tabs, but only to attach CI
  // dots, fire review notifications, and color the menu-bar icon for ALL pending
  // reviews (not just opened ones). fetchJSON returns [] on error.
  const [tabData, prs, usage, settings] = await Promise.all([
    fetchJSON('/api/tabs'),
    fetchJSON('/api/prs/tray'),
    fetchJSON('/api/usage'),
    fetchJSON('/api/settings'),
  ]);
  // /api/usage is SWR-cached server-side, so this 60s/blur fetch is cheap. fetchJSON
  // returns [] on error → renderUsageImage sees no .limits and yields null (no section).
  // Render the agent the user selected in the dashboard widget (persisted setting).
  const agentKey = (settings && settings.usageAgent) || 'claude';
  _usageImg = await renderUsageImage(usage, agentKey).catch(() => null);
  const tabs = (tabData && tabData.tabs) || [];
  const prList = Array.isArray(prs) ? prs : [];
  const prByUrl = {};
  for (const p of prList) if (p && p.url) prByUrl[p.url] = p;

  const github = tabs.filter(t => t.kind === 'github');
  // Mine / Review / Jira mirror your OPEN tabs, split by sidebar GROUP (tabGroup → prGroup
  // off the live snapshot) — NOT raw category, so a PR I only commented on (category 'other')
  // stays under Review instead of falling into Mine. "Review requested" (below) is the
  // broader master list — every PR awaiting review from the snapshot, opened or not.
  const taskTabs   = github.filter(t => tabGroup(t, prByUrl) !== 'review');
  const reviewTabs = github.filter(t => tabGroup(t, prByUrl) === 'review');
  const jiraTabs   = tabs.filter(t => t.kind === 'jira');

  // Notifications + icon color track ALL pending reviews from the snapshot, independent
  // of which tabs are open — so a newly-requested review still alerts you even unopened.
  const openPRs = prList.filter(p => !p.error && p.state === 'OPEN');
  const mine   = openPRs.filter(p => p.category === 'mine');
  const review = openPRs.filter(p => p.category === 'review');

  // Pre-load each author avatar we're about to render (unique logins, in parallel) so the
  // section builders below can read them synchronously from the cache.
  const logins = new Set();
  for (const pr of review) if (pr.author?.login) logins.add(pr.author.login);
  for (const t of [...taskTabs, ...reviewTabs]) { const l = prByUrl[t.url]?.author?.login; if (l) logins.add(l); }
  await Promise.all([...logins].map(loadAvatar));

  const tabItems = [
    ...tabSection('Mine', taskTabs, prByUrl),
    ...tabSection('Review', reviewTabs, prByUrl),
    ...tabSection('Jira', jiraTabs, prByUrl),
  ];

  // "Review requested": every PR awaiting your review, opened or not — MINUS the ones
  // you've already opened (reviewPending is false once viewed, until a newer request
  // re-surfaces it; computed server-side from persisted viewed_at — see server.js).
  // Clicking opens the PR (focusing its tab if already open).
  const reviewReqItems = prMenuItems('Review requested', review.filter(pr => pr.reviewPending), refreshMenu);

  // Notify + play a sound on any newly-requested review.
  detectReviewChanges(review);

  // Icon color by state: red = review requested, blue = only your tasks, green = clear.
  const steadyState = review.length ? 'review' : mine.length ? 'tasks' : 'idle';
  if (tray) {
    tray.setImage(trayIcon(steadyState));
    tray.setTitle('');
  }

  // Review requested on top (the priority — others are waiting on you), then your opened
  // Tasks/Jira tabs. Separator between only when both exist; placeholder when empty.
  let body = (reviewReqItems.length && tabItems.length)
    ? [...reviewReqItems, { type: 'separator' }, ...tabItems]
    : [...reviewReqItems, ...tabItems];
  if (!body.length) body = [{ label: 'Nothing to review or open', enabled: false }];
  _body = body;
}

// Assemble the tray menu from the cached body. (The RAM/CPU usage readout moved to the
// Settings page — see public/js/views/settings.js — so nothing is computed per build.)
function buildMenuNow() {
  // Claude usage (Session/Weekly) sits just above Quit, with its own separator. Clicking
  // it opens the dashboard, where the full usage widget lives. Omitted when there's no
  // rendered image (no plan-limit data, or a render failure).
  const openDashboard = () => runInApp("window.showPage && window.showPage('dashboard')");
  const usage = _usageImg
    ? [{ label: '', icon: _usageImg, enabled: true, click: openDashboard }, { type: 'separator' }]
    : [];
  return Menu.buildFromTemplate([
    { label: 'Open TaskHub', click: () => openWindow() },
    { type: 'separator' },
    ...(_body || [{ label: 'Loading…', enabled: false }]),
    { type: 'separator' },
    ...usage,
    { label: 'Quit', click: () => quitApp() }, // the ONE sanctioned exit — see window.js
  ]);
}

module.exports = { refreshMenuData, buildMenuNow };
