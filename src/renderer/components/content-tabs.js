// Safari-compact horizontal tab bar for the viewer's LEFT content pane (#ctabs, inline in
// the toolbar's webview segment after the back/home controls). This bar is its OWN set of
// tabs — it does NOT mirror the sidebar's vertical PR/Jira tabs.
//
// The bar belongs to the ACTIVE viewer tab (the "context"): its first chip is the default
// tab (the PR/Jira page — read-only url, non-closable, owns the right-side split), followed
// by that context's extra web/file tabs and a `+`. Extra tabs are added only two ways: the
// user's `+` (type a URL or file path inline) or a file link clicked in the terminal. They
// render in the left pane only; switching among them never touches the right split view.
//
// Data lives on the active viewer tab: tab.links[] + tab.activeLink (null = default). All
// mutations live in viewer.js (added to window.*); this module only renders + reads.
import { state, activeTab, prByUrl } from '../stores/store.js';
import { esc, ghAvatarSrc, setHtmlIfChanged } from '../lib/util.js';
import { ICON, TAB_ICON } from '../lib/icons.js';
import { ciInfo } from './cards.js';

// Icon for the default (context) chip — the PR author's avatar + CI badge, or the Jira mark.
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
  return `<span class="ctab-ic">${TAB_ICON.jira || ICON.globe}</span>`;
}

// Icon for an extra tab — the page favicon (once loaded) or a globe for web; a doc for file.
function linkIcon(l) {
  if (l.kind === 'file') return `<span class="ctab-ic">${ICON.file}</span>`;
  if (l.icon) return `<span class="ctab-ic"><img src="${esc(l.icon)}" alt="" loading="lazy"></span>`;
  return `<span class="ctab-ic">${ICON.globe}</span>`;
}

function defaultChipHtml(t) {
  const active = !t.activeLink;
  return `<div class="ctab default ${active ? 'active' : ''}"
        onclick="setActiveLink(null)" title="${esc(t.url || '')}">
     ${defaultIcon(t)}
     <span class="ctab-title">${esc(t.title || '')}</span>
     <i class="ctab-load"></i>
   </div>`;
}

function linkChipHtml(t, l) {
  const active = t.activeLink === l.id;
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

// Render the bar for the active viewer tab. Hidden entirely when no tab is open.
export function renderContentTabs(force = false) {
  const el = document.getElementById('ctabs');
  if (!el) return;
  // Don't rebuild while the user is typing in an inline address field — an incidental churn
  // (an SSE refresh, a sibling tab's title/favicon landing) would clobber the input + caret.
  // `force` is passed by the explicit actions (commit/close/switch) that MUST re-render.
  if (!force && el.contains(document.activeElement) && document.activeElement?.classList.contains('ctab-input')) return;
  const t = activeTab();
  if (!t) { el.innerHTML = ''; el._lastHtml = ''; el.classList.remove('ctabs-single'); return; }
  // With just the default tab (no extra tabs), center a larger pill against the whole bar
  // (CSS .bar-wv.single balances the side groups). Multiple tabs share the bar equally.
  const single = !(t.links && t.links.length);
  el.classList.toggle('ctabs-single', single);
  el.closest('.bar-wv')?.classList.toggle('single', single);
  // The New-tab "+" is a static button in the toolbar (pinned far right), not rendered here.
  const html = defaultChipHtml(t) + (t.links || []).map(l => linkChipHtml(t, l)).join('');
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
  el.querySelectorAll('.ctab').forEach(node => {
    const active = node.classList.contains('default') ? !t.activeLink : node.dataset.id === t.activeLink;
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

