// Find-in-page for the embedded webview (⌘F). Electron's <webview> exposes Chromium's
// native find — findInPage()/stopFindInPage() + the found-in-page event — the very same
// highlight engine Chrome's own ⌘F drives. We use it rather than re-implementing a DOM
// search: the page lives in another process behind the webview boundary, so the renderer
// can't reach its DOM, and the native path highlights every match + scrolls to the active
// one for free. The bar itself is shared markup in split-body; it always acts on the active
// tab's webview (and only when a page — not a terminal — is the view).
import { state } from '../stores/store.js';
import { activeLeftWebview } from './viewer.js';

const bar   = () => document.getElementById('find-bar');
const input = () => document.getElementById('find-input');
const count = () => document.getElementById('find-count');

// The webview to search: whichever page is shown in the LEFT content pane (the default PR
// page OR the active web link), but only when a page — not a terminal — is on screen. Routes
// through activeLeftWebview so find follows the active content tab, not just the default.
function targetWv() {
  if (state.activeTermId) return null;
  const wv = activeLeftWebview();
  return wv && wv.src ? wv : null;
}

export function findVisible() { return !!(bar() && !bar().hidden); }

// Wire a tab's webview so its native find results land in the bar. Called from createTab so
// every tab (new and restored) reports while it's the active one.
export function attachFind(wv) {
  wv.addEventListener('found-in-page', e => {
    const r = e.result;
    if (!r || !findVisible()) return;
    const c = count();
    if (!c) return;
    if (!r.matches) c.textContent = input()?.value ? 'No results' : '';
    else c.textContent = `${r.activeMatchOrdinal || 1}/${r.matches}`;
  });
}

// Drive a single find request. findNext:false starts a fresh search (re-highlights from the
// top as the query changes); findNext:true steps to the next/previous match of the same query.
function run(text, { findNext = true, forward = true } = {}) {
  const wv = targetWv();
  if (!wv) return;
  if (!text) { try { wv.stopFindInPage('clearSelection'); } catch {} const c = count(); if (c) c.textContent = ''; return; }
  try { wv.findInPage(text, { findNext, forward }); } catch {}
}

export function openFind() {
  if (!targetWv()) return;            // no page tab in view — nothing to search
  const b = bar();
  if (!b) return;
  b.hidden = false;
  const i = input();
  i.focus();
  i.select();                          // re-opening selects the prior query for quick replace
  if (i.value.trim()) run(i.value, { findNext: false });
}

// returnFocus is for the user-initiated close only (Esc / the × button): hand keyboard focus
// back to the page being read. The cleanup callers (activateTab/closeSplit/showPage) leave it
// off — they're about to hide or swap the webview, so focusing it would strand focus on a
// hidden element instead of the incoming view.
export function closeFind(returnFocus = false) {
  const b = bar();
  if (b) b.hidden = true;
  const wv = targetWv();
  try { wv?.stopFindInPage('clearSelection'); } catch {}
  if (returnFocus) { try { wv?.focus(); } catch {} }
}

// Step to the next (forward) or previous match of the current query. Only while the bar is
// open — otherwise ⌘G would re-highlight on the page (the input keeps its value after close)
// with no visible bar to show the match count.
export function findNext(forward = true) {
  if (!findVisible()) return;
  const v = input()?.value || '';
  if (v) run(v, { findNext: true, forward });
}

// Live search as the query changes — a fresh find on each keystroke.
export function onFindInput(e) { run(e.target.value, { findNext: false }); }

export function onFindKey(e) {
  if (e.key === 'Enter') { e.preventDefault(); findNext(!e.shiftKey); }
  else if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); closeFind(true); } // don't bubble to the Esc-closes-viewer handler
}
