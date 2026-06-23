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
import { esc, basename, loadScript, codeFontStack } from '../lib/util.js';
import { XCODE_LIGHT, XCODE_DARK } from '../lib/monaco-xcode-theme.mjs';
import { toast, toastErr } from './toast.js';

// The shared "Code font" setting (Settings → Appearance — the same family+size that drives the
// git diff view) also styles the editor. state.fonts.diff is that setting (kind kept as 'diff').
const codeFont = () => ({ fontFamily: codeFontStack(state.fonts.diff.family), fontSize: state.fonts.diff.size });

// Load the vendored Monaco once via its AMD loader. Resolves to the global `monaco`. On
// failure the memo is cleared so a transient first-load error doesn't brick the editor for
// the whole session — the next open retries.
let _monaco = null;
function loadMonaco() {
  if (_monaco) return _monaco;
  _monaco = buildMonaco().catch(e => { _monaco = null; throw e; });
  return _monaco;
}
function buildMonaco() {
  return new Promise((resolve, reject) => {
    // Self-host the language workers: a data: URL that importScripts workerMain with the right
    // baseUrl (the standard self-host pattern). Same-origin loopback, so this is allowed.
    const base = location.origin + '/vendor/monaco/';
    window.MonacoEnvironment = {
      getWorkerUrl: () => 'data:text/javascript;charset=utf-8,' + encodeURIComponent(
        `self.MonacoEnvironment={baseUrl:'${base}'};importScripts('${base}vs/base/worker/workerMain.js');`),
    };
    const css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = '/vendor/monaco/vs/editor/editor.main.css';
    document.head.appendChild(css);
    loadScript('/vendor/monaco/vs/loader.js').then(() => {
      window.require.config({ paths: { vs: '/vendor/monaco/vs' } });
      window.require(['vs/editor/editor.main'], () => {
        // Monaco's loader sets a global define() with `.amd`. Drop the marker so our UMD vendor
        // libs (xterm, loaded lazily) still take their global branch instead of registering as
        // anonymous AMD modules. Monaco's own lazy language loads use define() directly and don't
        // need the marker.
        try { delete window.define.amd; } catch {}
        // Register the converted XCode Modern themes (light + dark).
        try {
          window.monaco.editor.defineTheme('xcode-light', XCODE_LIGHT);
          window.monaco.editor.defineTheme('xcode-dark', XCODE_DARK);
        } catch {}
        // The TS/JS language worker (tsWorker.js, ~5.6MB) is trimmed from the vendored build —
        // we only need syntax highlighting (Monarch grammars, main-thread), not IntelliSense.
        // Turn OFF every monaco-typescript feature so NO provider (completion/hover/diagnostics/
        // …) ever registers — that's what would otherwise try to spawn the removed worker.
        // Highlighting is unaffected (it comes from basic-languages, not the TS service).
        try {
          const ts = window.monaco.languages.typescript;
          const allOff = {
            completionItems: false, hovers: false, documentSymbols: false, definitions: false,
            references: false, documentHighlights: false, rename: false, diagnostics: false,
            documentRangeFormattingEdits: false, signatureHelp: false, onTypeFormattingEdits: false,
            codeActions: false, inlayHints: false,
          };
          for (const d of [ts.typescriptDefaults, ts.javascriptDefaults]) {
            d.setModeConfiguration(allOff);
            d.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: true, noSuggestionDiagnostics: true });
          }
        } catch {}
        resolve(window.monaco);
      }, reject);
    }).catch(reject);
  });
}

// App theme → the converted XCode Modern Monaco theme.
const monacoTheme = () => (document.documentElement.getAttribute('data-theme') === 'dark' ? 'xcode-dark' : 'xcode-light');

// Re-skin open editors when the app theme toggles (theme.js calls this). Monaco's theme is
// global, so one setTheme covers every open editor; no-op until Monaco has loaded.
export function applyEditorTheme() {
  try { window.monaco?.editor.setTheme(monacoTheme()); } catch {}
}

// Monaco language id for a path, from its own registered extensions/filenames (covers every
// language it ships — Swift, Go, Rust, …). Falls back to plaintext.
function languageId(monaco, file) {
  const ext = '.' + (file.split('.').pop() || '').toLowerCase();
  const base = (file.split('/').pop() || '').toLowerCase();
  const langs = monaco.languages.getLanguages();
  const hit = langs.find(l =>
    (l.extensions || []).some(e => e.toLowerCase() === ext) ||
    (l.filenames || []).some(f => f.toLowerCase() === base));
  return hit ? hit.id : 'plaintext';
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
  if (!tab || tab.kind !== 'file' || !tab.edView || tab.readOnly || !tab.dirty) return;
  const content = tab.edView.getValue();
  try {
    await apiJson(ROUTES.FILE, 'PUT', { path: tab.path, content });
    // New saved baseline = the version we just wrote, so later edits (and undo back to it)
    // compute dirty correctly.
    tab._savedVersion = tab._edModel?.getAlternativeVersionId();
    tab.dirty = false;
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
