// Embedded viewer: the Electron app embeds the real GitHub/Jira page in a <webview>
// (the main process strips X-Frame-Options/CSP so framing is allowed). Opened links
// live as tabs in the left nav; activating one shows it full-width here.
import { ROUTES } from '/shared/routes.mjs';
import { state, activeTab, prByUrl, prGroup, prTabTitle, jiraTabTitle, jiraByKey } from '../stores/store.js';
import { api, apiJson } from '../services/api.js';
import { esc, jiraKeyFromUrl, canSplitTerminal, ghAvatarSrc } from '../lib/util.js';
import { ICON } from '../lib/icons.js';
import { toast, toastErr } from './toast.js';
import { renderTabs } from './sidebar.js';
import { openMenu } from './menu.js';
import { disposeTerm, visibleTerm } from './terminal.js';
import { ensurePrTerminal, applyPrLayout, clearPrLayout, resolveTabFolder } from './split.js';
import { hideDiffPane } from './diff.js';

let _tabSeq = 0;

// Open a URL as a tab in the left nav. New tabs append at the bottom; re-opening an
// already-open URL just focuses it (keeps its position).
export function openInSplit(url, title, kind, meta = {}) {
  const existing = state.tabs.find(t => t.url === url);
  if (existing) {
    ensurePanelOpen();
    activateTab(existing.id);
    return;
  }
  const tab = createTab(url, title, kind, meta);
  state.tabs.push(tab);
  ensurePanelOpen();
  activateTab(tab.id);
}

// Build a <webview>-backed tab object (not yet added to state.tabs). Shared by
// openInSplit (new tab) and restoreTabs (rehydrate from the server-saved set).
export function createTab(url, title, kind, meta = {}) {
  const id = 'tab' + (++_tabSeq);
  const wv = document.createElement('webview');
  // Perf: (1) lazy — `src` is set on first activation (see activateTab), so restored
  // and background tabs don't all load at once; (2) throttle when hidden.
  // NOTE: deliberately NO `partition` — webviews must use the default session so they
  // share your existing GitHub/Jira login cookies AND get the X-Frame-Options stripping
  // applied to session.defaultSession in tray.js (allowFraming).
  wv.setAttribute('webpreferences', 'backgroundThrottling=yes');
  wv.setAttribute('allowpopups', '');
  wv.style.display = 'none';
  document.getElementById('split-body').appendChild(wv);
  // repo/branch (for GitHub PRs) let the terminal map to the right project workspace +
  // worktree without depending on state.projects still holding PR data.
  // category ('mine'|'review') and login (the PR author) are persisted like repo/branch
  // so a GitHub tab keeps its sidebar group AND its author avatar across restarts and even
  // after its PR merges and leaves the snapshot — neither depends on state.projects still
  // holding the PR. Live data refreshes both (see views/dashboard.js); '' until known.
  // avatar is the author's avatar frozen as a data URI at open time (freezeAvatar): a
  // pinned tab keeps the exact image even if the live PR vanishes or the author changes
  // their picture. '' until fetched; falls back to the live github.com/<login>.png URL.
  const tab = { id, kind: kind === 'jira' ? 'jira' : 'github', title: title || url, url, wv, loaded: false, started: false, repo: meta.repo || '', branch: meta.branch || '', jiraKey: meta.jiraKey || jiraKeyFromUrl(url), prSplit: !!meta.prSplit, paneView: meta.paneView === 'diff' ? 'diff' : 'term', category: meta.category || '', login: meta.login || '', avatar: meta.avatar || '' };
  wv.addEventListener('did-stop-loading', () => { tab.loaded = true; if (id === state.activeTabId) showSplitLoading(false); });
  // Keep the Back button's enabled state in sync as the user navigates within the tab.
  const onNav = () => { if (id === state.activeTabId) updateNavButtons(); };
  wv.addEventListener('did-navigate', onNav);
  wv.addEventListener('did-navigate-in-page', onNav);
  return tab;
}

// ── Tab persistence ─────────────────────────────────────────────────────────────
// Open tabs live only in state.tabs (renderer memory), so they're lost when the window
// reloads or the app restarts. Persist the full ordered list to taskhub.db (server)
// on every change and rehydrate it on launch via /api/tabs.
export function saveTabs() {
  // Don't persist before the saved set has been read back in — otherwise a tab opened
  // from the tray (which fires on did-finish-load, before our async restore lands) would
  // PUT a single-tab list and wipe everything else.
  if (!state.tabsReady) return;
  const active = activeTab();
  api(ROUTES.TABS, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tabs: state.tabs.map(t => ({ kind: t.kind, title: t.title, url: t.url, repo: t.repo, branch: t.branch, jiraKey: t.jiraKey, prSplit: t.prSplit, paneView: t.paneView, category: t.category, login: t.login, avatar: t.avatar })),
      active: active ? active.url : null,
    }),
  }).catch(() => {});
  // Note: we don't push a tray refresh here. The tray pulls the latest saved tabs itself when
  // it's about to open (main's blur handler → tabs-only refresh), so persisting is enough.
}

export async function restoreTabs() {
  // Read the saved set first. If the server is briefly unreachable, retry a few times
  // rather than proceeding — state.tabsReady stays false so saveTabs() can't overwrite
  // (and wipe) tabs we were never able to read. taskhub.db is the source of truth.
  let data = null;
  for (let i = 0; i < 5 && !data; i++) {
    try { data = await api(ROUTES.TABS); }
    catch { await new Promise(r => setTimeout(r, 200)); }
  }
  if (!data) return;
  const saved = Array.isArray(data.tabs) ? data.tabs : [];
  for (const t of saved) {
    // A tab opened from the tray may already be in state.tabs by the time restore lands —
    // skip it so we don't double-add.
    if (t && t.url && !state.tabs.some(x => x.url === t.url)) {
      state.tabs.push(createTab(t.url, t.title, t.kind, { repo: t.repo, branch: t.branch, jiraKey: t.jiraKey, prSplit: t.prSplit, paneView: t.paneView, category: t.category, login: t.login, avatar: t.avatar }));
    }
  }
  state.tabsReady = true;
  // Rehydrate the tabs into the sidebar nav, but keep the Dashboard selected on
  // launch — don't auto-activate a saved GitHub/Jira tab and switch the view away.
  if (state.tabs.length) renderTabs();
  saveTabs(); // persist the merged set (covers a tray tab opened before restore landed)
}

// Make the viewer visible: it replaces the content full-width (open tabs live in the
// left nav, so <main> is hidden while a tab is shown).
export function ensurePanelOpen() {
  document.getElementById('split').hidden = false;
  document.body.classList.add('viewing-tab'); // hides <main>, viewer fills the area
}

export function activateTab(id) {
  state.activeTabId = id;
  state.activeTermId = null;                  // showing a page, not a terminal
  document.body.classList.remove('viewing-term');
  // Lazy load: only kick off the page load the first time a tab is shown.
  const cur = state.tabs.find(t => t.id === id);
  if (cur && cur.wv && !cur.started) { cur.started = true; cur.wv.setAttribute('src', cur.url); }
  hideAllPanes();
  if (cur && cur.wv) cur.wv.style.display = '';
  document.getElementById('split').hidden = false;
  document.body.classList.add('viewing-tab');
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active')); // a tab is the view now
  const t = activeTab();
  showSplitLoading(t ? !t.loaded : false);
  updateNavButtons();
  // PR ↔ terminal split: a GitHub PR shows a paired terminal to its right when ITS own
  // `prSplit` is on (per-tab, default off). Switching tabs reveals it instantly (no slide).
  if (canSplitTerminal(cur) && cur.prSplit && window.taskhub?.term) {
    ensurePrTerminal(cur).then(() => { if (state.activeTabId === cur.id) applyPrLayout(cur); });
  } else {
    clearPrLayout();
  }
  document.getElementById('split-toggle-term')?.classList.toggle('on', !!(canSplitTerminal(cur) && cur.prSplit));
  renderTabs();
  saveTabs();
}

// Hide every pane in the viewer (webview tabs + terminals + diff). The caller then
// shows one; applyPrLayout re-adds pane-diff when the incoming tab is in diff view.
export function hideAllPanes() {
  state.tabs.forEach(t => { if (t.wv) t.wv.style.display = 'none'; });
  for (const t of state.terms.values()) t.el.style.display = 'none';
  hideDiffPane();
  document.body.classList.remove('pane-diff');
}

function pairedTermHasContext(tab) {
  return !!(tab && tab.termId && state.terms.get(tab.termId)?.hasContext);
}

export function confirmCloseTabTerminals(tabs) {
  const contextual = tabs.filter(pairedTermHasContext);
  if (!contextual.length) return true;
  if (contextual.length === 1) {
    const title = contextual[0].title || 'this task';
    return confirm(`Close "${title}" and stop its terminal?\n\nThe terminal has input/history that will be lost.`);
  }
  return confirm(`Close ${contextual.length} tabs and stop their terminals?\n\nThese terminals have input/history that will be lost.`);
}

export function closePairedTerm(tab) {
  if (!tab?.termId) return;
  disposeTerm(tab.termId);
  tab.termId = null;
}

export function closeTab(id) {
  const i = state.tabs.findIndex(t => t.id === id);
  if (i < 0) return;
  const tab = state.tabs[i];
  if (!confirmCloseTabTerminals([tab])) return;
  closePairedTerm(tab);
  tab.wv?.remove();
  state.tabs.splice(i, 1);
  if (state.activeTabId === id) {
    const next = state.tabs[i] || state.tabs[i - 1];
    if (next) activateTab(next.id);
    else closeSplit();           // last tab closed → close the panel
  } else {
    renderTabs();
    saveTabs();
  }
}

export function closeSplit() {
  if (!confirmCloseTabTerminals(state.tabs)) return;
  state.tabs.forEach(t => { closePairedTerm(t); t.wv?.remove(); });
  state.tabs = []; state.activeTabId = null; state.activeTermId = null;
  document.getElementById('split').hidden = true;
  document.body.classList.remove('viewing-tab', 'viewing-term', 'pr-split', 'pane-diff'); // restore <main>
  renderTabs(); // clear tab rows; paired terminals were stopped above
  saveTabs();
}

export function splitBack()    { const t = activeTab(); try { if (t && t.wv.canGoBack()) t.wv.goBack(); } catch {} }
export function splitForward() { const t = activeTab(); try { if (t && t.wv.canGoForward()) t.wv.goForward(); } catch {} } // no toolbar button — ⌘] only
export function splitHome()  { const t = activeTab(); if (t && t.wv) { t.loaded = false; showSplitLoading(true); t.wv.loadURL(t.url); } } // back to the tab's default link
export function showSplitLoading(on) { document.getElementById('split-loading').hidden = !on; }
// Grey out Back when the active tab has no history to go back to.
export function updateNavButtons() { const t = activeTab(); const b = document.getElementById('split-back'); if (b) { let can = false; try { can = !!(t && t.wv && t.started && t.wv.canGoBack()); } catch {} b.disabled = !can; } }

// Titles: PR/page title in the webview segment. In split mode the pane's name lives on
// the active view-switch button (segmented control), so the segment title stays empty;
// a solo full-width terminal (no switch visible) still gets the "Terminal" label.
export function updateTitles() {
  const st = document.getElementById('split-title');
  const tt = document.getElementById('term-title');
  if (st) {
    const t = state.activeTermId ? null : activeTab();
    if (!t) { st.innerHTML = ''; }
    else {
      const login = t.kind === 'github' ? (prByUrl(t.url)?.author?.login || t.login) : '';
      // Prefer the frozen data URI; fall back to the live github.com URL until it's fetched.
      const src = ghAvatarSrc(login, t.avatar);
      const avatar = src ? `<img src="${src}" alt="" title="${esc(login)}" loading="lazy">` : '';
      st.innerHTML = avatar + `<span class="stitle-text">${esc(t.title || '')}</span>`;
    }
  }
  if (tt) tt.textContent = (state.activeTermId && visibleTerm()) ? 'Terminal' : '';
  updateFolderChip();
}

// Folder chip (right of the webview segment): shows the active tab's local folder — the
// project workspace, or its git worktree (worktree glyph + delete menu) — or a "Create
// worktree" CTA when the branch isn't checked out anywhere yet. Resolution hits
// /api/worktree (a `git worktree list` server-side), so guards keep it cheap and correct:
// a (key + short TTL) short-circuit collapses the burst of updateTitles calls an SSE sync
// triggers, yet still re-resolves within a few seconds so a worktree created/removed OUTSIDE
// the app (e.g. in a terminal) is picked up; and a request-counter + active-tab check drop a
// stale async result if the user switches tabs mid-resolve. Pass force=true after an in-app
// create/remove to refresh immediately.
const FOLDER_TTL = 5000;
let _folderReq = 0;
let _folderKey = null;
let _folderAt = 0;
async function updateFolderChip(force = false) {
  const el = document.getElementById('split-folder');
  const addBtn = document.getElementById('split-folder-add');
  if (!el) return;
  const hideChip = () => { el.hidden = true; el.dataset.path = ''; el.dataset.worktree = ''; el.dataset.workspace = ''; };
  const hideAdd = () => { if (addBtn) { addBtn.hidden = true; addBtn.dataset.workspace = ''; addBtn.dataset.branch = ''; } };
  const t = state.activeTermId ? null : activeTab();
  const branch = t && t.kind === 'github' ? (t.branch || prByUrl(t.url)?.headRefName || '') : '';
  // The tab + its branch/key decide the folder; skip the resolve when that's unchanged AND
  // we resolved recently (TTL), so a sync burst doesn't spawn a git process each time while
  // an external worktree change still surfaces within FOLDER_TTL. create/remove force=true.
  const key = !t ? '' : `${t.id}|${t.kind}|${t.kind === 'jira' ? (t.jiraKey || jiraKeyFromUrl(t.url) || '') : branch}`;
  const now = Date.now();
  if (!force && key === _folderKey && now - _folderAt < FOLDER_TTL) return;
  _folderAt = now;
  _folderKey = key;

  if (!t || (t.kind !== 'github' && t.kind !== 'jira')) { hideChip(); hideAdd(); return; }
  const reqId = ++_folderReq;
  const tabId = t.id;
  const info = await resolveTabFolder(t).catch(() => null);
  if (reqId !== _folderReq || state.activeTabId !== tabId) return; // tab switched mid-resolve
  if (!info || !info.path) { hideChip(); hideAdd(); return; }

  // Branch not checked out anywhere yet + a known PR branch → encourage a dedicated
  // worktree with a "Create worktree" CTA. (When it's already in the main checkout we fall
  // through to the plain folder chip instead of offering a create that git would reject.)
  if (!info.matched && info.workspace && branch && addBtn) {
    hideChip();
    addBtn.dataset.workspace = info.workspace;
    addBtn.dataset.branch = branch;
    addBtn.title = `Create a worktree for ${branch}`;
    addBtn.innerHTML = ICON.worktree + '<span class="fa-label">Create worktree</span>';
    addBtn.hidden = false;
    return;
  }

  // Otherwise show the folder chip: the worktree glyph for a dedicated worktree, or the
  // plain folder for the main checkout / a tab we can't fork — both reveal in Finder.
  hideAdd();
  const isWorktree = !!info.isWorktree;
  const name = info.path.split('/').filter(Boolean).pop() || info.path;
  el.dataset.path = info.path;
  // A worktree carries its workspace so the right-click menu can offer deletion (the main
  // checkout can't be deleted, so it leaves these blank).
  el.dataset.worktree = isWorktree ? '1' : '';
  el.dataset.workspace = isWorktree ? (info.workspace || '') : '';
  el.title = (isWorktree ? 'Worktree — reveal in Finder (right-click for more) — ' : 'Reveal in Finder — ') + info.path;
  el.classList.toggle('is-worktree', isWorktree);
  el.innerHTML = `<span class="fc-ic">${isWorktree ? ICON.worktree : ICON.folder}</span>`
    + `<span class="fc-text">${esc(name)}</span>`;
  el.hidden = false;
}

// Reveal the active tab's resolved folder in the system file manager.
export function openTabFolder() {
  const p = document.getElementById('split-folder')?.dataset.path;
  if (p && window.taskhub?.openPath) window.taskhub.openPath(p);
}

// Right-click the folder chip → reveal in Finder always, plus "Delete worktree" when the
// chip is a worktree (not the shared main checkout). Uses the shared context menu.
export function folderMenu(e) {
  const el = document.getElementById('split-folder');
  if (!el || el.hidden) return false;
  return openMenu(e, [
    { label: 'Reveal in Finder', onClick: openTabFolder },
    el.dataset.worktree === '1' && { label: 'Delete worktree…', onClick: removeTabWorktree, danger: true },
  ]);
}

// Delete the chip's worktree (after confirming), then re-resolve so the chip falls back
// to the plain checkout / create CTA. The branch is left intact.
export async function removeTabWorktree() {
  const el = document.getElementById('split-folder');
  const workspace = el?.dataset.workspace, worktree = el?.dataset.path;
  if (!workspace || !worktree) return;
  if (!confirm(`Delete this worktree?\n\n${worktree}\n\nThe folder is removed; the branch is kept. Uncommitted changes there will block deletion.`)) return;
  try {
    const r = await apiJson(ROUTES.WORKTREE_REMOVE, 'POST', { path: workspace, worktree });
    if (r.error) { toastErr(r.error); return; }
    toast('Worktree deleted');
    updateFolderChip(true);
  } catch (e) {
    toastErr('Failed to delete worktree: ' + e.message);
  }
}

// Create a git worktree for the active tab's PR branch (sibling of the project workspace),
// then re-resolve the chip so it flips to the new worktree.
export async function createTabWorktree() {
  const btn = document.getElementById('split-folder-add');
  const workspace = btn?.dataset.workspace, branch = btn?.dataset.branch;
  if (!workspace || !branch) return;
  btn.disabled = true;
  try {
    const r = await apiJson(ROUTES.WORKTREE, 'POST', { path: workspace, branch });
    if (r.error) { toastErr(r.error); return; }
    toast(`Worktree created for ${branch}`);
    updateFolderChip(true);
  } catch (e) {
    toastErr('Failed to create worktree: ' + e.message);
  } finally {
    btn.disabled = false;
  }
}

// PR card / Jira badge click handlers. repo/branch are passed from the card (so the
// terminal can map to the project workspace + worktree even when projects lost their PRs).
export function openPrSplit(url, num, repo, branch) {
  const pr = prByUrl(url);
  const login = pr?.author?.login;
  // Persist the sidebar GROUP ('mine'|'review'), not the raw category — a PR I've only
  // commented on is category 'other' but belongs under Review (see prGroup).
  openInSplit(url, pr ? prTabTitle(pr) : `PR ${num}`, 'github', { repo: repo || pr?.repo, branch: branch || pr?.headRefName, category: pr ? prGroup(pr) : '', login });
  freezeAvatar(url, login);
}

// Freeze the PR author's avatar onto the tab: fetch the PNG bytes once (via main) and store
// them as a data URI, so the tab keeps the exact image even after the live PR leaves the
// snapshot or the author changes their picture. Only fetches on a fresh open — a restored
// tab already carries its frozen bytes, so reopening a PR is what re-freshes the image.
async function freezeAvatar(url, login) {
  if (!login || !window.taskhub?.fetchAvatar) return;
  const tab = state.tabs.find(t => t.url === url);
  if (!tab || tab.avatar) return;            // restored/already frozen → leave it
  const data = await window.taskhub.fetchAvatar(login).catch(() => null);
  if (!data) return;
  const live = state.tabs.find(t => t.url === url);   // may have closed mid-fetch
  if (!live) return;
  live.avatar = data;
  saveTabs();
  renderTabs();
}

export function jiraClick(e, url, key) {
  e.stopPropagation();   // don't trigger a parent PR card
  e.preventDefault();    // open in the embedded viewer, not the <a> href
  const it = jiraByKey(key);
  openInSplit(url, jiraTabTitle(key, it && it.summary), 'jira', { jiraKey: key });
}

// Expose the open tabs + activation to the Electron main process, so the tray menu
// can list them and clicking one focuses the window + switches to that tab.
export function initTrayBridge() {
  window.__getTabs = () => state.tabs.map(t => ({ id: t.id, kind: t.kind, title: t.title, url: t.url, active: t.id === state.activeTabId }));
  window.__activateTabByUrl = url => { const t = state.tabs.find(x => x.url === url); if (t) { ensurePanelOpen(); activateTab(t.id); } };
  // Open a link from the tray inside the embedded viewer (new tab, or focus if open).
  // The tray passes the PR's category so the tab lands in the right sidebar group and
  // keeps it across restarts; backfill an already-open tab whose saved category is stale
  // (e.g. opened category-less before this) so it re-groups immediately.
  window.__openTab = (url, title, kind, category) => {
    const existing = state.tabs.find(t => t.url === url);
    if (existing && category && existing.category !== category) { existing.category = category; saveTabs(); }
    openInSplit(url, title, kind, { category });
  };
}
