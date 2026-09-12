// This surface only renders the snapshot supplied by its native owner. It has no
// file I/O or HTTP API access; native controls own loading and mutations.
import { parseDiff } from '../lib/diff-parse.mjs';
import { renderReadOnly, wireDiffCollapse } from '../components/diff.js';
import { esc } from '../lib/util.js';

const pane = document.getElementById('native-diff');
wireDiffCollapse(pane);
pane.addEventListener('click', event => {
  const discard = event.target.closest('.hunk-discard');
  if (discard) {
    window.webkit?.messageHandlers.diff?.postMessage({ type: 'discard', selection: [discard.dataset.f, discard.dataset.h, discard.dataset.b].map(Number), revision: renderedRevision });
    return;
  }
  const button = event.target.closest('[data-open-path]');
  if (!button) return;
  const line = Number(button.dataset.openLine);
  if (Number.isSafeInteger(line) && line > 0 && line <= 1_000_000) {
    window.webkit?.messageHandlers.diff?.postMessage({ type: 'open', path: button.dataset.openPath, line });
  }
});
let previous = null;
let renderedRevision = null;
let currentTheme = 'system';
const media = matchMedia('(prefers-color-scheme: dark)');
media.addEventListener('change', () => window.nativeDiff.setTheme(currentTheme));
window.nativeDiff = {
  render(snapshot) {
    const key = JSON.stringify(snapshot);
    if (key === previous) return true;
    const files = parseDiff(snapshot.diff);
    pane.innerHTML = files.length || !snapshot.untracked.length ? renderReadOnly(files, { fileLinks: snapshot.fileLinks !== false, discardable: Boolean(snapshot.revision) }) : '';
    if (snapshot.untracked.length) {
      const visible = snapshot.untracked.slice(0, 200);
      const remainder = snapshot.untracked.length - visible.length;
      pane.insertAdjacentHTML('beforeend', `<section class="diff-root"><div class="diff-file"><div class="diff-file-head diff-untracked-head">Untracked files</div><div class="diff-body">${visible.map(path => `<div class="diff-untracked"><button class="diff-open-file" data-open-path="${esc(path)}" data-open-line="1">${esc(path)}</button></div>`).join('')}${remainder ? `<div class="diff-stub">… and ${remainder} more untracked files</div>` : ''}</div></div></section>`);
    }
    renderedRevision = snapshot.revision || null;
    previous = key;
    return true;
  },
  setTheme(theme) {
    currentTheme = theme;
    document.documentElement.dataset.theme = theme === 'system'
      ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : theme;
  },
};
window.webkit?.messageHandlers.diff?.postMessage({ type: 'ready' });
