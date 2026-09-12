// This surface has no HTTP/file API. Swift supplies one document, validates all
// writes, and owns confirmation. Remote pages never receive this message handler.
import { loadMonaco, languageId } from '../lib/monaco-loader.mjs';

const post = body => window.webkit.messageHandlers.editor.postMessage(body);
const monaco = await loadMonaco();
let editor, model, savedVersion, readOnly = false, frozen = false, lastDirty;
let appearance = 'system';
const media = matchMedia('(prefers-color-scheme: dark)');
const theme = () => monaco.editor.setTheme(
  (appearance === 'dark' || (appearance === 'system' && media.matches)) ? 'xcode-dark' : 'xcode-light');
media.addEventListener('change', theme);
const dirty = () => model.getAlternativeVersionId() !== savedVersion;
function changed() {
  const value = dirty();
  if (value !== lastDirty) { lastDirty = value; post({ type: 'changed', dirty: value }); }
}

window.nativeEditor = Object.freeze({
  load(document) {
    if (model) throw new Error('Document already loaded');
    readOnly = document.readOnly;
    model = monaco.editor.createModel(document.content, languageId(monaco, document.path));
    savedVersion = model.getAlternativeVersionId();
    editor = monaco.editor.create(window.document.getElementById('editor'), {
      model, readOnly, automaticLayout: true, minimap: { enabled: false },
      scrollBeyondLastLine: false, tabSize: 2, renderWhitespace: 'selection',
      fontFamily: 'Menlo, Monaco, monospace', fontSize: 13,
      ariaLabel: 'Code editor',
    });
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => post({ type: 'save' }));
    model.onDidChangeContent(changed);
    theme(); changed();
  },
  snapshot(freeze = false) {
    if (!model) throw new Error('Document has not loaded');
    if (freeze) { frozen = true; editor.updateOptions({ readOnly: true }); }
    return { content: editor.getValue({ preserveBOM: true }), version: model.getAlternativeVersionId(), dirty: dirty() };
  },
  acknowledge(version) { savedVersion = version; changed(); return dirty(); },
  unfreeze() { frozen = false; editor.updateOptions({ readOnly }); },
  setTheme(value) { appearance = value; theme(); },
  find() { editor.getAction('actions.find').run(); },
  focus(line = 0) {
    if (frozen) return;
    if (line > 0) { editor.revealLineInCenter(line); editor.setPosition({ lineNumber: line, column: 1 }); }
    editor.focus();
  },
});
post({ type: 'ready' });
