// Diff pane: a read-only `git diff` view of a tab's worktree, sharing the right-side
// split with the paired terminal (split.js switches between them per tab.paneView).
// Fetches /api/diff on every show but skips the DOM rebuild when the patch text is
// unchanged, so flipping back and forth is free while the worktree is quiet.
import { api, apiJson } from './api.js';
import { esc } from './util.js';
import { toast, toastErr } from './toast.js';
// .mjs (not .js): the package is type:commonjs, and the extension lets node:test
// import this parser directly while the browser loads it like any other module.
import { parseDiff, diffPath, hunkBlocks, blockPatch } from './diff-parse.mjs';

// Render guards (idea borrowed from Codex.app's diff viewer): a lockfile-sized file or
// a huge patch degrades to a stub instead of freezing the renderer on a million rows.
const MAX_FILES = 100;        // files rendered before the rest collapse into one stub
const MAX_FILE_LINES = 2000;  // per-file rendered rows before it becomes a stub
const MAX_TOTAL_LINES = 6000; // whole-pane row budget — files past it render as stubs

let _cwd = '';      // worktree of the last render — refreshDiff() re-renders it
let _files = [];    // parsed files of the last render — discard buttons index into this
// Last-rendered inputs, to skip identical rebuilds. Kept as separate fields compared
// with === (the diff string is a reference to the response we already hold) — a
// concatenated cache key would copy a potentially multi-MB patch on every show.
let _lastCwd = null, _lastDiff = null, _lastUnt = null;

const pane = () => document.getElementById('diff-pane');

// The worktree the pane is currently showing (the commit popover acts on it).
export const diffCwd = () => _cwd;

export function hideDiffPane() {
  const p = pane();
  if (p) p.style.display = 'none';
  closeConfirm(false); // a lingering discard prompt would float over the next view
}

// ── In-pane discard confirmation ─────────────────────────────────────────────────
// Replaces window.confirm so only the diff panel is blocked, not the whole window
// (the overlay is scoped to the pane's region in index.html). Promise resolves true on
// confirm, false on cancel / Esc / backdrop click.
const confirmEl = () => document.getElementById('diff-confirm');
let _confirmResolve = null;

function closeConfirm(result) {
  const el = confirmEl();
  if (el) { el.hidden = true; el.innerHTML = ''; }
  const r = _confirmResolve;
  _confirmResolve = null;
  if (r) r(result);
}

function confirmDiscard(what, path) {
  const el = confirmEl();
  if (!el) return Promise.resolve(false);
  closeConfirm(false); // never stack two prompts
  el.innerHTML =
    `<div class="diff-confirm-card" role="alertdialog" aria-modal="true">
       <div class="diff-confirm-msg">Discard ${esc(what)} in <b>${esc(path)}</b>?
         <div class="diff-confirm-sub">The file on disk is rewritten — this can't be undone.</div>
       </div>
       <div class="diff-confirm-actions">
         <button class="btn btn-secondary btn-sm" data-dc="cancel">Cancel</button>
         <button class="btn btn-danger btn-sm" data-dc="confirm">Discard</button>
       </div>
     </div>`;
  el.hidden = false;
  el.querySelector('[data-dc="confirm"]').focus();
  return new Promise(res => { _confirmResolve = res; });
}

// Re-render after an action that changed the worktree (e.g. a commit/discard). Only
// while the pane is actually on screen — if the user flipped to Terminal or another
// tab while the action was in flight, re-showing the pane here would paint it over
// the now-active view; the next show re-fetches anyway. Beyond this there's no watcher
// or polling — the diff refreshes once each time the pane is shown, deliberately.
export function refreshDiff() {
  const p = pane();
  if (_cwd && p && p.style.display !== 'none') renderDiffPane(_cwd);
}

export async function renderDiffPane(cwd) {
  const p = pane();
  if (!p) return;
  initOnce(p);
  p.style.display = '';
  _cwd = cwd || '';
  if (!cwd) { _lastCwd = null; p.innerHTML = msg('No local folder is mapped to this tab'); return; }
  // initOnce already parked the .diff-frame overlay in the pane, so childElementCount
  // would never be 0 — check for actual rendered content instead.
  if (!p.querySelector('.diff-root, .diff-empty')) p.innerHTML = msg('Loading…');
  let data;
  try { data = await api('/api/diff?path=' + encodeURIComponent(cwd)); }
  catch (e) { data = { error: e.message }; }
  if (cwd !== _cwd) return; // a later render (other tab / refresh) superseded this one
  if (data.error) { _lastCwd = null; p.innerHTML = msg(esc(data.error)); return; }
  const unt = (data.untracked || []).join('\n');
  if (cwd === _lastCwd && data.diff === _lastDiff && unt === _lastUnt) return;
  _lastCwd = cwd; _lastDiff = data.diff; _lastUnt = unt;
  _files = parseDiff(data.diff);
  p.innerHTML = render(_files, data.untracked || []);
  p.scrollTop = 0;
}

const msg = (text) => `<div class="diff-empty">${text}</div>`;

function render(files, untracked) {
  if (!files.length && !untracked.length) return msg('No uncommitted changes');
  const parts = [];
  // Per-file cap alone still allows 100 × 2000 rows in one innerHTML parse; a whole-pane
  // budget keeps the worst case bounded — files past it render as header-only stubs.
  let budget = MAX_TOTAL_LINES;
  files.slice(0, MAX_FILES).forEach((f, i) => {
    const lines = f.hunks.reduce((n, h) => n + h.lines.length, 0);
    parts.push(renderFile(f, i, budget > 0));
    budget -= lines;
  });
  if (files.length > MAX_FILES) parts.push(msg(`… and ${files.length - MAX_FILES} more files — diff truncated`));
  if (untracked.length) {
    parts.push(`<div class="diff-file"><div class="diff-file-head diff-untracked-head">Untracked files</div><div class="diff-body">` +
      untracked.map(u => `<div class="diff-untracked">${esc(u)}</div>`).join('') + `</div></div>`);
  }
  return `<div class="diff-root">${parts.join('')}</div>`;
}

const CHEVRON = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>';

function renderFile(f, fi, allow = true) {
  const badge = { added: 'A', deleted: 'D', renamed: 'R' }[f.status] || '';
  const counts = `<span class="diff-counts">${f.adds ? `<span class="dc-add">+${f.adds}</span>` : ''}${f.dels ? `<span class="dc-del">−${f.dels}</span>` : ''}</span>`;
  const head = `<div class="diff-file-head"><span class="diff-chev">${CHEVRON}</span>` +
    (badge ? `<span class="diff-badge diff-badge-${f.status}">${badge}</span>` : '') +
    `<span class="diff-fpath">${esc(diffPath(f))}</span>${counts}</div>`;

  let body;
  const total = f.hunks.reduce((n, h) => n + h.lines.length, 0);
  if (f.binary)                      body = `<div class="diff-stub">Binary file</div>`;
  else if (!total)                   body = ''; // pure rename / mode change — header says it all
  else if (total > MAX_FILE_LINES || !allow)
    body = `<div class="diff-stub">Large diff (+${f.adds} −${f.dels}) — not rendered. Use the terminal: <code>git diff ${esc(f.newPath || f.oldPath)}</code></div>`;
  else {
    // Rows are grouped into one <tbody> per change BLOCK (contiguous +/− run) with the
    // context runs in plain tbodys between them. Hovering anywhere in a block reveals
    // its Discard button (pure CSS, tbody:hover) on the block's first row.
    const row = l => {
      const cls = l.t === '+' ? 'add' : l.t === '-' ? 'del' : 'ctx';
      return `<tr class="diff-line ${cls}"><td class="dg">${l.oldNo || ''}</td><td class="dg">${l.newNo || ''}</td>` +
             `<td class="dx"><span class="dm">${l.t === ' ' ? '&nbsp;' : l.t}</span>${esc(l.text)}</td></tr>`;
    };
    const groups = f.hunks.map((h, hi) => {
      const ids = hunkBlocks(h);
      const segs = [];
      h.lines.forEach((l, i) => {
        const last = segs[segs.length - 1];
        if (!last || last.id !== ids[i]) segs.push({ id: ids[i], lines: [] });
        segs[segs.length - 1].lines.push(l);
      });
      return `<tbody><tr class="diff-hunk"><td class="dg" colspan="2"></td><td class="dx">${esc(h.header)}</td></tr></tbody>` +
        segs.map(s => {
          const rows = s.lines.map(row);
          if (s.id === null) return `<tbody>${rows.join('')}</tbody>`;
          rows[0] = rows[0].replace('</td></tr>',
            `<button class="hunk-discard" data-f="${fi}" data-h="${hi}" data-b="${s.id}" title="Revert this block in the file">Discard</button></td></tr>`);
          return `<tbody class="diff-block">${rows.join('')}</tbody>`;
        }).join('');
    });
    body = `<table class="diff-table">${groups.join('')}</table>`;
  }
  // .diff-body owns the rounded-corner clipping so the sticky header above it works.
  return `<div class="diff-file">${head}${body ? `<div class="diff-body">${body}</div>` : ''}</div>`;
}

// Reverse-apply one block onto the worktree, after confirmation. A drifted file makes
// `git apply -R` fail atomically — the refresh then shows the worktree's real state.
async function discardBlock(btn) {
  const f = _files[+btn.dataset.f];
  const h = f && f.hunks[+btn.dataset.h];
  if (!f || !h || !_cwd) return;
  // "all changes" when this is the file's only block; otherwise it's one of several.
  const soleBlock = f.hunks.length === 1 && new Set(hunkBlocks(h).filter(x => x !== null)).size === 1;
  const what = !soleBlock ? 'this block' : f.status === 'added' ? 'this new file' : 'all changes';
  if (!(await confirmDiscard(what, diffPath(f)))) return;
  btn.disabled = true;
  try {
    const r = await apiJson('/api/git/discard', 'POST', { path: _cwd, patch: blockPatch(f, h, +btn.dataset.b) });
    if (r.error) toastErr(r.error);
    else toast('Discarded');
  } catch (e) {
    toastErr(e.message);
  } finally {
    // A failed/drifted discard leaves the DOM as-is (the refresh below skips identical
    // content), so the button must come back to life itself; after a successful discard
    // the rebuild replaces it anyway and this is a no-op on a detached node.
    btn.disabled = false;
  }
  refreshDiff(); // success or drift, re-render what's actually on disk now
}

// One-time wiring: collapse/expand a file on header click, discard on a hunk's button
// (event delegation — the pane's content is rebuilt wholesale on every refresh).
let _wired = false;
function initOnce(p) {
  if (_wired) return;
  _wired = true;
  p.addEventListener('click', e => {
    const discard = e.target.closest('.hunk-discard');
    if (discard) { discardBlock(discard); return; }
    const head = e.target.closest('.diff-file-head');
    if (head && !head.classList.contains('diff-untracked-head')) head.parentElement.classList.toggle('collapsed');
  });
  // Hover frame: one overlay div moved over whichever block is hovered. Drawn outside
  // the table because cell-painted borders get sliced at row seams (see CSS comment).
  const frame = document.createElement('div');
  frame.className = 'diff-frame';
  p.appendChild(frame);
  let framed = null;
  p.addEventListener('mouseover', e => {
    const tb = e.target.closest('tbody.diff-block');
    if (tb === framed) return;
    framed = tb;
    if (!tb) { frame.style.display = 'none'; return; }
    const root = p.querySelector('.diff-root');
    if (!root) return;
    root.appendChild(frame); // re-parent into the current render (pane innerHTML resets wipe it)
    const r = tb.getBoundingClientRect(), o = root.getBoundingClientRect();
    frame.style.top = (r.top - o.top - 1) + 'px';
    frame.style.left = (r.left - o.left - 1) + 'px';
    frame.style.width = (r.width + 1) + 'px';
    frame.style.height = (r.height + 1) + 'px';
    frame.style.display = 'block';
  });
  p.addEventListener('mouseleave', () => { framed = null; frame.style.display = 'none'; });

  // Discard-confirm overlay: button clicks resolve, a backdrop click cancels. Esc cancels
  // in the CAPTURE phase + stops propagation so app.js's Esc handler doesn't also close the
  // whole viewer (same approach as the commit popover).
  const cf = confirmEl();
  if (cf) cf.addEventListener('click', e => {
    const btn = e.target.closest('[data-dc]');
    if (btn) closeConfirm(btn.dataset.dc === 'confirm');
    else if (e.target === cf) closeConfirm(false); // clicked the dimmed backdrop, not the card
  });
  document.addEventListener('keydown', e => {
    if (_confirmResolve != null && e.key === 'Escape') { e.stopPropagation(); closeConfirm(false); }
  }, true);
}
