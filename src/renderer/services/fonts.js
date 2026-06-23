// Code fonts: the terminal and the diff pane each have their own family + size pair
// (Settings → Appearance), persisted in taskhub.db settings like the theme.
// The diff pane and the settings previews read the values from the --term-font /
// --diff-font CSS custom properties; open terminals get them pushed into their xterm
// options and refit. ⌘+ / ⌘− / ⌘0 (main/app-menu.js) bump the pane currently in view.
import { ROUTES } from '/shared/routes.mjs';
import { state, FONT_DEFAULTS } from '../stores/store.js';
import { apiJson } from './api.js';
import { toastErr } from '../components/toast.js';
import { codeFontStack, esc } from '../lib/util.js';
import { fitTerm, visibleTerm } from '../components/terminal.js';
import { applyCodeFont } from '../components/editor.js';

export const FONT_MIN = 9, FONT_MAX = 24;
const KINDS = ['term', 'diff'];
const clampSize = px => Math.min(FONT_MAX, Math.max(FONT_MIN, px));

// The font menus (Settings → Terminal/Diff font) list the fonts actually installed on this
// machine, enumerated at runtime — not a hand-picked list. A static option for a font you
// don't have silently falls back to SF Mono, which reads as "the setting did nothing".

// Monospace test: in a fixed-pitch face narrow and wide glyphs share one advance width.
// Measure without a generic fallback so a family the platform can't resolve falls back to
// the canvas default (proportional) and is rejected — this also drops the non-monospace
// families that queryLocalFonts returns.
const _measureCtx = (() => { try { return document.createElement('canvas').getContext('2d'); } catch { return null; } })();
function isMonospace(family) {
  if (!_measureCtx) return true;                       // can't measure → don't filter
  const w = s => { _measureCtx.font = `16px "${family}"`; return _measureCtx.measureText(s).width; };
  const iii = w('iiiiiiiiii'), www = w('WWWWWWWWWW'), mmm = w('MMMMMMMMMM');
  return iii > 0 && Math.abs(iii - www) < 1 && Math.abs(iii - mmm) < 1;
}
const fontInstalled = f => { try { return document.fonts.check(`12px "${f}"`); } catch { return false; } };

// Enumerate the installed monospace families via the Local Font Access API (the only web
// platform API that can *list* fonts — document.fonts.check can merely test a name you
// already have). Caches a successful read; returns [] when the API is missing or denied so
// the caller can degrade. Granted in main/window.js, so this is the live path in the app.
let _enumerated = null;
async function monoFamilies() {
  if (_enumerated) return _enumerated;
  if (typeof window.queryLocalFonts !== 'function') return [];
  try {
    const fonts = await window.queryLocalFonts();
    const fams = [...new Set(fonts.map(f => f.family))].filter(isMonospace).sort((a, b) => a.localeCompare(b));
    if (fams.length) return (_enumerated = fams);
  } catch { /* unsupported or permission denied */ }
  return [];
}

// Rebuild both font <select>s from the installed fonts. Safe to call repeatedly. Always
// keeps the served default and the currently-persisted family (even if that font isn't
// installed here — don't drop a value synced from another machine). If enumeration isn't
// available, degrade by filtering the options already in the markup down to what's actually
// installed — so even the fallback shows no phantom fonts, and no font list lives in JS.
export async function populateFontMenus() {
  let fams = [];
  try { fams = await monoFamilies(); } catch { /* keep [] → markup fallback */ }
  for (const kind of KINDS) {
    const sel = document.getElementById(`${kind}-font-family`);
    if (!sel) continue;
    const current = state.fonts[kind].family;
    const available = fams.length
      ? fams
      : [...sel.options].map(o => o.value).filter(v => v && fontInstalled(v));
    const list = current && !available.includes(current) ? [current, ...available] : available;
    sel.innerHTML = '<option value="">SF Mono (default)</option>'
      + list.map(f => `<option value="${esc(f)}">${esc(f)}</option>`).join('');
    sel.value = current || '';
  }
}

// Push the current fonts into every consumer: the CSS tokens (diff pane + settings
// previews) and the settings controls (static markup, always in the DOM — kept in sync
// however the font changed: settings page, ⌘+/⌘−, another window's save). `changed` is
// the kind that changed ('term'|'diff') or null for a full sync; only a term-font change
// touches the xterms, since the diff font feeds CSS alone.
export function applyFonts(changed = null) {
  const root = document.documentElement.style;
  for (const kind of KINDS) {
    const { family, size } = state.fonts[kind];
    root.setProperty(`--${kind}-font`, codeFontStack(family));
    root.setProperty(`--${kind}-font-size`, size + 'px');
    const sel = document.getElementById(`${kind}-font-family`);
    if (sel) sel.value = family;
    const label = document.getElementById(`${kind}-font-size-val`);
    if (label) label.textContent = size + ' px';
  }
  // The Code font (kind 'diff') also styles open Monaco editors — push it to them.
  if (changed === 'diff' || changed === null) applyCodeFont();
  if (changed === 'diff') return;                    // otherwise diff font is CSS-only — no xterm work
  const fam = codeFontStack(state.fonts.term.family), size = state.fonts.term.size;
  for (const t of state.terms.values()) {
    try { t.term.options.fontFamily = fam; t.term.options.fontSize = size; } catch {}
  }
  // Refit only a terminal that's actually on screen — never one hidden behind the diff
  // pane (FitAddon measures a zero-size element and would push a bogus PTY resize).
  const vt = visibleTerm();
  if (vt && vt.el.style.display !== 'none') fitTerm(vt);
}

// Coalesce rapid changes (holding ⌘+/⌘−) into one write per setting — only the final
// value reaches taskhub.db. Keyed by setting so term/diff family/size don't clobber.
const _persistTimers = new Map();
function persist(key, value) {
  clearTimeout(_persistTimers.get(key));
  _persistTimers.set(key, setTimeout(() => {
    _persistTimers.delete(key);
    apiJson(ROUTES.settingsKey(key), 'PUT', { value: String(value) }).catch(e => toastErr(e.message));
  }, 250));
}

export function setFontFamily(kind, family) {
  state.fonts[kind].family = family || '';
  applyFonts(kind);
  persist(`${kind}_font_family`, state.fonts[kind].family);
}

export function setFontSize(kind, px) {
  const v = clampSize(Math.round(px) || FONT_DEFAULTS[kind]);
  if (v === state.fonts[kind].size) return;
  state.fonts[kind].size = v;
  applyFonts(kind);
  persist(`${kind}_font_size`, v);
}

export const bumpFontSize  = (kind, d) => setFontSize(kind, state.fonts[kind].size + d);
export const resetFontSize = kind => setFontSize(kind, FONT_DEFAULTS[kind]);

// Which font ⌘+ / ⌘− / ⌘0 act on: the diff pane when it's showing, else a visible
// terminal, else the diff font when the settings page is open (so its preview reacts).
// Anywhere else nothing is zoomable → null, and the shortcut no-ops (callers guard) so
// a plain page can't silently mutate a font the user can't see.
export const zoomTarget = () =>
  document.body.classList.contains('pane-diff') ? 'diff'
    : visibleTerm() ? 'term'
    : document.getElementById('page-settings')?.classList.contains('active') ? 'diff'
    : null;

// Adopt the persisted values at startup (taskhub.db is authoritative). Any terminal
// rehydrated before this lands is updated in place by applyFonts.
export function syncFontsFromSettings(s = {}) {
  for (const kind of KINDS) {
    const fam = s[`${kind}_font_family`];
    if (fam != null) state.fonts[kind].family = fam;
    const n = parseInt(s[`${kind}_font_size`], 10);
    if (n) state.fonts[kind].size = clampSize(n);
  }
  applyFonts();
}
