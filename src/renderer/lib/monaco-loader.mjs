import { XCODE_LIGHT, XCODE_DARK } from './monaco-xcode-theme.mjs';

function loadScript(url) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = url;
    script.onload = resolve;
    script.onerror = () => { script.remove(); reject(new Error('Editor asset failed to load')); };
    document.head.appendChild(script);
  });
}

// Load the vendored Monaco once via its AMD loader. Resolves to the global `monaco`. On
// failure the memo is cleared so a transient first-load error doesn't brick the editor for
// the whole session — the next open retries.
let _monaco = null;
export function loadMonaco() {
  if (_monaco) return _monaco;
  _monaco = buildMonaco().catch(e => { _monaco = null; throw e; });
  return _monaco;
}
function buildMonaco() {
  return new Promise((resolve, reject) => {
    // A same-origin worker bootstrap also works with the focused editor's CSP.
    window.MonacoEnvironment = { getWorkerUrl: () => '/lib/monaco-worker.js' };
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

// Monaco language id for a path, from its own registered extensions/filenames (covers every
// language it ships — Swift, Go, Rust, …). Falls back to plaintext.
export function languageId(monaco, file) {
  const ext = '.' + (file.split('.').pop() || '').toLowerCase();
  const base = (file.split('/').pop() || '').toLowerCase();
  const langs = monaco.languages.getLanguages();
  const hit = langs.find(l =>
    (l.extensions || []).some(e => e.toLowerCase() === ext) ||
    (l.filenames || []).some(f => f.toLowerCase() === base));
  return hit ? hit.id : 'plaintext';
}
