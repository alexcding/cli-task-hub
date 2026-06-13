// One lightweight context menu, shared by the sidebar tab menu and the viewer folder
// menu. Only one is open at a time. Dismissed by an outside click (capture) or Escape
// (the global keydown handler in app.js calls closeMenu when isMenuOpen()).
let _el = null;
export const isMenuOpen = () => !!_el;
export function closeMenu() {
  if (_el) { _el.remove(); _el = null; }
  document.removeEventListener('click', closeMenu, true);
}

// Open at the event's position. `items` is an array of { label, onClick, danger };
// falsy entries are skipped so callers can inline conditionals. Returns false so inline
// `oncontextmenu="return openMenu(...)"` cancels the native menu.
export function openMenu(e, items) {
  e.preventDefault();
  closeMenu();
  const m = document.createElement('div');
  m.className = 'status-menu';
  for (const it of items) {
    if (!it) continue;
    const b = document.createElement('button');
    b.className = 'status-menu-item' + (it.danger ? ' danger' : '');
    b.textContent = it.label;
    b.onclick = () => { closeMenu(); it.onClick(); };
    m.appendChild(b);
  }
  document.body.appendChild(m);
  m.style.top = (window.scrollY + e.clientY) + 'px';
  m.style.left = Math.min(window.scrollX + e.clientX, window.scrollX + window.innerWidth - m.offsetWidth - 8) + 'px';
  _el = m;
  setTimeout(() => document.addEventListener('click', closeMenu, true), 0);
  return false;
}
