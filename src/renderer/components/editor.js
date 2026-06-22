// Embedded code editor for `file` tabs. A CodeMirror 6 view per file tab, lazy-built on
// first activation. The vendored bundle (src/renderer/vendor/codemirror.js — a single
// IIFE exposing window.CM6) loads once on first use, mirroring how terminal.js loads
// xterm. File content is read/written over the local API (/api/file); dirty state drives
// the save affordance on the tab strip. The editor pane (tab.ed) is created in
// viewer.js's createTab and shown/hidden alongside webview tabs.
import { ROUTES } from '/shared/routes.mjs';
import { api, apiJson } from '../services/api.js';
import { esc, basename, loadScript } from '../lib/util.js';
import { toast, toastErr } from './toast.js';

// Load the vendored CM6 global once. Resolves to window.CM6 (the bundle's exports).
let _cmReady = null;
function loadCM() {
  if (!_cmReady) _cmReady = loadScript('/vendor/codemirror.js').then(() => window.CM6);
  return _cmReady;
}

// Map a file extension to a CM6 language extension (highlighting). Unknown types get no
// language (plain text) rather than failing — the editor still opens.
function languageFor(file, CM) {
  const ext = (file.split('.').pop() || '').toLowerCase();
  if (['js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx'].includes(ext))
    return CM.javascript({ typescript: ext.startsWith('ts'), jsx: ext.endsWith('x') });
  if (ext === 'json') return CM.json();
  if (['html', 'htm', 'xml'].includes(ext)) return CM.html();
  if (ext === 'css') return CM.cssLang();
  if (['md', 'markdown'].includes(ext)) return CM.markdown();
  return [];
}

// Recompute dirty (doc differs from what's on disk) and refresh the tab strip + titlebar
// if it flipped — the save affordance keys off tab.dirty. Short-circuit on doc length first
// so the common keystroke (which changes length) skips materializing the whole doc to a
// string — important for large files (toString of an up-to-5MB doc per keystroke is costly).
function recomputeDirty(tab) {
  const doc = tab.edView.state.doc;
  const dirty = doc.length !== tab.savedLen || doc.toString() !== tab.savedDoc;
  if (dirty !== tab.dirty) { tab.dirty = dirty; window.__refreshTabs?.(); }
}

// Build (or no-op if already built) the CodeMirror view for a file tab. Fetches the file,
// then mounts an editor into tab.ed. On error, renders the message in the pane instead.
export async function ensureEditor(tab) {
  if (!tab || tab.kind !== 'file' || tab.edView || tab._edLoading) return;
  tab._edLoading = true;
  let CM;
  try { CM = await loadCM(); }
  catch (e) { tab._edLoading = false; renderError(tab, e.message); return; }

  let data;
  try { data = await api(ROUTES.FILE + '?path=' + encodeURIComponent(tab.path)); }
  catch (e) { tab._edLoading = false; renderError(tab, e.message || 'Could not open file'); return; }

  tab.savedDoc = data.content;
  tab.savedLen = data.content.length;
  tab.readOnly = !!data.readOnly;
  tab.dirty = false;

  // Follow the app theme (not always dark): dark → One Dark (bg + its own highlight style);
  // light → CM6's default light surface + the default highlight style. Only ONE highlight
  // style is added per theme — adding defaultHighlightStyle *and* oneDark put the light style
  // at higher precedence (earlier = higher in CM6), painting dark text on the dark bg.
  const dark = document.documentElement.getAttribute('data-theme') === 'dark';
  const themeExts = dark
    ? [CM.oneDark]
    : [CM.syntaxHighlighting(CM.defaultHighlightStyle, { fallback: true })];

  const extensions = [
    CM.lineNumbers(),
    CM.highlightActiveLineGutter(),
    CM.highlightSpecialChars(),
    CM.history(),
    CM.foldGutter(),
    CM.drawSelection(),
    CM.indentOnInput(),
    CM.bracketMatching(),
    CM.closeBrackets(),
    CM.autocompletion(),
    CM.highlightActiveLine(),
    CM.highlightSelectionMatches(),
    CM.keymap.of([
      // ⌘S saves; preventDefault so the browser's Save-page dialog never appears.
      { key: 'Mod-s', preventDefault: true, run: () => { saveEditor(tab); return true; } },
      ...CM.closeBracketsKeymap, ...CM.defaultKeymap, ...CM.searchKeymap,
      ...CM.historyKeymap, ...CM.foldKeymap, ...CM.completionKeymap, CM.indentWithTab,
    ]),
    languageFor(tab.path, CM),
    ...themeExts,
    CM.EditorState.readOnly.of(tab.readOnly),
    CM.EditorView.editable.of(!tab.readOnly),
    CM.EditorView.updateListener.of(u => { if (u.docChanged) recomputeDirty(tab); }),
    // Fill the pane; the scroller owns the vertical scrollbar on the right.
    CM.EditorView.theme({ '&': { height: '100%' }, '.cm-scroller': { overflow: 'auto' } }),
  ];

  tab.ed.innerHTML = '';
  tab.edView = new CM.EditorView({
    state: CM.EditorState.create({ doc: data.content, extensions }),
    parent: tab.ed,
  });
  tab._edLoading = false;
  tab.loaded = true;
  window.__refreshTabs?.();          // refresh the tab bar (loading → read-only/dirty)
  if (tab.ed && tab.ed.style.display !== 'none') focusEditor(tab); // focus if this is the shown pane
  if (tab._pendingLine) { gotoLine(tab, tab._pendingLine); tab._pendingLine = 0; }
}

function renderError(tab, msg) {
  tab.ed.innerHTML = `<div class="editor-err">${esc(msg || 'Failed to open file')}</div>`;
  tab.loaded = true;
  window.__refreshTabs?.();
}

// Focus the editor (called when its tab activates) so typing goes straight to it.
export function focusEditor(tab) {
  try { tab?.edView?.focus(); } catch {}
}

// Jump to a 1-based line (from a terminal file:line link) — scroll it into view + place
// the cursor there.
export function gotoLine(tab, line) {
  const view = tab?.edView;
  if (!view || !line) { if (tab) tab._pendingLine = line; return; }
  try {
    const ln = Math.max(1, Math.min(line, view.state.doc.lines));
    const pos = view.state.doc.line(ln).from;
    view.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
    view.focus();
  } catch {}
}

// Save the file tab's content to disk, then clear dirty. ⌘S and the tab's save button
// both route here. No-op for a read-only file or a clean buffer.
export async function saveEditor(tab) {
  if (!tab || tab.kind !== 'file' || !tab.edView || tab.readOnly || !tab.dirty) return;
  const content = tab.edView.state.doc.toString();
  try {
    await apiJson(ROUTES.FILE, 'PUT', { path: tab.path, content });
    tab.savedDoc = content;
    tab.savedLen = content.length;
    tab.dirty = false;
    toast('Saved ' + basename(tab.path));
    window.__refreshTabs?.();
  } catch (e) {
    toastErr('Save failed: ' + (e.message || ''));
  }
}

// Tear down a file tab's editor (on tab close). The pane element is removed by the caller.
export function disposeEditor(tab) {
  try { tab?.edView?.destroy(); } catch {}
  if (tab) tab.edView = null;
}
