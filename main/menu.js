// Builds the tray context menu. The menu LIST mirrors the app's open tabs (same
// /api/tabs source as the sidebar), grouped exactly like the sidebar, plus the
// "Review requested" master list and the resource-usage readout.
const { Menu } = require('electron');
const { fetchJSON } = require('./server-supervisor');
const { openWindow, openLinkInApp } = require('./window');
const { trayIcon, avatarIcon, loadAvatar, jiraIcon } = require('./icons');
const { detectReviewChanges, acknowledgedReviews, prKey } = require('./notifications');
const { computeUsage, fmtKB } = require('./usage');

// Build a labeled section of open-tab menu items. Each item maps 1:1 to a sidebar row
// and clicking it focuses that exact tab. Titles are the ones saved on the tab
// (produced by the renderer's prTabTitle/jiraTabTitle at open time), so they read
// identically in both places. GitHub tabs show the PR author's avatar with a CI badge
// (looked up in prByUrl); Jira tabs show Jira's blue diamond mark.
// Truncate long titles so the menu doesn't stretch wide; trimEnd() drops a trailing
// space that would otherwise leave a visible gap before the ellipsis.
const menuLabel = s => s.length > 40 ? s.slice(0, 40).trimEnd() + '…' : s;

function tabSection(label, tabs, prByUrl) {
  if (!tabs.length) return [];
  const items = [{ label, enabled: false }];
  for (const t of tabs) {
    const title = t.title || t.url;
    const item = {
      label: menuLabel(title),
      click: () => openLinkInApp(t.url, title, t.kind),
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
      // Clicking acknowledges the request (hides it from "Review requested" until a
      // re-request) and opens it as a tab; rebuild so it drops on the next menu open.
      click: () => { acknowledgedReviews.add(prKey(pr)); openLinkInApp(pr.url, full, 'github'); refreshMenu(); },
    });
  }
  return items;
}

// `tray` is the Tray instance (recolored by state); `refreshMenu` re-invokes the caller
// so a click can rebuild the menu.
async function buildMenu(tray, refreshMenu) {
  // The PR snapshot (/api/prs/tray) is read alongside the tabs, but only to attach CI
  // dots, fire review notifications, and color the menu-bar icon for ALL pending
  // reviews (not just opened ones). fetchJSON returns [] on error.
  const [tabData, prs] = await Promise.all([
    fetchJSON('/api/tabs'),
    fetchJSON('/api/prs/tray'),
  ]);
  const tabs = (tabData && tabData.tabs) || [];
  const prList = Array.isArray(prs) ? prs : [];
  const prByUrl = {};
  for (const p of prList) if (p && p.url) prByUrl[p.url] = p;

  const github = tabs.filter(t => t.kind === 'github');
  // Tasks / Review / Jira mirror your OPEN tabs (split by saved category — anything not
  // 'review' falls under Tasks, matching the renderer's ghCat). "Review requested"
  // (below) is the broader master list — every PR awaiting your review from the
  // snapshot, opened or not — so an unopened request is never missed.
  const taskTabs   = github.filter(t => t.category !== 'review');
  const reviewTabs = github.filter(t => t.category === 'review');
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
  // you've already clicked (acknowledged). A re-request clears the ack and re-surfaces it
  // (see notifications.js). Clicking opens the PR (focusing its tab if already open).
  const reviewReqItems = prMenuItems('Review requested', review.filter(pr => !acknowledgedReviews.has(prKey(pr))), refreshMenu);

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

  // Total RAM + CPU across every TaskHub process, with a per-component breakdown in the
  // submenu. Refreshed whenever the menu rebuilds (every 60s and on window blur).
  const usage = computeUsage();
  const usageItem = {
    label: `App Usage — CPU ${Math.round(usage.totalCPU)}% · Memory ${fmtKB(usage.totalKB)}`,
    submenu: usage.breakdown.map(b => ({ label: `${b.label}: ${fmtKB(b.kb)} · ${Math.round(b.cpu)}% CPU`, enabled: false })),
  };

  return Menu.buildFromTemplate([
    { label: 'Open TaskHub', click: () => openWindow() },
    { type: 'separator' },
    ...body,
    { type: 'separator' },
    usageItem,
    { label: 'Quit', click: () => require('electron').app.quit() },
  ]);
}

module.exports = { buildMenu };
