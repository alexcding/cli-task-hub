import { state } from './store.js';
import { api } from './api.js';
import { toastErr } from './toast.js';

// ── Terminal theme ────────────────────────────────────────────────────────────
// Terminals always match the system light/dark setting — no separate preference.
const TERM_THEMES = {
  dark:  { background:'#1e1e1e', foreground:'#e6e6e6', cursor:'#e6e6e6', cursorAccent:'#1e1e1e', selectionBackground:'#5b5b5b' },
  light: { background:'#ffffff', foreground:'#1f2430', cursor:'#1f2430', cursorAccent:'#ffffff', selectionBackground:'#b3d4fc',
           black:'#1f2430', red:'#c91b00', green:'#00a33f', yellow:'#a5740b', blue:'#0451a5', magenta:'#a626a4', cyan:'#0998b3', white:'#5c6370',
           brightBlack:'#7f848e', brightRed:'#e8364f', brightGreen:'#00a33f', brightYellow:'#b58900', brightBlue:'#2472c8', brightMagenta:'#bc05bc', brightCyan:'#0598bc', brightWhite:'#1f2430' },
};
const termMode = () => window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
export const termTheme = () => TERM_THEMES[termMode()];

// Re-skin every open terminal when the OS theme switches.
function applyTermThemes() {
  const th = termTheme();
  for (const t of state.terms.values()) { try { t.term.options.theme = th; } catch {} t.el.style.background = th.background; }
}

// ── App theme ──────────────────────────────────────────────────────────────────
// Light/dark theming for the whole UI. 'auto' follows the OS; 'light'/'dark' force one.
// Persisted to config.db (settings table, key `theme`) AND mirrored to localStorage so the
// inline head script can resolve it before first paint (no flash). The resolved mode is
// written to <html data-theme>, which drives every CSS token. Independent of the terminal theme.
let _appThemePref = (function () { try { return localStorage.getItem('taskhub.theme') || 'auto'; } catch { return 'auto'; } })();

function appThemeMode() {
  if (_appThemePref === 'light' || _appThemePref === 'dark') return _appThemePref;
  return window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function applyAppTheme() {
  document.documentElement.setAttribute('data-theme', appThemeMode());
  document.querySelectorAll('#theme-toggle .theme-opt').forEach(b =>
    b.classList.toggle('active', b.dataset.themeOpt === _appThemePref));
}

export async function setAppTheme(value) {
  _appThemePref = value;
  try { localStorage.setItem('taskhub.theme', value); } catch {}
  applyAppTheme();
  window.taskhub?.setTheme?.(value); // match native chrome appearance (traffic lights/scrollbars) to the theme; no-op in browser
  // Durable home is the config.db settings table; the localStorage copy above is just a
  // pre-paint cache so the window doesn't flash the wrong theme before this read lands.
  try { await api('/api/settings/theme', { method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ value }) }); }
  catch (e) { toastErr(e.message); }
}

// config.db is authoritative (survives a localStorage clear, shared across windows);
// re-sync from it after the pre-paint localStorage guess (called from init).
export function syncThemeFromSettings(saved) {
  if (saved && saved !== _appThemePref) {
    _appThemePref = saved;
    try { localStorage.setItem('taskhub.theme', _appThemePref); } catch {}
  }
  applyAppTheme();
}

export function initTheme() {
  if (window.matchMedia) {
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTermThemes);
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (_appThemePref === 'auto') applyAppTheme(); });
  }
  applyAppTheme(); // reflect the localStorage value on the toggle immediately (config sync follows in init)
  window.taskhub?.setTheme?.(_appThemePref); // sync native appearance on load so vibrancy matches
}
