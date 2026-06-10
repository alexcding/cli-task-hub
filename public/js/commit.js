// Commit popover for the diff pane: branch + change counts, a message box, and
// Commit / Commit-and-push / Push actions running against the tab's worktree.
// Anchored under the toolbar's Commit button; refreshes the diff after each action.
import { api, apiJson } from './api.js';
import { esc } from './util.js';
import { ICON } from './icons.js';
import { toast, toastErr } from './toast.js';
import { parseDiff } from './diff-parse.mjs';
import { refreshDiff, diffCwd } from './diff.js';

let _open = false;
let _meta = null;  // last fetched { branch, ahead, files, adds, dels, untracked } for the popover
let _busy = false;

const pop = () => document.getElementById('commit-pop');

export function toggleCommitPop() {
  if (_open) return closeCommitPop();
  const cwd = diffCwd();
  if (!cwd) return;
  _open = true;
  initOnce();
  const p = pop();
  p.hidden = false;
  p.innerHTML = `<div class="cp-loading">Loading…</div>`;
  fill(cwd);
}

export function closeCommitPop() {
  _open = false;
  const p = pop();
  if (p) p.hidden = true;
}

const COMMIT_ICON = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3.5"/><path d="M2.5 12h6"/><path d="M15.5 12h6"/></svg>';
const PUSH_ICON = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 17a5.5 5.5 0 1 1 2-10.6 6 6 0 0 1 11.6 1.7A4.5 4.5 0 0 1 19 17"/><path d="M12 12v8"/><path d="M8.5 15.5 12 12l3.5 3.5"/></svg>';

async function fill(cwd) {
  let data;
  try { data = await api('/api/diff?path=' + encodeURIComponent(cwd)); }
  catch (e) { data = { error: e.message }; }
  if (!_open) return;
  if (data.error) { pop().innerHTML = `<div class="cp-loading">${esc(data.error)}</div>`; return; }
  const files = parseDiff(data.diff);
  _meta = {
    cwd,
    branch: data.branch || '?',
    ahead: data.ahead,
    untracked: data.untracked || [],
    files,
    adds: files.reduce((n, f) => n + f.adds, 0),
    dels: files.reduce((n, f) => n + f.dels, 0),
  };
  const dirty = files.length > 0 || _meta.untracked.length > 0;
  const canPush = _meta.ahead === null ? true : _meta.ahead > 0; // null = no upstream yet → first push
  pop().innerHTML = `
    <div class="cp-head">
      <span class="cp-branch" title="${esc(_meta.branch)}">${ICON.branch}<span>${esc(_meta.branch)}</span></span>
      <span class="cp-counts">${_meta.adds ? `<span class="dc-add">+${_meta.adds}</span>` : ''}${_meta.dels ? `<span class="dc-del">−${_meta.dels}</span>` : ''}</span>
    </div>
    <textarea id="cp-msg" placeholder="Commit message (leave blank to auto-fill)…" rows="3" spellcheck="false"></textarea>
    <label class="cp-check"><input type="checkbox" id="cp-untracked" checked ${_meta.untracked.length ? '' : 'disabled'}>
      Include untracked files${_meta.untracked.length ? ` (${_meta.untracked.length})` : ''}</label>
    <div class="cp-actions">
      <button class="cp-act" onclick="commitAction('commit')" ${dirty ? '' : 'disabled'}>${COMMIT_ICON}<span>Commit</span><kbd>⌘↩</kbd></button>
      <button class="cp-act" onclick="commitAction('commit-push')" ${dirty ? '' : 'disabled'}>${PUSH_ICON}<span>Commit and push</span></button>
      <button class="cp-act" onclick="commitAction('push')" ${canPush ? '' : 'disabled'}>${PUSH_ICON}<span>Push${_meta.ahead ? ` (${_meta.ahead})` : ''}</span></button>
    </div>`;
  const msg = document.getElementById('cp-msg');
  msg.focus();
  msg.addEventListener('keydown', e => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); commitAction('commit'); }
  });
}

// Blank message → a plain heuristic summary of what's being committed.
function autoMessage() {
  const names = _meta.files.map(f => (f.newPath || f.oldPath).split('/').pop());
  if (document.getElementById('cp-untracked')?.checked) names.push(..._meta.untracked.map(u => u.split('/').pop()));
  if (!names.length) return 'Update';
  return `Update ${names[0]}` + (names.length > 1 ? ` and ${names.length - 1} more` : '');
}

export async function commitAction(kind) {
  if (_busy || !_meta) return;
  _busy = true;
  document.querySelectorAll('.cp-act').forEach(b => b.disabled = true);
  try {
    let committed = false;
    if (kind !== 'push') {
      const message = document.getElementById('cp-msg').value.trim() || autoMessage();
      const includeUntracked = !!document.getElementById('cp-untracked')?.checked;
      const r = await apiJson('/api/git/commit', 'POST', { path: _meta.cwd, message, includeUntracked });
      if (r.error) return toastErr(r.error); // nothing changed on disk — popover state still true
      committed = true;
      if (kind === 'commit') toast(`Committed ${r.hash}`);
    }
    if (kind !== 'commit') {
      const r = await apiJson('/api/git/push', 'POST', { path: _meta.cwd });
      if (r.error) {
        toastErr(r.error);
        // 'Commit and push' where the commit landed but the push didn't: the diff pane
        // and the popover's counts are now stale — refresh both rather than keep showing
        // the committed work as pending (re-fill also re-enables Push with the new ahead).
        if (committed) { refreshDiff(); fill(_meta.cwd); }
        return;
      }
      toast(kind === 'push' ? 'Pushed' : 'Committed and pushed');
    }
    closeCommitPop();
    refreshDiff();
  } catch (e) {
    toastErr(e.message);
  } finally {
    _busy = false;
    document.querySelectorAll('.cp-act').forEach(b => b.disabled = false);
  }
}

// One-time wiring: Esc and click-outside close the popover (the toggle button itself
// is excluded so clicking it again toggles instead of close-then-reopen). Esc listens
// in the CAPTURE phase and stops propagation — app.js's bubble-phase Esc handler would
// otherwise close the whole viewer along with the popover.
let _wired = false;
function initOnce() {
  if (_wired) return;
  _wired = true;
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && _open) { e.stopPropagation(); closeCommitPop(); }
  }, true);
  document.addEventListener('mousedown', e => {
    if (_open && !e.target.closest('#commit-pop') && !e.target.closest('#commit-btn')) closeCommitPop();
  });
}
