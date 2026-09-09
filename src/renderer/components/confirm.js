// In-app confirmation dialog for destructive actions (sidebar task / worktree delete): a small
// modal card on the shared .modal-backdrop — title, one-paragraph consequence, Cancel + a danger
// button. Resolves true on the danger button; false on Cancel, Escape, or a backdrop click. One
// dialog at a time: opening a second cancels the first.
import { esc } from '../lib/util.js';

let _open = null; // () => cancel the current dialog

export function confirmDialog({ title = 'Delete?', message = '', label = 'Delete' } = {}) {
  _open?.();
  return new Promise(resolve => {
    const back = document.createElement('div');
    back.className = 'modal-backdrop';
    back.innerHTML = `<div class="modal modal-confirm" role="alertdialog" aria-modal="true">
        <h2>${esc(title)}</h2>
        <p class="modal-msg">${esc(message)}</p>
        <div class="modal-actions">
          <button class="btn btn-secondary" data-c="cancel">Cancel</button>
          <button class="btn btn-danger" data-c="ok">${esc(label)}</button>
        </div>
      </div>`;
    const done = ok => {
      if (_open !== cancel) return; // already settled
      _open = null;
      document.removeEventListener('keydown', onKey, true);
      back.remove();
      resolve(ok);
    };
    const cancel = () => done(false);
    const onKey = e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancel(); } };
    back.onclick = e => { if (e.target === back) cancel(); };
    back.querySelector('[data-c="ok"]').onclick = () => done(true);
    back.querySelector('[data-c="cancel"]').onclick = cancel;
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(back);
    _open = cancel;
    back.querySelector('[data-c="cancel"]').focus(); // a reflexive Enter cancels; the destructive action is a deliberate click
  });
}
