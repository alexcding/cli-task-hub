// One lightweight context menu, shared by the sidebar tab menu and the viewer folder
// menu. Only one is open at a time. Dismissed by an outside click (capture) or Escape
// (the global keydown handler in app.js calls closeMenu when isMenuOpen()).
let _el = null;
export const isMenuOpen = () => !!_el;
export function closeMenu() {
  if (_el) { _el.remove(); _el = null; }
  document.removeEventListener('click', closeMenu, true);
}

// Open at the event's position. `items` is an array of { label, onClick, danger }, or
// { separator:true } for a rule BETWEEN groups — one that would lead, trail or double up is
// dropped, so a caller can inline it ahead of a group that may turn out empty and never get a
// stray line; falsy entries are skipped so callers can inline conditionals. Returns false so inline `oncontextmenu="return openMenu(...)"`
// cancels the native menu.
export function openMenu(e, items) {
  e.preventDefault();
  closeMenu();
  const m = document.createElement('div');
  m.className = 'status-menu';
  for (const it of items) {
    if (!it) continue;
    if (it.separator) {
      // Nothing above it to divide from, or the previous entry was itself a rule → skip. The
      // trailing case (a group that turned out empty) is dropped after the loop.
      if (!m.lastElementChild || m.lastElementChild.classList.contains('status-menu-sep')) continue;
      const sep = document.createElement('div');
      sep.className = 'status-menu-sep';
      m.appendChild(sep);
      continue;
    }
    if (it.heading) {
      const h = document.createElement('div');
      h.className = 'status-menu-head';
      h.textContent = it.heading;
      m.appendChild(h);
      continue;
    }
    const b = document.createElement('button');
    b.className = 'status-menu-item' + (it.danger ? ' danger' : '');
    b.textContent = it.label;
    b.onclick = () => { closeMenu(); it.onClick(); };
    m.appendChild(b);
  }
  // A rule with nothing under it is a line across the bottom of the menu: the group it was
  // introducing had no items (a context with no page and no ticket). Drop it.
  while (m.lastElementChild?.classList.contains('status-menu-sep')) m.lastElementChild.remove();
  document.body.appendChild(m);
  // Clamp into the viewport on both axes (offset* is known now that it's in the DOM): near the
  // bottom edge the menu rides up so it stays fully visible — e.g. the Run button in the bottom bar.
  const top = Math.min(window.scrollY + e.clientY, window.scrollY + window.innerHeight - m.offsetHeight - 8);
  m.style.top = Math.max(window.scrollY + 8, top) + 'px';
  m.style.left = Math.min(window.scrollX + e.clientX, window.scrollX + window.innerWidth - m.offsetWidth - 8) + 'px';
  _el = m;
  setTimeout(() => document.addEventListener('click', closeMenu, true), 0);
  return false;
}

// Native-first menu: the real macOS popup when the shell offers one (bridge.js `menu` → muda),
// the in-page menu above as the plain-browser fallback. Use this for any menu that can open OVER
// THE PANE — a DOM menu there is painted under the embedded page, which is a native child webview
// composited above the renderer's entire layer tree. `items` is openMenu's array; the native path
// carries only labels, so each item's onClick runs here, by index.
// Async: `return nativeMenu(...)` can't cancel a context menu (a promise is truthy), so a
// contextmenu caller must preventDefault() itself before awaiting.
// An item may carry `items` of its own — one level of submenu ("History ▸ …"). The id sent to the
// host is the item's PATH ("4" / "4.2"), so the answer maps straight back onto the array that built
// it and only the chosen leaf's onClick runs.
export async function nativeMenu(e, items) {
  const list = items.filter(Boolean);
  if (!window.taskhub?.menu) return openMenu(e, flattenForDom(list));
  closeMenu();   // the native popup won't fire the outside-click that dismisses an in-page one
  const spec = (arr, prefix = '') => arr.filter(Boolean).map((it, i) => {
    const id = prefix ? `${prefix}.${i}` : String(i);
    if (it.separator) return { separator: true };
    if (it.items) return { label: it.label, items: spec(it.items, id) };
    return { id, label: it.label };
  });
  const picked = await window.taskhub.menu(spec(list));
  if (picked == null) return false;
  const hit = String(picked).split('.').reduce((node, i) => {
    const arr = Array.isArray(node) ? node : node?.items;
    return (arr || []).filter(Boolean)[Number(i)];
  }, list);
  if (hit && !hit.separator && hit.onClick) hit.onClick();
  return false;
}

// The in-page menu (plain-browser fallback) has no submenus: a group's children are shown inline
// between rules, under their parent's label as a heading.
function flattenForDom(list) {
  const out = [];
  for (const it of list) {
    if (!it?.items) { out.push(it); continue; }
    out.push({ separator: true }, { heading: it.label }, ...it.items.filter(Boolean), { separator: true });
  }
  return out;
}
