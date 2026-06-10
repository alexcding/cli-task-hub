// Central renderer state — the single place mutable app state lives. Modules read
// and write `state` and call each other's render functions; nothing else holds
// long-lived data. (Views are functions of this state; see views/*.)
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
};

export const activeTab = () => state.tabs.find(t => t.id === state.activeTabId) || null;

// ── Lookups over loaded data ──────────────────────────────────────────────────
// A loaded PR (with its CI status) by URL, across all project groups.
export function prByUrl(url) {
  for (const g of state.projects) {
    const pr = (g.prs || []).find(p => p.url === url);
    if (pr) return pr;
  }
  return null;
}

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
