// Embedded code editor for `file` tabs — Monaco (the VS Code editor). The vendored AMD
// distribution (src/renderer/vendor/monaco/vs) loads once on first use via Monaco's own
// loader; each file tab gets a Monaco editor + model. File content is read/written over the
// local API (/api/file); dirty state drives the save affordance on the content-tab bar. The
// editor pane (tab.ed) is created in viewer.js and shown/hidden alongside webview tabs.
//
// `tab` here is any object with { kind:'file', path, ed (pane div), edView, _edModel,
// _savedVersion, readOnly, dirty, _pendingLine } — a viewer tab OR a per-context file link.
import { ROUTES } from '/shared/routes.mjs';
import { api, apiJson } from '../services/api.js';
import { state } from '../stores/store.js';
import { esc, basename, codeFontStack } from '../lib/util.js';
import { loadMonaco, languageId } from '../lib/monaco-loader.mjs';
import { toast, toastErr } from './toast.js';
import { saveEditorBuffer } from '../lib/editor-save.mjs';

// The shared "Code font" setting (Settings → Appearance — the same family+size that drives the
// git diff view) also styles the editor. state.fonts.diff is that setting (kind kept as 'diff').
const codeFont = () => ({ fontFamily: codeFontStack(state.fonts.diff.family), fontSize: state.fonts.diff.size });

// App theme → the converted XCode Modern Monaco theme.
const monacoTheme = () => (document.documentElement.getAttribute('data-theme') === 'dark' ? 'xcode-dark' : 'xcode-light');

// Re-skin open editors when the app theme toggles (theme.js calls this). Monaco's theme is
// global, so one setTheme covers every open editor; no-op until Monaco has loaded.
export function applyEditorTheme() {
  try { window.monaco?.editor.setTheme(monacoTheme()); } catch {}
}

// Build (or no-op if already built) the Monaco editor for a file tab. Fetches the file, then
// mounts the editor into tab.ed. On error, renders the message in the pane instead.
export async function ensureEditor(tab) {
  if (!tab || tab.kind !== 'file' || tab.edView || tab._edLoading) return;
  tab._edLoading = true;

  // The tab can be closed during either await; if so its pane is detached (disposeLink ran
  // while edView was still null, so it couldn't dispose anything). Bail before creating an
  // editor that nothing would ever dispose. `alive` re-checks after each await.
  const alive = () => tab.kind === 'file' && tab.ed && tab.ed.isConnected && !tab.edView;

  let monaco;
  try { monaco = await loadMonaco(); }
  catch { tab._edLoading = false; if (alive()) renderError(tab, 'Editor failed to load'); return; }
  if (!alive()) { tab._edLoading = false; return; }

  let data;
  try { data = await api(ROUTES.FILE + '?path=' + encodeURIComponent(tab.path)); }
  catch (e) { tab._edLoading = false; if (alive()) renderError(tab, e.message || 'Could not open file'); return; }
  if (!alive()) { tab._edLoading = false; return; }

  tab.readOnly = !!data.readOnly;
  tab._fileRevision = data.revision;
  tab.dirty = false;

  // No file URI on the model — a URI is global, so two tabs on the same path would share (and
  // double-dispose) one model. Own model per tab; set the language explicitly instead.
  const model = monaco.editor.createModel(data.content, languageId(monaco, tab.path));
  tab._edModel = model;
  // Dirty tracking via the alternative version id (an int that returns to the saved value on
  // undo) — no full-document string materialization/compare per keystroke.
  tab._savedVersion = model.getAlternativeVersionId();

  tab.ed.innerHTML = '';
  tab.edView = monaco.editor.create(tab.ed, {
    model,
    theme: monacoTheme(),
    readOnly: tab.readOnly,
    automaticLayout: true,            // tracks the pane size (split drag / window resize)
    minimap: { enabled: false },      // marginal value in a narrow split pane; saves paint cost
    scrollBeyondLastLine: false,
    tabSize: 2,
    renderWhitespace: 'selection',
    ...codeFont(),                    // shared Code font (family + size)
  });
  // ⌘S saves (Monaco owns the keybinding inside the editor).
  tab.edView.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => saveEditor(tab));
  // Dirty = current version differs from the last saved version; flip the tab's save affordance.
  model.onDidChangeContent(() => {
    const dirty = model.getAlternativeVersionId() !== tab._savedVersion;
    if (dirty !== tab.dirty) { tab.dirty = dirty; window.__refreshTabs?.(); }
  });

  tab._edLoading = false;
  tab.loaded = true;
  window.__refreshTabs?.();
  if (tab.ed && tab.ed.style.display !== 'none') focusEditor(tab);
  if (tab._pendingLine) { gotoLine(tab, tab._pendingLine); tab._pendingLine = 0; }
}

function renderError(tab, msg) {
  tab.ed.innerHTML = `<div class="editor-err">${esc(msg || 'Failed to open file')}</div>`;
  tab.loaded = true;
  window.__refreshTabs?.();
}

// Focus the editor (called when its tab activates).
export function focusEditor(tab) {
  try { tab?.edView?.focus(); } catch {}
}

// Jump to a 1-based line (from a terminal file:line link) — reveal it + place the cursor.
export function gotoLine(tab, line) {
  const ed = tab?.edView;
  if (!ed || !line) { if (tab) tab._pendingLine = line; return; }
  try {
    ed.revealLineInCenter(line);
    ed.setPosition({ lineNumber: line, column: 1 });
    ed.focus();
  } catch {}
}

// Save the file tab's content to disk, then clear dirty. ⌘S and the tab's save button route here.
export async function saveEditor(tab) {
  if (!tab || tab.kind !== 'file' || tab._savePromise) return;
  try {
    if (!(await saveEditorBuffer(tab, payload => apiJson(ROUTES.FILE, 'PUT', payload)))) return;
    toast('Saved ' + basename(tab.path));
    window.__refreshTabs?.();
  } catch (e) {
    toastErr('Save failed: ' + (e.message || ''));
  }
}

// Re-apply the Code font to every open editor (called when the setting changes in Settings).
export function applyCodeFont() {
  const f = codeFont();
  for (const tab of state.tabs) for (const l of (tab.links || [])) {
    if (l.edView) { try { l.edView.updateOptions(f); } catch {} }
  }
}

// Tear down a file tab's editor + model (on tab close). The pane element is removed by the caller.
export function disposeEditor(tab) {
  try { tab?.edView?.dispose(); } catch {}
  try { tab?._edModel?.dispose(); } catch {}
  if (tab) { tab.edView = null; tab._edModel = null; }
}
