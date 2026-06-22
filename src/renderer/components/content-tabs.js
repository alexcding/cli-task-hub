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
import { esc, ghAvatarSrc } from '../lib/util.js';
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
   </div>`;
}

function linkChipHtml(t, l) {
  const active = t.activeLink === l.id;
  // A blank (just-added) or being-edited tab is an inline address field — Safari compact:
  // a magnifier glyph + the field, with a blue focus ring (see .ctab.editing CSS).
  if (l.editing || !l.url) {
    const magnifier = `<span class="ctab-ic">${ICON.search}</span>`;
    return `<div class="ctab editing active" data-id="${l.id}">
       ${magnifier}
       <input class="ctab-input" type="text" spellcheck="false" autocomplete="off"
              placeholder="Search or enter a URL or file path" value="${esc(l.url || '')}"
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
        onclick="setActiveLink('${l.id}')" oncontextmenu="return ctabMenu(event,'${l.id}')"
        ondblclick="editLink('${l.id}')" title="${esc(l.url || '')}">
     ${linkIcon(l)}
     <span class="ctab-title">${esc(l.title || l.url || '')}</span>
     ${save}<button class="ctab-btn ctab-x" title="Close tab" onclick="event.stopPropagation();closeLink('${l.id}')">${ICON.close}</button>
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
  if (el._lastHtml !== html) {
    el.innerHTML = html;
    el._lastHtml = html;
    // Focus a freshly-rendered inline input (a just-added / being-edited tab).
    const input = el.querySelector('.ctab.editing .ctab-input');
    if (input && document.activeElement !== input) input.focus();
  }
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
  if (!el) { done(); return; }
  let called = false;
  const fin = () => { if (called) return; called = true; done(); };
  el.classList.add('ctab-closing');
  el.addEventListener('animationend', fin, { once: true });
  setTimeout(fin, 290);
}

