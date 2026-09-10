// "New session" dialog behind the sidebar's "+" on a project: name the branch (→ worktree folder),
// pick the base branch it forks from, and choose the agent to launch in its terminal. An in-app
// modal on the shared .modal-backdrop — the webview swallows native prompt()/confirm(), so those
// are never used here. Resolves { branch, base, cli } on Create, or null on Cancel / Escape /
// backdrop click. One dialog at a time: opening a second cancels the first.
import { ROUTES } from '/shared/routes.mjs';
import { state } from '../stores/store.js';
import { api } from '../services/api.js';
import { esc } from '../lib/util.js';

const PREFERRED_BASE = 'develop'; // preselected when the repo has it; else the repo's default branch
const CLI_CHOICES = [
  { id: 'claude', label: 'Claude' },
  { id: 'codex', label: 'Codex' },
  { id: '', label: 'Shell only' },
];

let _open = null; // () => cancel the current dialog (claimed synchronously at entry, before the refs fetch)

// Mirrors the server's validBranchName (repositories/github.js): git check-ref-format rules plus
// no `.`/`..` segments, so the derived worktree folder can never escape `${ws}.worktrees`.
export function branchNameError(b) {
  if (!b) return 'Enter a branch name';
  if (b.startsWith('-') || b.endsWith('/') || b.endsWith('.') || b.endsWith('.lock')) return 'Branch name can’t start with “-” or end with “/”, “.” or “.lock”';
  if (/[\x00-\x20\x7f~^:?*[\\]|\.\.|@\{|\/\/|^@$/.test(b)) return 'Branch name can’t contain spaces, “..” or ~ ^ : ? * [ \\';
  if (!b.split('/').every(seg => seg && seg !== '.' && !seg.startsWith('.'))) return 'No branch segment may start with “.”';
  return '';
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
          <label class="form-label" for="ns-branch">Branch name</label>
          <input type="text" id="ns-branch" placeholder="${esc(placeholder)}" autocomplete="off" spellcheck="false">
          <div class="form-hint" id="ns-hint">Also names the worktree folder. Leave blank to use the placeholder.</div>
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
    const baseSel = back.querySelector('#ns-base');
    let cli = cli0;
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
      const branch = (input.value.trim() || placeholder).replace(/\s+/g, '-');
      const err = branchNameError(branch);
      if (err) { hint.textContent = err; hint.classList.add('form-hint-err'); input.focus(); return; }
      done({ branch, base: baseSel.value, cli });
    };
    input.oninput = () => { hint.classList.remove('form-hint-err'); hint.textContent = 'Also names the worktree folder. Leave blank to use the placeholder.'; };
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
