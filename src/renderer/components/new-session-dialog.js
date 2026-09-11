// "New session" dialog behind the sidebar's "+" on a project: name the branch (→ worktree folder)
// OR paste the PR / ticket the session is for — one field, read by shape — pick the base branch it
// forks from, and choose the agent to launch in its terminal. An in-app
// modal on the shared .modal-backdrop — the webview swallows native prompt()/confirm(), so those
// are never used here. Resolves { branch, base, cli } on Create, or null on Cancel / Escape /
// backdrop click. One dialog at a time: opening a second cancels the first.
import { ROUTES } from '/shared/routes.mjs';
import { state, prByUrl, jiraByKey } from '../stores/store.js';
import { api, apiJson } from '../services/api.js';
import { esc, isPrUrl, jiraKeyFromUrl, basename } from '../lib/util.js';
import { jiraTaskBranch } from '../lib/workflow.mjs';

// One field takes either: a branch name to create, or the address of the page the session is FOR.
const HINT = 'Also names the worktree folder — or paste a GitHub PR / Jira URL to start on that page.';
const PREFERRED_BASE = 'develop'; // preselected when the repo has it; else the repo's default branch
const CLI_CHOICES = [
  { id: 'claude', label: 'Claude' },
  { id: 'codex', label: 'Codex' },
  { id: '', label: 'Shell only' },
];

let _open = null; // () => cancel the current dialog (claimed synchronously at entry, before the refs fetch)

// Mirrors the server's validBranchName (repositories/github.js): git check-ref-format rules plus
// no `.`/`..` segments, so the derived worktree folder can never escape `${ws}.worktrees`.
function branchNameError(b) {
  if (!b) return 'Enter a branch name';
  if (b.startsWith('-') || b.endsWith('/') || b.endsWith('.') || b.endsWith('.lock')) return 'Branch name can’t start with “-” or end with “/”, “.” or “.lock”';
  if (/[\x00-\x20\x7f~^:?*[\\]|\.\.|@\{|\/\/|^@$/.test(b)) return 'Branch name can’t contain spaces, “..” or ~ ^ : ? * [ \\';
  if (!b.split('/').every(seg => seg && seg !== '.' && !seg.startsWith('.'))) return 'No branch segment may start with “.”';
  return '';
}

// A pasted address → the page this session is for, plus the branch that page implies. Exactly what
// the viewer's "New session" button derives from a PR/Jira TAB (viewer.js newSession), so a session
// started from the sidebar with a url lands in the same place as one started from the page itself:
// a PR brings its head branch (when the PR is known — it's whatever the sidebar already loaded),
// a ticket its feature/<KEY>-<slug>. Anything else is not a page we can open as a context.
export function parseSessionUrl(raw) {
  const url = String(raw || '').trim();
  if (!url) return null;
  if (isPrUrl(url)) {
    const pr = prByUrl(url);
    return { url, kind: 'github', jiraKey: '', title: pr?.title || '', branch: pr?.headRefName || '' };
  }
  const key = jiraKeyFromUrl(url);
  if (key) {
    const it = jiraByKey(key);
    return { url, kind: 'jira', jiraKey: key, title: it?.summary ? `${key} ${it.summary}` : key,
      branch: jiraTaskBranch(key, it?.summary || '') };
  }
  return null;
}

// …and what the sidebar's snapshots couldn't answer, asked live. A pasted link is usually for
// something the app has never listed (another project's PR, a ticket outside the board's filter),
// and both things we want from it are missing then: the TITLE, which becomes the session's name,
// and for a PR the HEAD BRANCH, which is what its worktree adopts. Best-effort — a failed lookup
// leaves the page as parsed, and the dialog still works on what the user typed.
async function completePage(page) {
  if (!page) return page;
  if (page.kind === 'github' && (!page.branch || !page.title)) {
    const pr = await api(`${ROUTES.PR_LOOKUP}?url=${encodeURIComponent(page.url)}`).catch(() => null);
    if (pr) return { ...page, title: page.title || pr.title || '', branch: page.branch || pr.headRefName || '' };
    return page;
  }
  if (page.kind === 'jira' && page.title === page.jiraKey) {
    // `key = X` is the whole search: one issue, by id.
    const snap = await apiJson(ROUTES.JIRA_SEARCH, 'POST', { jql: `key = ${page.jiraKey}`, limit: 1 }).catch(() => null);
    const it = (snap?.items || [])[0];
    if (it?.summary) return { ...page, title: `${page.jiraKey} ${it.summary}`, branch: jiraTaskBranch(page.jiraKey, it.summary) };
  }
  return page;
}

// This project's existing worktree for a pasted PR/ticket, or null. The match is the server's, asked
// STRICTLY (strict=1): an exact branch for a PR, the key as a whole token for a ticket, and nothing
// when two worktrees both qualify. The loose match is right for labelling a folder; this answer
// decides where a session runs — and which worktree Overwrite deletes. The main checkout never
// counts: a session runs on a worktree. The response carries that worktree's own branch, which may
// differ from the one derived here (a ticket's branch carries its summary).
async function existingWorktree(project, page, branch) {
  const q = page.kind === 'jira' ? `key=${encodeURIComponent(page.jiraKey)}` : `branch=${encodeURIComponent(branch || '')}`;
  if (q.endsWith('=')) return null;
  const found = await api(`${ROUTES.WORKTREE}?path=${encodeURIComponent(project.workspace)}&${q}&strict=1`).catch(() => null);
  if (!found?.matched || !found.isWorktree) return null;
  return { path: found.path, branch: found.branch || branch };
}

// The defaults the dialog would show for a project — a free branch name and the base it forks from
// — for callers that create a session WITHOUT asking (the viewer's "New session" button on a page
// that names no branch of its own). Returns null when the repo's refs can't be read.
export async function suggestSession(project) {
  let refs;
  try { refs = await api(`${ROUTES.GIT_REFS}?path=${encodeURIComponent(project.workspace)}`); } catch { return null; }
  if (!refs) return null;
  const branches = Array.isArray(refs.branches) ? refs.branches : [];
  const names = branches.map(b => b.name);
  const base = names.includes(PREFERRED_BASE) ? PREFERRED_BASE : (refs.defaultBranch || names[0] || PREFERRED_BASE);
  return { branch: suggestBranch(branches, Array.isArray(refs.worktrees) ? refs.worktrees : []), base };
}

// A placeholder branch name not already taken: worktree1, worktree2, …
function suggestBranch(branches, worktrees) {
  const taken = new Set([...branches.map(b => b.name), ...worktrees.map(w => w.branch)].filter(Boolean));
  for (let i = 1; ; i++) if (!taken.has(`worktree${i}`)) return `worktree${i}`;
}

export async function newSessionDialog(project) {
  _open?.();
  // Claim the single slot NOW: a second "+" during the refs fetch cancels this one (resolves null)
  // instead of stacking two dialogs, the first of which could then never settle.
  let cancelled = false;
  const pending = () => { cancelled = true; };
  _open = pending;
  let refs = { branches: [], worktrees: [], defaultBranch: '' };
  try { refs = await api(`${ROUTES.GIT_REFS}?path=${encodeURIComponent(project.workspace)}`) || refs; } catch {}
  if (cancelled) return null;
  const branches = Array.isArray(refs.branches) ? refs.branches : [];
  const names = branches.map(b => b.name);
  const base0 = names.includes(PREFERRED_BASE) ? PREFERRED_BASE : (refs.defaultBranch || names[0] || PREFERRED_BASE);
  if (!names.includes(base0)) names.unshift(base0);
  const placeholder = suggestBranch(branches, Array.isArray(refs.worktrees) ? refs.worktrees : []);
  const cli0 = CLI_CHOICES.some(c => c.id === state.defaultCli) ? state.defaultCli : 'claude';

  return new Promise(resolve => {
    const back = document.createElement('div');
    back.className = 'modal-backdrop';
    back.innerHTML = `<div class="modal modal-session" role="dialog" aria-modal="true">
        <h2>New session on ${esc(project.name || 'project')}</h2>
        <div class="form-group">
          <label class="form-label" for="ns-branch">Branch name or URL</label>
          <input type="text" id="ns-branch" placeholder="${esc(placeholder)}" autocomplete="off" spellcheck="false">
          <div class="form-hint" id="ns-hint">${esc(HINT)}</div>
        </div>
        <!-- Only for a pull request whose branch we don't know yet (its PR hasn't been loaded):
             everything else derives the branch from what was typed. -->
        <div class="form-group" id="ns-branch-row" hidden>
          <label class="form-label" for="ns-branch2">Branch for that pull request</label>
          <input type="text" id="ns-branch2" placeholder="${esc(placeholder)}" autocomplete="off" spellcheck="false">
        </div>
        <!-- Only when this link already has a checkout here (see existingWorktree). Same segmented
             control as the Agent row below — one control shape for every choice in this dialog. -->
        <div class="form-group" id="ns-wt-row" hidden>
          <span class="form-label">Worktree</span>
          <div class="theme-toggle ns-wt" role="radiogroup" aria-label="Worktree">
            <button type="button" class="theme-opt active" data-wt="reuse" role="radio" aria-checked="true">Reuse</button>
            <button type="button" class="theme-opt" data-wt="overwrite" role="radio" aria-checked="false">Overwrite</button>
          </div>
          <div class="form-hint" id="ns-wt-hint"></div>
        </div>
        <div class="form-group">
          <label class="form-label" for="ns-base">Branch from</label>
          <select id="ns-base">${names.map(n => `<option value="${esc(n)}"${n === base0 ? ' selected' : ''}>${esc(n)}</option>`).join('')}</select>
        </div>
        <div class="form-group">
          <span class="form-label">Agent</span>
          <div class="theme-toggle ns-cli" role="radiogroup" aria-label="Agent">
            ${CLI_CHOICES.map(c => `<button type="button" class="theme-opt${c.id === cli0 ? ' active' : ''}" data-cli="${esc(c.id)}" role="radio" aria-checked="${c.id === cli0}">${esc(c.label)}</button>`).join('')}
          </div>
        </div>
        <div class="modal-actions">
          <button class="btn btn-secondary" data-c="cancel">Cancel</button>
          <button class="btn btn-primary" data-c="ok">Create</button>
        </div>
      </div>`;
    const input = back.querySelector('#ns-branch');
    const branchRow = back.querySelector('#ns-branch-row');
    const branch2 = back.querySelector('#ns-branch2');
    const baseSel = back.querySelector('#ns-base');
    const wtRow = back.querySelector('#ns-wt-row');
    const wtHint = back.querySelector('#ns-wt-hint');
    let cli = cli0;
    let page = null;
    let found = null;    // this link's existing worktree, when it has one
    let reuse = true;    // …and whether to run the session there (the default)
    const done = result => {
      if (_open !== cancel) return; // already settled
      _open = null;
      document.removeEventListener('keydown', onKey, true);
      back.remove();
      resolve(result);
    };
    const cancel = () => done(null);
    const hint = back.querySelector('#ns-hint');
    const submit = () => {
      // A url in the field names its own branch; anything else IS the branch. The second input only
      // exists for the one case the url can't answer (a pull request we haven't loaded).
      const typed = input.value.trim();
      const raw = page ? (page.branch || branch2.value.trim()) : typed;
      // The placeholder is a NEW branch name, so it can only stand in where a new branch is what we
      // are making. A pull request needs its own head branch — falling back here would check out a
      // branch that doesn't exist (the worktree adopts, it doesn't create, for a PR).
      // `found` only means anything alongside the page that found it.
      if (found && page) { done({ branch: found.branch, base: baseSel.value, cli, page, worktree: found, overwrite: !reuse }); return; }
      if (!raw && page?.kind === 'github') {
        hint.textContent = 'Name the pull request’s branch';
        hint.classList.add('form-hint-err');
        branch2.focus();
        return;
      }
      const branch = (raw || placeholder).replace(/\s+/g, '-');
      const err = branchNameError(branch);
      if (err) {
        const el = page ? branch2 : input;
        hint.textContent = err; hint.classList.add('form-hint-err'); el.focus();
        return;
      }
      done({ branch, base: baseSel.value, cli, page, worktree: null, overwrite: false });
    };
    // What was typed decides what it is — a url (the page this session is for) or a branch name.
    // The hint says which reading won, so nothing is silently misread.
    // Repaint the hint + the conditional branch row for whatever `page` currently is.
    const paint = (typed, urlish, pending = false) => {
      hint.classList.toggle('form-hint-err', urlish && !page && !pending);
      const name = page && (page.kind === 'jira' ? page.jiraKey : 'that pull request');
      hint.textContent = !typed ? HINT
        : pending ? 'Looking it up…'
        : urlish && !page ? 'Not a GitHub pull request or Jira issue URL'
        : page ? (page.branch
            ? `Opens ${page.title || name} — branch ${page.branch}`
            : `Opens ${name} — name its branch below`)
        : HINT;
      // The extra input appears only for a PR whose head branch nothing could tell us. (A found
      // worktree always implies a branch, so it needs no clause of its own here.)
      branchRow.hidden = !(page && !page.branch);
      if (!branchRow.hidden && !branch2.value && document.activeElement !== branch2) branch2.focus();
      wtRow.hidden = !found;
      if (found) wtHint.textContent = reuse
        ? `Runs in ${basename(found.path)} on ${found.branch}`
        : `Replaces ${basename(found.path)} — its sessions are removed and uncommitted work there is lost`;
    };
    let seq = 0;
    input.oninput = () => {
      const typed = input.value.trim();
      const urlish = /^https?:\/\//i.test(typed);
      page = urlish ? parseSessionUrl(typed) : null;
      // Every edit invalidates what the LAST text resolved to. Without this the Worktree row — and
      // submit's `if (found)` short-circuit — outlived the url that produced it: type a branch name
      // over a pasted PR and Create would still run (or Overwrite delete) that PR's worktree.
      found = null; reuse = true;
      const mine = ++seq;
      paint(typed, urlish, !!page);
      if (!page) return;
      // The title and (for a PR) the branch may need a live lookup — the snapshots only hold what
      // this app lists. Ignore an answer that lands after the field moved on.
      completePage(page).then(async done => {
        if (mine !== seq) return;
        page = done;
        paint(typed, urlish);
        // …and does this work already have a checkout here? The answer only arrives for a link, so
        // the choice can't appear for a typed branch name.
        const wt = await existingWorktree(project, page, page.branch);
        if (mine !== seq) return;
        found = wt; reuse = true;
        back.querySelectorAll('.ns-wt .theme-opt').forEach(b => {
          const on = b.dataset.wt === 'reuse';
          b.classList.toggle('active', on); b.setAttribute('aria-checked', String(on));
        });
        paint(typed, urlish);
      });
    };
    const onKey = e => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancel(); }
      else if (e.key === 'Enter' && e.target !== baseSel) { e.preventDefault(); e.stopPropagation(); submit(); }
    };
    back.onclick = e => { if (e.target === back) cancel(); };
    back.querySelector('[data-c="ok"]').onclick = submit;
    back.querySelector('[data-c="cancel"]').onclick = cancel;
    back.querySelectorAll('.ns-wt .theme-opt').forEach(b => {
      b.onclick = () => {
        reuse = b.dataset.wt === 'reuse';
        back.querySelectorAll('.ns-wt .theme-opt').forEach(x => { const on = x === b; x.classList.toggle('active', on); x.setAttribute('aria-checked', String(on)); });
        paint(input.value.trim(), /^https?:\/\//i.test(input.value.trim()));
      };
    });
    back.querySelectorAll('.ns-cli .theme-opt').forEach(b => {
      b.onclick = () => {
        cli = b.dataset.cli;
        back.querySelectorAll('.ns-cli .theme-opt').forEach(x => { const on = x === b; x.classList.toggle('active', on); x.setAttribute('aria-checked', String(on)); });
      };
    });
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(back);
    _open = cancel;
    input.focus();
  });
}
