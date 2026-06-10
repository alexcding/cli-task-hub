// Central renderer state — the single place mutable app state lives. Modules read
// and write `state` and call each other's render functions; nothing else holds
// long-lived data. (Views are functions of this state; see views/*.)

// Default code-font sizes (px). The single JS source — fonts.js imports these to seed,
// clamp, and reset. index.html carries a matching CSS copy (--term-font-size /
// --diff-font-size) for the pre-JS paint only; keep the two in sync if these change.
export const FONT_DEFAULTS = { term: 13, diff: 12 };

export const state = {
  // Projects + navigation
  projects: [],
  activeProjectId: null,

  // Webview tabs (the embedded GitHub/Jira viewer)
  tabs: [],            // { id, kind:'github'|'jira', title, url, wv, loaded, started, repo, branch, jiraKey, prSplit, category, termId }
  activeTabId: null,
  tabsReady: false,    // false until restoreTabs() has merged the saved set

  // Terminals (xterm views bound to main-process PTYs)
  terms: new Map(),    // id -> { el, term, fit, off, offExit, cwd, title, paired, pairKey, hasContext }
  activeTermId: null,
  tabTermInit: null,   // promise: tabs restored + PTYs rehydrated (awaited by ensurePrTerminal)

  // Jira snapshots + filters
  mineSnap: { items: [] },
  sprintSnap: { items: [] },
  ticketFilters: null,  // {project,status,...}; null = not loaded yet
  projJiraSnap: {},     // projectId -> last snapshot
  projJiraFilters: {},  // projectId -> filters object

  // Jira ticket link base — auto-detected from acli (or settings override), never hardcoded.
  jiraBase: '',
  knownStatuses: new Set(),

  // PR ↔ terminal split fraction (PR pane share), persisted in localStorage.
  prRatio: parseFloat(localStorage.getItem('taskhub.prRatio')) || 0.6,

  // Code fonts (Settings → Appearance; ⌘+/⌘− adjust the size of the pane in view).
  // Terminal and diff pane each have their own family + size, persisted in taskhub.db
  // settings; family '' = the default stack (see codeFontStack in util.js).
  fonts: {
    term: { family: '', size: FONT_DEFAULTS.term },
    diff: { family: '', size: FONT_DEFAULTS.diff },
  },
};

export const activeTab = () => state.tabs.find(t => t.id === state.activeTabId) || null;

// Replace the project list while keeping the live `prs` already loaded for matching
// projects. The bare /api/projects feed (Jira/Settings/project CRUD) carries no PRs;
// blindly assigning it would drop the PR data the sidebar reads for author avatars,
// flickering each row back to the GitHub octicon until the next dashboard load.
export function setProjects(list) {
  const prevPrs = new Map(state.projects.map(p => [p.id, p.prs]));
  state.projects = (list || []).map(p =>
    p.prs ? p : (prevPrs.has(p.id) ? { ...p, prs: prevPrs.get(p.id) } : p));
}

// ── Lookups over loaded data ──────────────────────────────────────────────────
// A loaded PR (with its CI status) by URL, across all project groups.
export function prByUrl(url) {
  for (const g of state.projects) {
    const pr = (g.prs || []).find(p => p.url === url);
    if (pr) return pr;
  }
  return null;
}

// Which sidebar/tab group a PR belongs to: 'review' if it's still in my review orbit
// (awaiting my review — includes PRs I've only commented on, where `category` has fallen
// back to 'other'), else 'mine'. Single source of truth so a PR opened from the dashboard's
// "Review Requested" section lands under the sidebar's "Review" group, not "Mine". Mirrors
// the dashboard filter; falls back to category for snapshots predating awaitingMyReview.
export const prGroup = pr => ((pr?.awaitingMyReview ?? (pr?.category === 'review')) ? 'review' : 'mine');

// A loaded Jira ticket by key, across the cached snapshots (mine, sprint, per-project).
export function jiraByKey(key) {
  const pools = [state.mineSnap?.items, state.sprintSnap?.items,
                 ...Object.values(state.projJiraSnap || {}).map(s => s && s.items)];
  for (const items of pools) {
    const it = (items || []).find(x => x.key === key);
    if (it) return it;
  }
  return null;
}

// The project that owns a PR (by url), so we can root its terminal in that project's
// local workspace; null cwd → main falls back to the app's own repo.
export const projectByPrUrl = url => state.projects.find(g => (g.prs || []).some(p => p.url === url)) || null;
export const projectByRepo  = repo => repo ? state.projects.find(p => p.repo === repo) || null : null;

// The project that owns a Jira ticket, matched on the key's project prefix
// (RECORD-1234 → RECORD) against each project's configured jiraProjectKey.
export function projectByJiraKey(key) {
  const prefix = (key || '').split('-')[0].toUpperCase();
  if (!prefix) return null;
  return state.projects.find(p => (p.jiraProjectKey || '').toUpperCase() === prefix) || null;
}

// Shared tab/menu title formats. Keep in sync with tray.js (prMenuItems / openLinkInApp)
// so a PR/ticket reads identically whether opened from a card, a badge, or the menu:
//   GitHub → "PR #1233 <title>"      Jira → "RECORD-2158 <summary>"
export const prTabTitle   = pr => `PR #${pr.number} ${pr.title}`;
export const jiraTabTitle = (key, sum) => sum ? `${key} ${sum}` : key;
