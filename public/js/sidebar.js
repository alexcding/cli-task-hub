// Left sidebar: project nav, the grouped open-tab rows, drag-reorder, and the
// right-click tab menu.
import { state, prByUrl, prGroup, setProjects } from './store.js';
import { PR_CATEGORY, PR_GROUP } from '/shared/constants.mjs';
import { esc, ghAvatarSrc } from './util.js';
import { ICON, TAB_ICON } from './icons.js';
import { ciInfo } from './views/cards.js';
import { openMenu } from './menu.js';
import { activateTab, closeTab, closeSplit, confirmCloseTabTerminals, closePairedTerm, saveTabs, updateTitles } from './viewer.js';

// Render the open tabs as grouped rows in the left nav, and show the active tab's
// title in the viewer header.
export function renderTabs() {
  const navEl = document.getElementById('opentabs-nav');
  if (navEl) {
    const html = tabsMarkup();
    // Skip the innerHTML churn (and Sortable re-init) when nothing changed — SSE
    // refreshes re-render frequently but the tab rows rarely differ.
    if (navEl._lastHtml !== html) {
      navEl.innerHTML = html;
      navEl._lastHtml = html;
      initTabSort();
    }
  }
  updateTitles();
}

// Grouped sidebar markup: GitHub groups (Mine/Review) then a Jira group, each a list
// of .opentab rows. Left-click activates, middle-click closes, right-click opens a menu.
function tabsMarkup() {
  // GitHub tabs show the PR author's avatar (github.com/<login>.png, no API call),
  // with the CI status as a colored badge. Fall back to the GitHub octicon.
  const itemHtml = t => {
    let icon;
    if (t.kind === 'github') {
      const pr = prByUrl(t.url);
      // Prefer the live author, fall back to the login persisted on the tab so the avatar
      // survives a state.projects reload (Jira/Settings) and shows on cold start before the
      // dashboard snapshot lands — mirrors the category fallback below. CI has no fallback:
      // it's live-only (a persisted badge would go stale).
      const login = pr?.author?.login || t.login;
      const { cls, label } = ciInfo(pr?.ci);
      // CI shown as a Slack-style status badge on the avatar's bottom-right corner.
      const badge = cls === 'ci-none' ? '' : `<span class="ci-badge ${cls}" title="${esc(label)}"></span>`;
      // Prefer the avatar frozen onto the tab (a data URI — never re-fetches, never
      // flickers); fall back to the live github.com URL, then the octicon.
      const src = ghAvatarSrc(login, t.avatar);
      const inner = src ? `<img src="${src}" alt="" loading="lazy">` : TAB_ICON.github;
      icon = `<span class="tab-ic" title="${login ? esc(login) : ''}">${inner}${badge}</span>`;
    } else {
      icon = `<span class="tab-ic">${TAB_ICON[t.kind] || ''}</span>`;
    }
    return `<div class="opentab ${t.id === state.activeTabId ? 'active' : ''}" data-id="${t.id}"
          onclick="activateTab('${t.id}')"
          onauxclick="if(event.button===1){event.preventDefault();closeTab('${t.id}')}"
          oncontextmenu="return tabMenu(event,'${t.id}')" title="${esc(t.url)}">
       ${icon}
       <span class="tab-title">${esc(t.title)}</span>
       <button class="tab-x" onclick="event.stopPropagation();closeTab('${t.id}')" title="Close tab">${ICON.close}</button>
     </div>`;
  };
  // Render one labeled group of tab rows; self-hides when empty. `attrs` are extra
  // attributes on the wrapper (data-kind/data-cat used for drag-reorder scoping).
  const groupHtml = (label, attrs, items) =>
    items.length ? `<div class="tab-group" ${attrs}><span class="tab-group-label">${label}</span>${items.map(itemHtml).join('')}</div>` : '';
  const group = (label, kind) => groupHtml(label, `data-kind="${kind}"`, state.tabs.filter(t => t.kind === kind));
  // GitHub tabs split into Mine vs Review (same split as the dashboard sections). Prefer
  // the live PR (prGroup understands awaitingMyReview, so a commented PR groups under
  // Review not Mine); fall back to the group saved on the tab so a restored tab (or one
  // whose PR has merged and left the snapshot) keeps its group instead of vanishing.
  const ghCat = t => {
    const pr = prByUrl(t.url);
    return pr ? prGroup(pr) : (t.category === PR_CATEGORY.REVIEW ? PR_GROUP.REVIEW : PR_GROUP.MINE);
  };
  const ghGroup = (label, cat) =>
    groupHtml(label, `data-kind="github" data-cat="${cat}"`, state.tabs.filter(t => t.kind === 'github' && ghCat(t) === cat));
  // Only the two categorized GitHub groups render. Tabs that are neither 'mine' nor
  // 'review' (uncategorized / stale / not-yet-loaded PRs) show no row. Each group
  // self-hides when empty, so no bare headers appear.
  return ghGroup('Mine', PR_GROUP.MINE) + ghGroup('Review', PR_GROUP.REVIEW)
       + group('Jira', 'jira');
}

// Drag-to-reorder within each group. Reorder stays within a group — a PR tab can't
// become a Jira tab. After a drop, sync state.tabs to DOM order.
let _sortables = [];
function initTabSort() {
  if (typeof Sortable === 'undefined') return;
  _sortables.forEach(s => s.destroy());
  _sortables = [];
  document.querySelectorAll('#opentabs-nav .tab-group').forEach(group => {
    _sortables.push(new Sortable(group, { draggable: '[data-id]', animation: 150, filter: '.tab-x', onEnd: syncTabOrder }));
  });
}
function syncTabOrder() {
  const order = [...document.querySelectorAll('#opentabs-nav [data-id]')].map(el => el.dataset.id);
  state.tabs.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  saveTabs();
}

// Close every tab except `id`.
function closeOthers(id) {
  const keep = state.tabs.find(t => t.id === id);
  if (!keep) return;
  const closing = state.tabs.filter(t => t.id !== id);
  if (!confirmCloseTabTerminals(closing)) return;
  closing.forEach(t => { closePairedTerm(t); t.wv?.remove(); });
  state.tabs = [keep];
  activateTab(id);
}

// Right-click tab menu (the shared context menu in menu.js).
export function tabMenu(e, id) {
  return openMenu(e, [
    { label: 'Close tab', onClick: () => closeTab(id) },
    state.tabs.length > 1 && { label: 'Close others', onClick: () => closeOthers(id) },
    { label: 'Close all', onClick: () => closeSplit() },
  ]);
}

// ── Projects sidebar nav ──────────────────────────────────────────────────────
export function renderProjectNav(projects) {
  setProjects(projects);
  const list = projects.map(p => `
    <button class="nav-btn" data-page="project" data-project="${p.id}" onclick="showPage('project','${p.id}')">
      <span class="nav-dot" style="background:${p.color}"></span>
      <span style="overflow:hidden;text-overflow:ellipsis">${esc(p.name)}</span>
    </button>`).join('');
  // No projects yet → show a prominent CTA; otherwise the "+" on the section title is enough.
  const cta = projects.length ? '' :
    `<button class="nav-btn" style="color:var(--accent)" onclick="openNewProjectModal()"><span class="icon" style="color:var(--accent)">${ICON.plus}</span> New project</button>`;
  document.getElementById('project-nav').innerHTML = list + cta;
}

// ── Resizable left sidebar (width persisted in localStorage, restored next launch) ─
export function initSidebarResize() {
  const handle = document.getElementById('sidebar-resizer');
  if (!handle) return;
  const setW = w => document.documentElement.style.setProperty('--sidebar-w', Math.min(420, Math.max(170, w)) + 'px');
  const saved = parseInt(localStorage.getItem('taskhub.sidebarWidth') || '', 10);
  if (saved) setW(saved);
  let dragging = false, x = 0, raf = 0;
  const apply = () => { raf = 0; setW(x); };
  handle.addEventListener('mousedown', e => { dragging = true; e.preventDefault(); document.body.classList.add('resizing'); });
  window.addEventListener('mousemove', e => { if (!dragging) return; x = e.clientX; if (!raf) raf = requestAnimationFrame(apply); });
  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false; document.body.classList.remove('resizing');
    const w = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--sidebar-w'), 10);
    if (w) localStorage.setItem('taskhub.sidebarWidth', String(w));
  });
}
