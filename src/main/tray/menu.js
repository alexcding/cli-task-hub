// Builds the tray context menu. The menu LIST mirrors the app's open tabs (same
// /api/tabs source as the sidebar), grouped exactly like the sidebar, plus the
// "Review requested" master list.
const { Menu } = require('electron');
const { fetchJSON, postJSON } = require('../server/supervisor');
const { openWindow, openLinkInApp, runInApp, quitApp } = require('../windows/window');
const { trayIcon, trayPressedIcon, avatarIcon, loadAvatar, jiraIcon } = require('../native/icons');
const { detectReviewChanges } = require('../native/notifications');
const { renderUsageImage } = require('../native/usage-image');
const { PR_CATEGORY, PR_GROUP } = require('../../shared/constants.mjs');

// Build a labeled section of open-tab menu items. Each item maps 1:1 to a sidebar row
// and clicking it focuses that exact tab. Titles are the ones saved on the tab
// (produced by the renderer's prTabTitle/jiraTabTitle at open time), so they read
// identically in both places. GitHub tabs show the PR author's avatar with a CI badge
// (looked up in prByUrl); Jira tabs show Jira's blue diamond mark.
// Truncate long titles so the menu doesn't stretch wide; trimEnd() drops a trailing
// space that would otherwise leave a visible gap before the ellipsis.
const menuLabel = s => s.length > 40 ? s.slice(0, 40).trimEnd() + '…' : s;

// Sidebar GROUP for a PR — mirrors the renderer's store.prGroup. The category/group value
// strings come from the shared contract (src/shared/constants.mjs); main is CommonJS but can
// require() the .mjs (Node ≥22.12). 'review' when it's awaiting my review (falling back to
// category for snapshots predating awaitingMyReview), else 'mine'. A PR I've only commented on
// is category:'other' but belongs under Review — grouping on raw category sends it to Mine.
const prGroup = pr => ((pr?.awaitingMyReview ?? (pr?.category === PR_CATEGORY.REVIEW)) ? PR_GROUP.REVIEW : PR_GROUP.MINE);
// Group an open GitHub tab: prefer the live snapshot PR (source of truth, same as the
// sidebar); fall back to the group persisted on the tab (renderer backfills it via prGroup).
const tabGroup = (t, prByUrl) => { const pr = prByUrl[t.url]; return pr ? prGroup(pr) : (t.category === PR_CATEGORY.REVIEW ? PR_GROUP.REVIEW : PR_GROUP.MINE); };

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

// Lay out the menu body from the open tabs, the PR map (grouping + avatars), and the
// already-built "Review requested" section. Shared by the full refresh and the tabs-only
// refresh so the two produce an identical layout. Assumes the tabs' author avatars are
// already in the cache (the caller preloads them) since tabSection reads them synchronously.
function composeBody(tabs, prByUrl, reviewReqItems) {
  const github = tabs.filter(t => t.kind === 'github');
  const taskTabs   = github.filter(t => tabGroup(t, prByUrl) !== PR_GROUP.REVIEW);
  const reviewTabs = github.filter(t => tabGroup(t, prByUrl) === PR_GROUP.REVIEW);
  const jiraTabs   = tabs.filter(t => t.kind === 'jira');
  const tabItems = [
    ...tabSection('Mine', taskTabs, prByUrl),
    ...tabSection('Review', reviewTabs, prByUrl),
    ...tabSection('Jira', jiraTabs, prByUrl),
  ];
  let body = (reviewReqItems.length && tabItems.length)
    ? [...reviewReqItems, { type: 'separator' }, ...tabItems]
    : [...reviewReqItems, ...tabItems];
  if (!body.length) body = [{ label: 'Nothing to review or open', enabled: false }];
  return body;
}

// The fetched menu body (tab + review sections) is cached here so the tray can build a
// menu synchronously when it (re-)arms the context menu: refreshMenuData() renews it on
// the 60s tick / window blur, and buildMenuNow() assembles the full menu from it. (A menu
// must stay set via setContextMenu; popping one from a tray 'click' handler doesn't
// display on macOS — see tray.js.)
let _body = null;
// Last full refresh's PR map and "Review requested" section, cached so a tabs-only refresh
// (a tab switch changes only the open-tab list, not the PR snapshot) can rebuild the tab
// sections without re-fetching /api/prs/tray, /api/usage, /api/settings. Renewed on every
// full refreshMenuData(); read by refreshMenuTabs().
let _prByUrl = {};
let _reviewReqItems = [];
// The selected agent's Session/Weekly plan limits, rendered to one NativeImage
// (main/usage-image.js) and shown as a single row above Quit — same data + selected
// agent as the dashboard usage widget (/api/usage + the usageAgent setting). null when
// there's no limit data (e.g. not signed in) or a render fails → the section is simply
// omitted. Cached for sync rebuilds.
let _usageImg = null;
// Last successfully-fetched /api/settings, cached so the activity-notification decision
// (main.js) can read it synchronously instead of fetching per SSE event. Renewed on every
// full refreshMenuData() (60s tick / sync events / an explicit tray:refresh after a toggle);
// null until the first refresh → callers treat that as defaults (e.g. activityNotify on).
let _settings = null;
const getCachedSettings = () => _settings;

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
  // Keep the last good settings object (fetchJSON yields [] on error — don't cache that).
  if (settings && !Array.isArray(settings)) _settings = settings;
  const agentKey = (settings && settings.usageAgent) || 'claude';
  _usageImg = await renderUsageImage(usage, agentKey).catch(() => null);
  const tabs = (tabData && tabData.tabs) || [];
  const prList = Array.isArray(prs) ? prs : [];
  const prByUrl = {};
  for (const p of prList) if (p && p.url) prByUrl[p.url] = p;

  const github = tabs.filter(t => t.kind === 'github');

  // Notifications + icon color track ALL pending reviews from the snapshot, independent
  // of which tabs are open — so a newly-requested review still alerts you even unopened.
  const openPRs = prList.filter(p => !p.error && p.state === 'OPEN');
  const review = openPRs.filter(p => p.category === PR_CATEGORY.REVIEW);

  // Pre-load each author avatar we're about to render (unique logins, in parallel) so the
  // section builders read them synchronously from the cache.
  const logins = new Set();
  for (const pr of review) if (pr.author?.login) logins.add(pr.author.login);
  for (const t of github) { const l = prByUrl[t.url]?.author?.login; if (l) logins.add(l); }
  await Promise.all([...logins].map(loadAvatar));

  // "Review requested": every PR awaiting your review, opened or not — MINUS the ones
  // you've already opened (reviewPending is false once viewed, until a newer request
  // re-surfaces it; computed server-side from persisted viewed_at — see server.js).
  // Clicking opens the PR (focusing its tab if already open).
  const pendingReview = review.filter(pr => pr.reviewPending);
  const reviewReqItems = prMenuItems('Review requested', pendingReview, refreshMenu);

  // Notify + play a sound on any newly-requested review (sound chosen in Settings).
  detectReviewChanges(review, settings && settings.reviewSound);

  // Menu-bar icon: monochrome checkmark, plus a bronze dot when there are pending reviews
  // waiting on you (none → just the mono check). The pressed variant keeps it legible while
  // the tray menu is open (a non-template icon won't auto-invert against the highlight).
  if (tray) {
    const hasReview = pendingReview.length > 0;
    tray.setImage(trayIcon(hasReview));
    tray.setPressedImage(trayPressedIcon(hasReview));
    tray.setTitle('');
  }

  // Cache the PR-derived pieces so a tabs-only refresh can rebuild without re-fetching.
  _prByUrl = prByUrl;
  _reviewReqItems = reviewReqItems;
  _body = composeBody(tabs, prByUrl, reviewReqItems);
}

// Lightweight refresh for when only the open-tab list changed (a tab switch/open/close):
// re-read the saved tabs and rebuild the menu body, reusing the cached PR map + "Review
// requested" section from the last full refresh. Fetches only /api/tabs — no PR snapshot,
// usage, or settings — and leaves the menu-bar icon and review notifications (which track
// the PR snapshot, unchanged here) alone. Falls back gracefully before the first full
// refresh has populated the caches (empty map → tabs group by their persisted category).
async function refreshMenuTabs() {
  const tabData = await fetchJSON('/api/tabs');
  const tabs = (tabData && tabData.tabs) || [];
  // A tab opened since the last full refresh may have an author not yet in the avatar cache;
  // preload them so tabSection's synchronous icon lookup resolves (cheap — loadAvatar memoizes).
  const logins = new Set();
  for (const t of tabs) if (t.kind === 'github') { const l = _prByUrl[t.url]?.author?.login; if (l) logins.add(l); }
  await Promise.all([...logins].map(loadAvatar));
  _body = composeBody(tabs, _prByUrl, _reviewReqItems);
}

// Assemble the tray menu from the cached body. (The RAM/CPU usage readout moved to the
// Settings page — see src/renderer/pages/settings.js — so nothing is computed per build.)
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

module.exports = { refreshMenuData, refreshMenuTabs, buildMenuNow, getCachedSettings };
