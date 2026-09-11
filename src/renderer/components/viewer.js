// Embedded viewer: the Electron app embeds the real GitHub/Jira page in a <webview>
// (the main process strips X-Frame-Options/CSP so framing is allowed). Opened links
// live as tabs in the left nav; activating one shows it full-width here.
import { ROUTES } from '/shared/routes.mjs';
import { state, activeTab, prByUrl, prGroup, prTabTitle, jiraTabTitle, jiraByKey, projectByWorkspace } from '../stores/store.js';
import { api, apiJson } from '../services/api.js';
import { esc, jiraKeyFromUrl, canSplitTerminal, isPrUrl, ghAvatarSrc, basename, hasPage, isSessionUrl } from '../lib/util.js';
import { seedAvatar } from '../lib/avatars.js';
import { ICON } from '../lib/icons.js';
import { gitClientLabel, gitClientIcon } from '../lib/git-clients.js';
import { ideLabel, ideIcon, resolveIdeCmd, ideProbe } from '../lib/ides.js';
import { toast, toastErr } from './toast.js';
import { renderTabs } from './sidebar.js';
import { openMenu, closeMenu } from './menu.js';
import { ensurePrTerminal, applyPrLayout, clearPrLayout, resolveTabFolder, removeWorktree, openPrPanel, leaveReview, rightPaneOpen, rightPaneHidden, setPaneView, showEmptyPane } from './split.js';
import { jiraTaskBranch } from '../lib/workflow.mjs';
import { persistTask, taskForTab, taskById } from '../services/tasks.js';
import { deleteWorktreeAt, ensureWorktree } from './tasks.js';
import { suggestSession } from './new-session-dialog.js';
import { refreshWorkflowBtn, launchCli } from './workflow.js';
import { hideDiffPane } from './diff.js';
import { buildTerm, runBuild, stopBuild, isBuilding, disposeBuildTerm } from './build.js';
import { attachFind, closeFind } from './find.js';
import { renderContentTabs, playTabIn, playTabOut, markActiveTab, defaultChipRect, flipDefaultChip, focusCtabInput, inDiff } from './content-tabs.js';
import { ensureEditor, disposeEditor, saveEditor, focusEditor, gotoLine } from './editor.js';
import { createWcvShim } from './wcv-shim.js';

let _tabSeq = 0;
let _linkSeq = 0;

// A file link's url is `file://<absolute path>`; recover the path for the editor + API.
// decodeURI is the exact inverse of fileUrl's encodeURI (decodeURIComponent would over-decode
// reserved chars like # and ? that encodeURI leaves intact, mangling such paths).
function pathFromUrl(url) {
  if (!url) return '';
  if (!url.startsWith('file://')) return url;
  try { return decodeURI(url.slice('file://'.length)); } catch { return url.slice('file://'.length); }
}
// Build the `file://` url that keys a file link (dedupe within a context + persistence).
const fileUrl = p => 'file://' + encodeURI(p);

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
function createTab(url, title, kind, meta = {}) {
  const id = 'tab' + (++_tabSeq);
  // repo/branch (for GitHub PRs) let the terminal map to the right project workspace +
  // worktree without depending on state.projects still holding PR data.
  // category ('mine'|'review') and login (the PR author) are persisted so a GitHub tab keeps
  // its sidebar group AND its author avatar across restarts and even after its PR merges and
  // leaves the snapshot. avatar is the author's avatar frozen as a data URI (freezeAvatar).
  // links[] are this context's extra horizontal tabs; activeLink is the shown one (null = default).
  // `url` is the tab's identity (dedupe, PR lookup, paired-PTY key) and never changes; `cur` is
  // the page the user has navigated to inside it, so an evicted-then-reselected tab (see the
  // webview pool below) reloads where they left off rather than at the PR root.
  // wv is built lazily on first show (buildTabWebview) — a tab that's never shown costs no process.
  // kind: 'jira' when asked; otherwise a GitHub PR page is 'github' and any other URL is a plain
  // 'web' tab (no project, no terminal until a session is created for it — see newSession).
  const k = kind === 'jira' ? 'jira' : isPrUrl(url) ? 'github' : 'web';
  // paneView is the RIGHT pane's single state: 'off' (hidden — the terminal fills the panel),
  // 'term' (the context's page) or 'diff' (the worktree diff). A bare session has no page, so its
  // pane starts hidden; a page-backed context starts showing its page, as it always did.
  const pv = ['off', 'diff', 'term'].includes(meta.paneView) ? meta.paneView : (isSessionUrl(url) ? 'off' : 'term');
  const tab = { id, kind: k, title: title || url, url, cur: meta.cur || '', wv: null,
    loaded: false, started: false, repo: meta.repo || '', branch: meta.branch || '',
    jiraKey: meta.jiraKey || jiraKeyFromUrl(url),
    paneView: pv, category: meta.category || '',
    login: meta.login || '', avatar: meta.avatar || '',
    links: (meta.links || []).map(rebuildLink), activeLink: null };
  return tab;
}

// Build the default (PR/Jira page) webview for a context, lazily, on first show — mirrors
// buildLinkWebview. Rebuilt from scratch after a pool eviction, so every listener lives here.
function buildTabWebview(tab) {
  const wv = createWebviewEl();
  tab.wv = wv;
  wv.addEventListener('did-stop-loading', () => { tab.loaded = true; });
  // Page-load bar: this is the shown webview when its tab is active and no link is overlaid.
  const shown = () => tab.id === state.activeTabId && !tab.activeLink;
  wireProgress(wv, shown);
  // Keep the Back button's enabled state in sync as the user navigates within the tab, and
  // remember the current page (debounced — GitHub's Turbo nav is chatty) for a later rebuild.
  // (Electron fires GitHub's Turbo/pjax navigations as did-navigate-in-page, so both matter.)
  const onNav = e => { if (shown()) updateNavButtons(); if (isWebUrl(e.url)) { tab.cur = e.url; saveTabsSoon(); } };
  wv.addEventListener('did-navigate', onNav);
  wv.addEventListener('did-navigate-in-page', onNav);
}
// A persistable page URL (never about:blank / file:// / data:).
const isWebUrl = u => !!u && /^https?:/i.test(u);

// ── Live-webview pool ────────────────────────────────────────────────────────────
// Every embedded page (a context's default PR/Jira page or a web link) is its own WebContent /
// renderer process — a few hundred MB each — and hidden ones used to live forever. Instead, keep
// only the N most recently shown webviews alive (state.webviewPool, Settings → System); the rest are
// torn down and rebuilt from their saved URL the next time they're shown (a browser's tab discard).
// The pool holds owner objects (tab or link, whichever has the `.wv`), least-recent first.
let _live = [];

// Record `owner` as the most recently shown live webview and evict whatever exceeds the pool.
function touchLive(owner) {
  _live = _live.filter(o => o !== owner && o.wv);
  _live.push(owner);
  trimLive();
}
function trimLive() {
  const max = Math.max(1, state.webviewPool | 0);
  const shown = shownOwner();
  while (_live.length > max) {
    const victim = _live.find(o => o !== shown);   // never evict the page on screen
    if (!victim) break;
    disposeWebview(victim);   // evicted: page state (scroll, history) is lost; its URL survives (tab.cur / link.url)
  }
}
// Drop an owner's webview (if any) and forget it. The single teardown for evictions AND the
// close paths (disposeLink / closeTab / closeSplit) — null-safe on either build. Callers must
// never cache a `.wv` across a show — always re-read owner.wv (it may have been rebuilt).
function disposeWebview(owner) {
  if (owner.wv) { try { owner.wv.remove(); } catch {} }
  owner.wv = null; owner.started = false; owner.loaded = false;
  _live = _live.filter(o => o !== owner);
}
// The owner (tab or link) whose webview is currently on screen, if any.
function shownOwner() {
  const t = activeTab();
  if (!t) return null;
  if (t.activeLink) return (t.links || []).find(l => l.id === t.activeLink) || null;
  return inDiff(t) ? null : t;   // a page hidden behind the Diff view is evictable like any other
}
// Settings → System: change the pool size at runtime (also persisted by settings.js).
export const WEBVIEW_POOL_DEFAULT = 3;
// Clamp a setting value to a valid pool size; anything non-numeric → the default (not 1).
export function clampWebviewPool(v) { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(20, Math.max(1, n)) : WEBVIEW_POOL_DEFAULT; }
export function setWebviewPoolSize(n) {
  state.webviewPool = clampWebviewPool(n);
  trimLive();
}

// Create a hidden <webview> with the app's shared-session policy, appended to split-body, with
// find-in-page wired. Shared by the default tab (buildTabWebview) and per-context web links
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
  disposeWebview(l);
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
  wireProgress(wv, () => linkShown(link));
  const onNav = () => { if (linkShown(link)) updateNavButtons(); };
  // Persist URL/title via the debounced saver — a chatty SPA fires many nav/title events, and
  // each saveTabs() is a full /api/tabs PUT serializing every tab. Coalesce the bursts.
  const onNavUrl = e => { onNav(); if (isWebUrl(e.url)) { link.url = e.url; saveTabsSoon(); } };
  wv.addEventListener('did-navigate', onNavUrl);
  wv.addEventListener('did-navigate-in-page', onNavUrl);
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

// Paint the content pane for a context: show the active link's element (or the default PR
// webview), hiding the rest. Does NOT touch the terminal split. While Review covers the pane
// everything stays hidden — the native webview would otherwise paint over the diff.
export function paintLeft(tab) {
  if (!tab) return;
  resetWvProgress();   // the shown webview is changing; drop any in-flight bar (a still-loading view re-emits)
  if (tab.wv) tab.wv.style.display = 'none';
  (tab.links || []).forEach(l => { if (l.wv) l.wv.style.display = 'none'; if (l.ed) l.ed.style.display = 'none'; });
  const link = tab.activeLink ? (tab.links || []).find(l => l.id === tab.activeLink) : null;
  if (rightPaneHidden(tab)) return;               // pane collapsed onto the terminal — paint no page
  // Pane open with nothing in it — a bare session showing neither the diff nor a web tab (its
  // context has no page). It gets the #pane-empty surface, which says what the pane is for instead
  // of leaving a void, and the browser foot (back/forward/home for a page that isn't there) goes.
  // Decided HERE because paintLeft is the one path every view change goes through: closing the last
  // web tab of a bare session lands in exactly this state without going near the split code.
  const inBuild = tab.paneView === 'build' && !!buildTerm(tab);
  const blank = !inDiff(tab) && !inBuild && !hasPage(tab) && !link;
  document.body.classList.toggle('pane-blank', blank);
  showEmptyPane(blank);
  if (inDiff(tab) || inBuild) {
    /* the Diff view / the build terminal takes the pane — leave the page hidden. A native
       embedded webview paints over all DOM, so covering it isn't enough; it must not be shown. */
  } else if (!hasPage(tab)) {                     // bare session: the context has no page at all
    /* nothing to show — the pane holds the diff view or the web tabs the user adds */
  } else if (!link) {                                   // default tab — the PR/Jira page
    if (!tab.wv) buildTabWebview(tab);
    if (!tab.started) { tab.started = true; tab.wv.setAttribute('src', tab.cur || tab.url); }
    tab.wv.style.display = '';
    touchLive(tab);
  } else if (!link.url) {                         // blank tab: address field is in the bar; left stays empty
    /* nothing to show */
  } else if (link.kind === 'file') {
    if (!link.ed) buildLinkEditorPane(link);
    link.ed.style.display = '';
    ensureEditor(link);
  } else {
    if (!link.wv) buildLinkWebview(link);
    if (!link.started) { link.started = true; link.wv.setAttribute('src', link.url); }
    link.wv.style.display = '';
    touchLive(link);
  }
  // Push the new visibility to the native child webviews now (Tauri shim) rather than waiting for
  // the rAF loop, which is throttled while the renderer isn't painting — see wcv-shim el.syncBounds.
  tab.wv?.syncBounds?.();
  (tab.links || []).forEach(l => l.wv?.syncBounds?.());
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

// A context's active view just changed (a content tab picked, a file link opened): paint it — and
// open the right pane first when it's collapsed, since asking to see something implies showing it.
// setPaneView persists the state and repaints through applyPrLayout, so it replaces the paint.
function showActiveView(tab) {
  if (rightPaneHidden(tab)) setPaneView('term');
  else paintLeft(tab);
}

// Switch which horizontal tab is shown in the content pane. linkId null = the default PR tab.
// Deliberately does NOT call openPrPanel/clearPrLayout — the terminal split stays put. Picking
// a tab is asking to see a page, so it also leaves Review if that was covering the pane.
export function setActiveLink(linkId) {
  const tab = activeTab();
  if (!tab) return;
  closeFind();
  tab.activeLink = linkId || null;
  leaveReview(tab);
  showActiveView(tab);        // …opening the right pane first if it was collapsed
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
  leaveReview(tab);
  paintLeft(tab);            // nothing to show yet — the inline input lives in the bar
  renderContentTabs();
  focusCtabInput(link.id);   // focus THIS tab's field (explicitly — render no longer auto-focuses)
  playTabIn(link.id);        // grow the new tab in
}

// Open a URL as a new content (top horizontal) tab in the ACTIVE context, loaded immediately —
// the same kind of tab `+` creates, but pre-filled and shown. Used by the embedded webview's
// "Open Link in New Tab" (webview_menu.rs → window.__openContentTab). Focuses an existing match
// instead of duplicating. Returns false when there's no active viewer tab.
function openWebLink(url) {
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
  leaveReview(tab);
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
  focusCtabInput(id);
}

// Click an extra tab: focus it if it isn't focused; a click on the ALREADY-focused tab enters
// inline URL/path editing — single click, like a browser address bar (no double-click).
export function ctabClick(id) {
  const { tab, link } = linkById(id);
  if (!tab || !link) return;
  // While the Diff view covers the page the chip renders inactive, so a click means "show me
  // the page again", not "edit the address".
  if (tab.activeLink === id && !inDiff(tab)) editLink(id);
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
  if (!v) return;            // nothing entered → keep the tab blank; only a real value commits
  const { kind, value } = classifyInput(v);
  // Tear down any element from a prior value (e.g. re-edited tab whose kind changed).
  disposeLink(link); link.ed = null;
  link.kind = kind; link.editing = false; link.started = false; link.loaded = false; link.icon = '';
  if (kind === 'file') { link.path = value; link.url = fileUrl(value); link.title = basename(value) || value; }
  else { link.url = value; link.title = value; link.home = value; }   // home = the entered URL (Home button)
  leaveReview(tab);
  paintLeft(tab);
  renderContentTabs(true);   // force past the typing guard — the input is still focused here
  saveTabs();
}

// Inline-input key handler: Enter is the ONLY thing that commits a tab. Escape just leaves
// editing (a blank tab stays blank — it's fine to leave empty; only ✕ removes a tab).
export function ctabInputKey(e, id) {
  if (e.key === 'Enter') { e.preventDefault(); commitLinkInput(id, e.target.value); }
  else if (e.key === 'Escape') { e.preventDefault(); cancelLinkInput(id); }
}
// Blur/escape never dismiss a tab — an empty tab is allowed. For a tab that already has a url
// (re-editing), drop back out of editing; a blank tab is simply left as-is.
export function ctabInputBlur(id) {
  const { link } = linkById(id);
  if (link?.url && link.editing) { link.editing = false; renderContentTabs(true); }
}
function cancelLinkInput(id) {
  const { link } = linkById(id);
  if (link?.url && link.editing) { link.editing = false; renderContentTabs(true); }
}

// Close one extra tab. Falls back to the default tab if the closed one was active.
export function closeLink(id) {
  const tab = activeTab();
  if (!tab || !tab.links) return;
  if (!tab.links.some(l => l.id === id)) return;
  // Closing the LAST extra tab flips the bar multi→single (two half pills → one centered 560
  // pill). The normal shrink-out would let the survivor grow to fill the whole bar as the
  // closing tab collapses, THEN snap it down to 560 — a visible grow-then-shrink. So for the
  // 2→1 case, skip the shrink: snapshot the survivor at its half slot NOW, drop the closing tab
  // at once, and FLIP the survivor straight to its centered single size in one motion.
  const toSingle = tab.links.length === 1;
  const remove = () => {
    const j = tab.links.findIndex(l => l.id === id);
    if (j < 0) return;
    const prevRect = toSingle ? defaultChipRect() : null;
    disposeLink(tab.links[j]);
    tab.links.splice(j, 1);
    if (tab.activeLink === id) { tab.activeLink = null; paintLeft(tab); updateNavButtons(); }
    renderContentTabs(true);
    if (prevRect) flipDefaultChip(prevRect);
    saveTabs();
  };
  if (toSingle) remove();          // morph the survivor directly; no grow phase
  else playTabOut(id, remove);     // 3+→2+: shrink it out, siblings reflow to fill (no mode flip)
}

// "Close other tabs" — drop every extra tab, keep the default. The default can't be closed.
export function closeOtherLinks() {
  const tab = activeTab();
  if (!tab || !tab.links?.length) return;
  const prevRect = defaultChipRect();
  tab.links.forEach(disposeLink);
  tab.links = [];
  tab.activeLink = null;
  paintLeft(tab);
  updateNavButtons();
  renderContentTabs(true);
  flipDefaultChip(prevRect);
  saveTabs();
}

// Right-click an extra tab → close / close others. Native menu in the app (bridge.js ctabMenu),
// the in-page menu as the browser fallback — same shape as sessionMenu/folderMenu.
export async function ctabMenu(e, id) {
  e.preventDefault();
  if (window.taskhub?.ctabMenu) {
    closeMenu();
    const action = await window.taskhub.ctabMenu();
    if (action === 'close') closeLink(id);
    else if (action === 'closeOthers') closeOtherLinks();
    return false;
  }
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
    const task = term?.pairKey ? taskById(term.pairKey) : null;
    if (task?.url) tab = state.tabs.find(t => t.url === task.url) || null;
  }
  if (!tab) return;
  tab.links = tab.links || [];
  const want = normFilePath(filePath);
  let link = tab.links.find(l => l.kind === 'file' && normFilePath(l.path) === want);
  if (!link) { link = makeFileLink(filePath); tab.links.push(link); }
  if (line) link._pendingLine = line;
  tab.activeLink = link.id;
  leaveReview(tab);          // a file link wants to be SEEN — even if the Diff view was up
  if (state.activeTabId === tab.id) {
    showActiveView(tab);     // a ⌘-clicked path can arrive while the right pane is collapsed
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
      tabs: state.tabs.map(t => ({ kind: t.kind, title: t.title, url: t.url, cur: t.cur || '', repo: t.repo, branch: t.branch, jiraKey: t.jiraKey, paneView: t.paneView, category: t.category, login: t.login, avatar: t.avatar,
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
function saveTabsSoon() { clearTimeout(_saveTabsTimer); _saveTabsTimer = setTimeout(saveTabs, 800); }

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
    // A bare session's tab exists only for its task; if the task was removed while the window was
    // closed, the context is dead — don't rehydrate a tab with no session behind it.
    if (isSessionUrl(t?.url) && !state.tasks.some(x => x.url === t.url)) continue;
    if (t && t.url && !state.tabs.some(x => x.url === t.url)) {
      state.tabs.push(createTab(t.url, t.title, t.kind, { cur: t.cur, repo: t.repo, branch: t.branch, jiraKey: t.jiraKey, paneView: t.paneView, category: t.category, login: t.login, avatar: t.avatar, links: Array.isArray(t.links) ? t.links : [] }));
      seedAvatar(t.login, t.avatar);   // share the restored data URI so the dashboard reuses it
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
  // The terminal panel is always shown on a tab that can carry one; it belongs to the CONTEXT (the
  // default tab), not to which horizontal link is showing — switching links won't re-run this (see
  // setActiveLink). openPrPanel shows the live terminal, or the New Task empty state.
  // Not awaited: the tab must paint now, the terminal recovery lands when it lands. openPrPanel
  // guards itself against overlapping calls, so a click on "Reopen session" in the meantime joins
  // this run rather than starting a second one — and the button repaints once it settles.
  if (canSplitTerminal(cur)) openPrPanel(cur).then(() => { if (state.activeTabId === id) syncSessionButton(cur); });
  else clearPrLayout();
  syncSessionButton(cur);
  renderTabs();
  saveTabs();
}

// Hide ONE context's page elements (its default webview + every link webview/editor pane). The
// single teardown of "show no page here", shared by hideAllPanes and the collapsed split (split.js).
export function hideTabPanes(t) {
  if (t.wv) { t.wv.style.display = 'none'; t.wv.syncBounds?.(); }     // hide native child webview now, not on next rAF
  (t.links || []).forEach(l => { if (l.wv) { l.wv.style.display = 'none'; l.wv.syncBounds?.(); } if (l.ed) l.ed.style.display = 'none'; });
}

// Hide every left-pane element (default webviews + per-context link webviews/editor panes) +
// terminals + diff. The caller then shows one; applyPrLayout re-adds pane-diff when the
// incoming tab is in diff view.
export function hideAllPanes() {
  state.tabs.forEach(hideTabPanes);
  showEmptyPane(false);   // the blank-pane surface belongs to whichever context is showing
  for (const t of state.terms.values()) t.el.style.display = 'none';
  hideDiffPane();
  document.body.classList.remove('pane-diff', 'pane-build');
}

// Closing a web tab NEVER kills its task. A paired terminal is a deliberately-started task (worktree
// + terminal) — there are no auto-spawned bare shells anymore — so it keeps running in the background
// and shows in the sidebar; only the row's right-click Remove session (deleteTaskSession) or the shell exiting stops it.
// Closing the tab just unbinds + hides the pane; the PTY lives on (keyed to the task, so reopening
// the link re-adopts it).
export function closePairedTerm(tab) {
  if (!tab?.termId) return;
  const term = state.terms.get(tab.termId);
  if (term) term.el.style.display = 'none'; // keep the PTY alive; just unbind + hide
  tab.termId = null;
}

// Close a plain web tab (sidebar middle-click / native tab menu / ⌘W / the default chip's ×). A tab
// that belongs to a task session is NOT closable here — the session owns it, and the single way to
// drop it is the task row's right-click Remove session (tasks.js → removeTaskTab). Every browser-tab
// close path therefore no-ops on a task tab instead of half-removing the session's view.
export function closeTab(id) {
  const tab = state.tabs.find(t => t.id === id);
  if (!tab || taskForTab(tab)) return;
  removeTab(id);
}

// Unguarded removal — the session-removal path only (deleteTaskSession → removeTaskRecord).
export function removeTaskTab(id) { removeTab(id); }

function removeTab(id) {
  const i = state.tabs.findIndex(t => t.id === id);
  if (i < 0) return;
  const tab = state.tabs[i];
  closePairedTerm(tab);
  disposeBuildTerm(tab);   // the build PTY is paired, so nothing else would ever end it
  disposeWebview(tab);
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
  state.tabs.forEach(t => { closePairedTerm(t); disposeBuildTerm(t); disposeWebview(t); (t.links || []).forEach(disposeLink); });
  state.tabs = []; state.activeTabId = null; state.activeTermId = null;
  document.getElementById('split').hidden = true;
  document.body.classList.remove('viewing-tab', 'viewing-term', 'pr-split', 'pane-diff', 'pane-build', 'pane-blank', 'split-closed'); // restore <main>
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

// ── Page-load progress bar (inside the active content tab) ───────────────────────────
// Safari-style: a thin bar along the bottom of the ACTIVE content-tab chip (.ctab-load,
// clipped to the pill by .ctab's overflow:hidden). We drive two values on the persistent
// #ctabs element rather than inline styles on a chip — `--load-frac` (0–1, the width) and the
// `.loading` class (the fade) — so a chip rebuild on a title change can't wipe the progress;
// CSS reapplies it to whichever chip is .active. It tracks ONLY the shown webview (wireProgress
// gates on isShown). The Tauri shim feeds WKWebView estimatedProgress (did-progress); the
// Electron <webview> has no progress event, so there it just runs start→finish.
let _wvProgressTimer = null;
const _ctabsEl = () => document.getElementById('ctabs');
function setWvProgress(p) {
  const el = _ctabsEl();
  if (!el) return;
  if (_wvProgressTimer) { clearTimeout(_wvProgressTimer); _wvProgressTimer = null; }
  el.classList.add('loading');
  el.style.setProperty('--load-frac', String(Math.max(0.02, Math.min(1, p))));
}
// Snap to full, fade out, then (once invisible) zero the width so the next load grows from the left.
function finishWvProgress() {
  const el = _ctabsEl();
  if (!el) return;
  if (_wvProgressTimer) { clearTimeout(_wvProgressTimer); _wvProgressTimer = null; }
  el.classList.add('loading');
  el.style.setProperty('--load-frac', '1');
  _wvProgressTimer = setTimeout(() => {
    el.classList.remove('loading');
    _wvProgressTimer = setTimeout(() => el.style.setProperty('--load-frac', '0'), 300);
  }, 200);
}
// Hide immediately, no animation — used when the shown webview changes (tab/link switch).
function resetWvProgress() {
  const el = _ctabsEl();
  if (!el) return;
  if (_wvProgressTimer) { clearTimeout(_wvProgressTimer); _wvProgressTimer = null; }
  el.classList.remove('loading');
  el.style.setProperty('--load-frac', '0');
}
// Wire a webview's load events to the progress bar, but only while that webview is the shown one.
function wireProgress(wv, isShown) {
  wv.addEventListener('did-start-loading', () => { if (isShown()) setWvProgress(0.08); });
  wv.addEventListener('did-progress', e => { if (isShown()) setWvProgress(e.progress); });
  wv.addEventListener('did-stop-loading', () => { if (isShown()) finishWvProgress(); });
}

// Titles: PR/page title in the webview segment. In split mode the pane's name lives on
// the active view-switch button (segmented control), so the segment title stays empty;
// a solo full-width terminal (no switch visible) still gets the "Terminal" label.
export function updateTitles() {
  // The webview segment's title lives on the content bar's default chip (content-tabs.js) and the
  // terminal segment shows its folder chip instead of a label — nothing textual to fill here.
  updateFolderChip();
  refreshWorkflowBtn();
  syncSessionButton(activeTab());
  syncSplitToggle(activeTab());
}

// Split toggle (terminal segment, right edge). It exists wherever a terminal fills the panel — a
// PR/Jira session, a web-page session and a bare one alike — and only its pressed state differs;
// with no terminal there is nothing to collapse the pane onto, so it goes away.
function syncSplitToggle(tab) {
  const b = document.getElementById('split-toggle');
  if (!b) return;
  const live = !!(tab && tab.termId && state.terms.has(tab.termId));
  b.hidden = !live;
  if (!live) return;
  const open = rightPaneOpen(tab);
  b.classList.toggle('on', open);
  b.title = (open ? 'Hide the right panel' : 'Show the right panel') + ' (⌥⌘Return)';
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
export async function updateFolderChip(force = false) {
  const el = document.getElementById('split-folder');
  if (!el) return;
  const ide = document.getElementById('split-ide');
  const hideChip = () => {
    el.hidden = true; el.dataset.path = ''; el.dataset.worktree = ''; el.dataset.workspace = '';
    if (ide) { ide.hidden = true; ide.dataset.ide = ''; }
  };
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

  // Any context with a session resolves a folder (its task's worktree — resolveTabFolder); a PR or
  // Jira page resolves one from its project even before a session exists. A plain web page with
  // neither has no folder to show.
  if (!t || (t.kind === 'web' && !taskForTab(t))) { hideChip(); return; }
  const reqId = ++_folderReq;
  const tabId = t.id;
  const info = await resolveTabFolder(t).catch(() => null);
  if (reqId !== _folderReq || state.activeTabId !== tabId) return; // tab switched mid-resolve
  if (!info || !info.path) { hideChip(); return; }

  // The folder chip — always the current folder (the branch's worktree if one exists, else the
  // project workspace). Creating a worktree is no longer a chip CTA; it happens via New Task. The
  // folder NAME is not a segment: the worktree is already the session's title in the sidebar, so
  // repeating it here was dead weight. Finder lives in the right-click menu (and in the fallback
  // glyph, when no git client is configured).
  const isWorktree = !!info.isWorktree;
  el.dataset.path = info.path;
  // A worktree carries its workspace so the right-click menu can offer deletion (the main
  // checkout can't be deleted, so it leaves these blank).
  el.dataset.worktree = isWorktree ? '1' : '';
  el.dataset.workspace = isWorktree ? (info.workspace || '') : '';
  // Worktree state stays on the chip (see .is-worktree CSS: it accent-tints the stroke glyphs —
  // a brand <img> can't take the tint, so a git-client mark reads neutral either way).
  el.classList.toggle('is-worktree', isWorktree);
  const gc = state.gitClient || {};
  const gcOn = !!(gc.id && gc.cmd);
  const gcIcon = gcOn ? gitClientIcon(gc.id) : '';
  // A configured client without a brand mark (Custom deeplink, unknown id) falls back to the
  // folder/worktree glyph rather than an empty <img>; with no client at all the chip is still the
  // folder affordance (and the anchor for its right-click menu), so it reveals in Finder.
  const mark = gcIcon ? `<img src="${gcIcon}" alt="">` : (isWorktree ? ICON.worktree : ICON.folder);
  el.innerHTML = gcOn
    ? `<button type="button" class="fc-ic" onclick="folderChipClick()" title="${esc(`Open in ${gitClientLabel(gc.id)}`)}">${mark}</button>`
    : `<button type="button" class="fc-ic" onclick="openTabFolder()" title="${esc(`Reveal in Finder — ${info.path}`)}">${mark}</button>`;
  el.hidden = false;

  paintIdeChip(info);
}

// The IDE chip (#split-ide) — its own control beside the folder chip, so it can carry more than
// one action later (a Run half, say) without reshaping the folder chip. The IDE is a PROJECT
// setting (which editor a checkout belongs in is a property of the repo), resolved from the
// project this folder hangs off: info.workspace is that project's main checkout. Everything the
// click needs is cached on the element so it needs no second lookup.
function paintIdeChip(info) {
  const el = document.getElementById('split-ide');
  if (!el) return;
  const pj = projectByWorkspace(info.workspace);
  const cmd = resolveIdeCmd(pj?.ide, pj?.ideCmd);
  el.dataset.ide = cmd;
  el.dataset.ideId = cmd ? (pj?.ide || '') : '';
  // What to open inside the folder: the project's configured target (relative — it resolves per
  // worktree), and the probe to fall back on for an IDE that can't open a folder (Xcode). Kept
  // even with no IDE — {target} in the run script resolves through the same two settings.
  el.dataset.ideRel = pj?.ideTarget || '';
  el.dataset.ideProbe = ideProbe(pj?.ide);
  const icon = ideIcon(pj?.ide);
  const mark = icon ? `<img src="${icon}" alt="">` : ICON.code;   // 'custom' has no brand mark
  // Two independent halves: open (an IDE is set) and run (a script is set). A project can have
  // either, both, or neither — with neither there's nothing to show, so the chip stays hidden.
  const openHalf = cmd
    ? `<button type="button" class="fc-ic" onclick="openTabIde()" title="${esc(`Open in ${ideLabel(pj?.ide)}`)}">${mark}</button>`
    : '';
  el.innerHTML = openHalf + runHalfHtml(pj);
  el.hidden = !el.innerHTML;
}

// The play half, right of the IDE mark: runs the project's build/run script (project Settings →
// IDE card). No script configured → no button, so the chip stays a single launcher. While the
// build is running it becomes a stop square (⌃C into the build terminal).
function runHalfHtml(pj) {
  if (!pj?.runCmd) return '';
  const running = isBuilding(activeTab());
  return `<button type="button" class="fc-ic fc-run${running ? ' running' : ''}"
     onclick="${running ? 'stopBuild()' : 'runBuild()'}"
     title="${running ? 'Stop the running build (⌃C)' : esc('Run: ' + pj.runCmd.split('\n')[0])}">${running ? ICON.stop : ICON.play}</button>`;
}

// Toolbar play / stop. The run itself lives in build.js; setPaneView is passed in so build.js
// doesn't have to reach back into the split module (which already imports it).
export function runBuildClick() { runBuild(activeTab(), { setView: setPaneView, onState: syncBuildBtn }); }
export function stopBuildClick() { stopBuild(activeTab()); }

// Repaint just the play half — the build's busy state changed (setTermBusy), so the button has to
// flip between play and stop without re-resolving the folder.
function syncBuildBtn() {
  const el = document.getElementById('split-ide');
  if (!el || el.hidden) return;
  const t = activeTab();
  const ws = document.getElementById('split-folder')?.dataset.workspace || document.getElementById('split-folder')?.dataset.path || '';
  const pj = projectByWorkspace(ws);
  const cur = el.querySelector('.fc-run');
  const html = runHalfHtml(pj);
  if (cur) cur.outerHTML = html; else if (html) el.insertAdjacentHTML('beforeend', html);
}

// Folder-chip click: open the branch in the configured git client, else reveal in Finder.
export function folderChipClick() {
  const { id, cmd } = state.gitClient || {};
  const p = document.getElementById('split-folder')?.dataset.path;
  if (p && id && cmd) { window.taskhub?.openInGitClient?.(cmd, p); return; }
  openTabFolder();
}

// Open the chip's folder in the project's IDE. Same native launcher as the git client — it's the
// generic "{path} template" runner, not a git-specific one.
//
// What gets opened is not always the folder: Xcode opens DOCUMENTS, and a monorepo's IDE target
// may sit at a subpath. So the server resolves it (routes/file.js) from the project's configured
// target (relative to the checkout, so it lands in THIS branch's worktree) and, failing that, a
// per-IDE probe. Best-effort: any failure opens the folder, which is what most IDEs want anyway.
export async function openTabIde() {
  const el = document.getElementById('split-ide');
  const folder = document.getElementById('split-folder')?.dataset.path, cmd = el?.dataset.ide;
  if (!folder || !cmd) return;
  let target = folder;
  const rel = el.dataset.ideRel || '', probe = el.dataset.ideProbe || '';
  if (rel || probe) {
    try {
      const q = `path=${encodeURIComponent(folder)}&rel=${encodeURIComponent(rel)}&kind=${encodeURIComponent(probe)}`;
      const r = await api(`${ROUTES.LAUNCH_TARGET}?${q}`);
      if (r?.path) target = r.path;
      // A configured target that isn't in this worktree is worth saying out loud — the IDE would
      // just open the checkout and look like it ignored the setting.
      if (rel && r?.source !== 'configured') toast(`${rel} isn't in this worktree — opening the folder`);
    } catch { /* fall back to the folder */ }
  }
  window.taskhub?.openInGitClient?.(cmd, target);
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
  const ideEl = document.getElementById('split-ide');
  const ideId = ideEl?.dataset.ideId || '', hasIde = !!ideEl?.dataset.ide;
  if (window.taskhub?.folderMenu) {
    closeMenu(); // dismiss any open in-page menu (the native menu won't fire the click that would)
    const action = await window.taskhub.folderMenu({
      hasClient, clientLabel: hasClient ? gitClientLabel(id) : '',
      hasIde, ideLabel: hasIde ? ideLabel(ideId) : '', isWorktree,
    });
    if (action === 'client') folderChipClick();
    else if (action === 'ide') openTabIde();
    else if (action === 'finder') openTabFolder();
    else if (action === 'delete') removeTabWorktree();
    return false;
  }
  return openMenu(e, [
    hasClient && { label: `Open in ${gitClientLabel(id)}`, onClick: folderChipClick },
    hasIde && { label: `Open in ${ideLabel(ideId)}`, onClick: openTabIde },
    { label: 'Reveal in Finder', onClick: openTabFolder },
    isWorktree && { label: 'Delete worktree…', onClick: removeTabWorktree, danger: true },
  ]);
}

// Delete the chip's worktree through the single removal path (tasks.js → deleteWorktreeAt: in-app
// confirm, sessions on it stopped and forgotten, folder force-removed), then re-resolve so the chip
// falls back to the plain checkout / create CTA. The branch is left intact.
export async function removeTabWorktree() {
  const el = document.getElementById('split-folder');
  const workspace = el?.dataset.workspace, worktree = el?.dataset.path;
  if (!workspace || !worktree) return;
  if (await deleteWorktreeAt(workspace, worktree)) updateFolderChip(true);
}

// New task: open the active tab's terminal in its branch worktree, creating the worktree first
// if the branch isn't checked out anywhere yet. This is the SINGLE worktree-create entry point —
// "New session" / "Reopen session" (toolbar, left segment). Keyed on a LIVE terminal, not on the
// task record: any state where the page has no terminal beside it gets the button, so a session
// whose shell exited (or whose worktree vanished) is never stranded with no control at all. With a
// record it reopens that session (resuming its agent); with none it starts one. A solo terminal
// view hides it in CSS (body.viewing-term). Called from updateTitles, so every layout change syncs it.
function syncSessionButton(tab) {
  const b = document.getElementById('split-new-session');
  if (!b) return;
  const live = !!(tab && tab.termId && state.terms.has(tab.termId));
  b.hidden = !tab || live;
  if (b.hidden) return;
  // A recovery started by activateTab is still running (it isn't awaited there): the button has to
  // stay visible — the terminal isn't live yet — but pressing it would only join that same run, so
  // show it busy instead. openPrPanel clears the flag when it settles; the next paint re-enables.
  b.disabled = !!tab._panelPromise;
  const again = !!taskForTab(tab);
  b.querySelector('span').textContent = again ? 'Reopen session' : 'New session';
  b.title = again ? 'Reopen this page’s session' : 'Create a session for this page';
}

// Start (or reopen) a session for the active tab — the one path from a page to a worktree + agent.
// A tab whose session record survives but whose terminal is gone reopens it, resuming the agent.
// Otherwise, no dialog:
// the branch is derived, the worktree created and the default agent launched in one click (what the
// old New Task button did). A PR or Jira tab already names its branch (the PR's head ref;
// feature/<KEY>-<slug> for a ticket). A plain web page names nothing, so it takes the next free
// worktree name off its project's default branch — and only asks WHICH project, and only when there
// is more than one. Either way the task record links back to the tab by url, so the tab leaves the
// sidebar's Tabs group and shows as that project's session row.
export async function newSession(ev, project = null) {
  const tab = activeTab();
  if (!tab || (tab.termId && state.terms.has(tab.termId))) return; // already has its terminal
  const btn = document.getElementById('split-new-session');
  const busy = on => { if (btn) btn.disabled = on; };
  // A session already exists for this page — its shell just isn't running. Reopen it (openPrPanel
  // recreates the terminal on the recorded worktree and resumes the agent); failures toast there.
  if (taskForTab(tab)) {
    busy(true);
    try { await openPrPanel(tab, 'term'); } finally { busy(false); updateTitles(); }
    return;
  }
  // ── A page that names no branch of its own: pick the project, then take the next free name.
  if (tab.kind === 'web') {
    if (!project) {
      const projects = state.projects.filter(p => p.workspace);
      if (!projects.length) { toastErr('Add a project with a local workspace first'); return; }
      if (projects.length > 1) {
        const r = ev?.currentTarget?.getBoundingClientRect();
        const at = r ? { preventDefault() {}, clientX: r.left, clientY: r.bottom + 6 } : ev;
        openMenu(at, projects.map(p => ({ label: p.name, onClick: () => newSession(null, p) })));
        return;
      }
      project = projects[0];
    }
    busy(true);
    try {
      const pick = await suggestSession(project);
      if (!pick) { toastErr(`Couldn't read ${project.name}'s branches`); return; }
      const worktree = await ensureWorktree(project, pick.branch, { base: pick.base });
      if (!worktree) return;
      toast(`Worktree created for ${pick.branch}`);
      await ensurePrTerminal(tab, worktree, { branch: pick.branch, project }); // creates the task, linked by url
      await afterSession(tab, worktree, state.defaultCli);
    } catch (e) { toastErr('Failed to start session: ' + e.message); }
    finally { busy(false); }
    return;
  }
  // ── A PR or Jira tab: the branch is already decided, so no dialog.
  busy(true);
  try {
    const f = await resolveTabFolder(tab);
    let cwd = f.path; // where the terminal opens — the just-created worktree if we create one below
    const key = tab.jiraKey || jiraKeyFromUrl(tab.url) || '';
    const branch = tab.kind === 'jira'
      ? jiraTaskBranch(key, jiraByKey(key)?.summary || '')
      : (tab.branch || prByUrl(tab.url)?.headRefName || '');
    // A branch already checked out in the MAIN checkout can't get a worktree (git refuses a second
    // checkout) and a session never runs on the main repo — say so instead of half-creating one.
    if (f.matched && !f.isWorktree) { toastErr(`${branch || 'This branch'} is checked out in the main repo — switch it away there first.`); return; }
    if (!f.matched && f.workspace && branch) {
      // One conflict path for every worktree create (tasks.js → ensureWorktree): a non-worktree
      // folder in the way is confirmed in-app (the webview swallows native confirm()); failures toast.
      const created = await ensureWorktree({ workspace: f.workspace }, branch, { create: tab.kind === 'jira' });
      if (!created) return;
      toast(`Worktree created for ${branch}`);
      cwd = created;
      updateFolderChip(true);
    }
    await ensurePrTerminal(tab, cwd, { branch }); // creates the task record, linked by url
    await afterSession(tab, cwd, state.defaultCli);
  } catch (e) { toastErr('Failed to start session: ' + e.message); }
  finally { busy(false); }
}

// Shared tail: show the terminal, drop the button, re-render the sidebar (the tab is a session row
// now), and drop into the agent — stamping it (+ its minted conversation id) on the task so a
// stopped session resumes the same conversation.
async function afterSession(tab, cwd, cli) {
  if (state.activeTabId === tab.id) applyPrLayout(tab, 'term'); // the session is new: slide the terminal in from the left
  syncSessionButton(tab);
  updateTitles();
  renderTabs();
  const launched = cli ? await launchCli(tab.termId, cwd, cli) : null;
  const task = taskForTab(tab);
  if (task && cli) persistTask({ id: task.id, cli, ...(launched?.sessionId && { sessionId: launched.sessionId }) });
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
  seedAvatar(login, data);   // share it: the dashboard card for this author reuses it, no re-fetch
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
    window.__openTab(url, '', 'web', '');
  };
}
