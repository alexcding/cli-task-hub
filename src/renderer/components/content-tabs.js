// Safari-compact horizontal tab bar for the viewer's LEFT content pane (#ctabs, inline in
// the toolbar's webview segment, after the "+" that adds a tab). This bar is its OWN set of
// tabs — it does NOT mirror the sidebar's vertical PR/Jira tabs.
//
// The bar belongs to the ACTIVE viewer tab (the "context"): its first chip is the default
// tab (the PR/Jira page — read-only url; its × closes the context), then — if the user has added
// it — a Diff chip (the worktree's `git diff`, drawn over the page; tab.paneView === 'diff'),
// followed by that context's extra web/file tabs. NOTHING but the context's own page is on the bar
// by default: a fresh pane has nothing open in it, and the Diff is a tab you add like any other.
// The `+` that adds one is a static button in the segment's LEFT group, ahead of the strip; it
// opens a menu (viewer.js → ctabAdd) of what this pane can hold — Diff, a web page, a file.
// Extra tabs are added only three ways: that menu, ⇧⌘D (the Diff), or a file link clicked in the
// terminal. Picking a page chip leaves the Diff view; the terminal beside the pane is never
// touched by any of this.
//
// Data lives on the active viewer tab: tab.links[] + tab.activeLink (null = default). All
// mutations live in viewer.js (added to window.*); this module only renders + reads.
import { state, activeTab, prByUrl } from '../stores/store.js';
import { esc, ghAvatarSrc, setHtmlIfChanged, hasPage } from '../lib/util.js';
import { ICON, TAB_ICON } from '../lib/icons.js';
import { ciInfo } from './cards.js';
import { taskForTab } from '../services/tasks.js';
import { buildTerm } from './build.js';

// Icon for the default (context) chip — the PR author's avatar + CI badge, the Jira mark, or a globe (web tab).
function defaultIcon(t) {
  if (t.kind === 'github') {
    const pr = prByUrl(t.url);
    const login = pr?.author?.login || t.login;
    const { cls, label } = ciInfo(pr?.ci);
    const badge = cls === 'ci-none' ? '' : `<span class="ci-badge ${cls}" title="${esc(label)}"></span>`;
    const src = ghAvatarSrc(login, t.avatar);
    const inner = src ? `<img src="${src}" alt="" loading="lazy">` : TAB_ICON.github;
    return `<span class="ctab-ic" title="${login ? esc(login) : ''}">${inner}${badge}</span>`;
  }
  return `<span class="ctab-ic">${TAB_ICON[t.kind] || ICON.globe}</span>`; // jira mark, or a globe for a web tab
}

// Icon for an extra tab — the page favicon (once loaded) or a globe for web; a doc for file.
function linkIcon(l) {
  if (l.kind === 'file') return `<span class="ctab-ic">${ICON.file}</span>`;
  if (l.icon) return `<span class="ctab-ic"><img src="${esc(l.icon)}" alt="" loading="lazy"></span>`;
  return `<span class="ctab-ic">${ICON.globe}</span>`;
}

// The Diff chip exists once the user has ADDED it (`tab.diffOpen`, persisted per context) and
// only while the split is open with a live terminal (the diff needs its worktree). While it's the
// shown view no page chip is active. Both are PURE STATE predicates (no DOM class) so a paint that
// runs before split.js has synced body.pane-diff — activateTab's first paintLeft — still agrees
// with what the split will show; viewer.js imports inDiff for that.
const hasDiffTab = t => !!(t && t.diffOpen && t.termId && state.terms.get(t.termId));
export const inDiff = t => hasDiffTab(t) && t.paneView === 'diff';
// The Build chip appears once this context HAS a build terminal (the toolbar's play button made
// one); it's the way back to the output after looking at the page or the diff.
const hasBuildTab = t => !!buildTerm(t);
export const inBuild = t => hasBuildTab(t) && t.paneView === 'build';

function buildChipHtml(t) {
  return `<div class="ctab source buildtab ${inBuild(t) ? 'active' : ''}"
        onclick="setPaneView('build')" title="Output of this worktree's build">
     <span class="ctab-ic">${ICON.play}</span>
     <span class="ctab-title">Build</span>
   </div>`;
}

function diffChipHtml(t) {
  return `<div class="ctab source ${inDiff(t) ? 'active' : ''}" data-id="diff"
        onclick="setPaneView('diff')" title="Working changes in the task's worktree (⇧⌘D)">
     <span class="ctab-ic">${ICON.branch}</span>
     <span class="ctab-title">Diff</span>
     <button class="ctab-btn ctab-x" title="Close tab" onclick="event.stopPropagation();closeDiffTab()">${ICON.close}</button>
   </div>`;
}

// The default chip IS the context (the sidebar's PR/Jira tab), so its × closes the whole context —
// page, extra tabs, and the paired terminal binding — exactly like closing it from the sidebar. A
// task session's tab has no ×: it is removed only via the task row's right-click Remove session.
function defaultChipHtml(t) {
  const active = !t.activeLink && !inDiff(t);
  const x = taskForTab(t) ? '' : `<button class="ctab-btn ctab-x" title="Close tab" onclick="event.stopPropagation();closeTab('${t.id}')">${ICON.close}</button>`;
  return `<div class="ctab default ${active ? 'active' : ''}"
        onclick="setActiveLink(null)" title="${esc(t.url || '')}">
     ${defaultIcon(t)}
     <span class="ctab-title">${esc(t.title || '')}</span>
     ${x}
     <i class="ctab-load"></i>
   </div>`;
}

function linkChipHtml(t, l) {
  const active = t.activeLink === l.id && !inDiff(t);
  // A blank (just-added) or being-edited tab is a bare inline address field — just the outlined
  // pill (the blue focus ring from .ctab.editing) and the input. No magnifier glyph, no placeholder.
  if (l.editing || !l.url) {
    return `<div class="ctab editing ${active ? 'active' : ''}" data-id="${l.id}">
       <input class="ctab-input" type="text" spellcheck="false" autocomplete="off"
              value="${esc(l.url || '')}"
              onkeydown="ctabInputKey(event,'${l.id}')" onblur="ctabInputBlur('${l.id}')">
       <button class="ctab-btn ctab-x" title="Close tab" onmousedown="event.preventDefault()"
               onclick="event.stopPropagation();closeLink('${l.id}')">${ICON.close}</button>
     </div>`;
  }
  const dirty = l.kind === 'file' && l.dirty;
  const save = dirty
    ? `<button class="ctab-btn ctab-save" title="Save (⌘S)" onclick="event.stopPropagation();saveLinkFile('${l.id}')">${ICON.save}</button>`
    : '';
  return `<div class="ctab ${active ? 'active' : ''} ${dirty ? 'dirty' : ''}" data-id="${l.id}"
        onclick="ctabClick('${l.id}')" oncontextmenu="return ctabMenu(event,'${l.id}')"
        title="${esc(l.url || '')}">
     ${linkIcon(l)}
     <span class="ctab-title">${esc(l.title || l.url || '')}</span>
     ${save}<button class="ctab-btn ctab-x" title="Close tab" onclick="event.stopPropagation();closeLink('${l.id}')">${ICON.close}</button>
     <i class="ctab-load"></i>
   </div>`;
}

// The "+" — opens the menu of what this pane can hold (Diff / Web page… / File…; viewer.js ctabAdd).
// A bare plus: the panel outline it once wore read as a second split toggle at the other end of the
// same bar. Sized by .ctab-add svg.
function addBtnHtml() {
  return `<button class="ctab-add" id="ctab-add" title="Add to this panel" onclick="return ctabAdd(event)">
     <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>
   </button>`;
}

// Render the bar for the active viewer tab. Hidden entirely when no tab is open.
export function renderContentTabs(force = false) {
  const el = document.getElementById('ctabs');
  if (!el) return;
  // Don't rebuild while the user is typing in an inline address field — an incidental churn
  // (an SSE refresh, a sibling tab's title/favicon landing) would clobber the input + caret.
  // `force` is passed by the explicit actions (commit/close/switch) that MUST re-render.
  if (!force && el.contains(document.activeElement) && document.activeElement?.classList.contains('ctab-input')) return;
  const t = activeTab();
  if (!t) { el.innerHTML = ''; el._lastHtml = ''; el.classList.remove('ctabs-single', 'ctabs-empty'); return; }
  // With just the default tab (no extra tabs), center a larger pill against the whole bar
  // (CSS .bar-wv.single balances the side groups). Multiple tabs share the bar equally.
  const diffTab = hasDiffTab(t);
  // A bare session's context has no page, so it has no default chip — the bar is just the Diff
  // chip and whatever web tabs the user added (plus the toolbar's "+"). Same bar, one chip fewer.
  const page = hasPage(t);
  const single = page && !(t.links && t.links.length) && !diffTab && !hasBuildTab(t);
  el.classList.toggle('ctabs-single', single);
  el.closest('.bar-wv')?.classList.toggle('single', single);
  const chips = (page ? defaultChipHtml(t) : '') + (diffTab ? diffChipHtml(t) : '')
    + (hasBuildTab(t) ? buildChipHtml(t) : '')
    + (t.links || []).map(l => linkChipHtml(t, l)).join('');
  // …then the "+", trailing the chips like a browser's new-tab button. With no chips it is the
  // strip's only child, and .ctabs-empty drops the strip's leading margin so it sits exactly where
  // it used to live in .bar-nav — the segment's left edge.
  el.classList.toggle('ctabs-empty', !chips);
  setHtmlIfChanged(el, chips + addBtnHtml());
}

// Focus (+ select) a specific tab's inline address field — called EXPLICITLY when a tab is added
// or re-entered for editing. renderContentTabs no longer auto-focuses: now that blank tabs persist,
// a blanket focus-on-render grabbed the lingering field on every incidental rebuild (a sibling
// tab's title/favicon landing), so focus kept jumping to the newest blank tab.
export function focusCtabInput(id) {
  const input = document.querySelector(`#ctabs .ctab[data-id="${id}"] .ctab-input`);
  if (input && document.activeElement !== input) { input.focus(); input.select(); }
}

// Switch the active chip WITHOUT a full rebuild — just move the .active class on the existing
// chips. Lets the pill fill animate (the .ctab color transition) instead of snapping on rebuild.
export function markActiveTab() {
  const t = activeTab();
  const el = document.getElementById('ctabs');
  if (!t || !el) return;
  const diff = inDiff(t), build = inBuild(t);
  el.querySelectorAll('.ctab').forEach(node => {
    // The two pinned chips (Diff, Build) own the pane outright; while either is showing, no page
    // chip is active.
    const active = node.classList.contains('buildtab') ? build
      : node.classList.contains('source') ? diff
      : diff || build ? false
      : node.classList.contains('default') ? !t.activeLink
      : node.dataset.id === t.activeLink;   // a page-less context has no default chip: nothing is active until a view is picked
    node.classList.toggle('active', active);
  });
}

// Grow a just-added tab in (the bar rebuilds wholesale, so animate the specific element).
export function playTabIn(id) {
  const el = document.querySelector(`#ctabs .ctab[data-id="${id}"]`);
  if (!el) return;
  el.classList.add('ctab-entering');
  el.addEventListener('animationend', () => el.classList.remove('ctab-entering'), { once: true });
}

// Shrink a tab out, THEN run `done` (the real removal + re-render). A timeout backstops a
// missed animationend so the tab always closes.
export function playTabOut(id, done) {
  const el = document.querySelector(`#ctabs .ctab[data-id="${id}"]`);
  // No element, or reduced motion (the close animation is suppressed, so animationend never
  // fires and we'd wait out the timeout for nothing) → remove immediately.
  if (!el || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) { done(); return; }
  let called = false;
  const fin = () => { if (called) return; called = true; done(); };
  el.classList.add('ctab-closing');
  el.addEventListener('animationend', fin, { once: true });
  setTimeout(fin, 290);
}

// Snapshot the default chip's screen rect — call BEFORE a rebuild that may flip the bar into
// (or out of) single mode, then pass the result to flipDefaultChip() AFTER the rebuild.
export function defaultChipRect() {
  return document.querySelector('#ctabs .ctab.default')?.getBoundingClientRect() || null;
}

// FLIP the default chip from a prior rect to its new resting place. Closing the last extra tab
// switches the bar from multi (each pill fills, left-aligned) to single (one wide pill, centered)
// — two different flex layouts on a freshly-rebuilt element, which otherwise snaps. We morph it:
// flex-basis carries the WIDTH (real layout, so the pill/text never distort) and a translateX
// carries the POSITION shift. Both are visual-only — no surrounding layout moves. Reversible:
// works for single→multi too (e.g. when re-rendered with a new sibling).
export function flipDefaultChip(prev) {
  const el = document.querySelector('#ctabs .ctab.default');
  if (!el || !prev) return;
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
  // Bail if the chip didn't actually move/resize — measure its NATURAL (post-rebuild) rect and
  // compare to the prior one. (Must read this BEFORE pinning flexBasis, which would force the
  // width to prev.width and make any width comparison trivially true.)
  const now = el.getBoundingClientRect();
  if (Math.abs(prev.left - now.left) < 0.5 && Math.abs(prev.width - now.width) < 0.5) return;
  el.style.flexBasis = prev.width + 'px';          // First: pin the old width
  const mid = el.getBoundingClientRect();          //   …and read where that width now sits
  const dx = prev.left - mid.left;                 //   …then offset back to the old position
  el.style.transform = `translateX(${dx}px)`;
  el.getBoundingClientRect();                       // flush the inverted state before transitioning
  el.style.transition = 'transform .26s cubic-bezier(.32,.72,0,1), flex-basis .26s cubic-bezier(.32,.72,0,1)';
  el.style.flexBasis = '';                          // Play: settle width back to its CSS size…
  el.style.transform = 'none';                      //   …and position back to natural
  const cleanup = () => { el.style.transition = ''; el.style.transform = ''; el.style.flexBasis = ''; };
  el.addEventListener('transitionend', cleanup, { once: true });
  setTimeout(cleanup, 340);
}

