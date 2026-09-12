// This surface only renders the snapshot supplied by its native owner. It has no
// filesystem bridge or API access; native controls own loading and mutations.
import { parseDiff } from '../lib/diff-parse.mjs';
import { renderReadOnly, wireDiffCollapse } from '../components/diff.js';
import { esc } from '../lib/util.js';

const pane = document.getElementById('native-diff');
wireDiffCollapse(pane);
let previous = null;
let currentTheme = 'system';
const media = matchMedia('(prefers-color-scheme: dark)');
media.addEventListener('change', () => window.nativeDiff.setTheme(currentTheme));
window.nativeDiff = {
  render(snapshot) {
    const key = JSON.stringify(snapshot);
    if (key === previous) return true;
    const files = parseDiff(snapshot.diff);
    pane.innerHTML = files.length || !snapshot.untracked.length ? renderReadOnly(files) : '';
    if (snapshot.untracked.length) {
      const visible = snapshot.untracked.slice(0, 200);
      const remainder = snapshot.untracked.length - visible.length;
      pane.insertAdjacentHTML('beforeend', `<section class="diff-root"><div class="diff-file"><div class="diff-file-head diff-untracked-head">Untracked files</div><div class="diff-body">${visible.map(path => `<div class="diff-untracked">${esc(path)}</div>`).join('')}${remainder ? `<div class="diff-stub">… and ${remainder} more untracked files</div>` : ''}</div></div></section>`);
    }
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
