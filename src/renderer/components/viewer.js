// Embedded viewer: the Electron app embeds the real GitHub/Jira page in a <webview>
// (the main process strips X-Frame-Options/CSP so framing is allowed). Opened links
// live as tabs in the left nav; activating one shows it full-width here.
import { ROUTES } from '/shared/routes.mjs';
import { state, activeTab, prByUrl, prGroup, prTabTitle, jiraTabTitle, jiraByKey } from '../stores/store.js';
import { api, apiJson } from '../services/api.js';
import { esc, jiraKeyFromUrl, canSplitTerminal, ghAvatarSrc, basename } from '../lib/util.js';
import { ICON } from '../lib/icons.js';
import { gitClientLabel, gitClientIcon } from '../lib/git-clients.js';
import { toast, toastErr } from './toast.js';
import { renderTabs } from './sidebar.js';
import { openMenu, closeMenu } from './menu.js';
import { visibleTerm } from './terminal.js';
import { ensurePrTerminal, applyPrLayout, clearPrLayout, resolveTabFolder, removeWorktree, openPrPanel } from './split.js';
import { jiraTaskBranch } from '../lib/workflow.mjs';
import { persistTask } from '../services/tasks.js';
import { refreshWorkflowBtn } from './workflow.js';
import { hideDiffPane } from './diff.js';
import { attachFind, closeFind } from './find.js';
import { renderContentTabs, playTabIn, playTabOut, markActiveTab } from './content-tabs.js';
import { ensureEditor, disposeEditor, saveEditor, focusEditor, gotoLine } from './editor.js';
import { createWcvShim } from './wcv-shim.js';

let _tabSeq = 0;
let _linkSeq = 0;

// A file link's url is `file://<absolute path>`; recover the path for the editor + API.
// decodeURI is the exact inverse of fileUrl's encodeURI (decodeURIComponent would over-decode
// reserved chars like # and ? that encodeURI leaves intact, mangling such paths).
export function pathFromUrl(url) {
  if (!url) return '';
  if (!url.startsWith('file://')) return url;
  try { return decodeURI(url.slice('file://'.length)); } catch { return url.slice('file://'.length); }
}
// Build the `file://` url that keys a file link (dedupe within a context + persistence).
export const fileUrl = p => 'file://' + encodeURI(p);

// Open a PR/Jira page as a viewer tab (a "context"). New tabs append; re-opening an
// already-open url just focuses it. This is the ONLY way a viewer tab is born — the
// dashboard/sidebar/tray all route here. The horizontal bar's extra web/file tabs are
// NOT viewer tabs; they're per-context links (see addLink / openFileTab).
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

// Build a <webview>-backed viewer tab (not yet added to state.tabs). Shared by openInSplit
// (new tab) and restoreTabs (rehydrate). `savedLinks` rebuilds the context's extra tabs.
export function createTab(url, title, kind, meta = {}) {
  const id = 'tab' + (++_tabSeq);
  // repo/branch (for GitHub PRs) let the terminal map to the right project workspace +
  // worktree without depending on state.projects still holding PR data.
  // category ('mine'|'review') and login (the PR author) are persisted so a GitHub tab keeps
  // its sidebar group AND its author avatar across restarts and even after its PR merges and
  // leaves the snapshot. avatar is the author's avatar frozen as a data URI (freezeAvatar).
  // links[] are this context's extra horizontal tabs; activeLink is the shown one (null = default).
  const tab = { id, kind: kind === 'jira' ? 'jira' : 'github', title: title || url, url, wv: null,
    loaded: false, started: false, repo: meta.repo || '', branch: meta.branch || '',
    jiraKey: meta.jiraKey || jiraKeyFromUrl(url), prSplit: !!meta.prSplit,
    paneView: meta.paneView === 'diff' ? 'diff' : 'term', category: meta.category || '',
    login: meta.login || '', avatar: meta.avatar || '',
    links: (meta.links || []).map(rebuildLink), activeLink: null };

  const wv = createWebviewEl();
  tab.wv = wv;
  wv.addEventListener('did-stop-loading', () => { tab.loaded = true; });
  // Keep the Back button's enabled state in sync as the user navigates within the tab.
  const onNav = () => { if (id === state.activeTabId && !tab.activeLink) updateNavButtons(); };
  wv.addEventListener('did-navigate', onNav);
  wv.addEventListener('did-navigate-in-page', onNav);
  return tab;
}

// Create a hidden <webview> with the app's shared-session policy, appended to split-body, with
// find-in-page wired. Shared by the default tab (createTab) and per-context web links
// (buildLinkWebview) — callers attach their own navigation listeners.
// Perf: lazy — `src` is set on first activation, so restored/background views don't all load at
// once; backgroundThrottling pauses hidden ones. NOTE: deliberately NO `partition` — webviews
// use the default session so they share your GitHub/Jira login cookies AND get the
// X-Frame-Options stripping applied to session.defaultSession in tray.js (allowFraming).
function createWebviewEl() {
  // Tauri build: there's no Electron <webview> tag. Return a child-WKWebview shim that mimics
  // the webview API (createWcvShim handles framing natively — top-level browse context, so no
  // X-Frame-Options/CSP stripping needed). The Electron path below is unchanged.
  if (window.__TAURI__ && window.taskhub?.wcv) return createWcvShim();

  const wv = document.createElement('webview');
  wv.setAttribute('webpreferences', 'backgroundThrottling=yes');
  wv.setAttribute('allowpopups', '');
  wv.style.display = 'none';
  document.getElementById('split-body').appendChild(wv);
  attachFind(wv);   // route this webview's native find results to the find bar while it's active
  // A clicked file:// link inside the page can't render in a webview (Chromium ERR_FILE_NOT_FOUND);
  // intercept it and open the file in the code editor instead.
  wv.addEventListener('will-navigate', e => {
    if (e.url && e.url.startsWith('file://')) { try { e.preventDefault(); } catch {} try { wv.stop(); } catch {} openFileTab(pathFromUrl(e.url)); }
  });
  return wv;
}

// ── Horizontal content tabs (per-context links: web pages + local files) ─────────────
// Extra tabs live on the active viewer tab as `links`. They render in the LEFT pane only;
// switching among them never touches the right split view. Added two ways only: the user's
// `+` (addLink → inline url/path entry) or a terminal file link (openFileTab).

// Is this link the one currently shown (active link of the active tab)?
const linkShown = l => { const t = activeTab(); return !!(t && t.activeLink === l.id); };

// Resolve a link id within the active context → { tab, link } (link null if not found). The
// single lookup the link handlers share.
function linkById(id) {
  const tab = activeTab();
  return { tab, link: (tab && (tab.links || []).find(l => l.id === id)) || null };
}

// Tear down a link's left-pane resources (its webview or its editor pane). The single teardown
// the close paths share (closeLink / closeOtherLinks / commitLinkInput / closeTab / closeSplit).
function disposeLink(l) {
  if (l.wv) l.wv.remove();
  if (l.ed) { disposeEditor(l); l.ed.remove(); }
}

// Rebuild a persisted link into a runtime link object (no DOM element until shown).
function rebuildLink(s) {
  return { id: 'lnk' + (++_linkSeq), kind: s.kind === 'file' ? 'file' : 'web', url: s.url || '',
    title: s.title || '', icon: s.icon || '', path: s.path || (s.kind === 'file' ? pathFromUrl(s.url) : ''),
    home: s.url || '', wv: null, ed: null, edView: null, started: false, loaded: false, dirty: false, editing: false };
}
function makeWebLink() {
  return { id: 'lnk' + (++_linkSeq), kind: 'web', url: '', title: '', icon: '', path: '',
    wv: null, started: false, loaded: false, editing: true };
}
function makeFileLink(p) {
  return { id: 'lnk' + (++_linkSeq), kind: 'file', url: fileUrl(p), title: basename(p) || p, icon: '',
    path: p, ed: null, edView: null, loaded: false, dirty: false, editing: false };
}

// Build the <webview> for a web link, lazily, on first show.
function buildLinkWebview(link) {
  const wv = createWebviewEl();
  link.wv = wv;
  wv.addEventListener('did-stop-loading', () => { link.loaded = true; });
  const onNav = () => { if (linkShown(link)) updateNavButtons(); };
  // Persist URL/title via the debounced saver — a chatty SPA fires many nav/title events, and
  // each saveTabs() is a full /api/tabs PUT serializing every tab. Coalesce the bursts.
  wv.addEventListener('did-navigate', e => { onNav(); if (e.url) { link.url = e.url; saveTabsSoon(); } });
  wv.addEventListener('did-navigate-in-page', onNav);
  // After load, the tab adopts the page's title + favicon (a browser tab).
  wv.addEventListener('page-title-updated', e => { if (e.title) { link.title = e.title; renderContentTabs(); saveTabsSoon(); } });
  wv.addEventListener('page-favicon-updated', e => { const ic = e.favicons && e.favicons[0]; if (ic) { link.icon = ic; renderContentTabs(); } });
}
function buildLinkEditorPane(link) {
  const ed = document.createElement('div');
  ed.className = 'editor-pane';
  ed.style.display = 'none';
  document.getElementById('split-body').appendChild(ed);
  link.ed = ed;
}

// Paint the LEFT content pane for a context: show the active link's element (or the default
// PR webview), hiding the rest. Does NOT touch the right split view.
function paintLeft(tab) {
  if (!tab) return;
  if (tab.wv) tab.wv.style.display = 'none';
  (tab.links || []).forEach(l => { if (l.wv) l.wv.style.display = 'none'; if (l.ed) l.ed.style.display = 'none'; });
  const link = tab.activeLink ? (tab.links || []).find(l => l.id === tab.activeLink) : null;
  if (!link) {                                   // default tab — the PR/Jira page
    if (tab.wv) {
      if (!tab.started) { tab.started = true; tab.wv.setAttribute('src', tab.url); }
      tab.wv.style.display = '';
    }
    return;
  }
  if (!link.url) return;                          // blank tab: address field is in the bar; left stays empty
  if (link.kind === 'file') {
    if (!link.ed) buildLinkEditorPane(link);
    link.ed.style.display = '';
    ensureEditor(link);
  } else {
    if (!link.wv) buildLinkWebview(link);
    if (!link.started) { link.started = true; link.wv.setAttribute('src', link.url); }
    link.wv.style.display = '';
  }
}

// The webview currently shown in the left pane (default tab's or the active web link's),
// for the toolbar's Back/Home, find-in-page (find.js), and reload (⌘R in app.js). A file
// link has no webview, so this returns null there.
export function activeLeftWebview() {
  const t = activeTab();
  if (!t) return null;
  if (t.activeLink) return (t.links || []).find(l => l.id === t.activeLink)?.wv || null;
  return t.wv || null;
}

// Switch which horizontal tab is shown in the left pane. linkId null = the default PR tab.
// Deliberately does NOT call openPrPanel/clearPrLayout — the right split view stays put.
export function setActiveLink(linkId) {
  const tab = activeTab();
  if (!tab) return;
  closeFind();
  tab.activeLink = linkId || null;
  paintLeft(tab);
  updateNavButtons();
  markActiveTab();           // class toggle (not a rebuild) so the pill fill animates
  saveTabs();
  const link = linkId ? (tab.links || []).find(l => l.id === linkId) : null;
  if (link?.kind === 'file' && link.edView) focusEditor(link);
}

// `+` → open a blank tab whose chip is an inline address field (type a URL or file path).
export function addLink() {
  const tab = activeTab();
  if (!tab) return;
  tab.links = tab.links || [];
  const link = makeWebLink();
  tab.links.push(link);
  tab.activeLink = link.id;
  paintLeft(tab);            // nothing to show yet — the inline input lives in the bar
  renderContentTabs();       // renders + focuses the input
  playTabIn(link.id);        // grow the new tab in
}

// Open a URL as a new content (top horizontal) tab in the ACTIVE context, loaded immediately —
// the same kind of tab `+` creates, but pre-filled and shown. Used by the embedded webview's
// "Open Link in New Tab" (webview_menu.rs → window.__openContentTab). Focuses an existing match
// instead of duplicating. Returns false when there's no active viewer tab.
export function openWebLink(url) {
  if (!url) return false;
  const tab = activeTab();
  if (!tab) return false;
  tab.links = tab.links || [];
  const existing = tab.links.find(l => l.kind === 'web' && l.url === url);
  if (existing) { setActiveLink(existing.id); return true; }
  const link = makeWebLink();
  link.editing = false; link.url = url; link.title = url; link.home = url;
  tab.links.push(link);
  tab.activeLink = link.id;
  paintLeft(tab);            // builds + loads the link's webview
  renderContentTabs(true);
  playTabIn(link.id);
  saveTabs();
  return true;
}

// Re-enter URL editing on an existing tab.
export function editLink(id) {
  const { link } = linkById(id);
  if (!link) return;
  link.editing = true;
  renderContentTabs();
}

// Click an extra tab: focus it if it isn't focused; a click on the ALREADY-focused tab enters
// inline URL/path editing — single click, like a browser address bar (no double-click).
export function ctabClick(id) {
  const { tab, link } = linkById(id);
  if (!tab || !link) return;
  if (tab.activeLink === id) editLink(id);
  else setActiveLink(id);
}

// Common web TLDs — used to tell a bare host (github.com/x) from a filename (README.md).
// Without this, the old `\.[a-z]{2,}` test sent `package.json`/`README.md` to https://, since
// `.json`/`.md` look just like a TLD. This is a dev tool, so ambiguous input favors FILE.
const WEB_TLD = /\.(?:com|org|net|io|dev|app|ai|gov|edu|co|sh|me|info|xyz|cloud|page|tv|so|gg)(?:[/:?#]|$)/i;

// Decide whether typed text is a web URL or a local file path.
//  • http(s):// → web as-is.   • leading / ~ ./ ../ or www. → file/web by prefix.
//  • host with a known web TLD (github.com/x) → web with https://.   • everything else → file.
function classifyInput(v) {
  if (/^file:\/\//i.test(v)) return { kind: 'file', value: pathFromUrl(v) };  // file:// → clean local path
  if (/^https?:\/\//i.test(v)) return { kind: 'web', value: v };
  if (/^(\/|~|\.\.?\/)/.test(v)) return { kind: 'file', value: v };
  if (/^www\./i.test(v)) return { kind: 'web', value: 'https://' + v };
  // Only the host part (before the first '/') decides web-vs-file, so `src/app.js` stays a file.
  if (WEB_TLD.test(v.split('/')[0] + '/')) return { kind: 'web', value: 'https://' + v };
  return { kind: 'file', value: v };
}

// Commit the inline address input: turn the tab into a web or file tab and load it.
function commitLinkInput(id, raw) {
  const { tab, link } = linkById(id);
  if (!link) return;
  const v = (raw || '').trim();
  if (!v) { closeLink(id); return; }
  const { kind, value } = classifyInput(v);
  // Tear down any element from a prior value (e.g. re-edited tab whose kind changed).
  disposeLink(link); link.wv = null; link.ed = null;
  link.kind = kind; link.editing = false; link.started = false; link.loaded = false; link.icon = '';
  if (kind === 'file') { link.path = value; link.url = fileUrl(value); link.title = basename(value) || value; }
  else { link.url = value; link.title = value; link.home = value; }   // home = the entered URL (Home button)
  paintLeft(tab);
  renderContentTabs(true);   // force past the typing guard — the input is still focused here
  saveTabs();
}

// Inline-input key handler: Enter commits, Escape cancels (discards a never-loaded blank tab).
export function ctabInputKey(e, id) {
  if (e.key === 'Enter') { e.preventDefault(); commitLinkInput(id, e.target.value); }
  else if (e.key === 'Escape') { e.preventDefault(); cancelLinkInput(id); }
}
export function ctabInputBlur(id) {
  const { link } = linkById(id);
  if (!link) return;
  if (!link.url) closeLink(id);                  // a blank tab abandoned without entering anything
  else if (link.editing) { link.editing = false; renderContentTabs(true); }
}
function cancelLinkInput(id) {
  const { link } = linkById(id);
  if (!link) return;
  if (!link.url) closeLink(id);
  else { link.editing = false; renderContentTabs(true); }
}

// Close one extra tab (shrink it out first); fall back to the default tab if it was active.
export function closeLink(id) {
  const tab = activeTab();
  if (!tab || !tab.links) return;
  if (!tab.links.some(l => l.id === id)) return;
  playTabOut(id, () => {
    const j = tab.links.findIndex(l => l.id === id);
    if (j < 0) return;
    disposeLink(tab.links[j]);
    tab.links.splice(j, 1);
    if (tab.activeLink === id) { tab.activeLink = null; paintLeft(tab); updateNavButtons(); }
    renderContentTabs(true);
    saveTabs();
  });
}

// "Close other tabs" — drop every extra tab, keep the default. The default can't be closed.
export function closeOtherLinks() {
  const tab = activeTab();
  if (!tab || !tab.links?.length) return;
  tab.links.forEach(disposeLink);
  tab.links = [];
  tab.activeLink = null;
  paintLeft(tab);
  updateNavButtons();
  renderContentTabs();
  saveTabs();
}

// Right-click an extra tab → close / close others (an in-page menu).
export function ctabMenu(e, id) {
  e.preventDefault();
  return openMenu(e, [
    { label: 'Close tab', onClick: () => closeLink(id) },
    { label: 'Close other tabs', onClick: closeOtherLinks },
  ]);
}

// Save a file tab (its save button → here; ⌘S is handled inside Monaco).
export function saveLinkFile(id) {
  const { link } = linkById(id);
  if (link) saveEditor(link);
}

// Open a local file as an extra tab in the CURRENT context (a terminal file-link click).
// Reuses an already-open file in this context; `line` (1-based) jumps there.
export function openFileTab(filePath, line = 0) {
  if (!filePath) return;
  // Resolve the owning context: the active viewer tab, or — when a full-screen (standalone)
  // terminal is showing (activeTabId is null then) — the tab that owns the active terminal,
  // found by its pairKey. Without this, terminal file-links no-op in a solo task terminal.
  let tab = activeTab();
  if (!tab && state.activeTermId) {
    const term = state.terms.get(state.activeTermId);
    if (term?.pairKey) tab = state.tabs.find(t => t.url === term.pairKey) || null;
  }
  if (!tab) return;
  tab.links = tab.links || [];
  const want = normFilePath(filePath);
  let link = tab.links.find(l => l.kind === 'file' && normFilePath(l.path) === want);
  if (!link) { link = makeFileLink(filePath); tab.links.push(link); }
  if (line) link._pendingLine = line;
  tab.activeLink = link.id;
  if (state.activeTabId === tab.id) {
    paintLeft(tab);
    renderContentTabs(true);
  } else {
    activateTab(tab.id);   // bring the owning context into view (leaving the solo terminal)
  }
  saveTabs();
  if (line && link.edView) gotoLine(link, line);
}

// Light path normalization for the dedup key (collapse `//` and `/./`) so the same file
// reached two ways doesn't open two editors. Not a full realpath — symlinks/`..` still differ.
function normFilePath(p) {
  return String(p || '').replace(/\/{2,}/g, '/').replace(/\/\.(?=\/)/g, '');
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
      tabs: state.tabs.map(t => ({ kind: t.kind, title: t.title, url: t.url, repo: t.repo, branch: t.branch, jiraKey: t.jiraKey, prSplit: t.prSplit, paneView: t.paneView, category: t.category, login: t.login, avatar: t.avatar,
        // The context's extra horizontal tabs (web pages + local files). Only committed ones
        // (with a url) — a blank, never-entered tab isn't persisted.
        links: (t.links || []).filter(l => l.url).map(l => ({ kind: l.kind, url: l.url, title: l.title, path: l.path || '', icon: l.icon || '' })) })),
      active: active ? active.url : null,
    }),
  }).catch(() => {});
  // Note: we don't push a tray refresh here. The tray pulls the latest saved tabs itself when
  // it's about to open (main's blur handler → tabs-only refresh), so persisting is enough.
}

// Debounced saveTabs for high-frequency triggers (web-link in-page navigations / title churn),
// so a busy SPA doesn't fire a full /api/tabs PUT per event. Trailing-edge, 800ms.
let _saveTabsTimer = 0;
export function saveTabsSoon() { clearTimeout(_saveTabsTimer); _saveTabsTimer = setTimeout(saveTabs, 800); }

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
      state.tabs.push(createTab(t.url, t.title, t.kind, { repo: t.repo, branch: t.branch, jiraKey: t.jiraKey, prSplit: t.prSplit, paneView: t.paneView, category: t.category, login: t.login, avatar: t.avatar, links: Array.isArray(t.links) ? t.links : [] }));
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
  closeFind();                                // stop find on the outgoing webview; bar reopens per-tab
  state.activeTabId = id;
  state.activeTermId = null;                  // showing a page, not a terminal
  document.body.classList.remove('viewing-term');
  const cur = state.tabs.find(t => t.id === id);
  hideAllPanes();
  if (cur) paintLeft(cur);                    // show the active link, or the default PR page
  document.getElementById('split').hidden = false;
  document.body.classList.add('viewing-tab');
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active')); // a tab is the view now
  updateNavButtons();
  // PR ↔ terminal split: the right panel is per-tab (`prSplit`, default OFF). It belongs to the
  // CONTEXT (the default tab), not to which horizontal link is showing — switching links won't
  // re-run this (see setActiveLink). When expanded, openPrPanel shows the live terminal, etc.
  if (canSplitTerminal(cur) && cur.prSplit) openPrPanel(cur);
  else clearPrLayout();
  document.getElementById('split-toggle-term')?.classList.toggle('on', !!(canSplitTerminal(cur) && cur.prSplit));
  renderTabs();
  saveTabs();
}

// Hide every left-pane element (default webviews + per-context link webviews/editor panes) +
// terminals + diff. The caller then shows one; applyPrLayout re-adds pane-diff when the
// incoming tab is in diff view.
export function hideAllPanes() {
  state.tabs.forEach(t => {
    if (t.wv) t.wv.style.display = 'none';
    (t.links || []).forEach(l => { if (l.wv) l.wv.style.display = 'none'; if (l.ed) l.ed.style.display = 'none'; });
  });
  for (const t of state.terms.values()) t.el.style.display = 'none';
  hideDiffPane();
  document.body.classList.remove('pane-diff');
}

// Closing a web tab NEVER kills its task. A paired terminal is a deliberately-started task (worktree
// + terminal) — there are no auto-spawned bare shells anymore — so it keeps running in the background
// and shows on the Tasks page; only the Tasks-page trash button (deleteTaskSession) or the shell
// exiting stops it. Closing the tab just unbinds + hides the pane; the PTY lives on (it's keyed to the
// tab's URL, so reopening the link re-adopts it).
export function closePairedTerm(tab) {
  if (!tab?.termId) return;
  const term = state.terms.get(tab.termId);
  if (term) term.el.style.display = 'none'; // keep the PTY alive; just unbind + hide
  tab.termId = null;
}

export function closeTab(id) {
  const i = state.tabs.findIndex(t => t.id === id);
  if (i < 0) return;
  const tab = state.tabs[i];
  closePairedTerm(tab);
  tab.wv?.remove();
  (tab.links || []).forEach(disposeLink);
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
  closeFind();
  state.tabs.forEach(t => { closePairedTerm(t); t.wv?.remove(); (t.links || []).forEach(disposeLink); });
  state.tabs = []; state.activeTabId = null; state.activeTermId = null;
  document.getElementById('split').hidden = true;
  document.body.classList.remove('viewing-tab', 'viewing-term', 'pr-split', 'pane-diff'); // restore <main>
  renderTabs(); // clear tab rows; paired terminals were stopped above
  saveTabs();
}

// Back/Home act on whichever webview is shown in the left pane — the default PR page or the
// active web link (a file tab has no webview, so these no-op there).
export function splitBack()    { const wv = activeLeftWebview(); try { if (wv?.canGoBack()) wv.goBack(); } catch {} }
export function splitForward() { const wv = activeLeftWebview(); try { if (wv?.canGoForward()) wv.goForward(); } catch {} } // no toolbar button — ⌘] only
// Home → the shown pane's DEFAULT page: the PR/Jira url for the default tab, or a web link's
// originally-entered url. (Not "reload current" — that lost the go-home behavior.)
export function splitHome() {
  const t = activeTab();
  const wv = activeLeftWebview();
  if (!t || !wv) return;
  const link = t.activeLink ? (t.links || []).find(l => l.id === t.activeLink) : null;
  const home = link ? (link.home || link.url) : t.url;
  if (!home) return;
  try { wv.loadURL(home); } catch {}
}
// Grey out Back when the shown webview has no history to go back to.
export function updateNavButtons() { const wv = activeLeftWebview(); const b = document.getElementById('split-back'); if (b) { let can = false; try { can = !!(wv && wv.canGoBack()); } catch {} b.disabled = !can; } }

// Titles: PR/page title in the webview segment. In split mode the pane's name lives on
// the active view-switch button (segmented control), so the segment title stays empty;
// a solo full-width terminal (no switch visible) still gets the "Terminal" label.
export function updateTitles() {
  // The webview segment's title now lives on the content bar's default chip (content-tabs.js),
  // so there's no #split-title to fill here — only the terminal segment's label remains.
  const tt = document.getElementById('term-title');
  if (tt) tt.textContent = (state.activeTermId && visibleTerm()) ? 'Terminal' : '';
  updateFolderChip();
  refreshWorkflowBtn();
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
  if (!el) return;
  const hideChip = () => { el.hidden = true; el.dataset.path = ''; el.dataset.worktree = ''; el.dataset.workspace = ''; };
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

  if (!t || (t.kind !== 'github' && t.kind !== 'jira')) { hideChip(); return; }
  const reqId = ++_folderReq;
  const tabId = t.id;
  const info = await resolveTabFolder(t).catch(() => null);
  if (reqId !== _folderReq || state.activeTabId !== tabId) return; // tab switched mid-resolve
  if (!info || !info.path) { hideChip(); return; }

  // Show the folder chip — always the current folder (the branch's worktree if one exists, else the
  // project workspace). Creating a worktree is no longer a chip CTA; it happens via New Task. When a
  // git client is configured (Settings), the chip wears that client's brand mark and a click opens the
  // folder there; Finder moves to the right-click menu. With no client it shows the worktree/folder
  // glyph and a click reveals in Finder.
  const isWorktree = !!info.isWorktree;
  const name = basename(info.path) || info.path;
  el.dataset.path = info.path;
  // A worktree carries its workspace so the right-click menu can offer deletion (the main
  // checkout can't be deleted, so it leaves these blank).
  el.dataset.worktree = isWorktree ? '1' : '';
  el.dataset.workspace = isWorktree ? (info.workspace || '') : '';
  const gc = state.gitClient || {};
  const gcOn = !!(gc.id && gc.cmd);
  const gcIcon = gcOn ? gitClientIcon(gc.id) : '';
  // Two segments: the icon opens the configured git client (a deeplink), the name reveals in Finder.
  const icTitle = gcOn ? `Open in ${gitClientLabel(gc.id)}` : 'Reveal in Finder';
  const nameTitle = (isWorktree ? 'Worktree — reveal in Finder — ' : 'Reveal in Finder — ') + info.path;
  // Keep the worktree state on the chip even when a brand <img> replaces the glyph: the accent
  // tint targets the stroke glyph, and an accent ring marks the img (see .is-worktree CSS), so a
  // worktree stays distinguishable from a main checkout regardless of which icon is shown.
  el.classList.toggle('is-worktree', isWorktree);
  // Icon half only when a git client is configured — its sole job is the deeplink. With no client
  // it would be a folder glyph that just reveals in Finder, duplicating the name half, so drop it.
  // A configured client without a brand mark (Custom deeplink, unknown id) falls back to the
  // folder/worktree glyph rather than an empty <img>.
  const mark = gcIcon ? `<img src="${gcIcon}" alt="">` : (isWorktree ? ICON.worktree : ICON.folder);
  const glyph = gcOn
    ? `<button type="button" class="fc-ic" onclick="folderChipClick()" title="${esc(icTitle)}">${mark}</button>`
    : '';
  el.innerHTML = glyph
    + `<button type="button" class="fc-text" onclick="openTabFolder()" title="${esc(nameTitle)}"><span>${esc(name)}</span></button>`;
  el.hidden = false;
}

// Folder-chip click: open the branch in the configured git client, else reveal in Finder.
export function folderChipClick() {
  const { id, cmd } = state.gitClient || {};
  const p = document.getElementById('split-folder')?.dataset.path;
  if (p && id && cmd) { window.taskhub?.openInGitClient?.(cmd, p); return; }
  openTabFolder();
}

// Reveal the active tab's resolved folder in the system file manager.
export function openTabFolder() {
  const p = document.getElementById('split-folder')?.dataset.path;
  if (p && window.taskhub?.openPath) window.taskhub.openPath(p);
}

// Right-click the folder chip → reveal in Finder always (plus "Open in <client>" when one's
// configured, since a left-click now opens the client), and "Delete worktree" when the chip is
// a worktree (not the shared main checkout). A native macOS menu popped from main (matching the
// sidebar tab / webview / tray menus); the action comes back here to dispatch. Falls back to the
// in-page menu in a plain browser, where there's no main process.
export async function folderMenu(e) {
  e.preventDefault();
  const el = document.getElementById('split-folder');
  if (!el || el.hidden) return false;
  const { id, cmd } = state.gitClient || {};
  const hasClient = !!(id && cmd);
  const isWorktree = el.dataset.worktree === '1';
  if (window.taskhub?.folderMenu) {
    closeMenu(); // dismiss any open in-page menu (the native menu won't fire the click that would)
    const action = await window.taskhub.folderMenu({ hasClient, clientLabel: hasClient ? gitClientLabel(id) : '', isWorktree });
    if (action === 'client') folderChipClick();
    else if (action === 'finder') openTabFolder();
    else if (action === 'delete') removeTabWorktree();
    return false;
  }
  return openMenu(e, [
    hasClient && { label: `Open in ${gitClientLabel(id)}`, onClick: folderChipClick },
    { label: 'Reveal in Finder', onClick: openTabFolder },
    isWorktree && { label: 'Delete worktree…', onClick: removeTabWorktree, danger: true },
  ]);
}

// Delete the chip's worktree (after confirming), then re-resolve so the chip falls back
// to the plain checkout / create CTA. The branch is left intact.
export async function removeTabWorktree() {
  const el = document.getElementById('split-folder');
  const workspace = el?.dataset.workspace, worktree = el?.dataset.path;
  if (!workspace || !worktree) return;
  if (!confirm(`Delete this worktree?\n\n${worktree}\n\nThe folder is removed; the branch is kept. Uncommitted changes there will block deletion.`)) return;
  const r = await removeWorktree(workspace, worktree);
  if (r.error) { toastErr(r.error); return; }
  toast('Worktree deleted');
  updateFolderChip(true);
}

// New task: open the active tab's terminal in its branch worktree, creating the worktree first
// if the branch isn't checked out anywhere yet. This is the SINGLE worktree-create entry point —
// the old folder-chip "Create worktree" CTA folded into it. Branch naming mirrors the workflow
// runner: a GitHub PR uses its head ref; a Jira ticket derives feature/<KEY>-<summary>. After this
// the tab has a live terminal, so the button hides (updateTitles) and ⌘J / the pane-switch take over.
export async function newTask() {
  const tab = activeTab();
  if (!tab || !canSplitTerminal(tab)) return;
  const btn = document.querySelector('.new-task-cta');
  if (btn) btn.disabled = true;
  try {
    const f = await resolveTabFolder(tab);
    let cwd = f.path; // where the terminal opens — the just-created worktree if we create one below
    // A Jira task names its branch (and worktree folder) after the ticket key + a short title slug
    // — e.g. RECORD-648-ios-vod-player-display — and creates it off the default branch. A GitHub PR
    // uses its existing head ref.
    const key = tab.jiraKey || jiraKeyFromUrl(tab.url) || '';
    const branch = tab.kind === 'jira'
      ? jiraTaskBranch(key, jiraByKey(key)?.summary || '')
      : (tab.branch || prByUrl(tab.url)?.headRefName || '');
    if (!f.matched && f.workspace && branch) {
      let r = await apiJson(ROUTES.WORKTREE, 'POST', { path: f.workspace, branch, create: tab.kind === 'jira' });
      // A non-worktree folder is already sitting where this worktree would go. We never delete a
      // folder we didn't create without asking — confirm an override, tailoring the warning to how
      // safe it is (only regenerable editor state vs. real files), then retry with override.
      if (r && r.folderConflict) {
        const what = r.disposable
          ? `A leftover folder (only editor state, no source) is at:\n${r.path}\n\nDelete it and create the task here?`
          : `A folder already exists at:\n${r.path}\n\nIt isn't a git worktree and may contain files. Delete it and create the task here?`;
        if (!confirm(what)) return;
        r = await apiJson(ROUTES.WORKTREE, 'POST', { path: f.workspace, branch, create: tab.kind === 'jira', override: true });
      }
      if (r && r.error) { toastErr(r.error); return; }
      toast(`Worktree created for ${branch}`);
      cwd = r.path || cwd;
      updateFolderChip(true);
    }
    tab.prSplit = true;
    saveTabs();
    await ensurePrTerminal(tab, cwd); // pass the resolved/created path so it isn't re-resolved
    if (state.activeTabId === tab.id) applyPrLayout(tab, true);
    document.getElementById('split-toggle-term')?.classList.add('on');
    updateTitles(); // hide the New Task button now the tab has a terminal; set the worktree title
    // Track the task durably — it now survives tab close / terminal death / app restart (Tasks page).
    persistTask({ url: tab.url, kind: tab.kind, title: tab.title, repo: tab.repo || '', branch,
      jiraKey: tab.kind === 'jira' ? key : '', workspace: f.workspace || '', worktree: cwd || '' });
  } catch (e) {
    toastErr('Failed to start task: ' + e.message);
  } finally {
    if (btn) btn.disabled = false;
  }
}

// Open an http(s) URL in the user's default browser (main guards the scheme).
export function openExternal(url) {
  if (url) window.taskhub?.openExternal?.(url);
}

// Update the chosen git client (id + command template) and re-render the folder chip so the
// change takes effect immediately. Called at bootstrap and by the Settings picker.
export function updateGitClient(id, cmd) {
  state.gitClient = { id: id || '', cmd: cmd || '' };
  updateFolderChip(true);
}

// Open a repo's GitHub home page in the default browser. `repo` is "owner/name".
export function openRepo(repo) {
  if (repo) openExternal(`https://github.com/${repo}`);
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
  // Host hook (Tauri): "Open Link in New Tab" in the embedded webview → a new content (top) tab in
  // the current context. Falls back to a sidebar tab if there's no active context or it throws.
  window.__openContentTab = (url) => {
    try { if (openWebLink(url)) return; } catch (e) { console.warn('[openContentTab]', e); }
    window.__openTab(url, '', 'github', '');
  };
}
