// Safari-compact horizontal tab bar for the viewer's LEFT content pane (#ctabs, inline in
// the toolbar's webview segment, after the "+" that adds a tab). This bar is its OWN set of
// tabs — it does NOT mirror the sidebar's vertical PR/Jira tabs.
//
// The bar belongs to the ACTIVE viewer tab (the "context"): its first chip is the default
// tab (the PR/Jira page — read-only url; its × closes the context), then everything the user has
// opened — web/file tabs, a Diff chip (the worktree's `git diff`, drawn over the page;
// tab.paneView === 'diff'), a Build chip — each WHERE IT WAS OPENED, immediately after whatever was
// active at the time (chipEntries below), not in a fixed slot. NOTHING but the context's own page is on the bar
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

// ── The strip's order ─────────────────────────────────────────────────────────
// The page chip is always first — it IS the context, not something the user opened. Everything
// after it is one ordered list, tab.chipOrder: the ids of the extras ('diff', 'build', or a link's
// id) in the order they sit on the bar. A new tab is spliced in right after the ACTIVE one
// (browser behaviour), which is the whole reason the order is state and not a set of fixed slots.
//
// ONE list, not an index per chip: two indices can name the same slot, and whichever chip the
// composition happened to splice first won the tie — a Diff opened beside the page chip landed
// behind a Build that also claimed position 0.
//
// Only the links (and where the Diff sits among them) survive a restart: tab.links is persisted in
// order and `tabs.diff_pos` is the Diff's index among them, so chipOrder is rebuilt by
// initChipOrder below. A build terminal never outlives the app, so 'build' is runtime-only.
export function initChipOrder(t) {
  const ids = (t.links || []).map(l => l.id);
  if (t.diffOpen) ids.splice(Math.min(Math.max(t.diffIdx | 0, 0), ids.length), 0, 'diff');
  t.chipOrder = ids;
  return t.chipOrder;
}

// The bar, in order. Ids that name nothing live (a closed link, the Diff with no terminal beside
// the pane, a finished build) are skipped rather than removed, so a chip whose condition comes back
// — the terminal reconnecting under a Diff tab — returns to its own place. Anything live but
// unlisted (a restored context whose order was never built) is appended, so nothing can vanish.
export function chipEntries(t) {
  const live = new Map((t.links || []).map(l => [l.id, { type: 'link', l }]));
  if (hasDiffTab(t)) live.set('diff', { type: 'diff' });
  if (hasBuildTab(t)) live.set('build', { type: 'build' });
  const order = Array.isArray(t.chipOrder) ? t.chipOrder : initChipOrder(t);
  const out = [];
  for (const id of order) { const e = live.get(id); if (e) { out.push(e); live.delete(id); } }
  for (const e of live.values()) out.push(e);
  return out;
}

// Where a newly opened tab belongs: just after the active chip, as a position in tab.chipOrder.
// The page chip is active → the front of the list, so the new tab lands beside it rather than at
// the far end of the bar.
export function nextChipIdx(t) {
  const order = Array.isArray(t.chipOrder) ? t.chipOrder : initChipOrder(t);
  const active = inDiff(t) ? 'diff' : inBuild(t) ? 'build' : t.activeLink;
  const i = active ? order.indexOf(active) : -1;
  return i < 0 ? 0 : i + 1;
}

// A position in chipOrder, as an index into the LINKS array — the ids before it that are links.
// Keeps tab.links in bar order, which is what persistence stores (a link's runtime id means nothing
// after a restart, so the array's own sequence is the only record of where its tabs sat).
export function linkIdxAt(t, at) {
  const order = Array.isArray(t.chipOrder) ? t.chipOrder : initChipOrder(t);
  return order.slice(0, at).filter(id => id !== 'diff' && id !== 'build').length;
}

// The Diff's index among the links only — what `tabs.diff_pos` stores, since 'build' is not
// persisted and a link's runtime id means nothing after a restart.
export function diffPos(t) {
  const order = Array.isArray(t.chipOrder) ? t.chipOrder : initChipOrder(t);
  const i = order.indexOf('diff');
  return i < 0 ? 0 : order.slice(0, i).filter(id => id !== 'diff' && id !== 'build').length;
}

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

// Back / Forward / Home live in the pane's bottom strip beside a session, and in the TOOLBAR for a
// page that has no session — that state has its own chrome and no bottom strip at all. One group of
// buttons either way (they're the same three actions on the same webview), moved between the two
// homes rather than duplicated, so nothing can drift out of sync.
function placeBrowserNav(toBar) {
  const nav = document.getElementById('browser-nav');
  const want = document.getElementById(toBar ? 'bar-nav' : 'browser-foot');
  if (nav && want && nav.parentElement !== want) want.insertBefore(nav, want.firstChild);
}

// Render the bar for the active viewer tab. Hidden entirely when no tab is open.
export function renderContentTabs(force = false) {
  const el = document.getElementById('ctabs');
  if (!el) return;
  // Don't rebuild while the user is typing in an inline address field — an incidental churn
  // (an SSE refresh, a sibling tab's title/favicon landing) would clobber the input + caret.
  // `force` is passed by the explicit actions (commit/close/switch) that MUST re-render.
  if (!force && el.contains(document.activeElement) && document.activeElement?.classList.contains('ctab-input')) return;
  const title = document.getElementById('bar-title');
  const t = activeTab();
  if (!t) {
    el.innerHTML = ''; el._lastHtml = ''; el.classList.remove('ctabs-single');
    document.body.classList.remove('page-only');
    if (title) { title.hidden = true; title.innerHTML = ''; }
    return;
  }
  // No session on this page → it is a single webview, not a context that can hold tabs: the Diff
  // needs a live terminal and a file needs its worktree, so the strip and the "+" have nothing to
  // offer. Show the page's title instead, centred, and let the toolbar's one action be the CTA that
  // turns this page INTO a session. (Extra tabs are not lost — they're still persisted, and come
  // back on the strip the moment the page has a session.)
  const soloPage = !(t.termId && state.terms.get(t.termId));
  document.body.classList.toggle('page-only', soloPage);
  placeBrowserNav(soloPage);
  if (title) {
    title.hidden = !soloPage;
    if (soloPage) setHtmlIfChanged(title, `${defaultIcon(t)}<span class="bar-title-t">${esc(t.title || t.url || '')}</span>`);
    else if (title.innerHTML) { title.innerHTML = ''; title._lastHtml = ''; }
  }
  if (soloPage) { el.innerHTML = ''; el._lastHtml = ''; el.classList.remove('ctabs-single'); return; }
  // With just the default tab (no extra tabs), cap the lone pill's width (CSS .bar-wv.single) —
  // it starts at the strip's left edge either way. Multiple tabs share the bar equally.
  const diffTab = hasDiffTab(t);
  // A bare session's context has no page, so it has no default chip — the bar is just the Diff
  // chip and whatever web tabs the user added (plus the toolbar's "+"). Same bar, one chip fewer.
  const page = hasPage(t);
  const single = page && !(t.links && t.links.length) && !diffTab && !hasBuildTab(t);
  el.classList.toggle('ctabs-single', single);
  el.closest('.bar-wv')?.classList.toggle('single', single);
  // The "+" is a static button in the segment's left group (.bar-nav), not rendered here.
  // The page chip, then the extras in the order they were opened in (chipEntries).
  const html = (page ? defaultChipHtml(t) : '')
    + chipEntries(t).map(e => e.type === 'diff' ? diffChipHtml(t)
      : e.type === 'build' ? buildChipHtml(t)
      : linkChipHtml(t, e.l)).join('');
  setHtmlIfChanged(el, html);
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

