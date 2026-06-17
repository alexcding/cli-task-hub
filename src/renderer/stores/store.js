// Central renderer state — the single place mutable app state lives. Modules read
// and write `state` and call each other's render functions; nothing else holds
// long-lived data. (Views are functions of this state; see views/*.)

import { PR_CATEGORY, PR_GROUP } from '/shared/constants.mjs';

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
  sprintSnap: { items: [] },   // assigned to me, in an active sprint — the dashboard's "Current Sprint"
  boardSnap: { items: [] },   // the active project's sprint board (all assignees) — Scrumboard page
  boardProjectId: '',         // which project's board the Scrumboard is showing
  boardFilters: {},           // projectId -> assignee filter ('' = all, '__unassigned__', or accountId)
  projJiraSnap: {},     // projectId -> last snapshot
  projJiraFilters: {},  // projectId -> filters object

  // Jira ticket link base — auto-detected from acli (or settings override), never hardcoded.
  jiraBase: '',
  knownStatuses: new Set(),
  // Optimistic Scrumboard moves awaiting server confirmation: ticket key -> { status, statusId }.
  // A drop (or board status change) records the target here and the board renders the card in
  // that column immediately; the entry is held — surviving the stale-while-revalidate snapshot
  // reloads that fire on every sync — until a fetched board snapshot reports the new status
  // (Jira's search index lags a beat after a transition), then it's dropped. Prevents the card
  // bouncing back to its old column on the next sync. See reconcileBoardMoves / applyBoardMoves.
  pendingJiraMoves: new Map(),

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
export const prGroup = pr => ((pr?.awaitingMyReview ?? (pr?.category === PR_CATEGORY.REVIEW)) ? PR_GROUP.REVIEW : PR_GROUP.MINE);

// A loaded Jira ticket by key, across the cached snapshots (mine, sprint, per-project).
export function jiraByKey(key) {
  const pools = [state.sprintSnap?.items, state.boardSnap?.items,
                 ...Object.values(state.projJiraSnap || {}).map(s => s && s.items)];
  for (const items of pools) {
    const it = (items || []).find(x => x.key === key);
    if (it) return it;
  }
  return null;
}

// ── Optimistic Jira moves (sticky-optimistic status changes) ─────────────────────
// A status change (drag-drop on the board, or the status menu anywhere) is shown immediately
// and HELD across the stale-while-revalidate snapshot reloads that fire on every sync, until a
// fetched snapshot reports the new status (Jira's search index lags a beat after a transition).
// Applied at render time as copies — the snapshot is never mutated, so reconcile keeps comparing
// against the server's real status. Every Jira view (board, dashboard sprint, project tab) shares
// this, so none of them bounce. See doTransition / the render fns / the *PendingMoves callers.
// Give up holding a move only after this long. It MUST exceed the board snapshot's refresh
// latency, or the overlay is dropped before the server reflects the move and the card snaps
// back to its stale old column: the snapshot is stale only after 90s (jiraStale) and the Jira
// poll runs every ~120s, and the transition route doesn't re-sync the board — so confirmation
// can take ~2 min. 5 min leaves margin (slow acli queue / Jira search-index lag).
const MOVE_TTL_MS = 300_000;
let _moveSeq = 0;             // monotonic token so a stale failed transition can't revert a newer move

// Resolve a status NAME to its id by scanning loaded snapshots (every Jira item carries statusId).
// '' when the status isn't present anywhere — the overlay then keeps the card's own id (configured
// boards re-column only once a card with that status appears).
function jiraStatusId(name) {
  for (const snap of [state.boardSnap, state.sprintSnap, ...Object.values(state.projJiraSnap)])
    for (const it of (snap?.items || [])) if (it.status === name && it.statusId) return String(it.statusId);
  return '';
}

// Record an optimistic move; resolves the target status id up front so configured columns (which
// bucket by id) re-column even a name-only status-menu change. Returns a token the caller keeps so
// clearPendingMove can ignore a stale failure that a newer move on the same ticket has superseded.
export function recordPendingMove(key, status, statusId) {
  state.knownStatuses.add(status);
  const seq = ++_moveSeq;
  state.pendingJiraMoves.set(key, { status, statusId: statusId || jiraStatusId(status), at: Date.now(), seq });
  return seq;
}

// Drop a pending move only if it's still the one identified by `seq` (a newer move supersedes it).
export function clearPendingMove(key, seq) {
  if (state.pendingJiraMoves.get(key)?.seq === seq) state.pendingJiraMoves.delete(key);
}

// Release moves the server has confirmed (a freshly-fetched snapshot reports the target status/id)
// and expire stale ones. The full-map TTL sweep also reaps moves whose ticket never lands in this
// snapshot. Call on every fresh Jira snapshot fetch so whichever view is open does the reaping.
export function reconcilePendingMoves(snap) {
  const pend = state.pendingJiraMoves;
  if (!pend.size) return;
  const now = Date.now();
  for (const [k, mv] of pend) if (now - mv.at > MOVE_TTL_MS) pend.delete(k);
  for (const it of (snap?.items || [])) {
    const mv = pend.get(it.key);
    if (mv && (it.status === mv.status || (mv.statusId && String(it.statusId) === String(mv.statusId)))) pend.delete(it.key);
  }
}

// Overlay still-pending moves on top of snapshot items, as COPIES. Returns the input untouched
// when nothing is pending (the common case), so it's cheap to call from every render.
export function applyPendingMoves(items) {
  const pend = state.pendingJiraMoves;
  if (!pend.size) return items || [];
  return (items || []).map(it => {
    const mv = pend.get(it.key);
    return mv ? { ...it, status: mv.status, statusId: mv.statusId || it.statusId } : it;
  });
}

// Project by id — the page-level lookup shared by the project page and the Git tab.
export const projectById = id => state.projects.find(p => p.id === id) || null;

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
