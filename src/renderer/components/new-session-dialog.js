// "New session" dialog behind the sidebar's "+" on a project: name the branch (→ worktree folder)
// OR paste the PR / ticket the session is for — one field, read by shape — pick the base branch it
// forks from, and choose the agent to launch in its terminal. An in-app
// modal on the shared .modal-backdrop — the webview swallows native prompt()/confirm(), so those
// are never used here. Resolves { branch, base, cli } on Create, or null on Cancel / Escape /
// backdrop click. One dialog at a time: opening a second cancels the first.
import { ROUTES } from '/shared/routes.mjs';
import { state, prByUrl, jiraByKey } from '../stores/store.js';
import { api } from '../services/api.js';
import { esc, isPrUrl, jiraKeyFromUrl } from '../lib/util.js';
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
    return { url, kind: 'github', jiraKey: '', title: pr?.title || url, branch: pr?.headRefName || '' };
  }
  const key = jiraKeyFromUrl(url);
  if (key) {
    const it = jiraByKey(key);
    return { url, kind: 'jira', jiraKey: key, title: it?.summary ? `${key} ${it.summary}` : key,
      branch: jiraTaskBranch(key, it?.summary || '') };
  }
  return null;
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
    let cli = cli0;
    let page = null;
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
      const branch = (raw || placeholder).replace(/\s+/g, '-');
      const err = branchNameError(branch);
      if (err) {
        const el = page ? branch2 : input;
        hint.textContent = err; hint.classList.add('form-hint-err'); el.focus();
        return;
      }
      done({ branch, base: baseSel.value, cli, page });
    };
    // What was typed decides what it is — a url (the page this session is for) or a branch name.
    // The hint says which reading won, so nothing is silently misread.
    input.oninput = () => {
      const typed = input.value.trim();
      page = /^https?:\/\//i.test(typed) ? parseSessionUrl(typed) : null;
      const urlish = /^https?:\/\//i.test(typed);
      hint.classList.toggle('form-hint-err', urlish && !page);
      hint.textContent = !typed ? HINT
        : urlish && !page ? 'Not a GitHub pull request or Jira issue URL'
        : page ? (page.branch
            ? `Opens ${page.kind === 'jira' ? page.jiraKey : 'that pull request'} — branch ${page.branch}`
            : `Opens that pull request — it isn’t loaded yet, so name its branch below`)
        : HINT;
      // The extra input appears only for a PR whose head branch we can't know from here.
      branchRow.hidden = !(page && !page.branch);
      if (!branchRow.hidden && !branch2.value) branch2.focus();
    };
    const onKey = e => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancel(); }
      else if (e.key === 'Enter' && e.target !== baseSel) { e.preventDefault(); e.stopPropagation(); submit(); }
    };
    back.onclick = e => { if (e.target === back) cancel(); };
    back.querySelector('[data-c="ok"]').onclick = submit;
    back.querySelector('[data-c="cancel"]').onclick = cancel;
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
